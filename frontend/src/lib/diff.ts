export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

/** Line diff (LCS). Fine for index definitions, which are a few hundred lines at most. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Keep changed lines plus `context` lines around them. */
export function collapseContext(lines: DiffLine[], context = 3): Array<DiffLine | { kind: "gap"; count: number }> {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "ctx") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out: Array<DiffLine | { kind: "gap"; count: number }> = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (gap) out.push({ kind: "gap", count: gap });
      gap = 0;
      out.push(line);
    } else {
      gap += 1;
    }
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}

/** JSON with object keys sorted, so key order does not show up as a change. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item as object)
          .sort()
          .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value), null, 2);
}
