import { api, errorMessage } from "./api";
import { load, save } from "./storage";
import { Store } from "./store";
import type { Job, MetricsSummary, SummaryIndex } from "./types";

export type Connection = "unknown" | "ok" | "degraded" | "down";

export interface AppState {
  summary: MetricsSummary | null;
  indexes: SummaryIndex[];
  loaded: boolean;
  connection: Connection;
  connectionError: string | null;
  /** Names whose index id changed during this browser session (dropped and recreated). */
  recreated: string[];
  jobs: Job[];
  /** Jobs this browser started that the server no longer knows (Mong restarted). */
  lostJobs: Job[];
}

export const appStore = new Store<AppState>({
  summary: null,
  indexes: [],
  loaded: false,
  connection: "unknown",
  connectionError: null,
  recreated: [],
  jobs: [],
  lostJobs: [],
});

const SEEN_KEY = "seenIndexIds";
const seenIds = new Map<string, string>(Object.entries(load<Record<string, string>>(SEEN_KEY, {})));

function noteIndexes(indexes: SummaryIndex[]): string[] {
  const recreated = new Set(appStore.value.recreated);
  for (const index of indexes) {
    const previous = seenIds.get(index.name);
    if (previous && previous !== index.index_id) recreated.add(index.name);
    seenIds.set(index.name, index.index_id);
  }
  save(SEEN_KEY, Object.fromEntries(seenIds));
  return [...recreated];
}

let pending: Promise<void> | null = null;

/** Reload the metrics summary, which also carries the index list. */
export function refreshSummary(options: { force?: boolean } = {}): Promise<void> {
  if (pending && !options.force) return pending;
  const run = (async () => {
    try {
      const summary = await api.metricsSummary(Boolean(options.force));
      const indexes = [...summary.indexes].sort((a, b) => a.name.localeCompare(b.name));
      const hasError = summary.alerts.some((alert) => alert.severity === "error");
      appStore.set({
        summary,
        indexes: summary.connected || summary.indexes.length ? indexes : appStore.value.indexes,
        loaded: summary.connected || appStore.value.loaded,
        connection: !summary.connected ? "down" : hasError ? "degraded" : "ok",
        connectionError: summary.error,
        recreated: noteIndexes(indexes),
      });
    } catch (error) {
      appStore.set({ connection: "down", connectionError: errorMessage(error) });
    }
  })();
  pending = run.finally(() => {
    pending = null;
  });
  return pending;
}

export function indexByName(name: string | null | undefined): SummaryIndex | undefined {
  if (!name) return undefined;
  return appStore.value.indexes.find((index) => index.name === name);
}

export function indexById(id: string | null | undefined): SummaryIndex | undefined {
  if (!id) return undefined;
  return appStore.value.indexes.find((index) => index.index_id === id);
}

const JOBS_KEY = "jobs";

/** Reload jobs. Jobs this browser started that the server lost are kept and marked lost. */
export async function refreshJobs(): Promise<void> {
  try {
    const jobs = await api.jobs();
    const known = load<Job[]>(JOBS_KEY, []);
    const ids = new Set(jobs.map((job) => job.id));
    const lost = known.filter(
      (job) => !ids.has(job.id) && (job.state === "running" || job.state === "queued"),
    );
    const merged = [...appStore.value.lostJobs.filter((job) => !ids.has(job.id)), ...lost];
    const lostJobs = [...new Map(merged.map((job) => [job.id, { ...job }])).values()];
    save(JOBS_KEY, jobs.slice(0, 50));
    appStore.set({ jobs, lostJobs });
  } catch {
    // The summary poll reports connectivity.
  }
}

export function rememberJob(job: Job): void {
  const known = load<Job[]>(JOBS_KEY, []);
  save(JOBS_KEY, [job, ...known.filter((item) => item.id !== job.id)].slice(0, 50));
  appStore.set({ jobs: [job, ...appStore.value.jobs.filter((item) => item.id !== job.id)] });
}

export function dismissLostJob(id: string): void {
  appStore.set({ lostJobs: appStore.value.lostJobs.filter((job) => job.id !== id) });
}
