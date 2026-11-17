import {
  acceptedTypes,
  indexModeType,
  isClauseKey,
  locate,
  MQL_COMPOUND,
  MQL_OPERATORS,
  specFor,
} from "./catalog.js";
import { effectiveIndexNameFromDoc, readJson, syntaxDiagnostic } from "./context.js";
import { canonicalTypes, fieldsFor, typesCompatible } from "./fields.js";

function diag(from, to, severity, message) {
  return { from, to: Math.max(to, from), severity, message };
}

function typeName(info) {
  const types = [...canonicalTypes(info?.types || [])];
  return types.join(", ") || "unknown";
}

function incompatibility(operator, path, info, accepted) {
  if (accepted?.length === 1 && accepted[0] === "filter") {
    return `Filter path "${path}" is not a filter field`;
  }
  if (accepted?.length === 1 && accepted[0] === "vector") {
    return `"${path}" is not a vector field`;
  }
  const need = accepted.join(", ");
  if (!operator) return `"${path}" is indexed as ${typeName(info)}, not ${need}`;
  return `${operator} cannot query "${path}" (${typeName(info)}). It requires ${need}`;
}

function checkPath(path, valueNode, schema, fields, diags) {
  if (!fields?.knowsMapping || /[*?]/.test(path || "")) return;
  const accepted = schema?.pendingAccepted || null;
  const from = valueNode.from;
  const to = valueNode.to;
  if (!path) {
    diags.push(diag(from, to, "error", "Path is empty"));
    return;
  }
  const info = fields.lookup(path);
  if (!info.allowed || info.origin === "missing") {
    diags.push(diag(from, to, "error", `Field "${path}" is not in this index mapping`));
    return;
  }
  if (!info.types.size) {
    const message = fields.observedOrigin === "sampled"
      ? `Field "${path}" was not found in the document sample; it may still be indexed dynamically`
      : `Field "${path}" is not in the indexed field list`;
    diags.push(diag(from, to, "warning", message));
    return;
  }
  if (accepted && !typesCompatible(info.types, accepted)) {
    diags.push(diag(from, to, "error", incompatibility(schema?.operator, path, info, accepted)));
    return;
  }
  if (info.origin === "dynamic") {
    const message = fields.observedOrigin === "sampled"
      ? `Field "${path}" was not found in the document sample; it may still be indexed dynamically`
      : `Field "${path}" is not in the indexed field list`;
    diags.push(diag(from, to, "warning", message));
  }
}

function shapeOk(value, spec) {
  switch (spec.kind) {
    case "string":
    case "index":
    case "multi":
    case "path-string":
      return value.kind === "string";
    case "stringish":
      return value.kind === "string" || (value.kind === "array" && value.items.every((item) => item.kind === "string"));
    case "number":
      return value.kind === "number";
    case "boolean":
      return value.kind === "boolean";
    case "enum":
      return (value.kind === "string" || value.kind === "number") && spec.values.includes(value.value);
    case "array":
    case "operators":
      return value.kind === "array";
    case "operator":
    case "object":
      return value.kind === "object";
    case "path":
      return value.kind === "string" || value.kind === "array" || value.kind === "object";
    case "sort-dir":
      return value.kind === "number" || value.kind === "object";
    case "any":
      return true;
    default:
      return true;
  }
}

function expectedPhrase(spec) {
  switch (spec.kind) {
    case "string":
    case "index":
    case "multi":
    case "path":
    case "path-string":
      return "a string";
    case "stringish":
      return "a string or array of strings";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "enum":
      return `one of ${spec.values.join(", ")}`;
    case "array":
    case "operators":
      return "an array";
    case "object":
    case "operator":
      return "an object";
    case "sort-dir":
      return "1 or -1";
    default:
      return "a different value";
  }
}

