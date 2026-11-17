import { html, nothing } from "lit";
import { LightElement } from "../components/base";
import type { Column } from "../components/data-table";
import { originBadge } from "../components/index-origin";
import { icon } from "../components/icons";
import { indexStatus, statusPill } from "../components/status-pill";
import { dropIndexFlow } from "../lib/actions";
import { capabilities } from "../lib/capabilities";
import { indexLabel, isCoupled } from "../lib/origin";
import { formatBytes, formatMs, formatNumber, formatRate } from "../lib/format";
import { href, navigate } from "../lib/router";
import { appStore } from "../lib/state";
import { load, save } from "../lib/storage";
import { StoreController } from "../lib/store";
import type { SummaryIndex } from "../lib/types";

type TypeFilter = "all" | "SEARCH" | "VECTOR_SEARCH";
type StatusFilter = "all" | "ok" | "attention";
type SourceFilter = "all" | "mongot" | "mongod";

const managed = (index: SummaryIndex) => isCoupled(index);

export class MongIndexes extends LightElement {
  static properties = {
    query: { state: true },
    typeFilter: { state: true },
    statusFilter: { state: true },
    sourceFilter: { state: true },
  };
  declare query: string;
  declare typeFilter: TypeFilter;
  declare statusFilter: StatusFilter;
  declare sourceFilter: SourceFilter;

  private readonly app = new StoreController(this, appStore);

  constructor() {
    super();
    this.query = "";
    this.typeFilter = load<TypeFilter>("indexes.type", "all");
    this.statusFilter = load<StatusFilter>("indexes.status", "all");
    this.sourceFilter = load<SourceFilter>("indexes.source", "all");
  }

  private setType(value: TypeFilter): void {
    this.typeFilter = value;
    save("indexes.type", value);
  }

  private setSource(value: SourceFilter): void {
    this.sourceFilter = value;
    save("indexes.source", value);
  }

  private setStatus(value: StatusFilter): void {
    this.statusFilter = value;
    save("indexes.status", value);
  }

  private filtered(): SummaryIndex[] {
    const needle = this.query.trim().toLowerCase();
    return this.app.value.indexes.filter((index) => {
      if (needle && !index.name.toLowerCase().includes(needle) && !index.index_id.toLowerCase().includes(needle)) {
        return false;
      }
      if (this.typeFilter !== "all" && index.type !== this.typeFilter) return false;
      if (this.sourceFilter === "mongod" && !managed(index)) return false;
      if (this.sourceFilter === "mongot" && managed(index)) return false;
      if (this.statusFilter !== "all") {
        const ok = indexStatus(index).tone === "ok";
        if (this.statusFilter === "ok" ? !ok : ok) return false;
      }
      return true;
    });
  }

  private columns(): Column<SummaryIndex>[] {
    const m = (row: SummaryIndex) => row.metrics ?? ({} as SummaryIndex["metrics"]);
    return [
      {
        key: "name",
        label: "Name",
        pinned: true,
        render: (row) => html`<a href=${href(["indexes", row.name])} @click=${(e: Event) => e.stopPropagation()}>${indexLabel(row)}</a>
          ${originBadge(row)}
          ${this.app.value.recreated.includes(row.name)
            ? html`<span class="badge" title="Dropped and recreated during this session; saved queries and history may refer to the old index">recreated</span>`
            : nothing}`,
      },
      {
        key: "type",
        label: "Type",
        render: (row) => html`<span class="badge">${row.type === "VECTOR_SEARCH" ? "vector" : "search"}</span>`,
      },
      {
        key: "source",
        label: "Source",
        render: (row) => originBadge(row),
        sortValue: (row) => (isCoupled(row) ? "coupled" : "standalone"),
      },
      { key: "status", label: "Status", render: (row) => statusPill(row), sortValue: (row) => indexStatus(row).label },
      {
        key: "documents",
        label: "Documents",
        align: "right",
        render: (row) => formatNumber(m(row).documents),
        sortValue: (row) => m(row).documents,
      },
      {
        key: "size",
        label: "Size",
        align: "right",
        render: (row) => formatBytes(m(row).size_bytes),
        sortValue: (row) => m(row).size_bytes,
      },
      {
        key: "segments",
        label: "Segments",
        align: "right",
        render: (row) => formatNumber(m(row).segments),
        sortValue: (row) => m(row).segments,
      },
      {
        key: "qps",
        label: "Queries/s",
        align: "right",
        render: (row) => formatRate(m(row).qps, ""),
        sortValue: (row) => m(row).qps,
      },
      {
        key: "latency",
        label: "Batch latency",
        align: "right",
        render: (row) => formatMs(m(row).batch_latency_mean_ms),
        sortValue: (row) => m(row).batch_latency_mean_ms,
      },
      {
        key: "stored",
        label: "Stored source",
        render: (row) => {
          const caps = capabilities(row);
          if (caps.isVector) return html`<span class="muted">—</span>`;
          return caps.storedSource === "full"
            ? html`<span class="pill" data-tone="ok">full</span>`
            : caps.storedSource === "partial"
              ? html`<span class="pill" data-tone="info">partial</span>`
              : html`<span class="pill">none</span>`;
        },
        sortValue: (row) => capabilities(row).storedSource,
      },
      {
        key: "revision",
        label: "Revision",
        align: "right",
        render: (row) =>
          row.desired_revision === row.active_revision
            ? String(row.active_revision)
            : html`<span title="Revision ${row.desired_revision} is building">${row.active_revision} → ${row.desired_revision}</span>`,
        sortValue: (row) => row.active_revision,
      },
      {
        key: "actions",
        label: "",
        sortable: false,
        align: "right",
        render: (row) => html`<span class="row" style="justify-content:flex-end;flex-wrap:nowrap" @click=${(e: Event) => e.stopPropagation()}>
          <a class="btn ghost sm" href=${href("explore", { index: row.name })} title="Query this index">${icon("explore", 14)} Query</a>
          ${capabilities(row).readOnly
            ? nothing
            : html`<a class="btn ghost sm icon" href=${href(["indexes", row.name, "storage"])} title="Storage statistics">${icon("database", 14)}</a>`}
          <a class="btn ghost sm icon" href=${href(["indexes", "new"], { from: row.name })} title="Clone into a new standalone index">${icon("copy", 14)}</a>
          ${capabilities(row).readOnly
            ? nothing
            : html`<button class="btn ghost sm icon" title="Drop index" style="color:var(--danger)" @click=${() => dropIndexFlow(row)}>${icon("trash", 14)}</button>`}
        </span>`,
      },
    ];
  }

