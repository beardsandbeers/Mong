import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { LightElement } from "../components/base";
import { confirmDialog } from "../components/dialog";
import { originBadge } from "../components/index-origin";
import { icon } from "../components/icons";
import { indexStatus, statusPill } from "../components/status-pill";
import type { TabSpec } from "../components/tabs";
import { toast } from "../components/toast";
import { track } from "../lib/activity";
import { api, ApiError, errorMessage } from "../lib/api";
import { capabilities, namespaceOf, replicated } from "../lib/capabilities";
import { originLabel, originTitle } from "../lib/origin";
import { download } from "../lib/csv";
import { canonicalJson, collapseContext, diffLines } from "../lib/diff";
import { prettyJson } from "../lib/ejson";
import { formatBytes, formatMs, formatNumber, formatPercent, formatRate, isNum } from "../lib/format";
import { href, navigate } from "../lib/router";
import { indexValues, SeriesController, times, WINDOWS, windowSeconds } from "../lib/series";
import { appStore, indexByName, refreshSummary } from "../lib/state";
import { load, save } from "../lib/storage";
import { StoreController } from "../lib/store";
import type { SummaryIndex, UpdateMode } from "../lib/types";
import { alertList } from "./dashboard";
import "./index-danger";
import "./index-fields";
import "./index-storage";

const TABS = ["overview", "definition", "fields", "storage", "data", "danger"] as const;
type Tab = (typeof TABS)[number];
/** Field and storage statistics and the danger zone exist only on the standalone API. */
const READ_ONLY_TABS: readonly Tab[] = ["overview", "definition", "data"];

function tabsFor(index: SummaryIndex): readonly Tab[] {
  if (index.source === "mongod") return READ_ONLY_TABS;
  if (replicated(index)) return ["overview", "definition", "fields", "storage", "data"];
  return TABS;
}

type DefinitionEditor = HTMLElement & {
  value: string;
  mode: string;
  index: unknown;
  getDefinition(): Record<string, unknown>;
};

export class MongIndexDetail extends LightElement {
  static properties = {
    name: { type: String },
    tab: { type: String },
    windowId: { state: true },
    draft: { state: true },
    baseRevision: { state: true },
    baseText: { state: true },
    saving: { state: true },
    defError: { state: true },
    updateMode: { state: true },
  };
  declare name: string;
  declare tab: string;
  declare windowId: string;
  declare draft: string;
  declare baseRevision: number | null;
  declare baseText: string;
  declare saving: boolean;
  declare defError: string | null;
  declare updateMode: UpdateMode;

  private readonly app = new StoreController(this, appStore);
  private readonly series = new SeriesController(this, () => this.index?.index_id);
  private loadedFor = "";

  constructor() {
    super();
    this.name = "";
    this.tab = "overview";
    this.windowId = load("index.window", "15m");
    this.draft = "";
    this.baseRevision = null;
    this.baseText = "";
    this.saving = false;
    this.defError = null;
    this.updateMode = "rebuild";
  }

  private get index(): SummaryIndex | undefined {
    return indexByName(this.name);
  }

  protected willUpdate(_changed: PropertyValues): void {
    const index = this.index;
    if (index && this.loadedFor !== index.index_id) {
      this.loadedFor = index.index_id;
      this.loadDefinition(index);
      void this.series.refresh();
    }
  }

  private loadDefinition(index: SummaryIndex): void {
    this.baseText = prettyJson(index.definition ?? {});
    this.baseRevision = index.desired_revision;
    this.draft = this.baseText;
    this.defError = null;
  }

  private setTab(tab: string): void {
    navigate(tab === "overview" ? ["indexes", this.name] : ["indexes", this.name, tab]);
  }

  // ----- header -----

