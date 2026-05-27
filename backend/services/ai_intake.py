import json
import uuid
import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Any

import httpx

from services.db_writer import _pool_or_raise, _row_to_dict
from services.settings import get_settings


TENANT_ID = "default"
USER = "admin"
QUALIFICATION_CACHE: dict[str, dict[str, Any]] = {}
LIFECYCLE = [
    "Draft",
    "Submitted",
    "In Qualification",
    "More Information Required",
    "Approved for Design",
    "Rejected",
    "On Hold",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _payload_value(payload: dict[str, Any], section: str, key: str, default: Any = None) -> Any:
    value = payload.get(section, {})
    if isinstance(value, dict):
        return value.get(key, default)
    return default


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"yes", "true", "required", "high", "critical"}


def generate_recommendations(payload: dict[str, Any]) -> dict[str, Any]:
    problem = " ".join(
        str(item or "")
        for item in [
            _payload_value(payload, "business", "problem"),
            _payload_value(payload, "business", "manualProcess"),
            _payload_value(payload, "business", "desiredOutcome"),
        ]
    ).lower()
    systems = _payload_value(payload, "systems", "systems", [])
    systems_text = " ".join(systems if isinstance(systems, list) else [str(systems)]).lower()
    data_classification = _payload_value(payload, "systems", "dataClassification", "Internal")
    sensitive = _boolish(_payload_value(payload, "systems", "sensitiveData")) or data_classification in {"Confidential", "Restricted"}
    customer_facing = _boolish(_payload_value(payload, "governance", "customerFacing"))
    financial = _boolish(_payload_value(payload, "governance", "financialImpact"))
    external_llm = _boolish(_payload_value(payload, "governance", "externalLlmAllowed"))
    audit = _boolish(_payload_value(payload, "governance", "auditLogging"))

    if any(term in problem for term in ["approve", "approval", "decision", "exception", "complaint"]):
        workflow_type = "Human-in-the-loop Copilot"
        autonomy = "Human Approval Required"
    elif any(term in problem for term in ["report", "summary", "document", "email", "extract"]):
        workflow_type = "Knowledge and document automation"
        autonomy = "Suggestion Only"
    elif any(term in systems_text for term in ["api", "sap", "erp", "servicenow"]):
        workflow_type = "Workflow orchestration"
        autonomy = "Semi Autonomous"
    else:
        workflow_type = "AI-assisted workflow intake"
        autonomy = "Human Approval Required"

    risk_score = 0
    if sensitive:
        risk_score += 3
    if customer_facing:
        risk_score += 2
    if financial:
        risk_score += 2
    if external_llm:
        risk_score += 1
    if audit:
        risk_score += 1
    if risk_score >= 7:
        risk = "Critical"
    elif risk_score >= 5:
        risk = "High"
    elif risk_score >= 2:
        risk = "Moderate"
    else:
        risk = "Low"

    filled = sum(1 for section in payload.values() if isinstance(section, dict) for value in section.values() if value not in ("", [], None, False))
    qualification_score = min(96, 36 + filled * 4)
    readiness_score = min(92, 30 + len(systems if isinstance(systems, list) else []) * 7 + (12 if audit else 0) + (10 if not sensitive else 0))
    complexity = "High" if len(systems if isinstance(systems, list) else []) >= 5 or risk in {"High", "Critical"} else "Medium" if filled >= 8 else "Low"

    return {
        "workflowType": workflow_type,
        "architecture": "Multi-agent orchestration" if "orchestration" in workflow_type.lower() or len(systems if isinstance(systems, list) else []) >= 4 else "Governed copilot with workflow tools",
        "autonomyLevel": autonomy,
        "riskLevel": risk,
        "humanApproval": risk != "Low" or autonomy != "Suggestion Only",
        "deploymentReadiness": "High" if readiness_score >= 75 else "Medium" if readiness_score >= 55 else "Low",
        "qualificationScore": qualification_score,
        "readinessScore": readiness_score,
        "estimatedComplexity": complexity,
        "estimatedTokenConsumption": "Medium" if workflow_type != "Knowledge and document automation" else "High",
        "estimatedRoi": "High" if _payload_value(payload, "business", "frequency") in {"Daily", "Hourly", "Real-time"} else "Medium",
        "suggestedAgents": [
            "Intake Classifier Agent",
            "Governance Policy Agent",
            "Workflow Orchestrator Agent",
            "System Integration Agent",
        ],
        "alerts": [
            item
            for item in [
                "Sensitive data controls required" if sensitive else None,
                "Customer-facing review required" if customer_facing else None,
                "Audit logging should be enabled" if audit else None,
                "External LLM usage needs policy approval" if external_llm else None,
            ]
            if item
        ],
    }


