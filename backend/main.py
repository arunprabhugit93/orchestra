import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from api.routes import agents, alerts, auth, health, imports, organization_graph, runs, settings as settings_routes
from services.anomaly_detector import analyse_event
from services.db_writer import close_db, init_db, write_event
from services.event_bus import subscribe_events
from services.settings import get_settings
from services.auth import require_session


connected_clients: set[WebSocket] = set()
dispatcher_task: asyncio.Task | None = None


async def event_dispatcher() -> None:
    async for event in subscribe_events():
        analyse_event(event)
        await write_event(event)
        payload = event.model_dump_json()
        dead_clients: list[WebSocket] = []
        for websocket in connected_clients.copy():
            try:
                await websocket.send_text(payload)
            except Exception:
                dead_clients.append(websocket)
        for websocket in dead_clients:
            connected_clients.discard(websocket)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global dispatcher_task
    await init_db()
    dispatcher_task = asyncio.create_task(event_dispatcher())
    try:
        yield
    finally:
        if dispatcher_task:
            dispatcher_task.cancel()
            await asyncio.gather(dispatcher_task, return_exceptions=True)
        await close_db()


def create_app() -> FastAPI:
    app = FastAPI(title="Agent Monitor Backend", lifespan=lifespan)
    settings = get_settings()
    origins = ["*"] if settings.websocket_origins == "*" else settings.websocket_origins.split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(auth.router)
    protected = [Depends(require_session)]
    app.include_router(agents.router, dependencies=protected)
    app.include_router(runs.router, dependencies=protected)
    app.include_router(alerts.router, dependencies=protected)
    app.include_router(imports.router, dependencies=protected)
    app.include_router(organization_graph.router, dependencies=protected)
    app.include_router(settings_routes.router, dependencies=protected)

    @app.websocket("/ws/events")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        connected_clients.add(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            connected_clients.discard(websocket)

    return app


app = create_app()
