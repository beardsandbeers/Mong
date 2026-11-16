import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { LightElement } from "../components/base";
import { icon } from "../components/icons";
import { toast } from "../components/toast";
import { track } from "../lib/activity";
import { api, errorMessage } from "../lib/api";
import { capabilities } from "../lib/capabilities";
import { prettyJson } from "../lib/ejson";
import { navigate } from "../lib/router";
import { appStore, indexByName, refreshSummary } from "../lib/state";
import { StoreController } from "../lib/store";
import type { IndexInfo, IndexType } from "../lib/types";

type TemplateId = "dynamic" | "static" | "vector" | "clone" | "observed";

interface Template {
  id: TemplateId;
  title: string;
  description: string;
  glyph: string;
  type?: IndexType;
  definition?: Record<string, unknown>;
  needsSource?: "any" | "search";
}

const TEMPLATES: Template[] = [
  {
    id: "dynamic",
    title: "Dynamic search",
    description: "Index every field automatically and store documents so you can browse and edit them here.",
    glyph: "sparkle",
    type: "SEARCH",
    definition: { mappings: { dynamic: true }, storedSource: true },
  },
  {
    id: "static",
    title: "Static mapping",
    description: "List exactly which fields are searchable. Smaller and faster to build than dynamic.",
    glyph: "columns",
    type: "SEARCH",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          title: { type: "string" },
          tags: { type: "token" },
          created_at: { type: "date" },
        },
      },
      storedSource: true,
    },
  },
  {
    id: "vector",
    title: "Vector search",
    description: "Nearest-neighbour search over embeddings, with optional fields to pre-filter on.",
    glyph: "database",
    type: "VECTOR_SEARCH",
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: 1536, similarity: "cosine" },
        { type: "filter", path: "category" },
      ],
    },
  },
  {
    id: "clone",
    title: "Clone an index",
    description: "Start from the definition of an existing index.",
    glyph: "copy",
    needsSource: "any",
  },
  {
    id: "observed",
    title: "From observed fields",
    description: "Turn the fields and types mongot has seen in a search index into a static mapping.",
    glyph: "tree",
    needsSource: "search",
  },
];

