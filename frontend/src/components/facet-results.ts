import { html, nothing, type PropertyValues } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { bucketList, facetValue, numericValue, readFacet, type FacetBucket, type FacetResult } from "../lib/facets";
import { formatCompact, formatNumber, pluralize } from "../lib/format";
import { LightElement } from "./base";
import { icon } from "./icons";

const BUCKETS_PER_PAGE = 20;

function columnLabel(name: string): string {
  return name === "count" ? "Count" : name;
}

function axisLabel(value: number): string {
  return value !== 0 && Math.abs(value) < 1 ? String(Number(value.toPrecision(3))) : formatCompact(value);
}

function chartScale(buckets: FacetBucket[], metric: string) {
  let low = 0;
  let high = 0;
  for (const bucket of buckets) {
    const value = numericValue(bucket.values[metric]);
    if (value === null) continue;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  if (low === high) high = 1;
  // Scale first so opposite-signed values near MAX_VALUE cannot overflow.
  const magnitude = Math.max(Math.abs(low), Math.abs(high));
  const fraction = (value: number) => (value / magnitude - low / magnitude) / (high / magnitude - low / magnitude);
  return { low, high, fraction };
}

export class MongFacetResults extends LightElement {
  static properties = {
    facets: { attribute: false },
    selected: { state: true },
    drill: { state: true },
    view: { state: true },
    metric: { state: true },
    page: { state: true },
  };
  declare facets: FacetResult[];
  private declare selected: number;
  private declare drill: Array<{ bucket: string; facet: FacetResult }>;
  private declare view: "chart" | "table";
  private declare metric: string;
  private declare page: number;

  constructor() {
    super();
    this.facets = [];
    this.selected = 0;
    this.drill = [];
    this.resetView();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!changed.has("facets")) return;
    this.selected = 0;
    this.drill = [];
    this.resetView();
  }

  private resetView(): void {
    this.page = 0;
    this.metric = "";
    this.view = "chart";
  }

  private openChild(facet: FacetResult, bucket: FacetBucket, name: string): void {
    const child = readFacet(name, bucket.values[name], facet.children?.[name]);
    if (!child) return;
    this.drill = [...this.drill, { bucket: bucket.label, facet: child }];
    this.resetView();
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".facet-heading")?.focus());
  }

  private table(facet: FacetResult, rows: FacetBucket[]) {
    return html`<div class="table-wrap" tabindex="0" role="region" aria-label=${`${facet.name} bucket table`}>
      <table class="table compact facet-table">
        <thead><tr>
          <th scope="col">Bucket</th>
          ${facet.columns.map((key) => html`<th scope="col" class=${facet.metrics.includes(key) ? "num" : ""}>${columnLabel(key)}</th>`)}
        </tr></thead>
        <tbody>
          ${rows.map((bucket) => html`<tr>
            <th scope="row" class="mono">${bucket.label}</th>
            ${facet.columns.map((key) => {
              const entry = Object.hasOwn(bucket.values, key) ? bucket.values[key] : undefined;
              const children = bucketList(entry);
              return html`<td class=${facet.metrics.includes(key) ? "num" : ""}>
                ${children
                  ? html`<button class="btn secondary sm"
                      aria-label=${`View ${key} buckets for ${bucket.label}`}
                      @click=${() => this.openChild(facet, bucket, key)}
                    >${pluralize(children.length, "bucket")} ${icon("chevronRight", 12)}</button>`
                  : entry === undefined ? "—" : facetValue(entry)}
              </td>`;
            })}
          </tr>`)}
        </tbody>
      </table>
    </div>`;
  }

  private chart(facet: FacetResult, rows: FacetBucket[], metric: string) {
    const scale = chartScale(facet.buckets, metric);
    const baseline = scale.fraction(0) * 100;
    const range = facet.type === "date" || facet.type === "number";
    const marks = rows.map((bucket) => {
      const value = Object.hasOwn(bucket.values, metric) ? bucket.values[metric] : undefined;
      const numeric = numericValue(value);
      const position = numeric === null ? baseline : scale.fraction(numeric) * 100;
      const label = numeric === null ? "—" : facetValue(value);
      const title = `${bucket.label} · ${columnLabel(metric)} ${label}`;
      return html`<li class="facet-mark" title=${title} ?data-outside=${bucket.outsideRange}>
        <span class="facet-mark__label">${bucket.label}</span>
        <span class="facet-mark__track" aria-hidden="true"
          style=${styleMap({
            "--bar-start": `${Math.min(position, baseline)}%`,
            "--bar-size": `${Math.abs(position - baseline)}%`,
          })}
        ><span class="facet-mark__fill"></span></span>
        <span class="facet-mark__value">${label}</span>
      </li>`;
    });
    const label = `${columnLabel(metric)} by ${facet.name} bucket`;
    if (!range) {
      return html`<ul class="facet-bars" role="list" aria-label=${label}
        style=${styleMap({ "--bar-baseline": `${baseline}%` })}>${marks}</ul>`;
    }
    return html`<div class="facet-columns-scroll" role="region" aria-label=${label} tabindex="0">
      <div class="facet-columns" style=${styleMap({ "--bar-baseline": `${baseline}%` })}>
        <div class="facet-axis hint" aria-hidden="true">
          <span>${axisLabel(scale.high)}</span>
          <span>${axisLabel(scale.low * 0.5 + scale.high * 0.5)}</span>
          <span>${axisLabel(scale.low)}</span>
        </div>
        <ul class="facet-columns__marks" role="list" aria-label=${label}
          style=${styleMap({ "--bucket-count": String(rows.length) })}>${marks}</ul>
      </div>
    </div>`;
  }

  render() {
    const current = this.drill.at(-1);
    const facet = current?.facet ?? this.facets[this.selected];
    if (!facet) return nothing;
    const metric = this.metric || facet.metrics[0];
    const chart = this.view === "chart" && metric !== undefined;
    const { buckets } = facet;
    const start = this.page * BUCKETS_PER_PAGE;
    const end = Math.min(buckets.length, start + BUCKETS_PER_PAGE);
    const rows = buckets.slice(start, end);
    const ordered = facet.type === "date" || facet.type === "number";
    return html`<section class="card">
      <div class="card__head">
        <div class="row">
          ${current
            ? html`<button class="btn secondary sm" @click=${() => {
                this.drill = this.drill.slice(0, -1);
                this.resetView();
                void this.updateComplete.then(() => this.querySelector<HTMLElement>(".facet-heading")?.focus());
              }}>Back</button>`
            : nothing}
          <h2 class="facet-heading" tabindex="-1">${current ? facet.name : "Facet results"}</h2>
          ${!current
            ? html`<select aria-label="Facet" @change=${(event: Event) => {
                this.selected = (event.target as HTMLSelectElement).selectedIndex;
                this.resetView();
              }}>
                ${this.facets.map((item, index) => html`<option ?selected=${index === this.selected}>${item.name}</option>`)}
              </select>`
            : nothing}
        </div>
        ${buckets.length && metric !== undefined
          ? html`<div class="seg" role="group" aria-label="Facet view">
              <button type="button" aria-pressed=${chart} @click=${() => (this.view = "chart")}>
                ${icon("analytics", 14)} ${ordered ? "Columns" : "Bars"}
              </button>
              <button type="button" aria-pressed=${!chart} @click=${() => (this.view = "table")}>
                ${icon("table", 14)} Table
              </button>
            </div>`
          : nothing}
      </div>
      <div class="card__body stack">
        <div class="row between">
          <div class="row small muted">
            ${current ? html`<span>Within <strong>${current.bucket}</strong></span>` : nothing}
            ${facet.path ? html`<code>${facet.path}</code>` : nothing}
            <span>${pluralize(buckets.length, "bucket")}</span>
          </div>
          ${chart && facet.metrics.length > 1
            ? html`<label class="row small">Metric
                <select @change=${(event: Event) => (this.metric = (event.target as HTMLSelectElement).value)}>
                  ${facet.metrics.map((key) => html`<option .value=${key} ?selected=${key === metric}>${columnLabel(key)}</option>`)}
                </select>
              </label>`
            : nothing}
        </div>
        ${!buckets.length
          ? html`<p class="empty">This facet returned no buckets.</p>`
          : chart ? this.chart(facet, rows, metric) : this.table(facet, rows)}
        ${buckets.length > BUCKETS_PER_PAGE
          ? html`<div class="row between">
              <span class="hint" aria-live="polite">${formatNumber(start + 1)}–${formatNumber(end)} of ${formatNumber(buckets.length)}</span>
              <div class="row">
                <button class="btn secondary sm" ?disabled=${start === 0} @click=${() => (this.page -= 1)}>Previous</button>
                <button class="btn secondary sm" ?disabled=${end === buckets.length} @click=${() => (this.page += 1)}>Next</button>
              </div>
            </div>`
          : nothing}
      </div>
    </section>`;
  }
}

customElements.define("mong-facet-results", MongFacetResults);