function lintVectorBounds(obj, fields, diags, pathKey, vectorKey) {
  const pathProp = obj.properties.find((item) => item.key === pathKey && item.value?.kind === "string");
  const vectorProp = obj.properties.find((item) => item.key === vectorKey && item.value?.kind === "array");
  if (pathProp && vectorProp && fields?.knowsMapping) {
    const dims = fields.lookup(pathProp.value.value).numDimensions;
    if (dims && vectorProp.value.items.length !== dims) {
      diags.push(diag(
        vectorProp.value.from,
        vectorProp.value.to,
        "error",
        `${vectorKey} has ${vectorProp.value.items.length} dimensions but "${pathProp.value.value}" is indexed with ${dims}`,
      ));
    }
  }
  const limit = obj.properties.find((item) => item.key === "limit" && item.value?.kind === "number");
  const candidates = obj.properties.find((item) => item.key === "numCandidates" && item.value?.kind === "number");
  if (limit && candidates && candidates.value.value < limit.value.value) {
    diags.push(diag(
      candidates.value.from,
      candidates.value.to,
      "error",
      `numCandidates (${candidates.value.value}) is less than limit (${limit.value.value})`,
    ));
  }
}

function lintAnalyzed(obj, schema, fields, diags) {
  const operator = schema?.operator;
  if ((operator !== "wildcard" && operator !== "regex") || !fields?.knowsMapping) return;
  const pathProp = obj.properties.find((item) => item.key === "path" && item.value?.kind === "string");
  if (!pathProp) return;
  const info = fields.lookup(pathProp.value.value);
  const types = [...canonicalTypes(info.types)];
  if (!types.length || types.some((type) => type !== "string")) return;
  const flag = obj.properties.find((item) => item.key === "allowAnalyzedField");
  if (flag?.value?.kind === "boolean" && flag.value.value === true) return;
  diags.push(diag(
    pathProp.value.from,
    pathProp.value.to,
    "error",
    `${operator} on analyzed field "${pathProp.value.value}" needs allowAnalyzedField: true`,
  ));
}

function lintFilterField(path, from, to, fields, diags) {
  if (!fields?.knowsMapping || !path) return;
  const info = fields.lookup(path);
  if (!info.allowed || info.origin === "missing") {
    diags.push(diag(from, to, "error", `Field "${path}" is not in this index mapping`));
    return;
  }
  if (info.types.size && !typesCompatible(info.types, ["filter"])) {
    diags.push(diag(from, to, "error", `Filter path "${path}" is not a filter field`));
  }
}

function lintMqlValue(obj, mode, path, model, fields, diags, doc, localIndexName) {
  for (const prop of obj.properties) {
    const spec = MQL_OPERATORS[prop.key];
    if (!spec) {
      diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Unknown filter operator "${prop.key}"`));
      continue;
    }
    const value = prop.value;
    if (!value) continue;
    if (spec.value === "array" && value.kind !== "array") {
      diags.push(diag(value.from, value.to, "error", `"${prop.key}" must be an array`));
    } else if (spec.value === "boolean" && value.kind !== "boolean") {
      diags.push(diag(value.from, value.to, "error", `"${prop.key}" must be a boolean`));
    } else if (spec.value === "clause") {
      if (value.kind !== "object") diags.push(diag(value.from, value.to, "error", `"${prop.key}" must be an object`));
      else lintNode(value, mode, path.concat(prop.key), model, fields, diags, doc, localIndexName);
    } else if (spec.value === "scalar" && (value.kind === "object" || value.kind === "array")) {
      diags.push(diag(value.from, value.to, "error", `"${prop.key}" must be a single value`));
    }
  }
}

function lintMql(obj, mode, path, model, fields, diags, doc, localIndexName) {
  for (const prop of obj.properties) {
    if (MQL_COMPOUND[prop.key]) {
      const value = prop.value;
      if (prop.key === "$not") {
        if (value?.kind !== "object") diags.push(diag(prop.keyFrom, prop.keyTo, "error", '"$not" must be an object'));
        else lintNode(value, mode, path.concat(prop.key), model, fields, diags, doc, localIndexName);
      } else if (value?.kind !== "array") {
        diags.push(diag(prop.keyFrom, prop.keyTo, "error", `"${prop.key}" must be an array of clauses`));
      } else {
        value.items.forEach((item, index) => {
          if (item.kind !== "object") diags.push(diag(item.from, item.to, "error", `"${prop.key}" clauses must be objects`));
          else lintNode(item, mode, path.concat(prop.key, index), model, fields, diags, doc, localIndexName);
        });
      }
      continue;
    }
    if (prop.key.startsWith("$")) {
      diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Unknown filter operator "${prop.key}"`));
      continue;
    }
    lintFilterField(prop.key, prop.keyFrom, prop.keyTo, fields, diags);
    if (prop.value?.kind === "object") {
      lintMqlValue(prop.value, mode, path.concat(prop.key), model, fields, diags, doc, localIndexName);
    } else if (prop.value?.kind === "array") {
      diags.push(diag(prop.value.from, prop.value.to, "error", `Use $in to match a list of values for "${prop.key}"`));
    }
  }
}

