/**
 * Flatten an index mapping into field paths and the types mongot indexed.
 * Dynamic strings stay `string` (not `token`) unless the mapping says otherwise.
 */

const CANONICAL = {
  string: "string",
  stringFacet: "string",
  token: "token",
  autocomplete: "autocomplete",
  number: "number",
  numberFacet: "number",
  date: "date",
  dateFacet: "date",
  boolean: "boolean",
  objectId: "objectId",
  uuid: "uuid",
  geo: "geo",
  document: "document",
  embeddedDocuments: "embeddedDocuments",
  vector: "vector",
  knnVector: "vector",
  filter: "filter",
};

const CONTAINER_TYPES = new Set(["document", "embeddedDocuments"]);

export function canonicalType(type) {
  return CANONICAL[type] || type;
}

export function canonicalTypes(types) {
  const out = new Set();
  for (const type of types || []) out.add(canonicalType(type));
  return out;
}

/** True when any indexed type is one the operator accepts. `accepted` null means any type. */
export function typesCompatible(fieldTypes, accepted) {
  if (!accepted) return true;
  const have = canonicalTypes(fieldTypes);
  return accepted.some((type) => have.has(type));
}

function emptyEntry() {
  return {
    types: new Set(),
    multis: [],
    numDimensions: null,
    childDynamic: undefined,
  };
}

function addType(map, path, type, extra = {}) {
  if (!path || !type) return;
  if (!map.has(path)) map.set(path, emptyEntry());
  const entry = map.get(path);
  entry.types.add(type);
  if (extra.numDimensions != null && entry.numDimensions == null) {
    entry.numDimensions = Number(extra.numDimensions);
  }
  if (Array.isArray(extra.multis)) {
    for (const name of extra.multis) {
      if (!entry.multis.includes(name)) entry.multis.push(name);
    }
  }
  if (extra.childDynamic !== undefined) entry.childDynamic = extra.childDynamic;
}

function specsOf(definition) {
  if (Array.isArray(definition)) return definition.filter((item) => item && typeof item === "object");
  if (definition && typeof definition === "object") return [definition];
  return [];
}

function typeSetMap(definition) {
  const map = new Map();
  for (const set of definition?.typeSets || []) {
    if (!set?.name) continue;
    const types = new Set();
    for (const spec of set.types || []) {
      if (spec?.type) types.add(spec.type);
    }
    map.set(set.name, types);
  }
  return map;
}

