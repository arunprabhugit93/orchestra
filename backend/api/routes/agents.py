from fastapi import APIRouter, HTTPException

from api.schemas import AgentOnboardRequest, AgentUpdateRequest, LangfuseImportRequest
from api.utils import parse_optional_datetime
from services.agent_registry import delete_agent, get_agent_credentials, list_agents, save_agent, update_agent
from services.db_writer import fetch_agent_stats
from services.langfuse_importer import LangfuseImportError, import_langfuse_observations


router = APIRouter()


@router.get("/agents/{agent_id}/stats")
async def get_agent_stats(agent_id: str, hours: int = 24):
    return await fetch_agent_stats(agent_id, hours)


@router.get("/agents")
async def get_agents():
    return await list_agents()


@router.post("/agents")
async def onboard_agent(request: AgentOnboardRequest):
    try:
        return await save_agent(
            display_name=request.display_name,
            provider=request.provider,
            base_url=request.base_url,
            public_key=request.public_key,
            secret_key=request.secret_key,
            metadata=request.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/agents/{agent_id}")
async def edit_agent(agent_id: str, request: AgentUpdateRequest):
    try:
        agent = await update_agent(
            agent_id=agent_id,
            display_name=request.display_name,
            provider=request.provider,
            base_url=request.base_url,
            public_key=request.public_key,
            secret_key=request.secret_key,
            metadata=request.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.delete("/agents/{agent_id}")
async def remove_agent(agent_id: str):
    deleted = await delete_agent(agent_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Agent not found")
    return {"deleted": True, "agent_id": agent_id}


@router.post("/agents/{agent_id}/import-langfuse")
async def import_agent_langfuse(agent_id: str, request: LangfuseImportRequest):
    credentials = await get_agent_credentials(agent_id)
    if not credentials:
        raise HTTPException(status_code=404, detail="Agent not found")
    if credentials["provider"] != "langfuse":
        raise HTTPException(status_code=400, detail="Agent provider is not Langfuse")
    try:
        return await import_langfuse_observations(
            agent_id=agent_id,
            base_url=credentials["base_url"],
            public_key=credentials["public_key"],
            secret_key=credentials["secret_key"],
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
