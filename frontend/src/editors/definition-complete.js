import { applyCompletion } from "./complete.js";
import {
  BUILTIN_ANALYZERS,
  SORTABLE_TYPES,
  definedAnalyzers,
  definedTypeSets,
  fieldPrefix,
  localFieldNames,
  locate,
  mappedFields,
  specFor,
  valueTemplate,
} from "./definition-catalog.js";
import { contextAt, readJson } from "./context.js";

function matches(label, partial) {
  return !partial || label.startsWith(partial);
}

function keyOption(label, detail, scaffold, boost, type = "property") {
  return { label, detail, type, boost, applyKind: "key", scaffold };
}

function sortableNames(doc) {
  const types = new Map();
  for (const field of mappedFields(doc)) {
    if (!types.has(field.path)) types.set(field.path, new Set());
    types.get(field.path).add(field.type);
  }
  const names = [];
  for (const [path, fieldTypes] of types) {
    if ([...fieldTypes].some((type) => SORTABLE_TYPES.includes(type))) names.push(path);
  }
  return names.sort();
}

function keyCompletions(schema, ctx, model, doc) {
  if (!schema || schema.role !== "keys") return [];
  const options = [];
  const taken = new Set(ctx.existingKeys || []);
  for (const [name, spec] of Object.entries(schema.keySpecs || {})) {
    if (spec.hidden || taken.has(name)) continue;
    options.push(keyOption(
      name,
      spec.detail || spec.kind,
      JSON.stringify(valueTemplate(spec), null, 2),
      spec.required ? 30 : 10,
      spec.kind === "object" || spec.kind === "array" ? "keyword" : "property",
    ));
  }
  if (schema.freeform?.kind === "field-name") {
    for (const name of localFieldNames(model?.fieldPaths, fieldPrefix(ctx.objectPath))) {
      if (taken.has(name)) continue;
      options.push(keyOption(name, "indexed field", JSON.stringify({ type: "string" }, null, 2), 0, "variable"));
    }
  }
  if (schema.freeform?.kind === "sort-field") {
    for (const name of sortableNames(doc)) {
      if (taken.has(name)) continue;
      options.push(keyOption(name, "sortable field", "1", 0, "variable"));
    }
  }
  return options;
}

function valueCompletions(spec, model, doc) {
  if (!spec) return [];
  if (spec.kind === "enum") {
    return spec.values.map((value) => ({
      label: String(value),
      detail: "option",
      type: "enum",
      applyKind: "value",
      insert: value,
      quote: typeof value !== "number" && typeof value !== "boolean",
    }));
  }
  if (spec.kind === "boolean" || spec.kind === "dynamic" || spec.kind === "stored") {
    return [true, false].map((value) => ({
      label: String(value),
      detail: spec.kind === "boolean" ? "boolean" : spec.detail || spec.kind,
      type: "enum",
      applyKind: "value",
      insert: value,
      quote: false,
    }));
  }
  if (spec.kind === "analyzer") {
    const names = [...BUILTIN_ANALYZERS, ...definedAnalyzers(doc)];
    return [...new Set(names)].map((name) => ({
      label: name,
      detail: BUILTIN_ANALYZERS.includes(name) ? "built-in analyzer" : "custom analyzer",
      type: "constant",
      applyKind: "value",
      insert: name,
      quote: true,
    }));
  }
  if (spec.kind === "typeSet") {
    return definedTypeSets(doc).map((name) => ({
      label: name,
      detail: "type set",
      type: "constant",
      applyKind: "value",
      insert: name,
      quote: true,
    }));
  }
  if (spec.kind === "path") {
    return (model?.fieldPaths || []).map((field) => ({
      label: field.path,
      detail: (field.types || []).join(", ") || "field",
      type: "variable",
      applyKind: "value",
      insert: field.path,
      quote: true,
    }));
  }
  if (spec.kind === "sort-value") {
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
  if (schema?.role !== "array") return [];
  return (schema.scaffolds || []).map((item) => ({
    label: item.label,
    detail: item.detail || "",
    type: "keyword",
    boost: 20,
    applyKind: "element",
    scaffold: JSON.stringify(item.template, null, 2),
  }));
}

function finish(ctx, pos, options) {
  const filtered = options.filter((option) => matches(option.label, ctx.partial));
  if (!filtered.length) return null;
  const to = Math.min(Math.max(pos, ctx.from), ctx.to);
  return { from: ctx.from, to, options: filtered };
}

export function definitionCompletion(context, model) {
  const ctx = contextAt(context.state, context.pos);
  if (!ctx) return null;
  const mode = model?.mode === "VECTOR_SEARCH" ? "VECTOR_SEARCH" : "SEARCH";
  const doc = readJson(context.state);
  const schema = locate(mode, ctx.objectPath, doc);

  if (ctx.kind === "key") {
    if (ctx.enclose !== "quotes" && !context.explicit && !ctx.partial) return null;
    return finish(ctx, context.pos, keyCompletions(schema, ctx, model, doc));
  }
  if (ctx.kind === "element") {
    if (!context.explicit && !ctx.partial && ctx.enclose !== "quotes") return null;
    return finish(ctx, context.pos, elementCompletions(schema));
  }
  if (ctx.kind === "value") {
    const spec = specFor(schema, ctx.key);
    const options = valueCompletions(spec, model, doc);
    if (!options.length) return null;
    if (ctx.enclose === "bare" && !context.explicit) return null;
    return finish(ctx, context.pos, options);
  }
  return null;
}

export function definitionCompletionSource(readModel) {
  return (context) => {
    const result = definitionCompletion(context, readModel(context));
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
