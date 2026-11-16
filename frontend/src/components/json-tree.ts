import { html, nothing, type TemplateResult } from "lit";
import { ejsonInfo } from "../lib/ejson";
import { LightElement } from "./base";

const CHILD_PAGE = 100;

/**
 * Collapsible JSON viewer. Extended JSON wrappers render as one value with a type badge.
 * Expansion state is kept per path so re-renders keep what the user opened.
 */
export class MongJsonTree extends LightElement {
  static properties = {
    value: { attribute: false },
    expandDepth: { type: Number, attribute: "expand-depth" },
  };
  declare value: unknown;
  declare expandDepth: number;

  private open = new Map<string, boolean>();
  private shown = new Map<string, number>();

  constructor() {
    super();
    this.value = undefined;
    this.expandDepth = 2;
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("value")) {
      this.open.clear();
      this.shown.clear();
    }
  }

  expandAll(): void {
    const walk = (value: unknown, path: string) => {
      if (value && typeof value === "object" && !ejsonInfo(value)) {
        this.open.set(path, true);
        for (const [key, child] of Object.entries(value as object)) walk(child, `${path}.${key}`);
      }
    };
    walk(this.value, "$");
    this.requestUpdate();
  }

  collapseAll(): void {
    const walk = (value: unknown, path: string) => {
      if (value && typeof value === "object" && !ejsonInfo(value)) {
        this.open.set(path, path === "$");
        for (const [key, child] of Object.entries(value as object)) walk(child, `${path}.${key}`);
      }
    };
    walk(this.value, "$");
    this.requestUpdate();
  }

  private isOpen(path: string, depth: number): boolean {
    return this.open.get(path) ?? depth < this.expandDepth;
  }

  private toggle(path: string, depth: number): void {
    this.open.set(path, !this.isOpen(path, depth));
    this.requestUpdate();
  }

  private leaf(value: unknown): TemplateResult {
    const info = ejsonInfo(value);
    if (info) {
      return html`<span class="ejson"><span class="badge">${info.type}</span><span class="jt-value jt-string">${info.display}</span></span>`;
    }
    if (value === null) return html`<span class="jt-null">null</span>`;
    switch (typeof value) {
      case "string":
        return html`<span class="jt-value jt-string">"${value}"</span>`;
      case "number":
        return html`<span class="jt-number">${value}</span>`;
      case "boolean":
        return html`<span class="jt-bool">${String(value)}</span>`;
      default:
        return html`<span class="jt-value">${String(value)}</span>`;
    }
  }

  private node(key: string | null, value: unknown, path: string, depth: number): TemplateResult {
    const label = key === null ? nothing : html`<span class="jt-key">${key}:</span>`;
    const container = value !== null && typeof value === "object" && !ejsonInfo(value);
    if (!container) {
      return html`<div class="jt-node"><div class="jt-row">${label}${this.leaf(value)}</div></div>`;
    }
    const isArray = Array.isArray(value);
    const entries: Array<[string, unknown]> = isArray
      ? (value as unknown[]).map((item, index) => [String(index), item])
      : Object.entries(value as Record<string, unknown>);
    const open = this.isOpen(path, depth);
    const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;
    const numericArray = isArray && entries.length > 8 && entries.every(([, item]) => typeof item === "number");
    if (numericArray && !open) {
      const preview = (value as number[]).slice(0, 4).map((n) => Number(n.toFixed(4))).join(", ");
      return html`<div class="jt-node"><div class="jt-row">
        <button class="jt-toggle" @click=${() => this.toggle(path, depth)}>▸</button>${label}
        <span class="jt-summary">[${preview}, … ${entries.length} numbers]</span>
      </div></div>`;
    }
    const limit = this.shown.get(path) ?? CHILD_PAGE;
    return html`<div class="jt-node">
      <div class="jt-row">
        <button class="jt-toggle" aria-label=${open ? "Collapse" : "Expand"} @click=${() => this.toggle(path, depth)}>
          ${open ? "▾" : "▸"}
        </button>
        ${label}<span class="jt-summary">${summary}</span>
      </div>
      ${open
        ? html`${entries.slice(0, limit).map(([k, v]) => this.node(k, v, `${path}.${k}`, depth + 1))}
          ${entries.length > limit
            ? html`<div class="jt-node">
                <button class="jt-more" @click=${() => {
                  this.shown.set(path, limit + CHILD_PAGE);
                  this.requestUpdate();
                }}>Show ${Math.min(CHILD_PAGE, entries.length - limit)} more of ${entries.length - limit}</button>
              </div>`
            : nothing}`
        : nothing}
    </div>`;
  }

  render() {
    if (this.value === undefined) return nothing;
    return html`<div class="jt-root">${this.node(null, this.value, "$", 0)}</div>`;
  }
}

customElements.define("mong-json-tree", MongJsonTree);
