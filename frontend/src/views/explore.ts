import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { LightElement } from "../components/base";
import type { Column } from "../components/data-table";
import { confirmDialog, openDialog } from "../components/dialog";
import "../components/explain-graph";
import "../components/explain-tree";
import "../components/facet-results";
import { originBadge } from "../components/index-origin";
import "../components/tabs";
import { icon } from "../components/icons";
import { toast } from "../components/toast";
import { FieldIndex, loadMappings } from "../editors/fields.js";
import { addResizeGrip } from "../editors/resize-grip.js";
import { startJob } from "../lib/actions";
import { track } from "../lib/activity";
import { api, errorMessage } from "../lib/api";
import { capabilities, type Capabilities } from "../lib/capabilities";
import { originLabel } from "../lib/origin";
import { download, toCsv, toNdjson } from "../lib/csv";
import { columnsFor, displayValue, getPath, prettyJson, sortValue } from "../lib/ejson";
import { addFacetToQuery, asDocument, facetFields, FACET_TEMPLATES, facetValue, matchCount, readFacets, type FacetResult } from "../lib/facets";
import { formatMs, formatNumber, pluralize, relativeTime } from "../lib/format";
import { normalizeHits, type Hit } from "../lib/hits";
import { navigate } from "../lib/router";
import { SEARCH_SNIPPETS, VECTOR_SNIPPETS, fieldQuery, type Snippet, type SnippetContext } from "../lib/snippets";
import { appStore } from "../lib/state";
import { capList, load, save } from "../lib/storage";
import { StoreController } from "../lib/store";
import type { SummaryIndex } from "../lib/types";
import { decodeQuery, encodeQuery } from "../lib/urlstate";
import "./explore-drawers";
import type { SimilarTarget } from "./explore-drawers";

const MODES = ["browse", "search", "aggregate", "vector"] as const;
type Mode = (typeof MODES)[number];
type ResultView = "table" | "tree" | "raw";

interface QueryEditor extends HTMLElement {
  value: string;
  getQuery(): Record<string, unknown>;
  indent(): boolean;
  insertText(text: string): void;
  focus(): void;
}

interface HistoryEntry {
  id: string;
  t: number;
  index: string;
  mode: Mode;
  query: string;
  hits: number;
  ms: number | null;
  ok: boolean;
}

interface SavedQuery {
  id: string;
  name: string;
  index: string;
  mode: Mode;
  query: string;
  t: number;
}

interface PageTiming {
  page: number;
  hits: number;
  /** Request to parsed response, measured in the browser. */
  e2e: number;
  /** Admin service time for the mongot call, from the API. */
  mongot: number | null;
}

interface FieldEntry {
  path: string;
  types: string[];
  origin: string;
}

interface Prefs {
  index?: string;
  batchSize: number;
  count: boolean;
  explain: string;
  view: ResultView;
}

const HISTORY_KEY = "explore.history";
const SAVED_KEY = "explore.saved";
const DRAFTS_KEY = "explore.drafts";
const PREFS_KEY = "explore.prefs";
const COLUMNS_KEY = "explore.columns";
const MAX_ROWS = 5000;
const TREE_LIMIT = 200;
const RAW_LIMIT = 500;
const BATCH_SIZES = [10, 25, 50, 100, 250, 500];
const EXPLAIN_OPTIONS = [
  { id: "", label: "No explain" },
  { id: "query_planner", label: "Explain: plan" },
  { id: "execution_stats", label: "Explain: timings" },
  { id: "all_plans_execution", label: "Explain: all plans" },
];
const MODE_LABELS: Record<Mode, string> = { browse: "Browse", search: "Search", aggregate: "Aggregate", vector: "Vector" };

/** A query handed to the next Explore instance (Find similar from an embedded view). */
let handoff: { index: string; mode: Mode; text: string } | null = null;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Pretty JSON that keeps long numeric arrays on one line. */
function queryText(value: Record<string, unknown>): string {
  const placeholders: string[] = [];
  const text = JSON.stringify(
    value,
    (_key, item) => {
      if (Array.isArray(item) && item.length > 8 && item.every((n) => typeof n === "number")) {
        placeholders.push(`[${item.join(", ")}]`);
        return `__VEC_${placeholders.length - 1}__`;
      }
      return item;
    },
    2,
  );
  return text.replace(/"__VEC_(\d+)__"/g, (_m, i) => placeholders[Number(i)]);
}

function oneLine(text: string, max = 90): string {
  const compact = text.replace(/\s+/g, " ").replace(/\[(-?\d[^\]]{60,})\]/g, "[…]");
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function countOf(metadata: Record<string, unknown> | null): { value: number; exact: boolean } | null {
  const count = metadata?.count as Record<string, unknown> | undefined;
  if (!count) return null;
  if (typeof count.total === "number") return { value: count.total, exact: true };
  if (typeof count.lowerBound === "number") return { value: count.lowerBound, exact: false };
  return null;
}

/** Browse on a MongoDB-managed index reads the collection instead of searching the index. */
function browsesCollection(index: SummaryIndex, mode: Mode): boolean {
  return mode === "browse" && capabilities(index).readOnly;
}

export class MongExplore extends LightElement {
  static properties = {
    params: { attribute: false },
    embedded: { type: Boolean },
    indexName: { state: true },
    mode: { state: true },
    text: { state: true },
    prefs: { state: true },
    fields: { state: true },
    fieldFilter: { state: true },
    running: { state: true },
    error: { state: true },
    hits: { state: true },
    metadata: { state: true },
    explainOut: { state: true },
    explainView: { state: true },
    cursorId: { state: true },
    hasMore: { state: true },
    pageNo: { state: true },
    timings: { state: true },
    loadingMore: { state: true },
    ranQuery: { state: true },
    selected: { state: true },
    openHit: { state: true },
    drawer: { state: true },
    menu: { state: true },
    urlNote: { state: true },
    history: { state: true },
    saved: { state: true },
    railOpen: { state: true },
    columnPrefs: { state: true },
  };
  declare params: URLSearchParams;
  declare embedded: boolean;
  declare indexName: string;
  declare mode: Mode;
  declare text: string;
  declare prefs: Prefs;
  declare fields: FieldEntry[];
  declare fieldFilter: string;
  declare running: boolean;
  declare error: string | null;
  declare hits: Hit[];
  declare metadata: Record<string, unknown> | null;
  declare explainOut: Record<string, unknown> | null;
  declare explainView: "graph" | "tree" | "raw";
  declare cursorId: string | null;
  declare hasMore: boolean;
  declare pageNo: number;
  declare timings: PageTiming[];
  declare loadingMore: boolean;
  declare ranQuery: { index: SummaryIndex; mode: Mode; query: Record<string, unknown> } | null;
  declare selected: Set<string>;
  declare openHit: Hit | null;
  declare drawer: "upsert" | "import" | null;
  declare menu: string | null;
  declare urlNote: string | null;
  declare history: HistoryEntry[];
  declare saved: SavedQuery[];
  declare railOpen: boolean;
  declare columnPrefs: Record<string, { pinned: string[]; hidden: string[] }>;

