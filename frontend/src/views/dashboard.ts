import { html, nothing, type TemplateResult } from "lit";
import { LightElement } from "../components/base";
import type { ChartSeries } from "../components/chart";
import type { Column } from "../components/data-table";
import { icon } from "../components/icons";
import { indexStatus, statusPill } from "../components/status-pill";
import { capabilities } from "../lib/capabilities";
import {
  formatBytes,
  formatCompact,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
  formatRate,
  isNum,
  relativeTime,
} from "../lib/format";
import { href, navigate } from "../lib/router";
import {
  indexValues,
  instanceValues,
  rpcOperations,
  rpcValues,
  SeriesController,
  times,
  WINDOWS,
  windowSeconds,
} from "../lib/series";
import { appStore, refreshSummary } from "../lib/state";
import { load, save } from "../lib/storage";
import { StoreController } from "../lib/store";
import type { Alert, IndexMetrics, SeriesSample, SummaryIndex } from "../lib/types";

const TONE: Record<Alert["severity"], string> = { error: "danger", warning: "warn", info: "info" };
const RPC_HIDDEN = new Set(["ListIndexes", "GetIndex"]);

export function alertList(alerts: Alert[], options: { linkIndexes?: boolean } = {}): TemplateResult {
  const linkIndexes = options.linkIndexes ?? true;
  return html`<div class="alert-list">
    ${alerts.map((alert) => {
      const body = html`<span class="dot" data-tone=${TONE[alert.severity]} style="margin-top:6px"></span>
        <div class="alert__body">
          <div class="alert__title">${alert.title}</div>
          <div class="small muted">${alert.detail}</div>
        </div>`;
      return linkIndexes && alert.index_name
        ? html`<a href=${href(["indexes", alert.index_name])}>${body}${icon("chevronRight", 14)}</a>`
        : html`<div>${body}</div>`;
    })}
  </div>`;
}

export class MongDashboard extends LightElement {
  static properties = { windowId: { state: true } };
  declare windowId: string;

  private readonly app = new StoreController(this, appStore);
  private readonly series = new SeriesController(this);

  constructor() {
    super();
    this.windowId = load("dashboard.window", "15m");
  }

  private setWindow(id: string): void {
    this.windowId = id;
    save("dashboard.window", id);
  }

  private async refresh(): Promise<void> {
    await Promise.all([refreshSummary({ force: true }), this.series.refresh()]);
  }

  private kpi(
    label: string,
    value: string,
    options: { foot?: unknown; trend?: Array<number | null>; tone?: string; title?: string } = {},
  ): TemplateResult {
    return html`<div class="kpi" data-tone=${options.tone ?? ""} title=${options.title ?? ""}>
      <div class="kpi__label">${label}</div>
      <div class="kpi__value">${value}</div>
      <div class="kpi__foot">
        <span>${options.foot ?? nothing}</span>
        ${options.trend ? html`<mong-sparkline .values=${options.trend}></mong-sparkline>` : nothing}
      </div>
    </div>`;
  }

  private kpis(samples: SeriesSample[]): TemplateResult {
    const { summary, indexes } = this.app.value;
    const instance = summary?.instance;
    const healthy = indexes.filter((index) => indexStatus(index).tone === "ok").length;
    const free = instance?.free_disk_bytes;
    const diskTone = isNum(free) ? (free < 2 * 1024 ** 3 ? "danger" : free < 10 * 1024 ** 3 ? "warn" : "") : "";
    const queued = instance?.rpc_queued ?? 0;
    return html`<div class="grid kpis">
      ${this.kpi("Indexes", formatNumber(indexes.length), {
        foot: indexes.length ? `${healthy} healthy` : "none yet",
        tone: healthy < indexes.length ? "warn" : "",
      })}
      ${this.kpi("Queries", formatRate(instance?.qps), {
        trend: instanceValues(samples, "qps"),
        foot: "per second",
      })}
      ${this.kpi("Failed queries", formatRate(instance?.failed_qps), {
        trend: instanceValues(samples, "failed_qps"),
        foot: "per second",
        tone: isNum(instance?.failed_qps) && instance!.failed_qps! > 0 ? "danger" : "",
      })}
      ${this.kpi("Search latency", formatMs(instance?.search_latency_mean_ms), {
        trend: instanceValues(samples, "search_latency_mean_ms"),
        foot: "mean per RPC",
        title: "Mean duration of Search, VectorSearch, and GetMore calls in the last interval",
      })}
      ${this.kpi("Ingest", formatRate(instance?.ingest_rate), {
        trend: instanceValues(samples, "ingest_rate"),
        foot: "inserts + updates /s",
      })}
      ${this.kpi("Documents", formatCompact(instance?.documents), {
        trend: instanceValues(samples, "documents"),
        foot: formatBytes(instance?.size_bytes) + " on disk",
      })}
      ${this.kpi("Free disk", formatBytes(free), { tone: diskTone, foot: "data volume" })}
      ${this.kpi("RPCs in flight", formatNumber(instance?.rpc_inflight), {
        trend: instanceValues(samples, "rpc_inflight"),
        foot: queued ? `${formatNumber(queued)} queued` : "none queued",
        tone: queued ? "warn" : "",
      })}
      ${this.kpi("Merges · cursors", `${formatNumber(instance?.merges)} · ${formatNumber(instance?.cursors)}`, {
        foot: "running · open",
      })}
    </div>`;
  }