def _fallback_qualification(request: dict[str, Any], reason: str) -> dict[str, Any]:
    impact = request.get("impactProfile") or {}
    missing = impact.get("missingInformation") or []
    flags = impact.get("keyRiskFlags") or []
    recommendation = impact.get("recommendedNextStep") or "Request More Information"
    return {
        "source": "Rule-based fallback",
        "status": "Configuration Required" if "GEMINI_API_KEY" in reason else "Generated",
        "qualificationComment": (
            f"{request.get('requestNumber') or 'This request'} is not ready for blind approval. "
            f"Current recommended path is {recommendation} based on the mapped impact profile."
        ),
        "suggestion": recommendation,
        "reasons": (flags or ["Impact profile has limited risk signals."])[:5],
        "checksBeforeApproval": (
            missing
            or [
                "Confirm business owner accountability.",
                "Validate system access and touchpoint feasibility.",
                "Confirm data classification, masking, and audit requirements.",
            ]
        )[:6],
        "criticalEmptyFields": _critical_empty_fields(request),
        "generalizedInputs": _generalized_inputs(request),
        "approvalNotes": "Approval should record business owner, data owner, system owner, required access, and human approval controls.",
        "attachmentGuidance": "Attach BRD or problem statement, process flow, sample inputs/outputs, data classification evidence, and integration/API notes.",
        "model": "fallback",
        "generatedAt": _now(),
        "error": reason,
    }


def _parse_gemini_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    parts = (((candidates[0] or {}).get("content") or {}).get("parts") or [])
    return "\n".join(str(part.get("text") or "") for part in parts if isinstance(part, dict)).strip()


