import { columnsFor, ejsonInfo, flatten } from "./ejson";

function cell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const info = ejsonInfo(value);
  if (info) return String(info.plain);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV with one column per flattened path. Arrays and Extended JSON values are single cells.
 */
export function toCsv(docs: unknown[], columns = columnsFor(docs, 500)): string {
  const lines = [columns.map(quote).join(",")];
  for (const doc of docs) {
    const flat = flatten(doc);
    lines.push(columns.map((column) => quote(cell(flat[column]))).join(","));
  }
  return lines.join("\r\n");
}

export function toNdjson(docs: unknown[]): string {
  return docs.map((doc) => JSON.stringify(doc)).join("\n") + (docs.length ? "\n" : "");
}

export function download(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
