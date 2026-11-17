import { html, nothing, type TemplateResult } from "lit";
import {
  explainJoins, explainPlans, indexReference, joinPreparation, joinTotals, nodeInvocations,
  nodeMillis, nodeTitle, planChildren, planMaxMillis, predicateSummary, scalarArgs,
  type JoinDetails, type PlanNode,
} from "../lib/explain";
import { formatBytes, formatMs, formatNumber, isNum } from "../lib/format";
import { LightElement } from "./base";

const STRATEGIES: Record<string, string> = {
  adaptive: "Adaptive membership", numeric: "Numeric membership", termInSet: "Term set",
  empty: "No foreign keys", docValuesProbe: "DocValues probe", postings: "Postings", points: "Numeric points",
};

/** Join data flow and the underlying local Lucene plans, including partitioned explain. */
export class MongExplainTree extends LightElement {
  static properties = {
    explain: { attribute: false }, query: { attribute: false }, indexName: { attribute: false },
    requestMillis: { attribute: false }, resultCount: { attribute: false }, collapsed: { state: true },
  };
  declare explain: PlanNode | null;
  declare query: PlanNode | null;
  declare indexName: string;
  declare requestMillis: number | null;
  declare resultCount: { value: number; exact: boolean } | null;
  declare collapsed: Set<string>;

  constructor() {
    super();
    this.explain = null;
    this.query = null;
    this.indexName = "";
    this.requestMillis = null;
    this.resultCount = null;
    this.collapsed = new Set();
  }

