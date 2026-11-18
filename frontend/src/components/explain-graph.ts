import { html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { explainFlow, type ExplainFlow, type ExplainFlowNode, type ExplainTiming } from "../lib/explain-flow";
import type { PlanNode } from "../lib/explain";
import { formatMs, formatNumber, isNum, pluralize } from "../lib/format";
import { LightElement } from "./base";
import { icon } from "./icons";
import "./json-tree";

const NODE_HEIGHT = 56;
const NODE_GAP = 8;
const EDGE_WIDTH = 30;

function duration({ millis, estimate }: ExplainTiming): string {
  const value = millis > 0 && millis < 0.01 ? `${formatNumber(millis * 1000, 3)} µs` : formatMs(millis);
  return `${estimate ? "≈" : ""}${value}`;
}

function edges(from: number, to: number): TemplateResult {
  const height = Math.max(from, to) * (NODE_HEIGHT + NODE_GAP) - NODE_GAP;
  const centers = (length: number) => Array.from({ length }, (_, i) => height / 2 + (i - (length - 1) / 2) * (NODE_HEIGHT + NODE_GAP));
  const start = centers(from);
  const end = centers(to);
  const middle = EDGE_WIDTH / 2;
  const path = [
    ...start.map((y) => `M0 ${y} H${middle}`),
    `M${middle} ${Math.min(start[0], end[0])} V${Math.max(start.at(-1)!, end.at(-1)!)}`,
    ...end.map((y) => `M${middle} ${y} H${EDGE_WIDTH} m-5 -4 l5 4 -5 4`),
  ].join(" ");
  return html`<svg class="explain-graph-edges" aria-hidden="true" width=${EDGE_WIDTH} height=${height} viewBox=${`0 0 ${EDGE_WIDTH} ${height}`}>
    ${svg`<path d=${path}></path>`}
  </svg>`;
}

export class MongExplainGraph extends LightElement {
  static properties = {
    explain: { attribute: false }, query: { attribute: false }, indexName: { attribute: false },
    requestMillis: { attribute: false }, resultCount: { attribute: false }, scope: { state: true },
    selectedId: { state: true },
  };
  declare explain: PlanNode | null;
  declare query: PlanNode | null;
  declare indexName: string;
  declare requestMillis: number | null;
  declare resultCount: { value: number; exact: boolean } | null;
  declare private scope: string[];
  declare private selectedId: string;
  private graph: ExplainFlow = { columns: [] };

  constructor() {
    super();
    this.explain = null;
    this.query = null;
    this.indexName = "";
    this.requestMillis = null;
    this.resultCount = null;
    this.scope = [];
    this.selectedId = "";
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("explain") || changed.has("query") || changed.has("indexName")) {
      this.graph = this.explain ? explainFlow(this.explain, this.query, this.indexName) : { columns: [] };
    }
  }

  private find(flow: ExplainFlow, id: string): ExplainFlowNode | undefined {
    return flow.columns.flat().find((node) => node.id === id) ?? flow.details?.find((node) => node.id === id);
  }

  private navigate(scope: string[], selectedId = ""): void {
    this.scope = scope;
    this.selectedId = selectedId;
    void this.updateComplete.then(() => {
      const viewport = this.querySelector<HTMLElement>(".explain-graph-viewport");
      if (viewport) {
        viewport.scrollTop = 0;
        viewport.scrollLeft = 0;
      }
      (viewport ?? this.querySelector<HTMLElement>(".explain-graph-breadcrumb button:last-child"))?.focus();
    });
  }

  private renderNode(node: ExplainFlowNode, selected: boolean): TemplateResult {
    const measured = node.timings ?? [];
    const times = measured.map((time) => `${time.label} ${duration(time)}`);
    const primary = node.headline ?? (measured.length === 1 ? measured[0] : undefined);
    const summary = !primary && times.length ? times.join(" · ") : node.summary;
    return html`<button class="explain-graph-node" data-kind=${node.kind} aria-pressed=${selected}
      title=${[node.title, node.summary, ...times].filter(Boolean).join("\n")}
      @click=${() => { this.selectedId = selected ? "" : node.id; }}>
      <span class="explain-graph-node-title">${node.title}</span>
      ${primary ? html`<span class="explain-graph-time" title=${primary.label}>${duration(primary)}</span>`
        : !times.length ? html`<span class="explain-graph-time muted" aria-label="Timing unavailable">—</span>` : nothing}
      ${summary ? html`<span class="explain-graph-node-summary">${summary}</span>` : nothing}
      ${node.flow ? html`<span class="explain-graph-node-open" aria-label="Has subgraph">${icon("chevronRight", 12)}</span>` : nothing}
    </button>`;
  }

  private inspect(node: ExplainFlowNode, scope: string[]): TemplateResult {
    const count = node.flow?.columns.reduce((sum, column) => sum + column.length, 0) ?? 0;
    const measured = node.timings?.length ? node.timings : node.headline ? [node.headline] : [];
    return html`<section class="explain-graph-inspector" aria-label=${node.title}>
      <div class="row">
        <h4>${node.title}</h4>
        <span class="spacer"></span>
        ${node.flow ? html`<button class="btn secondary sm" @click=${() => this.navigate([...scope, node.id])}>
          Open subgraph${count ? ` · ${pluralize(count, "node")}` : ""} ${icon("chevronRight", 14)}
        </button>` : nothing}
        <button class="btn ghost sm" aria-label="Close node details" @click=${() => { this.selectedId = ""; }}>${icon("x", 14)}</button>
      </div>
      ${node.summary ? html`<p class="small muted explain-graph-detail-summary">${node.summary}</p>` : nothing}
      ${measured.length ? html`<ul class="explain-graph-timings">
        ${measured.map((time) => html`<li title=${`${time.millis} ms`}><span>${time.label}</span><strong>${duration(time)}</strong></li>`)}
      </ul>` : nothing}
      ${node.data === undefined ? nothing : html`<div class="explain-graph-data">
        ${typeof node.data === "string" ? html`<pre>${node.data}</pre>` : html`<mong-json-tree .value=${node.data} .expandDepth=${1}></mong-json-tree>`}
      </div>`}
    </section>`;
  }

  render() {
    if (!this.explain) return nothing;
    let flow = this.graph;
    const path: ExplainFlowNode[] = [];
    for (const id of this.scope) {
      const node = this.find(flow, id);
      if (!node?.flow) break;
      path.push(node);
      flow = node.flow;
    }
    const scope = path.map((node) => node.id);
    const selected = this.find(flow, this.selectedId);
    return html`<div class="explain-graph stack">
      <div class="results-meta">
        ${isNum(this.requestMillis) ? html`<span>Last API request <strong>${formatMs(this.requestMillis)}</strong></span>` : nothing}
        ${this.resultCount ? html`<span>${this.resultCount.exact ? "" : "At least "}<strong>${pluralize(this.resultCount.value, "match", "matches")}</strong></span>` : nothing}
        <span class="hint">Recorded timings may overlap. ≈ marks an estimate.</span>
      </div>
      ${path.length ? html`<nav class="explain-graph-breadcrumb" aria-label="Explain graph path">
        <button class="btn ghost sm" @click=${() => this.navigate([], path[0].id)}>Query flow</button>
        ${path.map((node, i) => html`${icon("chevronRight", 12)}${i === path.length - 1
          ? html`<strong aria-current="location">${node.title}</strong>`
          : html`<button class="btn ghost sm" @click=${() => this.navigate(scope.slice(0, i + 1), path[i + 1].id)}>${node.title}</button>`}`)}
      </nav>` : nothing}
      ${flow.columns.length ? html`<div class="explain-graph-viewport" role="region" tabindex="0" aria-label=${path.at(-1)?.title ?? "Query flow"}
        style=${`--explain-node-height:${NODE_HEIGHT}px;--explain-node-gap:${NODE_GAP}px`}>
        <div class="explain-graph-columns">
          ${flow.columns.map((column, i) => html`
            ${i ? edges(flow.columns[i - 1].length, column.length) : nothing}
            <div class="explain-graph-column">
              ${repeat(column, (node) => node.id, (node) => this.renderNode(node, selected?.id === node.id))}
            </div>`)}
        </div>
      </div>` : nothing}
      ${flow.details?.length ? html`<div class="row explain-graph-details" role="group" aria-label="Explain diagnostics">
        ${flow.details.map((node) => html`<button class="btn secondary sm" aria-pressed=${selected?.id === node.id}
          @click=${() => { this.selectedId = selected?.id === node.id ? "" : node.id; }}>${node.title}</button>`)}
      </div>` : nothing}
      ${selected ? this.inspect(selected, scope) : nothing}
    </div>`;
  }
}

customElements.define("mong-explain-graph", MongExplainGraph);
