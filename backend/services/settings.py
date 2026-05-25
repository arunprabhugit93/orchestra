from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    redis_url: str = "redis://localhost:6379/0"
    redis_channel: str = "agent_events"
    database_url: str = "postgresql://user:pass@localhost:5432/agent_monitor"
    websocket_origins: str = "*"
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None
    langfuse_base_url: str = "https://cloud.langfuse.com"
    agent_secret_key: str | None = None
    login_allowed_emails: str = ""
    login_otp_minutes: int = 10
    login_session_hours: int = 12
    login_show_dev_otp: bool = True
    login_dev_otp_enabled: bool = False
    login_dev_otp: str = "123456"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from_email: str | None = None
    smtp_use_tls: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
