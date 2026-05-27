import asyncio
import inspect
import json
import os
import queue
import sys
import threading
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
AUDIT_DIR = BACKEND_ROOT / "audit"
AUDIT_LOG = AUDIT_DIR / "audit.log"
_local = threading.local()
_profile_enabled = False
_event_queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=20000)
_writer_started = False
_async_queue: asyncio.Queue[dict[str, Any]] | None = None
_async_writer_task: asyncio.Task | None = None
_async_loop: asyncio.AbstractEventLoop | None = None
_dropped_events = 0
IGNORED_HTTP_PATHS = {"/favicon.ico", "/health", "/robots.txt", "/manifest.json"}
IGNORED_HTTP_PREFIXES = ("/assets/", "/audit/")
ACTIVE_AUDIT_WHERE = """
NOT (
    module = 'api'
    AND event_type IN ('http_request', 'http_response')
    AND (
        function_name IN (
            'GET /favicon.ico',
            'HEAD /favicon.ico',
            'GET /health',
            'HEAD /health',
            'GET /robots.txt',
            'HEAD /robots.txt',
            'GET /manifest.json',
            'HEAD /manifest.json'
        )
        OR metadata->>'path' IN ('/favicon.ico', '/health', '/robots.txt', '/manifest.json')
        OR metadata->>'path' LIKE '/assets/%'
        OR metadata->>'path' LIKE '/audit/%'
    )
)
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_safe(item) for item in value[:20]]
    if isinstance(value, dict):
        return {str(key): _safe(item) for key, item in list(value.items())[:40] if "password" not in str(key).lower() and "key" not in str(key).lower()}
    return repr(value)[:500]


def _decode_metadata(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            return {"raw": value}
    return {}


def is_ignored_audit_event(event: dict[str, Any]) -> bool:
    if event.get("module") != "api" or event.get("eventType") not in {"http_request", "http_response"}:
        return False
    metadata = _decode_metadata(event.get("metadata"))
    path = metadata.get("path") or str(event.get("function") or "").removeprefix("GET ").removeprefix("HEAD ")
    return path in IGNORED_HTTP_PATHS or any(str(path).startswith(prefix) for prefix in IGNORED_HTTP_PREFIXES)


def write_audit_event(
    event_type: str,
    *,
    status: str = "info",
    module: str | None = None,
    function: str | None = None,
    message: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    global _dropped_events
    if getattr(_local, "writing", False):
        return
    _local.writing = True
    try:
        safe_metadata = _safe(metadata or {})
        if is_ignored_audit_event({"eventType": event_type, "module": module or "unknown", "function": function or "", "metadata": safe_metadata}):
            return
        event = {
            "id": str(uuid.uuid4()),
            "timestamp": _now(),
            "eventType": event_type,
            "status": status,
            "module": module or "unknown",
            "function": function or "",
            "message": message or "",
            "metadata": safe_metadata,
        }
        if _async_loop and _async_queue:
            def enqueue() -> None:
                global _dropped_events
                try:
                    _async_queue.put_nowait(event)
                except asyncio.QueueFull:
                    _dropped_events += 1

            _async_loop.call_soon_threadsafe(enqueue)
        else:
            _ensure_writer()
            try:
                _event_queue.put_nowait(event)
            except queue.Full:
                _dropped_events += 1
    finally:
        _local.writing = False


def _ensure_writer() -> None:
    global _writer_started
    if _writer_started:
        return
    _writer_started = True
    thread = threading.Thread(target=_writer_loop, name="audit-log-writer", daemon=True)
    thread.start()


def _writer_loop() -> None:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        event = _event_queue.get()
        if event is None:
            return
        try:
            with AUDIT_LOG.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")
        except Exception:
            pass


async def start_audit_writer() -> None:
    global _async_queue, _async_writer_task, _async_loop
    if _async_writer_task:
        return
    _async_loop = asyncio.get_running_loop()
    _async_queue = asyncio.Queue(maxsize=20000)
    _async_writer_task = asyncio.create_task(_audit_db_writer(), name="audit-db-writer")
    write_audit_event("audit_writer_started", status="success", module="audit", function="start_audit_writer")


async def stop_audit_writer() -> None:
    global _async_writer_task, _async_queue, _async_loop
    if not _async_writer_task:
        return
    write_audit_event("audit_writer_stopping", status="info", module="audit", function="stop_audit_writer")
    await asyncio.sleep(0)
    _async_writer_task.cancel()
    await asyncio.gather(_async_writer_task, return_exceptions=True)
    _async_writer_task = None
    _async_queue = None
    _async_loop = None


async def _audit_db_writer() -> None:
    batch: list[dict[str, Any]] = []
    while True:
        try:
            if not batch:
                batch.append(await _async_queue.get())  # type: ignore[union-attr]
            deadline = asyncio.get_running_loop().time() + 0.5
            while len(batch) < 200:
                timeout = max(0, deadline - asyncio.get_running_loop().time())
                if timeout <= 0:
                    break
                try:
                    batch.append(await asyncio.wait_for(_async_queue.get(), timeout=timeout))  # type: ignore[union-attr]
                except TimeoutError:
                    break
            await _write_batch(batch)
            batch = []
        except asyncio.CancelledError:
            if batch:
                await _write_batch(batch)
            raise
        except Exception as error:
            _append_file_batch([{
                "id": str(uuid.uuid4()),
                "timestamp": _now(),
                "eventType": "audit_writer_error",
                "status": "error",
                "module": "audit",
                "function": "_audit_db_writer",
                "message": str(error),
                "metadata": {},
            }, *batch])
            batch = []
            await asyncio.sleep(1)


async def _write_batch(batch: list[dict[str, Any]]) -> None:
    if not batch:
        return
    _append_file_batch(batch)
    from services.db_writer import _pool_or_raise

    rows = [
        (
            event["id"],
            datetime.fromisoformat(str(event["timestamp"]).replace("Z", "+00:00")),
            event["eventType"],
            event["status"],
            event["module"],
            event.get("function") or "",
            event.get("message") or "",
            json.dumps(event.get("metadata") or {}),
        )
        for event in batch
    ]
    async with _pool_or_raise().acquire() as conn:
        await conn.executemany(
            """
            INSERT INTO audit_event (id, timestamp, event_type, status, module, function_name, message, metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
            ON CONFLICT (id) DO NOTHING
            """,
            rows,
        )


def _append_file_batch(batch: list[dict[str, Any]]) -> None:
    try:
        AUDIT_DIR.mkdir(parents=True, exist_ok=True)
        with AUDIT_LOG.open("a", encoding="utf-8") as handle:
            for event in batch:
                handle.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")
    except Exception:
        pass


def audited(module: str | None = None) -> Callable:
    def decorator(func: Callable) -> Callable:
        if inspect.iscoroutinefunction(func):
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                started = time.perf_counter()
                write_audit_event("function_call", module=module or func.__module__, function=func.__name__, metadata={"args": len(args), "kwargs": list(kwargs)})
                try:
                    result = await func(*args, **kwargs)
                    write_audit_event("function_return", status="success", module=module or func.__module__, function=func.__name__, metadata={"durationMs": round((time.perf_counter() - started) * 1000, 2)})
                    return result
                except Exception as error:
                    write_audit_event("function_error", status="error", module=module or func.__module__, function=func.__name__, message=str(error), metadata={"durationMs": round((time.perf_counter() - started) * 1000, 2)})
                    raise

            return async_wrapper

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            write_audit_event("function_call", module=module or func.__module__, function=func.__name__, metadata={"args": len(args), "kwargs": list(kwargs)})
            try:
                result = func(*args, **kwargs)
                write_audit_event("function_return", status="success", module=module or func.__module__, function=func.__name__, metadata={"durationMs": round((time.perf_counter() - started) * 1000, 2)})
                return result
            except Exception as error:
                write_audit_event("function_error", status="error", module=module or func.__module__, function=func.__name__, message=str(error), metadata={"durationMs": round((time.perf_counter() - started) * 1000, 2)})
                raise

        return wrapper

    return decorator


def _profile(frame: Any, event: str, arg: Any) -> None:
    if event not in {"call", "return", "exception"} or getattr(_local, "writing", False):
        return
    if str(frame.f_code.co_filename).startswith("<"):
        return
    filename = Path(frame.f_code.co_filename).resolve()
    try:
        filename.relative_to(BACKEND_ROOT)
    except ValueError:
        return
    ignored_parts = {".venv", ".venv-mac", "site-packages", "__pycache__"}
    if filename.name == "audit.py" or ignored_parts.intersection(filename.parts):
        return
    module = str(filename.relative_to(BACKEND_ROOT)).replace("\\", "/")
    function = frame.f_code.co_name
    if function.startswith("<"):
        return
    status = "error" if event == "exception" else "success" if event == "return" else "info"
    write_audit_event(f"python_{event}", status=status, module=module, function=function, metadata={"line": frame.f_lineno})


def start_function_tracing() -> None:
    global _profile_enabled
    if _profile_enabled:
        return
    if os.getenv("AUDIT_TRACE_FUNCTIONS", "false").lower() not in {"1", "true", "yes"}:
        return
    _profile_enabled = True
    sys.setprofile(_profile)
    threading.setprofile(_profile)
    write_audit_event("audit_tracing_started", status="success", module="audit", function="start_function_tracing")


def stop_function_tracing() -> None:
    global _profile_enabled
    if not _profile_enabled:
        return
    sys.setprofile(None)
    threading.setprofile(None)
    _profile_enabled = False
    write_audit_event("audit_tracing_stopped", status="success", module="audit", function="stop_function_tracing")


def read_audit_events(limit: int = 500) -> list[dict[str, Any]]:
    if not AUDIT_LOG.exists():
        return []
    lines = AUDIT_LOG.read_text(encoding="utf-8", errors="ignore").splitlines()[-limit:]
    events: list[dict[str, Any]] = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return list(reversed(events))


async def query_audit_events(limit: int = 500) -> list[dict[str, Any]]:
    try:
        from services.db_writer import _pool_or_raise

        async with _pool_or_raise().acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT id, timestamp, event_type, status, module, function_name, message, metadata
                FROM audit_event
                WHERE {ACTIVE_AUDIT_WHERE}
                ORDER BY timestamp DESC
                LIMIT $1
                """,
                limit,
            )
        return [_row_to_event(row) for row in rows]
    except Exception:
        return [event for event in read_audit_events(limit) if not is_ignored_audit_event(event)]


