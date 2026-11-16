/**
 * Mongot index definitions. Shapes match what standalone mongot accepts:
 * `dynamic` is a boolean or `{ typeSet }`, and synonym sources are rejected.
 */

export const UNKNOWN = { role: "unknown" };

export const SORTABLE_TYPES = ["boolean", "date", "number", "objectId", "token", "uuid"];

export const BUILTIN_ANALYZERS = [
  "lucene.standard",
  "lucene.simple",
  "lucene.whitespace",
  "lucene.keyword",
  "lucene.english",
  "lucene.french",
  "lucene.spanish",
  "lucene.portuguese",
  "lucene.italian",
  "lucene.german",
  "lucene.russian",
  "lucene.arabic",
  "lucene.persian",
  "lucene.chinese",
  "lucene.hindi",
  "lucene.danish",
  "lucene.finnish",
  "lucene.hungarian",
  "lucene.dutch",
  "lucene.norwegian",
  "lucene.swedish",
  "lucene.turkish",
  "lucene.thai",
  "lucene.romanian",
  "lucene.armenian",
  "lucene.basque",
  "lucene.bengali",
  "lucene.brazilian",
  "lucene.bulgarian",
  "lucene.catalan",
  "lucene.czech",
  "lucene.galician",
  "lucene.greek",
  "lucene.irish",
  "lucene.indonesian",
  "lucene.latvian",
  "lucene.lithuanian",
  "lucene.sorani",
  "lucene.cjk",
  "lucene.kuromoji",
  "lucene.nori",
  "lucene.smartcn",
  "lucene.icu",
  "lucene.morfologik",
  "lucene.stempel",
  "lucene.ukrainian",
];

const SEARCH_FIELD_TYPES = [
  "autocomplete",
  "boolean",
  "date",
  "dateFacet",
  "document",
  "embeddedDocuments",
  "geo",
  "knnVector",
  "number",
  "numberFacet",
  "objectId",
  "string",
  "stringFacet",
  "token",
  "uuid",
];

const VECTOR_FIELD_TYPES = ["filter", "vector"];

const TOKENIZER_TYPES = [
  "edgeGram",
  "keyword",
  "nGram",
  "regexCaptureGroup",
  "regexSplit",
  "standard",
  "uaxUrlEmail",
  "whitespace",
];

const BOOL = { kind: "boolean" };
const NUMBER = { kind: "number" };
const ANALYZER_NAME = { kind: "analyzer", detail: "Analyzer name" };
const PATH = { kind: "path", detail: "Document field path" };

const SIMILARITY = {
  kind: "object",
  detail: "Similarity function",
  template: { type: "bm25" },
  enter: {
    role: "keys",
    keySpecs: {
      type: {
        kind: "enum",
        values: ["bm25", "boolean", "stableTfl"],
        required: true,
        detail: "Similarity",
      },
    },
  },
};

const DYNAMIC = {
  kind: "dynamic",
  detail: "Index new fields automatically",
  template: true,
  enter: {
    role: "keys",
    keySpecs: {
      typeSet: { kind: "typeSet", required: true, detail: "Named type set" },
    },
  },
};

const STORED = {
  kind: "stored",
  detail: "Keep the original document",
  template: true,
  enter: {
    role: "keys",
    oneOf: ["include", "exclude"],
    keySpecs: {
      include: { kind: "string-array", detail: "Fields to store", template: [""] },
      exclude: { kind: "string-array", detail: "Fields to skip", template: [""] },
    },
  },
};

const FIELD_MAP = {
  role: "keys",
  freeform: { kind: "field-name" },
  keySpecs: {},
};

const MULTI = {
  kind: "object",
  detail: "Alternate analyzers",
  template: { keyword: { type: "string", analyzer: "lucene.keyword" } },
  enter: {
    role: "keys",
    freeform: { kind: "multi-name" },
    keySpecs: {},
  },
};

const NUMBER_OPTIONS = {
  representation: { kind: "enum", values: ["double", "int64"], detail: "Numeric representation" },
  indexIntegers: { ...BOOL, detail: "Index integers" },
  indexDoubles: { ...BOOL, detail: "Index doubles" },
};

const TOKENIZER = {
  role: "keys",
  loose: true,
  keySpecs: {
    type: {
      kind: "enum",
      values: TOKENIZER_TYPES,
      required: true,
      detail: "Tokenizer",
    },
  },
};

const FILTER_ITEM = {
  role: "keys",
  loose: true,
  keySpecs: {
    type: { kind: "string", required: true, detail: "Filter type" },
  },
};

