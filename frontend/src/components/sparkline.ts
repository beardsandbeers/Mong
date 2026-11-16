import { html, svg } from "lit";
import { LightElement } from "./base";

/** Tiny inline trend line. Gaps (null) break the line. */
export class MongSparkline extends LightElement {
  static properties = {
    values: { attribute: false },
    width: { type: Number },
    height: { type: Number },
    color: { type: String },
  };
  declare values: Array<number | null>;
  declare width: number;
  declare height: number;
  declare color: string;

  constructor() {
    super();
    this.values = [];
    this.width = 96;
    this.height = 24;
    this.color = "var(--accent)";
  }

  render() {
    const points = this.values;
    const numbers = points.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (numbers.length < 2) {
      return html`<svg width=${this.width} height=${this.height}></svg>`;
    }
    const max = Math.max(...numbers);
    const min = Math.min(0, ...numbers);
    const span = max - min || 1;
    const step = this.width / Math.max(1, points.length - 1);
    const segments: string[] = [];
    let current = "";
    points.forEach((value, index) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        if (current) segments.push(current);
        current = "";
        return;
      }
      const x = (index * step).toFixed(1);
      const y = (this.height - 2 - ((value - min) / span) * (this.height - 4)).toFixed(1);
      current += `${current ? "L" : "M"}${x},${y}`;
    });
    if (current) segments.push(current);
    const last = numbers[numbers.length - 1];
    const lastY = this.height - 2 - ((last - min) / span) * (this.height - 4);
    return html`<svg width=${this.width} height=${this.height} viewBox="0 0 ${this.width} ${this.height}">
      ${segments.map(
        (d) => svg`<path d=${d} fill="none" stroke=${this.color} stroke-width="1.5" stroke-linejoin="round" />`,
      )}
      ${svg`<circle cx=${this.width} cy=${lastY.toFixed(1)} r="2" fill=${this.color} />`}
    </svg>`;
  }
}

customElements.define("mong-sparkline", MongSparkline);
