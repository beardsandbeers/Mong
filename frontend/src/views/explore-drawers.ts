import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { LightElement } from "../components/base";
import { confirmDialog } from "../components/dialog";
import { icon } from "../components/icons";
import { toast } from "../components/toast";
import { logActivity, track } from "../lib/activity";
import { api, errorMessage } from "../lib/api";
import { capabilities } from "../lib/capabilities";
import { displayValue, numericArrays, prettyJson } from "../lib/ejson";
import { formatBytes, formatNumber } from "../lib/format";
import type { Hit } from "../lib/hits";
import { importFile, type ImportProblem } from "../lib/importer";
import type { IndexInfo, SummaryIndex, WriteConcern } from "../lib/types";

type JsonInput = HTMLElement & { value: string; parse(): unknown; indent(): boolean };

const CONCERNS: Array<{ id: WriteConcern; label: string; hint: string }> = [
  { id: "visible", label: "Visible", hint: "Returns once the change is searchable" },
  { id: "committed", label: "Committed", hint: "Returns once the change is durable on disk" },
  { id: "indexed", label: "Indexed", hint: "Returns once mongot has indexed it; fastest" },
];

function concernSelect(value: WriteConcern, onChange: (value: WriteConcern) => void): TemplateResult {
  return html`<label class="row small" title=${CONCERNS.find((c) => c.id === value)?.hint ?? ""}>
    Write concern
    <select .value=${value} @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value as WriteConcern)}>
      ${CONCERNS.map((c) => html`<option value=${c.id} ?selected=${c.id === value}>${c.label}</option>`)}
    </select>
  </label>`;
}

export interface SimilarTarget {
  index: SummaryIndex;
  path: string;
  vector: number[];
}