const ANALYZER = {
  role: "keys",
  keySpecs: {
    name: { kind: "string", required: true, detail: "Analyzer name" },
    tokenizer: {
      kind: "object",
      required: true,
      detail: "Tokenizer",
      template: { type: "standard" },
      enter: TOKENIZER,
    },
    charFilters: {
      kind: "array",
      detail: "Character filters",
      template: [],
      enter: {
        role: "array",
        item: FILTER_ITEM,
        scaffolds: [{ label: "charFilter", detail: "Character filter", template: { type: "" } }],
      },
    },
    tokenFilters: {
      kind: "array",
      detail: "Token filters",
      template: [],
      enter: {
        role: "array",
        item: FILTER_ITEM,
        scaffolds: [{ label: "tokenFilter", detail: "Token filter", template: { type: "" } }],
      },
    },
  },
};

const TYPE_SET = {
  role: "keys",
  keySpecs: {
    name: { kind: "string", required: true, detail: "Type set name" },
    types: {
      kind: "array",
      required: true,
      detail: "Types in this set",
      template: [{ type: "string" }],
      enter: {
        role: "array",
        item: { role: "field", allowMulti: true },
        scaffolds: [{ label: "string", detail: "Field type", template: { type: "string" } }],
      },
    },
  },
};

const SORT_FIELD = {
  role: "keys",
  loose: true,
  keySpecs: {
    order: { kind: "enum", values: [1, -1], required: true, detail: "Sort direction" },
  },
};

const SORT = {
  role: "keys",
  freeform: { kind: "sort-field" },
  keySpecs: {},
};

const HNSW = {
  kind: "object",
  detail: "HNSW graph options",
  template: { maxEdges: 16, numEdgeCandidates: 100 },
  enter: {
    role: "keys",
    keySpecs: {
      maxEdges: { ...NUMBER, detail: "Max edges per node" },
      numEdgeCandidates: { ...NUMBER, detail: "Edge candidates" },
    },
  },
};

const VECTOR_SIMILARITY = {
  kind: "enum",
  values: ["cosine", "dotProduct", "euclidean"],
  required: true,
  detail: "Similarity",
};

function stringOptions(allowMulti) {
  const options = {
    analyzer: ANALYZER_NAME,
    searchAnalyzer: { ...ANALYZER_NAME, detail: "Query analyzer" },
    indexOptions: { kind: "enum", values: ["docs", "freqs", "offsets", "positions"], detail: "Index options" },
    store: { ...BOOL, detail: "Store the field value" },
    ignoreAbove: { ...NUMBER, detail: "Ignore values longer than this" },
    norms: { kind: "enum", values: ["include", "omit"], detail: "Norms" },
    similarity: SIMILARITY,
  };
  if (allowMulti) options.multi = MULTI;
  return options;
}

function optionsFor(type, allowMulti) {
  switch (type) {
    case "string":
      return stringOptions(allowMulti);
    case "autocomplete":
      return {
        analyzer: ANALYZER_NAME,
        minGrams: { ...NUMBER, detail: "Minimum gram size" },
        maxGrams: { ...NUMBER, detail: "Maximum gram size" },
        tokenization: {
          kind: "enum",
          values: ["edgeGram", "nGram", "rightEdgeGram"],
          detail: "Tokenization",
        },
        foldDiacritics: { ...BOOL, detail: "Fold diacritics" },
        similarity: SIMILARITY,
      };
    case "token":
      return {
        normalizer: { kind: "enum", values: ["lowercase", "none"], detail: "Normalizer" },
      };
    case "number":
    case "numberFacet":
      return { ...NUMBER_OPTIONS };
    case "geo":
      return { indexShapes: { ...BOOL, detail: "Index shapes as well as points" } };
    case "document":
      return {
        dynamic: DYNAMIC,
        fields: { kind: "object", detail: "Nested fields", template: {}, enter: FIELD_MAP },
      };
    case "embeddedDocuments":
      return {
        dynamic: DYNAMIC,
        fields: { kind: "object", detail: "Nested fields", template: {}, enter: FIELD_MAP },
        storedSource: STORED,
      };
    case "knnVector":
      return {
        dimensions: { ...NUMBER, required: true, detail: "Vector dimensions" },
        similarity: VECTOR_SIMILARITY,
      };
    case "vector":
      return {
        path: { ...PATH, required: true },
        numDimensions: { ...NUMBER, required: true, range: [1, 8192], detail: "Vector dimensions" },
        similarity: VECTOR_SIMILARITY,
        quantization: { kind: "enum", values: ["none", "scalar", "binary"], detail: "Quantization" },
        engine: { kind: "enum", values: ["custom", "lucene"], detail: "Vector engine" },
        indexingMethod: { kind: "enum", values: ["flat", "hnsw"], detail: "Indexing method" },
        hnswOptions: HNSW,
      };
    case "filter":
      return { path: { ...PATH, required: true } };
    default:
      return {};
  }
}

