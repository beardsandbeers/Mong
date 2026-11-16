import { html, nothing, type TemplateResult } from "lit";
import { LightElement } from "./base";
import { icon } from "./icons";

/** Empty state with a suggested next action. */
export class MongEmpty extends LightElement {
  static properties = {
    heading: { type: String },
    message: { attribute: false },
    action: { attribute: false },
    glyph: { type: String },
  };
  declare heading: string;
  declare message: string | TemplateResult | null;
  declare action: TemplateResult | null;
  declare glyph: string;

  constructor() {
    super();
    this.heading = "";
    this.message = null;
    this.action = null;
    this.glyph = "database";
  }

  render() {
    return html`<div class="empty">
      ${icon(this.glyph, 36)}
      ${this.heading ? html`<div class="empty__title">${this.heading}</div>` : nothing}
      ${this.message ? html`<div>${this.message}</div>` : nothing}
      ${this.action ? html`<div style="margin-top:8px">${this.action}</div>` : nothing}
    </div>`;
  }
}

customElements.define("mong-empty", MongEmpty);
