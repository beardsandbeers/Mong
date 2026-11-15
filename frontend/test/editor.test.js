import assert from "node:assert/strict";
import test from "node:test";

import { formatJson } from "../../src/mong/web/static/js/query-editor/json-editor.js";
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

test("formatJson pretty-prints a search query and keeps key order", () => {
  assert.equal(
    formatJson('{"text":{"query":"coffee","path":"title"}}'),
    '{\n  "text": {\n    "query": "coffee",\n    "path": "title"\n  }\n}',
  );
  assert.throws(() => formatJson("{"), SyntaxError);
});

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

test("unclosed strings keep completing keys, values, and array operators", () => {
  const key = contextAt(...Object.values(withCursor('{\n  "com|\n}')));
  assert.equal(key.kind, "key");
  assert.equal(key.enclose, "quotes");
  assert.equal(key.partial, "com");
  assert.deepEqual(
    labels(queryCompletion({ ...withCursor('{\n  "com|\n}'), explicit: false }, model())),
    ["compound"],
  );

  const nested = contextAt(...Object.values(withCursor('{\n  "compound": {\n    "mus|\n  }\n}')));
  assert.equal(nested.partial, "mus");
  assert.deepEqual(nested.objectPath, ["compound"]);
  const nestedLabels = labels(queryCompletion({
    ...withCursor('{\n  "compound": {\n    "mus|\n  }\n}'),
    explicit: false,
  }, model()));
  assert.equal(nestedLabels.includes("must"), true);
  assert.equal(nestedLabels.includes("mustNot"), true);

  const path = labels(queryCompletion({
    ...withCursor('{\n  "text": { "path": "ti|\n  }\n}'),
    explicit: false,
  }, model()));
  assert.equal(path.includes("title"), true);
  assert.equal(path.includes("account_id"), false);

  const clause = labels(queryCompletion({
    ...withCursor('{\n  "compound": { "must": [ "tex|\n  ] }\n}'),
    explicit: false,
  }, model()));
  assert.equal(clause.includes("text"), true);
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

const JOIN_INDEXES = [
  {
    index_id: "idx-contacts",
    name: "contacts_search",
    type: "SEARCH",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          account_id: { type: "token" },
          title: { type: "string" },
        },
      },
    },
  },
  {
    index_id: "idx-accounts",
    name: "accounts_search",
    type: "SEARCH",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          account_id: { type: "token" },
          region: { type: "token" },
        },
      },
    },
  },
  {
    index_id: "idx-vector",
    name: "accounts_vector",
    type: "VECTOR_SEARCH",
    definition: {
      fields: [{ type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" }],
    },
  },
];

function joinModel(extra = {}) {
  return model({ indexes: JOIN_INDEXES, indexId: "idx-contacts", ...extra });
}

test("join is offered in compound.filter and mustNot, not must or root", () => {
  const q = joinModel();
  const filter = labels(queryCompletion({
    ...withCursor('{ "compound": { "filter": [ { "|" } ] } }'),
    explicit: true,
  }, q));
  assert.equal(filter.includes("join"), true);
  assert.equal(filter.includes("text"), true);

  const mustNot = labels(queryCompletion({
    ...withCursor('{ "compound": { "mustNot": [ { "|" } ] } }'),
    explicit: true,
  }, q));
  assert.equal(mustNot.includes("join"), true);

  const must = labels(queryCompletion({
    ...withCursor('{ "compound": { "must": [ { "|" } ] } }'),
    explicit: true,
  }, q));
  assert.equal(must.includes("join"), false);

  const root = labels(queryCompletion({ ...withCursor('{ "|"}'), explicit: true }, q));
  assert.equal(root.includes("join"), false);
});

test("join from and field completions use search indexes and token or objectId paths", () => {
  const q = joinModel();
  const from = labels(queryCompletion({
    ...withCursor('{ "compound": { "filter": [ { "join": { "from": "|" } } ] } }'),
    explicit: true,
  }, q));
  assert.equal(from.includes("accounts_search"), true);
  assert.equal(from.includes("contacts_search"), true);
  assert.equal(from.includes("accounts_vector"), false);

  const local = labels(queryCompletion({
    ...withCursor('{ "compound": { "filter": [ { "join": { "localField": "|" } } ] } }'),
    explicit: true,
  }, q));
  assert.equal(local.includes("account_id"), true);
  assert.equal(local.includes("title"), false);

  const foreign = labels(queryCompletion({
    ...withCursor('{ "compound": { "filter": [ { "join": { "from": "accounts_search", "foreignField": "|" } } ] } }'),
    explicit: true,
  }, q));
  assert.equal(foreign.includes("account_id"), true);
  assert.equal(foreign.includes("region"), true);
  assert.equal(foreign.includes("title"), false);

  const foreignPath = labels(queryCompletion({
    ...withCursor('{ "compound": { "filter": [ { "join": { "from": "accounts_search", "operator": { "equals": { "path": "|" } } } } ] } }'),
    explicit: true,
  }, q));
  assert.equal(foreignPath.includes("region"), true);
  assert.equal(foreignPath.includes("title"), false);
});

test("join localField uses the selected index when the foreign index lacks that field", () => {
  const contacts = {
    index_id: "idx-contacts",
    name: "contacts_search",
    type: "SEARCH",
    definition: {
      mappings: {
        dynamic: true,
        fields: {
          _id: { type: "token" },
          account_id: { type: "token" },
        },
      },
    },
  };
  const accounts = {
    index_id: "idx-accounts",
    name: "accounts_search",
    type: "SEARCH",
    definition: {
      mappings: { dynamic: true, fields: { _id: { type: "token" } } },
    },
  };
  const q = model({
    indexes: [contacts, accounts],
    indexId: "idx-contacts",
    mappings: {
      "idx-contacts": {
        dynamic: false,
        fields: {
          _id: { type: "token" },
          account_id: { type: "token" },
          full_name: { type: "string" },
        },
      },
      "idx-accounts": {
        dynamic: false,
        fields: { _id: { type: "token" }, name: { type: "string" } },
      },
    },
  });
  const issues = messages(`{
    "compound": {
      "filter": [{
        "join": {
          "from": "accounts_search",
          "localField": "account_id",
          "foreignField": "_id",
          "operator": { "equals": { "path": "", "value": "" } }
        }
      }],
      "must": [{ "text": { "path": "full_name", "query": "andrea" } }]
    }
  }`, q);
  assert.equal(issues.some((message) => message.includes("account_id")), false);
  assert.equal(issues.some((message) => message.includes("full_name")), false);
  assert.equal(issues.some((message) => message.includes('Unknown index')), false);
  assert.equal(issues.some((message) => message === "Path is empty"), true);
});

test("lint accepts a cross-index join and rejects bad placements and keys", () => {
  const q = joinModel();
  const ok = messages(`{
    "compound": {
      "must": [{ "text": { "path": "title", "query": "architect" } }],
      "filter": [{
        "join": {
          "from": "accounts_search",
          "localField": "account_id",
          "foreignField": "account_id",
          "operator": { "equals": { "path": "region", "value": "Berlin" } }
        }
      }]
    }
  }`, q);
  assert.equal(ok.some((message) => message.includes("join") || message.includes("cannot query")), false);

  assert.equal(
    messages('{ "join": { "localField": "account_id", "foreignField": "account_id", "operator": { "exists": { "path": "account_id" } } } }', q)
      .some((message) => message.includes("compound.filter")),
    true,
  );
  assert.equal(
    messages('{ "compound": { "must": [{ "join": { "localField": "account_id", "foreignField": "account_id", "operator": { "exists": { "path": "account_id" } } } }] } }', q)
      .some((message) => message.includes("compound.filter")),
    true,
  );
  assert.equal(
    messages(`{
      "compound": {
        "filter": [{
          "join": {
            "from": "accounts_vector",
            "localField": "account_id",
            "foreignField": "account_id",
            "operator": { "exists": { "path": "account_id" } }
          }
        }]
      }
    }`, q).some((message) => message.includes("VECTOR_SEARCH")),
    true,
  );
  assert.equal(
    messages(`{
      "compound": {
        "filter": [{
          "join": {
            "from": "accounts_search",
            "localField": "title",
            "foreignField": "account_id",
            "operator": { "equals": { "path": "region", "value": "Berlin" } }
          }
        }]
      }
    }`, q).some((message) => message.includes("token")),
    true,
  );
});

test("join accepts an objectId key and still rejects a string key", () => {
  const contacts = {
    index_id: "idx-contacts",
    name: "contacts_search",
    type: "SEARCH",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          _id: { type: "objectId" },
          title: { type: "string" },
        },
      },
    },
  };
  const accounts = {
    index_id: "idx-accounts",
    name: "accounts_search",
    type: "SEARCH",
    definition: {
      mappings: { dynamic: false, fields: { _id: { type: "objectId" }, region: { type: "token" } } },
    },
  };
  const q = model({ indexes: [contacts, accounts], indexId: "idx-contacts" });
  const local = labels(queryCompletion({
    ...withCursor('{ "compound": { "filter": [ { "join": { "localField": "|" } } ] } }'),
    explicit: true,
  }, q));
  assert.equal(local.includes("_id"), true);
  assert.equal(local.includes("title"), false);
  const ok = messages(`{
    "compound": {
      "filter": [{
        "join": {
          "from": "accounts_search",
          "localField": "_id",
          "foreignField": "_id",
          "operator": { "equals": { "path": "region", "value": "Berlin" } }
        }
      }]
    }
  }`, q);
  assert.equal(ok.some((message) => message.includes("cannot query") || message.includes("objectId")), false);
});
