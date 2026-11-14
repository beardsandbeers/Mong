import assert from "node:assert/strict";
import test from "node:test";

import { contextAt } from "../../src/mong/web/static/js/query-editor/context.js";
import { queryCompletion } from "../../src/mong/web/static/js/query-editor/complete.js";
import { lintQuery } from "../../src/mong/web/static/js/query-editor/lint.js";
import { labels, withCursor } from "./helpers.js";

const INDEXES = [
  {
    index_id: "idx-search",
    name: "accounts_search",
    type: "SEARCH",
    definition: {
      mappings: {
        dynamic: true,
        fields: {
          account_id: { type: "token" },
          title: { type: "string" },
        },
      },
    },
  },
  {
    index_id: "idx-vector",
    name: "accounts_vector",
    type: "VECTOR_SEARCH",
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" },
        { type: "filter", path: "status" },
      ],
    },
  },
];

function model(extra = {}) {
  return { mode: "search", indexes: INDEXES, indexId: "idx-search", mappings: {}, ...extra };
}

function messages(text, queryModel = model()) {
  const { state } = withCursor(text.includes("|") ? text : `${text}|`);
  return lintQuery(state, queryModel).map((item) => item.message);
}

test("context paths follow operators, compound clauses, and values", () => {
  const key = contextAt(...Object.values(withCursor('{ "|"}')));
  assert.equal(key.kind, "key");
  assert.deepEqual(key.objectPath, []);

  const path = contextAt(...Object.values(withCursor('{ "text": { "path": "|title" } }')));
  assert.equal(path.kind, "value");
  assert.equal(path.key, "path");
  assert.deepEqual(path.objectPath, ["text"]);

  const nested = contextAt(...Object.values(withCursor(
    '{ "compound": { "must": [ { "text": { "path": "ti|tle" } } ] } }',
  )));
  assert.equal(nested.kind, "value");
  assert.deepEqual(nested.objectPath, ["compound", "must", 0, "text"]);
  assert.equal(nested.partial, "ti");
});

test("root keys offer operators and index, and path values follow field types", () => {
  const root = queryCompletion({ ...withCursor('{ "|"}'), explicit: true }, model());
  const rootLabels = labels(root);
  assert.equal(rootLabels.includes("text"), true);
  assert.equal(rootLabels.includes("equals"), true);
  assert.equal(rootLabels.includes("index"), true);
  assert.equal(rootLabels.includes("returnStoredSource"), true);

  const textPaths = labels(queryCompletion(
    { ...withCursor('{ "text": { "path": "|" } }'), explicit: true },
    model(),
  ));
  assert.equal(textPaths.includes("title"), true);
  assert.equal(textPaths.includes("account_id"), false);

  const equalsPaths = labels(queryCompletion(
    { ...withCursor('{ "equals": { "path": "|" } }'), explicit: true },
    model(),
  ));
  assert.equal(equalsPaths.includes("account_id"), true);
  assert.equal(equalsPaths.includes("title"), false);

  const indexes = labels(queryCompletion(
    { ...withCursor('{ "index": "|" }'), explicit: true },
    model(),
  ));
  assert.deepEqual(indexes, ["accounts_search"]);

  const vectorIndexes = labels(queryCompletion(
    { ...withCursor('{ "index": "|" }'), explicit: true },
    model({ mode: "vector", indexId: "idx-vector" }),
  ));
  assert.deepEqual(vectorIndexes, ["accounts_vector"]);
});

test("vector filter completions are filter fields and MQL operators", () => {
  const fields = labels(queryCompletion(
    { ...withCursor('{ "filter": { "|" } }'), explicit: true },
    model({ mode: "vector", indexId: "idx-vector" }),
  ));
  assert.equal(fields.includes("status"), true);
  assert.equal(fields.includes("$and"), true);
  assert.equal(fields.includes("equals"), false);

  const operators = labels(queryCompletion(
    { ...withCursor('{ "filter": { "status": { "|" } } }'), explicit: true },
    model({ mode: "vector", indexId: "idx-vector" }),
  ));
  assert.equal(operators.includes("$eq"), true);
  assert.equal(operators.includes("$in"), true);
  assert.equal(operators.includes("text"), false);
});

