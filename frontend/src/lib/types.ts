export type IndexType = "SEARCH" | "VECTOR_SEARCH";

export interface IndexStatsSnapshot {
  documents: number | null;
  size_bytes: number | null;
  files: number | null;
  segments: number | null;
  queries: number | null;
}

export interface IndexInfo {
  index_id: string;
  name: string;
  type: IndexType;
  type_code: number;
  desired_revision: number;
  active_revision: number;
  lifecycle_state: string;
  generation_id: string | null;
  failure_message: string | null;
  definition: Record<string, unknown> | null;
  stats?: IndexStatsSnapshot;
}

export interface IndexMetrics {
  status_label: string | null;
  qps: number | null;
  failed_qps: number | null;
  insert_rate: number | null;
  update_rate: number | null;
  delete_rate: number | null;
  ingest_rate: number | null;
  batch_latency_mean_ms: number | null;
  batch_latency_max_ms: number | null;
  batch_latency_p50_ms: number | null;
  batch_latency_p90_ms: number | null;
  batch_latency_p99_ms: number | null;
  lag_ms: number | null;
  documents: number | null;
  max_documents: number | null;
  deleted_ratio: number | null;
  segments: number | null;
  size_bytes: number | null;
  memory_bytes: number | null;
  initial_sync_exceptions: number | null;
  steady_state_exceptions: number | null;
  failed_queries_total: number | null;
}

export interface SummaryIndex extends IndexInfo {
  metrics: IndexMetrics;
}

export interface InstanceMetrics {
  management_ready: boolean;
  failure_message: string | null;
  free_disk_bytes: number | null;
  qps: number | null;
  failed_qps: number | null;
  ingest_rate: number | null;
  search_latency_mean_ms: number | null;
  rpc_inflight: number | null;
  rpc_queued: number | null;
  merges: number | null;
  cursors: number | null;
  documents: number | null;
  size_bytes: number | null;
  metrics_count: number;
}

export interface RpcStat {
  operation: string;
  rate: number | null;
  error_rate: number | null;
  mean_ms: number | null;
  total: number;
  errors: number;
}

export type Severity = "info" | "warning" | "error";

export interface Alert {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  index_id?: string | null;
  index_name?: string | null;
}

export interface MetricsSummary {
  connected: boolean;
  error: string | null;
  sampled_at: number | null;
  interval: number;
  started_at: number | null;
  instance: InstanceMetrics | null;
  indexes: SummaryIndex[];
  rpc: RpcStat[];
  alerts: Alert[];
}

export interface SeriesSample {
  t: number;
  instance: Partial<Record<keyof InstanceMetrics, number | null>>;
  indexes: Record<string, Partial<Record<keyof IndexMetrics, number | null>>>;
  rpc: Record<string, { rate: number | null; error_rate: number | null; mean_ms: number | null }>;
}

export interface Annotation {
  t: number;
  kind: "created" | "dropped" | "rebuilt" | "restart";
  index_id: string | null;
  label: string;
}

export interface MetricsSeries {
  interval: number;
  samples: SeriesSample[];
  annotations: Annotation[];
  now: number;
}

export interface QueryPage {
  index_id: string;
  page: number;
  page_size: number;
  count: number;
  results: Record<string, unknown>[];
  metadata: Record<string, unknown> | null;
  explain: Record<string, unknown> | null;
  explain_verbosity: string | null;
  generation_id: string;
  cursor_id: string | null;
  has_more: boolean;
  latency_ms?: number;
  truncated?: boolean;
}

export interface WriteResult {
  index_id: string;
  generation_id: string;
  indexed_count?: number;
  processed_count?: number;
}

export interface DeleteByQueryResult {
  index_id: string;
  generation_id: string;
  active_revision: number;
  matched_count: number;
  processed_count: number;
  dry_run: boolean;
}

export interface ByteMeasurement {
  value: number | null;
  method: string;
  completeness: string;
  omitted_components?: string[];
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: "clear_index" | "delete_by_query" | "export";
  index_id: string;
  index_name: string;
  state: JobState;
  done: number;
  total: number | null;
  unit: string;
  message: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: Record<string, unknown> | null;
  downloadable: boolean;
}

export type WriteConcern = "visible" | "indexed" | "committed";
