import { errorMessage } from "./api";
import { capList, load, save } from "./storage";
import { Store } from "./store";

export interface ActivityEntry {
  id: string;
  t: number;
  action: string;
  index: string | null;
  ok: boolean;
  detail: string;
  ms: number | null;
}

const KEY = "activity";

export const activityStore = new Store<{ entries: ActivityEntry[] }>({
  entries: load<ActivityEntry[]>(KEY, []),
});

export function logActivity(entry: Omit<ActivityEntry, "id" | "t"> & { t?: number }): void {
  const full: ActivityEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    t: entry.t ?? Date.now() / 1000,
    ...entry,
  };
  const entries = capList([full, ...activityStore.value.entries], 300, 400_000);
  activityStore.set({ entries });
  save(KEY, entries);
}

export function clearActivity(): void {
  activityStore.set({ entries: [] });
  save(KEY, []);
}

/** Run a mutating action and record its outcome and duration. */
export async function track<T>(
  action: string,
  index: string | null,
  run: () => Promise<T>,
  describe: (result: T) => string = () => "",
): Promise<T> {
  const started = performance.now();
  try {
    const result = await run();
    logActivity({ action, index, ok: true, detail: describe(result), ms: performance.now() - started });
    return result;
  } catch (error) {
    logActivity({ action, index, ok: false, detail: errorMessage(error), ms: performance.now() - started });
    throw error;
  }
}