const GROUPS: Array<{ label: string; ids: TemplateId[] }> = [
  { label: "Search index (full-text, filters, facets)", ids: ["dynamic", "static", "observed"] },
  { label: "Vector index (semantic similarity)", ids: ["vector"] },
  { label: "Copy an existing index", ids: ["clone"] },
];

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class MongIndexCreate extends LightElement {
  static properties = {
    from: { type: String },
    template: { type: String },
    step: { state: true },
    choice: { state: true },
    source: { state: true },
    name: { state: true },
    type: { state: true },
    definitionText: { state: true },
    loadingSource: { state: true },
    sourceError: { state: true },
    creating: { state: true },
    error: { state: true },
    diagnostics: { state: true },
    reviewed: { state: true },
  };
  declare from: string;
  declare template: string;
  declare step: 1 | 2 | 3;
  declare reviewed: Record<string, unknown> | null;
  declare choice: TemplateId | null;
  declare source: string;
  declare name: string;
  declare type: IndexType;
  declare definitionText: string;
  declare loadingSource: boolean;
  declare sourceError: string | null;
  declare creating: boolean;
  declare error: string | null;
  declare diagnostics: Array<{ severity: string; message: string }>;

  private readonly app = new StoreController(this, appStore);
  private initialized = false;

  constructor() {
    super();
    this.from = "";
    this.template = "";
    this.step = 1;
    this.choice = null;
    this.source = "";
    this.name = "";
    this.type = "SEARCH";
    this.definitionText = "";
    this.loadingSource = false;
    this.sourceError = null;
    this.creating = false;
    this.error = null;
    this.diagnostics = [];
    this.reviewed = null;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!this.initialized && (changed.has("from") || changed.has("template"))) {
      if (this.from) {
        this.choice = (this.template as TemplateId) === "observed" ? "observed" : "clone";
        this.source = this.from;
      } else if (TEMPLATES.some((item) => item.id === this.template)) {
        this.choice = this.template as TemplateId;
      }
    }
  }

  protected updated(): void {
    if (!this.initialized && this.choice && this.app.value.loaded) {
      this.initialized = true;
      if (this.from) void this.next();
    }
  }

  private get selected(): Template | undefined {
    return TEMPLATES.find((item) => item.id === this.choice);
  }

  private sourceOptions(kind: "any" | "search") {
    return this.app.value.indexes.filter((index) => kind === "any" || index.type === "SEARCH");
  }

  private async next(): Promise<void> {
    const template = this.selected;
    if (!template) return;
    this.sourceError = null;
    if (!template.needsSource) {
      this.type = template.type!;
      this.definitionText = prettyJson(template.definition);
      if (!this.name) this.name = template.type === "VECTOR_SEARCH" ? "vectors" : "";
      this.step = 2;
      return;
    }
    const source = indexByName(this.source);
    if (!source) {
      this.sourceError = "Choose an index to start from.";
      return;
    }
    this.loadingSource = true;
    try {
      if (template.id === "clone") {
        this.type = source.type;
        this.definitionText = prettyJson(source.definition ?? {});
      } else {
        const observed = await api.mappings(source.index_id);
        const definition = { ...(observed.definition ?? {}) } as Record<string, unknown>;
        if (definition.storedSource === undefined && source.definition?.storedSource !== undefined) {
          definition.storedSource = source.definition.storedSource;
        }
        this.type = "SEARCH";
        this.definitionText = prettyJson(definition);
      }
      this.name = this.uniqueName(`${source.name}_${template.id === "clone" ? "copy" : "static"}`);
      this.step = 2;
    } catch (error) {
      this.sourceError = errorMessage(error);
    } finally {
      this.loadingSource = false;
    }
  }

  private uniqueName(base: string): string {
    const taken = new Set(this.app.value.indexes.map((index) => index.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }

  private nameProblem(): string | null {
    const name = this.name.trim();
    if (!name) return "A name is required.";
    if (!NAME_PATTERN.test(name)) return "Use letters, numbers, dots, dashes, and underscores; start with a letter or number.";
    if (indexByName(name)) return "An index with this name already exists.";
    return null;
  }

  private review(event?: Event): void {
    event?.preventDefault();
    const problem = this.nameProblem();
    if (problem) {
      this.error = problem;
      return;
    }
    const editor = this.querySelector<HTMLElement & { getDefinition(): Record<string, unknown> }>("mong-definition-editor");
    try {
      this.reviewed = editor ? editor.getDefinition() : JSON.parse(this.definitionText || "{}");
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    this.error = null;
    this.step = 3;
  }

  private async create(): Promise<void> {
    const definition = this.reviewed;
    if (!definition) return;
    const name = this.name.trim();
    this.creating = true;
    this.error = null;
    try {
      await track("Create index", name, () => api.createIndex(name, this.type, definition), (index) => `${index.type} index, revision ${index.desired_revision}`);
      toast(`Created ${name}. mongot is building it now.`);
      await refreshSummary({ force: true });
      navigate(["indexes", name]);
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.creating = false;
    }
  }

  private steps(): TemplateResult {
    return html`<div class="wizard-steps" aria-label="Progress">
      <span class=${this.step === 1 ? "current" : ""}><span class="n">1</span> Starting point</span>
      <span class="muted">${icon("chevronRight", 14)}</span>
      <span class=${this.step === 2 ? "current" : ""}><span class="n">2</span> Name and definition</span>
      <span class="muted">${icon("chevronRight", 14)}</span>
      <span class=${this.step === 3 ? "current" : ""}><span class="n">3</span> Review</span>
    </div>`;
  }

  private stepThree(): TemplateResult {
    const definition = this.reviewed ?? {};
    const caps = capabilities({ type: this.type, definition } as IndexInfo);
    const mappings = (definition.mappings ?? {}) as { dynamic?: unknown; fields?: Record<string, unknown> };
    const fieldCount = this.type === "VECTOR_SEARCH"
      ? caps.vectorFields.length + caps.filterFields.length
      : Object.keys(mappings.fields ?? {}).length;
    return html`<section class="card">
      <div class="card__head"><h2>Review</h2></div>
      <div class="card__body stack">
        <dl class="dl">
          <dt>Name</dt><dd><strong>${this.name.trim()}</strong></dd>
          <dt>Type</dt><dd>${this.type === "VECTOR_SEARCH" ? "Vector search" : "Search"}</dd>
          ${this.type === "VECTOR_SEARCH"
            ? html`<dt>Vector fields</dt>
                <dd>${caps.vectorFields.map((f) => html`<code>${f.path}</code> (${f.numDimensions ?? "?"} dims, ${f.similarity ?? "?"}) `)}</dd>
                <dt>Filter fields</dt><dd>${caps.filterFields.length ? caps.filterFields.join(", ") : "none"}</dd>`
            : html`<dt>Mapping</dt>
                <dd>${mappings.dynamic === true ? "Dynamic (every field)" : "Static"}${fieldCount ? ` · ${fieldCount} top-level fields listed` : ""}</dd>
                <dt>Stored source</dt>
                <dd>${caps.storedSource === "full"
                  ? "Full documents (browse, edit, and export work)"
                  : caps.storedSource === "partial"
                    ? "Some fields (browse and export work; editing is read-only)"
                    : html`<span style="color:var(--warn)">None: browse, edit, and export will not be available</span>`}</dd>`}
        </dl>
        <details>
          <summary class="small muted" style="cursor:pointer">Definition JSON</summary>
          <pre class="raw card" style="margin-top:8px">${prettyJson(definition)}</pre>
        </details>
        ${this.error ? html`<div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div>` : nothing}
      </div>
      <div class="drawer__foot">
        <button type="button" class="btn secondary" @click=${() => (this.step = 2)}>Back</button>
        <button class="btn" ?disabled=${this.creating} @click=${() => this.create()}>
          ${this.creating ? "Creating…" : "Create index"}
        </button>
      </div>
    </section>`;
  }

  private stepOne(): TemplateResult {
    const template = this.selected;
    return html`<section class="card">
      <div class="card__head"><h2>How do you want to start?</h2></div>
      <div class="card__body stack">
        ${GROUPS.map(
          (group) => html`<div class="stack" style="gap:6px">
            <div class="label">${group.label}</div>
            <div class="choice-grid">
          ${TEMPLATES.filter((item) => group.ids.includes(item.id)).map(
            (item) => html`<button
              type="button"
              class="choice"
              aria-pressed=${this.choice === item.id ? "true" : "false"}
              ?disabled=${Boolean(item.needsSource) && !this.sourceOptions(item.needsSource!).length}
              @click=${() => {
                this.choice = item.id;
                this.sourceError = null;
              }}
              @dblclick=${() => !item.needsSource && this.next()}
            >
              <strong class="row">${icon(item.glyph, 16)} ${item.title}</strong>
              <span>${item.description}</span>
            </button>`,
          )}
            </div>
          </div>`,
        )}
        ${template?.needsSource
          ? html`<div class="field" style="max-width:420px">
              <label for="source-index">${template.id === "clone" ? "Index to clone" : "Search index to read observed fields from"}</label>
              <select id="source-index" .value=${this.source} @change=${(e: Event) => (this.source = (e.target as HTMLSelectElement).value)}>
                <option value="">Choose an index…</option>
                ${this.sourceOptions(template.needsSource).map(
                  (index) => html`<option value=${index.name} ?selected=${index.name === this.source}>${index.name} (${index.type === "VECTOR_SEARCH" ? "vector" : "search"})</option>`,
                )}
              </select>
              ${template.id === "observed"
                ? html`<div class="hint">Fields only appear once documents containing them have been indexed.</div>`
                : nothing}
            </div>`
          : nothing}
        ${this.sourceError ? html`<div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.sourceError}</div></div>` : nothing}
      </div>
      <div class="drawer__foot">
        <a class="btn secondary" href="#/indexes">Cancel</a>
        <button class="btn" ?disabled=${!template || this.loadingSource} @click=${() => this.next()}>
          ${this.loadingSource ? "Loading…" : "Continue"} ${icon("chevronRight", 14)}
        </button>
      </div>
    </section>`;
  }

  private stepTwo(): TemplateResult {
    const problem = this.name ? this.nameProblem() : null;
    const errors = this.diagnostics.filter((item) => item.severity === "error");
    return html`<form class="grid" style="grid-template-columns:minmax(0,1fr) 300px;align-items:start" @submit=${(e: Event) => this.review(e)}>
      <section class="card">
        <div class="card__head">
          <h2>Name and definition</h2>
          <span class="badge">${this.type === "VECTOR_SEARCH" ? "vector index" : "search index"}</span>
        </div>
        <div class="card__body stack">
          <div class="field" style="max-width:420px">
            <label for="index-name">Name</label>
            <input
              id="index-name"
              type="text"
              autocomplete="off"
              spellcheck="false"
              .value=${this.name}
              @input=${(e: InputEvent) => {
                this.name = (e.target as HTMLInputElement).value;
                this.error = null;
              }}
            />
            ${problem ? html`<div class="hint" style="color:var(--danger)">${problem}</div>` : html`<div class="hint">Used in URLs and queries. It cannot be renamed later.</div>`}
          </div>
          <div class="field">
            <label for="index-definition">Definition</label>
            <mong-definition-editor
              id="index-definition"
              .mode=${this.type}
              .value=${this.definitionText}
              @input=${(e: Event) => (this.definitionText = (e.target as HTMLElement & { value: string }).value)}
              @diagnostics=${(e: CustomEvent) => (this.diagnostics = e.detail)}
              @run=${(e: Event) => {
                e.preventDefault();
                this.review();
              }}
            ></mong-definition-editor>
          </div>
          ${this.error ? html`<div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div>` : nothing}
        </div>
        <div class="drawer__foot">
          <button type="button" class="btn secondary" @click=${() => (this.step = 1)}>Back</button>
          <button type="submit" class="btn" ?disabled=${Boolean(problem) || errors.length > 0}>
            Review ${icon("chevronRight", 14)}
          </button>
        </div>
      </section>
      <aside class="card">
        <div class="card__head"><h3>Tips</h3></div>
        <div class="card__body stack small">
          ${this.type === "VECTOR_SEARCH"
            ? html`<p><strong>numDimensions</strong> must match your embedding model (for example 1536 or 3072).</p>
                <p><strong>similarity</strong> is <code>cosine</code>, <code>euclidean</code>, or <code>dotProduct</code>.</p>
                <p>Add <code>filter</code> fields for anything you want to pre-filter on in <code>$vectorSearch</code>.</p>`
            : html`<p><strong>storedSource: true</strong> keeps full documents in the index so you can browse, edit, and export them here.</p>
                <p><strong>dynamic: true</strong> indexes every field it sees. Switch to a static mapping once your schema settles.</p>
                <p>Press <span class="kbd">Ctrl Space</span> for completions and <span class="kbd">Ctrl Enter</span> to review.</p>`}
          <p class="muted">mongot builds the index in the background. Its status shows as building until the first pass finishes.</p>
        </div>
      </aside>
    </form>`;
  }

  render() {
    return html`<div class="page">
      <div class="page__head">
        <div class="page__title">
          <h1>New index</h1>
          ${this.steps()}
        </div>
      </div>
      ${this.step === 1 ? this.stepOne() : this.step === 2 ? this.stepTwo() : this.stepThree()}
    </div>`;
  }
}

customElements.define("mong-index-create", MongIndexCreate);
