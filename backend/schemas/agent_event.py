from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


EventType = Literal[
    "run_start",
    "run_end",
    "step_start",
    "step_end",
    "tool_call_start",
    "tool_call_end",
    "tool_call_error",
    "llm_call_start",
    "llm_call_end",
    "token_usage",
    "loop_detected",
    "intent_drift",
    "human_handoff",
    "run_error",
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AgentEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(default_factory=lambda: str(uuid4()))
    run_id: str
    agent_id: str
    session_id: Optional[str] = None
    event_type: EventType
    timestamp: datetime = Field(default_factory=utc_now)
    step_name: Optional[str] = None
    tool_name: Optional[str] = None
    input_preview: Optional[str] = None
    output_preview: Optional[str] = None
    input_payload: Optional[Any] = None
    output_payload: Optional[Any] = None
    latency_ms: Optional[int] = None
    token_usage: Optional[Dict[str, int]] = None
    error: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


def preview(value: Any, limit: int = 200) -> Optional[str]:
    if value is None:
        return None
    text = value if isinstance(value, str) else repr(value)
    return text[:limit]
