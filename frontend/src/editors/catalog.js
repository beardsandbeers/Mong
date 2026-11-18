/**
 * Mongot query language: operators, option keys, and which field types
 * each operator can query. Names match mongot's BSON operator keys.
 */

export const SORTABLE_TYPES = ["token", "number", "date", "boolean", "objectId", "uuid"];

export const UNKNOWN = { role: "unknown" };

const STRING = { kind: "stringish" };
const NUMBER = { kind: "number" };
const BOOL = { kind: "boolean" };
const ANY = { kind: "any" };

function pathSpec(explicitTypes) {
  return {
    kind: "path",
    types: explicitTypes || null,
    enter(parent) {
      return {
        role: "keys",
        operator: parent.operator || null,
        pathTypes: explicitTypes || parent.pathTypes || null,
        keySpecs: {
          value: { kind: "path-string", types: explicitTypes || null },
          multi: { kind: "multi" },
        },
        acceptsOperators: false,
      };
    },
  };
}

const PATH = pathSpec(null);

function leafObject(keySpecs) {
  return {
    kind: "object",
    enter: { role: "keys", keySpecs, acceptsOperators: false, pathTypes: null },
  };
}

const SCORE = leafObject({
  boost: leafObject({ value: NUMBER, path: PATH }),
  constant: leafObject({ value: NUMBER }),
  function: { kind: "object", enter: UNKNOWN },
});

const FUZZY = leafObject({
  maxEdits: { kind: "enum", values: [1, 2] },
  prefixLength: NUMBER,
  maxExpansions: NUMBER,
});

function withScore(options) {
  return { score: SCORE, ...options };
}

function operatorSlot(parent) {
  return {
    role: "keys",
    keySpecs: {},
    acceptsOperators: true,
    singleOperator: true,
    pathTypes: parent?.pathTypes || null,
    filterOperators: parent?.filterOperators || null,
    loose: false,
  };
}

function clauseArray(parent, { allowJoin = false } = {}) {
  const item = operatorSlot(parent);
  if (allowJoin) item.operatorSet = FILTER_OPERATORS;
  return { kind: "operators", enter: { role: "array", item } };
}

const SPAN_CLAUSES = {
  term: {
    name: "term",
    detail: "Span term",
    fieldTypes: ["string"],
    options: withScore({
      path: { ...pathSpec(["string"]), required: true },
      query: { ...STRING, required: true },
      end: NUMBER,
    }),
    template: { path: "", query: "" },
  },
  first: { name: "first", detail: "Span first", fieldTypes: ["string"], loose: true, options: {}, template: {} },
  near: { name: "near", detail: "Span near", fieldTypes: ["string"], loose: true, options: {}, template: {} },
  or: { name: "or", detail: "Span or", fieldTypes: ["string"], loose: true, options: {}, template: {} },
  subtract: { name: "subtract", detail: "Span subtract", fieldTypes: ["string"], loose: true, options: {}, template: {} },
  contains: { name: "contains", detail: "Span contains", fieldTypes: ["string"], loose: true, options: {}, template: {} },
};

function defineOperator(name, fieldTypes, options, extra = {}) {
  return {
    name,
    fieldTypes,
    detail: extra.detail || name,
    options,
    loose: Boolean(extra.loose),
    template: extra.template || null,
    required: extra.required || null,
    requireAny: extra.requireAny || null,
  };
}

