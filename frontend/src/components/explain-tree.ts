import { html, nothing, type TemplateResult } from "lit";
import { formatMs, formatNumber } from "../lib/format";
import { LightElement } from "./base";

type Node = Record<string, any>;

function isPlanNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as Node).type === "string";
}

/** Total milliseconds a node reports across its timing areas (context, match, score, ...). */
export function nodeMillis(node: Node): number {
  const stats = node?.stats;
  if (!stats || typeof stats !== "object") return 0;
  let total = 0;
  for (const area of Object.values(stats as Record<string, any>)) {
    const ms = area?.millisElapsed;
    if (typeof ms === "number") total += ms;
  }
  return total;
}

/** Child plan nodes nested anywhere in a node's args. */
export function planChildren(node: Node): Array<{ label: string; node: Node }> {
  const out: Array<{ label: string; node: Node }> = [];
  const visit = (value: unknown, label: string) => {
    if (isPlanNode(value)) {
      out.push({ label, node: value });
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, label));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, key);
    }
  };
  for (const [key, value] of Object.entries(node.args ?? {})) visit(value, key);
  return out;
}

function scalarArgs(node: Node): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node.args ?? {})) {
    if (value === null || typeof value !== "object") parts.push(`${key}: ${JSON.stringify(value)}`);
  }
  return parts.join(", ");
}

/** Collapsible query plan with per-node timing bars, from mongot's explain output. */
export class MongExplainTree extends LightElement {
  static properties = { explain: { attribute: false }, collapsed: { state: true } };
  declare explain: Record<string, any> | null;
  declare collapsed: Set<string>;

  constructor() {
    super();
    this.explain = null;
    this.collapsed = new Set();
  }

  private toggle(id: string): void {
    const next = new Set(this.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.collapsed = next;
  }

  private row(node: Node, label: string, id: string, rootMs: number): TemplateResult {
    const ms = nodeMillis(node);
    const children = planChildren(node);
    const open = !this.collapsed.has(id);
    const counts = Object.values(node.stats ?? {})
      .map((area: any) => area?.invocationCounts)
      .filter(Boolean)
      .reduce((sum: number, counts: Record<string, number>) => sum + Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0), 0);
    return html`<div class=${id === "0" ? "" : "explain-node"}>
      <div class="explain-row">
        <span class="row" style="flex-wrap:nowrap;min-width:0">
          ${children.length
            ? html`<button class="jt-toggle" style="margin-left:0" @click=${() => this.toggle(id)} aria-label="Toggle">${open ? "▾" : "▸"}</button>`
            : html`<span style="width:14px"></span>`}
          ${label ? html`<span class="muted small">${label}</span>` : nothing}
          <span class="type">${node.type}</span>
          <span class="muted small ellipsis" title=${scalarArgs(node)}>${scalarArgs(node)}</span>
        </span>
        <span class="bar-track" style="width:100%" title="${formatMs(ms)} of ${formatMs(rootMs)}">
          <span class="bar" style="width:${rootMs > 0 ? Math.max(1, (ms / rootMs) * 100) : 0}%"></span>
        </span>
        <span class="num small" title=${counts ? `${formatNumber(counts)} invocations` : ""}>${node.stats ? formatMs(ms) : "—"}</span>
      </div>
      ${open ? children.map((child, i) => this.row(child.node, child.label, `${id}.${i}`, rootMs)) : nothing}
    </div>`;
  }

  render() {
    const explain = this.explain;
    if (!explain) return nothing;
    const root = isPlanNode(explain.query) ? explain.query : null;
    const rootMs = root ? nodeMillis(root) : 0;
    const materialize = explain.resultMaterialization?.stats?.millisElapsed;
    const lucene = explain.metadata?.lucene;
    const usage = explain.resourceUsage;
    return html`<div class="stack">
      <div class="results-meta">
        ${root ? html`<span>Query <strong>${formatMs(rootMs)}</strong></span>` : nothing}
        ${typeof materialize === "number" ? html`<span>Materialize results <strong>${formatMs(materialize)}</strong></span>` : nothing}
        ${lucene ? html`<span>${formatNumber(lucene.totalDocs)} docs in ${formatNumber(lucene.totalSegments)} segments</span>` : nothing}
        ${usage ? html`<span>${formatNumber(usage.numBatches)} batches · CPU ${formatMs((usage.userTimeMs ?? 0) + (usage.systemTimeMs ?? 0))}</span>` : nothing}
      </div>
      ${root
        ? this.row(root, "", "0", rootMs)
        : html`<div class="hint">This explain output has no query plan. The raw output is below.</div>`}
    </div>`;
  }
}

customElements.define("mong-explain-tree", MongExplainTree);
