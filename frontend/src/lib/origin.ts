import type { IndexInfo } from "./types";
import { namespaceOf, replicated } from "./capabilities";

/** An index coupled to a MongoDB collection, either listed from mongod or replicated into nomongo-t. */
export function isCoupled(index: IndexInfo | null | undefined): boolean {
  return (index?.source ?? "mongot") === "mongod" || replicated(index);
}

export function originLabel(index: IndexInfo | null | undefined): "Standalone" | "Coupled" {
  return isCoupled(index) ? "Coupled" : "Standalone";
}

/** `database.collection/index` for a coupled index, otherwise the index name. */
export function indexLabel(index: IndexInfo | null | undefined): string {
  if (!index) return "";
  const namespace = namespaceOf(index);
  const short = index.index_name || index.name;
  if (namespace && short && !short.includes("/")) return `${namespace}/${short}`;
  return index.name;
}

export function originTitle(index: IndexInfo | null | undefined): string {
  const namespace = namespaceOf(index);
  if (isCoupled(index)) {
    return namespace
      ? `Coupled to ${namespace}. Documents live in the collection and the index follows them.`
      : "Coupled to a MongoDB collection. Documents live in the collection and the index follows them.";
  }
  return "Standalone. Documents live in the index and are written through nomongo-t.";
}