  private header(index: SummaryIndex): TemplateResult {
    const caps = capabilities(index);
    const recreated = this.app.value.recreated.includes(index.name);
    return html`<div class="page__head">
      <div class="page__title">
        <div class="row">
          <h1>${index.name}</h1>
          ${originBadge(index)}
          ${statusPill(index)}
          <span class="badge">${caps.isVector ? "vector" : "search"}</span>
          ${recreated
            ? html`<span class="badge" title="This name now points at a new index id. Metrics history restarted.">recreated</span>`
            : nothing}
        </div>
        <div class="hint" title=${originTitle(index)}>
          ${originLabel(index)}${namespaceOf(index) ? html` · <span class="mono">${namespaceOf(index)}</span>` : nothing}
          · <span class="mono">${index.index_id}</span>
        </div>
      </div>
      <div class="page__actions">
        <a class="btn" href=${href("explore", { index: index.name })}>${icon("explore")} Query</a>
        <a class="btn secondary" href=${href(["indexes", "new"], { from: index.name })} title="Copy the definition into a new standalone index">${icon("copy")} Clone</a>
        <button class="btn secondary icon" title="Refresh" @click=${() => this.refresh()}>${icon("refresh")}</button>
      </div>
    </div>`;
  }

  private async refresh(): Promise<void> {
    await Promise.all([refreshSummary({ force: true }), this.series.refresh()]);
  }

  private tabs(index: SummaryIndex): TabSpec[] {
    const alerts = (this.app.value.summary?.alerts ?? []).filter((alert) => alert.index_id === index.index_id);
    const caps = capabilities(index);
    const shown = tabsFor(index);
    const tabs: (TabSpec & { id: Tab })[] = [
      { id: "overview", label: "Overview", badge: alerts.length || null },
      { id: "definition", label: "Definition", badge: this.dirty ? "edited" : null },
      { id: "fields", label: "Fields" },
      { id: "storage", label: "Storage" },
      {
        id: "data",
        label: "Data",
        disabled: !caps.browse && !caps.vector && !caps.search,
      },
      { id: "danger", label: "Danger zone" },
    ];
    return tabs.filter((tab) => shown.includes(tab.id));
  }

  // ----- overview -----

  private kpi(label: string, value: string, foot: unknown = nothing, tone = ""): TemplateResult {
    return html`<div class="kpi" data-tone=${tone}>
      <div class="kpi__label">${label}</div>
      <div class="kpi__value">${value}</div>
      <div class="kpi__foot"><span>${foot}</span></div>
    </div>`;
  }

