from __future__ import annotations

from collections import defaultdict
from typing import Any

from services.db_writer import _pool_or_raise, _row_to_dict


SUM_KEYS = ("cost", "tokens", "executions", "api_calls", "runtime_duration")


async def get_organization_graph(tenant_id: str = "default") -> dict[str, Any]:
    async with _pool_or_raise().acquire() as conn:
        org_rows = await conn.fetch(
            """
            SELECT n.*, t.type_name AS node_type
            FROM organization_node n
            JOIN node_type t ON t.id=n.node_type_id
            WHERE n.tenant_id=$1
            ORDER BY n.level ASC, n.sort_order ASC, n.node_name ASC
            """,
            tenant_id,
        )
        agent_rows = await conn.fetch(
            """
            SELECT
                agent_id, display_name, provider, base_url, created_at, updated_at,
                agent_code, agent_description, agent_type, use_case_summary,
                business_objective, lifecycle_status, business_criticality,
                autonomy_level, data_classification, access_scope, deployment_status,
                monitoring_required, audit_logging_required, human_approval_required,
                pii_usage, sensitive_data_usage, governance_profile
            FROM agent_integrations
            ORDER BY updated_at DESC
            """
        )
        mapping_rows = await conn.fetch(
            """
            SELECT m.*, n.node_name, n.node_code
            FROM agent_node_mapping m
            JOIN organization_node n ON n.id=m.node_id AND n.tenant_id=m.tenant_id
            WHERE m.tenant_id=$1 AND m.status='Active'
            """,
            tenant_id,
        )
        metric_rows = await conn.fetch(
            """
            WITH runs AS (
                SELECT
                    run_id,
                    agent_id,
                    MIN(timestamp) AS started_at,
                    MAX(timestamp) AS ended_at,
                    COUNT(*) FILTER (WHERE event_type IN ('tool_call_start','tool_call_end')) AS api_calls,
                    COUNT(*) FILTER (WHERE event_type IN ('run_error','tool_call_error')) AS error_events,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(
                        CASE
                            WHEN event_type='llm_call_end'
                                AND metadata->>'total_cost' IS NOT NULL
                                AND metadata->>'total_cost' <> 'null'
                            THEN (metadata->>'total_cost')::numeric
                            ELSE 0
                        END
                    ), 0) AS cost
                FROM agent_events
                GROUP BY run_id, agent_id
            )
            SELECT
                agent_id,
                COUNT(*) AS executions,
                COALESCE(SUM(tokens), 0) AS tokens,
                COALESCE(SUM(cost), 0) AS cost,
                COALESCE(SUM(api_calls), 0) AS api_calls,
                COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000), 0) AS runtime_duration,
                COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000), 0) AS latency,
                CASE WHEN COUNT(*) = 0 THEN 0 ELSE (COUNT(*) FILTER (WHERE error_events = 0)::numeric / COUNT(*)) * 100 END AS success_rate,
                CASE WHEN COUNT(*) = 0 THEN 0 ELSE (COUNT(*) FILTER (WHERE error_events > 0)::numeric / COUNT(*)) * 100 END AS error_rate
            FROM runs
            GROUP BY agent_id
            """
        )

    org_nodes = [_public_org_node(row) for row in org_rows]
    agents = [_public_agent(row) for row in agent_rows]
    mappings = [_row_to_dict(row) for row in mapping_rows]
    agent_metrics = {row["agent_id"]: _metric(row) for row in metric_rows}

    children_by_parent: dict[str | None, list[str]] = defaultdict(list)
    for node in org_nodes:
        children_by_parent[node["parent_id"]].append(node["id"])

    mappings_by_node: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for mapping in mappings:
        mappings_by_node[mapping["node_id"]].append(mapping)

    agents_by_id = {agent["id"]: agent for agent in agents}
    direct_metrics: dict[str, dict[str, Any]] = {}
    for node in org_nodes:
        direct = _empty_metric()
        for mapping in mappings_by_node[node["id"]]:
            _add_metric(direct, agent_metrics.get(mapping["agent_id"], _empty_metric()))
        direct_metrics[node["id"]] = direct

    rollup_metrics: dict[str, dict[str, Any]] = {}

    def rollup(node_id: str) -> dict[str, Any]:
        descendant = _empty_metric()
        combined = dict(direct_metrics[node_id])
        for child_id in children_by_parent.get(node_id, []):
            child_combined = rollup(child_id)
            _add_metric(descendant, child_combined)
            _add_metric(combined, child_combined)
        rollup_metrics[node_id] = {
            "direct": direct_metrics[node_id],
            "rollup": descendant,
            "combined": combined,
        }
        return combined

    for root_id in children_by_parent[None]:
        rollup(root_id)

    graph_nodes: list[dict[str, Any]] = []
    graph_edges: list[dict[str, Any]] = []

    for node in org_nodes:
        mapped_agents = mappings_by_node[node["id"]]
        graph_nodes.append(
            {
                "id": f"org:{node['id']}",
                "entityId": node["id"],
                "type": "organization",
                "label": node["node_name"],
                "metadata": {
                    **node,
                    "totalMappedAgents": len(mapped_agents),
                    "metrics": rollup_metrics.get(node["id"], {"direct": _empty_metric(), "rollup": _empty_metric(), "combined": _empty_metric()}),
                },
            }
        )
        if node["parent_id"]:
            graph_edges.append(
                {
                    "id": f"hierarchy:{node['parent_id']}:{node['id']}",
                    "source": f"org:{node['parent_id']}",
                    "target": f"org:{node['id']}",
                    "type": "hierarchy",
                }
            )

    for mapping in mappings:
        agent = agents_by_id.get(mapping["agent_id"])
        if not agent:
            continue
        metric = agent_metrics.get(mapping["agent_id"], _empty_metric())
        graph_nodes.append(
            {
                "id": f"agent:{mapping['agent_id']}:{mapping['node_id']}",
                "entityId": mapping["agent_id"],
                "type": "agent",
                "label": agent["display_name"],
                "metadata": {
                    **agent,
                    "mapping": mapping,
                    "metrics": metric,
                },
            }
        )
        graph_edges.append(
            {
                "id": f"mapping:{mapping['node_id']}:{mapping['agent_id']}",
                "source": f"org:{mapping['node_id']}",
                "target": f"agent:{mapping['agent_id']}:{mapping['node_id']}",
                "type": "mapping",
            }
        )

    overview = _overview(org_nodes, agents, mappings, agent_metrics, rollup_metrics)
    return {
        "nodes": graph_nodes,
        "edges": graph_edges,
        "metrics": {
            "agents": agent_metrics,
            "organization": rollup_metrics,
            "overview": overview,
        },
        "filters": {
            "nodeTypes": sorted({node["node_type"] for node in org_nodes if node.get("node_type")}),
            "departments": sorted({node["node_name"] for node in org_nodes if node.get("level") == 1}),
            "deploymentStatuses": sorted({agent.get("deployment_status") or "Draft" for agent in agents}),
            "riskLevels": ["Low", "Medium", "High", "Critical"],
            "environments": sorted({agent.get("deployment_environment") or "Development" for agent in agents}),
        },
        "layout": {
            "default": "vertical hierarchy",
            "supported": [
                "vertical hierarchy",
                "horizontal hierarchy",
                "compact",
                "expanded",
                "grouped by business area",
                "grouped by node type",
            ],
        },
    }


