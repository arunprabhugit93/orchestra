import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import asyncpg

from schemas.agent_event import AgentEvent
from services.settings import get_settings


CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS agent_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    event_type TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    step_name TEXT,
    tool_name TEXT,
    input_preview TEXT,
    output_preview TEXT,
    input_payload JSONB,
    output_payload JSONB,
    latency_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_agent_events_run_id ON agent_events(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent_id ON agent_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_event_type ON agent_events(event_type);
CREATE INDEX IF NOT EXISTS idx_agent_events_timestamp ON agent_events(timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_integrations (
    agent_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    public_key_encrypted TEXT NOT NULL,
    secret_key_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_agent_integrations_provider ON agent_integrations(provider);

ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS input_payload JSONB;
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS output_payload JSONB;

CREATE TABLE IF NOT EXISTS node_type (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    type_name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Active',
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, type_name)
);

CREATE INDEX IF NOT EXISTS idx_node_type_tenant ON node_type(tenant_id);

CREATE TABLE IF NOT EXISTS organization_node (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    node_code TEXT NOT NULL,
    parent_id TEXT REFERENCES organization_node(id),
    node_type_id TEXT NOT NULL REFERENCES node_type(id),
    description TEXT,
    owner TEXT,
    level INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Active',
    effective_from DATE,
    effective_to DATE,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_by TEXT,
    archived_at TIMESTAMPTZ,
    UNIQUE (tenant_id, node_code),
    UNIQUE (tenant_id, parent_id, node_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_org_node_root_name
ON organization_node(tenant_id, node_name)
WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_org_node_tenant ON organization_node(tenant_id);
CREATE INDEX IF NOT EXISTS idx_org_node_parent ON organization_node(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_node_status ON organization_node(status);

CREATE TABLE IF NOT EXISTS org_audit_history (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    changed_by TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    before_data JSONB,
    after_data JSONB
);

CREATE INDEX IF NOT EXISTS idx_org_audit_entity ON org_audit_history(entity_type, entity_id);
"""


_pool: asyncpg.Pool | None = None


async def init_db() -> None:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(get_settings().database_url, min_size=1, max_size=10)
    async with _pool.acquire() as conn:
        await conn.execute(CREATE_TABLE)
        try:
            await conn.execute(
                "SELECT create_hypertable('agent_events', 'timestamp', if_not_exists => TRUE);"
            )
        except asyncpg.PostgresError:
            # Plain Postgres is valid for local POC runs; TimescaleDB enables this function.
            pass


async def close_db() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def _pool_or_raise() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool is not initialized. Call init_db() first.")
    return _pool


async def write_event(event: AgentEvent) -> None:
    usage = event.token_usage or {}
    async with _pool_or_raise().acquire() as conn:
        await conn.execute(
            """
            INSERT INTO agent_events (
                event_id, run_id, agent_id, session_id, event_type, timestamp,
                step_name, tool_name, input_preview, output_preview, input_payload,
                output_payload, latency_ms, prompt_tokens, completion_tokens,
                total_tokens, error, metadata
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb)
            ON CONFLICT (event_id) DO UPDATE SET
                input_payload = COALESCE(EXCLUDED.input_payload, agent_events.input_payload),
                output_payload = COALESCE(EXCLUDED.output_payload, agent_events.output_payload),
                input_preview = COALESCE(EXCLUDED.input_preview, agent_events.input_preview),
                output_preview = COALESCE(EXCLUDED.output_preview, agent_events.output_preview),
                metadata = agent_events.metadata || EXCLUDED.metadata
            """,
            event.event_id,
            event.run_id,
            event.agent_id,
            event.session_id,
            event.event_type,
            event.timestamp,
            event.step_name,
            event.tool_name,
            event.input_preview,
            event.output_preview,
            json.dumps(event.input_payload) if event.input_payload is not None else None,
            json.dumps(event.output_payload) if event.output_payload is not None else None,
            event.latency_ms,
            usage.get("prompt"),
            usage.get("completion"),
            usage.get("total"),
            event.error,
            json.dumps(event.metadata),
        )


def _row_to_dict(row: asyncpg.Record) -> dict[str, Any]:
    data = dict(row)
    for key, value in list(data.items()):
        if isinstance(value, Decimal):
            data[key] = float(value)
    if data.get("timestamp") and isinstance(data["timestamp"], datetime):
        data["timestamp"] = data["timestamp"].isoformat()
    if data.get("created_at") and isinstance(data["created_at"], datetime):
        data["created_at"] = data["created_at"].isoformat()
    if data.get("updated_at") and isinstance(data["updated_at"], datetime):
        data["updated_at"] = data["updated_at"].isoformat()
    if isinstance(data.get("metadata"), str):
        data["metadata"] = json.loads(data["metadata"])
    if isinstance(data.get("input_payload"), str):
        data["input_payload"] = json.loads(data["input_payload"])
    if isinstance(data.get("output_payload"), str):
        data["output_payload"] = json.loads(data["output_payload"])
    return data


async def fetch_run_events(run_id: str, agent_id: str | None = None) -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        if agent_id:
            rows = await conn.fetch(
                """
                SELECT * FROM agent_events
                WHERE run_id = $1 AND agent_id = $2
                ORDER BY timestamp ASC
                """,
                run_id,
                agent_id,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM agent_events WHERE run_id = $1 ORDER BY timestamp ASC",
                run_id,
            )
    return [_row_to_dict(row) for row in rows]


async def upsert_agent_integration(
    *,
    agent_id: str,
    display_name: str,
    provider: str,
    base_url: str,
    public_key_encrypted: str,
    secret_key_encrypted: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    async with _pool_or_raise().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO agent_integrations (
                agent_id, display_name, provider, base_url,
                public_key_encrypted, secret_key_encrypted, metadata
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
            ON CONFLICT (agent_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                provider = EXCLUDED.provider,
                base_url = EXCLUDED.base_url,
                public_key_encrypted = EXCLUDED.public_key_encrypted,
                secret_key_encrypted = EXCLUDED.secret_key_encrypted,
                metadata = EXCLUDED.metadata,
                updated_at = NOW()
            RETURNING *
            """,
            agent_id,
            display_name,
            provider,
            base_url,
            public_key_encrypted,
            secret_key_encrypted,
            json.dumps(metadata or {}),
        )
    return _row_to_dict(row)


async def fetch_agent_integrations() -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                agent_id, display_name, provider, base_url, created_at, updated_at, metadata,
                public_key_encrypted IS NOT NULL AS public_key_configured,
                secret_key_encrypted IS NOT NULL AS secret_key_configured
            FROM agent_integrations
            ORDER BY updated_at DESC
            """
        )
    return [_row_to_dict(row) for row in rows]


async def fetch_agent_integration(agent_id: str) -> dict[str, Any] | None:
    async with _pool_or_raise().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM agent_integrations WHERE agent_id = $1",
            agent_id,
        )
    return _row_to_dict(row) if row else None


async def delete_agent_integration(agent_id: str) -> bool:
    async with _pool_or_raise().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM agent_integrations WHERE agent_id = $1",
            agent_id,
        )
    return result.endswith("1")


async def fetch_recent_runs(limit: int = 50, agent_id: str | None = None) -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        if agent_id:
            rows = await conn.fetch(
                """
                SELECT
                    run_id,
                    agent_id,
                    MIN(session_id) FILTER (WHERE session_id IS NOT NULL) AS session_id,
                    MIN(timestamp) AS started_at,
                    MAX(timestamp) AS last_event_at,
                    COUNT(*) AS event_count,
                    COUNT(*) FILTER (WHERE event_type IN ('run_error', 'tool_call_error')) AS error_count,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(
                        CASE
                            WHEN event_type = 'llm_call_end'
                                AND metadata->>'total_cost' IS NOT NULL
                                AND metadata->>'total_cost' <> 'null'
                            THEN (metadata->>'total_cost')::numeric
                            ELSE 0
                        END
                    ), 0) AS total_cost
                FROM agent_events
                WHERE agent_id = $1
                GROUP BY run_id, agent_id
                ORDER BY last_event_at DESC
                LIMIT $2
                """,
                agent_id,
                max(1, min(limit, 200)),
            )
        else:
            rows = await conn.fetch(
                """
                SELECT
                    run_id,
                    agent_id,
                    MIN(session_id) FILTER (WHERE session_id IS NOT NULL) AS session_id,
                    MIN(timestamp) AS started_at,
                    MAX(timestamp) AS last_event_at,
                    COUNT(*) AS event_count,
                    COUNT(*) FILTER (WHERE event_type IN ('run_error', 'tool_call_error')) AS error_count,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(
                        CASE
                            WHEN event_type = 'llm_call_end'
                                AND metadata->>'total_cost' IS NOT NULL
                                AND metadata->>'total_cost' <> 'null'
                            THEN (metadata->>'total_cost')::numeric
                            ELSE 0
                        END
                    ), 0) AS total_cost
                FROM agent_events
                GROUP BY run_id, agent_id
                ORDER BY last_event_at DESC
                LIMIT $1
                """,
                max(1, min(limit, 200)),
            )
    return [_row_to_dict(row) for row in rows]


async def fetch_agent_stats(agent_id: str, hours: int = 24) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    async with _pool_or_raise().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(DISTINCT run_id) AS runs,
                COUNT(*) AS events,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(
                    CASE
                        WHEN event_type = 'llm_call_end'
                            AND metadata->>'total_cost' IS NOT NULL
                            AND metadata->>'total_cost' <> 'null'
                        THEN (metadata->>'total_cost')::numeric
                        ELSE 0
                    END
                ), 0) AS total_cost,
                COUNT(*) FILTER (WHERE event_type IN ('run_error', 'tool_call_error')) AS errors,
                AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS avg_latency_ms
            FROM agent_events
            WHERE agent_id = $1 AND timestamp >= $2
            """,
            agent_id,
            since,
        )
    data = _row_to_dict(row)
    data["agent_id"] = agent_id
    data["hours"] = hours
    return data


async def fetch_active_alerts(minutes: int = 30) -> list[dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    async with _pool_or_raise().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM agent_events
            WHERE timestamp >= $1
              AND (event_type IN ('loop_detected', 'intent_drift', 'human_handoff')
                   OR metadata->>'alert' = 'true')
            ORDER BY timestamp DESC
            """,
            since,
        )
    return [_row_to_dict(row) for row in rows]
