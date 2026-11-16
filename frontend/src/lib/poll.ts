import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Runs `task` every `intervalMs`, one call at a time. Pauses while the tab is hidden
 * and runs immediately when it becomes visible again.
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private readonly onVisibility = () => {
    if (!this.running) return;
    if (document.hidden) this.clear();
    else this.trigger();
  };

  constructor(
    private readonly task: () => unknown,
    private intervalMs: number,
  ) {}

  get interval(): number {
    return this.intervalMs;
  }

  set interval(value: number) {
    this.intervalMs = value;
    if (this.running) this.schedule();
  }

  start(immediate = true): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    if (immediate) this.trigger(true);
    else this.schedule();
  }

  stop(): void {
    this.running = false;
    this.clear();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  get active(): boolean {
    return this.running;
  }

  /** Run now. `force` runs even while the tab is hidden (the first load of a view). */
  async trigger(force = false): Promise<void> {
    this.clear();
    if (!this.running || this.inFlight || (document.hidden && !force)) {
      if (this.running && !this.inFlight) this.schedule();
      return;
    }
    this.inFlight = true;
    try {
      await this.task();
    } catch {
      // The task reports its own errors.
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  private schedule(): void {
    this.clear();
    if (!this.running || document.hidden) return;
    this.timer = setTimeout(() => this.trigger(), this.intervalMs);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A Poller bound to a Lit host's connected lifetime. */
export class PollController implements ReactiveController {
  readonly poller: Poller;

  constructor(host: ReactiveControllerHost, task: () => unknown, intervalMs: number) {
    this.poller = new Poller(task, intervalMs);
    host.addController(this);
  }

  hostConnected(): void {
    this.poller.start();
  }

  hostDisconnected(): void {
    this.poller.stop();
  }
}