export const OPERATORS = {
  text: defineOperator("text", ["string"], withScore({
    path: { ...PATH, required: true },
    query: { ...STRING, required: true },
    fuzzy: FUZZY,
    matchCriteria: { kind: "enum", values: ["any", "all"] },
    synonyms: { kind: "string" },
  }), { detail: "Analyzed text" }),

  phrase: defineOperator("phrase", ["string"], withScore({
    path: { ...PATH, required: true },
    query: { ...STRING, required: true },
    slop: NUMBER,
    synonyms: { kind: "string" },
  }), { detail: "Ordered phrase" }),

  autocomplete: defineOperator("autocomplete", ["autocomplete"], withScore({
    path: { ...PATH, required: true },
    query: { ...STRING, required: true },
    tokenOrder: { kind: "enum", values: ["any", "sequential"] },
    fuzzy: FUZZY,
  }), { detail: "Search-as-you-type" }),

  equals: defineOperator("equals", ["token", "number", "date", "boolean", "objectId", "uuid"], withScore({
    path: { ...PATH, required: true },
    value: { ...ANY, required: true },
    doesNotAffect: STRING,
  }), { detail: "Exact value" }),

  in: defineOperator("in", ["token", "number", "date", "boolean", "objectId", "uuid"], withScore({
    path: { ...PATH, required: true },
    value: { kind: "array", required: true, template: [] },
    doesNotAffect: STRING,
  }), { detail: "Match any value" }),

  range: defineOperator("range", ["number", "date", "token", "objectId", "uuid"], withScore({
    path: { ...PATH, required: true },
    gt: ANY,
    gte: ANY,
    lt: ANY,
    lte: ANY,
    doesNotAffect: STRING,
  }), {
    detail: "Inclusive or exclusive range",
    template: { path: "", gte: 0 },
    requireAny: ["gt", "gte", "lt", "lte"],
  }),

  exists: defineOperator("exists", null, withScore({
    path: { ...PATH, required: true },
  }), { detail: "Field is present" }),

  wildcard: defineOperator("wildcard", ["string"], withScore({
    path: { ...PATH, required: true },
    query: { ...STRING, required: true },
    allowAnalyzedField: BOOL,
  }), { detail: "Wildcard pattern" }),

  regex: defineOperator("regex", ["string"], withScore({
    path: { ...PATH, required: true },
    query: { ...STRING, required: true },
    allowAnalyzedField: BOOL,
  }), { detail: "Regular expression" }),

  queryString: defineOperator("queryString", ["string"], withScore({
    defaultPath: { ...pathSpec(["string"]), required: true },
    query: { ...STRING, required: true },
  }), { detail: "Lucene query string" }),

  near: defineOperator("near", ["number", "date", "geo"], withScore({
    path: { ...PATH, required: true },
    origin: { ...ANY, required: true },
    pivot: { ...NUMBER, required: true, template: 1 },
  }), { detail: "Numeric, date, or geo proximity", template: { path: "", origin: 0, pivot: 1 } }),

  embeddedDocument: defineOperator("embeddedDocument", ["embeddedDocuments"], {
    path: { ...PATH, required: true },
    operator: {
      kind: "operator",
      required: true,
      enter(parent) {
        return operatorSlot(parent);
      },
    },
    score: SCORE,
  }, {
    detail: "Query embedded documents",
    template: { path: "", operator: { text: { path: "", query: "" } } },
  }),

  moreLikeThis: defineOperator("moreLikeThis", ["string"], withScore({
    like: { kind: "any", required: true, template: {} },
  }), { detail: "Documents similar to an example", template: { like: {} } }),

  geoWithin: defineOperator("geoWithin", ["geo"], withScore({
    path: { ...PATH, required: true },
    box: { kind: "object", enter: UNKNOWN },
    circle: { kind: "object", enter: UNKNOWN },
    geometry: { kind: "object", enter: UNKNOWN },
  }), {
    detail: "Geo point inside a shape",
    requireAny: ["box", "circle", "geometry"],
    template: {
      path: "",
      box: {
        bottomLeft: { type: "Point", coordinates: [0, 0] },
        topRight: { type: "Point", coordinates: [1, 1] },
      },
    },
  }),

  geoShape: defineOperator("geoShape", ["geo"], withScore({
    path: { ...PATH, required: true },
    relation: { kind: "enum", values: ["contains", "disjoint", "intersects", "within"], required: true },
    geometry: { kind: "object", required: true, enter: UNKNOWN, template: { type: "Polygon", coordinates: [] } },
  }), { detail: "Geo shape relation" }),

  knnBeta: defineOperator("knnBeta", ["vector"], withScore({
    path: { ...PATH, required: true },
    vector: { kind: "array", required: true, template: [0.1, 0.2, 0.3] },
    k: { ...NUMBER, required: true, template: 10 },
    filter: {
      kind: "operator",
      enter(parent) {
        return operatorSlot(parent);
      },
    },
  }), { detail: "Vector similarity (legacy)" }),

  compound: {
    name: "compound",
    detail: "Combine clauses",
    fieldTypes: null,
    loose: false,
    requireAny: ["must", "mustNot", "should", "filter"],
    template: { must: [{ text: { path: "", query: "" } }] },
    options(parent) {
      const scoring = clauseArray(parent);
      const filter = clauseArray(parent, { allowJoin: true });
      return withScore({
        must: scoring,
        mustNot: filter,
        should: scoring,
        filter,
        minimumShouldMatch: NUMBER,
        doesNotAffect: STRING,
      });
    },
  },

  hasAncestor: defineOperator("hasAncestor", null, withScore({
    ancestorPath: { ...PATH, required: true },
    operator: {
      kind: "operator",
      required: true,
      enter(parent) {
        return operatorSlot(parent);
      },
    },
  }), {
    detail: "Match an ancestor embedded document",
    template: { ancestorPath: "", operator: { text: { path: "", query: "" } } },
  }),

  hasRoot: defineOperator("hasRoot", null, withScore({
    operator: {
      kind: "operator",
      required: true,
      enter(parent) {
        return operatorSlot(parent);
      },
    },
  }), {
    detail: "Match the root from an embedded scope",
    template: { operator: { text: { path: "", query: "" } } },
  }),

  term: defineOperator("term", ["token", "string"], withScore({
    path: { ...PATH, required: true },
    query: { ...STRING, required: true },
    fuzzy: FUZZY,
  }), { detail: "Term query", loose: true }),

  search: defineOperator("search", ["string"], withScore({
    path: { ...PATH, required: true },
    query: { ...STRING, required: true },
    phrase: { kind: "object", enter: UNKNOWN },
    fuzzy: FUZZY,
    synonyms: { kind: "string" },
    matchCriteria: { kind: "enum", values: ["any", "all"] },
  }), { detail: "Search operator", loose: true }),

  span: {
    name: "span",
    detail: "Positional span query",
    fieldTypes: ["string"],
    template: { term: { path: "", query: "" } },
    enter: {
      role: "keys",
      acceptsOperators: true,
      singleOperator: true,
      operatorSet: SPAN_CLAUSES,
      keySpecs: {},
      pathTypes: null,
      filterOperators: null,
      loose: false,
    },
  },

  vectorSearch: defineOperator("vectorSearch", ["vector"], withScore({
    path: { ...pathSpec(["vector"]), required: true },
    queryVector: { kind: "array", required: true, template: [0.1, 0.2, 0.3] },
    limit: { ...NUMBER, required: true, template: 10 },
    numCandidates: { ...NUMBER, template: 50 },
    exact: BOOL,
    filter: {
      kind: "operator",
      enter(parent) {
        return operatorSlot(parent);
      },
    },
  }), { detail: "Vector search inside a search query" }),
};

