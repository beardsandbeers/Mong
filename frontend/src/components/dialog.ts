import { html, nothing, type TemplateResult } from "lit";
import { LightElement } from "./base";

export interface ConfirmOptions {
  title: string;
  message?: string | TemplateResult;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** The user must type this exact text to enable the confirm button. */
  typeToConfirm?: string;
  wide?: boolean;
}

interface OpenDialog {
  id: number;
  render: (close: (value: unknown) => void) => TemplateResult;
  resolve: (value: unknown) => void;
  wide: boolean;
}

let counter = 0;
const stack: OpenDialog[] = [];
let host: MongDialogHost | null = null;

/** Open a modal rendered by `render`; resolves with the value passed to `close`. */
export function openDialog<T>(
  render: (close: (value: T | null) => void) => TemplateResult,
  options: { wide?: boolean } = {},
): Promise<T | null> {
  return new Promise((resolve) => {
    stack.push({
      id: ++counter,
      render: render as OpenDialog["render"],
      resolve: resolve as OpenDialog["resolve"],
      wide: Boolean(options.wide),
    });
    host?.requestUpdate();
  });
}

function closeTop(id: number, value: unknown): void {
  const index = stack.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [item] = stack.splice(index, 1);
  item.resolve(value);
  host?.requestUpdate();
}

/** Confirmation modal. Destructive confirmations can require typing a name. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return openDialog<boolean>((close) => html`<mong-confirm .options=${options} .close=${close}></mong-confirm>`, {
    wide: options.wide,
  }).then((value) => value === true);
}

export class MongConfirm extends LightElement {
  static properties = { options: { attribute: false }, close: { attribute: false }, typed: { state: true } };
  declare options: ConfirmOptions;
  declare close: (value: boolean | null) => void;
  declare typed: string;

  constructor() {
    super();
    this.typed = "";
  }

  firstUpdated(): void {
    const target = this.querySelector<HTMLElement>("input") ?? this.querySelector<HTMLElement>("[data-autofocus]");
    target?.focus();
  }

  private get ready(): boolean {
    return !this.options.typeToConfirm || this.typed === this.options.typeToConfirm;
  }

  render() {
    const o = this.options;
    return html`<form
      @submit=${(event: Event) => {
        event.preventDefault();
        if (this.ready) this.close(true);
      }}
    >
      <div class="dialog__head"><h2>${o.title}</h2></div>
      <div class="dialog__body">
        ${typeof o.message === "string" ? html`<p>${o.message}</p>` : (o.message ?? nothing)}
        ${o.typeToConfirm
          ? html`<div class="field">
              <label>Type <strong class="mono">${o.typeToConfirm}</strong> to confirm</label>
              <input
                type="text"
                autocomplete="off"
                spellcheck="false"
                .value=${this.typed}
                @input=${(event: InputEvent) => (this.typed = (event.target as HTMLInputElement).value)}
              />
            </div>`
          : nothing}
      </div>
      <div class="dialog__foot">
        <button type="button" class="btn secondary" @click=${() => this.close(false)}>
          ${o.cancelText ?? "Cancel"}
        </button>
        <button type="submit" class="btn ${o.danger ? "danger" : ""}" ?disabled=${!this.ready} data-autofocus>
          ${o.confirmText ?? "Confirm"}
        </button>
      </div>
    </form>`;
  }
}

customElements.define("mong-confirm", MongConfirm);

export class MongDialogHost extends LightElement {
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && stack.length) {
      event.stopPropagation();
      closeTop(stack[stack.length - 1].id, null);
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    host = this;
    window.addEventListener("keydown", this.onKey, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    host = null;
    window.removeEventListener("keydown", this.onKey, true);
  }

  render() {
    return stack.map(
      (item) => html`<div class="overlay dialog-overlay" @click=${() => closeTop(item.id, null)}></div>
        <div class="dialog ${item.wide ? "wide" : ""}" role="dialog" aria-modal="true">
          ${item.render((value) => closeTop(item.id, value))}
        </div>`,
    );
  }
}

customElements.define("mong-dialog-host", MongDialogHost);