async def audit_summary() -> dict[str, Any]:
    try:
        from services.db_writer import _pool_or_raise

        async with _pool_or_raise().acquire() as conn:
            total = await conn.fetchval(f"SELECT COUNT(*) FROM audit_event WHERE {ACTIVE_AUDIT_WHERE}")
            errors = await conn.fetchval(f"SELECT COUNT(*) FROM audit_event WHERE {ACTIVE_AUDIT_WHERE} AND status='error'")
            ignored = await conn.fetchval(f"SELECT COUNT(*) FROM audit_event WHERE NOT ({ACTIVE_AUDIT_WHERE})")
            modules = await conn.fetch(f"SELECT module, COUNT(*) AS count FROM audit_event WHERE {ACTIVE_AUDIT_WHERE} GROUP BY module ORDER BY count DESC")
            statuses = await conn.fetch(f"SELECT status, COUNT(*) AS count FROM audit_event WHERE {ACTIVE_AUDIT_WHERE} GROUP BY status ORDER BY count DESC")
            event_types = await conn.fetch(f"SELECT event_type, COUNT(*) AS count FROM audit_event WHERE {ACTIVE_AUDIT_WHERE} GROUP BY event_type ORDER BY count DESC")
            functions = await conn.fetch(f"SELECT function_name, COUNT(*) AS count FROM audit_event WHERE {ACTIVE_AUDIT_WHERE} AND COALESCE(function_name, '') <> '' GROUP BY function_name ORDER BY count DESC LIMIT 200")
        return {
            "total": total or 0,
            "errors": errors or 0,
            "ignored": ignored or 0,
            "dropped": _dropped_events,
            "byModule": {row["module"]: row["count"] for row in modules},
            "byStatus": {row["status"]: row["count"] for row in statuses},
            "byEventType": {row["event_type"]: row["count"] for row in event_types},
            "byFunction": {row["function_name"]: row["count"] for row in functions},
        }
    except Exception:
        events = read_audit_events(5000)
        return _file_summary(events)


def _row_to_event(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "timestamp": row["timestamp"].isoformat(),
        "eventType": row["event_type"],
        "status": row["status"],
        "module": row["module"],
        "function": row["function_name"] or "",
        "message": row["message"] or "",
        "metadata": _decode_metadata(row["metadata"]),
    }


def _file_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    active_events = [event for event in events if not is_ignored_audit_event(event)]
    summary = {"total": len(active_events), "errors": 0, "ignored": len(events) - len(active_events), "dropped": _dropped_events, "byModule": {}, "byStatus": {}, "byEventType": {}, "byFunction": {}}
    for event in active_events:
        if event.get("status") == "error":
            summary["errors"] += 1
        for target, key in [("byModule", "module"), ("byStatus", "status"), ("byEventType", "eventType"), ("byFunction", "function")]:
            value = event.get(key) or ""
            if value:
                summary[target][value] = summary[target].get(value, 0) + 1
    return summary
