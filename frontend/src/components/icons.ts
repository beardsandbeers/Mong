import { svg, type SVGTemplateResult } from "lit";

const PATHS: Record<string, SVGTemplateResult> = {
  search: svg`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  plus: svg`<path d="M12 5v14M5 12h14"/>`,
  refresh: svg`<path d="M20 11a8 8 0 0 0-14.9-3.9L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L20 15"/><path d="M20 20v-5h-5"/>`,
  x: svg`<path d="M18 6 6 18M6 6l12 12"/>`,
  chevronRight: svg`<path d="m9 6 6 6-6 6"/>`,
  chevronDown: svg`<path d="m6 9 6 6 6-6"/>`,
  trash: svg`<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>`,
  edit: svg`<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>`,
  copy: svg`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>`,
  download: svg`<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>`,
  upload: svg`<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>`,
  play: svg`<path d="M7 5v14l11-7z"/>`,
  pause: svg`<path d="M8 5v14M16 5v14"/>`,
  sun: svg`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  moon: svg`<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>`,
  command: svg`<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>`,
  dashboard: svg`<rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="15" width="8" height="6" rx="1.5"/>`,
  layers: svg`<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>`,
  explore: svg`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/>`,
  activity: svg`<path d="M3 12h4l3-8 4 16 3-8h4"/>`,
  alert: svg`<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>`,
  check: svg`<path d="m5 12 5 5 9-10"/>`,
  more: svg`<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>`,
  columns: svg`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>`,
  pin: svg`<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>`,
  sparkle: svg`<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>`,
  table: svg`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 10v10"/>`,
  tree: svg`<path d="M5 4v16M5 8h6M5 14h6M11 6h8v4h-8zM11 12h8v4h-8z"/>`,
  code: svg`<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>`,
  database: svg`<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`,
  briefcase: svg`<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>`,
  info: svg`<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>`,
  link: svg`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  clock: svg`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  stop: svg`<rect x="6" y="6" width="12" height="12" rx="2"/>`,
  external: svg`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`,
  format: svg`<path d="M4 6h16M4 12h10M4 18h13"/>`,
  history: svg`<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>`,
  star: svg`<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>`,
};

export type IconName = keyof typeof PATHS;

export function icon(name: string, size = 16) {
  return svg`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? PATHS.info}</svg>`;
}
