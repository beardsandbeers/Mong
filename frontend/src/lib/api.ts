import type {
  DeleteByQueryResult,
  IndexInfo,
  IndexType,
  Job,
  MetricsSeries,
  MetricsSummary,
  QueryPage,
  UpdateMode,
  WriteConcern,
  WriteResult,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly raw: string;

  constructor(message: string, status: number, code: string, raw: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.raw = raw;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

const FRIENDLY: Record<string, string> = {
  UNAVAILABLE: "mongot is unreachable. Is the nomongo-t container running on port 27029?",
  CREDENTIALS_MISSING:
    "TLS credentials are missing. Copy server.crt and admin.token from the container into .nomongo-t/.",
  DEADLINE_EXCEEDED: "mongot did not answer in time.",
  FORBIDDEN: "The Mong server refused the request (host or origin not allowed).",
  UNAUTHENTICATED: "mongot rejected the admin token. Re-copy admin.token from the container.",
};

/** Human-readable message for an API failure. */
export function friendlyMessage(status: number, code: string, raw: string): string {
  if (FRIENDLY[code]) return FRIENDLY[code];
  if (status === 404 && !raw) return "Not found.";
  return raw || `Request failed (${status})`;
}

type Params = Record<string, string | number | boolean | string[] | undefined | null>;

function withQuery(path: string, params?: Params): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ApiError("The Mong server is not responding. Is `python -m mong` running?", 0, "NETWORK", "");
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const raw = (payload as { error?: string } | null)?.error ?? text.slice(0, 300);
    const code = (payload as { code?: string } | null)?.code ?? "HTTP_" + response.status;
    throw new ApiError(friendlyMessage(response.status, code, raw), response.status, code, raw);
  }
  return payload as T;
}

const id = (value: string) => encodeURIComponent(value);

export interface SearchRequest {
  query: Record<string, unknown>;
  vector?: boolean;
  batch_size?: number;
  explain?: string;
}

export interface DeleteByQueryRequest {
  query?: Record<string, unknown> | null;
  vector?: boolean;
  match_all?: boolean;
  dry_run?: boolean;
  max_matches?: number;
  concern?: WriteConcern;
}

export interface FieldStatsRequest {
  refresh?: boolean;
  page_size?: number;
  page_token?: string;
  path?: string[];
}

export interface JobRequest {
  kind: Job["kind"];
  index_id: string;
  [key: string]: unknown;
}

export const api = {
  status: (metrics = false) => request<Record<string, unknown>>("GET", withQuery("/api/status", { metrics })),
  indexes: () => request<{ indexes: IndexInfo[] }>("GET", "/api/indexes").then((body) => body.indexes),
  index: (indexId: string) => request<IndexInfo>("GET", `/api/indexes/${id(indexId)}`),
  createIndex: (name: string, type: IndexType, definition: unknown) =>
    request<IndexInfo>("POST", "/api/indexes", { name, type, definition }),
  updateIndex: (indexId: string, definition: unknown, expectedRevision: number, updateMode: UpdateMode = "auto") =>
    request<IndexInfo>("PUT", `/api/indexes/${id(indexId)}`, {
      definition,
      expected_revision: expectedRevision,
      update_mode: updateMode,
    }),
  dropIndex: (indexId: string, expectedRevision: number) =>
    request<IndexInfo>("DELETE", `/api/indexes/${id(indexId)}`, { expected_revision: expectedRevision }),
  mappings: (indexId: string, generationId = "") =>
    request<{ mappings: Record<string, unknown>; definition: Record<string, unknown>; generation_id: string | null }>(
      "GET",
      withQuery(`/api/indexes/${id(indexId)}/mappings`, { generation_id: generationId }),
    ),
  stats: (indexId: string, refresh = false) =>
    request<Record<string, any>>("GET", withQuery(`/api/indexes/${id(indexId)}/stats`, { refresh })),
  fieldStats: (indexId: string, params: FieldStatsRequest = {}) =>
    request<Record<string, any>>(
      "GET",
      withQuery(`/api/indexes/${id(indexId)}/field-stats`, params as Params),
    ),
  upsert: (indexId: string, documents: unknown[], concern: WriteConcern = "visible", signal?: AbortSignal) =>
    request<WriteResult>("POST", `/api/indexes/${id(indexId)}/documents`, { documents, concern }, { signal }),
  deleteDocument: (indexId: string, docId: unknown, concern: WriteConcern = "visible") =>
    request<WriteResult>("DELETE", `/api/indexes/${id(indexId)}/documents/${id(docIdText(docId))}`, {
      id: docId,
      concern,
    }),
  deleteDocuments: (indexId: string, ids: unknown[], concern: WriteConcern = "visible") =>
    request<WriteResult>("POST", `/api/indexes/${id(indexId)}/documents/delete`, { ids, concern }),
  deleteByQuery: (indexId: string, body: DeleteByQueryRequest) =>
    request<DeleteByQueryResult>("POST", `/api/indexes/${id(indexId)}/delete-by-query`, body),
  search: (indexId: string, body: SearchRequest, signal?: AbortSignal) =>
    request<QueryPage>("POST", `/api/indexes/${id(indexId)}/search`, body, { signal }),
  searchMeta: (indexId: string, body: SearchRequest, signal?: AbortSignal) =>
    request<QueryPage>("POST", `/api/indexes/${id(indexId)}/search-meta`, body, { signal }),
  browse: (indexId: string, body: { batch_size: number; count?: boolean }, signal?: AbortSignal) =>
    request<QueryPage>("POST", `/api/indexes/${id(indexId)}/browse`, body, { signal }),
  more: (cursorId: string, indexId: string, batchSize: number, page: number, signal?: AbortSignal) =>
    request<QueryPage>(
      "POST",
      "/api/query/more",
      { cursor_id: cursorId, index_id: indexId, batch_size: batchSize, page },
      { signal },
    ),
  killCursor: (cursorId: string) => request<unknown>("DELETE", `/api/query/cursors/${id(cursorId)}`),
  metricsSummary: (refresh = false) =>
    request<MetricsSummary>("GET", withQuery("/api/metrics/summary", { refresh })),
  metricsSeries: (params: { index?: string; since?: number } = {}) =>
    request<MetricsSeries>("GET", withQuery("/api/metrics/series", params as Params)),
  jobs: () => request<{ jobs: Job[] }>("GET", "/api/jobs").then((body) => body.jobs),
  job: (jobId: string) => request<Job>("GET", `/api/jobs/${id(jobId)}`),
  createJob: (body: JobRequest) => request<Job>("POST", "/api/jobs", body),
  cancelJob: (jobId: string) => request<Job>("POST", `/api/jobs/${id(jobId)}/cancel`, {}),
  jobDownloadUrl: (jobId: string) => `/api/jobs/${id(jobId)}/download`,
};

function docIdText(value: unknown): string {
  if (value && typeof value === "object") {
    const wrapped = value as Record<string, unknown>;
    if (typeof wrapped.$oid === "string") return wrapped.$oid;
    return JSON.stringify(value);
  }
  return String(value);
}

/** Error text for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