  private overview(index: SummaryIndex): TemplateResult {
    const m = index.metrics ?? ({} as SummaryIndex["metrics"]);
    const caps = capabilities(index);
    const samples = this.series.window(windowSeconds(this.windowId));
    const t = times(samples);
    const markers = this.series.markers(samples, index.index_id);
    const alerts = (this.app.value.summary?.alerts ?? []).filter((alert) => alert.index_id === index.index_id);
    const status = indexStatus(index);
    const rate = (v: number | null) => formatRate(v, "");
    const empty = this.series.loaded ? "Waiting for the next sample…" : "Loading history…";
    return html`
      ${alerts.length
        ? html`<section class="card">${alertList(alerts, { linkIndexes: false })}</section>`
        : nothing}
      <div class="grid kpis">
        ${this.kpi("Documents", formatNumber(m.documents), isNum(m.max_documents) && m.max_documents !== m.documents ? `${formatNumber(m.max_documents)} incl. deleted` : "")}
        ${this.kpi("Size on disk", formatBytes(m.size_bytes), `${formatNumber(m.segments)} segments`)}
        ${this.kpi("Queries", rate(m.qps) + "/s", isNum(m.failed_qps) && m.failed_qps > 0 ? `${rate(m.failed_qps)}/s failing` : "", isNum(m.failed_qps) && m.failed_qps > 0 ? "warn" : "")}
        ${this.kpi(
          "Batch latency",
          formatMs(m.batch_latency_mean_ms),
          html`<span title="Rolling percentiles reported by mongot">p50 ${formatMs(m.batch_latency_p50_ms)} · p90 ${formatMs(m.batch_latency_p90_ms)} · p99 ${formatMs(m.batch_latency_p99_ms)}</span>`,
        )}
        ${this.kpi("Ingest", rate(m.ingest_rate) + "/s", `ins ${rate(m.insert_rate)} · upd ${rate(m.update_rate)} · del ${rate(m.delete_rate)}`)}
        ${this.kpi("Deleted", formatPercent(m.deleted_ratio, 1), "awaiting merge", isNum(m.deleted_ratio) && m.deleted_ratio > 0.3 ? "warn" : "")}
        ${this.kpi("Replication lag", formatMs(m.lag_ms), "", isNum(m.lag_ms) && m.lag_ms > 10000 ? "warn" : "")}
        ${this.kpi("Exceptions", formatNumber((m.initial_sync_exceptions ?? 0) + (m.steady_state_exceptions ?? 0)), `initial ${formatNumber(m.initial_sync_exceptions)} · steady ${formatNumber(m.steady_state_exceptions)}`)}
      </div>

      <div class="row between">
        <h2>Activity</h2>
        <div class="seg" role="group" aria-label="Time window">
          ${WINDOWS.map(
            (item) => html`<button
              aria-pressed=${this.windowId === item.id ? "true" : "false"}
              @click=${() => {
                this.windowId = item.id;
                save("index.window", item.id);
              }}
            >${item.label}</button>`,
          )}
        </div>
      </div>
      <div class="grid cols-3">
        <section class="card chart-card">
          <div class="card__head"><h3>Queries per second</h3></div>
          <div class="card__body">
            <mong-chart .times=${t} .markers=${markers} .format=${rate} .emptyText=${empty} .series=${[
              { label: "Queries", values: indexValues(samples, index.index_id, "qps") },
              { label: "Failed", values: indexValues(samples, index.index_id, "failed_qps"), color: "var(--danger)" },
            ]}></mong-chart>
          </div>
        </section>
        <section class="card chart-card">
          <div class="card__head"><h3>Batch latency</h3></div>
          <div class="card__body">
            <mong-chart .times=${t} .markers=${markers} .format=${formatMs} .emptyText=${empty} .series=${[
              { label: "Mean", values: indexValues(samples, index.index_id, "batch_latency_mean_ms") },
              { label: "Max (decaying)", values: indexValues(samples, index.index_id, "batch_latency_max_ms") },
            ]}></mong-chart>
          </div>
        </section>
        <section class="card chart-card">
          <div class="card__head"><h3>Ingest</h3></div>
          <div class="card__body">
            <mong-chart stacked .times=${t} .markers=${markers} .format=${rate} .emptyText=${empty} .series=${[
              { label: "Inserts", values: indexValues(samples, index.index_id, "insert_rate") },
              { label: "Updates", values: indexValues(samples, index.index_id, "update_rate") },
              { label: "Deletes", values: indexValues(samples, index.index_id, "delete_rate"), color: "var(--danger)" },
            ]}></mong-chart>
          </div>
        </section>
      </div>

      <div class="grid cols-2">
        <section class="card">
          <div class="card__head"><h2>Details</h2></div>
          <div class="card__body">
            <dl class="dl">
              <dt>Status</dt><dd>${status.label} <span class="muted small">${status.detail}</span></dd>
              <dt>Lifecycle</dt><dd>${index.lifecycle_state}</dd>
              <dt>Status metric</dt><dd>${m.status_label ?? "—"}</dd>
              <dt>Revision</dt>
              <dd>
                ${index.active_revision} active${index.desired_revision !== index.active_revision
                  ? html` · <strong>${index.desired_revision} building</strong>`
                  : nothing}
              </dd>
              <dt>Generation</dt><dd class="mono small">${index.generation_id ?? "—"}</dd>
              ${index.ownership
                ? html`<dt>Ownership</dt><dd>${index.ownership}</dd>`
                : nothing}
              ${namespaceOf(index)
                ? html`<dt>Collection</dt><dd class="mono">${namespaceOf(index)}</dd>`
                : nothing}
              ${index.ownership === "replicated"
                ? html`<dt>Queryable</dt><dd>${index.queryable ? "yes" : "no"}</dd>`
                : nothing}
              ${index.source_status
                ? html`<dt>Source</dt><dd>${index.source_status}</dd>`
                : nothing}
              ${index.read_capabilities?.length
                ? html`<dt>Reads</dt><dd>${index.read_capabilities.join(", ")}</dd>`
                : nothing}
              ${index.build?.state
                ? html`<dt>Build</dt><dd>${index.build.state}</dd>`
                : nothing}
              <dt>Index id</dt><dd class="mono small">${index.index_id}</dd>
              ${index.failure_message
                ? html`<dt>Failure</dt><dd style="color:var(--danger)">${index.failure_message}</dd>`
                : nothing}
              <dt>Memory</dt><dd>${formatBytes(m.memory_bytes)} <span class="muted small">required</span></dd>
            </dl>
          </div>
        </section>
        <section class="card">
          <div class="card__head"><h2>What you can do here</h2></div>
          <div class="card__body stack small">
            ${this.capability("Browse documents", caps.browse, caps.reasons.browse)}
            ${this.capability("Search queries", caps.search, caps.reasons.search)}
            ${this.capability("Vector queries", caps.vector, caps.reasons.vector)}
            ${this.capability("Edit documents", caps.editable, caps.reasons.editable)}
            ${caps.isVector
              ? html`<div class="muted">
                  Vector fields: ${caps.vectorFields.map((f) => html`<code>${f.path}</code> (${f.numDimensions ?? "?"} dims, ${f.similarity}) `)}
                </div>`
              : html`<div class="muted">Stored source: ${caps.storedSource}</div>`}
          </div>
        </section>
      </div>
    `;
  }

