import type { Capabilities } from "./capabilities";

export interface Snippet {
  id: string;
  label: string;
  description: string;
  build: (ctx: SnippetContext) => Record<string, unknown>;
}

export interface SnippetContext {
  field: string;
  textField: string;
  numberField: string;
  dateField: string;
  caps: Capabilities;
}

const vectorField = (ctx: SnippetContext) => ctx.caps.vectorFields[0];

function randomUnitVector(dims: number): number[] {
  const values = Array.from({ length: dims }, () => Math.random() * 2 - 1);
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => Math.round((value / norm) * 1e5) / 1e5);
}

export const SEARCH_SNIPPETS: Snippet[] = [
  {
    id: "text",
    label: "Text",
    description: "Full-text match on an analyzed string field",
    build: (c) => ({ text: { query: "search terms", path: c.textField } }),
  },
  {
    id: "phrase",
    label: "Phrase",
    description: "Words in order, with optional slop",
    build: (c) => ({ phrase: { query: "exact phrase", path: c.textField, slop: 0 } }),
  },
  {
    id: "fuzzy",
    label: "Fuzzy text",
    description: "Tolerates typos (edit distance)",
    build: (c) => ({ text: { query: "serch trems", path: c.textField, fuzzy: { maxEdits: 1 } } }),
  },
  {
    id: "wildcard",
    label: "Wildcard",
    description: "Pattern with * and ?",
    build: (c) => ({ wildcard: { query: "abc*", path: c.textField, allowAnalyzedField: true } }),
  },
  {
    id: "equals",
    label: "Equals",
    description: "Exact value on token, number, date, boolean, or ObjectId fields",
    build: (c) => ({ equals: { path: c.field, value: "value" } }),
  },
  {
    id: "range-number",
    label: "Number range",
    description: "gt, gte, lt, lte on a number field",
    build: (c) => ({ range: { path: c.numberField, gte: 0, lt: 100 } }),
  },
  {
    id: "range-date",
    label: "Date range",
    description: "Between two dates",
    build: (c) => ({
      range: { path: c.dateField, gte: { $date: "2024-01-01T00:00:00Z" }, lt: { $date: "2025-01-01T00:00:00Z" } },
    }),
  },
  {
    id: "exists",
    label: "Exists",
    description: "Documents that have the field",
    build: (c) => ({ exists: { path: c.field } }),
  },
  {
    id: "compound",
    label: "Compound",
    description: "Combine must, should, filter, and mustNot clauses",
    build: (c) => ({
      compound: {
        must: [{ text: { query: "required", path: c.textField } }],
        should: [{ text: { query: "boost", path: c.textField } }],
        filter: [{ range: { path: c.numberField, gte: 0 } }],
        mustNot: [{ text: { query: "exclude", path: c.textField } }],
      },
    }),
  },
  {
    id: "highlight",
    label: "Text with highlights",
    description: "Returns highlighted snippets in the hit metadata",
    build: (c) => ({ text: { query: "search terms", path: c.textField }, highlight: { path: c.textField } }),
  },
  {
    id: "sort",
    label: "Sorted",
    description: "Match everything that has the field, sorted by it",
    build: (c) => ({ exists: { path: c.field }, sort: { [c.field]: -1 } }),
  },
  {
    id: "all",
    label: "Everything",
    description: "Every document with an _id",
    build: () => ({ exists: { path: "_id" } }),
  },
];

export const VECTOR_SNIPPETS: Snippet[] = [
  {
    id: "vector",
    label: "Nearest neighbours",
    description: "Approximate search with numCandidates",
    build: (c) => {
      const field = vectorField(c);
      return {
        path: field?.path ?? "embedding",
        queryVector: [0.1, 0.2, 0.3],
        numCandidates: 100,
        limit: 10,
      };
    },
  },
  {
    id: "vector-random",
    label: "Random vector",
    description: "A random unit vector of the right length, for trying the index",
    build: (c) => {
      const field = vectorField(c);
      return {
        path: field?.path ?? "embedding",
        queryVector: randomUnitVector(field?.numDimensions ?? 3),
        numCandidates: 100,
        limit: 10,
      };
    },
  },
  {
    id: "vector-filter",
    label: "With a filter",
    description: "Pre-filter on filter fields with MQL",
    build: (c) => {
      const field = vectorField(c);
      return {
        path: field?.path ?? "embedding",
        queryVector: [0.1, 0.2, 0.3],
        numCandidates: 100,
        limit: 10,
        filter: { [c.caps.filterFields[0] ?? "category"]: { $eq: "value" } },
      };
    },
  },
  {
    id: "vector-exact",
    label: "Exact (ENN)",
    description: "Exhaustive search: slower, no recall loss",
    build: (c) => {
      const field = vectorField(c);
      return { path: field?.path ?? "embedding", queryVector: [0.1, 0.2, 0.3], exact: true, limit: 10 };
    },
  },
];

/** A starter query for one field, picked by its indexed type. */
export function fieldQuery(path: string, types: string[]): Record<string, unknown> {
  if (types.includes("string") || types.includes("autocomplete")) {
    return types.includes("autocomplete") && !types.includes("string")
      ? { autocomplete: { query: "prefix", path } }
      : { text: { query: "search terms", path } };
  }
  if (types.includes("number")) return { range: { path, gte: 0 } };
  if (types.includes("date")) return { range: { path, gte: { $date: "2024-01-01T00:00:00Z" } } };
  if (types.includes("token") || types.includes("boolean") || types.includes("objectId") || types.includes("uuid")) {
    return { equals: { path, value: "value" } };
  }
  return { exists: { path } };
}