function walkMapping(fields, prefix, mapped) {
  for (const [name, definition] of Object.entries(fields || {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    for (const spec of specsOf(definition)) {
      if (!spec.type) continue;
      const multis = spec.multi && typeof spec.multi === "object" ? Object.keys(spec.multi) : [];
      const container = CONTAINER_TYPES.has(spec.type);
      addType(mapped, path, spec.type, {
        multis,
        childDynamic: container ? (spec.dynamic === undefined ? false : spec.dynamic) : undefined,
      });
      if (container) walkMapping(spec.fields, path, mapped);
    }
  }
}

function walkVectorFields(fields, mapped) {
  for (const field of fields || []) {
    if (!field?.path || !field.type) continue;
    addType(mapped, field.path, field.type, { numDimensions: field.numDimensions });
  }
}

export class FieldIndex {
  constructor(definition, indexType = "SEARCH") {
    this.knowsMapping = Boolean(definition && typeof definition === "object");
    this.indexType = indexType || "SEARCH";
    this.mapped = new Map();
    this.observed = new Map();
    this.hasObserved = false;
    this.observedOrigin = "indexed";
    this.observedRootDynamic = false;
    this.typeSets = typeSetMap(definition);
    const dynamic = definition?.mappings?.dynamic;
    this.rootDynamic = dynamic === undefined ? false : dynamic;
    if (this.knowsMapping) {
      walkMapping(definition.mappings?.fields, "", this.mapped);
      walkVectorFields(definition.fields, this.mapped);
    }
  }

  static compile(definition, indexType) {
    return new FieldIndex(definition, indexType);
  }

  static empty() {
    return new FieldIndex(null);
  }

  get hasDynamic() {
    if (this.rootDynamic) return true;
    for (const entry of this.mapped.values()) {
      if (entry.childDynamic) return true;
    }
    return false;
  }

  /**
   * Merge the mapping mongot exports for a search index. That document lists every
   * field the index has actually built, including ones that were only dynamic, and
   * its `dynamic` flag is what decides whether further fields are still open.
   * Explicit definition fields keep their configured types.
   */
  applyObserved(mappings) {
    if (!mappings || typeof mappings !== "object") return this;
    this.observed = new Map();
    this.observedOrigin = mappings.fieldSource === "sampled" ? "sampled" : "indexed";
    walkMapping(mappings.fields, "", this.observed);
    for (const path of this.mapped.keys()) this.observed.delete(path);
    this.observedRootDynamic = mappings.dynamic === undefined ? false : mappings.dynamic;
    this.hasObserved = true;
    return this;
  }

  lookup(path) {
    if (this.mapped.has(path)) {
      const entry = this.mapped.get(path);
      return { path, ...cloneEntry(entry), origin: "mapped", allowed: true };
    }
    if (this.observed.has(path)) {
      const entry = this.observed.get(path);
      return { path, ...cloneEntry(entry), origin: this.observedOrigin, allowed: true };
    }
    const dynamic = this.dynamicScope(path);
    if (dynamic.allowed) {
      return {
        path,
        types: dynamic.types,
        multis: [],
        numDimensions: null,
        origin: "dynamic",
        allowed: true,
      };
    }
    return {
      path,
      types: new Set(),
      multis: [],
      numDimensions: null,
      origin: "missing",
      allowed: false,
    };
  }

  /** Mapped and indexed paths whose types satisfy `accepted` (null = all of them). */
  suggest(accepted) {
    const out = [];
    const push = (path, entry, origin) => {
      if (accepted && entry.types.size && !typesCompatible(entry.types, accepted)) return;
      if (accepted && !entry.types.size) return;
      out.push({
        path,
        types: canonicalTypes(entry.types),
        rawTypes: new Set(entry.types),
        origin,
        numDimensions: entry.numDimensions ?? null,
        multis: entry.multis || [],
      });
    };
    for (const [path, entry] of this.mapped) push(path, entry, "mapped");
    for (const [path, entry] of this.observed) {
      if (this.mapped.has(path)) continue;
      push(path, entry, this.observedOrigin);
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  dynamicScope(path) {
    if (!this.knowsMapping) return { allowed: false, types: new Set() };
    const parts = String(path || "").split(".").filter(Boolean);
    if (!parts.length) return { allowed: false, types: new Set() };
    const rootDynamic = this.hasObserved ? this.observedRootDynamic : this.rootDynamic;
    let allowed = Boolean(rootDynamic);
    let types = typesForDynamic(rootDynamic, this.typeSets);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const prefix = parts.slice(0, i + 1).join(".");
      const mapped = this.mapped.get(prefix) || this.observed.get(prefix);
      if (mapped) {
        const container = [...mapped.types].some((type) => CONTAINER_TYPES.has(type));
        if (!container) return { allowed: false, types: new Set() };
        if (!mapped.childDynamic) {
          allowed = false;
          types = new Set();
        } else {
          allowed = true;
          types = typesForDynamic(mapped.childDynamic, this.typeSets);
        }
      } else if (!allowed) {
        return { allowed: false, types: new Set() };
      }
    }
    return { allowed, types };
  }
}

/** `dynamic` is a boolean, or `{ typeSet }` naming an entry in `typeSets`. A bare string is rejected. */
function typesForDynamic(dynamic, typeSets) {
  if (!dynamic || typeof dynamic !== "object") return new Set();
  const name = dynamic.typeSet;
  if (typeof name !== "string" || !name) return new Set();
  return new Set(typeSets.get(name) || []);
}

function cloneEntry(entry) {
  return {
    types: new Set(entry.types),
    multis: [...(entry.multis || [])],
    numDimensions: entry.numDimensions ?? null,
  };
}

const mappingCache = new Map();

export function clearMappingCache() {
  mappingCache.clear();
}

async function fetchMappings(index, fetchImpl) {
  // MongoDB supplies sampled suggestions separately from standalone mapping exports.
  const endpoint = index.source === "mongod" ? "field-suggestions" : "mappings";
  const params = new URLSearchParams();
  const generation = index.generation_id || "";
  if (generation) params.set("generation_id", generation);
  const query = params.toString();
  const url = `/api/indexes/${encodeURIComponent(index.index_id)}/${endpoint}${query ? `?${query}` : ""}`;
  const response = await fetchImpl(url);
  if (!response?.ok) return null;
  const body = await response.json();
  if (!body?.mappings) return null;
  return body.source === "sampled" ? { ...body.mappings, fieldSource: "sampled" } : body.mappings;
}

/** Field hints, cached per index definition and generation. Vector indexes have none. */
export function loadMappings(index, fetchImpl = globalThis.fetch) {
  const key = `${index.index_id}:${index.generation_id || index.active_revision || ""}:${index.desired_revision ?? ""}`;
  if (!mappingCache.has(key)) {
    const pending = fetchMappings(index, fetchImpl).then(
      (mappings) => {
        if (!mappings) mappingCache.delete(key);
        return mappings;
      },
      () => {
        mappingCache.delete(key);
        return null;
      },
    );
    mappingCache.set(key, pending);
  }
  return mappingCache.get(key);
}

export function fieldsFor(model, indexName) {
  const indexes = model?.indexes || [];
  const named = indexName ? indexes.find((index) => index.name === indexName) : null;
  const selected = indexes.find((index) => index.index_id === model?.indexId) || null;
  const index = named || selected;
  if (!index?.definition) return { index, fields: FieldIndex.empty() };
  const fields = FieldIndex.compile(index.definition, index.type);
  const observed = model?.mappings?.[index.index_id];
  if (observed) fields.applyObserved(observed);
  return { index, fields };
}
