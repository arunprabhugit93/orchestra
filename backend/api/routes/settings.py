from fastapi import APIRouter, HTTPException, Query

from api.schemas import (
    MoveNodeRequest,
    NodeTypeReorderItem,
    NodeTypeRequest,
    OrganizationNodeRequest,
    ReorderNodesRequest,
)
from services.organization_settings import (
    DEFAULT_TENANT_ID,
    archive_node,
    check_duplicate_code,
    check_duplicate_name,
    create_node,
    create_node_type,
    get_breadcrumb,
    get_children,
    get_hierarchy,
    get_node,
    list_node_types,
    move_node,
    reorder_node_types,
    reorder_nodes,
    search_nodes,
    update_node,
    update_node_type,
)


router = APIRouter(prefix="/settings", tags=["settings"])


def _tenant(tenant_id: str | None) -> str:
    return tenant_id or DEFAULT_TENANT_ID


def _value_error(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/node-types")
async def get_node_types(tenant_id: str | None = None):
    return await list_node_types(_tenant(tenant_id))


@router.post("/node-types")
async def add_node_type(request: NodeTypeRequest, tenant_id: str | None = None):
    try:
        return await create_node_type(request.model_dump(), _tenant(tenant_id))
    except ValueError as exc:
        raise _value_error(exc) from exc


@router.put("/node-types/{type_id}")
async def edit_node_type(type_id: str, request: NodeTypeRequest, tenant_id: str | None = None):
    try:
        row = await update_node_type(type_id, request.model_dump(), _tenant(tenant_id))
    except ValueError as exc:
        raise _value_error(exc) from exc
    if not row:
        raise HTTPException(status_code=404, detail="Node type not found")
    return row


@router.post("/node-types/reorder")
async def reorder_types(items: list[NodeTypeReorderItem], tenant_id: str | None = None):
    return await reorder_node_types([item.model_dump() for item in items], _tenant(tenant_id))


@router.get("/organization-nodes/hierarchy")
async def full_hierarchy(tenant_id: str | None = None):
    return await get_hierarchy(_tenant(tenant_id))


@router.get("/organization-nodes/search")
async def search_organization_nodes(
    q: str = "",
    status: str | None = None,
    node_type_id: str | None = None,
    tenant_id: str | None = None,
):
    return await search_nodes(q, status, node_type_id, _tenant(tenant_id))


@router.get("/organization-nodes/children")
async def children(parent_id: str | None = None, tenant_id: str | None = None):
    return await get_children(parent_id, _tenant(tenant_id))


@router.get("/organization-nodes/check-code")
async def duplicate_code(node_code: str, node_id: str | None = None, tenant_id: str | None = None):
    return await check_duplicate_code(node_code, node_id, _tenant(tenant_id))


@router.get("/organization-nodes/check-name")
async def duplicate_name(node_name: str, parent_id: str | None = None, node_id: str | None = None, tenant_id: str | None = None):
    return await check_duplicate_name(node_name, parent_id, node_id, _tenant(tenant_id))


@router.get("/organization-nodes/{node_id}")
async def organization_node(node_id: str, tenant_id: str | None = None):
    row = await get_node(node_id, _tenant(tenant_id))
    if not row:
        raise HTTPException(status_code=404, detail="Organization node not found")
    return row


@router.post("/organization-nodes")
async def add_organization_node(request: OrganizationNodeRequest, tenant_id: str | None = None):
    try:
        return await create_node(request.model_dump(), _tenant(tenant_id))
    except ValueError as exc:
        raise _value_error(exc) from exc


@router.put("/organization-nodes/{node_id}")
async def edit_organization_node(node_id: str, request: OrganizationNodeRequest, tenant_id: str | None = None):
    try:
        row = await update_node(node_id, request.model_dump(), _tenant(tenant_id))
    except ValueError as exc:
        raise _value_error(exc) from exc
    if not row:
        raise HTTPException(status_code=404, detail="Organization node not found")
    return row


@router.post("/organization-nodes/{node_id}/archive")
async def archive_organization_node(node_id: str, tenant_id: str | None = None):
    row = await archive_node(node_id, _tenant(tenant_id))
    if not row:
        raise HTTPException(status_code=404, detail="Organization node not found")
    return row


@router.post("/organization-nodes/{node_id}/move")
async def move_organization_node(node_id: str, request: MoveNodeRequest, tenant_id: str | None = None):
    try:
        row = await move_node(node_id, request.new_parent_id, _tenant(tenant_id))
    except ValueError as exc:
        raise _value_error(exc) from exc
    if not row:
        raise HTTPException(status_code=404, detail="Organization node not found")
    return row


@router.post("/organization-nodes/reorder")
async def reorder_organization_nodes(request: ReorderNodesRequest, tenant_id: str | None = None):
    return await reorder_nodes(request.parent_id, [item.model_dump() for item in request.items], _tenant(tenant_id))


@router.get("/organization-nodes/{node_id}/breadcrumb")
async def breadcrumb(node_id: str, tenant_id: str | None = None):
    return await get_breadcrumb(node_id, _tenant(tenant_id))
