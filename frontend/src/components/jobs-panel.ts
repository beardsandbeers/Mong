import { html, nothing } from "lit";
import { api, errorMessage } from "../lib/api";
import { formatNumber, relativeTime } from "../lib/format";
import { appStore, dismissLostJob, refreshJobs } from "../lib/state";
import { StoreController } from "../lib/store";
import type { Job } from "../lib/types";
import { LightElement } from "./base";
import { icon } from "./icons";
import { toast } from "./toast";

const KIND_LABEL: Record<Job["kind"], string> = {
  clear_index: "Clear index",
  delete_by_query: "Delete by query",
  export: "Export",
};

const STATE_TONE: Record<string, string> = {
  queued: "info",
  running: "info",
  succeeded: "ok",
  failed: "danger",
  cancelled: "warn",
  lost: "warn",
};

export function jobProgress(job: Job) {
  const pct = job.total ? Math.min(100, (job.done / job.total) * 100) : null;
  const active = job.state === "running" || job.state === "queued";
  return html`<div class="progress ${active && pct === null ? "indeterminate" : ""}">
    <span style="width:${pct ?? (active ? 30 : 100)}%"></span>
  </div>`;
}

export function jobSummary(job: Job): string {
  const total = job.total != null ? ` of ${formatNumber(job.total)}` : "";
  return `${formatNumber(job.done)}${total} ${job.unit}`;
}

/** Popover listing background jobs with progress, cancel, and download. */
export class MongJobsPanel extends LightElement {
  private readonly app = new StoreController(this, appStore);
  private readonly onDocClick = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!this.contains(target) && !(target as HTMLElement).closest?.("[aria-expanded]")) {
      this.dispatchEvent(new CustomEvent("close"));
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    refreshJobs();
    setTimeout(() => document.addEventListener("click", this.onDocClick), 0);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this.onDocClick);
  }

  private async cancel(job: Job): Promise<void> {
    try {
      await api.cancelJob(job.id);
      toast(`Cancelling ${KIND_LABEL[job.kind].toLowerCase()} on ${job.index_name}`);
      await refreshJobs();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  private row(job: Job, lost = false) {
    const state = lost ? "lost" : job.state;
    const active = !lost && (job.state === "running" || job.state === "queued");
    return html`<div style="padding:10px 12px;border-bottom:1px solid var(--line)" class="stack">
      <div class="row between">
        <strong>${KIND_LABEL[job.kind] ?? job.kind}</strong>
        <span class="pill" data-tone=${STATE_TONE[state] ?? "neutral"}>${state}</span>
      </div>
      <div class="row between small muted">
        <a href=${`#/indexes/${encodeURIComponent(job.index_name)}`}>${job.index_name}</a>
        <span>${relativeTime(job.created_at)}</span>
      </div>
      ${lost
        ? html`<div class="small">Mong restarted while this job ran. It stopped part way; check the index.</div>`
        : html`${jobProgress(job)}
          <div class="small muted">${jobSummary(job)}${job.message ? ` · ${job.message}` : ""}</div>
          ${job.error ? html`<div class="small" style="color:var(--danger)">${job.error}</div>` : nothing}`}
      <div class="row">
        ${active ? html`<button class="btn secondary sm" @click=${() => this.cancel(job)}>${icon("stop", 12)} Cancel</button>` : nothing}
        ${!lost && job.downloadable
          ? html`<a class="btn sm" href=${api.jobDownloadUrl(job.id)} download>${icon("download", 12)} Download</a>`
          : nothing}
        ${lost ? html`<button class="btn ghost sm" @click=${() => dismissLostJob(job.id)}>Dismiss</button>` : nothing}
      </div>
    </div>`;
  }

  render() {
    const { jobs, lostJobs } = this.app.value;
    return html`<div class="popover" style="right:0;top:40px;width:360px;max-height:70vh;overflow:auto">
      <div class="row between" style="padding:10px 12px;border-bottom:1px solid var(--line)">
        <strong>Background jobs</strong>
        <span class="hint">Run on the server; closing the tab is fine</span>
      </div>
      ${lostJobs.map((job) => this.row(job, true))}
      ${jobs.map((job) => this.row(job))}
      ${!jobs.length && !lostJobs.length
        ? html`<div class="empty small">No jobs yet. Clearing an index, large deletes, and exports run here.</div>`
        : nothing}
    </div>`;
  }
}

customElements.define("mong-jobs-panel", MongJobsPanel);
