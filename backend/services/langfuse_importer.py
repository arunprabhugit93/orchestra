from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import httpx

from schemas.agent_event import AgentEvent, preview
from services.db_writer import write_event
from services.settings import get_settings


LANGFUSE_FIELDS = "core,basic,time,io,metadata,model,usage,metrics"


class LangfuseImportError(RuntimeError):
    pass


async def import_langfuse_observations(
    *,
    agent_id: str = "langfuse_import",
    base_url: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    limit: int = 100,
    from_start_time: datetime | None = None,
    to_start_time: datetime | None = None,
    trace_id: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    environment: str | None = None,
    max_pages: int = 5,
) -> dict[str, Any]:
    settings = get_settings()
    resolved_base_url = base_url or settings.langfuse_base_url
    resolved_public_key = public_key or settings.langfuse_public_key
    resolved_secret_key = secret_key or settings.langfuse_secret_key
    if not resolved_public_key or not resolved_secret_key:
        raise LangfuseImportError(
            "Langfuse credentials must be configured before importing."
        )

    observations = await _fetch_observations(
        base_url=resolved_base_url,
        public_key=resolved_public_key,
        secret_key=resolved_secret_key,
        limit=limit,
        from_start_time=from_start_time,
        to_start_time=to_start_time,
        trace_id=trace_id,
        user_id=user_id,
        session_id=session_id,
        environment=environment,
        max_pages=max_pages,
    )

    events = _observations_to_events(observations, agent_id=agent_id)
    for event in events:
        await write_event(event)

    return {
        "imported_events": len(events),
        "source_observations": len(observations),
        "trace_count": len({obs.get("traceId") for obs in observations if obs.get("traceId")}),
        "agent_id": agent_id,
        "base_url": resolved_base_url,
    }


async def _fetch_observations(
    *,
    base_url: str,
    public_key: str,
    secret_key: str,
    limit: int,
    from_start_time: datetime | None,
    to_start_time: datetime | None,
    trace_id: str | None,
    user_id: str | None,
    session_id: str | None,
    environment: str | None,
    max_pages: int,
) -> list[dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/api/public/v2/observations"
    params: dict[str, Any] = {
        "fields": LANGFUSE_FIELDS,
        "limit": max(1, min(limit, 1000)),
    }
    if from_start_time:
        params["fromStartTime"] = _to_iso_z(from_start_time)
    if to_start_time:
        params["toStartTime"] = _to_iso_z(to_start_time)
    if trace_id:
        params["traceId"] = trace_id
    if user_id:
        params["userId"] = user_id
    if session_id:
        params["sessionId"] = session_id
    if environment:
        params["environment"] = environment

    observations: list[dict[str, Any]] = []
    cursor: str | None = None
    async with httpx.AsyncClient(timeout=30) as client:
        for _ in range(max_pages):
            request_params = dict(params)
            if cursor:
                request_params["cursor"] = cursor
            response = await client.get(url, params=request_params, auth=(public_key, secret_key))
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                status_code = exc.response.status_code
                if status_code in {401, 403}:
                    raise LangfuseImportError(
                        "Langfuse rejected the saved credentials for this agent. Update the public and secret keys, then import again."
                    ) from exc
                raise LangfuseImportError(
                    f"Langfuse import failed with HTTP {status_code}: {exc.response.text[:300]}"
                ) from exc
            payload = response.json()
            observations.extend(payload.get("data", []))
            cursor = (payload.get("meta") or {}).get("cursor")
            if not cursor:
                break
    return observations


def _observations_to_events(observations: list[dict[str, Any]], *, agent_id: str) -> list[AgentEvent]:
    by_trace: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for observation in observations:
        trace_id = observation.get("traceId")
        if trace_id:
            by_trace[trace_id].append(observation)

    events: list[AgentEvent] = []
    for trace_id, trace_observations in by_trace.items():
        ordered = sorted(trace_observations, key=lambda item: _parse_time(item.get("startTime")) or datetime.max.replace(tzinfo=timezone.utc))
        start_time = _first_time(ordered, "startTime")
        end_time = _last_time(ordered, "endTime") or start_time
        session_id = _first_value(ordered, "sessionId")
        user_id = _first_value(ordered, "userId")

        events.append(
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{trace_id}:run_start",
                run_id=trace_id,
                agent_id=agent_id,
                session_id=session_id,
                event_type="run_start",
                timestamp=start_time or datetime.now(timezone.utc),
                input_preview=preview(_first_value(ordered, "input")),
                input_payload=_first_value(ordered, "input"),
                metadata={
                    "source": "langfuse",
                    "trace_id": trace_id,
                    "user_id": user_id,
                    "observation_count": len(ordered),
                },
            )
        )

        for observation in ordered:
            events.extend(_observation_to_events(observation, agent_id=agent_id, fallback_session_id=session_id))

        events.append(
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{trace_id}:run_end",
                run_id=trace_id,
                agent_id=agent_id,
                session_id=session_id,
                event_type="run_end",
                timestamp=end_time or datetime.now(timezone.utc),
                output_preview=preview(_last_value(ordered, "output")),
                output_payload=_last_value(ordered, "output"),
                latency_ms=_latency_ms(start_time, end_time),
                metadata={
                    "source": "langfuse",
                    "trace_id": trace_id,
                    "user_id": user_id,
                    "observation_count": len(ordered),
                },
            )
        )

    return sorted(events, key=lambda event: event.timestamp)


