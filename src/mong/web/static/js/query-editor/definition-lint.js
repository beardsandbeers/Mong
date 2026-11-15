import {
  SORTABLE_TYPES,
  analyzerIssue,
  definedAnalyzers,
  definedTypeSets,
  locate,
  mappedFields,
  specFor,
} from "./definition-catalog.js";
import { readJson, syntaxDiagnostic } from "./context.js";

const JSON_MESSAGE = "Definition must be valid JSON";

function diag(from, to, severity, message) {
  return { from, to: Math.max(to, from), severity, message };
}

function shapeOk(value, spec) {
  switch (spec.kind) {
    case "string":
    case "analyzer":
    case "path":
    case "typeSet":
      return value.kind === "string";
    case "number":
      return value.kind === "number";
    case "boolean":
      return value.kind === "boolean";
    case "enum":
      return value.kind === "string" || value.kind === "number";
    case "array":
    case "string-array":
      return value.kind === "array";
    case "object":
      return value.kind === "object";
    case "field-value":
      return value.kind === "object" || value.kind === "array";
    case "dynamic":
    case "stored":
      return value.kind === "boolean" || value.kind === "object";
    case "sort-value":
      return value.kind === "number" || value.kind === "object";
    default:
      return true;
  }
}

function expectedMessage(key, spec) {
  switch (spec.kind) {
    case "dynamic":
      return `"${key}" must be a boolean or document`;
    case "stored":
      return `"${key}" must be a boolean or object`;
    case "field-value":
      return `"${key}" must be an object or array of objects`;
    case "sort-value":
      return `"${key}" must be 1, -1, or an object`;
    case "string":
    case "analyzer":
    case "path":
    case "typeSet":
      return `"${key}" must be a string`;
    case "number":
      return `"${key}" must be a number`;
    case "boolean":
      return `"${key}" must be a boolean`;
    case "enum":
      return `"${key}" must be one of ${spec.values.join(", ")}`;
    case "array":
    case "string-array":
      return `"${key}" must be an array`;
    default:
      return `"${key}" must be an object`;
  }
}

function lintGrams(obj, diags) {
  const min = obj.properties.find((item) => item.key === "minGrams" && item.value?.kind === "number");
  const max = obj.properties.find((item) => item.key === "maxGrams" && item.value?.kind === "number");
  if (min && max && min.value.value > max.value.value) {
    diags.push(diag(min.value.from, min.value.to, "error", "minGrams cannot be greater than maxGrams"));
  }
}

function lintSort(prop, value, root, diags) {
  const fields = mappedFields(root).filter((field) => field.path === prop.key);
  if (!fields.length) {
    diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Sort field "${prop.key}" is not statically defined`));
  } else if (!fields.some((field) => SORTABLE_TYPES.includes(field.type))) {
    diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Sort field "${prop.key}" is not a sortable type`));
  }
  if (value.kind === "number" && value.value !== 1 && value.value !== -1) {
    diags.push(diag(value.from, value.to, "warning", `"${prop.key}" must be 1 or -1`));
  }
}

