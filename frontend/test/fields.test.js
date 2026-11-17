import assert from "node:assert/strict";
import { test } from "vitest";

import {
  FieldIndex,
  clearMappingCache,
  loadMappings,
  typesCompatible,
} from "../src/editors/fields.js";

test("flattens static, multi-type, nested, and multi-analyzer fields", () => {
  const index = FieldIndex.compile({
    mappings: {
      dynamic: false,
      fields: {
        title: [{ type: "string" }, { type: "token" }],
        account_id: { type: "token" },
        address: {
          type: "document",
          dynamic: false,
          fields: { city: { type: "string", multi: { keyword: { type: "string", analyzer: "lucene.keyword" } } } },
        },
        items: {
          type: "embeddedDocuments",
          fields: { name: { type: "string" } },
        },
      },
    },
  });

  const title = index.lookup("title");
  assert.equal(title.origin, "mapped");
  assert.deepEqual([...title.types].sort(), ["string", "token"]);
  assert.equal(index.lookup("account_id").origin, "mapped");
  assert.equal(index.lookup("address.city").multis.includes("keyword"), true);
  assert.equal(index.lookup("items.name").origin, "mapped");
  assert.equal(index.lookup("address.zip").allowed, false);
  assert.equal(index.lookup("notes").allowed, false);
  assert.equal(typesCompatible(title.types, ["string"]), true);
  assert.equal(typesCompatible(index.lookup("account_id").types, ["string"]), false);
});

test("dynamic mappings and type sets do not treat strings as token", () => {
  const index = FieldIndex.compile({
    mappings: { dynamic: { typeSet: "onlyStrings" } },
    typeSets: [{ name: "onlyStrings", types: [{ type: "string" }, { type: "stringFacet" }] }],
  });
  const notes = index.lookup("notes");
  assert.equal(notes.origin, "dynamic");
  assert.equal(notes.allowed, true);
  assert.deepEqual([...notes.types], ["string", "stringFacet"]);

  const open = FieldIndex.compile({ mappings: { dynamic: true } });
  assert.equal(open.lookup("title").types.size, 0);
  assert.equal(open.hasDynamic, true);
});

test("nested dynamic documents allow children and static documents do not", () => {
  const index = FieldIndex.compile({
    mappings: {
      dynamic: true,
      fields: {
        address: { type: "document", dynamic: false, fields: { city: { type: "string" } } },
      },
    },
  });
  assert.equal(index.lookup("address.city").origin, "mapped");
  assert.equal(index.lookup("address.zip").allowed, false);
  assert.equal(index.lookup("notes").allowed, true);
});

test("vector definitions keep dimensions and filter fields", () => {
  const index = FieldIndex.compile({
    fields: [
      { type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" },
      { type: "filter", path: "status" },
    ],
  }, "VECTOR_SEARCH");
  assert.equal(index.lookup("embedding").numDimensions, 3);
  assert.equal([...index.lookup("embedding").types][0], "vector");
  assert.equal([...index.lookup("status").types][0], "filter");
  assert.deepEqual(index.suggest(["vector"]).map((field) => field.path), ["embedding"]);
});

test("observed mappings add indexed fields and close dynamic mappings", () => {
  const index = FieldIndex.compile({
    mappings: { dynamic: true, fields: { account_id: { type: "token" } } },
  });
  index.applyObserved({
    dynamic: false,
    fields: {
      account_id: { type: "string" },
      name: { type: "string" },
      billing_address: {
        type: "document",
        dynamic: false,
        fields: { city: { type: "string" } },
      },
    },
  });
  assert.equal(index.lookup("account_id").origin, "mapped");
  assert.equal([...index.lookup("account_id").types][0], "token");
  assert.equal(index.lookup("name").origin, "indexed");
  assert.equal([...index.lookup("name").types][0], "string");
  assert.equal(index.lookup("billing_address.city").origin, "indexed");
  assert.equal(index.lookup("billing_address.zip").allowed, false);
  assert.equal(index.lookup("notes").allowed, false);
  assert.deepEqual(index.suggest(["string"]).map((field) => field.path), ["billing_address.city", "name"]);
  assert.equal(index.suggest(["token"]).some((field) => field.path === "name"), false);
});

test("loadMappings caches the exported mapping", async () => {
  clearMappingCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({ mappings: { dynamic: false, fields: { name: { type: "string" } } } }),
    };
  };
  const index = { index_id: "idx-1", generation_id: "gen-1" };
  const first = await loadMappings(index, fetchImpl);
  const second = await loadMappings(index, fetchImpl);
  assert.equal(first.fields.name.type, "string");
  assert.equal(second, first);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/indexes\/idx-1\/mappings\?generation_id=gen-1/);
});

test("MongoDB loads sampled suggestions and keeps unsampled dynamic paths open", async () => {
  clearMappingCache();
  const index = {
    index_id: "mongod:crm:contacts:contacts_search", source: "mongod", desired_revision: 0,
    definition: { mappings: { dynamic: true, fields: { account_id: { type: "token" } } } },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ source: "sampled", sample_size: 100, mappings: {
      dynamic: true, fields: {
        full_name: [{ type: "string" }],
        address: [{ type: "document", dynamic: true, fields: { city: [{ type: "string" }] } }],
      },
    } }) };
  };
  const mapping = await loadMappings(index, fetchImpl);
  const fields = FieldIndex.compile(index.definition).applyObserved(mapping);
  assert.equal(calls[0], "/api/indexes/mongod%3Acrm%3Acontacts%3Acontacts_search/field-suggestions");
  assert.equal(fields.lookup("full_name").origin, "sampled");
  assert.equal(fields.lookup("address.city").origin, "sampled");
  assert.equal(fields.lookup("address.zip").allowed, true);
  assert.equal(fields.lookup("rare_field").allowed, true);
  assert.deepEqual([...fields.lookup("account_id").types], ["token"]);
  assert.deepEqual(fields.suggest(["string"]).map((field) => field.path), ["address.city", "full_name"]);
  await loadMappings(index, fetchImpl);
  assert.equal(calls.length, 1);
  await loadMappings({ ...index, desired_revision: 1 }, fetchImpl);
  assert.equal(calls.length, 2);
});

test("failed suggestion requests can be retried", async () => {
  clearMappingCache();
  const index = { index_id: "mongod:crm:contacts:contacts_search", source: "mongod" };
  assert.equal(await loadMappings(index, async () => ({ ok: false })), null);
  const result = await loadMappings(index, async () => ({ ok: true, json: async () => ({ mappings: { dynamic: true } }) }));
  assert.equal(result.dynamic, true);
});