def _public_org_node(row: Any) -> dict[str, Any]:
    data = _row_to_dict(row)
    data["nodeName"] = data["node_name"]
    data["nodeCode"] = data["node_code"]
    data["nodeType"] = data["node_type"]
    return data


def _public_agent(row: Any) -> dict[str, Any]:
    data = _row_to_dict(row)
    profile = dict(data.get("governance_profile") or {})
    for key in (
        "agent_code",
        "agent_description",
        "agent_type",
        "use_case_summary",
        "business_objective",
        "lifecycle_status",
        "business_criticality",
        "autonomy_level",
        "data_classification",
        "access_scope",
        "deployment_status",
        "monitoring_required",
        "audit_logging_required",
        "human_approval_required",
        "pii_usage",
        "sensitive_data_usage",
    ):
        profile[key] = data.get(key)
    return {
        "id": data["agent_id"],
        "agent_id": data["agent_id"],
        "display_name": data["display_name"],
        "provider": data["provider"],
        "base_url": data["base_url"],
        "updated_at": data.get("updated_at"),
        **profile,
    }


def _metric(row: Any) -> dict[str, Any]:
    data = _row_to_dict(row)
    return {
        "cost": float(data.get("cost") or 0),
        "tokens": int(data.get("tokens") or 0),
        "latency": float(data.get("latency") or 0),
        "executions": int(data.get("executions") or 0),
        "success_rate": float(data.get("success_rate") or 0),
        "error_rate": float(data.get("error_rate") or 0),
        "api_calls": int(data.get("api_calls") or 0),
        "runtime_duration": float(data.get("runtime_duration") or 0),
        "active_users": int(data.get("active_users") or 0),
    }


