export type PlanNode = Record<string, any>;

export function isPlanNode(value: unknown): value is PlanNode {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as PlanNode).type === "string";
}

/** Total milliseconds a node reports across its timing areas (context, match, score, ...). */
export function nodeMillis(node: PlanNode): number {
  const stats = node?.stats;
  if (!stats || typeof stats !== "object") return 0;
  let total = 0;
  for (const area of Object.values(stats as Record<string, any>)) {
    const ms = area?.millisElapsed;
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) total += ms;
  }
  return total;
}

/** Sum of invocation counts across a node's timing areas. */
export function nodeInvocations(node: PlanNode): number {
  let total = 0;
  for (const area of Object.values((node?.stats ?? {}) as Record<string, any>)) {
    for (const count of Object.values((area?.invocationCounts ?? {}) as Record<string, unknown>)) {
      total += Number(count) || 0;
    }
  }
  return total;
}

/** Child plan nodes nested anywhere in a node's args, labelled by the arg that holds them. */
export function planChildren(node: PlanNode): Array<{ label: string; node: PlanNode }> {
  const out: Array<{ label: string; node: PlanNode }> = [];
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

/** `key: value` pairs for a node's scalar args. */
export function scalarArgs(node: PlanNode): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node.args ?? {})) {
    if (value === null || typeof value !== "object") parts.push(`${key}: ${JSON.stringify(value)}`);
  }
  return parts.join(", ");
}

export interface PartitionPlan {
  id: string;
  label: string;
  node: PlanNode;
}

/** Partition plans are siblings; preparation at the top level applies to all of them. */
export function explainPlans(explain: PlanNode): PartitionPlan[] {
  const plans: PartitionPlan[] = [];
  const visit = (part: PlanNode, id: string, label: string) => {
    if (isPlanNode(part.query)) plans.push({ id, label, node: part.query });
    for (const [i, child] of (part.indexPartitionExplain ?? []).entries()) {
      visit(child, `${id}.${i}`, `${label ? `${label} / ` : ""}Partition ${i + 1}`);
    }
  };
  visit(explain, "plan", "");
  return plans;
}

/** A shared scale avoids clipping a child's accumulated work against its parent's timer. */
export function planMaxMillis(plans: PartitionPlan[]): number {
  const largest = (node: PlanNode): number => Math.max(nodeMillis(node), ...planChildren(node).map((child) => largest(child.node)));
  return Math.max(0, ...plans.map((plan) => largest(plan.node)));
}

export function nodeTitle(node: PlanNode): string {
  if (/Join/.test(node.args?.queryType ?? "")) return "Join membership";
  const titles: Record<string, string> = {
    BooleanQuery: "Combine clauses", TermQuery: "Match term", PhraseQuery: "Match phrase",
    MatchAllDocsQuery: "All documents", MatchNoDocsQuery: "No documents",
  };
  return titles[node.type] ?? node.type;
}

export interface SubmittedJoin {
  from?: unknown;
  localField: string;
  foreignField: string;
  operator?: PlanNode;
  exclude: boolean;
}

function submittedJoins(query: PlanNode | null): SubmittedJoin[] {
  const out: SubmittedJoin[] = [];
  const visit = (value: unknown, clause = "") => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, clause);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "join" && item && typeof item === "object") {
          out.push({ ...(item as SubmittedJoin), exclude: clause === "mustNot" });
        } else {
          visit(item, ["filter", "must", "mustNot", "should"].includes(key) ? key : clause);
        }
      }
    }
  };
  visit(query);
  return out;
}

export function indexReference(from: unknown, fallback = "Current index"): string {
  if (typeof from === "string" && from) return from;
  if (from && typeof from === "object" && "collection" in from) {
    const ref = from as { collection: string; index?: string };
    return `${ref.collection}/${ref.index ?? "default"}`;
  }
  return fallback;
}

/** A summary of the submitted predicate, rather than a fabricated foreign Lucene plan. */
export function predicateSummary(query: PlanNode | null | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [name, args] of Object.entries(query)) {
    if (name === "compound") {
      for (const [clause, children] of Object.entries(args ?? {})) {
        if (!Array.isArray(children)) continue;
        const summaries = children.map(predicateSummary).filter(Boolean);
        if (summaries.length) parts.push(`${clause}: ${summaries.join("; ")}`);
      }
    } else if (!["join", "count", "index", "sort", "returnStoredSource", "highlight"].includes(name) && args && typeof args === "object") {
      const value = args.query ?? args.value;
      const path = Array.isArray(args.path) ? args.path.join(", ") : args.path;
      parts.push(`${name}${path ? ` · ${path}` : ""}${value !== undefined ? `: ${JSON.stringify(value)}` : ""}`);
    }
  }
  return parts.join(" · ");
}

export interface JoinExecution {
  partition: string;
  data: PlanNode;
}

export interface JoinDetails {
  id: number;
  source: PlanNode;
  submitted?: SubmittedJoin;
  executions: JoinExecution[];
}

export function joinPreparation(explain: PlanNode): PlanNode | null {
  if (explain.joins?.preparation) return explain.joins.preparation;
  for (const child of explain.indexPartitionExplain ?? []) {
    const found = joinPreparation(child);
    if (found) return found;
  }
  return null;
}

/** Match query-local source IDs across partitions without adding repeated key counts. */
export function explainJoins(explain: PlanNode, query: PlanNode | null = null): JoinDetails[] {
  const executions: JoinExecution[] = [];
  const visit = (part: PlanNode, partition: string) => {
    for (const data of part.joins?.execution ?? []) executions.push({ partition, data });
    for (const [i, child] of (part.indexPartitionExplain ?? []).entries()) {
      visit(child, `${partition ? `${partition} / ` : ""}${i + 1}`);
    }
  };
  visit(explain, "");
  const submitted = submittedJoins(query);
  const sources: PlanNode[] = joinPreparation(explain)?.sources ?? [];
  if (!sources.length) {
    return submitted.map((join, id) => ({ id, source: { ...join, selfJoin: !join.from }, submitted: join, executions: [] }));
  }
  return sources.map((source) => {
    const matches = submitted.filter((join) => join.localField === source.localField
      && join.foreignField === source.foreignField
      && indexReference(join.from) === indexReference(source.from));
    return { id: source.id, source, submitted: matches.length === 1 ? matches[0] : undefined,
      executions: executions.filter((execution) => execution.data.id === source.id) };
  });
}

/** Counters are cumulative; each source's current segment snapshot is counted once. */
export function joinTotals(join: JoinDetails): { counters: Record<string, number>; strategies: Record<string, number>; segments: number } {
  const counters: Record<string, number> = {};
  const strategies: Record<string, number> = {};
  let segments = 0;
  for (const execution of join.executions) {
    for (const segment of execution.data.segments ?? []) {
      segments++;
      for (const [key, value] of Object.entries(segment.counters ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) counters[key] = (counters[key] ?? 0) + value;
      }
      for (const [key, value] of Object.entries(segment.strategyCounts ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) strategies[key] = (strategies[key] ?? 0) + value;
      }
    }
  }
  return { counters, strategies, segments };
}
