import type { IndexInfo } from "./types";

export type StoredSource = "full" | "partial" | "none";

export interface VectorField {
  path: string;
  numDimensions: number | null;
  similarity: string | null;
}

export interface Capabilities {
  isVector: boolean;
  storedSource: StoredSource;
  browse: boolean;
  search: boolean;
  vector: boolean;
  editable: boolean;
  exportMappings: boolean;
  vectorFields: VectorField[];
  filterFields: string[];
  reasons: {
    browse?: string;
    search?: string;
    vector?: string;
    editable?: string;
  };
}

export function storedSourceOf(definition: Record<string, unknown> | null | undefined): StoredSource {
  const value = definition?.storedSource;
  if (value === true) return "full";
  if (value && typeof value === "object") return "partial";
  return "none";
}

/** What the UI can offer for an index, with the reason for anything it cannot. */
export function capabilities(index: IndexInfo | null | undefined): Capabilities {
  const isVector = index?.type === "VECTOR_SEARCH";
  const definition = index?.definition ?? null;
  const storedSource = storedSourceOf(definition);
  const fields = Array.isArray(definition?.fields) ? (definition!.fields as Record<string, unknown>[]) : [];
  const vectorFields: VectorField[] = isVector
    ? fields
      .filter((field) => field?.type === "vector" && typeof field.path === "string")
      .map((field) => ({
        path: String(field.path),
        numDimensions: typeof field.numDimensions === "number" ? field.numDimensions : null,
        similarity: typeof field.similarity === "string" ? field.similarity : null,
      }))
    : [];
  const filterFields = isVector
    ? fields.filter((field) => field?.type === "filter" && typeof field.path === "string").map((f) => String(f.path))
    : [];
  const reasons: Capabilities["reasons"] = {};
  if (isVector) {
    reasons.browse = "Browse uses a search operator; vector indexes only answer vector queries.";
    reasons.search = "This is a vector index. Use Vector mode.";
  } else {
    reasons.vector = "This is a search index. Vector queries need a VECTOR_SEARCH index.";
    if (storedSource === "none") {
      reasons.browse = "Browse needs stored source. Add \"storedSource\": true to the definition.";
    }
  }
  if (storedSource !== "full") {
    reasons.editable = storedSource === "partial"
      ? "This index stores only some fields. Upsert replaces the whole document, so editing here would drop the fields that are not stored."
      : "This index does not store documents, so the full document is not available to edit.";
  }
  return {
    isVector,
    storedSource,
    browse: !isVector && storedSource !== "none",
    search: !isVector,
    vector: isVector,
    editable: !isVector && storedSource === "full",
    exportMappings: !isVector,
    vectorFields,
    filterFields,
    reasons,
  };
}
