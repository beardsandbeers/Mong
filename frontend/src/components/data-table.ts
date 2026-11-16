import { html, nothing, type TemplateResult } from "lit";
import { LightElement } from "./base";

export interface Column<T> {
  key: string;
  label: string | TemplateResult;
  render?: (row: T) => unknown;
  sortValue?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  align?: "left" | "right";
  width?: string;
  pinned?: boolean;
  truncate?: boolean;
  title?: (row: T) => string;
}

const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const VIRTUAL_THRESHOLD = 120;

/**
 * Sortable table with optional row selection. Long lists render only the visible
 * window of rows (fixed row height) so thousands of rows stay responsive.
 *
 * Events: `row-click` (detail: row), `selection-change` (detail: Set of row keys).
 */
export class MongDataTable<T = unknown> extends LightElement {
  static properties = {
    rows: { attribute: false },
    columns: { attribute: false },
    rowKey: { attribute: false },
    selectable: { type: Boolean },
    selected: { attribute: false },
    clickable: { type: Boolean },
    maxHeight: { type: Number, attribute: "max-height" },
    emptyText: { type: String, attribute: "empty-text" },
    sortKey: { type: String, attribute: "sort-key" },
    sortDir: { type: String, attribute: "sort-dir" },
    scrollTop: { state: true },
  };
  declare rows: T[];
  declare columns: Column<T>[];
  declare rowKey: (row: T, index: number) => string;
  declare selectable: boolean;
  declare selected: Set<string>;
  declare clickable: boolean;
  declare maxHeight: number;
  declare emptyText: string;
  declare sortKey: string;
  declare sortDir: "asc" | "desc";
  declare scrollTop: number;

  private sortedCache: { rows: T[]; key: string; dir: string; columns: Column<T>[]; out: T[] } | null = null;
  private frame = 0;

  constructor() {
    super();
    this.rows = [];
    this.columns = [];
    this.rowKey = (_row, index) => String(index);
    this.selectable = false;
    this.selected = new Set();
    this.clickable = false;
    this.maxHeight = 560;
    this.emptyText = "No rows";
    this.sortKey = "";
    this.sortDir = "asc";
    this.scrollTop = 0;
  }

  private get sorted(): T[] {
    const cache = this.sortedCache;
    if (
      cache &&
      cache.rows === this.rows &&
      cache.key === this.sortKey &&
      cache.dir === this.sortDir &&
      cache.columns === this.columns
    ) {
      return cache.out;
    }
    let out = this.rows;
    const column = this.columns.find((item) => item.key === this.sortKey);
    if (column) {
      const read = column.sortValue ?? ((row: T) => (row as Record<string, unknown>)[column.key] as string | number);
      const direction = this.sortDir === "desc" ? -1 : 1;
      out = [...this.rows].sort((a, b) => {
        const x = read(a);
        const y = read(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === "number" && typeof y === "number") return (x - y) * direction;
        return String(x).localeCompare(String(y), undefined, { numeric: true }) * direction;
      });
    }
    this.sortedCache = { rows: this.rows, key: this.sortKey, dir: this.sortDir, columns: this.columns, out };
    return out;
  }

  private toggleSort(column: Column<T>): void {
    if (column.sortable === false) return;
    if (this.sortKey === column.key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = column.key;
      this.sortDir = column.align === "right" ? "desc" : "asc";
    }
    this.dispatchEvent(new CustomEvent("sort-change", { detail: { key: this.sortKey, dir: this.sortDir } }));
  }

  private emitSelection(next: Set<string>): void {
    this.selected = next;
    this.dispatchEvent(new CustomEvent("selection-change", { detail: next }));
  }

