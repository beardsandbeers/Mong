export type PlanNode = Record<string, any>;

export function isPlanNode(value: unknown): value is PlanNode {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as PlanNode).type === "string";
}

/** Total milliseconds a node reports across its timing areas (context, match, score, ...). */
export function nodeMillis(node: PlanNode): number {
  const stats = node?.stats;
  if (!stats || typeof stats !== "object") return 0;
  let total = 0;
  for (const area of Object.values(stats as Record<string, any>)) {
    const ms = area?.millisElapsed;
    if (typeof ms === "number") total += ms;
  }
  return total;
}

/** Sum of invocation counts across a node's timing areas. */
export function nodeInvocations(node: PlanNode): number {
  let total = 0;
  for (const area of Object.values((node?.stats ?? {}) as Record<string, any>)) {
    for (const count of Object.values((area?.invocationCounts ?? {}) as Record<string, unknown>)) {
      total += Number(count) || 0;
    }
  }
  return total;
}

/** Child plan nodes nested anywhere in a node's args, labelled by the arg that holds them. */
export function planChildren(node: PlanNode): Array<{ label: string; node: PlanNode }> {
  const out: Array<{ label: string; node: PlanNode }> = [];
  const visit = (value: unknown, label: string) => {
    if (isPlanNode(value)) {
      out.push({ label, node: value });
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, label));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, key);
    }
  };
  for (const [key, value] of Object.entries(node.args ?? {})) visit(value, key);
  return out;
}

/** `key: value` pairs for a node's scalar args. */
export function scalarArgs(node: PlanNode): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node.args ?? {})) {
    if (value === null || typeof value !== "object") parts.push(`${key}: ${JSON.stringify(value)}`);
  }
  return parts.join(", ");
}
