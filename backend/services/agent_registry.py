import re
from typing import Any

from services.crypto import decrypt_text, encrypt_text
from services.db_writer import (
    delete_agent_integration,
    fetch_agent_integration,
    fetch_agent_integrations,
    fetch_agent_node_mappings,
    replace_agent_node_mappings,
    upsert_agent_integration,
)


SUPPORTED_PROVIDERS = {"langfuse"}


async def save_agent(
    *,
    display_name: str,
    provider: str,
    base_url: str,
    public_key: str,
    secret_key: str,
    metadata: dict[str, Any] | None = None,
    profile: dict[str, Any] | None = None,
    node_mappings: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    provider = provider.lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"Unsupported provider: {provider}")
    profile = _prepare_profile(profile or {})
    _validate_onboarding(
        display_name=display_name,
        profile=profile,
        node_mappings=node_mappings or [],
        allow_partial=profile.get("onboarding_status") == "Draft",
    )
    agent_id = await generate_agent_id(display_name=display_name, provider=provider)

    row = await upsert_agent_integration(
        agent_id=agent_id,
        display_name=display_name,
        provider=provider,
        base_url=base_url.rstrip("/"),
        public_key_encrypted=encrypt_text(public_key),
        secret_key_encrypted=encrypt_text(secret_key),
        metadata=metadata,
        profile=profile,
    )
    await replace_agent_node_mappings(agent_id, node_mappings or [])
    return await public_agent(row)


async def list_agents() -> list[dict[str, Any]]:
    return [await public_agent(row) for row in await fetch_agent_integrations()]


async def update_agent(
    *,
    agent_id: str,
    display_name: str | None = None,
    provider: str | None = None,
    base_url: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    metadata: dict[str, Any] | None = None,
    profile: dict[str, Any] | None = None,
    node_mappings: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    existing = await fetch_agent_integration(agent_id)
    if not existing:
        return None

    next_provider = (provider or existing["provider"]).lower()
    if next_provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"Unsupported provider: {next_provider}")
    next_profile = _prepare_profile(_existing_profile(existing) | (profile or {}))
    if profile is not None or node_mappings is not None:
        _validate_onboarding(
            display_name=display_name or existing["display_name"],
            profile=next_profile,
            node_mappings=node_mappings if node_mappings is not None else await fetch_agent_node_mappings(agent_id),
            allow_partial=profile is None or next_profile.get("onboarding_status") == "Draft",
        )

    row = await upsert_agent_integration(
        agent_id=agent_id,
        display_name=display_name or existing["display_name"],
        provider=next_provider,
        base_url=(base_url or existing["base_url"]).rstrip("/"),
        public_key_encrypted=encrypt_text(public_key) if public_key else existing["public_key_encrypted"],
        secret_key_encrypted=encrypt_text(secret_key) if secret_key else existing["secret_key_encrypted"],
        metadata=metadata if metadata is not None else existing.get("metadata"),
        profile=next_profile,
    )
    if node_mappings is not None:
        await replace_agent_node_mappings(agent_id, node_mappings)
    return await public_agent(row)


async def get_agent(agent_id: str) -> dict[str, Any] | None:
    row = await fetch_agent_integration(agent_id)
    return await public_agent(row) if row else None


async def get_agent_credentials(agent_id: str) -> dict[str, str] | None:
    row = await fetch_agent_integration(agent_id)
    if not row:
        return None
    return {
        "agent_id": row["agent_id"],
        "display_name": row["display_name"],
        "provider": row["provider"],
        "base_url": row["base_url"],
        "public_key": decrypt_text(row["public_key_encrypted"]),
        "secret_key": decrypt_text(row["secret_key_encrypted"]),
    }


async def delete_agent(agent_id: str) -> bool:
    return await delete_agent_integration(agent_id)


async def generate_agent_id(*, display_name: str, provider: str) -> str:
    base = _slugify(display_name)
    if not base:
        base = "agent"
    base = f"{base}_{provider.lower()}"
    candidate = base
    suffix = 2
    while await fetch_agent_integration(candidate):
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower())
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    return normalized[:80]


async def public_agent(row: dict[str, Any]) -> dict[str, Any]:
    profile = _existing_profile(row)
    mappings = await fetch_agent_node_mappings(row["agent_id"])
    return {
        "agent_id": row["agent_id"],
        "display_name": row["display_name"],
        "provider": row["provider"],
        "base_url": row["base_url"],
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "metadata": row.get("metadata") or {},
        "public_key_configured": bool(row.get("public_key_configured", True)),
        "secret_key_configured": bool(row.get("secret_key_configured", True)),
        "profile": profile,
        "node_mappings": mappings,
    }


def _existing_profile(row: dict[str, Any]) -> dict[str, Any]:
    profile = dict(row.get("governance_profile") or {})
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
        if key in row:
            profile[key] = row.get(key)
    return profile


def _prepare_profile(profile: dict[str, Any]) -> dict[str, Any]:
    prepared = dict(profile)
    prepared["suggested_risk_level"] = _suggest_risk_level(prepared)
    prepared["governance_profile"] = {
        key: value
        for key, value in prepared.items()
        if key
        not in {
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
            "governance_profile",
        }
    }
    return prepared


def _validate_onboarding(
    *,
    display_name: str,
    profile: dict[str, Any],
    node_mappings: list[dict[str, Any]],
    allow_partial: bool = False,
) -> None:
    if not display_name.strip():
        raise ValueError("Agent Name is mandatory.")
    if allow_partial:
        return
    if not profile.get("agent_type"):
        raise ValueError("Agent Type is mandatory.")
    if not profile.get("use_case_summary"):
        raise ValueError("Use Case Summary is mandatory.")
    if not profile.get("business_owner"):
        raise ValueError("Business Owner is mandatory.")
    if not profile.get("technical_owner"):
        raise ValueError("Technical Owner is mandatory.")
    if not profile.get("data_classification"):
        raise ValueError("Data Classification is mandatory.")
    if not profile.get("access_scope"):
        raise ValueError("Access Scope is mandatory.")
    if not any(mapping.get("placement_type") == "Primary" for mapping in node_mappings):
        raise ValueError("At least one Primary Organization Node is mandatory.")
    node_ids = [mapping.get("node_id") for mapping in node_mappings if mapping.get("node_id")]
    if len(node_ids) != len(set(node_ids)):
        raise ValueError("Duplicate organization node mappings are not allowed.")


def _suggest_risk_level(profile: dict[str, Any]) -> str:
    score = 0
    if profile.get("autonomy_level") in {"Semi Autonomous", "Fully Autonomous"}:
        score += 2 if profile.get("autonomy_level") == "Semi Autonomous" else 3
    if profile.get("data_classification") in {"Confidential", "Restricted"}:
        score += 2 if profile.get("data_classification") == "Confidential" else 3
    if profile.get("access_scope") in {"Limited Write", "Full Transactional"}:
        score += 2 if profile.get("access_scope") == "Limited Write" else 3
    if profile.get("process_dependency") in {"Core", "Mission Critical"}:
        score += 2 if profile.get("process_dependency") == "Core" else 3
    if profile.get("user_impact") in {"Customer Facing", "Regulatory Facing"}:
        score += 2
    if profile.get("sensitive_data_usage") or profile.get("pii_usage"):
        score += 1
    if score >= 10:
        return "Critical"
    if score >= 7:
        return "High"
    if score >= 3:
        return "Medium"
    return "Low"
