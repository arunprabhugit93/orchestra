import time
from typing import Any, Dict, List, Optional, Union

from langchain_core.callbacks import BaseCallbackHandler

from schemas.agent_event import AgentEvent, preview
from services.event_bus import publish_event


class AgentMonitorCallback(BaseCallbackHandler):
    def __init__(self, run_id: str, agent_id: str, session_id: str | None = None):
        self.run_id = run_id
        self.agent_id = agent_id
        self.session_id = session_id
        self._start_times: Dict[str, float] = {}
        self._tool_stack: list[str] = []
        self._chain_stack: list[str] = []
        self._original_intent: Optional[str] = None

    def _event(self, event_type: str, **kwargs: Any) -> AgentEvent:
        return AgentEvent(
            run_id=self.run_id,
            agent_id=self.agent_id,
            session_id=self.session_id,
            event_type=event_type,  # type: ignore[arg-type]
            **kwargs,
        )

    def _publish(self, event_type: str, **kwargs: Any) -> None:
        publish_event(self._event(event_type, **kwargs))

    def on_llm_start(self, serialized: Dict[str, Any], prompts: List[str], **kwargs: Any) -> None:
        if not self._original_intent and prompts:
            self._original_intent = prompts[0][:500]

        run_key = str(kwargs.get("run_id", "llm"))
        self._start_times[run_key] = time.perf_counter()
        self._publish(
            "llm_call_start",
            input_preview=preview(prompts[0] if prompts else None),
            metadata={"model": serialized.get("name") or serialized.get("id")},
        )

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        usage = response.llm_output.get("token_usage", {}) if getattr(response, "llm_output", None) else {}
        output = None
        generations = getattr(response, "generations", None)
        if generations and generations[0]:
            output = getattr(generations[0][0], "text", generations[0][0])

        run_key = str(kwargs.get("run_id", "llm"))
        self._publish(
            "llm_call_end",
            latency_ms=self._latency_ms(run_key),
            token_usage={
                "prompt": usage.get("prompt_tokens", 0),
                "completion": usage.get("completion_tokens", 0),
                "total": usage.get("total_tokens", 0),
            },
            output_preview=preview(output),
        )

    def on_llm_error(self, error: Union[Exception, KeyboardInterrupt], **kwargs: Any) -> None:
        self._publish("run_error", error=str(error), metadata={"phase": "llm"})

    def on_tool_start(self, serialized: Dict[str, Any], input_str: str, **kwargs: Any) -> None:
        tool_name = serialized.get("name") or serialized.get("id") or "unknown_tool"
        self._tool_stack.append(tool_name)
        self._start_times[f"tool:{tool_name}"] = time.perf_counter()
        self._publish(
            "tool_call_start",
            tool_name=tool_name,
            input_preview=preview(input_str),
        )

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        tool_name = self._tool_stack.pop() if self._tool_stack else None
        self._publish(
            "tool_call_end",
            tool_name=tool_name,
            latency_ms=self._latency_ms(f"tool:{tool_name}") if tool_name else None,
            output_preview=preview(output),
        )

    def on_tool_error(self, error: Union[Exception, KeyboardInterrupt], **kwargs: Any) -> None:
        tool_name = self._tool_stack.pop() if self._tool_stack else None
        self._publish("tool_call_error", tool_name=tool_name, error=str(error))

    def on_chain_start(self, serialized: Dict[str, Any], inputs: Dict[str, Any], **kwargs: Any) -> None:
        step_name = serialized.get("name") or serialized.get("id") or "unknown_node"
        self._chain_stack.append(step_name)
        self._start_times[f"chain:{step_name}"] = time.perf_counter()
        self._publish(
            "step_start",
            step_name=step_name,
            input_preview=preview(inputs),
        )

    def on_chain_end(self, outputs: Dict[str, Any], **kwargs: Any) -> None:
        step_name = self._chain_stack.pop() if self._chain_stack else None
        self._publish(
            "step_end",
            step_name=step_name,
            latency_ms=self._latency_ms(f"chain:{step_name}") if step_name else None,
            output_preview=preview(outputs),
        )

    def on_chain_error(self, error: Union[Exception, KeyboardInterrupt], **kwargs: Any) -> None:
        step_name = self._chain_stack.pop() if self._chain_stack else None
        self._publish("run_error", step_name=step_name, error=str(error), metadata={"phase": "chain"})

    def _latency_ms(self, key: str) -> int | None:
        started = self._start_times.pop(key, None)
        if started is None:
            return None
        return int((time.perf_counter() - started) * 1000)
