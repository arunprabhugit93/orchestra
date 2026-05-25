from fastapi import APIRouter, Depends, HTTPException

from api.schemas import OtpRequest, OtpVerifyRequest
from services.auth import request_login_otp, require_session, verify_login_otp


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/request-otp")
async def request_otp(request: OtpRequest):
    try:
        return await request_login_otp(request.email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/verify-otp")
async def verify_otp(request: OtpVerifyRequest):
    try:
        return await verify_login_otp(request.email, request.otp)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/me")
async def me(session: dict[str, str] = Depends(require_session)):
    return session
