import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { LightElement } from "../components/base";
import { icon } from "../components/icons";
import { api, errorMessage } from "../lib/api";
import { formatBytes, formatNumber, formatPercent, relativeTime } from "../lib/format";
import { measureCell, measureValue } from "../lib/measure";
import { indexValues, SeriesController, times } from "../lib/series";
import type { ByteMeasurement, SummaryIndex } from "../lib/types";

interface IndexStats {
  document_count?: number;
  lucene_document_count?: number;
  deleted_lucene_document_count?: number;
  index_size_bytes?: number;
  directory_size_bytes?: ByteMeasurement;
  average_index_bytes_per_document?: number;
  memory?: Record<string, ByteMeasurement>;
  sampled_at_unix_millis?: number;
  age_millis?: number;
}

interface Bucket {
  component: string;
  bytes: number | ByteMeasurement;
  reason?: string;
  owners?: string[];
  owner_count?: number;
  unattributed?: boolean;
}

interface FieldPage {
  fields?: Array<{ path: string; attributed_disk_bytes?: ByteMeasurement }>;
  storage_buckets?: Bucket[];
  memory_buckets?: Bucket[];
  shared_disk_bytes?: number;
  unattributed_disk_bytes?: number;
  total_attributed_disk_bytes?: number;
}

const MEMORY_LABELS: Record<string, string> = {
  accounted_reader_heap_bytes: "Reader heap",
  accounted_cache_heap_bytes: "Cache heap",
  accounted_writer_buffer_heap_bytes: "Writer buffers",
  desired_vector_off_heap_bytes: "Vector working set (off-heap)",
};

function bucketBytes(bucket: Bucket): number {
  return typeof bucket.bytes === "number" ? bucket.bytes : (measureValue(bucket.bytes) ?? 0);
}

function humanize(component: string): string {
  return component.replace(/_/g, " ");
}

export class MongIndexStorage extends LightElement {
  static properties = {
    index: { attribute: false },
    stats: { state: true },
    page: { state: true },
    loading: { state: true },
    error: { state: true },
    loadedAt: { state: true },
  };
  declare index: SummaryIndex;
  declare stats: IndexStats | null;
  declare page: FieldPage | null;
  declare loading: boolean;
  declare error: string | null;
  declare loadedAt: number | null;

  private readonly series = new SeriesController(this, () => this.index?.index_id, 15000);
  private loadedFor = "";

