from fastapi import APIRouter

from services.db_writer import fetch_active_alerts


router = APIRouter()


@router.get("/alerts/active")
async def get_active_alerts(minutes: int = 30):
    return await fetch_active_alerts(minutes)
