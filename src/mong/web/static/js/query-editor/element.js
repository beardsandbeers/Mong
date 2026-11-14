import {
  EditorState,
  EditorView,
  Prec,
  StateEffect,
  StateField,
  autocompletion,
  bracketMatching,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  defaultHighlightStyle,
  defaultKeymap,
  drawSelection,
  dropCursor,
  foldGutter,
  foldKeymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  history,
  historyKeymap,
  indentOnInput,
  indentUnit,
  indentWithTab,
  json,
  keymap,
  lineNumbers,
  lintGutter,
  lintKeymap,
  linter,
  placeholder,
  syntaxHighlighting,
} from "../../vendor/codemirror.js";
import { queryCompletionSource } from "./complete.js";
import { loadMappings } from "./fields.js";
import { lintQuery } from "./lint.js";

const setModel = StateEffect.define();

const modelField = StateField.define({
  create: () => ({ mode: "search", indexes: [], indexId: "", mappings: {} }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setModel)) next = effect.value;
    }
    return next;
  },
});

const theme = EditorView.theme({
  "&": {
    fontSize: "0.86rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    border: "1px solid var(--line)",
    borderRadius: "10px",
    backgroundColor: "#fbfcfd",
  },
  "&.cm-focused": {
    outline: "2px solid var(--accent-soft)",
    outlineOffset: "1px",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    minHeight: "110px",
  },
  ".cm-content": {
    padding: "8px 0",
    minHeight: "110px",
  },
  ".cm-gutters": {
    backgroundColor: "#f4f7f8",
    color: "var(--muted)",
    border: "none",
    borderRight: "1px solid var(--line)",
    borderRadius: "10px 0 0 10px",
  },
  ".cm-activeLine": { backgroundColor: "rgba(15, 138, 122, 0.05)" },
  ".cm-tooltip": { zIndex: "40" },
});

function emptyModel() {
  return { mode: "search", indexes: [], indexId: "", mappings: {} };
}

export class MongQueryEditor extends HTMLElement {
  constructor() {
    super();
    this._view = null;
    this._mode = "search";
    this._indexes = [];
    this._indexId = "";
    this._model = emptyModel();
    this._pendingValue = null;
    this._silence = false;
    this._signature = "";
    this._mappingFlight = "";
    this._status = null;
    this._resize = null;
  }

  static get observedAttributes() {
    return ["mode"];
  }

  attributeChangedCallback(name, _old, value) {
    if (name === "mode" && value) this.mode = value;
  }

  connectedCallback() {
    if (!this._view) this._mount();
    this._resize?.observe(this);
  }

  disconnectedCallback() {
    this._resize?.disconnect();
  }

