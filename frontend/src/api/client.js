import { API_BASE } from "../config";

export const AUTH_STORAGE_KEY = "agent_monitor_auth";

export function getStoredAuth() {
  try {
    return JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

export function storeAuth(auth) {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

export async function fetchJson(path, options = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const headers = new Headers(options.headers || {});
  const auth = getStoredAuth();
  if (auth?.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${auth.token}`);
  }
  const started = performance.now();
  const response = await fetch(url, { ...options, headers });
  if (!path.startsWith("/audit/")) {
    auditClientEvent({
      eventType: "frontend_api_call",
      status: response.ok ? "success" : "error",
      module: "frontend/api",
      function: `${options.method || "GET"} ${path}`,
      message: response.ok ? "API call completed" : "API call failed",
      metadata: { path, statusCode: response.status, durationMs: Math.round(performance.now() - started) },
    });
  }
  if (response.status === 401) {
    clearAuth();
    window.dispatchEvent(new CustomEvent("agent-monitor-auth-expired"));
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.detail || payload.error || JSON.stringify(payload);
    } catch {
      const text = await response.text();
      if (text) message = text;
    }
    throw new Error(message);
  }
  return response.json();
}

export function auditClientEvent(event) {
  const auth = getStoredAuth();
  if (!auth?.token) return;
  fetch(`${API_BASE}/audit/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => {});
}
