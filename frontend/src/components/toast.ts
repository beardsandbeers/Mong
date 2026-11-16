import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { LightElement } from "./base";
import { icon } from "./icons";

export type ToastKind = "info" | "error" | "warn";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

let counter = 0;
const items: ToastItem[] = [];
const hosts = new Set<MongToasts>();

/** Show a transient message. Errors stay longer. */
export function toast(message: string, kind: ToastKind = "info"): void {
  const item = { id: ++counter, message, kind };
  items.push(item);
  if (items.length > 5) items.shift();
  hosts.forEach((host) => host.requestUpdate());
  setTimeout(() => dismiss(item.id), kind === "error" ? 9000 : 4500);
}

function dismiss(id: number): void {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) items.splice(index, 1);
  hosts.forEach((host) => host.requestUpdate());
}

export class MongToasts extends LightElement {
  connectedCallback(): void {
    super.connectedCallback();
    hosts.add(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    hosts.delete(this);
  }

  render() {
    return html`<div class="toasts" role="status" aria-live="polite">
      ${repeat(
        items,
        (item) => item.id,
        (item) => html`<div class="toast" data-kind=${item.kind}>
          <span class="toast__msg">${item.message}</span>
          <button class="btn ghost sm icon" aria-label="Dismiss" @click=${() => dismiss(item.id)}>
            ${icon("x", 14)}
          </button>
        </div>`,
      )}
    </div>`;
  }
}

customElements.define("mong-toasts", MongToasts);