  private healthBanner(): TemplateResult | typeof nothing {
    const { summary, connection, indexes, loaded } = this.app.value;
    if (!summary || connection === "down") return nothing;
    const errors = summary.alerts.filter((alert) => alert.severity === "error");
    const warnings = summary.alerts.filter((alert) => alert.severity === "warning");
    if (errors.length) {
      return html`<div class="alert" data-tone="danger" role="status">
        ${icon("alert", 18)}
        <div class="alert__body">
          <div class="alert__title">${errors.length === 1 ? errors[0].title : `${errors.length} problems need attention`}</div>
          <div class="small">${errors.length === 1 ? errors[0].detail : errors.map((alert) => alert.title).join(" · ")}</div>
        </div>
      </div>`;
    }
    if (warnings.length) {
      return html`<div class="alert" data-tone="warn" role="status">
        ${icon("alert", 18)}
        <div class="alert__body">
          <div class="alert__title">${warnings.length === 1 ? warnings[0].title : `${warnings.length} warnings`}</div>
          <div class="small">${warnings.length === 1 ? warnings[0].detail : warnings.map((alert) => alert.title).join(" · ")}</div>
        </div>
      </div>`;
    }
    if (!loaded) return nothing;
    return html`<div class="alert" data-tone="ok" role="status">
      ${icon("check", 18)}
      <div class="alert__body">
        <div class="alert__title">All systems healthy</div>
        <div class="small">
          ${indexes.length ? `${indexes.length} indexes ready` : "mongot is up"} · sampled
          ${relativeTime(summary.sampled_at)}
        </div>
      </div>
    </div>`;
  }

  private indexColumns(samples: SeriesSample[]): Column<SummaryIndex>[] {
    const metric = (row: SummaryIndex, key: keyof IndexMetrics) => row.metrics?.[key] as number | null | undefined;
    return [
      {
        key: "name",
        label: "Index",
        pinned: true,
        render: (row) => html`<a href=${href(["indexes", row.name])} @click=${(e: Event) => e.stopPropagation()}>${row.name}</a>
          ${row.type === "VECTOR_SEARCH" ? html`<span class="badge">vector</span>` : nothing}`,
      },
      {
        key: "status",
        label: "Status",
        render: (row) => statusPill(row),
        sortValue: (row) => indexStatus(row).label,
      },
      {
        key: "documents",
        label: "Documents",
        align: "right",
        render: (row) => formatNumber(metric(row, "documents")),
        sortValue: (row) => metric(row, "documents"),
      },
      {
        key: "size",
        label: "Size",
        align: "right",
        render: (row) => formatBytes(metric(row, "size_bytes")),
        sortValue: (row) => metric(row, "size_bytes"),
      },
      {
        key: "qps",
        label: "Queries/s",
        align: "right",
        render: (row) => html`<span class="row" style="justify-content:flex-end;flex-wrap:nowrap">
          <mong-sparkline .values=${indexValues(samples, row.index_id, "qps")} width="64" height="18"></mong-sparkline>
          <span style="min-width:56px">${formatRate(metric(row, "qps"), "")}</span>
        </span>`,
        sortValue: (row) => metric(row, "qps"),
      },
      {
        key: "latency",
        label: "Batch latency",
        align: "right",
        render: (row) => formatMs(metric(row, "batch_latency_mean_ms")),
        sortValue: (row) => metric(row, "batch_latency_mean_ms"),
        title: () => "Mean time to produce a result batch in the last interval",
      },
      {
        key: "ingest",
        label: "Ingest/s",
        align: "right",
        render: (row) => formatRate(metric(row, "ingest_rate"), ""),
        sortValue: (row) => metric(row, "ingest_rate"),
      },
      {
        key: "deleted",
        label: "Deleted",
        align: "right",
        render: (row) => {
          const ratio = metric(row, "deleted_ratio");
          return html`<span style=${isNum(ratio) && ratio > 0.3 ? "color:var(--warn)" : ""}>${formatPercent(ratio, 0)}</span>`;
        },
        sortValue: (row) => metric(row, "deleted_ratio"),
        title: () => "Share of Lucene documents that are deleted and awaiting merge",
      },
      {
        key: "segments",
        label: "Segments",
        align: "right",
        render: (row) => formatNumber(metric(row, "segments")),
        sortValue: (row) => metric(row, "segments"),
      },
      {
        key: "lag",
        label: "Lag",
        align: "right",
        render: (row) => formatMs(metric(row, "lag_ms")),
        sortValue: (row) => metric(row, "lag_ms"),
      },
      {
        key: "error",
        label: "Latest error",
        truncate: true,
        render: (row) => {
          const alert = this.app.value.summary?.alerts.find(
            (item) => item.index_id === row.index_id && item.severity !== "info",
          );
          const text = row.failure_message ?? alert?.title ?? "";
          return text ? html`<span style="color:var(--${row.failure_message || alert?.severity === "error" ? "danger" : "warn"})">${text}</span>` : html`<span class="muted">—</span>`;
        },
        title: (row) => row.failure_message ?? "",
        sortable: false,
      },
    ];
  }

