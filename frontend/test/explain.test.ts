import { describe, expect, it } from "vitest";
import {
  explainJoins, explainPlans, joinTotals, nodeMillis, nodeTitle, planMaxMillis, predicateSummary,
} from "../src/lib/explain";

const source = { id: 0, from: "accounts_search", foreignIndexId: "accounts", selfJoin: false,
  localField: "account_id", foreignField: "_id", keyType: "TOKEN", keyCount: 7958 };
const query = { compound: {
  filter: [{ join: { from: "accounts_search", localField: "account_id", foreignField: "_id",
    operator: { text: { path: "description", query: "software" } } } }],
  must: [{ text: { path: "full_name", query: "nancy" } }],
} };
const execution = { id: 0, strategy: "adaptive", keyCount: 7958, segments: [
  { ordinal: 0, strategyCounts: { docValuesProbe: 1, postings: 0 }, counters: { probes: 100, probeMatches: 2, fallbacks: 0 } },
] };

describe("join explain normalization", () => {
  it("joins foreign preparation and execution by ID and retains the submitted predicate", () => {
    const [join] = explainJoins({ joins: { preparation: { sources: [source] }, execution: [execution] } }, query);
    expect(join.source.keyCount).toBe(7958);
    expect(predicateSummary(join.submitted?.operator)).toBe('text · description: "software"');
    expect(predicateSummary(query)).toBe('must: text · full_name: "nancy"');
    expect(joinTotals(join)).toEqual({ segments: 1, strategies: { docValuesProbe: 1, postings: 0 }, counters: { probes: 100, probeMatches: 2, fallbacks: 0 } });
  });

  it("combines current segment snapshots across partitions without multiplying the foreign key count", () => {
    const explain = { joins: { preparation: { sources: [source] } }, indexPartitionExplain: [
      { joins: { execution: [execution] } }, { joins: { execution: [execution] } },
    ] };
    const [join] = explainJoins(explain, query);
    expect(join.source.keyCount).toBe(7958);
    expect(join.executions.map((item) => item.partition)).toEqual(["1", "2"]);
    expect(joinTotals(join).counters.probes).toBe(200);
    expect(joinTotals(join).segments).toBe(2);
  });

  it("does not assign an ambiguous submitted predicate to a source", () => {
    const second = { ...query.compound.filter[0].join, operator: { text: { path: "description", query: "banking" } } };
    const [join] = explainJoins({ joins: { preparation: { sources: [source] } } },
      { compound: { filter: [...query.compound.filter, { join: second }] } });
    expect(join.submitted).toBeUndefined();
  });

  it("renders declared joins without inventing counters when server diagnostics are absent", () => {
    const [join] = explainJoins({}, query);
    expect(join.source.keyCount).toBeUndefined();
    expect(joinTotals(join).segments).toBe(0);
    expect(predicateSummary(join.submitted?.operator)).toContain("software");
  });

  it("retains self joins and exclusion semantics", () => {
    const [join] = explainJoins({}, { compound: { mustNot: [{ join: {
      localField: "manager_id", foreignField: "_id", operator: { exists: { path: "name" } },
    } }] } });
    expect(join.source.selfJoin).toBe(true);
    expect(join.submitted?.exclude).toBe(true);
  });
});

describe("local plan timing", () => {
  it("normalizes against the heaviest node, including child work greater than the root timer", () => {
    const plans = explainPlans({ query: { type: "BooleanQuery", stats: { context: { millisElapsed: 2.9 } },
      args: { filter: [{ type: "DefaultQuery", args: { queryType: "AdaptiveJoinQuery" }, stats: { match: { millisElapsed: 217 } } }] },
    } });
    expect(planMaxMillis(plans)).toBe(217);
    expect(nodeMillis(plans[0].node)).toBe(2.9);
    expect(nodeTitle(plans[0].node.args.filter[0])).toBe("Join membership");
  });

  it("finds partition plans when there is no top-level query", () => {
    const plans = explainPlans({ indexPartitionExplain: [
      { query: { type: "TermQuery", stats: { match: { millisElapsed: 12 } } } },
      { query: { type: "TermQuery", stats: { match: { millisElapsed: 4 } } } },
    ] });
    expect(plans.map((plan) => plan.label)).toEqual(["Partition 1", "Partition 2"]);
    expect(planMaxMillis(plans)).toBe(12);
  });

  it("ignores non-finite and missing timing values", () => {
    expect(nodeMillis({ stats: { context: { millisElapsed: NaN }, match: { millisElapsed: Infinity } } })).toBe(0);
    expect(planMaxMillis([])).toBe(0);
  });
});
