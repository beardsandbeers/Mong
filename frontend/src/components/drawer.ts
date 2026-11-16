import { html, nothing, type TemplateResult } from "lit";
import { LightElement } from "./base";
import { icon } from "./icons";

/**
 * Side panel. Light DOM has no slots, so the owner passes `body` and `footer` templates.
 * Emits `close` on the close button, Escape, or a backdrop click.
 */
export class MongDrawer extends LightElement {
  static properties = {
    open: { type: Boolean },
    heading: { attribute: false },
    subheading: { attribute: false },
    body: { attribute: false },
    footer: { attribute: false },
    actions: { attribute: false },
    wide: { type: Boolean },
  };
  declare open: boolean;
  declare heading: string | TemplateResult;
  declare subheading: string | TemplateResult | null;
  declare body: TemplateResult | null;
  declare footer: TemplateResult | null;
  declare actions: TemplateResult | null;
  declare wide: boolean;

  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.open) return;
    if (document.querySelector(".dialog")) return;
    if ((event.target as HTMLElement)?.closest?.(".cm-editor") && document.querySelector(".cm-tooltip-autocomplete")) return;
    this.requestClose();
  };

  constructor() {
    super();
    this.open = false;
    this.heading = "";
    this.subheading = null;
    this.body = null;
    this.footer = null;
    this.actions = null;
    this.wide = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }

  requestClose(): void {
    this.dispatchEvent(new CustomEvent("close", { bubbles: false }));
  }

  render() {
    if (!this.open) return nothing;
    return html`<div class="overlay" @click=${() => this.requestClose()}></div>
      <aside class="drawer ${this.wide ? "wide" : ""}" role="dialog" aria-modal="true">
        <div class="drawer__head">
          <div style="flex:1;min-width:0">
            <h2 class="ellipsis">${this.heading}</h2>
            ${this.subheading ? html`<div class="hint ellipsis">${this.subheading}</div>` : nothing}
          </div>
          ${this.actions ?? nothing}
          <button class="btn ghost icon" aria-label="Close" @click=${() => this.requestClose()}>${icon("x")}</button>
        </div>
        <div class="drawer__body">${this.body ?? nothing}</div>
        ${this.footer ? html`<div class="drawer__foot">${this.footer}</div>` : nothing}
      </aside>`;
  }
}

customElements.define("mong-drawer", MongDrawer);
