import { describe, expect, it, vi } from "vitest";
import { importFile } from "../src/lib/importer";

const ndjson = (docs: unknown[]) => new Blob([docs.map((doc) => JSON.stringify(doc)).join("\n")]);

describe("importFile", () => {
  it("upserts NDJSON in batches and reports bad records", async () => {
    const text = ['{"_id":1}', '{"_id":2}', "not json", '{"no_id":true}', "[1,2]", '{"_id":3}', '{"_id":4}', '{"_id":5}'].join("\n");
    const batches: unknown[][] = [];
    const upsert = vi.fn(async (docs: Record<string, unknown>[]) => {
      batches.push(docs.map((doc) => doc._id));
      return { indexed_count: docs.length };
    });
    const summary = await importFile(new Blob([text]), { upsert, signal: new AbortController().signal, batchSize: 2 });
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(summary.sent).toBe(5);
    expect(summary.read).toBe(8);
    expect(summary.problems.map((p) => p.where)).toEqual(["record 3", "record 4", "record 5"]);
    expect(summary.problems[1].message).toBe("Missing _id");
    expect(summary.cancelled).toBe(false);
    expect(summary.stopped).toBeNull();
  });

  it("reads a JSON array file", async () => {
    const upsert = vi.fn(async (docs: Record<string, unknown>[]) => ({ indexed_count: docs.length }));
    const file = new Blob([JSON.stringify([{ _id: "a", n: [1, 2] }, { _id: "b", s: "x,]" }])]);
    const summary = await importFile(file, { upsert, signal: new AbortController().signal });
    expect(summary.sent).toBe(2);
    expect(upsert.mock.calls[0][0]).toEqual([{ _id: "a", n: [1, 2] }, { _id: "b", s: "x,]" }]);
    expect(summary.bytes).toBe(file.size);
  });

  it("keeps going after a failed batch and stops after repeated failures", async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ _id: i }));
    let calls = 0;
    const flaky = vi.fn(async (batch: Record<string, unknown>[]) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { indexed_count: batch.length };
    });
    const once = await importFile(ndjson(docs), { upsert: flaky, signal: new AbortController().signal, batchSize: 4 });
    expect(once.sent).toBe(6);
    expect(once.problems).toEqual([{ where: "records 1–4", message: "boom" }]);
    expect(once.stopped).toBeNull();

    const broken = vi.fn(async () => {
      throw new Error("down");
    });
    const stopped = await importFile(ndjson(docs), { upsert: broken, signal: new AbortController().signal, batchSize: 2, maxFailures: 2 });
    expect(broken).toHaveBeenCalledTimes(2);
    expect(stopped.sent).toBe(0);
    expect(stopped.stopped).toMatch(/2 failed batches/);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const docs = Array.from({ length: 10 }, (_, i) => ({ _id: i }));
    const upsert = vi.fn(async (batch: Record<string, unknown>[]) => {
      controller.abort();
      return { indexed_count: batch.length };
    });
    const summary = await importFile(ndjson(docs), { upsert, signal: controller.signal, batchSize: 3 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(3);
    expect(summary.cancelled).toBe(true);
  });
});