def _fingerprint(request: dict[str, Any], enterprise_context: dict[str, Any]) -> str:
    payload = json.dumps({"request": request, "enterprise_context": enterprise_context}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _is_empty(value: Any) -> bool:
    return value in (None, "", [], {})


def _critical_empty_fields(request: dict[str, Any]) -> list[str]:
    critical = [
        ("title", "Request title"),
        ("requestOwnerName", "Request owner name"),
        ("requestOwnerEmail", "Request owner email"),
        ("businessProblem", "Business problem"),
        ("desiredOutcome", "Desired outcome"),
        ("primaryDepartmentId", "Primary department"),
        ("requestedAICapability", "Requested AI capability"),
        ("agentAutonomyLevel", "Agent autonomy level"),
        ("systemsInvolvedIds", "Systems involved"),
        ("dataDomainIds", "Data domains"),
        ("requiredAccess", "Required access"),
        ("humanApprovalRequired", "Human approval requirement"),
    ]
    result = [label for key, label in critical if _is_empty(request.get(key))]
    if not request.get("systemsInvolvedIds") and not request.get("noSystemIdentified"):
        result.append("Systems involved or explicit no-system flag")
    if not request.get("dataDomainIds") and not request.get("dataDomainUnknown"):
        result.append("Data domains or explicit unknown-data flag")
    return sorted(set(result))


def _generalized_inputs(request: dict[str, Any]) -> list[str]:
    weak_terms = {"test", "tbd", "na", "n/a", "none", "unknown", "general", "automation", "ai", "assistant", "help", "improve"}
    fields = [
        ("title", "Request title"),
        ("businessProblem", "Business problem"),
        ("desiredOutcome", "Desired outcome"),
        ("currentProcessDescription", "Current process description"),
        ("expectedBusinessImpact", "Expected business impact"),
        ("notes", "Notes / risk comments"),
    ]
    weak: list[str] = []
    for key, label in fields:
        value = str(request.get(key) or "").strip()
        words = [word.strip(".,;:!?()[]{}").lower() for word in value.split()]
        if value and (len(value) < 18 or all(word in weak_terms for word in words if word)):
            weak.append(label)
    return weak


async def _call_gemini(client: httpx.AsyncClient, url: str, api_key: str, body: dict[str, Any], key_label: str, model: str) -> dict[str, Any]:
    response = await client.post(url, headers={"x-goog-api-key": api_key}, json=body)
    response.raise_for_status()
    text = _parse_gemini_text(response.json())
    generated = json.loads(text)
    return {
        "source": "Gemini",
        "status": "Generated",
        "qualificationComment": generated.get("qualificationComment") or "",
        "suggestion": generated.get("suggestion") or "Request More Information",
        "reasons": generated.get("reasons") or [],
        "checksBeforeApproval": generated.get("checksBeforeApproval") or [],
        "criticalEmptyFields": generated.get("criticalEmptyFields") or [],
        "generalizedInputs": generated.get("generalizedInputs") or [],
        "approvalNotes": generated.get("approvalNotes") or "",
        "attachmentGuidance": generated.get("attachmentGuidance") or "",
        "model": model,
        "keyUsed": key_label,
        "strategy": get_settings().gemini_request_strategy,
        "generatedAt": _now(),
    }


async def _first_success(tasks: list[asyncio.Task]) -> dict[str, Any]:
    errors: list[str] = []
    pending = set(tasks)
    try:
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                try:
                    result = task.result()
                    for leftover in pending:
                        leftover.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    return result
                except Exception as error:
                    errors.append(str(error))
        raise RuntimeError("; ".join(errors) or "All Gemini requests failed.")
    finally:
        for task in pending:
            task.cancel()


async def generate_qualification_comments(request: dict[str, Any], enterprise_context: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    if not settings.gemini_api_key:
        return _fallback_qualification(request, "GEMINI_API_KEY is not configured in backend settings.")
    cache_key = _fingerprint(request, enterprise_context)
    if cached := QUALIFICATION_CACHE.get(cache_key):
        return {**cached, "cacheStatus": "hit"}

    critical_empty = _critical_empty_fields(request)
    generalized = _generalized_inputs(request)

    prompt = {
        "task": "Generate concise enterprise AI request qualification comments.",
        "instructions": [
            "Read every field in the request, including filled and empty fields.",
            "Read the full enterprise context registries and map selected ids to their detailed records.",
            "Return JSON only.",
            "Be crisp but specific. Do not invent facts.",
            "Include reasons for the suggestion, checks before approval, approval notes, and attachment guidance.",
            "Highlight critical empty fields and generalized or weak inputs.",
            "If any critical approval field is empty, unknown, or generalized, do not recommend approval.",
            "If information is missing, recommend Request More Information unless a stronger governance or integration review is required.",
        ],
        "output_schema": {
            "qualificationComment": "2-3 concise sentences",
            "suggestion": "Submit to Qualification | Request More Information | Governance Review Required | Architecture Review Required | Integration Feasibility Review Required | Approve for Design | Reject | Put On Hold",
            "reasons": ["short reason"],
            "checksBeforeApproval": ["specific check"],
            "criticalEmptyFields": ["critical empty or unknown field name"],
            "generalizedInputs": ["field with weak or overly generic wording"],
            "approvalNotes": "short approval note",
            "attachmentGuidance": "short attachment guidance",
        },
        "precomputed_quality_findings": {
            "criticalEmptyFields": critical_empty,
            "generalizedInputs": generalized,
        },
        "request": request,
        "enterprise_context": enterprise_context,
    }
    body = {
        "contents": [{"parts": [{"text": json.dumps(prompt, default=str)}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            if settings.gemini_request_strategy == "primary_only" or not settings.gemini_backup_api_key:
                result = await _call_gemini(client, url, settings.gemini_api_key, body, "primary", settings.gemini_model)
            else:
                tasks = [
                    asyncio.create_task(_call_gemini(client, url, settings.gemini_api_key, body, "primary", settings.gemini_model)),
                    asyncio.create_task(_call_gemini(client, url, settings.gemini_backup_api_key, body, "backup", settings.gemini_model)),
                ]
                result = await _first_success(tasks)
        result["criticalEmptyFields"] = sorted(set([*(result.get("criticalEmptyFields") or []), *critical_empty]))
        result["generalizedInputs"] = sorted(set([*(result.get("generalizedInputs") or []), *generalized]))
        result["cacheKey"] = cache_key
        result["cacheStatus"] = "miss"
        QUALIFICATION_CACHE[cache_key] = result
        return result
    except Exception as error:
        return _fallback_qualification(request, f"Gemini generation failed: {error}")


def _record(row: dict[str, Any]) -> dict[str, Any]:
    data = _row_to_dict(row)
    data["payload"] = data.pop("request_payload", {}) or {}
    return data


async def list_requests(status: str | None = None) -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM ai_intake_request
            WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
            ORDER BY updated_at DESC
            """,
            TENANT_ID,
            status,
        )
    return [_record(row) for row in rows]


async def get_request(request_id: str) -> dict[str, Any] | None:
    async with _pool_or_raise().acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM ai_intake_request WHERE tenant_id=$1 AND id=$2", TENANT_ID, request_id)
    return _record(row) if row else None


async def create_request(data: dict[str, Any]) -> dict[str, Any]:
    payload = data.get("payload") or {}
    recommendations = generate_recommendations(payload)
    title = data["title"].strip()
    status = data.get("status") or "Draft"
    if status not in LIFECYCLE:
        status = "Draft"
    history = [{"status": status, "at": _now(), "by": USER, "note": "Request created"}]
    async with _pool_or_raise().acquire() as conn:
        number = await conn.fetchval("SELECT 'AIR-' || LPAD((COUNT(*) + 1)::text, 4, '0') FROM ai_intake_request WHERE tenant_id=$1", TENANT_ID)
        row = await conn.fetchrow(
            """
            INSERT INTO ai_intake_request (
                id, tenant_id, request_number, title, department, owner, source_channel,
                status, priority, risk_level, qualification_score, readiness_score,
                estimated_complexity, estimated_roi, estimated_token_consumption,
                request_payload, recommendations, lifecycle_history, created_by, updated_by, submitted_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$19,$20)
            RETURNING *
            """,
            str(uuid.uuid4()),
            TENANT_ID,
            number,
            title,
            data.get("department"),
            data.get("owner"),
            data.get("source_channel") or "manual",
            status,
            _payload_value(payload, "business", "priority"),
            recommendations["riskLevel"],
            recommendations["qualificationScore"],
            recommendations["readinessScore"],
            recommendations["estimatedComplexity"],
            recommendations["estimatedRoi"],
            recommendations["estimatedTokenConsumption"],
            json.dumps(payload),
            json.dumps(recommendations),
            json.dumps(history),
            USER,
            datetime.now(timezone.utc) if status != "Draft" else None,
        )
    return _record(row)


async def update_request(request_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    existing = await get_request(request_id)
    if not existing:
        return None
    payload = data.get("payload") if data.get("payload") is not None else existing["payload"]
    recommendations = generate_recommendations(payload)
    status = data.get("status") or existing["status"]
    history = existing.get("lifecycle_history") or []
    if status != existing["status"]:
        history.append({"status": status, "at": _now(), "by": USER, "note": f"Moved from {existing['status']} to {status}"})
    async with _pool_or_raise().acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE ai_intake_request SET
                title=$3, department=$4, owner=$5, status=$6, priority=$7,
                risk_level=$8, qualification_score=$9, readiness_score=$10,
                estimated_complexity=$11, estimated_roi=$12, estimated_token_consumption=$13,
                request_payload=$14::jsonb, recommendations=$15::jsonb,
                lifecycle_history=$16::jsonb, updated_by=$17, updated_at=NOW(),
                submitted_at=CASE WHEN submitted_at IS NULL AND $6 <> 'Draft' THEN NOW() ELSE submitted_at END
            WHERE tenant_id=$1 AND id=$2
            RETURNING *
            """,
            TENANT_ID,
            request_id,
            (data.get("title") or existing["title"]).strip(),
            data.get("department") if data.get("department") is not None else existing.get("department"),
            data.get("owner") if data.get("owner") is not None else existing.get("owner"),
            status,
            _payload_value(payload, "business", "priority"),
            recommendations["riskLevel"],
            recommendations["qualificationScore"],
            recommendations["readinessScore"],
            recommendations["estimatedComplexity"],
            recommendations["estimatedRoi"],
            recommendations["estimatedTokenConsumption"],
            json.dumps(payload),
            json.dumps(recommendations),
            json.dumps(history),
            USER,
        )
    return _record(row)


async def dashboard() -> dict[str, Any]:
    requests = await list_requests()
    by_department: dict[str, int] = {}
    by_risk: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for item in requests:
        by_department[item.get("department") or "Unassigned"] = by_department.get(item.get("department") or "Unassigned", 0) + 1
        by_risk[item.get("risk_level") or "Unknown"] = by_risk.get(item.get("risk_level") or "Unknown", 0) + 1
        by_status[item.get("status") or "Draft"] = by_status.get(item.get("status") or "Draft", 0) + 1
    avg_readiness = round(sum(item.get("readiness_score") or 0 for item in requests) / max(1, len(requests)))
    return {
        "total": len(requests),
        "byDepartment": by_department,
        "byRisk": by_risk,
        "byStatus": by_status,
        "pipeline": len([item for item in requests if item.get("status") not in {"Retired", "Archived Requests"}]),
        "estimatedSavings": "$" + format(len(requests) * 48000, ","),
        "readinessScore": avg_readiness,
        "approvalBottlenecks": by_status.get("Governance Review", 0) + by_status.get("Submitted", 0),
    }