def _observation_to_events(
    observation: dict[str, Any],
    *,
    agent_id: str,
    fallback_session_id: str | None,
) -> list[AgentEvent]:
    trace_id = observation["traceId"]
    observation_id = observation["id"]
    observation_type = str(observation.get("type") or "").upper()
    name = observation.get("name")
    start_time = _parse_time(observation.get("startTime")) or datetime.now(timezone.utc)
    end_time = _parse_time(observation.get("endTime"))
    usage = _usage(observation)
    level = str(observation.get("level") or "").upper()
    status_message = observation.get("statusMessage")
    session_id = observation.get("sessionId") or fallback_session_id

    common = {
        "run_id": trace_id,
        "agent_id": agent_id,
        "session_id": session_id,
        "metadata": {
            "source": "langfuse",
            "trace_id": trace_id,
            "observation_id": observation_id,
            "observation_type": observation_type,
            "parent_observation_id": observation.get("parentObservationId"),
            "model": observation.get("providedModelName"),
            "level": level or None,
            "total_cost": _nested_number(observation.get("costDetails"), "total"),
        },
    }

    if observation_type == "GENERATION":
        events = [
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{observation_id}:llm_start",
                event_type="llm_call_start",
                timestamp=start_time,
                step_name=name,
                input_preview=preview(observation.get("input")),
                input_payload=observation.get("input"),
                **common,
            ),
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{observation_id}:llm_end",
                event_type="llm_call_end",
                timestamp=end_time or start_time,
                step_name=name,
                output_preview=preview(observation.get("output")),
                output_payload=observation.get("output"),
                latency_ms=_latency_ms(start_time, end_time),
                token_usage=usage,
                **common,
            ),
        ]
    elif observation_type == "TOOL":
        events = [
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{observation_id}:tool_start",
                event_type="tool_call_start",
                timestamp=start_time,
                tool_name=name,
                input_preview=preview(observation.get("input")),
                input_payload=observation.get("input"),
                **common,
            ),
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{observation_id}:tool_end",
                event_type="tool_call_end",
                timestamp=end_time or start_time,
                tool_name=name,
                output_preview=preview(observation.get("output")),
                output_payload=observation.get("output"),
                latency_ms=_latency_ms(start_time, end_time),
                **common,
            ),
        ]
    else:
        events = [
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{observation_id}:step_start",
                event_type="step_start",
                timestamp=start_time,
                step_name=name,
                input_preview=preview(observation.get("input")),
                input_payload=observation.get("input"),
                **common,
            ),
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{observation_id}:step_end",
                event_type="step_end",
                timestamp=end_time or start_time,
                step_name=name,
                output_preview=preview(observation.get("output")),
                output_payload=observation.get("output"),
                latency_ms=_latency_ms(start_time, end_time),
                token_usage=usage,
                **common,
            ),
        ]

    if level == "ERROR":
        events.append(
            AgentEvent(
                event_id=f"langfuse:{agent_id}:{observation_id}:error",
                event_type="run_error",
                timestamp=end_time or start_time,
                step_name=name if observation_type != "TOOL" else None,
                tool_name=name if observation_type == "TOOL" else None,
                error=status_message or "Langfuse observation marked as ERROR",
                **common,
            )
        )
    return events


def _usage(observation: dict[str, Any]) -> dict[str, int] | None:
    usage_details = observation.get("usageDetails") or {}
    prompt = _nested_int(usage_details, "input") or _nested_int(usage_details, "prompt")
    completion = _nested_int(usage_details, "output") or _nested_int(usage_details, "completion")
    total = _nested_int(usage_details, "total")
    if total is None and (prompt is not None or completion is not None):
        total = (prompt or 0) + (completion or 0)
    if prompt is None and completion is None and total is None:
        return None
    return {
        "prompt": prompt or 0,
        "completion": completion or 0,
        "total": total or 0,
    }


def _nested_int(value: Any, key: str) -> int | None:
    number = _nested_number(value, key)
    return int(number) if number is not None else None


def _nested_number(value: Any, key: str) -> float | None:
    if not isinstance(value, dict):
        return None
    number = value.get(key)
    return number if isinstance(number, (int, float)) else None


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return None


def _to_iso_z(value: datetime) -> str:
    normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return normalized.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _latency_ms(start_time: datetime | None, end_time: datetime | None) -> int | None:
    if not start_time or not end_time:
        return None
    return max(0, int((end_time - start_time).total_seconds() * 1000))


def _first_time(items: list[dict[str, Any]], key: str) -> datetime | None:
    for item in items:
        parsed = _parse_time(item.get(key))
        if parsed:
            return parsed
    return None


def _last_time(items: list[dict[str, Any]], key: str) -> datetime | None:
    for item in reversed(items):
        parsed = _parse_time(item.get(key))
        if parsed:
            return parsed
    return None


def _first_value(items: list[dict[str, Any]], key: str) -> Any:
    for item in items:
        value = item.get(key)
        if value is not None:
            return value
    return None


def _last_value(items: list[dict[str, Any]], key: str) -> Any:
    for item in reversed(items):
        value = item.get(key)
        if value is not None:
            return value
    return None
