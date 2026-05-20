from collections import defaultdict

from schemas.agent_event import AgentEvent
from services.event_bus import publish_event


class RunState:
    def __init__(self) -> None:
        self.tool_counts: dict[str, int] = defaultdict(int)
        self.total_tokens = 0
        self.step_count = 0


_run_states: dict[str, RunState] = {}

THRESHOLDS = {
    "loop_tool_calls": 3,
    "max_tokens_per_run": 50_000,
    "max_steps": 20,
}


def analyse_event(event: AgentEvent) -> None:
    if event.metadata.get("alert"):
        return

    state = _run_states.setdefault(event.run_id, RunState())

    if event.event_type == "tool_call_start" and event.tool_name:
        state.tool_counts[event.tool_name] += 1
        count = state.tool_counts[event.tool_name]
        if count > THRESHOLDS["loop_tool_calls"]:
            _emit_alert(event, "loop_detected", f"Tool '{event.tool_name}' called {count} times")

    if event.event_type == "step_start":
        state.step_count += 1
        if state.step_count > THRESHOLDS["max_steps"]:
            _emit_alert(event, "run_error", f"Step budget exceeded: {state.step_count}")

    if event.token_usage:
        state.total_tokens += event.token_usage.get("total", 0)
        if state.total_tokens > THRESHOLDS["max_tokens_per_run"]:
            _emit_alert(event, "run_error", f"Token budget exceeded: {state.total_tokens}")

    if event.event_type in ("run_end", "run_error"):
        _run_states.pop(event.run_id, None)


def _emit_alert(source_event: AgentEvent, alert_type: str, message: str) -> None:
    publish_event(
        AgentEvent(
            run_id=source_event.run_id,
            agent_id=source_event.agent_id,
            session_id=source_event.session_id,
            event_type=alert_type,
            step_name=source_event.step_name,
            tool_name=source_event.tool_name,
            error=message,
            metadata={"alert": True, "source_event_id": source_event.event_id},
        )
    )