  private chartCard(title: string, hint: string, body: TemplateResult): TemplateResult {
    return html`<section class="card chart-card">
      <div class="card__head">
        <div>
          <h2>${title}</h2>
          <div class="hint">${hint}</div>
        </div>
      </div>
      <div class="card__body">${body}</div>
    </section>`;
  }

  private charts(samples: SeriesSample[]): TemplateResult {
    const indexes = this.app.value.indexes.filter((index) => !capabilities(index).readOnly);
    const t = times(samples);
    const markers = this.series.markers(samples);
    const perIndex = (key: keyof IndexMetrics): ChartSeries[] =>
      indexes.map((index) => ({ label: index.name, values: indexValues(samples, index.index_id, key) }));
    const ops = rpcOperations(samples).filter((op) => !RPC_HIDDEN.has(op));
    const rpcRate: ChartSeries[] = ops.map((op) => ({ label: op, values: rpcValues(samples, op, "rate") }));
    const rpcErrors: ChartSeries[] = ops
      .map((op) => ({ label: op, values: rpcValues(samples, op, "error_rate") }))
      .filter((item) => item.values.some((value) => value));
    const empty = this.series.loaded ? "Waiting for the next sample…" : "Loading history…";
    return html`<div class="grid cols-2">
      ${this.chartCard(
        "Queries per second",
        "Stacked by index, from mongot's query counters",
        html`<mong-chart stacked .times=${t} .series=${perIndex("qps")} .markers=${markers} .format=${(v: number | null) => formatRate(v, "")} .emptyText=${empty}></mong-chart>`,
      )}
      ${this.chartCard(
        "Batch latency",
        "Mean time per result batch, per index",
        html`<mong-chart .times=${t} .series=${perIndex("batch_latency_mean_ms")} .markers=${markers} .format=${formatMs} .emptyText=${empty}></mong-chart>`,
      )}
      ${this.chartCard(
        "Ingest",
        "Inserts and updates per second, stacked by index",
        html`<mong-chart stacked .times=${t} .series=${perIndex("ingest_rate")} .markers=${markers} .format=${(v: number | null) => formatRate(v, "")} .emptyText=${empty}></mong-chart>`,
      )}
      ${this.chartCard(
        "RPC traffic",
        rpcErrors.length ? "Calls per second by operation; some calls are failing" : "Calls per second by operation (status polling excluded)",
        html`<mong-chart stacked .times=${t} .series=${rpcRate} .markers=${markers} .format=${(v: number | null) => formatRate(v, "")} .emptyText=${empty}></mong-chart>
          ${rpcErrors.length
            ? html`<div class="divider"></div>
                <div class="small muted" style="margin:4px 0">Errors per second</div>
                <mong-chart .height=${110} .times=${t} .series=${rpcErrors.map((item) => ({ ...item, color: "var(--danger)" }))} .format=${(v: number | null) => formatRate(v, "")}></mong-chart>`
            : nothing}`,
      )}
    </div>`;
  }