def _empty_metric() -> dict[str, Any]:
    return {
        "cost": 0.0,
        "tokens": 0,
        "latency": 0.0,
        "executions": 0,
        "success_rate": 0.0,
        "error_rate": 0.0,
        "api_calls": 0,
        "runtime_duration": 0.0,
        "active_users": 0,
    }


def _add_metric(target: dict[str, Any], source: dict[str, Any]) -> None:
    target_weight = target.get("executions", 0) or 0
    source_weight = source.get("executions", 0) or 0
    total_weight = target_weight + source_weight
    for key in SUM_KEYS:
        target[key] = (target.get(key) or 0) + (source.get(key) or 0)
    for key in ("latency", "success_rate", "error_rate"):
        if total_weight:
            target[key] = (((target.get(key) or 0) * target_weight) + ((source.get(key) or 0) * source_weight)) / total_weight
    target["active_users"] = (target.get("active_users") or 0) + (source.get("active_users") or 0)


def _overview(
    org_nodes: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    mappings: list[dict[str, Any]],
    agent_metrics: dict[str, dict[str, Any]],
    rollup_metrics: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    totals = _empty_metric()
    for metric in agent_metrics.values():
        _add_metric(totals, metric)
    mapped_by_node = defaultdict(int)
    for mapping in mappings:
        mapped_by_node[mapping["node_id"]] += 1
    risk_counts = defaultdict(int)
    deployment_counts = defaultdict(int)
    for agent in agents:
        risk_counts[agent.get("suggested_risk_level") or agent.get("risk_level") or "Unrated"] += 1
        deployment_counts[agent.get("deployment_status") or "Draft"] += 1
    top_agents = sorted(
        [{"agentId": agent_id, **metric} for agent_id, metric in agent_metrics.items()],
        key=lambda item: item["cost"],
        reverse=True,
    )[:8]
    top_departments = sorted(
        [
            {
                "nodeId": node["id"],
                "name": node["node_name"],
                **rollup_metrics.get(node["id"], {}).get("combined", _empty_metric()),
            }
            for node in org_nodes
            if node.get("level") == 1
        ],
        key=lambda item: item["cost"],
        reverse=True,
    )[:8]
    return {
        "totalOrganizationNodes": len(org_nodes),
        "totalAiAgents": len(agents),
        "activeAgents": len([agent for agent in agents if agent.get("lifecycle_status") not in {"Retired", "Inactive"}]),
        "criticalAgents": len([agent for agent in agents if agent.get("business_criticality") == "Critical"]),
        "highRiskAgents": len([agent for agent in agents if agent.get("suggested_risk_level") in {"High", "Critical"} or agent.get("risk_level") in {"High", "Critical"}]),
        "productionAgents": len([agent for agent in agents if agent.get("deployment_environment") == "Production" or agent.get("deployment_status") == "Live"]),
        "totalTokenUsage": totals["tokens"],
        "totalRuntimeCost": totals["cost"],
        "averageLatency": totals["latency"],
        "totalExecutions": totals["executions"],
        "topConsumingDepartments": top_departments,
        "topConsumingAgents": top_agents,
        "riskDistribution": dict(risk_counts),
        "deploymentStatusDistribution": dict(deployment_counts),
        "mappedAgentsByNode": dict(mapped_by_node),
    }