/** Cross-index / self-join semijoin. Only valid in compound.filter and compound.mustNot. */
const JOIN = defineOperator("join", null, {
  from: {
    kind: "index",
    indexType: "SEARCH",
    detail: "Foreign search index (omit for self-join)",
  },
  localField: { ...pathSpec(["token", "objectId"]), required: true, detail: "Local token or objectId join key" },
  foreignField: {
    ...pathSpec(["token", "objectId"]),
    required: true,
    detail: "Foreign token or objectId join key",
    foreignIndex: true,
  },
  operator: {
    kind: "operator",
    required: true,
    detail: "Foreign search predicate",
    foreignIndex: true,
    enter(parent) {
      return operatorSlot(parent);
    },
  },
}, {
  detail: "Filter by a matching document in another (or the same) index",
  template: {
    from: "",
    localField: "",
    foreignField: "",
    operator: { equals: { path: "", value: "" } },
  },
});

/** Operators allowed inside compound.filter / mustNot, including join. */
export const FILTER_OPERATORS = { ...OPERATORS, join: JOIN };

const FACET = {
  kind: "object",
  collector: true,
  detail: "Facet collector",
  template: { operator: { exists: { path: "" } }, facets: {} },
  enter: {
    role: "keys",
    acceptsOperators: false,
    keySpecs: {
      operator: {
        kind: "operator",
        enter() {
          return operatorSlot(null);
        },
      },
      facets: {
        kind: "object",
        required: true,
        enter: {
          role: "keys",
          acceptsOperators: false,
          keySpecs: {},
          freeform: { kind: "facet", suggestFields: true },
          pathTypes: null,
        },
      },
    },
    pathTypes: null,
  },
};

