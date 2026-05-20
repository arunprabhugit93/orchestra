# Backend Agent Monitoring

This workspace is split into two separate projects:

```text
backend/
frontend/
```

Backend:

```text
C:\Users\ArunprabhuP\Documents\Backend Agent Monitoring\backend
```

Frontend:

```text
C:\Users\ArunprabhuP\Documents\Backend Agent Monitoring\frontend
```

Run backend:

```powershell
cd "C:\Users\ArunprabhuP\Documents\Backend Agent Monitoring\backend"
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8001
```

Run frontend:

```powershell
cd "C:\Users\ArunprabhuP\Documents\Backend Agent Monitoring\frontend"
..\backend\.venv\Scripts\python.exe -m http.server 5173 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:5173
```