  _mount() {
    this.classList.add("query-editor-host");
    const host = this;
    this._status = document.createElement("p");
    this._status.className = "query-editor__status";
    this._view = new EditorView({
      parent: this,
      state: EditorState.create({
        doc: this._pendingValue ?? "",
        extensions: [
          modelField,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          bracketMatching(),
          closeBrackets(),
          autocompletion({
            override: [queryCompletionSource((context) => context.state.field(modelField))],
            activateOnTyping: true,
            maxRenderedOptions: 60,
          }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          highlightActiveLine(),
          json(),
          lintGutter(),
          linter((view) => lintQuery(view.state, view.state.field(modelField)), { delay: 150 }),
          EditorView.lineWrapping,
          placeholder("Ctrl+Space completes operators, fields, and index names"),
          EditorView.contentAttributes.of({ "aria-label": "Query expression JSON" }),
          Prec.high(keymap.of([
            {
              key: "Mod-Enter",
              run() {
                host.dispatchEvent(new CustomEvent("run", { bubbles: true }));
                return true;
              },
            },
          ])),
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...lintKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          theme,
          EditorView.updateListener.of((update) => {
            if (host._silence || !update.docChanged) return;
            host.dispatchEvent(new Event("input", { bubbles: true }));
            host._emitIndexChange();
            host._renderStatus();
          }),
        ],
      }),
    });
    this.append(this._status);
    this._pendingValue = null;
    this._resize = new ResizeObserver(() => this._view?.requestMeasure());
    this._pushModel();
    this._renderStatus();
    this._loadMappings();
  }

  get value() {
    return this._view ? this._view.state.doc.toString() : (this._pendingValue ?? "");
  }

  set value(next) {
    const text = next == null ? "" : String(next);
    if (!this._view) {
      this._pendingValue = text;
      return;
    }
    if (text === this.value) return;
    this._silence = true;
    this._view.dispatch({ changes: { from: 0, to: this._view.state.doc.length, insert: text } });
    this._silence = false;
    this._renderStatus();
  }

  get mode() {
    return this._mode === "vector" ? "vector" : "search";
  }

  set mode(value) {
    const next = value === "vector" ? "vector" : "search";
    this._mode = next;
    this._model = { ...this._model, mode: next };
    this._pushModel();
  }

  get indexes() {
    return this._indexes;
  }

  set indexes(value) {
    this._indexes = Array.isArray(value) ? value : [];
    this._model = { ...this._model, indexes: this._indexes };
    this._pushModel();
    this._loadMappings();
  }

  get indexId() {
    return this._indexId;
  }

  set indexId(value) {
    this._indexId = value || "";
    this._model = { ...this._model, indexId: this._indexId };
    this._pushModel();
    this._loadMappings();
  }

  get diagnostics() {
    if (!this._view) return [];
    return lintQuery(this._view.state, this._model);
  }

  getQuery() {
    const errors = this.diagnostics.filter((item) => item.severity !== "warning");
    if (errors.length) throw new Error(errors[0].message);
    let parsed;
    try {
      parsed = JSON.parse(this.value || "{}");
    } catch {
      throw new Error("Query must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Query must be a JSON object");
    }
    const query = { ...parsed };
    delete query.index;
    return query;
  }

  refresh() {
    this._view?.requestMeasure();
  }

  _pushModel() {
    if (!this._view) return;
    this._view.dispatch({ effects: setModel.of(this._model) });
    this._renderStatus();
  }

  _emitIndexChange() {
    let parsed;
    try {
      parsed = JSON.parse(this.value);
    } catch {
      return;
    }
    const name = parsed && typeof parsed.index === "string" ? parsed.index : "";
    if (!name) return;
    const match = this._indexes.find((index) => index.name === name);
    if (!match || match.index_id === this._indexId) return;
    if (name === this._emittedIndex && match.index_id === this._indexId) return;
    this._emittedIndex = name;
    this.dispatchEvent(new CustomEvent("index-change", {
      bubbles: true,
      detail: { indexId: match.index_id, name: match.name },
    }));
  }

  _renderStatus() {
    if (!this._status || !this._view) return;
    const issues = lintQuery(this._view.state, this._model);
    const first = issues[0];
    this._status.textContent = first ? first.message : "";
    this._status.dataset.severity = first ? (first.severity || "error") : "";
    const signature = issues.map((item) => `${item.severity}:${item.from}:${item.message}`).join("|");
    if (signature !== this._signature) {
      this._signature = signature;
      this.dispatchEvent(new CustomEvent("diagnostics", { bubbles: true, detail: issues }));
    }
  }

  async _loadMappings() {
    const index = this._indexes.find((item) => item.index_id === this._indexId);
    if (!index?.definition || index.type === "VECTOR_SEARCH") return;
    const key = `${index.index_id}:${index.generation_id || index.active_revision || ""}`;
    if (this._mappingFlight === key) return;
    this._mappingFlight = key;
    const mappings = await loadMappings(index);
    if (this._indexId !== index.index_id || !mappings) return;
    this._model = {
      ...this._model,
      mappings: { ...this._model.mappings, [index.index_id]: mappings },
    };
    this._pushModel();
    this._renderStatus();
  }
}

if (!customElements.get("mong-query-editor")) {
  customElements.define("mong-query-editor", MongQueryEditor);
}