  private rpcTable(): TemplateResult | typeof nothing {
    const rpc = this.app.value.summary?.rpc ?? [];
    if (!rpc.length) return nothing;
    return html`<section class="card">
      <div class="card__head">
        <div>
          <h2>RPC operations</h2>
          <div class="hint">Totals since mongot started; rates and latency for the last interval</div>
        </div>
      </div>
      <div class="card__body flush">
        <mong-data-table
          .rows=${rpc}
          .rowKey=${(row: { operation: string }) => row.operation}
          sort-key="total"
          sort-dir="desc"
          .maxHeight=${320}
          .columns=${[
            { key: "operation", label: "Operation" },
            { key: "total", label: "Calls", align: "right", render: (row: any) => formatNumber(row.total) },
            {
              key: "errors",
              label: "Errors",
              align: "right",
              render: (row: any) => html`<span style=${row.errors ? "color:var(--danger)" : ""}>${formatNumber(row.errors)}</span>`,
            },
            { key: "rate", label: "Calls/s", align: "right", render: (row: any) => formatRate(row.rate, "") },
            { key: "mean_ms", label: "Mean latency", align: "right", render: (row: any) => formatMs(row.mean_ms) },
          ]}
        ></mong-data-table>
      </div>
    </section>`;
  }

  render() {
    const { summary, indexes, loaded, connection } = this.app.value;
    const samples = this.series.window(windowSeconds(this.windowId));
    const alerts = summary?.alerts ?? [];
    return html`<div class="page">
      <div class="page__head">
        <div class="page__title">
          <h1>Dashboard</h1>
          <div class="hint">
            Sampled every ${summary?.interval ?? 5} s${summary?.started_at
              ? html` · history since ${formatDateTime(summary.started_at)} (kept in memory)`
              : nothing}
          </div>
        </div>
        <div class="page__actions">
          <div class="seg" role="group" aria-label="Time window">
            ${WINDOWS.map(
              (item) => html`<button aria-pressed=${this.windowId === item.id ? "true" : "false"} @click=${() => this.setWindow(item.id)}>
                ${item.label}
              </button>`,
            )}
          </div>
          <button
            class="btn secondary"
            aria-pressed=${this.series.paused ? "true" : "false"}
            title=${this.series.paused ? "Resume live charts" : "Freeze the charts to inspect them"}
            @click=${() => (this.series.paused = !this.series.paused)}
          >
            ${icon(this.series.paused ? "play" : "pause")} ${this.series.paused ? "Resume" : "Pause"}
          </button>
          <button class="btn secondary" @click=${() => this.refresh()}>${icon("refresh")} Refresh</button>
        </div>
      </div>

      ${this.healthBanner()}

      ${!loaded && connection !== "down"
        ? html`<div class="grid kpis">${Array.from({ length: 8 }, () => html`<div class="kpi"><span class="skeleton" style="width:60%"></span><span class="skeleton" style="height:24px"></span></div>`)}</div>`
        : this.kpis(samples)}

      ${alerts.length
        ? html`<section class="card">
            <div class="card__head">
              <h2>Alerts <span class="badge">${alerts.length}</span></h2>
            </div>
            ${alertList(alerts)}
          </section>`
        : nothing}

      <section class="card">
        <div class="card__head">
          <div>
            <h2>Index health</h2>
            <div class="hint">Click a row for details</div>
          </div>
          <a class="btn secondary sm" href="#/indexes/new">${icon("plus", 14)} New index</a>
        </div>
        <div class="card__body flush">
          ${loaded && !indexes.length
            ? html`<mong-empty
                heading="No indexes yet"
                .message=${"Create an index, then load documents into it."}
                .action=${html`<a class="btn" href="#/indexes/new">${icon("plus")} Create an index</a>`}
              ></mong-empty>`
            : html`<mong-data-table
                .rows=${indexes}
                .columns=${this.indexColumns(samples)}
                .rowKey=${(row: SummaryIndex) => row.index_id}
                clickable
                sort-key="name"
                empty-text=${loaded ? "No indexes" : "Loading…"}
                @row-click=${(e: CustomEvent<SummaryIndex>) => navigate(["indexes", e.detail.name])}
              ></mong-data-table>`}
        </div>
      </section>

      ${this.charts(samples)}
      ${this.rpcTable()}
    </div>`;
  }
}

customElements.define("mong-dashboard", MongDashboard);