  render() {
    const { indexes, loaded } = this.app.value;
    const rows = this.filtered();
    const vectors = indexes.filter((index) => index.type === "VECTOR_SEARCH").length;
    const managedCount = indexes.filter((index) => managed(index)).length;
    const attention = indexes.filter((index) => indexStatus(index).tone !== "ok").length;
    return html`<div class="page">
      <div class="page__head">
        <div class="page__title">
          <h1>Indexes</h1>
          <div class="hint">
            ${formatNumber(indexes.length)} total · ${formatNumber(indexes.length - vectors)} search ·
            ${formatNumber(vectors)} vector${managedCount ? ` · ${formatNumber(managedCount)} from MongoDB` : ""}${attention
              ? html` · <span style="color:var(--warn)">${attention} need attention</span>`
              : nothing}
          </div>
        </div>
        <div class="page__actions">
          <a class="btn" href="#/indexes/new">${icon("plus")} New index</a>
        </div>
      </div>

      <section class="card">
        <div class="card__head">
          <div class="row" style="flex:1">
            <label class="input-search" style="min-width:240px;flex:0 1 320px">
              ${icon("search", 14)}
              <input
                type="search"
                placeholder="Filter by name or id"
                aria-label="Filter indexes"
                .value=${this.query}
                @input=${(e: InputEvent) => (this.query = (e.target as HTMLInputElement).value)}
              />
            </label>
            <div class="seg" role="group" aria-label="Type">
              ${(
                [
                  ["all", "All types"],
                  ["SEARCH", "Search"],
                  ["VECTOR_SEARCH", "Vector"],
                ] as const
              ).map(
                ([value, label]) => html`<button aria-pressed=${this.typeFilter === value ? "true" : "false"} @click=${() => this.setType(value)}>${label}</button>`,
              )}
            </div>
            <div class="seg" role="group" aria-label="Source">
              ${(
                [
                  ["all", "All sources"],
                  ["mongot", "Standalone"],
                  ["mongod", "Coupled"],
                ] as const
              ).map(
                ([value, label]) => html`<button aria-pressed=${this.sourceFilter === value ? "true" : "false"} @click=${() => this.setSource(value)}>${label}</button>`,
              )}
            </div>
            <div class="seg" role="group" aria-label="Status">
              ${(
                [
                  ["all", "Any status"],
                  ["ok", "Healthy"],
                  ["attention", "Needs attention"],
                ] as const
              ).map(
                ([value, label]) => html`<button aria-pressed=${this.statusFilter === value ? "true" : "false"} @click=${() => this.setStatus(value)}>${label}</button>`,
              )}
            </div>
          </div>
          <span class="hint">${rows.length === indexes.length ? "" : `${rows.length} of ${indexes.length} shown`}</span>
        </div>
        <div class="card__body flush">
          ${loaded && !indexes.length
            ? html`<mong-empty
                heading="No indexes yet"
                .message=${"An index defines which fields mongot makes searchable. Start from a template."}
                .action=${html`<a class="btn" href="#/indexes/new">${icon("plus")} Create your first index</a>`}
              ></mong-empty>`
            : html`<mong-data-table
                .rows=${rows}
                .columns=${this.columns()}
                .rowKey=${(row: SummaryIndex) => row.index_id}
                clickable
                sort-key="name"
                .maxHeight=${680}
                empty-text=${loaded ? "No indexes match these filters" : "Loading…"}
                @row-click=${(e: CustomEvent<SummaryIndex>) => navigate(["indexes", e.detail.name])}
              ></mong-data-table>`}
        </div>
      </section>
    </div>`;
  }
}

customElements.define("mong-indexes", MongIndexes);
