import re
from typing import Any

from services.crypto import decrypt_text, encrypt_text
from services.db_writer import (
    delete_agent_integration,
    fetch_agent_integration,
    fetch_agent_integrations,
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
) -> dict[str, Any]:
    provider = provider.lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"Unsupported provider: {provider}")
    agent_id = await generate_agent_id(display_name=display_name, provider=provider)

    row = await upsert_agent_integration(
        agent_id=agent_id,
        display_name=display_name,
        provider=provider,
        base_url=base_url.rstrip("/"),
        public_key_encrypted=encrypt_text(public_key),
        secret_key_encrypted=encrypt_text(secret_key),
        metadata=metadata,
    )
    return public_agent(row)


async def list_agents() -> list[dict[str, Any]]:
    return [public_agent(row) for row in await fetch_agent_integrations()]


async def update_agent(
    *,
    agent_id: str,
    display_name: str | None = None,
    provider: str | None = None,
    base_url: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    existing = await fetch_agent_integration(agent_id)
    if not existing:
        return None

    next_provider = (provider or existing["provider"]).lower()
    if next_provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"Unsupported provider: {next_provider}")

    row = await upsert_agent_integration(
        agent_id=agent_id,
        display_name=display_name or existing["display_name"],
        provider=next_provider,
        base_url=(base_url or existing["base_url"]).rstrip("/"),
        public_key_encrypted=encrypt_text(public_key) if public_key else existing["public_key_encrypted"],
        secret_key_encrypted=encrypt_text(secret_key) if secret_key else existing["secret_key_encrypted"],
        metadata=metadata if metadata is not None else existing.get("metadata"),
    )
    return public_agent(row)


async def get_agent(agent_id: str) -> dict[str, Any] | None:
    row = await fetch_agent_integration(agent_id)
    return public_agent(row) if row else None


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


def public_agent(row: dict[str, Any]) -> dict[str, Any]:
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
    }
