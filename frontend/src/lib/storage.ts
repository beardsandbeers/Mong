const PREFIX = "mong.";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Save JSON; returns false when the quota is exceeded. */
export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Storage unavailable.
  }
}

/** Keep a list under `maxBytes` of JSON by dropping the oldest entries (at the end). */
export function capList<T>(items: T[], maxItems: number, maxBytes: number): T[] {
  let list = items.slice(0, maxItems);
  while (list.length > 1 && JSON.stringify(list).length > maxBytes) {
    list = list.slice(0, Math.max(1, Math.floor(list.length * 0.8)));
  }
  return list;
}
