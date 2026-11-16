/**
 * Relaxed Extended JSON helpers. The API returns BSON types as wrappers such as
 * `{"$oid": "..."}`; they stay wrapped so a document can be edited and written back.
 */

export interface EjsonInfo {
  type: string;
  display: string;
  /** Plain value for sorting and CSV. */
  plain: string | number;
}

const SINGLE_KEY_TYPES: Record<string, string> = {
  $oid: "ObjectId",
  $date: "Date",
  $numberDecimal: "Decimal128",
  $numberLong: "Int64",
  $numberDouble: "Double",
  $numberInt: "Int32",
  $symbol: "Symbol",
  $code: "Code",
  $uuid: "UUID",
  $minKey: "MinKey",
  $maxKey: "MaxKey",
  $binary: "Binary",
  $timestamp: "Timestamp",
  $regularExpression: "Regex",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Type info when `value` is an Extended JSON wrapper, otherwise null. */
export function ejsonInfo(value: unknown): EjsonInfo | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 2) return null;
  const key = keys[0];
  if (keys.length === 2) {
    if (keys.includes("$code") && keys.includes("$scope")) {
      return { type: "Code", display: String(value.$code), plain: String(value.$code) };
    }
    return null;
  }
  const type = SINGLE_KEY_TYPES[key];
  if (!type) return null;
  const raw = value[key];
  switch (key) {
    case "$date": {
      const iso = typeof raw === "string"
        ? raw
        : isPlainObject(raw) && typeof raw.$numberLong === "string"
          ? new Date(Number(raw.$numberLong)).toISOString()
          : String(raw);
      return { type, display: iso, plain: iso };
    }
    case "$numberDouble":
    case "$numberLong":
    case "$numberInt":
    case "$numberDecimal": {
      const text = String(raw);
      const number = Number(text);
      return { type, display: text, plain: Number.isFinite(number) && key !== "$numberLong" ? number : text };
    }
    case "$binary": {
      const sub = isPlainObject(raw) ? String(raw.subType ?? "") : "";
      const base64 = isPlainObject(raw) ? String(raw.base64 ?? "") : String(raw);
      const label = sub === "04" ? "UUID" : "Binary";
      return { type: label, display: base64.length > 32 ? `${base64.slice(0, 32)}…` : base64, plain: base64 };
    }
    case "$timestamp": {
      const t = isPlainObject(raw) ? `${raw.t}:${raw.i}` : String(raw);
      return { type, display: t, plain: t };
    }
    case "$regularExpression": {
      const pattern = isPlainObject(raw) ? `/${raw.pattern}/${raw.options ?? ""}` : String(raw);
      return { type, display: pattern, plain: pattern };
    }
    case "$minKey":
    case "$maxKey":
      return { type, display: type, plain: type };
    default:
      return { type, display: String(raw), plain: String(raw) };
  }
}

export function isEjsonWrapper(value: unknown): boolean {
  return ejsonInfo(value) !== null;
}

/** Short single-line rendering for tables. */
export function displayValue(value: unknown, max = 120): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  const info = ejsonInfo(value);
  if (info) return info.display;
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => typeof item === "number")) {
      return `[${value.length} numbers]`;
    }
    const text = JSON.stringify(value);
    return text.length > max ? `[${value.length} items]` : text;
  }
  const text = JSON.stringify(value);
  return text.length > max ? `{${Object.keys(value as object).length} fields}` : text;
}

/** Comparable value for sorting. */
export function sortValue(value: unknown): string | number {
  if (value === undefined || value === null) return "";
  const info = ejsonInfo(value);
  if (info) return info.plain;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value.toLowerCase();
  return JSON.stringify(value);
}

/** Read a dotted path. Arrays are not traversed. */
export function getPath(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const part of path.split(".")) {
    if (!isPlainObject(current) || isEjsonWrapper(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Flatten nested documents into dotted keys. Extended JSON wrappers and arrays are leaves.
 */
export function flatten(doc: unknown, prefix = "", out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (!isPlainObject(doc) || isEjsonWrapper(doc) || depth > 6) {
    if (prefix) out[prefix] = doc;
    return out;
  }
  const keys = Object.keys(doc);
  if (!keys.length && prefix) {
    out[prefix] = doc;
    return out;
  }
  for (const key of keys) {
    flatten(doc[key], prefix ? `${prefix}.${key}` : key, out, depth + 1);
  }
  return out;
}

/** Ordered union of flattened keys across documents, `_id` first. */
export function columnsFor(docs: unknown[], limit = 60): string[] {
  const seen = new Map<string, number>();
  for (const doc of docs.slice(0, 500)) {
    for (const key of Object.keys(flatten(doc))) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const keys = [...seen.keys()];
  keys.sort((a, b) => {
    if (a === "_id") return -1;
    if (b === "_id") return 1;
    return 0;
  });
  return keys.slice(0, limit);
}

/** Numeric arrays (embeddings) in a document, keyed by dotted path. */
export function numericArrays(doc: unknown, prefix = "", out: Array<{ path: string; values: number[] }> = []) {
  if (Array.isArray(doc)) {
    if (doc.length && doc.every((item) => typeof item === "number" || ejsonInfo(item)?.type === "Double")) {
      out.push({
        path: prefix,
        values: doc.map((item) => (typeof item === "number" ? item : Number(ejsonInfo(item)!.plain))),
      });
    }
    return out;
  }
  if (!isPlainObject(doc) || isEjsonWrapper(doc)) return out;
  for (const [key, value] of Object.entries(doc)) {
    numericArrays(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
