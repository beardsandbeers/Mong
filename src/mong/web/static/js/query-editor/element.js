import { StateEffect, StateField } from "../../vendor/codemirror.js";
import { queryCompletionSource } from "./complete.js";
import { loadMappings } from "./fields.js";
import { createJsonEditor, formatJson, renderStatus } from "./json-editor.js";
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
    this._label = null;
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
    this._bindLabel();
  }

  disconnectedCallback() {
    this._resize?.disconnect();
    if (this._label && this._focusFromLabel) {
      this._label.removeEventListener("click", this._focusFromLabel);
    }
    this._label = null;
  }

  _mount() {
    this.classList.add("query-editor-host");
    const host = this;
    const created = createJsonEditor({
      parent: this,
      doc: this._pendingValue ?? "",
      extensions: [modelField],
      completionSource: queryCompletionSource((context) => context.state.field(modelField)),
      lintSource: (view) => lintQuery(view.state, view.state.field(modelField)),
      lintNeedsRefresh: (update) => update.transactions.some(
        (tr) => tr.effects.some((effect) => effect.is(setModel)),
      ),
      placeholder: "Ctrl+Space completes operators, fields, and index names",
      ariaLabel: "Query expression JSON",
      onRun: () => {
        host.dispatchEvent(new CustomEvent("run", { bubbles: true }));
      },
      onFormat: () => {
        host.indent();
      },
      onDocChange: () => {
        if (host._silence) return;
        host.dispatchEvent(new Event("input", { bubbles: true }));
        host._emitIndexChange();
        host._renderStatus();
      },
    });
    this._view = created.view;
    this._status = created.status;
    this._resize = created.resize;
    this._pendingValue = null;
    this._focusFromLabel = (event) => {
      event.preventDefault();
      host._view?.focus();
    };
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

  focus() {
    this._view?.focus();
  }

  indent() {
    const current = this.value;
    let next;
    try {
      next = formatJson(current);
    } catch {
      if (this._status) {
        this._status.textContent = "Indent needs valid JSON";
        this._status.dataset.severity = "error";
      }
      return false;
    }
    if (!this._view) {
      this._pendingValue = next;
      this.dispatchEvent(new CustomEvent("formatted", { bubbles: true }));
      return true;
    }
    if (next !== current) {
      const line = this._view.state.doc.lineAt(this._view.state.selection.main.head).number;
      const lines = next.split("\n");
      let anchor = 0;
      const target = Math.min(line, lines.length);
      for (let i = 1; i < target; i += 1) anchor += lines[i - 1].length + 1;
      this._silence = true;
      this._view.dispatch({
        changes: { from: 0, to: this._view.state.doc.length, insert: next },
        selection: { anchor: Math.min(anchor, next.length) },
      });
      this._silence = false;
    }
    this._renderStatus();
    this.dispatchEvent(new CustomEvent("formatted", { bubbles: true }));
    return true;
  }

  _bindLabel() {
    if (!this.id || this._label) return;
    const label = document.querySelector(`label[for="${CSS.escape(this.id)}"]`);
    if (!label) return;
    this._label = label;
    label.addEventListener("click", this._focusFromLabel);
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
    renderStatus(this._status, issues);
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