function fieldSchema(node, search, allowMulti) {
  const allowed = search ? SEARCH_FIELD_TYPES : VECTOR_FIELD_TYPES;
  const type = stringField(node, "type");
  const known = type && allowed.includes(type);
  return {
    role: "keys",
    loose: !known,
    fieldType: known ? type : "",
    keySpecs: {
      type: { kind: "enum", values: allowed, required: true, strict: true, detail: "Field type" },
      ...(known ? optionsFor(type, allowMulti) : {}),
    },
  };
}

const MAPPINGS = {
  role: "keys",
  keySpecs: {
    dynamic: DYNAMIC,
    fields: { kind: "object", detail: "Field mappings", template: {}, enter: FIELD_MAP },
  },
};

const SEARCH_ROOT = {
  role: "keys",
  keySpecs: {
    analyzer: { ...ANALYZER_NAME, detail: "Default index analyzer" },
    searchAnalyzer: { ...ANALYZER_NAME, detail: "Default query analyzer" },
    mappings: { kind: "object", detail: "Document mappings", template: { dynamic: true }, enter: MAPPINGS },
    analyzers: {
      kind: "array",
      detail: "Custom analyzers",
      template: [{ name: "", tokenizer: { type: "standard" } }],
      enter: {
        role: "array",
        item: ANALYZER,
        scaffolds: [{
          label: "analyzer",
          detail: "Custom analyzer",
          template: { name: "", tokenizer: { type: "standard" } },
        }],
      },
    },
    storedSource: STORED,
    typeSets: {
      kind: "array",
      detail: "Named sets of field types",
      nonEmpty: true,
      template: [{ name: "", types: [{ type: "string" }] }],
      enter: {
        role: "array",
        item: TYPE_SET,
        scaffolds: [{
          label: "typeSet",
          detail: "Named type set",
          template: { name: "", types: [{ type: "string" }] },
        }],
      },
    },
    numPartitions: { ...NUMBER, detail: "Index partitions" },
    sort: { kind: "object", detail: "Sort by statically mapped fields", template: {}, enter: SORT },
    synonyms: { kind: "array", hidden: true, unsupported: true, template: [] },
  },
};

const VECTOR_ROOT = {
  role: "keys",
  keySpecs: {
    fields: {
      kind: "array",
      required: true,
      warnIfEmpty: true,
      detail: "Vector and filter fields",
      template: [{ type: "vector", path: "", numDimensions: 3, similarity: "cosine" }],
      enter: {
        role: "array",
        item: { role: "field", allowMulti: false },
        scaffolds: [
          {
            label: "vector",
            detail: "Vector field",
            template: { type: "vector", path: "", numDimensions: 3, similarity: "cosine" },
          },
          { label: "filter", detail: "Filter field", template: { type: "filter", path: "" } },
        ],
      },
    },
  },
};

function descend(node, part) {
  if (!node) return null;
  if (node.kind === "object" && typeof part === "string") {
    return node.properties.find((item) => item.key === part)?.value || null;
  }
  if (node.kind === "array" && typeof part === "number") return node.items[part] || null;
  return null;
}

function step(schema, part, node) {
  if (!schema || schema.role === "unknown") return UNKNOWN;
  if (schema.role === "array") {
    const item = schema.item || UNKNOWN;
    if (item.role === "field") return { role: "field", allowMulti: item.allowMulti !== false };
    return item;
  }
  if (schema.role !== "keys" || typeof part === "number") return UNKNOWN;
  const spec = schema.keySpecs?.[part];
  if (spec?.enter) return spec.enter;
  if (schema.freeform?.kind === "field-name" || schema.freeform?.kind === "multi-name") {
    const allowMulti = schema.freeform.kind === "field-name";
    if (node?.kind === "array") return { role: "array", item: { role: "field", allowMulti } };
    return { role: "field", allowMulti };
  }
  if (schema.freeform?.kind === "sort-field") return SORT_FIELD;
  return UNKNOWN;
}

