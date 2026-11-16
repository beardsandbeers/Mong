import { html } from "lit";
import { formatBytes } from "./format";
import type { ByteMeasurement } from "./types";

type Measurement = Partial<ByteMeasurement> & { included_components?: string[] };

export function measureValue(m: Measurement | null | undefined): number | null {
  if (!m || m.completeness === "UNAVAILABLE") return null;
  return typeof m.value === "number" ? m.value : null;
}

export function isPartial(m: Measurement | null | undefined): boolean {
  return m?.completeness === "PARTIAL";
}

/** Tooltip explaining how a byte figure was measured and what it leaves out. */
export function measureTitle(m: Measurement | null | undefined): string {
  if (!m) return "Not reported";
  const parts = [`Method: ${m.method ?? "unknown"}`, `Completeness: ${m.completeness ?? "unknown"}`];
  if (m.included_components?.length) parts.push(`Includes: ${m.included_components.join(", ")}`);
  if (m.omitted_components?.length) parts.push(`Leaves out: ${m.omitted_components.join(", ")}`);
  return parts.join("\n");
}

/** `1.2 MB`, `1.2 MB*` when partial (a lower bound), or `—` when unavailable. */
export function measureText(m: Measurement | null | undefined): string {
  const value = measureValue(m);
  if (value === null) return "—";
  return `${formatBytes(value)}${isPartial(m) ? "*" : ""}`;
}

export function measureCell(m: Measurement | null | undefined) {
  return html`<span title=${measureTitle(m)}>${measureText(m)}</span>`;
}
