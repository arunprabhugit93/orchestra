# Agent Monitor Backend

POC backend for monitoring LangGraph agent runs through a framework-agnostic event contract.

## Run locally

```powershell
cd "C:\Users\ArunprabhuP\Documents\Backend Agent Monitoring\backend"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
docker compose up -d
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

The dashboard can subscribe to:

```text
ws://127.0.0.1:8001/ws/events
```

The standalone frontend lives in `..\frontend\`. Serve it from that folder:

```powershell
cd "C:\Users\ArunprabhuP\Documents\Backend Agent Monitoring\frontend"
..\backend\.venv\Scripts\python.exe -m http.server 5173 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:5173
```

History and aggregate endpoints:

```text
GET /runs/{run_id}/events
GET /agents/{agent_id}/stats?hours=24
GET /alerts/active?minutes=30
POST /imports/langfuse
```

## Event contract

All producers emit `schemas.agent_event.AgentEvent`. Framework-specific details stay in callback adapters, while WebSocket clients, database persistence, and anomaly detection consume the canonical schema.

## Import from Langfuse

Agent credentials are stored in Postgres in `agent_integrations`. Public and secret keys are encrypted before insert and are never returned by the API.

Onboard agents from the frontend, or call the API:

```powershell
curl.exe -X POST http://127.0.0.1:8001/agents `
  -H "Content-Type: application/json" `
  -d "{\"agent_id\":\"claims_agent_prod\",\"display_name\":\"Claims Agent Production\",\"provider\":\"langfuse\",\"base_url\":\"https://hipaa.cloud.langfuse.com\",\"public_key\":\"pk-lf-...\",\"secret_key\":\"sk-lf-...\"}"
```

Then import recent observations for that agent:

```powershell
curl.exe -X POST http://127.0.0.1:8001/agents/claims_agent_prod/import-langfuse `
  -H "Content-Type: application/json" `
  -d "{\"limit\":100,\"max_pages\":5}"
```

Optional filters:

```json
{
  "trace_id": "trace-id",
  "user_id": "user-id",
  "session_id": "session-id",
  "environment": "production",
  "from_start_time": "2026-05-19T00:00:00Z",
  "to_start_time": "2026-05-20T00:00:00Z"
}
```
