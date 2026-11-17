import { describe, expect, it } from "vitest";
import { capabilities, namespaceOf } from "../src/lib/capabilities";
import type { IndexInfo } from "../src/lib/types";

function index(overrides: Partial<IndexInfo>): IndexInfo {
  return {
    index_id: "abc",
    name: "people",
    type: "SEARCH",
    type_code: 1,
    desired_revision: 1,
    active_revision: 1,
    lifecycle_state: "READY",
    generation_id: null,
    failure_message: null,
    definition: { mappings: { dynamic: true } },
    ...overrides,
  };
}

const managed = (overrides: Partial<IndexInfo> = {}) =>
  index({
    index_id: "mongod:crm:accounts:accounts_search",
    name: "crm.accounts/accounts_search",
    source: "mongod",
    database: "crm",
    collection: "accounts",
    index_name: "accounts_search",
    ...overrides,
  });

describe("capabilities", () => {
  it("keeps standalone rules: browse needs stored source", () => {
    const caps = capabilities(index({ source: "mongot" }));
    expect(caps.readOnly).toBe(false);
    expect(caps.browse).toBe(false);
    expect(caps.reasons.browse).toContain("stored source");
    expect(namespaceOf(index({}))).toBeNull();
  });

  it("lets MongoDB-managed indexes browse their collection but not write", () => {
    const caps = capabilities(managed());
    expect(namespaceOf(managed())).toBe("crm.accounts");
    expect(caps.readOnly).toBe(true);
    expect(caps.browse).toBe(true);
    expect(caps.reasons.browse).toBeUndefined();
    expect(caps.search).toBe(true);
    expect(caps.editable).toBe(false);
    expect(caps.reasons.editable).toContain("crm.accounts");
    expect(caps.exportMappings).toBe(false);
  });

  it("browses MongoDB-managed vector indexes too", () => {
    const caps = capabilities(
      managed({ type: "VECTOR_SEARCH", definition: { fields: [{ type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" }] } }),
    );
    expect(caps.browse).toBe(true);
    expect(caps.vector).toBe(true);
    expect(caps.vectorFields).toEqual([{ path: "embedding", numDimensions: 3, similarity: "cosine" }]);
  });
});
