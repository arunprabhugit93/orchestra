from fastapi import APIRouter

from api.schemas import LangfuseImportRequest
from api.utils import parse_optional_datetime
from services.langfuse_importer import LangfuseImportError, import_langfuse_observations


router = APIRouter()


@router.post("/imports/langfuse")
async def import_langfuse(request: LangfuseImportRequest):
    try:
        return await import_langfuse_observations(
            agent_id="langfuse_import",
            limit=request.limit,
            from_start_time=parse_optional_datetime(request.from_start_time),
            to_start_time=parse_optional_datetime(request.to_start_time),
            trace_id=request.trace_id,
            user_id=request.user_id,
            session_id=request.session_id,
            environment=request.environment,
            max_pages=request.max_pages,
        )
    except LangfuseImportError as exc:
        return {"error": str(exc)}
