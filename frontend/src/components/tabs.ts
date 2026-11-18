import { html, nothing } from "lit";
import { LightElement } from "./base";

export interface TabSpec {
  id: string;
  label: string;
  badge?: string | number | null;
  disabled?: boolean;
  title?: string;
}

/** Tab strip. Emits `tab-change` with the tab id; the owner renders the panel. */
export class MongTabs extends LightElement {
  static properties = { tabs: { attribute: false }, active: { type: String }, label: { type: String } };
  declare tabs: TabSpec[];
  declare active: string;
  declare label: string;

  constructor() {
    super();
    this.tabs = [];
    this.active = "";
    this.label = "";
  }

  private select(id: string): void {
    if (id === this.active) return;
    this.dispatchEvent(new CustomEvent("tab-change", { detail: id, bubbles: true }));
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const enabled = this.tabs.filter((tab) => !tab.disabled);
    const index = enabled.findIndex((tab) => tab.id === this.active);
    const next = enabled[(index + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length];
    if (next) this.select(next.id);
  }

  render() {
    return html`<div class="tabs" role="tablist" aria-label=${this.label || nothing} @keydown=${this.onKey}>
      ${this.tabs.map(
        (tab) => html`<button
          type="button"
          role="tab"
          aria-selected=${tab.id === this.active ? "true" : "false"}
          ?disabled=${tab.disabled}
          title=${tab.title ?? ""}
          @click=${() => this.select(tab.id)}
        >
          ${tab.label}${tab.badge != null && tab.badge !== "" ? html`<span class="badge">${tab.badge}</span>` : nothing}
        </button>`,
      )}
    </div>`;
  }
}

customElements.define("mong-tabs", MongTabs);
