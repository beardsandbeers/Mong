import { html, nothing } from "lit";
import { capabilities } from "../lib/capabilities";
import { navigate } from "../lib/router";
import { appStore, refreshSummary } from "../lib/state";
import { LightElement } from "./base";
import { icon } from "./icons";

export interface Command {
  id: string;
  label: string;
  group: string;
  glyph: string;
  keywords?: string;
  run: () => void;
}

/** Subsequence match; lower is better, null means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let score = 100;
  let position = -1;
  for (const char of q) {
    if (char === " ") continue;
    const next = t.indexOf(char, position + 1);
    if (next < 0) return null;
    score += next - position;
    position = next;
  }
  return score;
}

function commands(): Command[] {
  const base: Command[] = [
    { id: "nav:dashboard", label: "Dashboard", group: "Go to", glyph: "dashboard", run: () => navigate("") },
    { id: "nav:indexes", label: "Indexes", group: "Go to", glyph: "layers", run: () => navigate("indexes") },
    { id: "nav:explore", label: "Explore", group: "Go to", glyph: "explore", keywords: "query search", run: () => navigate("explore") },
    { id: "nav:activity", label: "Activity log", group: "Go to", glyph: "activity", run: () => navigate("activity") },
    {
      id: "nav:metrics",
      label: "Raw metrics",
      group: "Go to",
      glyph: "activity",
      keywords: "prometheus counters gauges",
      run: () => navigate("activity", { tab: "metrics" }),
    },
    { id: "act:new", label: "New index", group: "Action", glyph: "plus", keywords: "create", run: () => navigate("indexes/new") },
    {
      id: "act:theme",
      label: "Toggle light / dark theme",
      group: "Action",
      glyph: "moon",
      run: () => window.dispatchEvent(new CustomEvent("mong:toggle-theme")),
    },
    {
      id: "act:jobs",
      label: "Show background jobs",
      group: "Action",
      glyph: "briefcase",
      run: () => window.dispatchEvent(new CustomEvent("mong:open-jobs")),
    },
    { id: "act:refresh", label: "Refresh status", group: "Action", glyph: "refresh", run: () => refreshSummary({ force: true }) },
  ];
  for (const index of appStore.value.indexes) {
    const readOnly = capabilities(index).readOnly;
    base.push(
      {
        id: `idx:${index.name}`,
        label: `Open ${index.name}`,
        group: index.type === "VECTOR_SEARCH" ? "Vector index" : "Search index",
        glyph: "layers",
        keywords: index.name,
        run: () => navigate(["indexes", index.name]),
      },
      {
        id: `explore:${index.name}`,
        label: `Query ${index.name}`,
        group: "Explore",
        glyph: "explore",
        keywords: `search browse ${index.name}`,
        run: () => navigate("explore", { index: index.name }),
      },
      {
        id: `def:${index.name}`,
        label: `${readOnly ? "Definition" : "Edit definition"} of ${index.name}`,
        group: "Index",
        glyph: "code",
        run: () => navigate(["indexes", index.name, "definition"]),
      },
    );
    if (!readOnly) {
      base.push({
        id: `fields:${index.name}`,
        label: `Fields of ${index.name}`,
        group: "Index",
        glyph: "tree",
        run: () => navigate(["indexes", index.name, "fields"]),
      });
    }
  }
  return base;
}

/** Ctrl+K / Cmd+K launcher for pages, indexes, and actions. */
export class MongCommandPalette extends LightElement {
  static properties = { open: { state: true }, query: { state: true }, cursor: { state: true } };
  declare open: boolean;
  declare query: string;
  declare cursor: number;

  constructor() {
    super();
    this.open = false;
    this.query = "";
    this.cursor = 0;
  }

  private readonly onKey = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.toggle(!this.open);
    } else if (event.key === "Escape" && this.open) {
      event.stopPropagation();
      this.toggle(false);
    }
  };

  private readonly onOpen = () => this.toggle(true);

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("mong:palette", this.onOpen);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("mong:palette", this.onOpen);
  }

  private toggle(open: boolean): void {
    this.open = open;
    this.query = "";
    this.cursor = 0;
    if (open) this.updateComplete.then(() => this.querySelector("input")?.focus());
  }

  private get results(): Command[] {
    return commands()
      .map((command) => ({
        command,
        score: fuzzyScore(this.query, `${command.label} ${command.keywords ?? ""} ${command.group}`),
      }))
      .filter((item): item is { command: Command; score: number } => item.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 40)
      .map((item) => item.command);
  }

  private run(command: Command | undefined): void {
    if (!command) return;
    this.toggle(false);
    command.run();
  }

  private onInputKey(event: KeyboardEvent, results: Command[]): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.cursor = Math.min(results.length - 1, this.cursor + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.run(results[this.cursor]);
    }
  }

  protected updated(): void {
    this.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  render() {
    if (!this.open) return nothing;
    const results = this.results;
    return html`<div class="overlay" style="z-index:80" @click=${() => this.toggle(false)}></div>
      <div class="palette" role="dialog" aria-label="Command palette">
        <input
          type="text"
          placeholder="Jump to a page, index, or action…"
          .value=${this.query}
          @input=${(event: InputEvent) => {
            this.query = (event.target as HTMLInputElement).value;
            this.cursor = 0;
          }}
          @keydown=${(event: KeyboardEvent) => this.onInputKey(event, results)}
        />
        <div class="palette__list" role="listbox">
          ${results.map(
            (command, index) => html`<button
              class="palette__item"
              role="option"
              aria-selected=${index === this.cursor ? "true" : "false"}
              @mousemove=${() => (this.cursor = index)}
              @click=${() => this.run(command)}
            >
              ${icon(command.glyph)}<span>${command.label}</span><span class="group">${command.group}</span>
            </button>`,
          )}
          ${!results.length ? html`<div class="empty small">No matches</div>` : nothing}
        </div>
      </div>`;
  }
}

customElements.define("mong-command-palette", MongCommandPalette);