/** Vector indexes whose vector field matches a numeric array in the document. */
export function similarTargets(doc: unknown, indexes: SummaryIndex[]): SimilarTarget[] {
  const arrays = numericArrays(doc);
  const out: SimilarTarget[] = [];
  for (const index of indexes) {
    for (const field of capabilities(index).vectorFields) {
      const match =
        arrays.find((item) => item.path === field.path && (!field.numDimensions || item.values.length === field.numDimensions)) ??
        arrays.find((item) => field.numDimensions && item.values.length === field.numDimensions);
      if (match) out.push({ index, path: field.path, vector: match.values });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document drawer
// ---------------------------------------------------------------------------

export class MongDocDrawer extends LightElement {
  static properties = {
    hit: { attribute: false },
    index: { attribute: false },
    indexes: { attribute: false },
    view: { state: true },
    editing: { state: true },
    concern: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  declare hit: Hit | null;
  declare index: SummaryIndex;
  declare indexes: SummaryIndex[];
  declare view: "tree" | "json" | "meta";
  declare editing: boolean;
  declare concern: WriteConcern;
  declare busy: boolean;
  declare error: string | null;

  constructor() {
    super();
    this.hit = null;
    this.indexes = [];
    this.view = "tree";
    this.editing = false;
    this.concern = "visible";
    this.busy = false;
    this.error = null;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("hit")) {
      this.editing = false;
      this.error = null;
    }
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  private async save(): Promise<void> {
    const hit = this.hit!;
    const input = this.querySelector<JsonInput>("mong-json-input");
    if (!input) return;
    let doc: Record<string, unknown>;
    try {
      const parsed = input.parse();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The document must be a JSON object");
      doc = parsed as Record<string, unknown>;
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    if (doc._id === undefined) {
      this.error = "The document needs an _id.";
      return;
    }
    if (JSON.stringify(doc._id) !== JSON.stringify(hit.id)) {
      const ok = await confirmDialog({
        title: "Change the _id?",
        message: "Upsert writes a new document under the new _id and keeps the old one. Delete the old one yourself if you meant to rename it.",
        confirmText: "Write a new document",
      });
      if (!ok) return;
    }
    this.busy = true;
    this.error = null;
    try {
      await track("Edit document", this.index.name, () => api.upsert(this.index.index_id, [doc], this.concern), () => displayValue(doc._id));
      toast("Document saved.");
      this.editing = false;
      this.emit("saved", { hit, doc });
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busy = false;
    }
  }

  private async deleteDoc(): Promise<void> {
    const hit = this.hit!;
    const ok = await confirmDialog({
      title: "Delete this document?",
      message: html`<p>Deletes <code>${displayValue(hit.id)}</code> from ${this.index.name}. This cannot be undone.</p>`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    this.busy = true;
    try {
      await track("Delete document", this.index.name, () => api.deleteDocument(this.index.index_id, hit.id, this.concern), () => displayValue(hit.id));
      toast("Document deleted.");
      this.emit("deleted", hit);
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busy = false;
    }
  }

  render() {
    const hit = this.hit;
    if (!hit) return html`<mong-drawer .open=${false}></mong-drawer>`;
    const caps = capabilities(this.index);
    const canEdit = caps.editable && hit.hasSource;
    const editReason = !hit.hasSource && !caps.readOnly
      ? "This hit has no stored source, so only its _id is known."
      : caps.reasons.editable;
    const targets = similarTargets(hit.doc, this.indexes);
    const body = html`
      ${this.error ? html`<div class="alert" data-tone="danger" style="margin-bottom:12px">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div>` : nothing}
      ${this.editing
        ? html`<div class="stack">
            <mong-json-input aria-label="Document JSON" height="360" resize-key="document" .value=${prettyJson(hit.doc)} @run=${() => this.save()}></mong-json-input>
            <div class="hint">Upsert replaces the whole document. Extended JSON such as {"$oid": …} and {"$date": …} keeps its type. Ctrl+Enter saves.</div>
          </div>`
        : html`
            <div class="row between" style="margin-bottom:10px">
              <div class="seg" role="group" aria-label="View">
                ${(["tree", "json", "meta"] as const).map(
                  (view) => html`<button aria-pressed=${this.view === view ? "true" : "false"} @click=${() => (this.view = view)}>
                    ${view === "tree" ? "Tree" : view === "json" ? "JSON" : "Search metadata"}
                  </button>`,
                )}
              </div>
              ${!canEdit && editReason ? html`<span class="hint" title=${editReason}>${icon("info", 12)} Read-only</span>` : nothing}
            </div>
            ${this.view === "tree"
              ? html`<mong-json-tree .value=${hit.doc} expand-depth="2"></mong-json-tree>`
              : this.view === "json"
                ? html`<pre class="raw card">${prettyJson(hit.doc)}</pre>`
                : html`<mong-json-tree .value=${hit.meta} expand-depth="3"></mong-json-tree>`}
            ${!canEdit && editReason ? html`<p class="hint" style="margin-top:12px">${editReason}</p>` : nothing}
          `}
    `;
    const footer = this.editing
      ? html`${concernSelect(this.concern, (value) => (this.concern = value))}
          <span class="spacer"></span>
          <button class="btn secondary" @click=${() => (this.editing = false)}>Cancel</button>
          <button class="btn" ?disabled=${this.busy} @click=${() => this.save()}>${this.busy ? "Saving…" : "Save document"}</button>`
      : html`<button class="btn ghost" @click=${() => navigator.clipboard.writeText(prettyJson(hit.doc)).then(() => toast("Copied document JSON"))}>
            ${icon("copy", 14)} Copy
          </button>
          ${targets.length
            ? html`<button
                class="btn secondary"
                title="Run a vector query with this document's embedding"
                @click=${() => this.emit("find-similar", targets[0])}
              >
                ${icon("sparkle", 14)} Find similar${targets.length > 1 ? ` (${targets[0].index.name})` : ""}
              </button>`
            : nothing}
          <span class="spacer"></span>
          <button
            class="btn danger-outline"
            ?disabled=${this.busy || caps.readOnly || hit.id === undefined || caps.isVector && !hit.id}
            title=${caps.readOnly ? (caps.reasons.editable ?? "") : ""}
            @click=${() => this.deleteDoc()}
          >
            ${icon("trash", 14)} Delete
          </button>
          <button class="btn" ?disabled=${!canEdit} title=${canEdit ? "" : editReason ?? ""} @click=${() => (this.editing = true)}>
            ${icon("edit", 14)} Edit
          </button>`;
    return html`<mong-drawer
      open
      wide
      .heading=${html`<span class="mono">${displayValue(hit.id) || "Document"}</span>`}
      .subheading=${hit.score != null ? `score ${hit.score.toFixed(4)} · ${this.index.name}` : this.index.name}
      .body=${body}
      .footer=${footer}
      @close=${() => this.emit("close")}
    ></mong-drawer>`;
  }
}

customElements.define("mong-doc-drawer", MongDocDrawer);

// ---------------------------------------------------------------------------
// New document drawer
// ---------------------------------------------------------------------------

export class MongUpsertDrawer extends LightElement {
  static properties = {
    index: { attribute: false },
    concern: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  declare index: IndexInfo;
  declare concern: WriteConcern;
  declare busy: boolean;
  declare error: string | null;

  constructor() {
    super();
    this.concern = "visible";
    this.busy = false;
    this.error = null;
  }

  private template(): string {
    const caps = capabilities(this.index);
    if (caps.isVector) {
      const field = caps.vectorFields[0];
      const dims = field?.numDimensions ?? 3;
      return prettyJson({
        _id: "doc-1",
        [field?.path ?? "embedding"]: Array.from({ length: Math.min(dims, 8) }, () => 0.1),
        ...(caps.filterFields[0] ? { [caps.filterFields[0]]: "value" } : {}),
      }).replace("0.1\n  ]", dims > 8 ? `0.1\n    /* … ${dims} numbers in total */\n  ]` : "0.1\n  ]");
    }
    return prettyJson({ _id: "doc-1", title: "Hello", created_at: { $date: new Date().toISOString() } });
  }

  private async save(): Promise<void> {
    const input = this.querySelector<JsonInput>("mong-json-input");
    if (!input) return;
    let docs: Record<string, unknown>[];
    try {
      const parsed = input.parse();
      docs = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
      if (!docs.length || docs.some((doc) => !doc || typeof doc !== "object" || Array.isArray(doc))) {
        throw new Error("Enter a document object or an array of documents");
      }
      if (docs.some((doc) => doc._id === undefined)) throw new Error("Every document needs an _id");
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const result = await track("Upsert documents", this.index.name, () => api.upsert(this.index.index_id, docs, this.concern), (r) => `${formatNumber(r.indexed_count ?? docs.length)} documents`);
      toast(`Upserted ${formatNumber(result.indexed_count ?? docs.length)} document${docs.length === 1 ? "" : "s"}.`);
      this.dispatchEvent(new CustomEvent("saved", { detail: docs }));
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busy = false;
    }
  }

  render() {
    const body = html`<div class="stack">
      <mong-json-input aria-label="Documents JSON" height="360" resize-key="document" .value=${this.template()} @run=${() => this.save()}></mong-json-input>
      <div class="hint">One document or an array. An existing _id is replaced. Extended JSON keeps BSON types. Ctrl+Enter saves.</div>
      ${this.error ? html`<div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div>` : nothing}
    </div>`;
    const footer = html`${concernSelect(this.concern, (value) => (this.concern = value))}
      <span class="spacer"></span>
      <button class="btn secondary" @click=${() => this.dispatchEvent(new CustomEvent("close"))}>Cancel</button>
      <button class="btn" ?disabled=${this.busy} @click=${() => this.save()}>${this.busy ? "Saving…" : "Upsert"}</button>`;
    return html`<mong-drawer
      open
      wide
      .heading=${"Upsert documents"}
      .subheading=${this.index.name}
      .body=${body}
      .footer=${footer}
      @close=${() => this.dispatchEvent(new CustomEvent("close"))}
    ></mong-drawer>`;
  }
}

customElements.define("mong-upsert-drawer", MongUpsertDrawer);

// ---------------------------------------------------------------------------
// Import drawer
// ---------------------------------------------------------------------------

const IMPORT_BATCH = 500;
const MAX_PROBLEMS = 200;

export class MongImportDrawer extends LightElement {
  static properties = {
    index: { attribute: false },
    file: { state: true },
    concern: { state: true },
    running: { state: true },
    finished: { state: true },
    read: { state: true },
    sent: { state: true },
    bytes: { state: true },
    problems: { state: true },
    over: { state: true },
  };
  declare index: IndexInfo;
  declare file: File | null;
  declare concern: WriteConcern;
  declare running: boolean;
  declare finished: boolean;
  declare read: number;
  declare sent: number;
  declare bytes: number;
  declare problems: ImportProblem[];
  declare over: boolean;

  private controller: AbortController | null = null;
  private readonly onUnload = (event: BeforeUnloadEvent) => {
    if (!this.running) return;
    event.preventDefault();
    event.returnValue = "";
  };

  constructor() {
    super();
    this.file = null;
    this.concern = "indexed";
    this.running = false;
    this.finished = false;
    this.read = 0;
    this.sent = 0;
    this.bytes = 0;
    this.problems = [];
    this.over = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.onUnload);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("beforeunload", this.onUnload);
    this.controller?.abort();
  }

  private choose(file: File | null | undefined): void {
    if (!file || this.running) return;
    this.file = file;
    this.finished = false;
    this.read = 0;
    this.sent = 0;
    this.bytes = 0;
    this.problems = [];
  }

  private async run(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    this.finished = false;
    this.read = 0;
    this.sent = 0;
    this.bytes = 0;
    this.problems = [];
    const started = performance.now();
    const { cancelled, stopped } = await importFile(file, {
      upsert: (docs, signal) => api.upsert(this.index.index_id, docs, this.concern, signal),
      signal: controller.signal,
      batchSize: IMPORT_BATCH,
      maxProblems: MAX_PROBLEMS,
      onProgress: (progress) => {
        this.read = progress.read;
        this.sent = progress.sent;
        this.bytes = progress.bytes;
        this.problems = progress.problems;
      },
    });
    this.running = false;
    this.finished = true;
    this.controller = null;
    const detail = `${formatNumber(this.sent)} of ${formatNumber(this.read)} records written${this.problems.length ? `, ${this.problems.length} problems` : ""}${cancelled ? " (cancelled)" : ""}${stopped ? ` (${stopped})` : ""}`;
    logActivity({ action: "Import file", index: this.index.name, ok: !stopped && !cancelled, detail: `${file.name}: ${detail}`, ms: performance.now() - started });
    toast(`Import ${cancelled ? "cancelled" : stopped ? "stopped" : "finished"}: ${detail}`, stopped ? "error" : "info");
    if (this.sent) this.dispatchEvent(new CustomEvent("saved"));
  }

  render() {
    const file = this.file;
    const pct = file && file.size ? Math.min(100, (this.bytes / file.size) * 100) : 0;
    const body = html`<div class="stack">
      <p class="small">
        Reads NDJSON (one document per line) or a JSON array, streaming the file so large files are fine. Documents are upserted in
        batches of ${IMPORT_BATCH}; upsert is idempotent, so re-running an import is safe.
      </p>
      <label
        class="dropzone ${this.over ? "over" : ""}"
        @dragover=${(e: DragEvent) => {
          e.preventDefault();
          this.over = true;
        }}
        @dragleave=${() => (this.over = false)}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          this.over = false;
          this.choose(e.dataTransfer?.files?.[0]);
        }}
      >
        ${icon("upload", 28)}
        ${file
          ? html`<strong>${file.name}</strong><span>${formatBytes(file.size)}</span>`
          : html`<strong>Drop a .ndjson or .json file</strong><span>or click to choose one</span>`}
        <input type="file" accept=".json,.ndjson,.jsonl,application/json,application/x-ndjson" hidden ?disabled=${this.running} @change=${(e: Event) => this.choose((e.target as HTMLInputElement).files?.[0])} />
      </label>
      ${this.running || this.finished
        ? html`<div class="stack" style="gap:6px">
            <div class="progress"><span style="width:${pct}%"></span></div>
            <div class="row between small">
              <span>${formatNumber(this.read)} read · <strong>${formatNumber(this.sent)}</strong> written</span>
              <span class="muted">${formatBytes(this.bytes)} of ${formatBytes(file?.size)}</span>
            </div>
          </div>`
        : nothing}
      ${this.running
        ? html`<div class="alert" data-tone="warn">${icon("info", 16)}<div class="alert__body small">The import runs in this tab. Closing or reloading it stops the import; documents already written stay.</div></div>`
        : nothing}
      ${this.problems.length
        ? html`<div class="stack" style="gap:4px">
            <div class="label">Problems (${this.problems.length}${this.problems.length >= MAX_PROBLEMS ? "+" : ""})</div>
            <div class="card" style="max-height:220px;overflow:auto">
              ${this.problems.map((p) => html`<div class="small" style="padding:4px 10px;border-bottom:1px solid var(--line)"><strong>${p.where}</strong>: <span class="muted">${p.message}</span></div>`)}
            </div>
          </div>`
        : nothing}
    </div>`;
    const footer = html`${concernSelect(this.concern, (value) => (this.concern = value))}
      <span class="spacer"></span>
      ${this.running
        ? html`<button class="btn secondary" @click=${() => this.controller?.abort()}>${icon("stop", 14)} Cancel</button>`
        : html`<button class="btn secondary" @click=${() => this.dispatchEvent(new CustomEvent("close"))}>Close</button>
            <button class="btn" ?disabled=${!file} @click=${() => this.run()}>${icon("upload", 14)} ${this.finished ? "Import again" : "Import"}</button>`}`;
    return html`<mong-drawer
      open
      .heading=${"Import documents"}
      .subheading=${this.index.name}
      .body=${body}
      .footer=${footer}
      @close=${() => !this.running && this.dispatchEvent(new CustomEvent("close"))}
    ></mong-drawer>`;
  }
}

customElements.define("mong-import-drawer", MongImportDrawer);