  /** nomongo-t reports no metrics for MongoDB-managed indexes, so this shows what MongoDB reports. */
  private managedOverview(index: SummaryIndex): TemplateResult {
    const caps = capabilities(index);
    const status = indexStatus(index);
    const alerts = (this.app.value.summary?.alerts ?? []).filter((alert) => alert.index_id === index.index_id);
    const building = index.desired_revision !== index.active_revision;
    return html`
      ${alerts.length
        ? html`<section class="card">${alertList(alerts, { linkIndexes: false })}</section>`
        : nothing}
      <div class="grid kpis">
        ${this.kpi("Documents", formatNumber(index.metrics?.documents), "in the collection")}
        ${this.kpi("Status", status.label, index.queryable ? "queryable" : "not queryable", index.queryable ? "" : "warn")}
        ${this.kpi("Definition version", String(index.active_revision), building ? `version ${index.desired_revision} building` : "")}
      </div>
      <div class="grid cols-2">
        <section class="card">
          <div class="card__head"><h2>Details</h2></div>
          <div class="card__body">
            <dl class="dl">
              <dt>Collection</dt><dd class="mono">${namespaceOf(index)}</dd>
              <dt>Index name</dt><dd class="mono">${index.index_name}</dd>
              <dt>Status</dt><dd>${index.lifecycle_state} <span class="muted small">${status.detail}</span></dd>
              <dt>Queryable</dt><dd>${index.queryable ? "yes" : "no"}</dd>
              <dt>mongot id</dt><dd class="mono small">${index.mongot_id ?? "—"}</dd>
              ${index.failure_message
                ? html`<dt>Failure</dt><dd style="color:var(--danger)">${index.failure_message}</dd>`
                : nothing}
            </dl>
          </div>
        </section>
        <section class="card">
          <div class="card__head"><h2>What you can do here</h2></div>
          <div class="card__body stack small">
            ${this.capability("Browse documents", caps.browse, caps.reasons.browse)}
            ${this.capability("Search queries", caps.search, caps.reasons.search)}
            ${this.capability("Vector queries", caps.vector, caps.reasons.vector)}
            ${this.capability("Edit documents", caps.editable, caps.reasons.editable)}
            <div class="muted">
              MongoDB builds this index from the collection through replication. Its definition changes with
              <code>updateSearchIndex</code> in MongoDB. nomongo-t's standalone API does not report it, so size, query
              rates, and storage statistics are not available here.
            </div>
          </div>
        </section>
      </div>
    `;
  }