test("lint rejects text on token, equals on a dynamic string, and unknown indexes", () => {
  const sampled = model({
    mappings: {
      "idx-search": {
        dynamic: false,
        fields: {
          account_id: { type: "token" },
          title: { type: "string" },
          notes: { type: "string" },
        },
      },
    },
  });
  assert.equal(
    messages('{ "text": { "path": "account_id", "query": "a" } }').some((message) => message.includes("text cannot query")),
    true,
  );
  assert.equal(
    messages('{ "equals": { "path": "notes", "value": "hello" } }', sampled)
      .some((message) => message.includes("equals cannot query")),
    true,
  );
  assert.equal(
    messages('{ "index": "missing", "text": { "path": "title", "query": "a" } }')
      .some((message) => message.includes('Unknown index "missing"')),
    true,
  );
  assert.equal(
    messages('{ "text": { "path": "title", "query": "coffee" } }').some((message) => message.includes("cannot query")),
    false,
  );
});

test("lint checks vector dimensions, candidate counts, and filter fields", () => {
  const vector = model({ mode: "vector", indexId: "idx-vector" });
  const issues = messages(`{
    "path": "embedding",
    "queryVector": [0.1, 0.2],
    "numCandidates": 5,
    "limit": 10
  }`, vector);
  assert.equal(issues.some((message) => message.includes("2 dimensions")), true);
  assert.equal(issues.some((message) => message.includes("numCandidates")), true);

  const filter = messages(`{
    "path": "embedding",
    "queryVector": [0.1, 0.2, 0.3],
    "limit": 10,
    "filter": { "embedding": "x" }
  }`, vector);
  assert.equal(filter.some((message) => message.includes("not a filter field")), true);
  const okFilter = messages(`{
    "path": "embedding",
    "queryVector": [0.1, 0.2, 0.3],
    "limit": 10,
    "filter": { "status": { "$eq": "open" } }
  }`, vector);
  assert.equal(okFilter.some((message) => message.includes("filter")), false);
});

test("opportunities_search mapping offers account_id for equals only", () => {
  const opportunities = model({
    indexes: [{
      index_id: "opp",
      name: "opportunities_search",
      type: "SEARCH",
      definition: {
        mappings: {
          dynamic: true,
          fields: {
            _id: { type: "token" },
            account_id: { type: "token" },
            contact_ids: { type: "token" },
            primary_contact_id: { type: "token" },
          },
        },
      },
    }],
    indexId: "opp",
    mappings: {
      opp: {
        dynamic: false,
        fields: {
          account_id: { type: "token" },
          name: { type: "string" },
          amount: { type: "number" },
          stage: { type: "string" },
        },
      },
    },
  });
  const equalsPaths = labels(queryCompletion(
    { ...withCursor('{ "equals": { "path": "|" } }'), explicit: true },
    opportunities,
  ));
  assert.equal(equalsPaths.includes("account_id"), true);
  assert.equal(equalsPaths.includes("name"), false);
  const textPaths = labels(queryCompletion(
    { ...withCursor('{ "text": { "path": "|" } }'), explicit: true },
    opportunities,
  ));
  assert.equal(textPaths.includes("name"), true);
  assert.equal(textPaths.includes("account_id"), false);
  assert.equal(
    messages('{ "text": { "path": "account_id", "query": "a" } }', opportunities)
      .some((message) => message.includes("text cannot query")),
    true,
  );
});

test("wildcard on an analyzed string requires allowAnalyzedField", () => {
  const blocked = messages('{ "wildcard": { "path": "title", "query": "cof*" } }');
  assert.equal(blocked.some((message) => message.includes("allowAnalyzedField")), true);
  const allowed = messages('{ "wildcard": { "path": "title", "query": "cof*", "allowAnalyzedField": true } }');
  assert.equal(allowed.some((message) => message.includes("allowAnalyzedField")), false);
});