const TOP_LEVEL = {
  index: { kind: "index", detail: "Index name (removed before the query is sent)" },
  returnStoredSource: { ...BOOL, detail: "Return stored source documents" },
  highlight: {
    kind: "object",
    detail: "Highlight matching text",
    template: { path: "", maxNumPassages: 5, maxCharsToExamine: 500 },
    enter: {
      role: "keys",
      acceptsOperators: false,
      pathTypes: ["string"],
      keySpecs: {
        path: { ...pathSpec(["string"]) },
        maxNumPassages: NUMBER,
        maxCharsToExamine: NUMBER,
      },
    },
  },
  count: {
    kind: "object",
    detail: "Count metadata",
    template: { type: "total" },
    enter: leafObject({
      type: { kind: "enum", values: ["lowerBound", "total"] },
      threshold: NUMBER,
    }).enter,
  },
  sort: {
    kind: "object",
    detail: "Sort by indexed fields",
    template: {},
    enter: {
      role: "keys",
      acceptsOperators: false,
      keySpecs: {},
      freeform: { kind: "field", types: SORTABLE_TYPES },
      pathTypes: null,
    },
  },
  scoreDetails: { ...BOOL, detail: "Include a score breakdown" },
  tracking: {
    kind: "object",
    detail: "Track search terms",
    template: { searchTerms: "" },
    enter: leafObject({ searchTerms: { kind: "string" } }).enter,
  },
  concurrent: { ...BOOL, detail: "Search segments concurrently" },
  returnScope: {
    kind: "object",
    detail: "Embedded-document result scope",
    template: { path: "" },
    enter: {
      role: "keys",
      acceptsOperators: false,
      pathTypes: ["embeddedDocuments"],
      keySpecs: { path: { ...pathSpec(["embeddedDocuments"]) } },
    },
  },
  searchAfter: { kind: "string", detail: "Pagination token" },
  searchBefore: { kind: "string", detail: "Pagination token" },
  facet: FACET,
  aggregation: {
    kind: "object",
    collector: true,
    detail: "Aggregation collector",
    loose: true,
    template: {},
    enter: UNKNOWN,
  },
};

/** MQL clauses accepted as a vector `filter` / `parentFilter`. */
export const MQL_COMPOUND = {
  $and: { detail: "All of these clauses", template: [{}] },
  $or: { detail: "Any of these clauses", template: [{}] },
  $nor: { detail: "None of these clauses", template: [{}] },
  $not: { detail: "Negate a clause", template: {} },
};

export const MQL_OPERATORS = {
  $eq: { detail: "Equal", template: "", value: "scalar" },
  $ne: { detail: "Not equal", template: "", value: "scalar" },
  $gt: { detail: "Greater than", template: 0, value: "scalar" },
  $gte: { detail: "Greater than or equal", template: 0, value: "scalar" },
  $lt: { detail: "Less than", template: 0, value: "scalar" },
  $lte: { detail: "Less than or equal", template: 0, value: "scalar" },
  $in: { detail: "One of", template: [], value: "array" },
  $nin: { detail: "None of", template: [], value: "array" },
  $exists: { detail: "Field is present", template: true, value: "boolean" },
  $not: { detail: "Negate a clause", template: {}, value: "clause" },
};

export function mqlClause(pathTypes = ["filter"]) {
  return { role: "mql", pathTypes };
}

function mqlStep(schema, part) {
  if (part === "$and" || part === "$or" || part === "$nor") {
    return { role: "array", item: mqlClause(schema.pathTypes) };
  }
  if (part === "$not") return mqlClause(schema.pathTypes);
  if (typeof part === "number") return UNKNOWN;
  return { role: "mql-value", field: String(part), pathTypes: schema.pathTypes };
}

const VECTOR_FILTER = {
  kind: "object",
  detail: "MQL pre-filter on filter fields",
  template: {},
  enter() {
    return mqlClause(["filter"]);
  },
};

const VECTOR_ROOT = {
  role: "keys",
  acceptsOperators: false,
  singleOperator: false,
  pathTypes: null,
  filterOperators: null,
  keySpecs: {
    index: { kind: "index", detail: "Vector index name (removed before the query is sent)" },
    path: { ...pathSpec(["vector"]), required: true, detail: "Vector field" },
    queryVector: { kind: "array", required: true, template: [0.1, 0.2, 0.3], detail: "Query vector" },
    numCandidates: { ...NUMBER, template: 50, detail: "Candidates to consider" },
    limit: { ...NUMBER, required: true, template: 10, detail: "Results to return" },
    filter: VECTOR_FILTER,
    parentFilter: VECTOR_FILTER,
    exact: { ...BOOL, detail: "Exact nearest neighbour" },
    returnStoredSource: { ...BOOL, detail: "Return stored source documents" },
  },
};

const SEARCH_ROOT = {
  role: "keys",
  acceptsOperators: true,
  singleOperator: true,
  pathTypes: null,
  filterOperators: null,
  keySpecs: TOP_LEVEL,
};

function operatorSet(schema) {
  return schema.operatorSet || OPERATORS;
}

export function operatorByName(schema, name) {
  if (!schema?.acceptsOperators) return null;
  const set = operatorSet(schema);
  const op = set[name];
  if (!op) return null;
  if (schema.filterOperators && !schema.filterOperators.includes(name)) return op;
  return op;
}

