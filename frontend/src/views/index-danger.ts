import { html, nothing, type PropertyValues } from "lit";
import { LightElement } from "../components/base";
import { confirmDialog } from "../components/dialog";
import { icon } from "../components/icons";
import { clearIndexFlow, dropIndexFlow, startJob } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { capabilities } from "../lib/capabilities";
import { formatNumber } from "../lib/format";
import type { SummaryIndex } from "../lib/types";

const DRY_RUN_CAP = 10_000;

type QueryEditor = HTMLElement & { value: string; getQuery(): Record<string, unknown> };

export class MongIndexDanger extends LightElement {
  static properties = {
    index: { attribute: false },
    filterText: { state: true },
    counting: { state: true },
    counted: { state: true },
    error: { state: true },
  };
  declare index: SummaryIndex;
  declare filterText: string;
  declare counting: boolean;
  declare counted: { matched: number; query: Record<string, unknown>; key: string } | null;
  declare error: string | null;

  private lastIndexId = "";

  constructor() {
    super();
    this.filterText = '{\n  "category": "obsolete"\n}';
    this.counting = false;
    this.counted = null;
    this.error = null;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("index") && this.index?.index_id !== this.lastIndexId) {
      this.lastIndexId = this.index?.index_id ?? "";
      this.counted = null;
      this.error = null;
    }
  }

  private get isVector(): boolean {
    return this.index.type === "VECTOR_SEARCH";
  }

  private readQuery(): Record<string, unknown> {
    if (this.isVector) {
      const parsed = JSON.parse(this.filterText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The filter must be a JSON object");
      return parsed;
    }
    const editor = this.querySelector<QueryEditor>("mong-query-editor");
    if (!editor) throw new Error("The query editor is not ready");
    return editor.getQuery();
  }

  private async count(): Promise<void> {
    let query: Record<string, unknown>;
    try {
      query = this.readQuery();
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    this.counting = true;
    this.error = null;
    try {
      const result = await api.deleteByQuery(this.index.index_id, {
        query,
        vector: this.isVector,
        dry_run: true,
        max_matches: DRY_RUN_CAP,
      });
      this.counted = { matched: result.matched_count, query, key: JSON.stringify(query) };
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.counting = false;
    }
  }

  private queryChanged(): void {
    if (this.counted) this.counted = null;
  }

  private async runDelete(): Promise<void> {
    const counted = this.counted;
    if (!counted) return;
    const capped = counted.matched >= DRY_RUN_CAP;
    const label = capped ? `at least ${formatNumber(counted.matched)}` : formatNumber(counted.matched);
    const ok = await confirmDialog({
      title: `Delete ${label} documents from ${this.index.name}?`,
      danger: true,
      confirmText: "Delete documents",
      message: html`<p>
          This runs on the server in passes of 10,000 until nothing matches${capped ? ", so it may delete more than the count shown" : ""}.
          You can cancel between passes. Deleted documents cannot be recovered.
        </p>
        <pre class="raw card" style="max-height:160px;overflow:auto">${JSON.stringify(counted.query, null, 2)}</pre>`,
      typeToConfirm: counted.matched > 1000 || capped ? this.index.name : undefined,
    });
    if (!ok) return;
    const job = await startJob(this.index, {
      kind: "delete_by_query",
      query: counted.query,
      vector: this.isVector,
      estimate: counted.matched,
    });
    if (job) this.counted = null;
  }

  render() {
    const index = this.index;
    const docs = index.metrics?.documents;
    const caps = capabilities(index);
    const counted = this.counted;
    return html`<section class="card danger-zone">
      <div class="card__head">
        <div>
          <h2 style="color:var(--danger)">Danger zone</h2>
          <div class="hint">These actions delete data and cannot be undone.</div>
        </div>
      </div>

      <div class="danger-row" style="flex-direction:column;align-items:stretch">
        <div>
          <h3>Delete documents matching a query</h3>
          <p class="hint">
            ${this.isVector
              ? "An MQL filter on this index's filter fields. Count first to see how many documents match."
              : "A search operator, such as text, range, or equals. Count first to see how many documents match."}
          </p>
        </div>
        ${this.isVector
          ? html`<div class="stack" style="gap:4px">
              <textarea
                rows="5"
                spellcheck="false"
                aria-label="Filter document"
                .value=${this.filterText}
                @input=${(e: InputEvent) => {
                  this.filterText = (e.target as HTMLTextAreaElement).value;
                  this.queryChanged();
                }}
              ></textarea>
              ${caps.filterFields.length
                ? html`<div class="hint">Filter fields: ${caps.filterFields.map((f) => html`<code>${f}</code> `)}</div>`
                : html`<div class="hint" style="color:var(--warn)">This index defines no filter fields, so filters cannot match anything.</div>`}
            </div>`
          : html`<mong-query-editor
              height="200"
              resize-key="delete-query"
              .mode=${"search"}
              .indexes=${[index]}
              .indexId=${index.index_id}
              .value=${'{\n  "text": { "query": "obsolete", "path": "status" }\n}'}
              @input=${() => this.queryChanged()}
              @run=${(e: Event) => {
                e.preventDefault();
                void this.count();
              }}
            ></mong-query-editor>`}
        ${this.error ? html`<div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div>` : nothing}
        <div class="row">
          <button class="btn secondary" ?disabled=${this.counting} @click=${() => this.count()}>
            ${this.counting ? "Counting…" : "Count matches"}
          </button>
          ${counted
            ? html`<span>
                  ${counted.matched === 0
                    ? "No documents match."
                    : html`<strong>${counted.matched >= DRY_RUN_CAP ? "At least " : ""}${formatNumber(counted.matched)}</strong> documents match.`}
                </span>
                ${counted.matched > 0
                  ? html`<button class="btn danger" @click=${() => this.runDelete()}>${icon("trash", 14)} Delete matching documents…</button>`
                  : nothing}`
            : html`<span class="hint">Nothing is deleted until you confirm after counting.</span>`}
        </div>
      </div>

      <div class="danger-row">
        <div>
          <h3>Delete all documents</h3>
          <p class="hint">
            Empties the index${docs != null ? ` (${formatNumber(docs)} documents)` : ""} and keeps its definition. Runs as a background job you can cancel.
          </p>
        </div>
        <button class="btn danger-outline" ?disabled=${!docs} @click=${() => clearIndexFlow(index)}>${icon("trash", 14)} Delete all documents…</button>
      </div>

      <div class="danger-row">
        <div>
          <h3>Drop index</h3>
          <p class="hint">Deletes the index, its definition, and every document. You must type the index name.</p>
        </div>
        <button class="btn danger" @click=${() => dropIndexFlow(index)}>${icon("trash", 14)} Drop index…</button>
      </div>
    </section>`;
  }
}

customElements.define("mong-index-danger", MongIndexDanger);
