// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { MongExplainGraph } from "../src/components/explain-graph";
import type { MongJsonTree } from "../src/components/json-tree";
import { explainFlow } from "../src/lib/explain-flow";
import type { PlanNode } from "../src/lib/explain";

afterEach(() => { document.body.replaceChildren(); });

async function mount(explain: PlanNode) {
  const graph = new MongExplainGraph();
  graph.explain = explain;
  graph.query = { text: { path: "name", query: "Foxes" } };
  document.body.append(graph);
  await graph.updateComplete;
  return graph;
}

function card(graph: MongExplainGraph, title: string): HTMLButtonElement {
  const result = [...graph.querySelectorAll<HTMLButtonElement>(".explain-graph-node")]
    .find((node) => node.querySelector(".explain-graph-node-title")?.textContent === title);
  expect(result, title).toBeDefined();
  return result!;
}

async function open(graph: MongExplainGraph, title: string) {
  card(graph, title).click();
  await graph.updateComplete;
  const button = graph.querySelector<HTMLButtonElement>(".explain-graph-inspector .btn.secondary")!;
  button.click();
  await graph.updateComplete;
}

it("shows partition fan-out, actual merge timing, rewrite history, and cumulative segment work", async () => {
  const partition = {
    luceneQuery: [{ analyzed: "Foxes", rewritten: "fox" }, { analyzed: "fox*", rewritten: "fox | foxes" }],
    query: [{ type: "TermQuery", stats: { match: { millisElapsed: 4 } } }, { type: "MatchNoDocsQuery" }],
    joins: { execution: [{ id: 3, strategy: "adaptive", segments: [
      { ordinal: 0, costEstimation: { millisElapsed: 0 }, indexSetup: { millisElapsed: 1.3 } },
      { ordinal: 1, costEstimation: { millisElapsed: 0.001 }, counters: { probes: 3 } },
    ] }] },
  };
  const explain = {
    joins: { preparation: { timing: { millisElapsed: 5 }, sources: [{ id: 3, from: "foreign", keyCount: 20 }] } },
    indexPartitionExplain: [partition, { query: { type: "TermQuery" } }],
    aggregation: { partitionMerge: { millisElapsed: 0 } },
    resultMaterialization: { stats: { millisElapsed: 1.5 } },
  };
  const graph = await mount(explain);
  expect(card(graph, "Partition 1").parentElement).toBe(card(graph, "Partition 2").parentElement);
  expect(card(graph, "Merge index partitions").textContent).toContain("0.00 ms");
  expect(graph.querySelectorAll(".explain-graph-edges")).toHaveLength(4);

  await open(graph, "Partition 1");
  expect(card(graph, "Match term").textContent).toContain("4.0 ms");
  expect(card(graph, "No documents").textContent).toContain("—");
  await open(graph, "Lucene rewrites");
  await open(graph, "Rewrite 2");
  expect(card(graph, "Analyze query").textContent).toContain("fox*");
  card(graph, "Rewrite query").click();
  await graph.updateComplete;
  expect(graph.querySelector(".explain-graph-data pre")?.textContent).toBe("fox | foxes");

  const back = [...graph.querySelectorAll<HTMLButtonElement>("nav button")].find((button) => button.textContent === "Partition 1")!;
  back.click();
  await graph.updateComplete;
  await open(graph, "Execute join · #3");
  expect(card(graph, "Segment 0").textContent).toContain("Cost 0.00 ms · Setup 1.3 ms");
  expect(card(graph, "Segment 1").textContent).toContain("1 µs");
  expect(graph.querySelector(".explain-graph-edges")).toBeTruthy();
  card(graph, "Segment 1").click();
  await graph.updateComplete;
  const data = graph.querySelector<MongJsonTree>("mong-json-tree")!;
  const counters = [...data.querySelectorAll(".jt-row")].find((row) => row.textContent?.includes("counters"))!;
  counters.querySelector("button")?.click();
  await data.updateComplete;
  expect(data.textContent).toContain("probes");

  const updated = structuredClone(partition);
  updated.joins.execution[0].segments[1].costEstimation.millisElapsed = 2;
  updated.joins.execution[0].segments.reverse();
  graph.explain = { ...explain, indexPartitionExplain: [updated, explain.indexPartitionExplain[1]] };
  await graph.updateComplete;
  expect(graph.querySelector(".explain-graph-timings")?.textContent).toContain("2.0 ms");
});

it("keeps the lifted mongot plan inside the MongoDB stage, with vector segment timings", async () => {
  const graph = await mount({
    query: { type: "WrappedKnnQuery" },
    luceneVectorSegmentStats: [{ id: "_a", executionType: "Approximate", approximateStage: { millisElapsed: 1.5 } }],
    mongod: { stages: [
      { $_internalSearchMongotRemote: { mongotQuery: {} }, executionTimeMillisEstimate: 12, nReturned: 8 },
      { $_internalSearchIdLookup: {}, executionTimeMillisEstimate: 14 },
    ] },
  });
  expect(card(graph, "$_internalSearchMongotRemote").textContent).toContain("≈12.0 ms");
  expect(card(graph, "$_internalSearchIdLookup").textContent).toContain("≈14.0 ms");
  await open(graph, "$_internalSearchMongotRemote");
  await open(graph, "Vector segment search");
  expect(card(graph, "Segment _a").textContent).toContain("1.5 ms");
});

it("connects shard plans to the reported merge pipeline and keeps planner-only stages untimed", () => {
  const flow = explainFlow({ mongod: {
    shards: { a: { stages: [{ $search: { explain: { query: { type: "TermQuery" } } } }] }, b: { stages: [{ $limit: 10 }] } },
    splitPipeline: { shardsPart: [{ $search: {} }], mergerPart: [{ $mergeCursors: {} }, { $limit: 10 }] },
  } }, null, "test");
  expect(flow.columns.map((column) => column.map((node) => node.title))).toEqual([["a", "b"], ["$mergeCursors"], ["$limit"]]);
  expect(flow.columns[1][0].timings).toEqual([]);
  expect(flow.columns[0][0].flow?.columns[0][0].flow?.columns[0][0].title).toBe("Match term");

  const partitions = explainFlow({ indexPartitionExplain: [{}, {}] }, null, "test");
  expect(partitions.columns.at(-1)?.[0]).toMatchObject({ title: "Combine partition results", data: undefined });
});
