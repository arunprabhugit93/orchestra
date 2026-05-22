const isLocalStaticServer =
  ["127.0.0.1", "localhost"].includes(window.location.hostname) &&
  ["5173", "5179"].includes(window.location.port);

export const API_BASE = isLocalStaticServer ? "http://127.0.0.1:8001" : window.location.origin;
export const WS_URL = isLocalStaticServer
  ? "ws://127.0.0.1:8001/ws/events"
  : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/events`;
