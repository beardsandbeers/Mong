import { indexReference, isPlanNode, nodeMillis, nodeTitle, planChildren, scalarArgs, type PlanNode } from "./explain";
import { formatNumber, isNum, pluralize } from "./format";

export interface ExplainTiming {
  label: string;
  millis: number;
  estimate?: boolean;
}

export interface ExplainFlowNode {
  id: string;
  title: string;
  kind: "planning" | "execution" | "output" | "details";
  data: unknown;
  summary?: string;
  timings?: ExplainTiming[];
  headline?: ExplainTiming;
  flow?: ExplainFlow;
}

export interface ExplainFlow {
  columns: ExplainFlowNode[][];
  details?: ExplainFlowNode[];
}

const TIMING_LABELS: Record<string, string> = {
  approximateStage: "ANN", exactStage: "Exact", costEstimation: "Cost", indexSetup: "Setup",
  weightSetup: "Weight setup", context: "Context", match: "Match", score: "Score",
  executionTimeMillis: "Execution", executionTimeMillisEstimate: "Execution estimate",
  userTimeMs: "User CPU", systemTimeMs: "System CPU",
};

function label(key: string): string {
  return TIMING_LABELS[key] ?? key.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function document(value: unknown): PlanNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PlanNode : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function timing(name: string, value: unknown, estimate = false): ExplainTiming | undefined {
  return isNum(value) && value >= 0 ? { label: name, millis: value, estimate } : undefined;
}

/** Take reported timers from a phase's own fields. Arrays are separate records. */
function timings(value: unknown, path = ""): ExplainTiming[] {
  return Object.entries(document(value) ?? {}).flatMap(([key, item]) => {
    if (key === "millisElapsed" || key === "executionTimeMillis" || key === "executionTimeMillisEstimate"
      || key === "userTimeMs" || key === "systemTimeMs") {
      const found = timing(path || label(key), item, key === "executionTimeMillisEstimate");
      return found ? [found] : [];
    }
    const next = key === "stats" ? path : [path, label(key)].filter(Boolean).join(" / ");
    return document(item) ? timings(item, next) : [];
  });
}

function node(id: string, title: string, data: unknown, options: Partial<ExplainFlowNode> = {}): ExplainFlowNode {
  return { id, title, kind: "execution", data, ...options };
}

function phase(id: string, title: string, data: unknown, options: Partial<ExplainFlowNode> = {}): ExplainFlowNode {
  return node(id, title, data, { timings: timings(data), ...options });
}

function queryNode(query: PlanNode, id: string, clause?: string): ExplainFlowNode {
  const measured = timings(query.stats);
  const headline = measured.length > 1 ? timing("Recorded work", nodeMillis(query)) : undefined;
  const summary = [clause, scalarArgs(query)].filter(Boolean).join(" · ") || query.type;
  const root = node(id, nodeTitle(query), query, { summary, timings: measured, headline });
  const children = planChildren(query).map((child, i) => queryNode(child.node, `${id}/${i}`, child.label));
  return children.length ? { ...root, flow: { columns: [children, [root]] } } : root;
}

function rewrites(value: unknown): ExplainFlowNode[][] {
  const pairs = list(value).flatMap((entry, i) => {
    const pair = document(entry);
    if (!pair) return [];
    const columns = [
      ["analyzed", "Analyze query"], ["rewritten", "Rewrite query"],
    ].filter(([key]) => pair[key] !== undefined).map(([key, title]) => [phase(`rewrite/${i}/${key}`, title, pair[key], {
      kind: "planning", summary: typeof pair[key] === "string" ? pair[key] : undefined,
    })]);
    return columns.length ? [{ pair, columns, i }] : [];
  });
  if (pairs.length === 1) return pairs[0].columns;
  if (!pairs.length) return [];
  return [[node("rewrites", "Lucene rewrites", value, {
    kind: "planning", summary: pluralize(pairs.length, "recorded pair"),
    flow: { columns: [pairs.map(({ pair, columns, i }) => node(`rewrite/${i}`, `Rewrite ${i + 1}`, pair, {
      kind: "planning", flow: { columns },
    }))] },
  })]];
}

function joinPreparation(data: PlanNode, indexName: string): ExplainFlowNode {
  const root = node("join-preparation", "Prepare joins", data, {
    kind: "planning", summary: isNum(data.keyCount) ? pluralize(data.keyCount, "key") : undefined,
    timings: timings(data.timing, "Total preparation"),
  });
  const sources = list(data.sources).map((value, i) => {
    const source = document(value) ?? {};
    const from = indexReference(source.from, source.selfJoin ? indexName : source.foreignIndexId ?? "Foreign index");
    return node(`source/${i}`, `Collect join keys · #${source.id ?? i}`, value, {
      kind: "planning", summary: [from, isNum(source.keyCount) ? pluralize(source.keyCount, "key") : ""].filter(Boolean).join(" · "),
      timings: timings(source.collection, "Foreign collection"),
    });
  });
  const columns: ExplainFlowNode[][] = [];
  if (data.dependencySetup != null) columns.push([phase("dependencies", "Resolve dependencies", data.dependencySetup, { kind: "planning" })]);
  else if (sources.length > 1) columns.push([root]);
  if (sources.length) columns.push(sources);
  return columns.length ? { ...root, flow: { columns } } : root;
}

function segmentNodes(value: unknown): ExplainFlowNode[] {
  return list(value).map((entry, i) => {
    const segment = document(entry) ?? {};
    const identity = segment.id ?? segment.ordinal;
    return phase(identity == null ? `segment/index/${i}` : `segment/id/${identity}`, `Segment ${identity ?? i + 1}`, entry, {
      summary: [segment.executionType, isNum(segment.docCount) ? pluralize(segment.docCount, "doc") : undefined, segment.fallbackReason]
        .filter(Boolean).join(" · "),
    });
  });
}

function joinExecution(value: unknown, i: number): ExplainFlowNode {
  const execution = document(value) ?? {};
  const segments = segmentNodes(execution.segments);
  const root = node(execution.id == null ? `join/index/${i}` : `join/id/${execution.id}`, `Execute join · #${execution.id ?? i}`, value, {
    summary: [execution.strategy, segments.length ? pluralize(segments.length, "segment") : undefined].filter(Boolean).join(" · "),
    timings: timings(execution.weightSetup, "Weight setup"),
  });
  return segments.length ? { ...root, flow: { columns: [[root], segments] } } : root;
}

function aggregationTree(data: PlanNode, id: string): ExplainFlowNode {
  const root = phase(id, data.name ?? "Aggregation tree", data, {
    summary: [data.type, data.path, isNum(data.observedBuckets) ? pluralize(data.observedBuckets, "bucket") : undefined].filter(Boolean).join(" · "),
  });
  const children = list(data.children).filter((entry): entry is PlanNode => !!document(entry))
    .map((child, i) => aggregationTree(child, `${id}/${i}`));
  return children.length ? { ...root, flow: { columns: [children, [root]] } } : root;
}

function queryExecution(data: PlanNode): ExplainFlowNode[] {
  const queries = list(data.query).flatMap((query, i) => isPlanNode(query) ? [queryNode(query, `query/${i}`)] : []);
  const joins = list(data.joins?.execution).map(joinExecution);
  const segments = segmentNodes(data.luceneVectorSegmentStats);
  if (!segments.length) return [...queries, ...joins];
  const vector = node("vector-segments", "Vector segment search", data.luceneVectorSegmentStats, {
    summary: pluralize(segments.length, "segment"),
  });
  const columns = [[vector], segments];
  if (segments.length > 1) columns.push([node("vector-merge", "Merge vector candidates", undefined, {
    kind: "output", summary: "Inferred from segment fan-out",
  })]);
  return [...queries, ...joins, { ...vector, flow: { columns } }];
}

function mongotFlow(data: PlanNode, indexName: string): ExplainFlow {
  const columns: ExplainFlowNode[][] = [];
  const preparation = document(data.joins?.preparation);
  if (preparation) columns.push([joinPreparation(preparation, indexName)]);
  if (data.optimizerRulesFired != null) columns.push([phase("optimizer", "Optimizer rules", data.optimizerRulesFired, {
    kind: "planning", summary: list(data.optimizerRulesFired).join(" · "),
  })]);
  columns.push(...rewrites(data.luceneQuery));

  const partitions = list(data.indexPartitionExplain).map((value, i) => {
    const part = document(value) ?? {};
    const count = part.metadata?.lucene?.totalSegments;
    return node(`partition/${i}`, `Partition ${i + 1}`, value, {
      flow: mongotFlow(part, indexName), timings: timings(part.timing),
      summary: isNum(count) ? pluralize(count, "index segment") : undefined,
    });
  });
  if (partitions.length) columns.push(partitions);
  const execution = queryExecution(data);
  if (execution.length) columns.push(execution);

  const collectors = document(data.collectors ?? data.collectStats);
  if (collectors) {
    const types = Object.entries(collectors).filter(([key]) => key !== "allCollectorStats")
      .map(([key, stats]) => phase(`collectors/${key}`, label(key), stats));
    columns.push([phase("collectors", "Collect results", collectors, {
      headline: timing("All collectors", collectors.allCollectorStats?.millisElapsed),
      flow: types.length ? { columns: [types] } : undefined,
    })]);
  }

  const { partitionMerge, ...collection } = document(data.aggregation) ?? {};
  if (Object.keys(collection).length) {
    const { collect, accumulatorCollect, tree } = collection;
    const treeData = document(tree);
    const phases = [
      ...(collect != null ? [phase("aggregation/collect", "Collect aggregates", collect)] : []),
      ...(accumulatorCollect != null ? [phase("aggregation/accumulators", "Update accumulators", accumulatorCollect)] : []),
      ...(treeData ? [aggregationTree(treeData, "aggregation/tree")] : []),
    ];
    columns.push([phase("aggregation", "Aggregate", collection, {
      headline: timing("Collection", collect?.millisElapsed), flow: phases.length ? { columns: [phases] } : undefined,
    })]);
  }
  if (partitionMerge != null) columns.push([phase("partition-merge", "Merge index partitions", partitionMerge, { kind: "output", summary: "Aggregation" })]);
  else if (partitions.length > 1) columns.push([node("partition-merge", "Combine partition results", undefined, {
    kind: "output", summary: "Inferred from partition fan-out",
  })]);

  for (const [key, title] of [["highlight", "Highlight matches"], ["resultMaterialization", "Materialize results"]]) {
    if (data[key] != null) columns.push([phase(key, title, data[key], { kind: "output" })]);
  }

  const details: ExplainFlowNode[] = [];
  for (const [key, title] of [["metadata", "Index metadata"], ["resourceUsage", "Resource usage"], ["vectorTracing", "Vector tracing"],
    ["vectorliteStats", "Vectorlite statistics"], ["vectorliteTrace", "Vectorlite trace"], ["numCandidates", "Vector candidates"], ["featureFlags", "Feature flags"]]) {
    if (data[key] != null) details.push(phase(key, title, data[key], { kind: "details" }));
  }
  // Keep the full scope accessible for newer explain fields and plan variants.
  if (Object.keys(data).length) details.push(node("mongot-details", "Mongot details", data, { kind: "details" }));
  return { columns, details };
}

function mongoPlan(value: unknown, id: string, summary?: string): ExplainFlowNode {
  const data = document(value) ?? {};
  const inputs = Object.entries(data).flatMap(([key, entry]) => list(entry).flatMap((child, i) => {
    const input = document(child);
    if (!input) return [];
    const plan = input.stage ? input : input.executionStages ?? input.winningPlan;
    return plan ? [mongoPlan(plan, `${id}/${key}/${i}`, input.shardName ?? label(key))] : [];
  }));
  const root = node(id, data.stage ?? "MongoDB plan", value, {
    kind: "output", summary: summary ?? (isNum(data.nReturned) ? `${formatNumber(data.nReturned)} returned` : undefined),
    timings: timings({ executionTimeMillis: data.executionTimeMillis, executionTimeMillisEstimate: data.executionTimeMillisEstimate }),
  });
  if (data.queryPlan) return { ...mongoPlan(data.queryPlan, id, summary), data: value };
  return inputs.length ? { ...root, flow: { columns: [inputs, [root]] } } : root;
}

function pipeline(value: unknown, indexName: string, lifted?: ExplainFlow): ExplainFlowNode[][] {
  return list(value).flatMap((entry, i) => {
    const data = document(entry);
    if (!data) return [];
    const name = Object.keys(data).find((key) => key.startsWith("$"));
    const spec = name ? document(data[name]) : undefined;
    const search = document(spec?.explain);
    let flow: ExplainFlow;
    if (search) flow = mongotFlow(search, indexName);
    else if (lifted && (spec?.mongotQuery || name === "$vectorSearch" || name === "$searchMeta" || name === "$_internalSearchMongotRemote")) {
      flow = lifted;
      lifted = undefined;
    } else if (spec?.queryPlanner || spec?.executionStats) flow = mongoFlow(spec, indexName);
    else flow = { columns: pipeline(spec?.subPipeline ?? spec?.pipeline, indexName) };
    return [[node(`stage/${i}`, name ?? `Stage ${i + 1}`, entry, {
      kind: "output", summary: isNum(data.nReturned) ? `${formatNumber(data.nReturned)} returned` : undefined,
      timings: timings({ executionTimeMillis: data.executionTimeMillis, executionTimeMillisEstimate: data.executionTimeMillisEstimate }),
      flow: flow.columns.length || flow.details?.length ? flow : undefined,
    })]];
  });
}

function mongoFlow(data: PlanNode, indexName: string, lifted?: ExplainFlow): ExplainFlow {
  const columns = pipeline(data.stages, indexName, lifted);
  const split = document(data.splitPipeline);
  const shards = Object.entries(document(data.shards) ?? {}).flatMap(([name, value], i) => {
    const shard = document(value);
    return shard ? [node(`shard/${i}`, name, shard, {
      kind: "output", flow: mongoFlow(shard, indexName),
      headline: timing("Shard execution", shard.executionStats?.executionTimeMillis),
    })] : [];
  });
  if (shards.length) columns.push(shards);
  else columns.push(...pipeline(split?.shardsPart, indexName));
  columns.push(...pipeline(split?.mergerPart, indexName).map(([stage]) => [{ ...stage, id: `merge/${stage.id}` }]));

  const details = [node("mongod-details", "MongoDB details", data, { kind: "details" })];
  const stats = document(data.executionStats);
  if (stats?.executionStages) columns.push([node("execution", "Execute MongoDB plan", stats, {
    kind: "output", headline: timing("Total execution", stats.executionTimeMillis),
    flow: { columns: [[mongoPlan(stats.executionStages, "execution-stage")]] },
  })]);
  const planner = document(data.queryPlanner);
  if (planner && (planner.winningPlan || list(planner.rejectedPlans).length)) {
    const plans = [
      ...list(planner.winningPlan).map((value, i) => mongoPlan(value, `winning/${i}`, "Winning plan")),
      ...list(planner.rejectedPlans).map((value, i) => mongoPlan(value, `rejected/${i}`, `Rejected plan ${i + 1}`)),
    ];
    const planned = node("planner", "Query planner", planner, { kind: "details", flow: { columns: [plans] } });
    if (columns.length) details.push(planned);
    else columns.push([planned]);
  }
  const alternatives = list(stats?.allPlansExecution);
  if (alternatives.length) details.push(node("alternative-plans", "Candidate executions", alternatives, {
    kind: "details", flow: { columns: [alternatives.map((value, i) => {
      const candidate = document(value);
      return mongoPlan(candidate?.executionStages ?? value, `candidate/${i}`, `Candidate ${i + 1}`);
    })] },
  }));
  return { columns, details };
}

export function explainFlow(explain: PlanNode, query: PlanNode | null, indexName: string): ExplainFlow {
  const { mongod, ...mongot } = explain;
  const mongo = document(mongod);
  const index = indexName || mongot.metadata?.indexName || "Current index";
  const remote = mongotFlow(mongot, index);
  const flow = mongo ? mongoFlow(mongo, index, remote.details?.length ? remote : undefined) : remote;
  if (mongo && remote.details?.length && !flow.columns.some((column) => column.some((stage) => stage.flow === remote))) {
    flow.details?.push(node("remote-details", "Mongot details", mongot, { kind: "details", flow: remote }));
  }
  if (query) flow.columns.unshift([node("submitted", "Submitted query", query, { kind: "planning", summary: index })]);
  return flow;
}
