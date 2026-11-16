import { html, type PropertyValues } from "lit";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { LightElement } from "./base";

export interface ChartSeries {
  label: string;
  values: Array<number | null>;
  /** CSS color or `var(--token)`; defaults cycle through the chart palette. */
  color?: string;
}

export interface ChartMarker {
  t: number;
  label: string;
}

const PALETTE = Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`);

function cssVar(name: string, fallback = "#888"): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function resolveColor(color: string | undefined, index: number): string {
  if (!color) return cssVar(PALETTE[index % PALETTE.length]);
  const match = /^var\((--[\w-]+)\)$/.exec(color);
  return match ? cssVar(match[1]) : color;
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const value = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0");
    return `${color}${value}`;
  }
  return color;
}

/**
 * Time-series chart (uPlot). `times` are epoch seconds. `stacked` draws cumulative areas
 * while the legend still shows each series' own value.
 */
export class MongChart extends LightElement {
  static properties = {
    times: { attribute: false },
    series: { attribute: false },
    markers: { attribute: false },
    height: { type: Number },
    stacked: { type: Boolean },
    format: { attribute: false },
    emptyText: { type: String },
  };
  declare times: number[];
  declare series: ChartSeries[];
  declare markers: ChartMarker[];
  declare height: number;
  declare stacked: boolean;
  declare format: (value: number | null) => string;
  declare emptyText: string;

  private plot: uPlot | null = null;
  private signature = "";
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;

  constructor() {
    super();
    this.times = [];
    this.series = [];
    this.markers = [];
    this.height = 180;
    this.stacked = false;
    this.format = (value) => (value == null ? "—" : String(Math.round(value * 100) / 100));
    this.emptyText = "Collecting samples…";
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this);
    this.themeObserver = new MutationObserver(() => this.rebuild());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.plot?.destroy();
    this.plot = null;
    this.signature = "";
  }

  render() {
    const hasData = this.times.length >= 2 && this.series.length > 0;
    return html`<div class="chart-host" ?hidden=${!hasData}></div>
      <div class="chart-empty" style="height:${this.height}px" ?hidden=${hasData}>${this.emptyText}</div>`;
  }

  protected updated(_changed: PropertyValues): void {
    this.draw();
  }

  private data(): AlignedData {
    const ys = this.series.map((item) => item.values.map((value) => (value == null ? null : value)));
    if (!this.stacked) return [this.times, ...ys] as AlignedData;
    const stacked: Array<Array<number | null>> = [];
    ys.forEach((values, s) => {
      stacked.push(
        values.map((value, i) => {
          const below = s > 0 ? stacked[s - 1][i] : 0;
          return (value ?? 0) + (below ?? 0);
        }),
      );
    });
    return [this.times, ...stacked] as AlignedData;
  }

  private rebuild(): void {
    this.plot?.destroy();
    this.plot = null;
    this.signature = "";
    this.draw();
  }

  private draw(): void {
    const container = this.querySelector<HTMLElement>(".chart-host");
    if (!container) return;
    if (this.times.length < 2 || !this.series.length) {
      this.plot?.destroy();
      this.plot = null;
      this.signature = "";
      return;
    }
    const signature = `${this.series.map((s) => `${s.label}|${s.color ?? ""}`).join(",")}|${this.stacked}|${this.height}`;
    const data = this.data();
    if (this.plot && signature === this.signature) {
      this.plot.setData(data, false);
      this.plot.setScale("x", { min: this.times[0], max: this.times[this.times.length - 1] });
      return;
    }
    this.plot?.destroy();
    this.signature = signature;
    const width = Math.max(200, container.clientWidth || this.clientWidth || 400);
    this.plot = new uPlot(this.options(width), data, container);
  }

  private resize(): void {
    if (!this.plot) return;
    const container = this.querySelector<HTMLElement>(".chart-host");
    const width = container?.clientWidth || this.clientWidth;
    if (width && Math.abs(width - this.plot.width) > 2) {
      this.plot.setSize({ width, height: this.height });
    }
  }

  private options(width: number): Options {
    const ink = cssVar("--muted");
    const grid = cssVar("--line");
    const format = this.format;
    const originals = this.series.map((item) => item.values);
    const markers = () => this.markers;
    const markerColor = cssVar("--warn");
    return {
      width,
      height: this.height,
      padding: [8, 8, 0, 0],
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      legend: { live: true },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [Math.min(0, min), max > 0 ? max * 1.1 : 1] } },
      axes: [
        { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 28 },
        {
          stroke: ink,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 64,
          values: (_u, splits) => splits.map((value) => format(value)),
        },
      ],
      series: [
        { label: "Time", value: (_u, value) => (value == null ? "—" : new Date(value * 1000).toLocaleTimeString()) },
        ...this.series.map((item, index) => {
          const color = resolveColor(item.color, index);
          return {
            label: item.label,
            stroke: color,
            width: 1.6,
            fill: this.stacked ? withAlpha(color, 0.35) : withAlpha(color, 0.08),
            points: { show: false },
            spanGaps: false,
            value: (_u: uPlot, value: number | null, _s: number, idx: number | null) =>
              format(this.stacked && idx != null ? (originals[index][idx] ?? null) : value),
          };
        }),
      ],
      hooks: {
        draw: [
          (u: uPlot) => {
            const list = markers();
            if (!list.length) return;
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = markerColor;
            ctx.fillStyle = markerColor;
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1 * devicePixelRatio;
            ctx.font = `${10 * devicePixelRatio}px sans-serif`;
            for (const marker of list) {
              const x = u.valToPos(marker.t, "x", true);
              if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.fillText(marker.label, x + 3 * devicePixelRatio, u.bbox.top + 10 * devicePixelRatio);
            }
            ctx.restore();
          },
        ],
      },
    };
  }
}

customElements.define("mong-chart", MongChart);
