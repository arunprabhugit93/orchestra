export function formatDate(value) {
  if (!value) return "n/a";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(new Date(value));
}

export function formatDuration(ms) {
  if (!ms) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatCost(value) {
  const cost = Number(value || 0);
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}

export function shortId(value) {
  if (!value) return "n/a";
  return value.length > 16 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

export function formatPayloadValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const encoded = JSON.stringify(value);
  return encoded.length > 1200 ? `${encoded.slice(0, 1200)}...` : encoded;
}
