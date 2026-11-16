import { html } from "lit";
import { LightElement } from "../components/base";

class Placeholder extends LightElement {
  static properties = { name: {}, tab: {}, from: {}, template: {}, params: { attribute: false } };
  render() {
    return html`<div class="page">Coming soon</div>`;
  }
}

customElements.define("mong-activity", Placeholder);