function lintProperty(prop, spec, mode, path, root, diags) {
  const value = prop.value;
  if (!value) {
    diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Missing value for "${prop.key}"`));
    return;
  }
  if (spec.unsupported) {
    if (value.kind !== "array") {
      diags.push(diag(value.from, value.to, "error", `"${prop.key}" must be an array`));
      return;
    }
    if (value.items.length) {
      diags.push(diag(value.from, value.to, "error", "MongoDB synonym sources are unsupported in standalone"));
    }
    return;
  }
  if (!shapeOk(value, spec)) {
    diags.push(diag(value.from, value.to, "error", expectedMessage(prop.key, spec)));
    return;
  }

  if (spec.kind === "string" && spec.required && value.kind === "string" && !value.value) {
    diags.push(diag(value.from, value.to, "error", `"${prop.key}" is empty`));
  }

  if (spec.kind === "enum") {
    if (!spec.values.includes(value.value)) {
      const message = spec.strict
        ? `Field type "${value.value}" is not valid on a ${mode === "VECTOR_SEARCH" ? "vector" : "search"} index`
        : `"${prop.key}" must be one of ${spec.values.join(", ")}`;
      diags.push(diag(value.from, value.to, spec.strict ? "error" : "warning", message));
    }
    return;
  }

  if (spec.kind === "number" && spec.range) {
    const [min, max] = spec.range;
    if (!Number.isInteger(value.value) || value.value < min || value.value > max) {
      diags.push(diag(value.from, value.to, "error", `"${prop.key}" must be between ${min} and ${max}`));
    }
    return;
  }

  if (spec.kind === "analyzer") {
    const issue = analyzerIssue(value.value, definedAnalyzers(root));
    if (issue) diags.push(diag(value.from, value.to, issue.severity, issue.message));
    return;
  }

  if (spec.kind === "typeSet") {
    if (!value.value) diags.push(diag(value.from, value.to, "error", "typeSet name is empty"));
    else if (!definedTypeSets(root).includes(value.value)) {
      diags.push(diag(value.from, value.to, "warning", `Unknown type set "${value.value}"`));
    }
    return;
  }

  if (spec.kind === "path") {
    if (!value.value) diags.push(diag(value.from, value.to, "error", "Path is empty"));
    return;
  }

  if (spec.kind === "string-array") {
    for (const item of value.items) {
      if (item.kind !== "string") {
        diags.push(diag(item.from, item.to, "error", `"${prop.key}" must be an array of strings`));
      }
    }
    return;
  }

  if (spec.kind === "sort-value") {
    lintSort(prop, value, root, diags);
    if (value.kind === "object") lintNode(value, mode, path.concat(prop.key), root, diags);
    return;
  }

  if (spec.kind === "field-value") {
    if (value.kind === "object") lintNode(value, mode, path.concat(prop.key), root, diags);
    else {
      value.items.forEach((item, index) => {
        if (item.kind !== "object") {
          diags.push(diag(item.from, item.to, "error", `"${prop.key}" entries must be objects`));
        } else {
          lintNode(item, mode, path.concat(prop.key, index), root, diags);
        }
      });
    }
    return;
  }

  if (spec.kind === "array") {
    if (spec.nonEmpty && !value.items.length) {
      diags.push(diag(value.from, value.to, "error", `"${prop.key}" cannot be empty`));
    }
    if (spec.warnIfEmpty && !value.items.length) {
      diags.push(diag(value.from, value.to, "warning", "Vector fields array is empty"));
    }
    lintNode(value, mode, path.concat(prop.key), root, diags);
    return;
  }

  if (value.kind === "object" && (spec.kind === "object" || spec.kind === "dynamic" || spec.kind === "stored")) {
    lintNode(value, mode, path.concat(prop.key), root, diags);
  }
}

function lintObject(obj, schema, mode, path, root, diags) {
  const seen = new Set();
  for (const prop of obj.properties) {
    if (seen.has(prop.key)) {
      diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Duplicate key "${prop.key}"`));
    }
    seen.add(prop.key);
    const spec = specFor(schema, prop.key);
    if (!spec) {
      if (!schema.loose && !schema.freeform) {
        diags.push(diag(prop.keyFrom, prop.keyTo, "warning", `Unknown key "${prop.key}"`));
      }
      continue;
    }
    lintProperty(prop, spec, mode, path, root, diags);
  }
  for (const [key, spec] of Object.entries(schema.keySpecs || {})) {
    if (spec.required && !spec.hidden && !seen.has(key)) {
      diags.push(diag(obj.from, Math.min(obj.from + 1, obj.to), "error", `Missing required option "${key}"`));
    }
  }
  if (schema.oneOf) {
    const present = schema.oneOf.filter((key) => seen.has(key));
    if (!present.length) {
      diags.push(diag(obj.from, Math.min(obj.from + 1, obj.to), "error", `Add one of ${schema.oneOf.join(", ")}`));
    } else if (present.length > 1) {
      diags.push(diag(
        obj.from,
        Math.min(obj.from + 1, obj.to),
        "error",
        `storedSource can only set one of ${schema.oneOf.join(" or ")}`,
      ));
    }
  }
  if (schema.fieldType === "autocomplete") lintGrams(obj, diags);
}

function lintNode(node, mode, path, root, diags) {
  if (!node) return;
  const schema = locate(mode, path, root);
  if (schema.role === "keys") {
    if (node.kind !== "object") {
      diags.push(diag(node.from, node.to, "error", "Expected an object"));
      return;
    }
    lintObject(node, schema, mode, path, root, diags);
    return;
  }
  if (schema.role === "array" && node.kind === "array") {
    node.items.forEach((item, index) => lintNode(item, mode, path.concat(index), root, diags));
  }
}

function lintDuplicateNames(doc, key, label, diags) {
  const list = doc.properties.find((item) => item.key === key)?.value;
  if (!list || list.kind !== "array") return;
  const seen = new Set();
  for (const item of list.items) {
    if (item?.kind !== "object") continue;
    const nameProp = item.properties.find((prop) => prop.key === "name" && prop.value?.kind === "string");
    if (!nameProp?.value?.value) continue;
    const name = nameProp.value.value;
    if (seen.has(name)) {
      diags.push(diag(nameProp.value.from, nameProp.value.to, "error", `Duplicate ${label} name "${name}"`));
    }
    seen.add(name);
  }
}

export function lintDefinition(state, model) {
  const syntax = syntaxDiagnostic(state, JSON_MESSAGE);
  if (syntax.length) return syntax;
  const doc = readJson(state);
  if (!doc) return [diag(0, 0, "error", JSON_MESSAGE)];
  if (doc.kind !== "object") return [diag(doc.from, doc.to, "error", "Definition must be a JSON object")];
  const mode = model?.mode === "VECTOR_SEARCH" ? "VECTOR_SEARCH" : "SEARCH";
  const diags = [];
  lintNode(doc, mode, [], doc, diags);
  lintDuplicateNames(doc, "analyzers", "analyzer", diags);
  lintDuplicateNames(doc, "typeSets", "type set", diags);
  return diags;
}
