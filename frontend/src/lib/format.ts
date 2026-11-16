const DASH = "—";

export function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (!isNum(value)) return DASH;
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatCompact(value: number | null | undefined): string {
  if (!isNum(value)) return DASH;
  if (Math.abs(value) < 1000) return formatNumber(value, value % 1 ? 1 : 0);
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) return DASH;
  let size = Math.abs(value);
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 100 ? 0 : digits);
  return `${value < 0 ? "-" : ""}${text} ${BYTE_UNITS[unit]}`;
}

export function formatMs(value: number | null | undefined): string {
  if (!isNum(value)) return DASH;
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  if (value < 10_000) return `${Math.round(value)} ms`;
  return formatDuration(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (!isNum(ms)) return DASH;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatRate(value: number | null | undefined, unit = "/s"): string {
  if (!isNum(value)) return DASH;
  if (value === 0) return `0${unit}`;
  if (value < 0.1) return `<0.1${unit}`;
  if (value < 10) return `${value.toFixed(1)}${unit}`;
  return `${formatCompact(value)}${unit}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) return DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatTime(epochSeconds: number | null | undefined): string {
  if (!isNum(epochSeconds)) return DASH;
  return new Date(epochSeconds * 1000).toLocaleTimeString();
}

export function formatDateTime(epochSeconds: number | null | undefined): string {
  if (!isNum(epochSeconds)) return DASH;
  return new Date(epochSeconds * 1000).toLocaleString();
}

export function relativeTime(epochSeconds: number | null | undefined, now = Date.now() / 1000): string {
  if (!isNum(epochSeconds)) return DASH;
  const delta = Math.round(now - epochSeconds);
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function pluralize(count: number, word: string, plural = `${word}s`): string {
  return `${formatNumber(count)} ${count === 1 ? word : plural}`;
}
