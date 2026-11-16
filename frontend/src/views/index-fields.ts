import { html, nothing, type PropertyValues } from "lit";
import { LightElement } from "../components/base";
import type { Column } from "../components/data-table";
import { icon } from "../components/icons";
import { FieldIndex, loadMappings } from "../editors/fields.js";
import { api, errorMessage } from "../lib/api";
import { formatPercent, relativeTime } from "../lib/format";
import { measureCell, measureValue } from "../lib/measure";
import { href } from "../lib/router";
import type { ByteMeasurement, IndexInfo } from "../lib/types";

interface FieldStat {
  path: string;
  configured: boolean;
  observed: boolean;
  attributed_disk_bytes?: ByteMeasurement;
  accounted_reader_heap_bytes?: ByteMeasurement;
  desired_vector_off_heap_bytes?: ByteMeasurement;
  representations?: Array<{ mapping_type: string; multi: string; physical_name: string }>;
}

interface FieldStatsResponse {
  fields: FieldStat[];
  next_page_token?: string;
  refresh_in_progress?: boolean;
  retry_after_millis?: number;
  state?: string;
  attribution_coverage?: number;
  index_stats?: { sampled_at_unix_millis?: number };
}

interface Row {
  path: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  types: string[];
  origin: "configured" | "observed" | "group";
  analyzer: string;
  multis: string[];
  dims: number | null;
  stat?: FieldStat;
}

const MAX_PAGES = 20;

