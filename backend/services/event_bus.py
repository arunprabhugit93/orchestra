import redis
import redis.asyncio as aioredis

from schemas.agent_event import AgentEvent
from services.settings import get_settings


_sync_client: redis.Redis | None = None


def _get_sync_client() -> redis.Redis:
    global _sync_client
    if _sync_client is None:
        _sync_client = redis.from_url(get_settings().redis_url)
    return _sync_client


def publish_event(event: AgentEvent) -> None:
    settings = get_settings()
    _get_sync_client().publish(settings.redis_channel, event.model_dump_json())


async def subscribe_events():
    settings = get_settings()
    client = aioredis.from_url(settings.redis_url)
    pubsub = client.pubsub()
    await pubsub.subscribe(settings.redis_channel)
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                yield AgentEvent.model_validate_json(message["data"])
    finally:
        await pubsub.unsubscribe(settings.redis_channel)
        await pubsub.close()
        await client.aclose()
