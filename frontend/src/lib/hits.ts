import { ejsonInfo } from "./ejson";

export interface Hit {
  key: string;
  doc: Record<string, unknown>;
  score: number | null;
  id: unknown;
  hasSource: boolean;
  meta: Record<string, unknown>;
  raw: Record<string, unknown>;
}

const SCORE_KEYS = ["$searchScore", "$vectorSearchScore", "$score"];

/** Split a mongot hit into its document and search metadata (`$`-prefixed keys). */
export function normalizeHit(raw: Record<string, unknown>, ordinal: number): Hit {
  const meta: Record<string, unknown> = {};
  let doc: Record<string, unknown> = {};
  let hasSource = false;
  if (raw.storedSource && typeof raw.storedSource === "object") {
    doc = raw.storedSource as Record<string, unknown>;
    hasSource = true;
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "storedSource") meta[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith("$")) meta[key] = value;
      else doc[key] = value;
    }
  }
  let score: number | null = null;
  for (const key of SCORE_KEYS) {
    const value = meta[key];
    if (typeof value === "number") {
      score = value;
      break;
    }
    const info = ejsonInfo(value);
    if (info && typeof info.plain === "number") {
      score = info.plain;
      break;
    }
  }
  const id = doc._id;
  const idKey = id === undefined ? `#${ordinal}` : JSON.stringify(id);
  return { key: `${idKey}`, doc, score, id, hasSource, meta, raw };
}

export function normalizeHits(results: Record<string, unknown>[], offset = 0): Hit[] {
  return results.map((raw, index) => normalizeHit(raw, offset + index));
}
