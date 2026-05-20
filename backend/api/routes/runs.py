from fastapi import APIRouter

from services.db_writer import fetch_recent_runs, fetch_run_events


router = APIRouter()


@router.get("/runs")
async def get_runs(limit: int = 50, agent_id: str | None = None):
    return await fetch_recent_runs(limit, agent_id)


@router.get("/runs/{run_id}/events")
async def get_run_events(run_id: str, agent_id: str | None = None):
    return await fetch_run_events(run_id, agent_id)
