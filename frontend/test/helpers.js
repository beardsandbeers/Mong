import { EditorState, json } from "../src/editors/codemirror.js";

export function withCursor(text) {
  const pos = text.indexOf("|");
  if (pos < 0) throw new Error("missing cursor marker");
  const doc = text.slice(0, pos) + text.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [json()] });
  return { state, pos };
}

export function labels(result) {
  return (result?.options || []).map((option) => option.label);
}
