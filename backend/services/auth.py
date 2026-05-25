import hashlib
import asyncio
import re
import secrets
import smtplib
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from fastapi import Header, HTTPException

from services.db_writer import _pool_or_raise
from services.settings import get_settings


EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalize_email(email: str) -> str:
    normalized = email.strip().lower()
    if not EMAIL_PATTERN.match(normalized):
        raise ValueError("Enter a valid email address.")
    allowed = [item.strip().lower() for item in get_settings().login_allowed_emails.split(",") if item.strip()]
    if allowed and normalized not in allowed:
        raise ValueError("This email is not allowed to access the application.")
    return normalized


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _smtp_ready() -> bool:
    settings = get_settings()
    return bool(settings.smtp_host and settings.smtp_from_email)


def _send_otp_email_sync(email: str, otp: str, expires_in_minutes: int) -> None:
    settings = get_settings()
    if not settings.smtp_host or not settings.smtp_from_email:
        raise RuntimeError("SMTP is not configured.")
    message = EmailMessage()
    message["Subject"] = "Agent Monitor login OTP"
    message["From"] = settings.smtp_from_email
    message["To"] = email
    message.set_content(
        "\n".join(
            [
                "Your Agent Monitor one-time passcode is:",
                "",
                otp,
                "",
                f"This code expires in {expires_in_minutes} minutes.",
                "If you did not request this code, ignore this email.",
            ]
        )
    )
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
        if settings.smtp_use_tls:
            smtp.starttls()
        if settings.smtp_username and settings.smtp_password:
            smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(message)


async def _send_otp_email(email: str, otp: str, expires_in_minutes: int) -> None:
    await asyncio.to_thread(_send_otp_email_sync, email, otp, expires_in_minutes)


async def request_login_otp(email: str) -> dict[str, str | int]:
    normalized = _normalize_email(email)
    otp = f"{secrets.randbelow(1_000_000):06d}"
    expires_in_minutes = max(1, get_settings().login_otp_minutes)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_in_minutes)
    async with _pool_or_raise().acquire() as conn:
        await conn.execute("DELETE FROM login_otp WHERE email=$1 AND (consumed_at IS NOT NULL OR expires_at < NOW())", normalized)
        await conn.execute(
            """
            INSERT INTO login_otp (id, email, otp_hash, expires_at)
            VALUES ($1,$2,$3,$4)
            """,
            str(uuid.uuid4()),
            normalized,
            _hash(otp),
            expires_at,
        )
    if _smtp_ready():
        try:
            await _send_otp_email(normalized, otp, expires_in_minutes)
        except Exception as exc:
            raise ValueError(f"Could not send OTP email: {exc}") from exc
        response: dict[str, str | int] = {"email": normalized, "expires_in_minutes": expires_in_minutes, "delivery": "email"}
        if get_settings().login_show_dev_otp:
            response["dev_otp"] = otp
        return response
    # Local POC behavior: return the OTP so login works before SMTP is configured.
    return {"email": normalized, "expires_in_minutes": expires_in_minutes, "delivery": "development", "dev_otp": otp}


async def verify_login_otp(email: str, otp: str) -> dict[str, str]:
    normalized = _normalize_email(email)
    clean_otp = re.sub(r"\D", "", otp)
    if len(clean_otp) != 6:
        raise ValueError("Enter the 6 digit OTP.")
    settings = get_settings()
    dev_otp_matches = settings.login_dev_otp_enabled and clean_otp == re.sub(r"\D", "", settings.login_dev_otp)
    async with _pool_or_raise().acquire() as conn:
        if dev_otp_matches:
            await conn.execute(
                "UPDATE login_otp SET consumed_at=NOW() WHERE email=$1 AND consumed_at IS NULL",
                normalized,
            )
        else:
            row = await conn.fetchrow(
                """
                SELECT id FROM login_otp
                WHERE email=$1 AND otp_hash=$2 AND consumed_at IS NULL AND expires_at >= NOW()
                ORDER BY created_at DESC
                LIMIT 1
                """,
                normalized,
                _hash(clean_otp),
            )
            if not row:
                raise ValueError("OTP is invalid or expired.")
            await conn.execute("UPDATE login_otp SET consumed_at=NOW() WHERE id=$1", row["id"])
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=max(1, settings.login_session_hours))
        await conn.execute(
            """
            INSERT INTO login_session (token_hash, email, expires_at)
            VALUES ($1,$2,$3)
            """,
            _hash(token),
            normalized,
            expires_at,
        )
    return {"token": token, "email": normalized, "expires_at": expires_at.isoformat()}


async def get_session(token: str) -> dict[str, str] | None:
    async with _pool_or_raise().acquire() as conn:
        await conn.execute("DELETE FROM login_session WHERE expires_at < NOW()")
        row = await conn.fetchrow(
            "SELECT email, expires_at FROM login_session WHERE token_hash=$1 AND expires_at >= NOW()",
            _hash(token),
        )
    if not row:
        return None
    return {"email": row["email"], "expires_at": row["expires_at"].isoformat()}


async def require_session(authorization: str | None = Header(default=None)) -> dict[str, str]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Login required")
    session = await get_session(authorization.split(" ", 1)[1].strip())
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")
    return session
