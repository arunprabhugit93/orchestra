import { API_BASE } from "../config";

export async function fetchJson(path, options = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const response = await fetch(url, options);
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
