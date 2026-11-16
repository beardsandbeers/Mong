import { LitElement } from "lit";

/**
 * Renders into light DOM. CodeMirror injects its styles into the document head and the
 * global design tokens and utility classes must reach every component.
 */
export class LightElement extends LitElement {
  protected createRenderRoot(): HTMLElement {
    return this;
  }
}
