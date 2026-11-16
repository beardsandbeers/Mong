import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ChartMarker } from "../components/chart";
import { api, errorMessage } from "./api";
import { Poller } from "./poll";
import type { Annotation, IndexMetrics, InstanceMetrics, MetricsSeries, SeriesSample } from "./types";

const MAX_SAMPLES = 720;

export const WINDOWS = [
  { id: "5m", label: "5 min", seconds: 300 },
  { id: "15m", label: "15 min", seconds: 900 },
  { id: "1h", label: "1 hour", seconds: 3600 },
] as const;

export type WindowId = (typeof WINDOWS)[number]["id"];

export function windowSeconds(id: string): number {
  return WINDOWS.find((item) => item.id === id)?.seconds ?? 900;
}

/**
 * Keeps a local copy of the server's metrics history, fetching only new samples on
 * each poll. `index` limits per-index series to one index id.
 */
export class SeriesController implements ReactiveController {
  samples: SeriesSample[] = [];
  annotations: Annotation[] = [];
  interval = 5;
  error: string | null = null;
  loaded = false;
  private readonly poller: Poller;
  private currentIndex: string | undefined;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly index: () => string | undefined = () => undefined,
    intervalMs = 5000,
  ) {
    this.poller = new Poller(() => this.fetch(), intervalMs);
    host.addController(this);
  }

  hostConnected(): void {
    this.poller.start();
  }

  hostDisconnected(): void {
    this.poller.stop();
  }

  refresh(): Promise<void> {
    return this.poller.trigger(true);
  }

  get paused(): boolean {
    return !this.poller.active;
  }

  set paused(value: boolean) {
    if (value) this.poller.stop();
    else this.poller.start();
    this.host.requestUpdate();
  }

  private async fetch(): Promise<void> {
    const index = this.index();
    if (index !== this.currentIndex) {
      this.currentIndex = index;
      this.samples = [];
      this.annotations = [];
      this.loaded = false;
    }
    const since = this.samples.at(-1)?.t;
    try {
      const body: MetricsSeries = await api.metricsSeries({ index, since });
      if (index !== this.currentIndex) return;
      this.interval = body.interval;
      this.samples = [...this.samples, ...body.samples].slice(-MAX_SAMPLES);
      const seen = new Set(this.annotations.map((item) => `${item.t}|${item.kind}|${item.index_id}`));
      const fresh = body.annotations.filter((item) => !seen.has(`${item.t}|${item.kind}|${item.index_id}`));
      const oldest = this.samples[0]?.t ?? 0;
      this.annotations = [...this.annotations, ...fresh].filter((item) => item.t >= oldest);
      this.error = null;
    } catch (error) {
      this.error = errorMessage(error);
    }
    this.loaded = true;
    this.host.requestUpdate();
  }

  /** Samples within the last `seconds` of the newest sample. */
  window(seconds: number): SeriesSample[] {
    const last = this.samples.at(-1)?.t;
    if (last == null) return [];
    return this.samples.filter((sample) => sample.t >= last - seconds);
  }

  markers(samples: SeriesSample[], indexId?: string): ChartMarker[] {
    const first = samples[0]?.t;
    if (first == null) return [];
    return this.annotations
      .filter((item) => item.t >= first && (!indexId || item.index_id === indexId || item.index_id == null))
      .map((item) => ({ t: item.t, label: item.label }));
  }
}

export function times(samples: SeriesSample[]): number[] {
  return samples.map((sample) => sample.t);
}

export function instanceValues(samples: SeriesSample[], key: keyof InstanceMetrics): Array<number | null> {
  return samples.map((sample) => sample.instance[key] ?? null);
}

export function indexValues(
  samples: SeriesSample[],
  indexId: string,
  key: keyof IndexMetrics,
): Array<number | null> {
  return samples.map((sample) => sample.indexes[indexId]?.[key] ?? null);
}

export function rpcOperations(samples: SeriesSample[]): string[] {
  const ops = new Set<string>();
  for (const sample of samples) for (const op of Object.keys(sample.rpc)) ops.add(op);
  return [...ops].sort();
}

export function rpcValues(
  samples: SeriesSample[],
  operation: string,
  key: "rate" | "error_rate" | "mean_ms",
): Array<number | null> {
  return samples.map((sample) => sample.rpc[operation]?.[key] ?? null);
}

/** True when every value is null or zero, so a chart would be a flat line. */
export function allQuiet(values: Array<number | null>): boolean {
  return values.every((value) => !value);
}
