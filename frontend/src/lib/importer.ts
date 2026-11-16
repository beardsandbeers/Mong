import { errorMessage } from "./api";
import { fileChunks, readRecords } from "./ndjson";

export interface ImportProblem {
  where: string;
  message: string;
}

export interface ImportProgress {
  read: number;
  sent: number;
  bytes: number;
  problems: ImportProblem[];
}

export interface ImportOptions {
  upsert: (docs: Record<string, unknown>[], signal: AbortSignal) => Promise<{ indexed_count?: number }>;
  signal: AbortSignal;
  batchSize?: number;
  maxProblems?: number;
  /** Consecutive failed batches before the import gives up. */
  maxFailures?: number;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportSummary extends ImportProgress {
  cancelled: boolean;
  stopped: string | null;
}

const fmt = (n: number) => n.toLocaleString();

/**
 * Stream documents from an NDJSON or JSON-array file and upsert them in batches.
 * Bad records are reported and skipped; the import stops after `maxFailures` failed
 * batches in a row, or when `signal` aborts.
 */
export async function importFile(file: Blob, options: ImportOptions): Promise<ImportSummary> {
  const { upsert, signal, batchSize = 500, maxProblems = 200, maxFailures = 3, onProgress } = options;
  const progress: ImportProgress = { read: 0, sent: 0, bytes: 0, problems: [] };
  const encoder = new TextEncoder();
  let batch: Record<string, unknown>[] = [];
  let first = 0;
  let failures = 0;
  let stopped: string | null = null;
  const report = () => onProgress?.({ ...progress, problems: [...progress.problems] });
  const problem = (where: string, message: string) => {
    if (progress.problems.length < maxProblems) progress.problems.push({ where, message });
  };

  async function* counted(): AsyncGenerator<string> {
    for await (const chunk of fileChunks(file)) {
      progress.bytes += encoder.encode(chunk).length;
      yield chunk;
    }
  }

  const flush = async () => {
    if (!batch.length) return;
    const docs = batch;
    const range = `records ${fmt(first)}–${fmt(first + docs.length - 1)}`;
    batch = [];
    try {
      const result = await upsert(docs, signal);
      progress.sent += result.indexed_count ?? docs.length;
      failures = 0;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      failures += 1;
      problem(range, errorMessage(error));
      if (failures >= maxFailures) stopped = `Stopped after ${maxFailures} failed batches in a row.`;
    }
    report();
  };

  try {
    for await (const record of readRecords(counted())) {
      if (signal.aborted || stopped) break;
      progress.read = record.n;
      const where = `record ${fmt(record.n)}`;
      if (record.error) {
        problem(where, `${record.error}: ${record.text}`);
        continue;
      }
      const value = record.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        problem(where, "Not a JSON object");
        continue;
      }
      if ((value as Record<string, unknown>)._id === undefined) {
        problem(where, "Missing _id");
        continue;
      }
      if (!batch.length) first = record.n;
      batch.push(value as Record<string, unknown>);
      if (batch.length >= batchSize) await flush();
      else if (record.n % 100 === 0) report();
    }
    if (!signal.aborted && !stopped) await flush();
  } catch (error) {
    if ((error as Error)?.name !== "AbortError") stopped = errorMessage(error);
  }
  report();
  return { ...progress, cancelled: signal.aborted && !stopped, stopped };
}
