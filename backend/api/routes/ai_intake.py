from fastapi import APIRouter, HTTPException

from api.schemas import AiIntakeRequestPayload, AiIntakeUpdatePayload, AiQualificationCommentRequest
from services.ai_intake import create_request, dashboard, generate_qualification_comments, get_request, list_requests, update_request


router = APIRouter(prefix="/ai-intake", tags=["ai-intake"])


@router.get("/requests")
async def requests(status: str | None = None):
    return await list_requests(status)


@router.get("/dashboard")
async def intake_dashboard():
    return await dashboard()


@router.get("/requests/{request_id}")
async def request_detail(request_id: str):
    row = await get_request(request_id)
    if not row:
        raise HTTPException(status_code=404, detail="AI intake request not found")
    return row


@router.post("/requests")
async def add_request(request: AiIntakeRequestPayload):
    if not request.title.strip():
        raise HTTPException(status_code=400, detail="Request Title is required")
    return await create_request(request.model_dump())


@router.put("/requests/{request_id}")
async def edit_request(request_id: str, request: AiIntakeUpdatePayload):
    row = await update_request(request_id, request.model_dump(exclude_unset=True))
    if not row:
        raise HTTPException(status_code=404, detail="AI intake request not found")
    return row


@router.post("/qualification-comments")
async def qualification_comments(request: AiQualificationCommentRequest):
    return await generate_qualification_comments(request.request, request.enterprise_context)
