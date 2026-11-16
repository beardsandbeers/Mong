import type { ReactiveController, ReactiveControllerHost } from "lit";

type Listener<T> = (value: T) => void;

/** Minimal observable state container. */
export class Store<T extends object> {
  private current: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.current = initial;
  }

  get value(): T {
    return this.current;
  }

  set(patch: Partial<T> | ((value: T) => Partial<T>)): void {
    const next = typeof patch === "function" ? patch(this.current) : patch;
    this.current = { ...this.current, ...next };
    for (const listener of [...this.listeners]) listener(this.current);
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Re-renders a Lit host whenever the store changes. */
export class StoreController<T extends object> implements ReactiveController {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly store: Store<T>,
  ) {
    host.addController(this);
  }

  get value(): T {
    return this.store.value;
  }

  hostConnected(): void {
    this.unsubscribe = this.store.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
