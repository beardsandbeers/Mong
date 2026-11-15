import { EditorSelection } from "../../vendor/codemirror.js";
import {
  acceptedTypes,
  allowedOperators,
  indexModeType,
  isClauseKey,
  locate,
  MQL_COMPOUND,
  MQL_OPERATORS,
  operatorTemplate,
  specFor,
  valueTemplate,
} from "./catalog.js";
import { contextAt, effectiveIndexName } from "./context.js";
import { fieldsFor } from "./fields.js";

function typeLabel(types) {
  return [...types].join(", ");
}

function matches(label, partial) {
  return !partial || label.startsWith(partial);
}

function keyOption(label, detail, scaffold, boost, type = "property") {
  return { label, detail, type, boost, applyKind: "key", scaffold };
}

function keyCompletions(schema, ctx, fields) {
  if (!schema) return [];
  const options = [];
  const taken = new Set(ctx.existingKeys || []);

  if (schema.role === "mql") {
    for (const [name, spec] of Object.entries(MQL_COMPOUND)) {
      if (taken.has(name)) continue;
      options.push(keyOption(name, spec.detail, JSON.stringify(spec.template), 20, "keyword"));
    }
    for (const field of fields.suggest(schema.pathTypes || ["filter"])) {
      if (taken.has(field.path)) continue;
      options.push(keyOption(
        field.path,
        `${typeLabel(field.types)} · ${field.origin}`,
        '""',
        field.origin === "mapped" ? 5 : 0,
        "variable",
      ));
    }
    return options;
  }

  if (schema.role === "mql-value") {
    for (const [name, spec] of Object.entries(MQL_OPERATORS)) {
      if (taken.has(name)) continue;
      options.push(keyOption(name, spec.detail, JSON.stringify(spec.template), 20, "keyword"));
    }
    return options;
  }

  if (schema.role !== "keys") return [];
  const blocked = schema.singleOperator && [...taken].some((key) => isClauseKey(schema, key));

  for (const [name, spec] of Object.entries(schema.keySpecs || {})) {
    if (taken.has(name) || (blocked && spec.collector)) continue;
    options.push({
      label: name,
      detail: spec.detail || spec.kind,
      type: spec.collector ? "keyword" : "property",
      boost: spec.required ? 30 : 10,
      applyKind: "key",
      scaffold: JSON.stringify(valueTemplate(spec), null, 2),
    });
  }

  if (schema.acceptsOperators && !blocked) {
    for (const op of allowedOperators(schema)) {
      if (taken.has(op.name)) continue;
      options.push({
        label: op.name,
        detail: op.detail || "operator",
        type: "keyword",
        boost: 40,
        applyKind: "key",
        scaffold: JSON.stringify(operatorTemplate(op.name), null, 2),
      });
    }
  }

  if (schema.freeform?.suggestFields || schema.freeform?.kind === "field") {
    const accepted = schema.freeform.types || null;
    for (const field of fields.suggest(accepted)) {
      if (taken.has(field.path)) continue;
      const scaffold = schema.freeform.kind === "field"
        ? "1"
        : JSON.stringify({ type: "string", path: field.path });
      options.push({
        label: field.path,
        detail: `${typeLabel(field.types)} · ${field.origin}`,
        type: "variable",
        boost: 0,
        applyKind: "key",
        scaffold,
      });
    }
  }
  return options;
}

function valueCompletions(spec, schema, ctx, fields, mode, model) {
  if (!spec) return [];
  if (spec.kind === "index") {
    const wanted = spec.indexType || indexModeType(mode);
    return (model?.indexes || [])
      .filter((index) => index.type === wanted && index.name)
      .map((index) => ({
        label: index.name,
        detail: index.type,
        type: "constant",
        boost: 10,
        applyKind: "value",
        insert: index.name,
        quote: true,
      }));
  }
  if (spec.kind === "path" || spec.kind === "path-string") {
    const accepted = acceptedTypes(schema, spec);
    return fields.suggest(accepted).map((field) => ({
      label: field.path,
      detail: `${typeLabel(field.types)}${field.numDimensions ? ` · ${field.numDimensions}d` : ""} · ${field.origin}`,
      type: "variable",
      boost: field.origin === "mapped" ? 5 : 0,
      applyKind: "value",
      insert: field.path,
      quote: true,
    }));
  }
  if (spec.kind === "multi") {
    const info = fields.lookup(ctx.locals?.value || "");
    return (info?.multis || []).map((name) => ({
      label: name,
      detail: "multi analyzer",
      type: "enum",
      applyKind: "value",
      insert: name,
      quote: true,
    }));
  }
  if (spec.kind === "enum") {
    return spec.values.map((value) => ({
      label: String(value),
      detail: "option",
      type: "enum",
      applyKind: "value",
      insert: value,
      quote: typeof value !== "number",
    }));
  }
  if (spec.kind === "boolean") {
    return [true, false].map((value) => ({
      label: String(value),
      detail: "boolean",
      type: "enum",
      applyKind: "value",
      insert: value,
      quote: false,
    }));
  }
  if (spec.kind === "sort-dir") {
    return [1, -1].map((value) => ({
      label: String(value),
      detail: "sort direction",
      type: "enum",
      applyKind: "value",
      insert: value,
      quote: false,
    }));
  }
  return [];
}

