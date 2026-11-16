import { html } from "lit";
import { confirmDialog } from "../components/dialog";
import { toast } from "../components/toast";
import { logActivity, track } from "./activity";
import { api, ApiError, errorMessage, type JobRequest } from "./api";
import { formatNumber } from "./format";
import { navigate } from "./router";
import { refreshSummary, rememberJob } from "./state";
import type { IndexInfo, Job, SummaryIndex } from "./types";

const JOB_LABELS: Record<Job["kind"], string> = {
  clear_index: "Clear index",
  delete_by_query: "Delete by query",
  export: "Export",
};

function documentCount(index: IndexInfo | SummaryIndex): number | null {
  return (index as SummaryIndex).metrics?.documents ?? index.stats?.documents ?? null;
}

/** Start a server-side job, track it in this browser, and open the jobs panel. */
export async function startJob(
  index: IndexInfo,
  body: { kind: Job["kind"]; [key: string]: unknown },
): Promise<Job | null> {
  try {
    const job = await api.createJob({ ...body, index_id: index.index_id } as JobRequest);
    rememberJob(job);
    logActivity({ action: `${JOB_LABELS[job.kind]} job started`, index: index.name, ok: true, detail: `Job ${job.id}`, ms: null });
    window.dispatchEvent(new CustomEvent("mong:jobs-changed"));
    window.dispatchEvent(new CustomEvent("mong:open-jobs"));
    toast(`${JOB_LABELS[job.kind]} started for ${index.name}. Progress is in the Jobs panel.`);
    return job;
  } catch (error) {
    logActivity({ action: `${JOB_LABELS[body.kind]} job`, index: index.name, ok: false, detail: errorMessage(error), ms: null });
    toast(errorMessage(error), "error");
    return null;
  }
}

/** Drop an index after the user types its name. Returns true when dropped. */
export async function dropIndexFlow(index: IndexInfo | SummaryIndex): Promise<boolean> {
  const docs = documentCount(index);
  const ok = await confirmDialog({
    title: `Drop ${index.name}?`,
    message: html`<p>
        This permanently deletes the index${docs != null ? html` and its <strong>${formatNumber(docs)}</strong> documents` : ""}.
        Queries against it will fail. This cannot be undone.
      </p>
      <p class="muted small">Saved queries and history that refer to it are kept.</p>`,
    confirmText: "Drop index",
    danger: true,
    typeToConfirm: index.name,
  });
  if (!ok) return false;
  try {
    await track("Drop index", index.name, () => api.dropIndex(index.index_id, index.desired_revision), () => `revision ${index.desired_revision}`);
    toast(`Dropped ${index.name}.`);
    await refreshSummary({ force: true });
    navigate("indexes");
    return true;
  } catch (error) {
    const message =
      error instanceof ApiError && error.isConflict
        ? "The index changed since this page loaded (its revision moved). Reload and try again."
        : errorMessage(error);
    toast(message, "error");
    return false;
  }
}

/** Delete every document as a server-side job, after the user types the index name. */
export async function clearIndexFlow(index: IndexInfo | SummaryIndex): Promise<Job | null> {
  const docs = documentCount(index);
  const ok = await confirmDialog({
    title: `Delete all documents in ${index.name}?`,
    message: html`<p>
        Runs on the server in passes of 10,000 until the index is empty${docs != null ? html` (about <strong>${formatNumber(docs)}</strong> documents)` : ""}.
        The definition is kept. You can cancel between passes; documents already deleted stay deleted.
      </p>`,
    confirmText: "Delete all documents",
    danger: true,
    typeToConfirm: index.name,
  });
  if (!ok) return null;
  return startJob(index, { kind: "clear_index", estimate: docs ?? undefined });
}