  private toggleRow(key: string, event: Event): void {
    event.stopPropagation();
    const next = new Set(this.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.emitSelection(next);
  }

  private toggleAll(): void {
    const keys = this.sorted.map((row, index) => this.rowKey(row, index));
    const all = keys.length > 0 && keys.every((key) => this.selected.has(key));
    this.emitSelection(all ? new Set() : new Set(keys));
  }

  private onScroll(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.scrollTop = target.scrollTop;
    });
  }

  private cell(column: Column<T>, row: T): unknown {
    if (column.render) return column.render(row);
    const value = (row as Record<string, unknown>)[column.key];
    return value == null ? "" : String(value);
  }

  render() {
    const rows = this.sorted;
    const virtual = rows.length > VIRTUAL_THRESHOLD;
    let start = 0;
    let end = rows.length;
    if (virtual) {
      start = Math.max(0, Math.floor(this.scrollTop / ROW_HEIGHT) - OVERSCAN);
      end = Math.min(rows.length, start + Math.ceil(this.maxHeight / ROW_HEIGHT) + OVERSCAN * 2);
    }
    const keys = rows.map((row, index) => this.rowKey(row, index));
    const allSelected = keys.length > 0 && keys.every((key) => this.selected.has(key));
    const someSelected = !allSelected && keys.some((key) => this.selected.has(key));
    const colCount = this.columns.length + (this.selectable ? 1 : 0);
    return html`<div
      class="table-wrap"
      style="max-height:${this.maxHeight}px"
      @scroll=${virtual ? this.onScroll : null}
    >
      <table class="table">
        <thead>
          <tr>
            ${this.selectable
              ? html`<th style="width:32px">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    .checked=${allSelected}
                    .indeterminate=${someSelected}
                    @change=${() => this.toggleAll()}
                  />
                </th>`
              : nothing}
            ${this.columns.map((column) => {
              const sortable = column.sortable !== false;
              const active = this.sortKey === column.key;
              return html`<th
                class="${sortable ? "sortable" : ""} ${column.pinned ? "pinned" : ""} ${column.align === "right" ? "num" : ""}"
                style=${column.width ? `width:${column.width}` : ""}
                aria-sort=${active ? (this.sortDir === "asc" ? "ascending" : "descending") : "none"}
                @click=${() => this.toggleSort(column)}
              >
                ${column.label}${active ? html`<span class="sort">${this.sortDir === "asc" ? "▲" : "▼"}</span>` : nothing}
              </th>`;
            })}
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? html`<tr><td colspan=${colCount} class="table-empty">${this.emptyText}</td></tr>`
            : nothing}
          ${virtual && start > 0
            ? html`<tr class="spacer"><td colspan=${colCount} style="height:${start * ROW_HEIGHT}px"></td></tr>`
            : nothing}
          ${rows.slice(start, end).map((row, offset) => {
            const index = start + offset;
            const key = keys[index];
            const isSelected = this.selected.has(key);
            return html`<tr
              class="${this.clickable ? "clickable" : ""} ${isSelected ? "selected" : ""}"
              @click=${this.clickable
                ? () => this.dispatchEvent(new CustomEvent("row-click", { detail: row }))
                : null}
            >
              ${this.selectable
                ? html`<td @click=${(event: Event) => this.toggleRow(key, event)}>
                    <input type="checkbox" aria-label="Select row" .checked=${isSelected} />
                  </td>`
                : nothing}
              ${this.columns.map(
                (column) => html`<td
                  class="${column.pinned ? "pinned" : ""} ${column.align === "right" ? "num" : ""} ${column.truncate ? "cell-trunc" : ""}"
                  title=${column.title ? column.title(row) : ""}
                >
                  ${this.cell(column, row)}
                </td>`,
              )}
            </tr>`;
          })}
          ${virtual && end < rows.length
            ? html`<tr class="spacer"><td colspan=${colCount} style="height:${(rows.length - end) * ROW_HEIGHT}px"></td></tr>`
            : nothing}
        </tbody>
      </table>
    </div>`;
  }
}

customElements.define("mong-data-table", MongDataTable);