  constructor() {
    super();
    this.stats = null;
    this.page = null;
    this.loading = false;
    this.error = null;
    this.loadedAt = null;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("index") && this.index && this.index.index_id !== this.loadedFor) {
      this.loadedFor = this.index.index_id;
      this.stats = null;
      this.page = null;
      void this.load(false);
    }
  }

  private async load(refresh: boolean): Promise<void> {
    const id = this.index.index_id;
    this.loading = true;
    this.error = null;
    try {
      const [stats, page] = await Promise.all([
        api.stats(id, refresh) as Promise<IndexStats>,
        api.fieldStats(id, { refresh, page_size: 500 }) as Promise<FieldPage>,
      ]);
      if (id !== this.index.index_id) return;
      this.stats = stats;
      this.page = page;
      this.loadedAt = stats.sampled_at_unix_millis ? stats.sampled_at_unix_millis / 1000 : Date.now() / 1000;
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.loading = false;
    }
  }

  private bars(items: Array<{ label: string; value: number; title?: string; extra?: TemplateResult | string }>): TemplateResult {
    const max = Math.max(1, ...items.map((item) => item.value));
    return html`<div class="stack" style="gap:6px">
      ${items.map(
        (item) => html`<div class="storage-bar-row" title=${item.title ?? ""}>
          <span class="ellipsis small">${item.label}</span>
          <span class="bar-track" style="width:100%"><span class="bar" style="width:${Math.max(0.5, (item.value / max) * 100)}%"></span></span>
          <span class="num small">${formatBytes(item.value)}${item.extra ?? ""}</span>
        </div>`,
      )}
    </div>`;
  }

  render() {
    const stats = this.stats;
    const page = this.page;
    const samples = this.series.window(3600);
    const t = times(samples);
    const id = this.index.index_id;
    const buckets = [...(page?.storage_buckets ?? [])]
      .map((bucket) => ({ ...bucket, value: bucketBytes(bucket) }))
      .sort((a, b) => b.value - a.value);
    const merged = new Map<string, { value: number; reason?: string; owners: number }>();
    for (const bucket of buckets) {
      const current = merged.get(bucket.component) ?? { value: 0, reason: bucket.reason, owners: 0 };
      current.value += bucket.value;
      current.owners = Math.max(current.owners, bucket.owner_count ?? 0);
      merged.set(bucket.component, current);
    }
    const topFields = [...(page?.fields ?? [])]
      .map((field) => ({ path: field.path, m: field.attributed_disk_bytes, value: measureValue(field.attributed_disk_bytes) ?? 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);
    return html`
      <div class="row between">
        <div class="hint">
          ${this.loadedAt
            ? html`Snapshot taken ${relativeTime(this.loadedAt)}. Statistics are collected on demand and never polled.
                <span title="* marks a lower bound (partial measurement); — means mongot cannot report it">* = partial, — = unavailable</span>`
            : "Collecting statistics…"}
        </div>
        <button class="btn secondary sm" ?disabled=${this.loading} @click=${() => this.load(true)}>
          ${icon("refresh", 14)} ${this.loading ? "Collecting…" : "Take a new snapshot"}
        </button>
      </div>
      ${this.error ? html`<div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div>` : nothing}

      <div class="grid kpis">
        <div class="kpi"><div class="kpi__label">Documents</div><div class="kpi__value">${formatNumber(stats?.document_count)}</div>
          <div class="kpi__foot"><span>${formatNumber(stats?.lucene_document_count)} Lucene docs</span></div></div>
        <div class="kpi"><div class="kpi__label">Deleted Lucene docs</div><div class="kpi__value">${formatNumber(stats?.deleted_lucene_document_count)}</div>
          <div class="kpi__foot"><span>${stats?.lucene_document_count ? formatPercent((stats.deleted_lucene_document_count ?? 0) / (stats.lucene_document_count + (stats.deleted_lucene_document_count ?? 0)), 1) : "—"} of all</span></div></div>
        <div class="kpi"><div class="kpi__label">Directory size</div><div class="kpi__value">${measureCell(stats?.directory_size_bytes)}</div>
          <div class="kpi__foot"><span>index ${formatBytes(stats?.index_size_bytes)}</span></div></div>
        <div class="kpi"><div class="kpi__label">Bytes per document</div><div class="kpi__value">${formatBytes(stats?.average_index_bytes_per_document)}</div>
          <div class="kpi__foot"><span>average</span></div></div>
        ${Object.entries(MEMORY_LABELS).map(
          ([key, label]) => html`<div class="kpi"><div class="kpi__label">${label}</div><div class="kpi__value">${measureCell(stats?.memory?.[key])}</div><div class="kpi__foot"></div></div>`,
        )}
      </div>

      <div class="grid cols-2">
        <section class="card chart-card">
          <div class="card__head"><div><h3>Size on disk</h3><div class="hint">From the metrics sampler, last hour</div></div></div>
          <div class="card__body">
            <mong-chart .times=${t} .format=${(v: number | null) => formatBytes(v)} .series=${[{ label: "Size", values: indexValues(samples, id, "size_bytes") }]}></mong-chart>
          </div>
        </section>
        <section class="card chart-card">
          <div class="card__head"><div><h3>Documents and segments</h3><div class="hint">Live documents; segments drop as merges run</div></div></div>
          <div class="card__body">
            <mong-chart .times=${t} .format=${(v: number | null) => formatNumber(v)} .series=${[
              { label: "Documents", values: indexValues(samples, id, "documents") },
              { label: "Incl. deleted", values: indexValues(samples, id, "max_documents") },
            ]}></mong-chart>
          </div>
        </section>
      </div>

      <div class="grid cols-2">
        <section class="card">
          <div class="card__head">
            <div>
              <h3>Disk by component</h3>
              <div class="hint">
                ${page
                  ? html`${formatBytes(page.total_attributed_disk_bytes)} attributed to fields · ${formatBytes(page.shared_disk_bytes)} shared · ${formatBytes(page.unattributed_disk_bytes)} unattributed`
                  : "Loading…"}
              </div>
            </div>
          </div>
          <div class="card__body">
            ${merged.size
              ? this.bars(
                  [...merged.entries()].map(([component, info]) => ({
                    label: humanize(component),
                    value: info.value,
                    title: `${info.reason ?? ""}${info.owners ? ` · shared by ${info.owners} fields` : ""}`,
                  })),
                )
              : html`<div class="hint">${this.loading ? "Loading…" : "No breakdown reported."}</div>`}
          </div>
        </section>
        <section class="card">
          <div class="card__head">
            <div><h3>Largest fields</h3><div class="hint">Disk used only by each field (shared storage excluded); the Fields tab lists all</div></div>
          </div>
          <div class="card__body">
            ${topFields.length
              ? this.bars(topFields.map((field) => ({ label: field.path, value: field.value, extra: field.m?.completeness === "PARTIAL" ? "*" : "" })))
              : html`<div class="hint">${this.loading ? "Loading…" : "No per-field sizes reported."}</div>`}
          </div>
        </section>
      </div>
    `;
  }
}

customElements.define("mong-index-storage", MongIndexStorage);