export function allowedOperators(schema) {
  const set = operatorSet(schema);
  const names = schema.filterOperators || Object.keys(set);
  return names.map((name) => set[name]).filter(Boolean);
}

function operatorSchema(op, parent) {
  if (op.enter) return op.enter;
  const keySpecs = typeof op.options === "function" ? op.options(parent) : (op.options || {});
  return {
    role: "keys",
    operator: op.name,
    operatorDef: op,
    keySpecs,
    acceptsOperators: false,
    pathTypes: parent?.pathTypes || null,
    filterOperators: parent?.filterOperators || null,
    loose: Boolean(op.loose),
  };
}

function step(schema, part) {
  if (!schema || schema.role === "unknown") return UNKNOWN;
  if (schema.role === "mql") return mqlStep(schema, part);
  if (schema.role === "mql-value") {
    return part === "$not" ? mqlClause(schema.pathTypes) : UNKNOWN;
  }
  if (schema.role === "array") {
    return typeof part === "number" ? schema.item : UNKNOWN;
  }
  if (typeof part === "number") return UNKNOWN;
  if (schema.acceptsOperators) {
    const op = operatorSet(schema)[part];
    if (op) return operatorSchema(op, schema);
  }
  const spec = schema.keySpecs?.[part];
  if (spec) {
    if (typeof spec.enter === "function") return spec.enter(schema) || UNKNOWN;
    if (spec.enter) return spec.enter;
    return UNKNOWN;
  }
  if (schema.freeform) return schema.freeform.enter || UNKNOWN;
  return UNKNOWN;
}

/** Schema of the object or array at `objectPath`. */
export function locate(mode, objectPath) {
  let schema = mode === "vector" ? VECTOR_ROOT : SEARCH_ROOT;
  for (const part of objectPath || []) {
    schema = step(schema, part);
    if (!schema || schema.role === "unknown") return UNKNOWN;
  }
  return schema;
}

export function specFor(schema, key) {
  if (!schema || schema.role === "unknown") return null;
  if (schema.keySpecs && Object.prototype.hasOwnProperty.call(schema.keySpecs, key)) {
    return schema.keySpecs[key];
  }
  if (schema.freeform?.kind === "field") return { kind: "sort-dir" };
  if (schema.freeform) return { kind: "any" };
  return null;
}

export function isClauseKey(schema, key) {
  if (!schema) return false;
  if (schema.acceptsOperators && operatorSet(schema)[key]) return true;
  return Boolean(schema.keySpecs?.[key]?.collector);
}

export function acceptedTypes(schema, spec) {
  if (!spec) return null;
  if (spec.kind !== "path" && spec.kind !== "path-string") return null;
  if (schema?.pathTypes) return schema.pathTypes;
  if (spec.types) return spec.types;
  const fieldTypes = schema?.operatorDef?.fieldTypes
    || (schema?.operator && OPERATORS[schema.operator]?.fieldTypes);
  return fieldTypes || null;
}

export function valueTemplate(spec) {
  if (!spec) return "";
  if (Object.prototype.hasOwnProperty.call(spec, "template")) return spec.template;
  switch (spec.kind) {
    case "string":
    case "stringish":
    case "path":
    case "path-string":
    case "index":
    case "multi":
      return "";
    case "number":
      return 0;
    case "boolean":
      return true;
    case "array":
    case "operators":
      return [];
    case "enum":
      return spec.values[0];
    case "any":
      return "";
    default:
      return {};
  }
}

export function operatorTemplate(name) {
  const op = OPERATORS[name] || FILTER_OPERATORS[name] || SPAN_CLAUSES[name];
  if (!op) return {};
  if (op.template) return structuredClone(op.template);
  const options = typeof op.options === "function" ? op.options(null) : (op.options || {});
  const body = {};
  for (const [key, spec] of Object.entries(options)) {
    if (spec.required) body[key] = valueTemplate(spec);
  }
  return body;
}

export function requiredKeys(op) {
  if (!op) return [];
  if (op.required) return op.required;
  const options = typeof op.options === "function" ? op.options(null) : (op.options || {});
  return Object.entries(options).filter(([, spec]) => spec.required).map(([key]) => key);
}

export function rootSchema(mode) {
  return mode === "vector" ? VECTOR_ROOT : SEARCH_ROOT;
}

export function indexModeType(mode) {
  return mode === "vector" ? "VECTOR_SEARCH" : "SEARCH";
}
