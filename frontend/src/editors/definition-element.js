import { Compartment, EditorState, EditorView, StateEffect, StateField } from "./codemirror.js";
import { definitionCompletionSource } from "./definition-complete.js";
import { lintDefinition } from "./definition-lint.js";
import { FieldIndex, loadMappings } from "./fields.js";
import { createJsonEditor, renderStatus } from "./json-editor.js";

const setModel = StateEffect.define();

const modelField = StateField.define({
  create: () => ({ mode: "SEARCH", fieldPaths: [] }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setModel)) next = effect.value;
    }
    return next;
  },
});

function readMode(value) {
  return value === "VECTOR_SEARCH" ? "VECTOR_SEARCH" : "SEARCH";
}

function readOnlyExtensions(readonly) {
  return readonly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

export class MongDefinitionEditor extends HTMLElement {
  constructor() {
    super();
    this._view = null;
    this._mode = "SEARCH";
    this._index = null;
    this._model = { mode: "SEARCH", fieldPaths: [] };
    this._pendingValue = null;
    this._silence = false;
    this._signature = "";
    this._mappingFlight = "";
    this._status = null;
    this._resize = null;
    this._label = null;
    this._readonly = false;
    this._editability = new Compartment();
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
    this.classList.add("query-editor-host", "definition-editor-host");
    const host = this;
    const created = createJsonEditor({
      parent: this,
      doc: this._pendingValue ?? "",
      extensions: [modelField, this._editability.of(readOnlyExtensions(this._readonly))],
      completionSource: definitionCompletionSource((context) => context.state.field(modelField)),
      lintSource: (view) => lintDefinition(view.state, view.state.field(modelField)),
      lintNeedsRefresh: (update) => update.transactions.some(
        (tr) => tr.effects.some((effect) => effect.is(setModel)),
      ),
      placeholder: "Ctrl+Space completes keys, field types, and analyzers",
      ariaLabel: "Index definition JSON",
      minHeight: "160px",
      height: Number(this.getAttribute("height")) || 420,
      resizeKey: this.getAttribute("resize-key") || "definition",
      onRun: () => {
        const run = new CustomEvent("run", { bubbles: true, cancelable: true });
        if (host.dispatchEvent(run)) host.closest("form")?.requestSubmit();
      },
      onDocChange: () => {
        if (host._silence) return;
        host.dispatchEvent(new Event("input", { bubbles: true }));
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
    this._loadFields();
  }

  _bindLabel() {
    if (!this.id || this._label) return;
    const label = document.querySelector(`label[for="${CSS.escape(this.id)}"]`);
    if (!label) return;
    this._label = label;
    label.addEventListener("click", this._focusFromLabel);
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

  get readonly() {
    return this._readonly;
  }

  set readonly(value) {
    this._readonly = Boolean(value);
    this._view?.dispatch({ effects: this._editability.reconfigure(readOnlyExtensions(this._readonly)) });
  }

  get mode() {
    return this._mode;
  }

  set mode(value) {
    const next = readMode(value);
    this._mode = next;
    this._model = { ...this._model, mode: next };
    this._pushModel();
    this._renderStatus();
  }

  get index() {
    return this._index;
  }

  set index(value) {
    this._index = value || null;
    this._model = { ...this._model, fieldPaths: [] };
    this._pushModel();
    this._loadFields();
  }

  get diagnostics() {
    if (!this._view) return [];
    return lintDefinition(this._view.state, this._model);
  }

  getDefinition() {
    const errors = this.diagnostics.filter((item) => item.severity !== "warning");
    if (errors.length) throw new Error(errors[0].message);
    let parsed;
    try {
      parsed = JSON.parse(this.value || "{}");
    } catch {
      throw new Error("Definition must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Definition must be a JSON object");
    }
    return parsed;
  }

  refresh() {
    this._view?.requestMeasure();
  }

  _pushModel() {
    if (!this._view) return;
    this._view.dispatch({ effects: setModel.of(this._model) });
  }

  _renderStatus() {
    if (!this._status || !this._view) return;
    const issues = lintDefinition(this._view.state, this._model);
    renderStatus(this._status, issues);
    const signature = issues.map((item) => `${item.severity}:${item.from}:${item.message}`).join("|");
    if (signature !== this._signature) {
      this._signature = signature;
      this.dispatchEvent(new CustomEvent("diagnostics", { bubbles: true, detail: issues }));
    }
  }

  async _loadFields() {
    const index = this._index;
    if (!index?.definition) return;
    const key = `${index.index_id}:${index.generation_id || index.active_revision || ""}`;
    if (this._mappingFlight === key && this._model.fieldPaths.length) return;
    this._mappingFlight = key;
    const compiled = FieldIndex.compile(index.definition, index.type);
    if (index.type !== "VECTOR_SEARCH") {
      const observed = await loadMappings(index);
      if (this._index?.index_id !== index.index_id) return;
      if (observed) compiled.applyObserved(observed);
    }
    if (this._index?.index_id !== index.index_id) return;
    this._model = {
      ...this._model,
      fieldPaths: compiled.suggest(null).map((field) => ({
        path: field.path,
        types: [...field.rawTypes],
      })),
    };
    this._pushModel();
    this._renderStatus();
  }
}

if (!customElements.get("mong-definition-editor")) {
  customElements.define("mong-definition-editor", MongDefinitionEditor);
}
