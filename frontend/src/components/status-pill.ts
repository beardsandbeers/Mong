import { html } from "lit";
import type { IndexInfo, SummaryIndex } from "../lib/types";
import { LightElement } from "./base";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

export interface IndexStatus {
  tone: Tone;
  label: string;
  detail: string;
}

const STATUS_TONES: Record<string, Tone> = {
  STEADY: "ok",
  INITIAL_SYNC: "info",
  NOT_STARTED: "info",
  STALE: "warn",
  RECOVERING_TRANSIENT: "warn",
  RECOVERING_NON_TRANSIENT: "danger",
  FAILED: "danger",
  DOES_NOT_EXIST: "danger",
  UNKNOWN: "neutral",
};

/** One status for an index from its lifecycle state, revisions, and status metric. */
export function indexStatus(index: IndexInfo | SummaryIndex): IndexStatus {
  const label = (index as SummaryIndex).metrics?.status_label ?? null;
  if (index.failure_message) {
    return { tone: "danger", label: "Failed", detail: index.failure_message };
  }
  const lifecycle = String(index.lifecycle_state || "").toUpperCase();
  if (lifecycle && lifecycle !== "READY") {
    const tone: Tone = STATUS_TONES[lifecycle] ?? (lifecycle.includes("FAIL") ? "danger" : "info");
    return { tone, label: titleCase(lifecycle), detail: `Lifecycle state ${lifecycle}` };
  }
  if (index.desired_revision !== index.active_revision) {
    return {
      tone: "info",
      label: "Rebuilding",
      detail: `Revision ${index.desired_revision} is building; revision ${index.active_revision} is active.`,
    };
  }
  if (label && label !== "STEADY") {
    return { tone: STATUS_TONES[label] ?? "neutral", label: titleCase(label), detail: `Index status ${label}` };
  }
  return { tone: "ok", label: "Ready", detail: label ? "Steady" : "Ready" };
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function statusPill(index: IndexInfo | SummaryIndex) {
  const status = indexStatus(index);
  return html`<span class="pill" data-tone=${status.tone} title=${status.detail}>
    <span class="dot" data-tone=${status.tone}></span>${status.label}
  </span>`;
}

export function statusDot(index: IndexInfo | SummaryIndex) {
  const status = indexStatus(index);
  return html`<span class="dot" data-tone=${status.tone} title=${`${status.label}: ${status.detail}`}></span>`;
}

export class MongStatusPill extends LightElement {
  static properties = { index: { attribute: false } };
  declare index: IndexInfo | SummaryIndex | null;

  constructor() {
    super();
    this.index = null;
  }

  render() {
    return this.index ? statusPill(this.index) : html``;
  }
}

customElements.define("mong-status-pill", MongStatusPill);
