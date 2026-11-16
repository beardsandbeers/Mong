import { createJsonEditor, formatJson, renderStatus } from "./json-editor.js";

function syntaxIssues(state) {
  const text = state.doc.toString();
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = String(error?.message || "Invalid JSON");
    const match = /position (\d+)/.exec(message);
    const from = match ? Math.min(Number(match[1]), text.length) : 0;
    return [{ from, to: Math.min(from + 1, text.length), severity: "error", message }];
  }
}

/** Plain JSON editor (documents, filters) with syntax checking and Alt+Shift+F to indent. */
export class MongJsonInput extends HTMLElement {
  constructor() {
    super();
    this._view = null;
    this._status = null;
    this._resize = null;
    this._pendingValue = null;
    this._silence = false;
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
    const created = createJsonEditor({
      parent: this,
      doc: this._pendingValue ?? "",
      lintSource: (view) => syntaxIssues(view.state),
      placeholder: this.getAttribute("placeholder") || "",
      ariaLabel: this.getAttribute("aria-label") || "JSON",
      minHeight: "120px",
      height: Number(this.getAttribute("height")) || 200,
      resizeKey: this.getAttribute("resize-key") || "",
      onRun: () => host.dispatchEvent(new CustomEvent("run", { bubbles: true })),
      onFormat: () => host.indent(),
      onDocChange: () => {
        if (host._silence) return;
        host.dispatchEvent(new Event("input", { bubbles: true }));
        renderStatus(host._status, syntaxIssues(host._view.state));
      },
    });
    this._view = created.view;
    this._status = created.status;
    this._resize = created.resize;
    this._pendingValue = null;
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
    renderStatus(this._status, syntaxIssues(this._view.state));
  }

  /** Parsed value; throws with the parser's message when the text is not valid JSON. */
  parse() {
    try {
      return JSON.parse(this.value);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
  }

  indent() {
    try {
      this.value = formatJson(this.value);
      return true;
    } catch {
      return false;
    }
  }

  focus() {
    this._view?.focus();
  }
}

if (!customElements.get("mong-json-input")) {
  customElements.define("mong-json-input", MongJsonInput);
}