function resolveFields(model, doc, localIndexName, path, key = null) {
  const name = effectiveIndexNameFromDoc(doc, path, key, localIndexName);
  return fieldsFor(model, name).fields;
}

function lintObject(obj, schema, mode, path, model, fields, diags, doc, localIndexName) {
  if (!schema || schema.role === "unknown" || obj.kind !== "object") return;
  if (schema.role === "mql") {
    lintMql(obj, mode, path, model, fields, diags, doc, localIndexName);
    return;
  }
  if (schema.role === "mql-value") {
    lintMqlValue(obj, mode, path, model, fields, diags, doc, localIndexName);
    return;
  }
  const seen = new Set();
  let clauses = 0;
  for (const prop of obj.properties) {
    if (seen.has(prop.key)) {
      diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Duplicate key "${prop.key}"`));
    }
    seen.add(prop.key);

    const clause = isClauseKey(schema, prop.key);
    if (clause) {
      clauses += 1;
      if (schema.singleOperator && clauses > 1) {
        diags.push(diag(prop.keyFrom, prop.keyTo, "error", "Only one operator or collector is allowed"));
      }
      if (schema.filterOperators && schema.acceptsOperators && !schema.filterOperators.includes(prop.key)) {
        const hint = prop.key === "join"
          ? "join is only allowed in compound.filter or compound.mustNot"
          : `"${prop.key}" is not allowed here`;
        diags.push(diag(prop.keyFrom, prop.keyTo, "error", hint));
      }
    }

    const spec = specFor(schema, prop.key);
    const propFields = resolveFields(model, doc, localIndexName, path, prop.key);
    if (clause && !spec) {
      if (!prop.value || prop.value.kind !== "object") {
        diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Expected an object for "${prop.key}"`));
      } else {
        lintNode(prop.value, mode, path.concat(prop.key), model, propFields, diags, doc, localIndexName);
      }
      continue;
    }
    if (!spec) {
      if (prop.key === "join") {
        diags.push(diag(
          prop.keyFrom,
          prop.keyTo,
          "error",
          "join is only allowed in compound.filter or compound.mustNot",
        ));
        if (prop.value?.kind === "object") {
          lintNode(prop.value, mode, path.concat(prop.key), model, propFields, diags, doc, localIndexName);
        }
        continue;
      }
      if (!schema.loose && !schema.freeform) {
        diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Unknown key "${prop.key}"`));
      }
      continue;
    }
    lintProperty(prop, spec, schema, mode, path, model, propFields, diags, doc, localIndexName);
  }

  for (const [key, spec] of Object.entries(schema.keySpecs || {})) {
    if (spec.required && !seen.has(key)) {
      diags.push(diag(obj.from, Math.min(obj.from + 1, obj.to), "error", `Missing required option "${key}"`));
    }
  }
  const requireAny = schema.operatorDef?.requireAny;
  if (requireAny && !requireAny.some((key) => seen.has(key))) {
    diags.push(diag(obj.from, Math.min(obj.from + 1, obj.to), "error", `Add one of ${requireAny.join(", ")}`));
  }
  if (schema.singleOperator && schema.acceptsOperators && clauses === 0) {
    diags.push(diag(obj.from, Math.min(obj.from + 1, obj.to), "error", "Add a query operator"));
  }
  lintMulti(obj, schema, fields, diags);
  lintAnalyzed(obj, schema, fields, diags);
  if (mode === "vector" && path.length === 0) lintVectorBounds(obj, fields, diags, "path", "queryVector");
  if (schema.operator === "knnBeta") lintVectorBounds(obj, fields, diags, "path", "vector");
  if (schema.operator === "vectorSearch") lintVectorBounds(obj, fields, diags, "path", "queryVector");
}

function lintProperty(prop, spec, schema, mode, path, model, fields, diags, doc, localIndexName) {
  const value = prop.value;
  if (!value) {
    diags.push(diag(prop.keyFrom, prop.keyTo, "error", `Missing value for "${prop.key}"`));
    return;
  }
  if (!shapeOk(value, spec)) {
    diags.push(diag(value.from, value.to, "error", `"${prop.key}" must be ${expectedPhrase(spec)}`));
    return;
  }

  if (spec.kind === "index" && value.kind === "string") {
    const found = (model?.indexes || []).find((index) => index.name === value.value);
    const wanted = spec.indexType || indexModeType(mode);
    if (!found) diags.push(diag(value.from, value.to, "error", `Unknown index "${value.value}"`));
    else if (found.type !== wanted) {
      diags.push(diag(value.from, value.to, "error", `Index "${value.value}" is ${found.type}, not ${wanted}`));
    }
    return;
  }

  if (spec.kind === "path" || spec.kind === "path-string") {
    const accepted = acceptedTypes(schema, spec);
    const tagged = { ...schema, pendingAccepted: accepted };
    const visit = (node) => {
      if (node?.kind === "string") checkPath(node.value, node, tagged, fields, diags);
    };
    if (value.kind === "string") visit(value);
    if (value.kind === "array") {
      for (const item of value.items) {
        if (item.kind === "string") visit(item);
        else diags.push(diag(item.from, item.to, "error", `"${prop.key}" must be a string or array of strings`));
      }
    }
    if (value.kind === "object") {
      lintNode(value, mode, path.concat(prop.key), model, fields, diags, doc, localIndexName);
    }
    return;
  }

  if (spec.kind === "array" && value.kind === "array" && (prop.key === "queryVector" || prop.key === "vector")) {
    for (const item of value.items) {
      if (item.kind !== "number") {
        diags.push(diag(item.from, item.to, "error", `${prop.key} values must be numbers`));
      }
    }
  }

  if (value.kind === "object" || value.kind === "array") {
    lintNode(value, mode, path.concat(prop.key), model, fields, diags, doc, localIndexName);
  }
}

function lintNode(node, mode, path, model, fields, diags, doc, localIndexName) {
  if (!node) return;
  const schema = locate(mode, path);
  const nodeFields = resolveFields(model, doc, localIndexName, path) || fields;
  if (node.kind === "object") {
    lintObject(node, schema, mode, path, model, nodeFields, diags, doc, localIndexName);
  }
  if (node.kind === "array" && schema.role === "array") {
    node.items.forEach((item, index) => {
      lintNode(item, mode, path.concat(index), model, nodeFields, diags, doc, localIndexName);
    });
  }
}

function lintMulti(obj, schema, fields, diags) {
  if (!schema?.keySpecs?.multi || !fields?.knowsMapping) return;
  const multi = obj.properties.find((item) => item.key === "multi" && item.value?.kind === "string");
  const target = obj.properties.find((item) => item.key === "value" && item.value?.kind === "string");
  if (!multi || !target) return;
  const info = fields.lookup(target.value.value);
  if (!info.allowed || info.multis.includes(multi.value.value)) return;
  const available = info.multis.length ? `. Available: ${info.multis.join(", ")}` : "";
  diags.push(diag(multi.value.from, multi.value.to, "error", `Unknown multi "${multi.value.value}" on "${target.value.value}"${available}`));
}

export function lintQuery(state, model) {
  const syntax = syntaxDiagnostic(state);
  if (syntax.length) return syntax;
  const doc = readJson(state);
  if (!doc) return [diag(0, 0, "error", "Query must be valid JSON")];
  if (doc.kind !== "object") return [diag(doc.from, doc.to, "error", "Query must be a JSON object")];
  const mode = model?.mode === "vector" ? "vector" : "search";
  const indexName = doc.properties.find((item) => item.key === "index" && item.value?.kind === "string")?.value.value || null;
  const { fields } = fieldsFor(model, indexName);
  const diags = [];
  lintNode(doc, mode, [], model, fields, diags, doc, indexName);
  return diags;
}
