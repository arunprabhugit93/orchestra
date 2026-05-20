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


@lru_cache
def get_settings() -> Settings:
    return Settings()
