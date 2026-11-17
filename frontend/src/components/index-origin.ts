import { html } from "lit";
import { isCoupled, originLabel, originTitle } from "../lib/origin";
import type { IndexInfo } from "../lib/types";

/** Short Standalone / Coupled marker for any view that names an index. */
export function originBadge(index: IndexInfo | null | undefined) {
  const coupled = isCoupled(index);
  return html`<span class="badge ${coupled ? "coupled" : ""}" title=${originTitle(index)}>${originLabel(index)}</span>`;
}