/** Definition specs by dotted path, for analyzers and multi names. */
function specsByPath(definition: Record<string, any> | null | undefined): Map<string, Record<string, any>[]> {
  const out = new Map<string, Record<string, any>[]>();
  const walk = (fields: Record<string, any> | undefined, prefix: string) => {
    for (const [name, raw] of Object.entries(fields ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      const specs = (Array.isArray(raw) ? raw : [raw]).filter((s) => s && typeof s === "object");
      out.set(path, specs);
      for (const spec of specs) if (spec.fields) walk(spec.fields, path);
    }
  };
  walk(definition?.mappings?.fields, "");
  return out;
}

export class MongIndexFields extends LightElement {
  static properties = {
    index: { attribute: false },
    filter: { state: true },
    collapsed: { state: true },
    rows: { state: true },
    loading: { state: true },
    error: { state: true },
    stats: { state: true },
    statsLoading: { state: true },
    statsError: { state: true },
    statsMeta: { state: true },
  };
  declare index: IndexInfo;
  declare filter: string;
  declare collapsed: Set<string>;
  declare rows: Row[];
  declare loading: boolean;
  declare error: string | null;
  declare stats: Map<string, FieldStat> | null;
  declare statsLoading: boolean;
  declare statsError: string | null;
  declare statsMeta: { sampledAt: number | null; coverage: number | null; truncated: boolean } | null;

  private loadedKey = "";
  private statsRun = 0;

  constructor() {
    super();
    this.filter = "";
    this.collapsed = new Set();
    this.rows = [];
    this.loading = false;
    this.error = null;
    this.stats = null;
    this.statsLoading = false;
    this.statsError = null;
    this.statsMeta = null;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("index") && this.index) {
      const key = `${this.index.index_id}:${this.index.desired_revision}:${this.index.generation_id}`;
      if (key !== this.loadedKey) {
        this.loadedKey = key;
        this.stats = null;
        this.statsMeta = null;
        void this.loadFields();
      }
    }
  }

  private async loadFields(): Promise<void> {
    const index = this.index;
    this.loading = true;
    this.error = null;
    try {
      const compiled = FieldIndex.compile(index.definition, index.type);
      if (index.type !== "VECTOR_SEARCH") {
        const observed = await loadMappings(index);
        if (observed) compiled.applyObserved(observed);
      }
      if (index.index_id !== this.index.index_id) return;
      const specs = specsByPath(index.definition as Record<string, any>);
      const rootAnalyzer = String((index.definition as Record<string, any> | null)?.analyzer ?? "lucene.standard");
      const fields = compiled.suggest(null) as Array<{
        path: string;
        rawTypes: Set<string>;
        origin: string;
        numDimensions: number | null;
        multis: string[];
      }>;
      const byPath = new Map<string, Row>();
      for (const field of fields) {
        const spec = specs.get(field.path) ?? [];
        const types = [...field.rawTypes];
        const textual = types.some((type) => type === "string" || type === "autocomplete");
        const analyzer =
          spec.map((s) => s.analyzer).find(Boolean) ?? (textual ? rootAnalyzer : "");
        byPath.set(field.path, {
          path: field.path,
          name: field.path.split(".").pop() ?? field.path,
          depth: field.path.split(".").length - 1,
          hasChildren: false,
          types,
          origin: field.origin === "mapped" ? "configured" : "observed",
          analyzer: String(analyzer),
          multis: field.multis ?? [],
          dims: field.numDimensions,
        });
      }
      for (const path of [...byPath.keys()]) {
        const parts = path.split(".");
        for (let i = 1; i < parts.length; i += 1) {
          const parent = parts.slice(0, i).join(".");
          const existing = byPath.get(parent);
          if (existing) existing.hasChildren = true;
          else {
            byPath.set(parent, {
              path: parent,
              name: parts[i - 1],
              depth: i - 1,
              hasChildren: true,
              types: [],
              origin: "group",
              analyzer: "",
              multis: [],
              dims: null,
            });
          }
        }
      }
      this.rows = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.loading = false;
    }
  }

  private async loadStats(refresh = false): Promise<void> {
    const run = ++this.statsRun;
    const index = this.index;
    this.statsLoading = true;
    this.statsError = null;
    const stats = new Map<string, FieldStat>();
    let token = "";
    let pages = 0;
    let meta: FieldStatsResponse | null = null;
    try {
      for (let attempt = 0; pages < MAX_PAGES; ) {
        const body = (await api.fieldStats(index.index_id, {
          refresh: refresh && pages === 0,
          page_size: 200,
          page_token: token,
        })) as FieldStatsResponse;
        if (run !== this.statsRun) return;
        if (body.refresh_in_progress && !body.fields?.length && attempt < 15) {
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(500, body.retry_after_millis ?? 1000))));
          continue;
        }
        meta = meta ?? body;
        for (const field of body.fields ?? []) stats.set(field.path, field);
        pages += 1;
        token = body.next_page_token ?? "";
        if (!token) break;
      }
      this.stats = stats;
      this.statsMeta = {
        sampledAt: meta?.index_stats?.sampled_at_unix_millis ? meta.index_stats.sampled_at_unix_millis / 1000 : Date.now() / 1000,
        coverage: meta?.attribution_coverage ?? null,
        truncated: Boolean(token),
      };
    } catch (error) {
      if (run === this.statsRun) this.statsError = errorMessage(error);
    } finally {
      if (run === this.statsRun) this.statsLoading = false;
    }
  }

  private toggle(path: string): void {
    const next = new Set(this.collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.collapsed = next;
  }

  private visibleRows(): Row[] {
    const needle = this.filter.trim().toLowerCase();
    const statsOnly = this.stats ? [...this.stats.keys()].filter((path) => !this.rows.some((row) => row.path === path)) : [];
    const extra: Row[] = statsOnly.map((path) => ({
      path,
      name: path.split(".").pop() ?? path,
      depth: path.split(".").length - 1,
      hasChildren: false,
      types: [...new Set((this.stats!.get(path)!.representations ?? []).map((r) => r.mapping_type))],
      origin: this.stats!.get(path)!.configured ? "configured" : "observed",
      analyzer: "",
      multis: [],
      dims: null,
    }));
    const all = [...this.rows, ...extra].sort((a, b) => a.path.localeCompare(b.path));
    if (needle) {
      return all.filter((row) => row.origin !== "group" && row.path.toLowerCase().includes(needle)).map((row) => ({ ...row, depth: 0, name: row.path }));
    }
    return all.filter((row) => {
      const parts = row.path.split(".");
      for (let i = 1; i < parts.length; i += 1) if (this.collapsed.has(parts.slice(0, i).join("."))) return false;
      return true;
    });
  }

  private columns(maxDisk: number): Column<Row>[] {
    const stat = (row: Row) => this.stats?.get(row.path);
    const sizeCell = (m: ByteMeasurement | undefined, max: number) => {
      const value = measureValue(m);
      return html`<span class="row" style="justify-content:flex-end;flex-wrap:nowrap">
        ${max > 0 && value != null
          ? html`<span class="bar-track" style="width:80px"><span class="bar" style="width:${Math.max(1, (value / max) * 100)}%"></span></span>`
          : nothing}
        <span style="min-width:72px">${m ? measureCell(m) : html`<span class="muted">—</span>`}</span>
      </span>`;
    };
    const cols: Column<Row>[] = [
      {
        key: "path",
        label: "Field",
        sortable: false,
        render: (row) => html`<span class="row" style="flex-wrap:nowrap;padding-left:${row.depth * 16}px">
          ${row.hasChildren && !this.filter
            ? html`<button class="jt-toggle" style="margin-left:0" aria-label="Toggle ${row.path}" @click=${(e: Event) => {
                e.stopPropagation();
                this.toggle(row.path);
              }}>${this.collapsed.has(row.path) ? "▸" : "▾"}</button>`
            : html`<span style="width:14px"></span>`}
          <span class="mono ${row.origin === "group" ? "muted" : ""}">${row.name}</span>
          ${row.multis.length ? html`<span class="badge" title="Multi analyzers: ${row.multis.join(", ")}">+${row.multis.length} multi</span>` : nothing}
        </span>`,
      },
      {
        key: "types",
        label: "Type",
        sortable: false,
        render: (row) => html`${row.types.map((type) => html`<span class="badge" style="margin-right:4px">${type}</span>`)}${row.dims ? html`<span class="muted small">${row.dims} dims</span>` : nothing}`,
      },
      {
        key: "origin",
        label: "Source",
        sortable: false,
        render: (row) =>
          row.origin === "configured"
            ? html`<span title="Listed in the index definition">definition</span>`
            : row.origin === "observed"
              ? html`<span class="muted" title="Indexed dynamically because documents contained it">observed</span>`
              : nothing,
      },
      { key: "analyzer", label: "Analyzer", sortable: false, render: (row) => html`<span class="mono small">${row.analyzer}</span>` },
    ];
    if (this.stats) {
      cols.push(
        { key: "disk", label: "Disk", align: "right", sortable: false, render: (row) => (row.origin === "group" ? nothing : sizeCell(stat(row)?.attributed_disk_bytes, maxDisk)) },
        { key: "heap", label: "Heap", align: "right", sortable: false, render: (row) => (row.origin === "group" ? nothing : measureCell(stat(row)?.accounted_reader_heap_bytes)) },
      );
      if (this.index.type === "VECTOR_SEARCH") {
        cols.push({ key: "vector", label: "Vector memory", align: "right", sortable: false, render: (row) => (row.origin === "group" ? nothing : measureCell(stat(row)?.desired_vector_off_heap_bytes)) });
      }
    }
    cols.push({
      key: "query",
      label: "",
      sortable: false,
      align: "right",
      render: (row) =>
        row.origin === "group"
          ? nothing
          : html`<a class="btn ghost sm" href=${href("explore", { index: this.index.name, field: row.path })} title="Start a query on this field">${icon("explore", 12)} Query</a>`,
    });
    return cols;
  }

  render() {
    const rows = this.visibleRows();
    const maxDisk = this.stats
      ? Math.max(0, ...[...this.stats.values()].map((s) => measureValue(s.attributed_disk_bytes) ?? 0))
      : 0;
    const fieldCount = this.rows.filter((row) => row.origin !== "group").length;
    return html`<section class="card">
      <div class="card__head">
        <div>
          <h2>Fields <span class="badge">${fieldCount}</span></h2>
          <div class="hint">
            The definition merged with what mongot has actually indexed.
            ${this.statsMeta
              ? html`Sizes from a snapshot taken ${relativeTime(this.statsMeta.sampledAt)}${this.statsMeta.coverage != null ? html`, covering ${formatPercent(this.statsMeta.coverage, 0)} of disk` : nothing}.
                  <span title="* marks a lower bound: some storage is shared between fields. — means mongot cannot attribute it.">* = partial</span>`
              : nothing}
          </div>
        </div>
        <div class="row">
          <label class="input-search" style="width:220px">
            ${icon("search", 14)}
            <input type="search" placeholder="Filter fields" aria-label="Filter fields" .value=${this.filter} @input=${(e: InputEvent) => (this.filter = (e.target as HTMLInputElement).value)} />
          </label>
          <button class="btn secondary sm" ?disabled=${this.statsLoading} @click=${() => this.loadStats(Boolean(this.stats))} title="Field statistics are collected on demand, not polled">
            ${icon("database", 14)} ${this.statsLoading ? "Collecting…" : this.stats ? "Refresh sizes" : "Load sizes"}
          </button>
        </div>
      </div>
      ${this.statsError ? html`<div class="alert" data-tone="danger" style="margin:12px">${icon("alert", 16)}<div class="alert__body">${this.statsError}</div></div>` : nothing}
      ${this.statsMeta?.truncated ? html`<div class="hint" style="padding:8px 16px">Showing sizes for the first ${MAX_PAGES * 200} fields.</div>` : nothing}
      <div class="card__body flush">
        ${this.error
          ? html`<div class="alert" data-tone="danger" style="margin:12px">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div>`
          : this.loading && !this.rows.length
            ? html`<div class="card__body"><span class="skeleton block"></span></div>`
            : html`<mong-data-table
                .rows=${rows}
                .columns=${this.columns(maxDisk)}
                .rowKey=${(row: Row) => row.path}
                .maxHeight=${620}
                empty-text=${this.filter ? "No fields match" : "No fields yet. Fields appear after documents are indexed."}
              ></mong-data-table>`}
      </div>
    </section>`;
  }
}

customElements.define("mong-index-fields", MongIndexFields);
