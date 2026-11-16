/** Vectors longer than this are not put in the URL. */
export const MAX_URL_VECTOR = 64;
/** Encoded queries longer than this are not put in the URL. */
export const MAX_URL_CHARS = 6000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "===".slice((base64.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** True when the value contains a numeric array longer than `limit`. */
export function hasLongVector(value: unknown, limit = MAX_URL_VECTOR): boolean {
  if (Array.isArray(value)) {
    if (value.length > limit && value.every((item) => typeof item === "number")) return true;
    return value.some((item) => hasLongVector(item, limit));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => hasLongVector(item, limit));
  }
  return false;
}

export type EncodeResult = { ok: true; value: string } | { ok: false; reason: string };

/** Compress query text for the URL hash, or explain why it is left out. */
export async function encodeQuery(text: string): Promise<EncodeResult> {
  if (!text.trim()) return { ok: true, value: "" };
  try {
    if (hasLongVector(JSON.parse(text))) {
      return { ok: false, reason: `Queries with vectors over ${MAX_URL_VECTOR} numbers are not saved in the URL.` };
    }
  } catch {
    // Invalid JSON is still shareable as text.
  }
  const compressed = await pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
  const value = toBase64Url(compressed);
  if (value.length > MAX_URL_CHARS) {
    return { ok: false, reason: "This query is too long to save in the URL." };
  }
  return { ok: true, value };
}

export async function decodeQuery(value: string): Promise<string | null> {
  if (!value) return null;
  try {
    const bytes = await pipe(fromBase64Url(value), new DecompressionStream("deflate-raw"));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
