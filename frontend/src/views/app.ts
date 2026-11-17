import { html, nothing, type TemplateResult } from "lit";
import { LightElement } from "../components/base";
import { originBadge } from "../components/index-origin";
import { originTitle } from "../lib/origin";
import { icon } from "../components/icons";
import { statusDot } from "../components/status-pill";
import { toast } from "../components/toast";
import { logActivity } from "../lib/activity";
import { PollController } from "../lib/poll";
import { href, navigate, RouteController } from "../lib/router";
import { appStore, refreshJobs, refreshSummary } from "../lib/state";
import { load, save } from "../lib/storage";
import { StoreController } from "../lib/store";

type Theme = "light" | "dark";

const NAV = [
  { path: "", label: "Dashboard", glyph: "dashboard" },
  { path: "indexes", label: "Indexes", glyph: "layers" },
  { path: "explore", label: "Explore", glyph: "explore" },
  { path: "activity", label: "Activity", glyph: "activity" },
];

export class MongApp extends LightElement {
  static properties = { jobsOpen: { state: true }, theme: { state: true } };
  declare jobsOpen: boolean;
  declare theme: Theme;

  private readonly router = new RouteController(this);
  private readonly app = new StoreController(this, appStore);
  readonly summaryPoll = new PollController(this, () => refreshSummary(), 5000);
  private readonly jobsPoll = new PollController(this, () => this.pollJobs(), 4000);

  constructor() {
    super();
    this.jobsOpen = false;
    this.theme = (document.documentElement.dataset.theme as Theme) || "light";
  }

  private activeJobIds = new Set<string>();

  private async pollJobs(): Promise<void> {
    await refreshJobs();
    const jobs = appStore.value.jobs;
    const finished = jobs.filter((job) => this.activeJobIds.has(job.id) && job.state !== "running" && job.state !== "queued");
    for (const job of finished) {
      const label = job.kind === "export" ? "Export" : job.kind === "clear_index" ? "Clear index" : "Delete by query";
      if (job.state === "succeeded") toast(`${label} on ${job.index_name} finished: ${job.message}`);
      else if (job.state === "failed") toast(`${label} on ${job.index_name} failed: ${job.error ?? "unknown error"}`, "error");
      else toast(`${label} on ${job.index_name} was cancelled`, "warn");
      logActivity({
        action: `${label} job ${job.state}`,
        index: job.index_name,
        ok: job.state === "succeeded",
        detail: job.error ?? job.message,
        ms: job.started_at && job.finished_at ? (job.finished_at - job.started_at) * 1000 : null,
      });
    }
    if (finished.some((job) => job.kind !== "export")) void refreshSummary({ force: true });
    this.activeJobIds = new Set(jobs.filter((job) => job.state === "running" || job.state === "queued").map((job) => job.id));
    this.jobsPoll.poller.interval = this.activeJobIds.size ? 1500 : 10000;
  }

  private toggleTheme(): void {
    this.theme = this.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = this.theme;
    save("theme", this.theme);
  }

  connectedCallback(): void {
    super.connectedCallback();
    const saved = load<Theme | null>("theme", null);
    if (saved) this.theme = saved;
    window.addEventListener("mong:jobs-changed", this.onJobsChanged);
    window.addEventListener("mong:open-jobs", this.onOpenJobs);
    window.addEventListener("mong:toggle-theme", this.onToggleTheme);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("mong:jobs-changed", this.onJobsChanged);
    window.removeEventListener("mong:open-jobs", this.onOpenJobs);
    window.removeEventListener("mong:toggle-theme", this.onToggleTheme);
  }

  private readonly onJobsChanged = () => {
    this.jobsPoll.poller.interval = 1500;
    this.jobsPoll.poller.trigger(true);
  };

  private readonly onOpenJobs = () => {
    this.jobsOpen = true;
  };

  private readonly onToggleTheme = () => this.toggleTheme();

  private section(): string {
    return this.router.route.segments[0] ?? "";
  }

  private crumbs(): TemplateResult {
    const [first, second, third] = this.router.route.segments;
    const part = (label: string, link?: string) =>
      link ? html`<a href=${link} style="color:inherit">${label}</a>` : html`<span>${label}</span>`;
    const sep = html`<span class="sep">/</span>`;
    if (!first) return part("Dashboard");
    if (first === "indexes") {
      if (!second) return part("Indexes");
      if (second === "new") return html`${part("Indexes", href("indexes"))}${sep}${part("New index")}`;
      return html`${part("Indexes", href("indexes"))}${sep}${part(second, third ? href(["indexes", second]) : undefined)}${third ? html`${sep}${part(third.charAt(0).toUpperCase() + third.slice(1))}` : nothing}`;
    }
    if (first === "explore") return part("Explore");
    if (first === "activity") return part("Activity");
    return part("Not found");
  }

