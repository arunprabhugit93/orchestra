from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
import json
from pathlib import Path

from services.audit import audit_summary, query_audit_events, write_audit_event


router = APIRouter(prefix="/audit", tags=["audit"])


class ClientAuditEvent(BaseModel):
    eventType: str = "client_event"
    status: str = "info"
    module: str = "frontend"
    function: str = ""
    message: str = ""
    metadata: dict = Field(default_factory=dict)


@router.get("/events")
async def audit_events(limit: int = Query(500, ge=1, le=5000)):
    return await query_audit_events(limit)


@router.get("/summary")
async def summary():
    return await audit_summary()


@router.get("/coverage")
async def audit_coverage():
    manifest = Path(__file__).resolve().parents[3] / "audit" / "audit_manifest.json"
    if not manifest.exists():
        return {"generatedAt": None, "functions": []}
    return json.loads(manifest.read_text(encoding="utf-8"))


@router.post("/events")
async def add_audit_event(event: ClientAuditEvent):
    write_audit_event(
        event.eventType,
        status=event.status,
        module=event.module,
        function=event.function,
        message=event.message,
        metadata=event.metadata,
    )
    return {"status": "logged"}
