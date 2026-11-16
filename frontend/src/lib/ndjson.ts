/**
 * Streaming readers for document files. Neither loads the whole file: NDJSON is split
 * on newlines, and a JSON array is split into its top-level elements.
 */

export interface ParsedRecord {
  /** 1-based record number. */
  n: number;
  value?: unknown;
  error?: string;
  text: string;
}

/** Splits a top-level JSON array into element texts, chunk by chunk. */
export class JsonArraySplitter {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private started = false;
  private finished = false;
  private buffer = "";

  push(chunk: string): string[] {
    const out: string[] = [];
    for (const char of chunk) {
      if (this.finished) continue;
      if (!this.started) {
        if (/\s/.test(char)) continue;
        if (char !== "[") throw new Error("Expected a JSON array or NDJSON");
        this.started = true;
        continue;
      }
      if (this.inString) {
        this.buffer += char;
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') {
        this.inString = true;
        this.buffer += char;
        continue;
      }
      if (char === "{" || char === "[") {
        this.depth += 1;
        this.buffer += char;
        continue;
      }
      if (char === "}" || char === "]") {
        if (this.depth === 0 && char === "]") {
          if (this.buffer.trim()) out.push(this.buffer.trim());
          this.buffer = "";
          this.finished = true;
          continue;
        }
        this.depth -= 1;
        this.buffer += char;
        continue;
      }
      if (char === "," && this.depth === 0) {
        if (this.buffer.trim()) out.push(this.buffer.trim());
        this.buffer = "";
        continue;
      }
      this.buffer += char;
    }
    return out;
  }

  end(): string[] {
    if (!this.finished && this.started) throw new Error("The JSON array is not closed");
    return [];
  }
}

function parse(text: string, n: number): ParsedRecord {
  try {
    return { n, value: JSON.parse(text), text };
  } catch (error) {
    return { n, error: (error as Error).message, text: text.slice(0, 200) };
  }
}

/** Records from a stream of text chunks; the format is detected from the first character. */
export async function* readRecords(chunks: AsyncIterable<string>): AsyncGenerator<ParsedRecord> {
  let mode: "unknown" | "array" | "lines" = "unknown";
  let splitter: JsonArraySplitter | null = null;
  let pending = "";
  let n = 0;
  for await (const chunk of chunks) {
    let text = chunk;
    if (mode === "unknown") {
      pending += text;
      const first = pending.trimStart()[0];
      if (!first) continue;
      mode = first === "[" ? "array" : "lines";
      text = pending;
      pending = "";
      if (mode === "array") splitter = new JsonArraySplitter();
    }
    if (mode === "array") {
      for (const element of splitter!.push(text)) {
        n += 1;
        yield parse(element, n);
      }
      continue;
    }
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      n += 1;
      yield parse(line, n);
    }
  }
  if (mode === "array") {
    splitter!.end();
  } else if (pending.trim()) {
    n += 1;
    yield parse(pending, n);
  }
}

/** Text chunks of a File without reading it into memory. */
export async function* fileChunks(file: Blob): AsyncGenerator<string> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