  private toggle(id: string): void {
    const next = new Set(this.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.collapsed = next;
  }

  private row(node: PlanNode, label: string, id: string, scale: number, depth = 0): TemplateResult {
    const ms = nodeMillis(node);
    const children = planChildren(node);
    const open = !this.collapsed.has(id);
    const counts = nodeInvocations(node);
    const timed = Object.values(node.stats ?? {}).some((area: any) => isNum(area?.millisElapsed));
    const width = scale > 0 && ms > 0 ? Math.min(100, Math.max(1, ms / scale * 100)) : 0;
    return html`<div class=${depth ? "explain-node" : ""}>
      <div class="explain-row">
        <span class="explain-node-label">
          ${children.length
            ? html`<button class="jt-toggle" @click=${() => this.toggle(id)} aria-expanded=${String(open)} aria-label=${`${open ? "Collapse" : "Expand"} ${nodeTitle(node)}`}>${open ? "▾" : "▸"}</button>`
            : html`<span class="explain-leaf-spacer"></span>`}
          ${label ? html`<span class="explain-clause">${label}</span>` : nothing}
          <strong title=${node.type}>${nodeTitle(node)}</strong>
          <span class="muted small explain-node-args">${scalarArgs(node)}</span>
        </span>
        <span class="bar-track" title="Accumulated node work; timings can overlap">
          <span class="bar" style="width:${width}%"></span>
        </span>
        <span class="num small" title=${counts ? `${formatNumber(counts)} operation invocations` : ""}>${timed ? formatMs(ms) : "—"}</span>
      </div>
      ${open ? children.map((child, i) => this.row(child.node, child.label, `${id}.${i}`, scale, depth + 1)) : nothing}
    </div>`;
  }

  private metric(label: string, value: string, title = ""): TemplateResult {
    return html`<div class="explain-metric" title=${title}><span>${label}</span><strong>${value}</strong></div>`;
  }

  private join(join: JoinDetails, ordinal: number, localName: string): TemplateResult {
    const source = join.source;
    const totals = joinTotals(join);
    const strategies = [...new Set(join.executions.map((execution) => execution.data.strategy))];
    const choices = Object.entries(totals.strategies).filter(([, count]) => count > 0);
    const choiceCount = choices.reduce((sum, [, count]) => sum + count, 0);
    const predicate = predicateSummary(join.submitted?.operator);
    const localPredicate = predicateSummary(this.query);
    const relation = join.submitted?.exclude ? "Exclude matching local documents" : "Keep matching local documents";
    return html`<section class="explain-join" aria-label=${`Join ${ordinal + 1}`}>
      <div class="explain-section-head">
        <h4>Join ${ordinal + 1}</h4>
        <span class="badge accent">${source.selfJoin ? "Self join" : "Index join"}</span>
        ${source.keyType ? html`<span class="badge">${String(source.keyType).toLowerCase()} keys</span>` : nothing}
        <span class="spacer"></span>
        ${strategies.map((strategy) => html`<span class="pill">${STRATEGIES[strategy] ?? strategy}</span>`)}
      </div>
      <div class="explain-flow">
        <div class="explain-step explain-step-foreign">
          <span class="explain-step-label">1 · Foreign selection</span>
          <strong class="mono">${indexReference(source.from, source.selfJoin ? localName : source.foreignIndexId)}</strong>
          ${predicate
            ? html`<p class="explain-predicate">${predicate}</p><span class="hint">Submitted foreign filter</span>`
            : html`<p class="hint">Foreign predicate is not included in this explain output.</p>`}
        </div>
        <span class="explain-flow-arrow" aria-hidden="true">→</span>
        <div class="explain-step explain-step-keys">
          <span class="explain-step-label">2 · Join membership</span>
          <strong class="explain-key-count">${isNum(source.keyCount) ? formatNumber(source.keyCount) : "—"} <span>unique keys</span></strong>
          <div class="explain-key-relation"><code>${source.foreignField}</code><span>→</span><code>${source.localField}</code></div>
          <span class="hint">${relation}</span>
        </div>
        <span class="explain-flow-arrow" aria-hidden="true">→</span>
        <div class="explain-step explain-step-local">
          <span class="explain-step-label">3 · Local search</span>
          <strong class="mono">${localName}</strong>
          ${localPredicate ? html`<p class="explain-predicate">${localPredicate}</p>` : nothing}
          ${this.resultCount
            ? html`<span class="explain-result-count">${this.resultCount.exact ? "" : "At least "}${formatNumber(this.resultCount.value)} final query matches</span>`
            : html`<span class="hint">Returns local documents</span>`}
        </div>
      </div>
      <div class="explain-metrics">
        ${this.metric("Foreign key collection", formatMs(source.collection?.millisElapsed))}
        ${this.metric("Key data", formatBytes(source.keyBytes))}
        ${this.metric("Memory reservation", formatBytes(source.reservedBytes), "Admission estimate for the join, not measured JVM heap usage")}
        ${totals.segments ? this.metric("Segment snapshots", formatNumber(totals.segments)) : nothing}
        ${isNum(totals.counters.probes) ? this.metric("Membership probes", formatNumber(totals.counters.probes)) : nothing}
        ${isNum(totals.counters.probeMatches) ? this.metric("Probe matches", formatNumber(totals.counters.probeMatches), "Membership confirmations; can repeat during counting or facets, and are not returned result counts") : nothing}
        ${isNum(totals.counters.fallbacks) ? this.metric("Strategy fallbacks", formatNumber(totals.counters.fallbacks)) : nothing}
      </div>
      ${choices.length ? html`<div class="explain-strategies">
        <span class="small muted">Scorer choices</span>
        <div class="explain-strategy-bar" role="img" aria-label=${choices.map(([key, count]) => `${STRATEGIES[key] ?? key}: ${count}`).join(", ")}>
          ${choices.map(([key, count]) => html`<span class=${`explain-strategy-${key}`} style="width:${count / choiceCount * 100}%"></span>`)}
        </div>
        <div class="explain-strategy-legend">${choices.map(([key, count]) => html`<span><i class=${`explain-strategy-${key}`}></i>${STRATEGIES[key] ?? key}<strong>${formatNumber(count)}</strong></span>`)}</div>
        <span class="hint">Initial scorer selections; a segment can be selected more than once.</span>
      </div>` : nothing}
      ${join.executions.length ? html`<details class="explain-details">
        <summary>Execution details${totals.segments ? ` · ${formatNumber(totals.segments)} segment snapshots` : ""}</summary>
        <div class="explain-execution-summary">
          ${join.executions.map(({ partition, data }) => html`<p class="small"><strong>${partition ? `Partition ${partition}` : "Local execution"}</strong> · ${STRATEGIES[data.strategy] ?? data.strategy} · ${data.selectionReason}${data.exhaustive ? " · exhaustive" : ""}</p>`)}
        </div>
        ${totals.segments ? html`<div class="table-wrap"><table class="explain-segments">
          <thead><tr><th>Partition / segment</th><th>Scorer choices</th><th class="num">Probes</th><th class="num">Probe matches</th><th class="num">Fallbacks</th><th class="num">Cost estimation</th><th class="num">Index setup</th></tr></thead>
          <tbody>${join.executions.flatMap(({ partition, data }) => (data.segments ?? []).map((segment: PlanNode) => html`<tr>
            <td>${partition || "1"} / ${segment.ordinal}</td>
            <td>${Object.entries(segment.strategyCounts ?? {}).filter(([, count]) => Number(count) > 0).map(([key, count]) => `${STRATEGIES[key] ?? key} × ${formatNumber(Number(count))}`).join(", ") || "—"}</td>
            <td class="num">${formatNumber(segment.counters?.probes)}</td><td class="num">${formatNumber(segment.counters?.probeMatches)}</td>
            <td class="num" title=${segment.fallbackReason ?? ""}>${formatNumber(segment.counters?.fallbacks)}</td>
            <td class="num">${formatMs(segment.costEstimation?.millisElapsed)}</td><td class="num">${formatMs(segment.indexSetup?.millisElapsed)}</td>
          </tr>`))}</tbody>
        </table></div>` : html`<p class="hint">Segment counters are available with execution-level explain.</p>`}
      </details>` : nothing}
    </section>`;
  }

  render() {
    const explain = this.explain;
    if (!explain) return nothing;
    const plans = explainPlans(explain);
    const joins = explainJoins(explain, this.query);
    const preparation = joinPreparation(explain);
    const scale = planMaxMillis(plans);
    const materialize = explain.resultMaterialization?.stats?.millisElapsed;
    const lucene = explain.metadata?.lucene;
    const usage = explain.resourceUsage;
    const localName = this.indexName || explain.metadata?.indexName || "Current index";
    return html`<div class="explain-visual stack">
      <div class="results-meta explain-overview">
        ${isNum(this.requestMillis) ? html`<span>Last request <strong>${formatMs(this.requestMillis)}</strong></span>` : nothing}
        ${isNum(preparation?.timing?.millisElapsed) ? html`<span>Join preparation <strong>${formatMs(preparation!.timing.millisElapsed)}</strong></span>` : nothing}
        ${isNum(materialize) ? html`<span>Materialize results <strong>${formatMs(materialize)}</strong></span>` : nothing}
        ${lucene ? html`<span>${formatNumber(lucene.totalDocs)} indexed docs · ${formatNumber(lucene.totalSegments)} segments</span>` : nothing}
        ${usage ? html`<span>${formatNumber(usage.numBatches)} batches · CPU ${formatMs((usage.userTimeMs ?? 0) + (usage.systemTimeMs ?? 0))}</span>` : nothing}
      </div>
      ${joins.map((join, i) => this.join(join, i, localName))}
      ${plans.length ? html`<section class="explain-local-plan">
        <div class="explain-section-head"><h4>Local Lucene plan</h4><span class="spacer"></span><span class="small muted">Recorded node work</span></div>
        <p class="hint explain-timing-note">Node timings accumulate across invocations and may overlap. They are not request latency and do not add up to the parent timer.</p>
        ${plans.map((plan) => html`<section class="explain-partition">
          ${plan.label ? html`<h4 class="explain-partition-label">${plan.label}</h4>` : nothing}
          ${this.row(plan.node, "", plan.id, scale)}
        </section>`)}
      </section>` : html`<div class="hint">This explain output has no local query plan. Use Raw to inspect the full response.</div>`}
      ${explain.luceneQuery ? html`<details class="explain-details"><summary>Compiled Lucene query</summary>
        ${Object.entries(explain.luceneQuery).filter(([, value]) => typeof value === "string").map(([name, value]) => html`<div class="explain-compiled"><strong class="small">${name}</strong><pre>${value}</pre></div>`)}
      </details>` : nothing}
    </div>`;
  }
}

customElements.define("mong-explain-tree", MongExplainTree);
