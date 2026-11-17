// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { MongExplainTree } from "../src/components/explain-tree";

const query = { compound: {
  filter: [{ join: { from: "accounts_search", localField: "account_id", foreignField: "_id",
    operator: { text: { path: "description", query: "software" } } } }],
  must: [{ text: { path: "full_name", query: "nancy" } }],
} };
const explain = {
  metadata: { indexName: "contacts_search", lucene: { totalDocs: 42277757, totalSegments: 42 } },
  joins: { preparation: { timing: { millisElapsed: 21 }, sources: [
    { id: 0, from: "accounts_search", localField: "account_id", foreignField: "_id", keyType: "TOKEN",
      keyCount: 7958, keyBytes: 286488, reservedBytes: 15665088, collection: { millisElapsed: 20 } },
  ] }, execution: [{ id: 0, strategy: "adaptive", selectionReason: "sampledCost", exhaustive: true, segments: [
    { ordinal: 0, strategyCounts: { docValuesProbe: 1, postings: 0 }, counters: { probes: 100, probeMatches: 2, fallbacks: 0 }, costEstimation: { millisElapsed: 1.6 }, indexSetup: { millisElapsed: 0 } },
  ] }] },
  query: { type: "BooleanQuery", stats: { context: { millisElapsed: 2.9 } }, args: {
    filter: [{ type: "DefaultQuery", args: { queryType: "AdaptiveJoinQuery" }, stats: { match: { millisElapsed: 217 } } }],
    must: [{ type: "TermQuery", args: { path: "full_name", value: "nancy" }, stats: { match: { millisElapsed: 18.9 } } }],
  } },
  luceneQuery: { analyzed: "Boolean(Join, nancy)", rewritten: "Boolean(Join, nancy)" },
};

afterEach(() => { document.body.innerHTML = ""; });

async function mount(data = explain, submitted: Record<string, unknown> | null = query) {
  const element = new MongExplainTree();
  element.explain = data;
  element.query = submitted;
  element.requestMillis = 281;
  element.resultCount = { value: 1092, exact: true };
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("explain visualization", () => {
  it("shows both indexes, the foreign predicate, key relationship, strategy, and actual request timing", async () => {
    const element = await mount();
    const flow = element.querySelector(".explain-flow")!;
    expect(flow.textContent).toContain("accounts_search");
    expect(flow.textContent).toContain("contacts_search");
    expect(flow.textContent).toContain("description");
    expect(flow.textContent).toContain("software");
    expect(flow.textContent).toContain("nancy");
    expect(flow.textContent).toContain("7,958");
    expect(flow.querySelector(".explain-key-relation")!.textContent).toContain("_id→account_id");
    expect(element.textContent).toContain("Adaptive membership");
    expect(element.textContent).toContain("Last request 281 ms");
    expect(element.textContent).toContain("Probe matches");
    expect(element.textContent).toContain("not request latency");
    expect(element.querySelectorAll(".explain-row")).toHaveLength(3);
    const bars = [...element.querySelectorAll<HTMLElement>(".explain-row .bar")];
    expect(parseFloat(bars[0].style.width)).toBeLessThan(2);
    expect(bars[1].style.width).toBe("100%");
    expect(element.querySelector(".explain-segments tbody")!.children).toHaveLength(1);
  });

  it("keeps the local tree collapsible with an accessible toggle", async () => {
    const element = await mount();
    const toggle = element.querySelector<HTMLButtonElement>('.explain-row button[aria-expanded="true"]')!;
    toggle.click();
    await element.updateComplete;
    expect(element.querySelectorAll(".explain-row")).toHaveLength(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not fabricate a foreign query when only raw explain was supplied", async () => {
    const element = await mount(explain, null);
    expect(element.querySelector(".explain-flow")!.textContent).toContain("Foreign predicate is not included");
    expect(element.querySelector(".explain-flow")!.textContent).not.toContain("software");
  });

  it("renders partition plans and planner-only joins without zero-valued execution claims", async () => {
    const element = await mount({
      joins: { preparation: { sources: explain.joins.preparation.sources.map(({ collection: _collection, ...source }) => source) } },
      indexPartitionExplain: [
        { query: { type: "TermQuery", args: { path: "full_name", value: "nancy" } }, joins: { execution: [{ id: 0, strategy: "adaptive", selectionReason: "sampledCost" }] } },
        { query: { type: "TermQuery", args: { path: "full_name", value: "nancy" } } },
      ],
    } as any);
    expect(element.textContent).toContain("Partition 1");
    expect(element.textContent).toContain("Partition 2");
    expect(element.textContent).toContain("Segment counters are available with execution-level explain");
    expect(element.querySelector(".explain-metrics")!.textContent).not.toContain("Membership probes");
    expect(element.querySelector(".explain-metrics")!.textContent).not.toContain("0.00 ms");
    expect(element.querySelectorAll(".explain-row")).toHaveLength(2);
  });
});
