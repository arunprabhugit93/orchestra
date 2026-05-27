import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from api.routes import agents, ai_intake, alerts, audit, auth, health, imports, organization_graph, runs, settings as settings_routes
from services.anomaly_detector import analyse_event
from services.audit import is_ignored_audit_event, start_audit_writer, start_function_tracing, stop_audit_writer, stop_function_tracing, write_audit_event
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
    await start_audit_writer()
    start_function_tracing()
    dispatcher_task = asyncio.create_task(event_dispatcher())
    try:
        yield
    finally:
        if dispatcher_task:
            dispatcher_task.cancel()
            await asyncio.gather(dispatcher_task, return_exceptions=True)
        stop_function_tracing()
        await stop_audit_writer()
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
    app.include_router(ai_intake.router, dependencies=protected)
    app.include_router(audit.router, dependencies=protected)
    app.include_router(runs.router, dependencies=protected)
    app.include_router(alerts.router, dependencies=protected)
    app.include_router(imports.router, dependencies=protected)
    app.include_router(organization_graph.router, dependencies=protected)
    app.include_router(settings_routes.router, dependencies=protected)

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> Response:
        return Response(status_code=204)

    @app.websocket("/ws/events")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        connected_clients.add(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            connected_clients.discard(websocket)

    @app.middleware("http")
    async def audit_http_requests(request, call_next):
        request_function = f"{request.method} {request.url.path}"
        request_metadata = {"path": request.url.path, "method": request.method}
        if is_ignored_audit_event({"eventType": "http_request", "module": "api", "function": request_function, "metadata": request_metadata}):
            return await call_next(request)
        write_audit_event("http_request", module="api", function=request_function, metadata=request_metadata)
        try:
            response = await call_next(request)
            write_audit_event("http_response", status="success" if response.status_code < 400 else "error", module="api", function=request_function, metadata={"path": request.url.path, "method": request.method, "statusCode": response.status_code})
            return response
        except Exception as error:
            write_audit_event("http_error", status="error", module="api", function=request_function, message=str(error), metadata=request_metadata)
            raise

    return app


app = create_app()
