import { OPERATORS } from "../editors/catalog.js";
import { displayValue } from "./ejson";
import { formatNumber, isNum } from "./format";

type Document = Record<string, unknown>;
export type FacetType = "string" | "number" | "date";

export interface FacetField {
  path: string;
  type: FacetType;
}

const FACET_TYPES = [
  { type: "string", label: "String", name: "categories", mappings: ["token", "stringFacet"] },
  { type: "number", label: "Number", name: "values", mappings: ["number", "numberFacet"] },
  { type: "date", label: "Date", name: "dates", mappings: ["date", "dateFacet"] },
] as const;

export const FACET_TEMPLATES = FACET_TYPES.map(({ type, label }) => ({ type, label, path: "" }));

export function facetFields(fields: Array<{ path: string; types: string[] }>): FacetField[] {
  return fields.flatMap(({ path, types }) =>
    FACET_TYPES.filter(({ mappings }) => mappings.some((type) => types.includes(type)))
      .map(({ type }) => ({ path, type })),
  );
}

function facetTemplate({ path, type }: FacetField) {
  if (type === "string") return { type, path, numBuckets: 10 };
  const year = new Date().getUTCFullYear();
  const boundaries = type === "number"
    ? [0, 10, 50, 100]
    : [year - 2, year - 1, year, year + 1].map((y) => ({ $date: `${y}-01-01T00:00:00Z` }));
  return { type, path, boundaries, default: "Other" };
}

export function addFacetToQuery(text: string, field: FacetField): Document {
  const query = asDocument(JSON.parse(text.trim() || "{}"));
  if (!query) throw new Error("Query must be a JSON object.");
  const collector = asDocument(query.facet) ?? {};
  const facets = asDocument(collector.facets) ?? {};
  if ((Object.hasOwn(query, "facet") && !asDocument(query.facet))
    || (Object.hasOwn(collector, "facets") && !asDocument(collector.facets))) {
    throw new Error("Both facet and facets must be JSON objects.");
  }
  const operator = Object.keys(query).find((key) => Object.hasOwn(OPERATORS, key));
  if (operator && !Object.hasOwn(query, "facet")) {
    collector.operator = { [operator]: query[operator] };
    delete query[operator];
  }
  const base = field.path.replaceAll(".", "_") || FACET_TYPES.find(({ type }) => type === field.type)!.name;
  let name = base;
  for (let suffix = 2; Object.hasOwn(facets, name); suffix += 1) name = `${base}_${suffix}`;
  query.facet = { ...collector, facets: { ...facets, [name]: facetTemplate(field) } };
  return query;
}

export interface FacetBucket {
  label: string;
  outsideRange: boolean;
  values: Document;
}

export interface FacetResult {
  name: string;
  path: string | undefined;
  type: FacetType | undefined;
  buckets: FacetBucket[];
  columns: string[];
  metrics: string[];
  children: Document | undefined;
}

export function asDocument(value: unknown): Document | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Document : undefined;
}

function dateKey(value: unknown): string | undefined {
  const raw = asDocument(value)?.$date;
  const millis = asDocument(raw)?.$numberLong;
  if (typeof raw !== "string" && typeof millis !== "string") return undefined;
  const date = typeof raw === "string" ? new Date(raw) : new Date(Number(millis));
  return isNum(date.getTime()) ? date.toISOString() : String(millis ?? raw);
}

export function numericValue(value: unknown): number | null {
  if (isNum(value)) return value;
  const wrapped = asDocument(value);
  if (!wrapped || Object.keys(wrapped).length !== 1) return null;
  for (const key of ["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"]) {
    const text = wrapped[key];
    if (typeof text !== "string") continue;
    const number = Number(text);
    return isNum(number) ? number : null;
  }
  return null;
}

function bucketType(value: unknown): FacetType | undefined {
  if (typeof value === "string") return "string";
  if (dateKey(value) !== undefined) return "date";
  return numericValue(value) !== null ? "number" : undefined;
}

function boundaryKey(value: unknown): string {
  const exact = asDocument(value)?.$numberLong ?? asDocument(value)?.$numberDecimal;
  return dateKey(value) ?? String(exact ?? numericValue(value) ?? value);
}

export function facetValue(value: unknown): string {
  const date = dateKey(value);
  if (date !== undefined) return date.replace(/T00:00:00\.000Z$/, "");
  if (typeof value === "string") return value || '""';
  if (isNum(value)) return Number.isSafeInteger(value) ? formatNumber(value) : String(value);
  const long = asDocument(value)?.$numberLong;
  if (typeof long === "string" && /^-?\d+$/.test(long)) return BigInt(long).toLocaleString();
  return displayValue(value);
}

export function matchCount(metadata: Document | null): { value: unknown; exact: boolean } | undefined {
  const count = asDocument(metadata?.count);
  if (numericValue(count?.total) !== null) return { value: count?.total, exact: true };
  if (numericValue(count?.lowerBound) !== null) return { value: count?.lowerBound, exact: false };
  return undefined;
}

export function bucketList(value: unknown): unknown[] | undefined {
  const buckets = asDocument(value)?.buckets;
  return Array.isArray(buckets) ? buckets : undefined;
}

export function readFacet(name: string, value: unknown, definition: unknown): FacetResult | undefined {
  const list = bucketList(value);
  if (!list) return undefined;
  const spec = asDocument(definition);
  const rows = list.map(asDocument).filter((row): row is Document => row !== undefined && Object.hasOwn(row, "_id"));
  const kind = spec?.type;
  const inferred = rows.map((row) => bucketType(row._id));
  const type = kind === "string" || kind === "number" || kind === "date"
    ? kind
    : inferred.find((value) => value === "date" || value === "number") ?? inferred[0];
  const boundaries = Array.isArray(spec?.boundaries) ? spec.boundaries : [];
  const ranks = new Map(boundaries.map((boundary, index) => [boundaryKey(boundary), index]));
  const columns = new Set<string>();
  const metrics = new Set<string>();
  const buckets = rows.map(({ _id, ...values }) => {
    const outsideRange = (type === "number" || type === "date") && typeof _id === "string";
    const rank = outsideRange ? undefined : ranks.get(boundaryKey(_id));
    const upper = rank === undefined ? undefined : boundaries[rank + 1];
    const label = upper === undefined ? facetValue(_id) : `${facetValue(_id)} – <${facetValue(upper)}`;
    // Intermediate aggregation buckets wrap their automatic count in {total}.
    const total = asDocument(values.count)?.total;
    if (numericValue(total) !== null) values.count = total;
    for (const [key, entry] of Object.entries(values)) {
      columns.add(key);
      if (numericValue(entry) !== null) metrics.add(key);
    }
    return { label, values, outsideRange, rank: rank ?? boundaries.length };
  });
  if (ranks.size) buckets.sort((a, b) => a.rank - b.rank);
  return {
    name,
    path: typeof spec?.path === "string" ? spec.path : undefined,
    type,
    buckets,
    columns: columns.delete("count") ? ["count", ...columns] : [...columns],
    metrics: metrics.delete("count") ? ["count", ...metrics] : [...metrics],
    children: asDocument(spec?.facets),
  };
}

export function readFacets(metadata: Document | null, query: Document): FacetResult[] {
  const definitions = asDocument(asDocument(query.facet)?.facets);
  return Object.entries(asDocument(metadata?.facet) ?? {}).flatMap(([name, value]) => {
    const facet = readFacet(name, value, definitions && Object.hasOwn(definitions, name) ? definitions[name] : undefined);
    return facet ? [facet] : [];
  });
}