  private page(): TemplateResult {
    const { segments, params } = this.router.route;
    const [first, second, third] = segments;
    switch (first ?? "") {
      case "":
      case "dashboard":
        return html`<mong-dashboard></mong-dashboard>`;
      case "indexes":
        if (!second) return html`<mong-indexes></mong-indexes>`;
        if (second === "new") {
          return html`<mong-index-create .from=${params.get("from") ?? ""} .template=${params.get("template") ?? ""}></mong-index-create>`;
        }
        return html`<mong-index-detail .name=${second} .tab=${third ?? "overview"}></mong-index-detail>`;
      case "explore":
        return html`<mong-explore .params=${params}></mong-explore>`;
      case "activity":
        return html`<mong-activity .tab=${params.get("tab") ?? "log"}></mong-activity>`;
      default:
        return html`<div class="page">
          <mong-empty
            heading="Page not found"
            .message=${"That address does not match a page."}
            .action=${html`<a class="btn" href="#/">Go to the dashboard</a>`}
          ></mong-empty>
        </div>`;
    }
  }

  private connectionPill(): TemplateResult {
    const { connection, summary } = this.app.value;
    const tone = connection === "ok" ? "ok" : connection === "degraded" ? "warn" : connection === "down" ? "danger" : "neutral";
    const label =
      connection === "ok"
        ? "Connected"
        : connection === "degraded"
          ? "Needs attention"
          : connection === "down"
            ? "Disconnected"
            : "Connecting…";
    const title = summary?.sampled_at ? `Last sample ${new Date(summary.sampled_at * 1000).toLocaleTimeString()}` : "";
    return html`<a class="pill" data-tone=${tone} href="#/" title=${title}>
      <span class="dot ${connection === "unknown" ? "pulse" : ""}" data-tone=${tone}></span>${label}
    </a>`;
  }

  private banner(): TemplateResult | typeof nothing {
    const { connection, connectionError } = this.app.value;
    if (connection !== "down") return nothing;
    return html`<div class="page" style="padding-bottom:0">
      <div class="alert" data-tone="danger" role="alert">
        ${icon("alert", 18)}
        <div class="alert__body">
          <div class="alert__title">Cannot reach mongot</div>
          <div class="small">${connectionError ?? "The last status request failed."}</div>
        </div>
        <button class="btn secondary sm" @click=${() => refreshSummary({ force: true })}>Retry</button>
      </div>
    </div>`;
  }

  render() {
    const { indexes, jobs } = this.app.value;
    const section = this.section();
    const activeJobs = jobs.filter((job) => job.state === "running" || job.state === "queued").length;
    const currentIndex = section === "indexes" ? this.router.route.segments[1] : this.router.route.params.get("index");
    return html`
      <aside class="sidebar">
        <a class="brand" href="#/" style="text-decoration:none;color:inherit">
          <span class="brand__mark">M</span>
          <span>
            <div class="brand__name">Mong</div>
            <div class="brand__sub">NoMongo-T console</div>
          </span>
        </a>
        <nav class="nav" aria-label="Main">
          ${NAV.map(
            (item) => html`<a href=${href(item.path)} class=${section === item.path || (!section && !item.path) ? "active" : ""}>
              ${icon(item.glyph)} ${item.label}
            </a>`,
          )}
        </nav>
        <nav class="nav" aria-label="Indexes">
          <div class="nav__section row between">
            <span>Indexes <span class="badge">${indexes.length}</span></span>
            <a href="#/indexes/new" title="New index" style="color:inherit">${icon("plus", 14)}</a>
          </div>
          ${indexes.map(
            (index) => html`<a
              class="nav__index ${currentIndex === index.name ? "active" : ""}"
              href=${href(["indexes", index.name])}
              title=${`${index.type}. ${originTitle(index)}`}
            >
              ${statusDot(index)}<span class="ellipsis">${index.name}</span>${originBadge(index)}
            </a>`,
          )}
        </nav>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="topbar__crumbs ellipsis">${this.crumbs()}</div>
          <div class="topbar__spacer"></div>
          ${this.connectionPill()}
          <div style="position:relative">
            <button
              class="btn ghost"
              aria-expanded=${this.jobsOpen ? "true" : "false"}
              @click=${() => (this.jobsOpen = !this.jobsOpen)}
              title="Background jobs"
            >
              ${icon("briefcase")} Jobs${activeJobs ? html`<span class="badge accent">${activeJobs}</span>` : nothing}
            </button>
            ${this.jobsOpen
              ? html`<mong-jobs-panel @close=${() => (this.jobsOpen = false)}></mong-jobs-panel>`
              : nothing}
          </div>
          <button
            class="btn ghost"
            title="Command palette (Ctrl+K)"
            @click=${() => window.dispatchEvent(new CustomEvent("mong:palette"))}
          >
            ${icon("command")} <span class="kbd">Ctrl K</span>
          </button>
          <button class="btn ghost icon" title="Toggle theme" aria-label="Toggle theme" @click=${() => this.toggleTheme()}>
            ${icon(this.theme === "dark" ? "sun" : "moon")}
          </button>
        </header>
        ${this.banner()}
        ${this.page()}
      </div>
      <mong-toasts></mong-toasts>
      <mong-dialog-host></mong-dialog-host>
      <mong-command-palette></mong-command-palette>
    `;
  }
}

customElements.define("mong-app", MongApp);

export function goToIndex(name: string, tab?: string): void {
  navigate(tab ? ["indexes", name, tab] : ["indexes", name]);
}
