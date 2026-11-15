import assert from "node:assert/strict";
import test from "node:test";

import { definitionCompletion } from "../../src/mong/web/static/js/query-editor/definition-complete.js";
import { lintDefinition } from "../../src/mong/web/static/js/query-editor/definition-lint.js";
import { labels, withCursor } from "./helpers.js";

const FIELD_PATHS = [
  { path: "title", types: ["string"] },
  { path: "address.city", types: ["string"] },
  { path: "embedding", types: ["vector"] },
];

function model(extra = {}) {
  return { mode: "SEARCH", fieldPaths: FIELD_PATHS, ...extra };
}

function complete(text, definitionModel = model()) {
  return definitionCompletion({ ...withCursor(text), explicit: true }, definitionModel);
}

function issues(text, definitionModel = model()) {
  const source = text.includes("|") ? text : `${text}|`;
  const { state } = withCursor(source);
  return lintDefinition(state, definitionModel);
}

function errors(text, definitionModel = model()) {
  return issues(text, definitionModel).filter((item) => item.severity !== "warning").map((item) => item.message);
}

test("root and nested keys follow the definition, and synonyms are not offered", () => {
  const root = labels(complete('{ "|"}'));
  assert.equal(root.includes("mappings"), true);
  assert.equal(root.includes("analyzer"), true);
  assert.equal(root.includes("storedSource"), true);
  assert.equal(root.includes("synonyms"), false);

  const stringKeys = labels(complete(`{
    "mappings": { "fields": { "title": { "type": "string", "|" } } }
  }`));
  assert.equal(stringKeys.includes("analyzer"), true);
  assert.equal(stringKeys.includes("multi"), true);
  assert.equal(stringKeys.includes("normalizer"), false);
  assert.equal(stringKeys.includes("numDimensions"), false);

  const tokenKeys = labels(complete(`{
    "mappings": { "fields": { "id": { "type": "token", "|" } } }
  }`));
  assert.equal(tokenKeys.includes("normalizer"), true);
  assert.equal(tokenKeys.includes("analyzer"), false);
});

test("field type values depend on the index kind", () => {
  const searchTypes = labels(complete(`{
    "mappings": { "fields": { "title": { "type": "|" } } }
  }`));
  assert.equal(searchTypes.includes("string"), true);
  assert.equal(searchTypes.includes("knnVector"), true);
  assert.equal(searchTypes.includes("vector"), false);

  const vectorTypes = labels(complete(
    '{ "fields": [ { "type": "|" } ] }',
    model({ mode: "VECTOR_SEARCH" }),
  ));
  assert.equal(vectorTypes.includes("vector"), true);
  assert.equal(vectorTypes.includes("filter"), true);
  assert.equal(vectorTypes.includes("string"), false);

  const vectorKeys = labels(complete(
    '{ "fields": [ { "type": "vector", "|" } ] }',
    model({ mode: "VECTOR_SEARCH" }),
  ));
  assert.equal(vectorKeys.includes("numDimensions"), true);
  assert.equal(vectorKeys.includes("similarity"), true);
  assert.equal(vectorKeys.includes("quantization"), true);
});

test("analyzer, type set, and field path values come from the definition and the index", () => {
  const analyzers = labels(complete(`{
    "analyzer": "|",
    "analyzers": [{ "name": "myAnalyzer", "tokenizer": { "type": "standard" } }]
  }`));
  assert.equal(analyzers.includes("lucene.standard"), true);
  assert.equal(analyzers.includes("lucene.keyword"), true);
  assert.equal(analyzers.includes("myAnalyzer"), true);

  const typeSets = labels(complete(`{
    "mappings": { "dynamic": { "typeSet": "|" } },
    "typeSets": [{ "name": "onlyStrings", "types": [{ "type": "string" }] }]
  }`));
  assert.deepEqual(typeSets, ["onlyStrings"]);

  const names = labels(complete('{ "mappings": { "fields": { "|" } } }'));
  assert.equal(names.includes("title"), true);
  assert.equal(names.includes("address"), true);
  assert.equal(names.includes("embedding"), true);

  const paths = labels(complete(
    '{ "fields": [ { "type": "vector", "path": "|" } ] }',
    model({ mode: "VECTOR_SEARCH" }),
  ));
  assert.equal(paths.includes("embedding"), true);
  assert.equal(paths.includes("title"), true);
});