  private capability(label: string, ok: boolean, reason?: string): TemplateResult {
    return html`<div class="row" style="align-items:flex-start;flex-wrap:nowrap">
      <span style="color:var(--${ok ? "ok" : "muted"});margin-top:2px">${icon(ok ? "check" : "x", 14)}</span>
      <div>
        <div>${label}</div>
        ${!ok && reason ? html`<div class="muted">${reason}</div>` : nothing}
      </div>
    </div>`;
  }

  // ----- definition -----

  private get dirty(): boolean {
    return this.draft !== this.baseText;
  }

  private get editor(): DefinitionEditor | null {
    return this.querySelector<DefinitionEditor>("mong-definition-editor");
  }

  private async saveDefinition(index: SummaryIndex): Promise<void> {
    const editor = this.editor;
    if (!editor || this.baseRevision == null) return;
    let definition: Record<string, unknown>;
    try {
      definition = editor.getDefinition();
    } catch (error) {
      this.defError = errorMessage(error);
      return;
    }
    let before: unknown = {};
    try {
      before = JSON.parse(this.baseText);
    } catch {
      before = {};
    }
    const lines = collapseContext(diffLines(canonicalJson(before), canonicalJson(definition)));
    if (!lines.some((line) => line.kind === "add" || line.kind === "del")) {
      toast("No changes to save (only formatting or key order differs).");
      return;
    }
    const docs = index.metrics?.documents;
    const preserve = this.updateMode === "preserve";
    const ok = await confirmDialog({
      title: `Save a new definition for ${index.name}?`,
      wide: true,
      danger: !preserve,
      confirmText: `Save revision ${this.baseRevision + 1}`,
      typeToConfirm: index.name,
      message: html`<div class="alert" data-tone=${preserve ? "info" : "danger"}>
          ${icon("alert", 18)}
          <div class="alert__body">
            <div class="alert__title">${preserve ? "Keep the documents when the server can" : "The index will be rebuilt empty"}</div>
            <div class="small">
              ${preserve
                ? html`mongot accepts revision ${this.baseRevision + 1} only when the new definition can keep the current documents. Otherwise the save is rejected and nothing is rebuilt.`
                : html`mongot builds revision ${this.baseRevision + 1} from scratch. The
                  ${docs != null ? html`<strong>${formatNumber(docs)}</strong>` : ""} documents in the current revision are
                  discarded once it takes over, and nothing re-ingests them for you. Reload your data afterwards, for example
                  with the CRM loader.`}
            </div>
          </div>
        </div>
        <div class="label">Changes</div>
        <div class="diff">
          ${lines.map((line) =>
            line.kind === "gap"
              ? html`<div class="ctx">… ${line.count} unchanged lines</div>`
              : html`<div class=${line.kind}>${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${line.text}</div>`,
          )}
        </div>`,
    });
    if (!ok) return;
    this.saving = true;
    this.defError = null;
    try {
      const updated = await track(
        "Update definition",
        index.name,
        () => api.updateIndex(index.index_id, definition, this.baseRevision!, this.updateMode),
        (result) => `revision ${result.desired_revision}`,
      );
      toast(
        this.updateMode === "preserve"
          ? `Saved revision ${updated.desired_revision}. mongot kept the documents in ${index.name}.`
          : `Saved revision ${updated.desired_revision}. mongot is rebuilding ${index.name}.`,
      );
      this.baseText = prettyJson(updated.definition ?? definition);
      this.baseRevision = updated.desired_revision;
      this.draft = this.baseText;
      await refreshSummary({ force: true });
    } catch (error) {
      this.defError =
        error instanceof ApiError && error.isConflict
          ? `Someone else changed this index (it is no longer at revision ${this.baseRevision}). Reload the definition, then reapply your edits.`
          : errorMessage(error);
    } finally {
      this.saving = false;
    }
  }

  private async exportObserved(index: SummaryIndex, mode: "download" | "load"): Promise<void> {
    try {
      const observed = await api.mappings(index.index_id);
      const definition = { ...(observed.definition ?? {}) } as Record<string, unknown>;
      if (definition.storedSource === undefined && index.definition?.storedSource !== undefined) {
        definition.storedSource = index.definition.storedSource;
      }
      if (mode === "download") {
        download(`${index.name}-observed-mapping.json`, prettyJson(definition), "application/json");
      } else {
        this.draft = prettyJson(definition);
        toast("Loaded the observed mapping into the editor. Review it before saving.");
      }
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  private definition(index: SummaryIndex): TemplateResult {
    const caps = capabilities(index);
    const serverMoved = this.baseRevision != null && index.desired_revision !== this.baseRevision;
    return html`
      ${serverMoved
        ? html`<div class="alert" data-tone="warn">
            ${icon("alert", 18)}
            <div class="alert__body">
              <div class="alert__title">The definition changed on the server</div>
              <div class="small">You loaded revision ${this.baseRevision}; the index is now at revision ${index.desired_revision}. Saving would be rejected.</div>
            </div>
            <button class="btn secondary sm" @click=${() => this.loadDefinition(index)}>Load revision ${index.desired_revision}</button>
          </div>`
        : nothing}
      ${caps.readOnly
        ? html`<div class="alert" data-tone="info">
            ${icon("info", 18)}
            <div class="alert__body">
              <div class="alert__title">MongoDB manages this definition</div>
              <div class="small">
                Change it with <code>db.${index.collection}.updateSearchIndex("${index.index_name}", …)</code> in the
                <code>${index.database}</code> database. MongoDB then rebuilds the index from the collection. Clone copies it
                into a new standalone index.
              </div>
            </div>
          </div>`
        : nothing}
      <section class="card">
        <div class="card__head">
          <div>
            <h2>Definition</h2>
            <div class="hint">${caps.readOnly ? "Version" : "Revision"} ${this.baseRevision ?? "—"}${this.dirty ? " · unsaved edits" : ""}</div>
          </div>
          <div class="row">
            <button class="btn ghost sm" @click=${() => navigator.clipboard.writeText(this.draft).then(() => toast("Copied definition"))}>
              ${icon("copy", 14)} Copy
            </button>
            ${caps.exportMappings
              ? html`<button class="btn ghost sm" title="Download the static mapping mongot has built from observed documents" @click=${() => this.exportObserved(index, "download")}>
                    ${icon("download", 14)} Export observed mapping
                  </button>
                  <button class="btn ghost sm" title="Replace the editor contents with the observed static mapping" @click=${() => this.exportObserved(index, "load")}>
                    ${icon("tree", 14)} Use observed mapping
                  </button>`
              : nothing}
          </div>
        </div>
        <div class="card__body stack">
          <mong-definition-editor
            .mode=${index.type}
            .index=${index}
            .readonly=${caps.readOnly}
            .value=${this.draft}
            @input=${(e: Event) => (this.draft = (e.target as DefinitionEditor).value)}
            @run=${(e: Event) => {
              e.preventDefault();
              if (!caps.readOnly) void this.saveDefinition(index);
            }}
          ></mong-definition-editor>
          ${this.dirty
            ? html`<div class="stack" style="gap:6px">
                <div class="label">Unsaved changes</div>
                ${this.diffPreview()}
              </div>`
            : nothing}
          ${this.defError ? html`<div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.defError}</div></div>` : nothing}
        </div>
        ${caps.readOnly
          ? nothing
          : html`<div class="drawer__foot">
              <label class="row small">
                Save
                <select
                  aria-label="How to apply the definition"
                  .value=${this.updateMode}
                  @change=${(e: Event) => (this.updateMode = (e.target as HTMLSelectElement).value as UpdateMode)}
                >
                  <option value="rebuild" ?selected=${this.updateMode === "rebuild"}>Rebuild empty</option>
                  <option value="preserve" ?selected=${this.updateMode === "preserve"}>Keep documents</option>
                  <option value="auto" ?selected=${this.updateMode === "auto"}>Let the server decide</option>
                </select>
              </label>
              <button class="btn secondary" ?disabled=${!this.dirty} @click=${() => (this.draft = this.baseText)}>Discard edits</button>
              <button class="btn ${this.updateMode === "rebuild" ? "danger" : ""}" ?disabled=${!this.dirty || this.saving || serverMoved} @click=${() => this.saveDefinition(index)}>
                ${this.saving ? "Saving…" : this.updateMode === "preserve" ? "Save and keep documents…" : "Save…"}
              </button>
            </div>`}
      </section>
    `;
  }

  private diffPreview(): TemplateResult {
    let before: unknown;
    let after: unknown;
    try {
      before = JSON.parse(this.baseText);
      after = JSON.parse(this.draft);
    } catch {
      return html`<div class="hint">The draft is not valid JSON yet.</div>`;
    }
    const lines = collapseContext(diffLines(canonicalJson(before), canonicalJson(after)), 2);
    if (!lines.some((line) => line.kind !== "ctx" && line.kind !== "gap")) {
      return html`<div class="hint">Only formatting or key order differs; nothing would change.</div>`;
    }
    return html`<div class="diff" style="max-height:260px">
      ${lines.map((line) =>
        line.kind === "gap"
          ? html`<div class="ctx">… ${line.count} unchanged lines</div>`
          : html`<div class=${line.kind}>${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${line.text}</div>`,
      )}
    </div>`;
  }

  // ----- render -----

  private panel(index: SummaryIndex, tab: string): TemplateResult {
    switch (tab as Tab) {
      case "definition":
        return this.definition(index);
      case "fields":
        return html`<mong-index-fields .index=${index}></mong-index-fields>`;
      case "storage":
        return html`<mong-index-storage .index=${index}></mong-index-storage>`;
      case "data":
        return html`<mong-explore .params=${new URLSearchParams({ index: index.name })} .embedded=${true}></mong-explore>`;
      case "danger":
        return html`<mong-index-danger .index=${index}></mong-index-danger>`;
      default:
        return index.source === "mongod" ? this.managedOverview(index) : this.overview(index);
    }
  }

  render() {
    const index = this.index;
    const { loaded } = this.app.value;
    if (!index) {
      return html`<div class="page">
        ${loaded
          ? html`<mong-empty
              heading=${`No index named ${this.name}`}
              .message=${"It may have been dropped, or the name is misspelled."}
              .action=${html`<a class="btn" href="#/indexes">See all indexes</a>`}
              glyph="layers"
            ></mong-empty>`
          : html`<span class="skeleton" style="width:240px;height:24px"></span><span class="skeleton block"></span>`}
      </div>`;
    }
    const tab = (tabsFor(index) as readonly string[]).includes(this.tab) ? this.tab : "overview";
    return html`<div class="page">
      ${this.header(index)}
      <mong-tabs .tabs=${this.tabs(index)} .active=${tab} @tab-change=${(e: CustomEvent<string>) => this.setTab(e.detail)}></mong-tabs>
      ${this.panel(index, tab)}
    </div>`;
  }
}

customElements.define("mong-index-detail", MongIndexDetail);