/** Schema of the object at `objectPath` inside a definition. */
export function locate(mode, objectPath, doc) {
  const search = mode !== "VECTOR_SEARCH";
  let schema = search ? SEARCH_ROOT : VECTOR_ROOT;
  let node = doc;
  for (const part of objectPath || []) {
    node = descend(node, part);
    schema = step(schema, part, node);
    if (!schema || schema.role === "unknown") return UNKNOWN;
    if (schema.role === "field") schema = fieldSchema(node, search, schema.allowMulti !== false);
  }
  return schema;
}

export function specFor(schema, key) {
  if (!schema || schema.role !== "keys") return null;
  if (schema.keySpecs && Object.prototype.hasOwnProperty.call(schema.keySpecs, key)) {
    return schema.keySpecs[key];
  }
  if (schema.freeform?.kind === "field-name" || schema.freeform?.kind === "multi-name") {
    return { kind: "field-value" };
  }
  if (schema.freeform?.kind === "sort-field") return { kind: "sort-value" };
  return null;
}

export function valueTemplate(spec) {
  if (!spec) return "";
  if (Object.prototype.hasOwnProperty.call(spec, "template")) return spec.template;
  switch (spec.kind) {
    case "string":
    case "analyzer":
    case "path":
    case "typeSet":
      return "";
    case "number":
      return spec.range ? spec.range[0] : 0;
    case "boolean":
    case "dynamic":
    case "stored":
      return true;
    case "enum":
      return spec.values[0];
    case "array":
    case "string-array":
      return [];
    case "field-value":
      return { type: "string" };
    case "sort-value":
      return 1;
    default:
      return {};
  }
}

function prop(node, key) {
  if (!node || node.kind !== "object") return null;
  return node.properties.find((item) => item.key === key)?.value || null;
}

function stringField(node, key) {
  const value = prop(node, key);
  return value?.kind === "string" ? value.value : "";
}

function fieldSpecs(node) {
  if (!node) return [];
  if (node.kind === "object") return [node];
  if (node.kind === "array") return node.items.filter((item) => item?.kind === "object");
  return [];
}

function walkFieldMap(node, prefix, out) {
  if (!node || node.kind !== "object") return;
  for (const property of node.properties) {
    const path = prefix ? `${prefix}.${property.key}` : property.key;
    for (const spec of fieldSpecs(property.value)) {
      const type = stringField(spec, "type");
      if (type) out.push({ path, type });
      if (type === "document" || type === "embeddedDocuments") {
        walkFieldMap(prop(spec, "fields"), path, out);
      }
    }
  }
}

/** Statically mapped `{ path, type }` pairs from a search definition. */
export function mappedFields(doc) {
  const out = [];
  if (!doc || doc.kind !== "object") return out;
  const mappings = prop(doc, "mappings");
  if (mappings?.kind === "object") walkFieldMap(prop(mappings, "fields"), "", out);
  return out;
}

function namesIn(doc, key) {
  const list = prop(doc, key);
  if (!list || list.kind !== "array") return [];
  const names = [];
  for (const item of list.items) {
    const name = stringField(item, "name");
    if (name) names.push(name);
  }
  return names;
}

export function definedAnalyzers(doc) {
  return namesIn(doc, "analyzers");
}

export function definedTypeSets(doc) {
  return namesIn(doc, "typeSets");
}

/** Dotted prefix of the field map the cursor is inside. */
export function fieldPrefix(objectPath) {
  const names = [];
  const path = objectPath || [];
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] !== "fields") continue;
    const name = path[i + 1];
    if (typeof name !== "string") continue;
    names.push(name);
    i += 1;
  }
  return names.join(".");
}

export function localFieldNames(fieldPaths, prefix) {
  const names = new Set();
  const head = prefix ? `${prefix}.` : "";
  for (const field of fieldPaths || []) {
    const path = field.path || "";
    if (!path) continue;
    const rest = head ? (path.startsWith(head) ? path.slice(head.length) : "") : path;
    const name = rest.split(".").filter(Boolean)[0];
    if (name) names.add(name);
  }
  return [...names].sort();
}

export function analyzerIssue(name, customNames) {
  if (!name) return { severity: "error", message: "Analyzer name is empty" };
  if (BUILTIN_ANALYZERS.includes(name) || customNames.includes(name)) return null;
  if (name.startsWith("lucene.")) {
    return { severity: "warning", message: `Unknown built-in analyzer "${name}"` };
  }
  return { severity: "error", message: `Unknown analyzer "${name}"` };
}