test("lint rejects definitions mongot rejects and warns on unknown keys", () => {
  assert.equal(errors("{").some((message) => message.includes("valid JSON")), true);
  assert.equal(errors("[]").some((message) => message.includes("JSON object")), true);
  assert.equal(
    errors('{ "mappings": { "dynamic": "onlyStrings" } }').some((message) => message.includes("boolean or document")),
    true,
  );
  assert.equal(
    errors('{ "mappings": { "fields": { "v": { "type": "vector" } } } }')
      .some((message) => message.includes("not valid on a search index")),
    true,
  );
  assert.equal(
    errors('{ "fields": [{ "type": "vector", "path": "embedding", "similarity": "cosine" }] }', model({ mode: "VECTOR_SEARCH" }))
      .some((message) => message.includes("numDimensions")),
    true,
  );
  assert.equal(
    errors('{ "fields": [{ "type": "vector", "path": "embedding", "numDimensions": 8193, "similarity": "cosine" }] }', model({ mode: "VECTOR_SEARCH" }))
      .some((message) => message.includes("between 1 and 8192")),
    true,
  );
  assert.equal(
    errors('{ "mappings": { "fields": { "t": { "type": "autocomplete", "minGrams": 4, "maxGrams": 2 } } } }')
      .some((message) => message.includes("minGrams cannot be greater")),
    true,
  );
  assert.equal(
    errors('{ "mappings": { "fields": { "t": { "type": "string", "analyzer": "missing" } } } }')
      .some((message) => message.includes('Unknown analyzer "missing"')),
    true,
  );
  assert.equal(
    errors('{ "mappings": { "dynamic": true }, "synonyms": [{ "name": "s" }] }')
      .some((message) => message.includes("unsupported")),
    true,
  );
  assert.equal(
    errors('{ "storedSource": { "include": ["a"], "exclude": ["b"] }, "mappings": { "dynamic": true } }')
      .some((message) => message.includes("only set one of")),
    true,
  );

  const unknown = issues('{ "mappings": { "dynamic": true }, "notAKey": 1 }');
  assert.equal(unknown.some((item) => item.severity === "warning" && item.message.includes("notAKey")), true);
  assert.equal(unknown.some((item) => item.severity !== "warning"), false);
});

test("definitions this project already creates lint without errors", () => {
  const clean = [
    { mappings: { dynamic: true }, storedSource: true },
    {
      fields: [
        { type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" },
      ],
    },
    {
      mappings: {
        dynamic: true,
        fields: {
          account_id: { type: "token" },
          title: { type: "string" },
        },
      },
    },
    {
      fields: [
        { type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" },
        { type: "filter", path: "status" },
      ],
    },
    {
      mappings: {
        dynamic: false,
        fields: {
          title: [{ type: "string" }, { type: "token" }],
          account_id: { type: "token" },
          address: {
            type: "document",
            dynamic: false,
            fields: {
              city: {
                type: "string",
                multi: { keyword: { type: "string", analyzer: "lucene.keyword" } },
              },
            },
          },
          items: { type: "embeddedDocuments", fields: { name: { type: "string" } } },
        },
      },
    },
    {
      mappings: { dynamic: { typeSet: "onlyStrings" } },
      typeSets: [{ name: "onlyStrings", types: [{ type: "string" }, { type: "stringFacet" }] }],
    },
    { mappings: { dynamic: true } },
    {
      mappings: {
        dynamic: true,
        fields: {
          address: { type: "document", dynamic: false, fields: { city: { type: "string" } } },
        },
      },
    },
    {
      mappings: {
        dynamic: true,
        fields: {
          _id: { type: "token" },
          account_id: { type: "token" },
          opportunity_ids: { type: "token" },
        },
      },
      storedSource: true,
    },
    {
      analyzer: "myAnalyzer",
      mappings: { dynamic: true },
      analyzers: [{
        name: "myAnalyzer",
        charFilters: [{ type: "htmlStrip" }],
        tokenizer: { type: "whitespace", minGram: 2 },
        tokenFilters: [{ type: "lowercase" }],
      }],
    },
  ];

  for (const definition of clean) {
    const mode = definition.fields ? "VECTOR_SEARCH" : "SEARCH";
    const found = errors(JSON.stringify(definition), model({ mode }));
    assert.deepEqual(found, [], JSON.stringify(definition));
  }
});