function elementCompletions(schema) {
  const slot = schema?.role === "array" ? schema.item : schema;
  if (!slot?.acceptsOperators) return [];
  return allowedOperators(slot).map((op) => ({
    label: op.name,
    detail: op.detail || "operator",
    type: "keyword",
    boost: 40,
    applyKind: "element",
    scaffold: JSON.stringify({ [op.name]: operatorTemplate(op.name) }, null, 2),
  }));
}

function finish(ctx, pos, options) {
  const filtered = options.filter((option) => matches(option.label, ctx.partial));
  if (!filtered.length) return null;
  const to = Math.min(Math.max(pos, ctx.from), ctx.to);
  return { from: ctx.from, to, options: filtered };
}

export function queryCompletion(context, model) {
  const ctx = contextAt(context.state, context.pos);
  if (!ctx) return null;
  const mode = model?.mode === "vector" ? "vector" : "search";
  const indexName = effectiveIndexName(context.state, ctx.objectPath, ctx.key);
  const { fields } = fieldsFor(model, indexName);
  const schema = locate(mode, ctx.objectPath);

  if (ctx.kind === "key") {
    if (ctx.enclose !== "quotes" && !context.explicit && !ctx.partial) return null;
    return finish(ctx, context.pos, keyCompletions(schema, ctx, fields));
  }
  if (ctx.kind === "element") {
    if (!context.explicit && !ctx.partial && ctx.enclose !== "quotes") return null;
    return finish(ctx, context.pos, elementCompletions(schema));
  }
  if (ctx.kind === "value") {
    const spec = specFor(schema, ctx.key);
    const options = valueCompletions(spec, schema, ctx, fields, mode, model);
    if (!options.length) return null;
    if (ctx.enclose === "bare" && !context.explicit) return null;
    return finish(ctx, context.pos, options);
  }
  return null;
}

function withCommas(doc, ctx, text) {
  if (ctx.enclose !== "bare") return text;
  const before = doc.sliceString(ctx.containerFrom, ctx.from).replace(/\s+$/, "");
  const after = doc.sliceString(ctx.to, ctx.containerTo).replace(/^\s+/, "");
  let next = text;
  if (before && !before.endsWith("{") && !before.endsWith("[") && !before.endsWith(",")) next = `,\n  ${next}`;
  if (after && !after.startsWith("}") && !after.startsWith("]") && !after.startsWith(",")) next = `${next},`;
  return next;
}

function cursorFor(from, text) {
  const empty = text.indexOf('""');
  return EditorSelection.cursor(empty >= 0 ? from + empty + 1 : from + text.length);
}

export function applyCompletion(view, option) {
  const pos = view.state.selection.main.head;
  const ctx = contextAt(view.state, pos);
  if (!ctx) return;
  const doc = view.state.doc;

  if (option.applyKind === "element") {
    const span = ctx.unclosed
      ? { from: ctx.tokenFrom, to: ctx.tokenTo }
      : { from: ctx.from, to: ctx.to };
    const text = withCommas(
      doc,
      { ...ctx, from: span.from, to: span.to, enclose: ctx.unclosed ? "bare" : ctx.enclose },
      option.scaffold || "{}",
    );
    view.dispatch({ changes: { from: span.from, to: span.to, insert: text }, selection: cursorFor(span.from, text) });
    return;
  }

  if (ctx.kind === "key" && !ctx.hasValue) {
    const body = option.scaffold ?? '""';
    const replacement = `"${option.label}": ${body}`;
    if (ctx.enclose === "quotes") {
      const to = ctx.hasColon ? ctx.colonTo : ctx.nameTo;
      view.dispatch({
        changes: { from: ctx.nameFrom, to, insert: replacement },
        selection: cursorFor(ctx.nameFrom, replacement),
      });
      return;
    }
    const text = withCommas(doc, ctx, replacement);
    view.dispatch({
      changes: { from: ctx.from, to: ctx.to, insert: text },
      selection: cursorFor(ctx.from, text),
    });
    return;
  }

  if (ctx.kind === "key") {
    view.dispatch({
      changes: { from: ctx.from, to: ctx.to, insert: option.label },
      selection: EditorSelection.cursor(ctx.from + option.label.length),
    });
    return;
  }

  const raw = option.insert ?? option.label;
  if (ctx.unclosed && ctx.enclose === "quotes") {
    const insert = option.quote === false || typeof raw === "number" || typeof raw === "boolean"
      ? String(raw)
      : JSON.stringify(raw);
    view.dispatch({
      changes: { from: ctx.tokenFrom, to: ctx.tokenTo, insert },
      selection: EditorSelection.cursor(ctx.tokenFrom + insert.length),
    });
    return;
  }
  let text = option.quote === false || typeof raw === "number" || typeof raw === "boolean"
    ? String(raw)
    : raw;
  let from = ctx.from;
  let to = ctx.to;
  if (option.quote === false && ctx.enclose === "quotes") {
    from = ctx.tokenFrom;
    to = ctx.tokenTo;
  } else if (ctx.enclose === "bare" && option.quote !== false && typeof raw === "string") {
    text = JSON.stringify(raw);
  }
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
  });
}

export function queryCompletionSource(readModel) {
  return (context) => {
    const result = queryCompletion(context, readModel(context));
    if (!result) return null;
    return {
      from: result.from,
      to: result.to,
      validFor: /^[\w$.-]*$/,
      options: result.options.map((option) => ({
        label: option.label,
        detail: option.detail,
        type: option.type,
        boost: option.boost,
        apply: (view) => applyCompletion(view, option),
      })),
    };
  };
}