  private readonly store = new StoreController(this, appStore);
  private lastParams: string | null = null;
  private fieldsKey = "";
  private pendingRun = false;
  private pendingField: string | null = null;
  private aggregateResult: { facets: FacetResult[]; text: string } | null = null;
  private controller: AbortController | null = null;
  private drafts: Record<string, string> = load(DRAFTS_KEY, {});
  private draftTimer = 0;
  private readonly onDocClick = (event: MouseEvent) => {
    if (!this.menu) return;
    if (!(event.target as HTMLElement).closest?.("[data-menu]")) this.menu = null;
  };
  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === `mong.${HISTORY_KEY}`) this.history = load<HistoryEntry[]>(HISTORY_KEY, []);
    if (event.key === `mong.${SAVED_KEY}`) this.saved = load<SavedQuery[]>(SAVED_KEY, []);
  };

  constructor() {
    super();
    this.params = new URLSearchParams();
    this.embedded = false;
    this.indexName = "";
    this.mode = "browse";
    this.text = "";
    this.prefs = { batchSize: 25, count: false, explain: "", view: "table", ...load<Partial<Prefs>>(PREFS_KEY, {}) };
    this.fields = [];
    this.fieldFilter = "";
    this.running = false;
    this.error = null;
    this.hits = [];
    this.metadata = null;
    this.explainOut = null;
    this.explainView = "graph";
    this.cursorId = null;
    this.hasMore = false;
    this.pageNo = 1;
    this.timings = [];
    this.loadingMore = false;
    this.ranQuery = null;
    this.selected = new Set();
    this.openHit = null;
    this.drawer = null;
    this.menu = null;
    this.urlNote = null;
    this.history = load<HistoryEntry[]>(HISTORY_KEY, []);
    this.saved = load<SavedQuery[]>(SAVED_KEY, []);
    this.railOpen = false;
    this.columnPrefs = load(COLUMNS_KEY, {});
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocClick);
    window.addEventListener("storage", this.onStorage);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this.onDocClick);
    window.removeEventListener("storage", this.onStorage);
    this.cancel();
    this.releaseCursor();
    this.flushDraft();
  }

  // ---------------------------------------------------------------------------
  // Index, mode, and query state
  // ---------------------------------------------------------------------------

  private get indexes(): SummaryIndex[] {
    return this.store.value.indexes;
  }

  private get index(): SummaryIndex | undefined {
    return this.indexes.find((index) => index.name === this.indexName);
  }

  private get caps(): Capabilities {
    return capabilities(this.index);
  }

  private get editor(): QueryEditor | null {
    return this.querySelector<QueryEditor>("mong-query-editor");
  }

  private defaultMode(caps: Capabilities): Mode {
    if (caps.isVector) return "vector";
    return caps.browse ? "browse" : "search";
  }

  private modeAllowed(mode: Mode, caps = this.caps): boolean {
    return mode === "browse" ? caps.browse : mode === "vector" ? caps.vector : caps.search;
  }

  private snippetContext(): SnippetContext {
    const byType = (type: string) => this.fields.find((field) => field.types.includes(type))?.path;
    const first = this.fields.find((field) => field.path !== "_id")?.path ?? "_id";
    return {
      field: first,
      textField: byType("string") ?? byType("autocomplete") ?? first,
      numberField: byType("number") ?? first,
      dateField: byType("date") ?? first,
      caps: this.caps,
    };
  }

  private defaultText(mode: Mode): string {
    if (mode === "browse") return "";
    if (mode === "aggregate") return prettyJson({ facet: { facets: {} } });
    const snippet = mode === "vector" ? VECTOR_SNIPPETS[0] : SEARCH_SNIPPETS[0];
    return queryText(snippet.build(this.snippetContext()));
  }

  private draftKey(index = this.indexName, mode = this.mode): string {
    return `${index}|${mode}`;
  }

  private flushDraft(): void {
    if (!this.draftTimer) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = 0;
    this.saveDraft();
  }

  private saveDraft(): void {
    if (!this.indexName || this.mode === "browse") return;
    const entries = Object.entries({ ...this.drafts, [this.draftKey()]: this.text.slice(0, 50_000) });
    this.drafts = Object.fromEntries(entries.slice(-40));
    save(DRAFTS_KEY, this.drafts);
  }

  private onEditorInput(): void {
    this.text = this.editor?.value ?? "";
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      this.draftTimer = 0;
      this.saveDraft();
    }, 400);
  }

  /** Switch index and/or mode, keeping a draft per (index, mode). */
  private select(indexName: string, mode?: Mode, text?: string): void {
    this.flushDraft();
    this.pendingRun = false;
    this.pendingField = null;
    this.menu = null;
    const index = this.indexes.find((item) => item.name === indexName);
    const caps = capabilities(index);
    const indexChanged = indexName !== this.indexName;
    let next = mode ?? (indexChanged && this.mode !== "aggregate" ? this.defaultMode(caps) : this.mode);
    if (index && !this.modeAllowed(next, caps)) next = this.defaultMode(caps);
    const aggregateChanged = this.mode !== next && (this.mode === "aggregate" || next === "aggregate");
    if (indexChanged || aggregateChanged) {
      this.cancel();
      this.releaseCursor();
      this.clearResults();
      this.drawer = null;
    }
    if (indexChanged) {
      this.fields = [];
      this.fieldsKey = "";
    }
    this.indexName = indexName;
    this.mode = next;
    this.text = text ?? this.drafts[this.draftKey(indexName, next)] ?? (this.fields.length || next !== "search" ? this.defaultText(next) : "");
    if (!this.embedded && indexName) {
      this.prefs = { ...this.prefs, index: indexName };
      save(PREFS_KEY, this.prefs);
    }
  }

  private setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    this.prefs = { ...this.prefs, [key]: value };
    save(PREFS_KEY, this.prefs);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("params")) {
      const key = this.params.toString();
      if (key !== this.lastParams) {
        this.lastParams = key;
        void this.applyParams();
      }
    }
    const indexes = this.indexes;
    if (!this.indexName && indexes.length) {
      const preferred = this.prefs.index && indexes.some((i) => i.name === this.prefs.index) ? this.prefs.index : indexes[0].name;
      this.select(preferred, MODES.find((mode) => mode === this.params.get("mode")));
      this.pendingRun = this.mode === "browse";
    }
    const index = this.index;
    if (index) {
      const key = `${index.index_id}:${index.generation_id ?? ""}:${index.desired_revision ?? ""}`;
      if (key !== this.fieldsKey) {
        this.fieldsKey = key;
        void this.loadFields(index, key);
      }
      if (!this.modeAllowed(this.mode)) this.select(this.indexName, this.defaultMode(this.caps));
    }
  }

  protected updated(changed: PropertyValues): void {
    const pane = this.explainOut && this.querySelector<HTMLElement>(".explain-pane");
    if (pane && !pane.nextElementSibling) {
      addResizeGrip(pane, {
        height: Math.round(window.innerHeight * 0.72),
        minHeight: 168,
        storageKey: "explain",
        label: "Resize explain panel",
        fitHeight: () => {
          const height = pane.style.height;
          pane.style.height = "auto";
          const contentHeight = pane.scrollHeight;
          pane.style.height = height;
          return contentHeight;
        },
      });
    }
    if (pane && changed.has("explainView")) pane.scrollTo(0, 0);
    if (this.pendingRun && this.index && !this.running && (this.mode === "browse" || this.editor)) {
      this.pendingRun = false;
      void this.run();
    }
  }

  private async applyParams(): Promise<void> {
    if (handoff && (!this.params.get("index") || handoff.index === this.params.get("index"))) {
      const pending = handoff;
      handoff = null;
      this.select(pending.index, pending.mode, pending.text);
      this.pendingRun = true;
      return;
    }
    const name = this.params.get("index") ?? "";
    const mode = MODES.find((candidate) => candidate === this.params.get("mode"));
    const encoded = this.params.get("q");
    const field = this.params.get("field");
    let text: string | undefined;
    if (encoded) {
      const params = this.params.toString();
      const decoded = await decodeQuery(encoded);
      if (!this.isConnected || this.params.toString() !== params) return;
      if (decoded == null) toast("The query in this link could not be read.", "warn");
      else text = decoded;
    }
    if (name || mode || text) {
      const target = name || this.indexName || this.prefs.index || this.indexes[0]?.name || "";
      const resolvedMode = field ? (capabilities(this.indexes.find((i) => i.name === target)).isVector ? undefined : "search") : (mode ?? undefined);
      if (target === this.indexName && resolvedMode === this.mode && text === undefined && !field) return;
      this.select(target, resolvedMode, text);
      this.pendingField = field;
      if (field) this.applyField();
      this.pendingRun = text !== undefined || (!field && this.mode === "browse");
    }
  }

  private applyField(): void {
    const path = this.pendingField;
    if (!path || !this.fields.length) return;
    this.pendingField = null;
    const entry = this.fields.find((field) => field.path === path);
    this.text = queryText(fieldQuery(path, entry?.types ?? []));
  }

  private async loadFields(index: SummaryIndex, key: string): Promise<void> {
    try {
      const compiled = FieldIndex.compile(index.definition, index.type);
      if (index.type !== "VECTOR_SEARCH") {
        const observed = await loadMappings(index);
        if (observed) compiled.applyObserved(observed);
      }
      if (this.fieldsKey !== key) return;
      const suggested = compiled.suggest(null) as Array<{ path: string; rawTypes: Set<string>; origin: string }>;
      this.fields = suggested.map((field) => ({ path: field.path, types: [...field.rawTypes], origin: field.origin }));
    } catch {
      if (this.fieldsKey !== key) return;
      this.fields = [];
    }
    if (this.pendingField) this.applyField();
    else if (this.mode === "search" && !this.text && !this.drafts[this.draftKey()]) this.text = this.defaultText("search");
  }

  // ---------------------------------------------------------------------------
  // Running queries
  // ---------------------------------------------------------------------------

  private clearResults(): void {
    this.hits = [];
    this.metadata = null;
    this.explainOut = null;
    this.cursorId = null;
    this.hasMore = false;
    this.timings = [];
    this.error = null;
    this.selected = new Set();
    this.ranQuery = null;
    this.aggregateResult = null;
    this.openHit = null;
  }

  private abortRun(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private releaseCursor(): void {
    if (this.cursorId && this.hasMore) {
      const cursor = this.cursorId;
      api.killCursor(cursor).catch(() => undefined);
    }
    this.cursorId = null;
    this.hasMore = false;
  }

  private buildQuery(): Record<string, unknown> {
    const caps = this.caps;
    if (this.mode === "browse") {
      const query: Record<string, unknown> = { exists: { path: "_id" }, returnStoredSource: true };
      if (this.prefs.count) query.count = { type: "lowerBound" };
      return query;
    }
    const editor = this.editor;
    const query = editor ? editor.getQuery() : (JSON.parse(this.text || "{}") as Record<string, unknown>);
    if (this.mode === "aggregate") {
      const facets = asDocument(asDocument(query.facet)?.facets);
      if (facets && Object.keys(facets).length === 0) throw new Error("Add a facet before running this query.");
    }
    if (this.mode === "search") {
      // mongod looks up full documents itself, which stored source may only cover in part.
      if (!caps.readOnly && caps.storedSource !== "none" && query.returnStoredSource === undefined) query.returnStoredSource = true;
    }
    if ((this.mode === "search" || this.mode === "aggregate") && this.prefs.count && query.count === undefined) {
      query.count = { type: "lowerBound" };
    }
    return query;
  }

  async runMeta(): Promise<void> {
    const index = this.index;
    const mode = this.mode;
    if (!index || this.running || (mode !== "search" && mode !== "aggregate")) return;
    let query: Record<string, unknown>;
    try {
      query = this.buildQuery();
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    this.flushDraft();
    this.cancel();
    this.releaseCursor();
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    this.error = null;
    const text = this.text;
    const started = performance.now();
    try {
      const page = await api.searchMeta(
        index.index_id,
        { query, explain: this.prefs.explain || undefined },
        controller.signal,
      );
      if (this.controller !== controller) return;
      const e2e = performance.now() - started;
      this.hits = [];
      this.metadata = page.metadata;
      this.explainOut = page.explain;
      this.explainVerbosity = page.explain_verbosity ?? this.prefs.explain;
      this.cursorId = null;
      this.hasMore = false;
      this.pageNo = 1;
      this.timings = [{ page: 1, hits: 0, e2e, mongot: page.latency_ms ?? null }];
      this.selected = new Set();
      this.ranQuery = { index, mode, query };
      if (mode === "aggregate") {
        this.aggregateResult = { facets: readFacets(page.metadata, query), text };
        void this.syncUrl(index.name, mode, text);
      }
      this.remember({ index: index.name, mode, query: text, hits: 0, ms: page.latency_ms ?? e2e, ok: true });
    } catch (error) {
      if (this.controller !== controller || (error as Error)?.name === "AbortError") return;
      this.clearResults();
      this.error = errorMessage(error);
      this.remember({ index: index.name, mode, query: text, hits: 0, ms: null, ok: false });
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.running = false;
      }
    }
  }

  async run(): Promise<void> {
    if (this.mode === "aggregate") return this.runMeta();
    const index = this.index;
    if (!index || this.running) return;
    let query: Record<string, unknown>;
    try {
      query = this.buildQuery();
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    this.flushDraft();
    this.cancel();
    this.releaseCursor();
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    this.error = null;
    const mode = this.mode;
    const text = mode === "browse" ? "" : this.text;
    const started = performance.now();
    try {
      const page = browsesCollection(index, mode)
        ? await api.browse(index.index_id, { batch_size: this.prefs.batchSize, count: this.prefs.count }, controller.signal)
        : await api.search(
          index.index_id,
          {
            query,
            vector: mode === "vector",
            batch_size: this.prefs.batchSize,
            explain: this.prefs.explain || undefined,
          },
          controller.signal,
        );
      if (this.controller !== controller) {
        if (page.cursor_id && page.has_more) api.killCursor(page.cursor_id).catch(() => undefined);
        return;
      }
      const e2e = performance.now() - started;
      this.hits = normalizeHits(page.results);
      this.metadata = page.metadata;
      this.explainOut = page.explain;
      this.explainVerbosity = page.explain_verbosity ?? this.prefs.explain;
      this.cursorId = page.cursor_id;
      this.hasMore = page.has_more;
      this.pageNo = page.page || 1;
      this.timings = [{ page: this.pageNo, hits: this.hits.length, e2e, mongot: page.latency_ms ?? null }];
      this.selected = new Set();
      this.ranQuery = { index, mode, query };
      this.remember({ index: index.name, mode, query: text, hits: this.hits.length, ms: page.latency_ms ?? e2e, ok: true });
      void this.syncUrl(index.name, mode, text);
    } catch (error) {
      if (this.controller !== controller || (error as Error)?.name === "AbortError") return;
      this.clearResults();
      this.error = errorMessage(error);
      this.remember({ index: index.name, mode, query: text, hits: 0, ms: null, ok: false });
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.running = false;
      }
    }
  }

  private cancel(): void {
    this.abortRun();
    this.running = false;
    this.loadingMore = false;
  }

  private async loadMore(): Promise<void> {
    const index = this.ranQuery?.index;
    if (!index || !this.cursorId || !this.hasMore || this.loadingMore) return;
    const controller = new AbortController();
    this.controller = controller;
    this.loadingMore = true;
    const started = performance.now();
    try {
      const page = await api.more(this.cursorId, index.index_id, this.prefs.batchSize, this.pageNo + 1, controller.signal);
      if (this.controller !== controller) return;
      const e2e = performance.now() - started;
      this.hits = [...this.hits, ...normalizeHits(page.results, this.hits.length)];
      this.cursorId = page.cursor_id ?? this.cursorId;
      this.hasMore = page.has_more;
      this.pageNo = page.page || this.pageNo + 1;
      this.timings = [...this.timings, { page: this.pageNo, hits: page.results.length, e2e, mongot: page.latency_ms ?? null }];
      if (page.metadata) this.metadata = page.metadata;
      // Execution-level explain is cumulative, so each GetMore carries the newer document.
      if (page.explain) this.explainOut = page.explain;
      if (this.hits.length >= MAX_ROWS) {
        this.releaseCursor();
        toast(`Stopped at ${formatNumber(MAX_ROWS)} rows. Use Export → All matches for more.`, "warn");
      }
    } catch (error) {
      if (this.controller === controller && (error as Error)?.name !== "AbortError") {
        toast(errorMessage(error), "error");
        this.hasMore = false;
      }
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.loadingMore = false;
      }
    }
  }

  private async syncUrl(index: string, mode: Mode, text: string): Promise<void> {
    if (this.embedded) return;
    const ranQuery = this.ranQuery;
    const encoded = mode === "browse" ? ({ ok: true, value: "" } as const) : await encodeQuery(text);
    if (!this.isConnected || this.indexName !== index || this.mode !== mode || this.ranQuery !== ranQuery) return;
    this.urlNote = encoded.ok ? null : encoded.reason;
    const params = { index, mode, q: encoded.ok ? encoded.value : "" };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
    this.lastParams = search.toString();
    navigate("explore", params, { replace: true });
  }

  // ---------------------------------------------------------------------------
  // History and saved queries
  // ---------------------------------------------------------------------------

  /** Record a run. Other tabs write the same list, so start from what is stored. */
  private remember(entry: Omit<HistoryEntry, "id" | "t">): void {
    const stored = load<HistoryEntry[]>(HISTORY_KEY, []);
    const rest = stored.filter((item) => !(item.index === entry.index && item.mode === entry.mode && item.query === entry.query));
    const next: HistoryEntry = { ...entry, id: newId(), t: Date.now() / 1000 };
    this.history = capList([next, ...rest], 50, 300_000);
    save(HISTORY_KEY, this.history);
  }

  private restore(item: { index: string; mode: Mode; query: string }, run = false): void {
    if (!this.indexes.some((index) => index.name === item.index)) {
      toast(`Index ${item.index} no longer exists.`, "warn");
      return;
    }
    this.select(item.index, item.mode, item.query);
    if (run) this.pendingRun = true;
  }

  private async saveQuery(): Promise<void> {
    if (!this.index) return;
    const suggestion = this.mode === "browse" ? `Browse ${this.indexName}` : oneLine(this.text, 40);
    const name = await openDialog<string>((close) => {
      let value = suggestion;
      return html`<form
        @submit=${(event: Event) => {
          event.preventDefault();
          if (value.trim()) close(value.trim());
        }}
      >
        <div class="dialog__head"><h2>Save query</h2></div>
        <div class="dialog__body">
          <div class="field">
            <label for="save-query-name">Name</label>
            <input id="save-query-name" type="text" autocomplete="off" .value=${suggestion} @input=${(e: Event) => (value = (e.target as HTMLInputElement).value)} />
          </div>
          <p class="hint">Saved in this browser for ${this.indexName}.</p>
        </div>
        <div class="dialog__foot">
          <button type="button" class="btn secondary" @click=${() => close(null)}>Cancel</button>
          <button type="submit" class="btn">Save</button>
        </div>
      </form>`;
    });
    if (!name) return;
    const entry: SavedQuery = { id: newId(), name, index: this.indexName, mode: this.mode, query: this.text, t: Date.now() / 1000 };
    this.saved = capList([entry, ...load<SavedQuery[]>(SAVED_KEY, [])], 100, 500_000);
    if (!save(SAVED_KEY, this.saved)) toast("Browser storage is full; the query was not saved.", "error");
    else toast(`Saved “${name}”.`);
  }

  private removeSaved(id: string): void {
    this.saved = load<SavedQuery[]>(SAVED_KEY, []).filter((item) => item.id !== id);
    save(SAVED_KEY, this.saved);
  }

  // ---------------------------------------------------------------------------
  // Editor helpers
  // ---------------------------------------------------------------------------

  private applySnippet(snippet: Snippet): void {
    this.menu = null;
    this.text = queryText(snippet.build(this.snippetContext()));
    this.saveDraft();
    requestAnimationFrame(() => this.editor?.focus());
  }

  private insertField(field: FieldEntry): void {
    if (this.mode === "browse") {
      this.select(this.indexName, "search", queryText(fieldQuery(field.path, field.types)));
      return;
    }
    const editor = this.editor;
    if (!editor) return;
    editor.insertText(JSON.stringify(field.path));
    this.text = editor.value;
  }

  private findSimilar(target: SimilarTarget): void {
    const text = queryText({ path: target.path, queryVector: target.vector, numCandidates: 100, limit: 10 });
    this.openHit = null;
    if (this.embedded && target.index.name !== this.indexName) {
      handoff = { index: target.index.name, mode: "vector", text };
      navigate("explore", { index: target.index.name, mode: "vector" });
      return;
    }
    this.select(target.index.name, "vector", text);
    this.pendingRun = true;
  }

  // ---------------------------------------------------------------------------
  // Results actions
  // ---------------------------------------------------------------------------

  private exportLoaded(format: "csv" | "ndjson"): void {
    this.menu = null;
    const docs = this.hits.map((hit) => hit.doc);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `${this.ranQuery?.index.name ?? "results"}-${stamp}`;
    if (format === "csv") download(`${name}.csv`, toCsv(docs), "text/csv");
    else download(`${name}.ndjson`, toNdjson(docs), "application/x-ndjson");
  }

  private async exportAll(format: "csv" | "ndjson"): Promise<void> {
    this.menu = null;
    const ran = this.ranQuery;
    if (!ran) return;
    const query = { ...ran.query };
    delete query.count;
    const count = countOf(this.metadata);
    await startJob(ran.index, {
      kind: "export",
      format,
      query: browsesCollection(ran.index, ran.mode) ? null : query,
      vector: ran.mode === "vector",
      estimate: count?.value || undefined,
    });
  }

  private async deleteSelected(): Promise<void> {
    const index = this.ranQuery?.index;
    if (!index) return;
    const hits = this.hits.filter((hit) => this.selected.has(hit.key) && hit.id !== undefined);
    if (!hits.length) return;
    const ok = await confirmDialog({
      title: `Delete ${pluralize(hits.length, "document")}?`,
      message: html`<p>Deletes the selected ${pluralize(hits.length, "document")} from <strong>${index.name}</strong> by _id. This cannot be undone.</p>`,
      confirmText: "Delete",
      danger: true,
      typeToConfirm: hits.length > 100 ? String(hits.length) : undefined,
    });
    if (!ok) return;
    try {
      await track("Delete documents", index.name, () => api.deleteDocuments(index.index_id, hits.map((hit) => hit.id)), () => pluralize(hits.length, "document"));
      const keys = new Set(hits.map((hit) => hit.key));
      this.hits = this.hits.filter((hit) => !keys.has(hit.key));
      this.selected = new Set();
      toast(`Deleted ${pluralize(hits.length, "document")}.`);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  private onSaved(event: CustomEvent<{ hit: Hit; doc: Record<string, unknown> }>): void {
    const { hit, doc } = event.detail;
    const updated: Hit = { ...hit, doc, raw: { ...hit.raw, storedSource: doc } };
    this.hits = this.hits.map((item) => (item.key === hit.key ? updated : item));
    this.openHit = updated;
  }

  private onDeleted(event: CustomEvent<Hit>): void {
    this.hits = this.hits.filter((item) => item.key !== event.detail.key);
    const next = new Set(this.selected);
    next.delete(event.detail.key);
    this.selected = next;
    this.openHit = null;
  }

  // ---------------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------------

  private get columnPref(): { pinned: string[]; hidden: string[] } {
    return this.columnPrefs[this.ranQuery?.index.name ?? this.indexName] ?? { pinned: ["_id"], hidden: [] };
  }

  private setColumnPref(pref: { pinned: string[]; hidden: string[] }): void {
    const key = this.ranQuery?.index.name ?? this.indexName;
    this.columnPrefs = { ...this.columnPrefs, [key]: pref };
    save(COLUMNS_KEY, this.columnPrefs);
  }

  private allColumns(): string[] {
    return columnsFor(
      this.hits.map((hit) => hit.doc),
      200,
    );
  }

  private tableColumns(): Column<Hit>[] {
    const pref = this.columnPref;
    const hidden = new Set(pref.hidden);
    const all = this.allColumns().filter((column) => !hidden.has(column));
    const pinned = pref.pinned.filter((column) => all.includes(column));
    const rest = all.filter((column) => !pinned.includes(column)).slice(0, 40);
    const columns: Column<Hit>[] = [];
    const scores = new Set(this.hits.map((hit) => hit.score).filter((score) => score != null));
    if (scores.size > 1 || (scores.size === 1 && this.ranQuery?.mode !== "browse")) {
      columns.push({
        key: "$score",
        label: "Score",
        align: "right",
        width: "86px",
        render: (hit) => (hit.score == null ? "" : hit.score.toFixed(4)),
        sortValue: (hit) => hit.score,
      });
    }
    [...pinned, ...rest].forEach((path, i) => {
      columns.push({
        key: path,
        label: path,
        pinned: i === 0 && pinned.length > 0,
        truncate: true,
        render: (hit) => {
          const value = getPath(hit.doc, path);
          return html`<span class=${typeof value === "number" ? "num" : ""}>${displayValue(value, 80)}</span>`;
        },
        title: (hit) => displayValue(getPath(hit.doc, path), 400),
        sortValue: (hit) => sortValue(getPath(hit.doc, path)),
      });
    });
    return columns;
  }

  private togglePin(column: string): void {
    const pref = this.columnPref;
    const pinned = pref.pinned.includes(column) ? pref.pinned.filter((c) => c !== column) : [...pref.pinned, column];
    this.setColumnPref({ ...pref, pinned });
  }

  private toggleHidden(column: string): void {
    const pref = this.columnPref;
    const hidden = pref.hidden.includes(column) ? pref.hidden.filter((c) => c !== column) : [...pref.hidden, column];
    this.setColumnPref({ ...pref, hidden });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private toggleMenu(name: string, event: Event): void {
    event.stopPropagation();
    this.menu = this.menu === name ? null : name;
  }

  private indexOptions(): TemplateResult {
    const option = (index: SummaryIndex) =>
      html`<option value=${index.name} ?selected=${index.name === this.indexName}>${originLabel(index)} · ${index.name}</option>`;
    const coupled = this.indexes.filter((index) => originLabel(index) === "Coupled");
    if (!coupled.length) return html`${this.indexes.map(option)}`;
    const standalone = this.indexes.filter((index) => originLabel(index) === "Standalone");
    return html`${standalone.length ? html`<optgroup label="Standalone">${standalone.map(option)}</optgroup>` : nothing}
      <optgroup label="Coupled">${coupled.map(option)}</optgroup>`;
  }

  private renderRail(caps: Capabilities): TemplateResult {
    const filter = this.fieldFilter.trim().toLowerCase();
    const fields = this.fields.filter((field) => !filter || field.path.toLowerCase().includes(filter));
    const history = this.history.filter((item) => !this.embedded || item.index === this.indexName).slice(0, 25);
    const saved = this.saved.filter((item) => !this.embedded || item.index === this.indexName);
    return html`<aside class="rail">
      ${this.embedded
        ? nothing
        : html`<div class="card">
            <div class="card__body stack" style="gap:8px">
              <label class="label row" for="explore-index">Index ${this.index ? originBadge(this.index) : nothing}</label>
              <select id="explore-index" .value=${this.indexName} @change=${(e: Event) => this.select((e.target as HTMLSelectElement).value)}>
                ${this.indexOptions()}
              </select>
              ${this.index
                ? html`<div class="row small muted" style="gap:6px;flex-wrap:wrap">
                    <span class="badge">${caps.isVector ? "Vector" : "Search"}</span>
                    ${caps.readOnly ? html`<span class="badge" title="MongoDB manages this index; Mong only reads it">MongoDB</span>` : nothing}
                    <span>${formatNumber(this.index.metrics?.documents ?? null)} docs</span>
                    <span>· stored source: ${caps.storedSource}</span>
                  </div>`
                : nothing}
            </div>
          </div>`}
      <button class="btn secondary rail__toggle" aria-expanded=${this.railOpen} @click=${() => (this.railOpen = !this.railOpen)}>
        ${icon("chevronDown", 14)} Fields, saved queries &amp; history
      </button>
      <div class="rail__tools">
        <div class="card">
          <div class="card__head"><h3>Fields</h3><span class="hint">${this.fields.length}</span></div>
          ${this.fields.some((field) => field.origin === "sampled")
            ? html`<p class="hint">Dynamic field suggestions come from a document sample and may be incomplete.</p>`
            : nothing}
          <div class="card__body stack" style="gap:6px">
            ${this.fields.length > 8
              ? html`<input type="search" placeholder="Filter fields" .value=${this.fieldFilter} @input=${(e: Event) => (this.fieldFilter = (e.target as HTMLInputElement).value)} />`
              : nothing}
            <div class="list" style="max-height:280px;overflow:auto">
              ${fields.length
                ? fields.map(
                    (field) => html`<button title="Insert ${field.path} into the query (${field.origin})" @click=${() => this.insertField(field)}>
                      <span class="grow mono small">${field.path}</span>
                      <span class="muted small">${field.types.join(", ")}</span>
                    </button>`,
                  )
                : html`<span class="hint">${this.index ? "No indexed fields yet." : "Pick an index."}</span>`}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Saved</h3></div>
          <div class="card__body">
            <div class="list">
              ${saved.length
                ? saved.map(
                    (item) => html`<button title=${oneLine(item.query, 300)} @click=${() => this.restore(item)}>
                      ${icon("star", 12)}
                      <span class="grow">${item.name}</span>
                      ${this.embedded ? nothing : html`<span class="muted small">${item.index}</span>`}
                      <span
                        class="muted"
                        role="button"
                        aria-label="Remove saved query"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          this.removeSaved(item.id);
                        }}
                      >${icon("x", 12)}</span>
                    </button>`,
                  )
                : html`<span class="hint">Save a query with the star button.</span>`}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>History</h3></div>
          <div class="card__body">
            <div class="list">
              ${history.length
                ? history.map(
                    (item) => html`<button title="${item.index} · ${MODE_LABELS[item.mode]}\n${oneLine(item.query, 400)}" @click=${() => this.restore(item)}>
                      <span class="dot" data-tone=${item.ok ? "ok" : "danger"}></span>
                      <span class="grow mono small">${item.mode === "browse" ? "Browse" : oneLine(item.query, 60)}</span>
                      <span class="muted small">${relativeTime(item.t)}</span>
                    </button>`,
                  )
                : html`<span class="hint">Queries you run appear here.</span>`}
            </div>
          </div>
        </div>
      </div>
    </aside>`;
  }

  private renderEditorCard(caps: Capabilities): TemplateResult {
    const snippets = this.mode === "vector" ? VECTOR_SNIPPETS : SEARCH_SNIPPETS;
    const aggregate = this.mode === "aggregate";
    const tabs = MODES.map((mode) => {
      const disabled = !this.modeAllowed(mode, caps);
      return {
        id: mode,
        label: MODE_LABELS[mode],
        disabled,
        title: disabled ? (mode === "aggregate" ? "Aggregate requires a search index." : caps.reasons[mode]) : undefined,
      };
    });
    return html`<div class="card">
      <div class="card__head query-toolbar">
        <mong-tabs class="explore-mode-tabs" label="Query mode" .tabs=${tabs} .active=${this.mode}
          @tab-change=${(event: CustomEvent<Mode>) => this.select(this.indexName, event.detail)}></mong-tabs>
        <span class="spacer"></span>
        ${this.mode === "search" || this.mode === "vector"
          ? html`<span data-menu>
                <button class="btn ghost sm" aria-haspopup="menu" aria-expanded=${this.menu === "snippets"} @click=${(e: Event) => this.toggleMenu("snippets", e)}>
                  ${icon("code", 14)} Snippets ${icon("chevronDown", 12)}
                </button>
                ${this.menu === "snippets"
                  ? html`<div class="popover menu query-menu query-menu--snippets" role="menu">
                      ${snippets.map(
                        (snippet) => html`<button role="menuitem" @click=${() => this.applySnippet(snippet)} style="flex-direction:column;align-items:flex-start;gap:2px">
                          <strong>${snippet.label}</strong><span class="muted small">${snippet.description}</span>
                        </button>`,
                      )}
                    </div>`
                  : nothing}
              </span>`
          : nothing}
        ${this.mode !== "browse"
          ? html`<button class="btn ghost sm" title="Indent (Alt+Shift+F)" @click=${() => this.editor?.indent()}>${icon("format", 14)} Format</button>`
          : nothing}
        <button class="btn ghost sm" title="Save this query" ?disabled=${!this.index} @click=${() => this.saveQuery()}>${icon("star", 14)} Save</button>
      </div>
      <div class="card__body stack">
        ${aggregate ? this.renderFacetPicker() : nothing}
        ${this.mode === "browse"
          ? html`<p class="hint" style="margin:0">
              Every document in ${this.indexName || "the index"}, in index order, with stored source. Switch to Search to filter.
            </p>`
          : html`<mong-query-editor
              resize-key="explore"
              .value=${this.text}
              .mode=${this.mode === "vector" ? "vector" : "search"}
              .indexes=${this.indexes}
              .indexId=${this.index?.index_id ?? ""}
              @input=${() => this.onEditorInput()}
              @run=${() => this.run()}
              @index-change=${(e: CustomEvent<{ name: string }>) => {
                if (!this.embedded) this.select(e.detail.name, undefined, this.editor?.value);
              }}
            ></mong-query-editor>`}
        <div class="row" style="flex-wrap:wrap;gap:12px">
          ${aggregate ? nothing : html`<label class="row small">
            Batch
            <select .value=${String(this.prefs.batchSize)} @change=${(e: Event) => this.setPref("batchSize", Number((e.target as HTMLSelectElement).value))}>
              ${BATCH_SIZES.map((size) => html`<option value=${size} ?selected=${size === this.prefs.batchSize}>${size}</option>`)}
            </select>
          </label>`}
          <label class="row small" title=${this.mode === "vector" ? "Vector queries do not count matches" : "Adds count: {type: \"lowerBound\"}. Exact totals can be slow on large indexes."}>
            <input type="checkbox" .checked=${this.prefs.count} ?disabled=${this.mode === "vector"} @change=${(e: Event) => this.setPref("count", (e.target as HTMLInputElement).checked)} />
            Count matches
          </label>
          <select aria-label="Explain" .value=${this.prefs.explain} @change=${(e: Event) => this.setPref("explain", (e.target as HTMLSelectElement).value)}>
            ${EXPLAIN_OPTIONS.map((option) => html`<option value=${option.id} ?selected=${option.id === this.prefs.explain}>${option.label}</option>`)}
          </select>
          <span class="spacer"></span>
          ${this.running
            ? html`<button class="btn secondary" @click=${() => this.cancel()}>${icon("stop", 14)} Cancel</button>`
            : nothing}
          ${this.mode === "search"
            ? html`<button class="btn secondary" title="Facet and count metadata, with no hits" ?disabled=${!this.index || this.running} @click=${() => this.runMeta()}>
                ${icon("activity", 14)} Meta
              </button>`
            : nothing}
          <button class="btn" ?disabled=${!this.index || this.running} @click=${() => this.run()}>
            ${icon("play", 14)} ${this.running ? "Running…" : "Run"} <span class="kbd run-shortcut">Ctrl ↵</span>
          </button>
        </div>
      </div>
    </div>`;
  }

  private renderFacetPicker(): TemplateResult {
    const indexed = facetFields(this.fields);
    const options = [...indexed, ...FACET_TEMPLATES];
    return html`<div class="row">
      <label class="field facet-field"><span class="label">Add facet</span>
        <select class="facet-field-select" ?disabled=${!this.index} @change=${(event: Event) => {
          const select = event.target as HTMLSelectElement;
          const field = options[Number(select.value)];
          select.selectedIndex = 0;
          if (!field) return;
          try {
            this.text = prettyJson(addFacetToQuery(this.text, field));
            this.error = null;
            this.saveDraft();
            this.editor?.focus();
          } catch (error) {
            this.error = errorMessage(error);
          }
        }}>
          <option value="" disabled selected>Choose a field or template</option>
          ${indexed.length ? html`<optgroup label="Indexed fields">
            ${indexed.map(({ path, type }, index) => html`<option value=${index}>${path} · ${type}</option>`)}
          </optgroup>` : nothing}
          <optgroup label="Templates">
            ${FACET_TEMPLATES.map(({ label }, index) => html`<option value=${indexed.length + index}>${label} facet</option>`)}
          </optgroup>
        </select>
      </label>
      <p class="hint">Set <code>boundaries</code> for ranges. Add <code>facet.operator</code> to filter matches.</p>
    </div>`;
  }

  private renderAggregateResults(): TemplateResult {
    if (this.error) {
      return html`<div class="alert" data-tone="danger" role="alert">
        ${icon("alert", 16)}<div class="alert__body">${this.error}</div>
      </div>`;
    }
    const result = this.aggregateResult;
    if (!result) return html`<div class="card">
      <mong-empty glyph="analytics" heading=${this.running ? "Running…" : "Facet results"}
        .message=${this.running ? null : "Run a query to see the bucket breakdown."}></mong-empty>
    </div>`;
    const count = matchCount(this.metadata);
    const latency = this.timings[0]?.mongot;
    return html`
      <div class="results-meta" role="status">
        ${count ? html`<span><strong>${count.exact ? "" : "≥"}${facetValue(count.value)}</strong> matches</span>` : nothing}
        ${latency == null ? nothing : html`<span>${formatMs(latency)} server time</span>`}
        ${this.running
          ? html`<span>Running query…</span>`
          : result.text !== this.text ? html`<span>Query edited. Run again to refresh.</span>` : nothing}
      </div>
      ${result.facets.length
        ? html`<mong-facet-results .facets=${result.facets}></mong-facet-results>`
        : html`<p class="card card__body muted">${this.metadata ? "This query returned no facets." : "This query returned no metadata."}</p>`}
      ${this.metadata
        ? html`<details class="card card__body facet-raw">
            <summary>Raw metadata</summary>
            <mong-json-tree .value=${this.metadata} expand-depth="1"></mong-json-tree>
          </details>`
        : nothing}
    `;
  }

  private renderStats(): TemplateResult | typeof nothing {
    if (!this.ranQuery || this.error) return nothing;
    const count = countOf(this.metadata);
    const first = this.timings[0];
    const last = this.timings.length > 1 ? this.timings[this.timings.length - 1] : null;
    const stat = (label: string, value: string, hint: string, title = "") =>
      html`<div class="query-stat" title=${title}>
        <div class="query-stat__label">${label}</div>
        <div class="query-stat__value">${value}</div>
        <div class="query-stat__hint">${hint}</div>
      </div>`;
    const matchesHint = this.ranQuery.mode === "vector"
      ? "vector queries don't count"
      : count
        ? (count.exact ? "exact total" : "lower bound")
        : "turn on Count matches";
    return html`<div class="query-stats">
      ${stat("Results", formatNumber(this.hits.length), this.hasMore ? "more available" : "all loaded")}
      ${stat("Matches", count ? `${count.exact ? "" : "≥ "}${formatNumber(count.value)}` : "—", matchesHint)}
      ${stat("End to end", formatMs(first?.e2e), "first page", "Time from sending the query until the browser parsed the response.")}
      ${stat("Mongot", formatMs(first?.mongot), "first page", "Admin service time for the mongot call: the connection, the RPC, and decoding the response.")}
      ${last
        ? stat(`Page ${last.page}`, formatMs(last.e2e), `end to end · ${formatMs(last.mongot)} mongot`, "The most recent Load more.")
        : nothing}
    </div>`;
  }

  private renderSearchMeta(): TemplateResult | typeof nothing {
    if (!this.ranQuery || this.error) return nothing;
    const metadata = this.metadata;
    const hasTree = metadata !== null && typeof metadata === "object" && Object.keys(metadata).length > 0;
    const tree = () => this.querySelector<HTMLElement & { expandAll(): void; collapseAll(): void }>("mong-json-tree.search-meta-tree");
    return html`<div class="card">
      <div class="card__head">
        <h3>Search meta</h3>
        <span class="spacer"></span>
        ${hasTree
          ? html`<button class="btn ghost sm" @click=${() => tree()?.expandAll()}>Expand</button>
              <button class="btn ghost sm" @click=${() => tree()?.collapseAll()}>Collapse</button>
              <button class="btn ghost sm" title="Copy metadata" @click=${() => navigator.clipboard.writeText(prettyJson(metadata)).then(() => toast("Copied search meta"))}>${icon("copy", 14)}</button>`
          : nothing}
      </div>
      <div class="card__body stack">
        ${hasTree
          ? html`<mong-json-tree class="search-meta-tree" .value=${metadata} expand-depth="3"></mong-json-tree>`
          : html`<p class="hint" style="margin:0">
              This query returned no metadata. Add <code>count</code> or a <code>facet</code> collector, or run Meta for a metadata-only query.
            </p>`}
        ${this.timings.length > 1
          ? html`<div class="table-wrap"><table class="table compact">
              <thead><tr><th>Page</th><th class="num">Hits</th><th class="num">End to end</th><th class="num">Mongot</th></tr></thead>
              <tbody>
                ${this.timings.map(
                  (t) => html`<tr>
                    <td>${t.page}</td>
                    <td class="num">${formatNumber(t.hits)}</td>
                    <td class="num">${formatMs(t.e2e)}</td>
                    <td class="num">${formatMs(t.mongot)}</td>
                  </tr>`,
                )}
              </tbody>
            </table></div>`
          : nothing}
      </div>
    </div>`;
  }

  private renderResultsHead(): TemplateResult {
    const view = this.prefs.view;
    const canWrite = Boolean(this.index) && !this.caps.readOnly;
    return html`<div class="card__head query-toolbar">
      <div class="results-meta">
        <h3>Results</h3>
        ${this.ranQuery && this.ranQuery.index.name !== this.indexName ? html`<span>from ${this.ranQuery.index.name}</span>` : nothing}
      </div>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="Result view">
        ${(["table", "tree", "raw"] as const).map(
          (id) => html`<button aria-pressed=${view === id ? "true" : "false"} @click=${() => this.setPref("view", id)}>
            ${icon(id === "raw" ? "code" : id, 14)} ${id === "table" ? "Table" : id === "tree" ? "Tree" : "Raw"}
          </button>`,
        )}
      </div>
      ${view === "table" && this.hits.length
        ? html`<span data-menu>
            <button class="btn ghost sm" aria-expanded=${this.menu === "columns"} @click=${(e: Event) => this.toggleMenu("columns", e)}>${icon("columns", 14)} Columns</button>
            ${this.menu === "columns" ? this.renderColumnsMenu() : nothing}
          </span>`
        : nothing}
      <span data-menu>
        <button class="btn ghost sm" aria-haspopup="menu" aria-expanded=${this.menu === "export"} ?disabled=${!this.ranQuery} @click=${(e: Event) => this.toggleMenu("export", e)}>${icon("download", 14)} Export ${icon("chevronDown", 12)}</button>
        ${this.menu === "export"
          ? html`<div class="popover menu query-menu" role="menu">
              <div class="menu__label">Loaded rows (${formatNumber(this.hits.length)})</div>
              <button ?disabled=${!this.hits.length} @click=${() => this.exportLoaded("csv")}>CSV</button>
              <button ?disabled=${!this.hits.length} @click=${() => this.exportLoaded("ndjson")}>NDJSON</button>
              <div class="menu__label">All matches (server job)</div>
              <button @click=${() => this.exportAll("ndjson")}>NDJSON file</button>
              <button @click=${() => this.exportAll("csv")}>CSV file</button>
            </div>`
          : nothing}
      </span>
      <span data-menu>
        <button class="btn secondary sm" aria-haspopup="menu" aria-expanded=${this.menu === "add"} ?disabled=${!canWrite} title=${this.caps.readOnly ? (this.caps.reasons.editable ?? "") : ""} @click=${(e: Event) => this.toggleMenu("add", e)}>${icon("plus", 14)} Add ${icon("chevronDown", 12)}</button>
        ${this.menu === "add"
          ? html`<div class="popover menu query-menu" role="menu">
              <button @click=${() => ((this.menu = null), (this.drawer = "upsert"))}>${icon("edit", 14)} Upsert documents</button>
              <button @click=${() => ((this.menu = null), (this.drawer = "import"))}>${icon("upload", 14)} Import a file</button>
            </div>`
          : nothing}
      </span>
    </div>`;
  }

  private renderColumnsMenu(): TemplateResult {
    const pref = this.columnPref;
    return html`<div class="popover menu query-menu query-menu--columns" @click=${(e: Event) => e.stopPropagation()}>
      <div class="menu__label">Show and pin columns</div>
      ${this.allColumns().map(
        (column) => html`<div class="row" style="padding:2px 8px;gap:6px">
          <input type="checkbox" aria-label="Show ${column}" .checked=${!pref.hidden.includes(column)} @change=${() => this.toggleHidden(column)} />
          <span class="grow mono small ellipsis" style="flex:1">${column}</span>
          <button class="btn ghost sm" aria-pressed=${pref.pinned.includes(column) ? "true" : "false"} title="Pin to the left" style=${pref.pinned.includes(column) ? "color:var(--accent)" : ""} @click=${() => this.togglePin(column)}>
            ${icon("pin", 12)}
          </button>
        </div>`,
      )}
    </div>`;
  }

  private renderResultsBody(): TemplateResult {
    if (this.error) {
      return html`<div class="card__body"><div class="alert" data-tone="danger">${icon("alert", 16)}<div class="alert__body">${this.error}</div></div></div>`;
    }
    if (!this.ranQuery) {
      return html`<mong-empty
        heading=${this.running ? "Running…" : "No results yet"}
        .message=${this.running ? null : "Run a query to see documents here."}
      ></mong-empty>`;
    }
    if (!this.hits.length) {
      return html`<mong-empty
        heading="No matches"
        .message=${"Nothing matched this query. Try a broader one, or check the field names in Explore."}
      ></mong-empty>`;
    }
    const view = this.prefs.view;
    if (view === "raw") {
      const shown = this.hits.slice(0, RAW_LIMIT);
      return html`<pre class="raw results-body">${prettyJson(shown.map((hit) => hit.raw))}</pre>
        ${this.hits.length > RAW_LIMIT ? html`<p class="hint" style="padding:0 16px">Showing the first ${RAW_LIMIT} hits.</p>` : nothing}`;
    }
    if (view === "tree") {
      const shown = this.hits.slice(0, TREE_LIMIT);
      return html`<div class="results-body stack" style="padding:12px 16px;gap:10px">
        ${shown.map(
          (hit) => html`<div class="card" style="padding:8px 12px">
            <div class="row between small" style="margin-bottom:4px">
              <button class="btn ghost sm mono result-id" @click=${() => (this.openHit = hit)}><span class="ellipsis">${displayValue(hit.id) || hit.key}</span></button>
              ${hit.score != null && this.ranQuery?.mode !== "browse" ? html`<span class="muted">score ${hit.score.toFixed(4)}</span>` : nothing}
            </div>
            <mong-json-tree .value=${hit.doc} expand-depth="1"></mong-json-tree>
          </div>`,
        )}
        ${this.hits.length > TREE_LIMIT ? html`<p class="hint">Showing the first ${TREE_LIMIT} documents. Use the table for all ${formatNumber(this.hits.length)}.</p>` : nothing}
      </div>`;
    }
    return html`<mong-data-table
      .rows=${this.hits}
      .columns=${this.tableColumns()}
      .rowKey=${(hit: Hit) => hit.key}
      .selected=${this.selected}
      ?selectable=${!capabilities(this.ranQuery.index).readOnly}
      clickable
      max-height="620"
      @row-click=${(e: CustomEvent<Hit>) => (this.openHit = e.detail)}
      @selection-change=${(e: CustomEvent<Set<string>>) => (this.selected = e.detail)}
    ></mong-data-table>`;
  }

  private renderResultsFoot(): TemplateResult | typeof nothing {
    if (!this.ranQuery || this.error) return nothing;
    const selected = this.selected.size;
    return html`<div class="row" style="gap:8px;padding:10px 16px;border-top:1px solid var(--line)">
      ${selected
        ? html`<span class="small"><strong>${formatNumber(selected)}</strong> selected</span>
            <button class="btn danger-outline sm" @click=${() => this.deleteSelected()}>${icon("trash", 12)} Delete selected</button>
            <button class="btn ghost sm" @click=${() => (this.selected = new Set())}>Clear selection</button>`
        : nothing}
      ${this.urlNote ? html`<span class="hint">${icon("link", 12)} ${this.urlNote}</span>` : nothing}
      <span class="spacer"></span>
      ${this.hasMore
        ? html`<button class="btn secondary sm" ?disabled=${this.loadingMore} @click=${() => this.loadMore()}>
            ${this.loadingMore ? "Loading…" : `Load ${this.prefs.batchSize} more`}
          </button>`
        : this.hits.length
          ? html`<span class="hint">All results loaded</span>`
          : nothing}
    </div>`;
  }

  private explainVerbosity = "";

  private renderExplain(): TemplateResult | typeof nothing {
    if (!this.explainOut) return nothing;
    const viewer = this.explainView === "graph" ? html`<mong-explain-graph
      .explain=${this.explainOut}
      .query=${this.ranQuery?.query ?? null}
      .indexName=${this.ranQuery?.index.name ?? ""}
      .requestMillis=${this.timings.at(-1)?.mongot ?? null}
      .resultCount=${countOf(this.metadata)}
    ></mong-explain-graph>` : this.explainView === "tree" ? html`<mong-explain-tree
      .explain=${this.explainOut}
      .query=${this.ranQuery?.query ?? null}
      .indexName=${this.ranQuery?.index.name ?? ""}
      .requestMillis=${this.timings.at(-1)?.mongot ?? null}
      .resultCount=${countOf(this.metadata)}
    ></mong-explain-tree>` : html`<pre class="raw">${prettyJson(this.explainOut)}</pre>`;
    return html`<div class="card explain-card">
      <div class="card__head">
        <h3>Explain</h3>
        <span class="hint">${EXPLAIN_OPTIONS.find((o) => o.id === this.explainVerbosity)?.label.replace("Explain: ", "") ?? ""}</span>
        <span class="spacer"></span>
        <div class="seg" role="group" aria-label="Explain view">
          <button aria-pressed=${this.explainView === "graph"} @click=${() => (this.explainView = "graph")}>Graph</button>
          <button aria-pressed=${this.explainView === "tree"} @click=${() => (this.explainView = "tree")}>Tree</button>
          <button aria-pressed=${this.explainView === "raw"} @click=${() => (this.explainView = "raw")}>Raw</button>
        </div>
        <button class="btn ghost sm" aria-label="Copy explain output" @click=${() => navigator.clipboard.writeText(prettyJson(this.explainOut)).then(() => toast("Copied explain output"))}>${icon("copy", 14)}</button>
      </div>
      <div class="card__body"><div class="explain-pane">${viewer}</div></div>
    </div>`;
  }

  private renderDrawers(): TemplateResult | typeof nothing {
    const index = this.ranQuery?.index ?? this.index;
    if (!index) return nothing;
    return html`
      ${this.openHit
        ? html`<mong-doc-drawer
            .hit=${this.openHit}
            .index=${index}
            .indexes=${this.indexes}
            @close=${() => (this.openHit = null)}
            @saved=${(e: CustomEvent) => this.onSaved(e)}
            @deleted=${(e: CustomEvent) => this.onDeleted(e)}
            @find-similar=${(e: CustomEvent<SimilarTarget>) => this.findSimilar(e.detail)}
          ></mong-doc-drawer>`
        : nothing}
      ${this.drawer === "upsert" && this.index
        ? html`<mong-upsert-drawer
            .index=${this.index}
            @close=${() => (this.drawer = null)}
            @saved=${() => {
              this.drawer = null;
              if (this.ranQuery) void this.run();
            }}
          ></mong-upsert-drawer>`
        : nothing}
      ${this.drawer === "import" && this.index
        ? html`<mong-import-drawer
            .index=${this.index}
            @close=${() => {
              this.drawer = null;
              if (this.ranQuery) void this.run();
            }}
          ></mong-import-drawer>`
        : nothing}
    `;
  }

  render() {
    const state = this.store.value;
    if (!state.loaded && !state.indexes.length) {
      return html`<div class=${this.embedded ? "" : "page"}><mong-empty heading="Loading indexes…"></mong-empty></div>`;
    }
    if (!state.indexes.length) {
      return html`<div class=${this.embedded ? "" : "page"}>
        <mong-empty
          heading="No indexes"
          .message=${"Create an index to start querying."}
          .action=${html`<a class="btn" href="#/indexes/new">${icon("plus")} New index</a>`}
        ></mong-empty>
      </div>`;
    }
    const caps = this.caps;
    const body = html`<div class="explore">
      ${this.renderRail(caps)}
      <div class="stack" style="min-width:0">
        ${this.index ? nothing : html`<div class="alert" data-tone="warn">${icon("alert", 16)}<div class="alert__body">Index “${this.indexName}” was not found.</div></div>`}
        ${this.renderEditorCard(caps)}
        ${this.mode === "aggregate"
          ? this.renderAggregateResults()
          : html`<div class="card">
              ${this.renderResultsHead()}
              ${this.renderStats()}
              ${this.renderResultsBody()}
              ${this.renderResultsFoot()}
            </div>
            ${this.renderSearchMeta()}`}
        ${this.renderExplain()}
      </div>
    </div>
    ${this.mode === "aggregate" ? nothing : this.renderDrawers()}`;
    if (this.embedded) return body;
    return html`<div class="page">
      <div class="page__head">
        <div class="page__title">
          <h1>Explore</h1>
          <div class="hint">Browse documents, run search queries, and analyze facets.<span class="run-shortcut"> Ctrl+Enter runs the query.</span></div>
        </div>
      </div>
      ${body}
    </div>`;
  }
}

customElements.define("mong-explore", MongExplore);
