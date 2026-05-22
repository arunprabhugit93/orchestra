from fastapi import APIRouter

from services.organization_graph import get_organization_graph


router = APIRouter(tags=["organization-graph"])


@router.get("/organization-graph")
async def organization_graph(tenant_id: str | None = None):
    return await get_organization_graph(tenant_id or "default")
