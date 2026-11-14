import { syntaxTree } from "../../vendor/codemirror.js";

const VALUES = new Set(["Object", "Array", "String", "Number", "True", "False", "Null"]);

function childNamed(node, name) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

function valueChild(node) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (VALUES.has(child.name)) return child;
  }
  return null;
}

function textOf(doc, node) {
  return doc.sliceString(node.from, node.to);
}

function decodeString(text) {
  try {
    return JSON.parse(text);
  } catch {
    return String(text).replace(/^"|"$/g, "");
  }
}

function indexInArray(arrayNode, element) {
  let index = 0;
  for (let child = arrayNode.firstChild; child; child = child.nextSibling) {
    if (!VALUES.has(child.name)) continue;
    if (child.from === element.from && child.to === element.to) return index;
    index += 1;
  }
  return index;
}

function objectPath(node, doc) {
  const parts = [];
  let current = node;
  while (current?.parent) {
    const parent = current.parent;
    if (parent.name === "Property") {
      const name = childNamed(parent, "PropertyName");
      if (name) parts.push(decodeString(textOf(doc, name)));
    } else if (parent.name === "Array") {
      parts.push(indexInArray(parent, current));
    }
    current = parent;
  }
  return parts.reverse();
}

function objectKeys(objectNode, doc, skip) {
  const keys = [];
  for (let child = objectNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Property" || child === skip) continue;
    const name = childNamed(child, "PropertyName");
    if (name) keys.push(decodeString(textOf(doc, name)));
  }
  return keys;
}

function stringProps(objectNode, doc) {
  const props = {};
  for (let child = objectNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Property") continue;
    const name = childNamed(child, "PropertyName");
    const value = valueChild(child);
    if (!name || !value || value.name !== "String") continue;
    props[decodeString(textOf(doc, name))] = decodeString(textOf(doc, value));
  }
  return props;
}

function clampPartial(doc, from, to, pos) {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const cursor = Math.min(Math.max(pos, start), end);
  return { from: start, to: end, partial: doc.sliceString(start, cursor) };
}

function keyContext(propertyName, doc, pos) {
  const property = propertyName.parent;
  const objectNode = property?.parent;
  const raw = textOf(doc, propertyName);
  const contentFrom = propertyName.from + (raw.startsWith('"') ? 1 : 0);
  const contentTo = propertyName.to - (raw.endsWith('"') ? 1 : 0);
  const span = clampPartial(doc, contentFrom, contentTo, pos);
  const colon = childNamed(property, ":");
  const value = valueChild(property);
  return {
    kind: "key",
    objectPath: objectNode?.name === "Object" ? objectPath(objectNode, doc) : [],
    key: decodeString(raw),
    partial: span.partial,
    from: span.from,
    to: span.to,
    tokenFrom: propertyName.from,
    tokenTo: propertyName.to,
    nameFrom: propertyName.from,
    nameTo: propertyName.to,
    hasColon: Boolean(colon),
    colonTo: colon ? colon.to : propertyName.to,
    hasValue: Boolean(value),
    existingKeys: objectNode?.name === "Object" ? objectKeys(objectNode, doc, property) : [],
    locals: objectNode?.name === "Object" ? stringProps(objectNode, doc) : {},
    enclose: "quotes",
    containerFrom: objectNode?.from ?? 0,
    containerTo: objectNode?.to ?? doc.length,
  };
}

function valueContext(property, doc, pos, token) {
  const name = childNamed(property, "PropertyName");
  const objectNode = property.parent?.name === "Object" ? property.parent : null;
  const base = {
    kind: "value",
    objectPath: objectNode ? objectPath(objectNode, doc) : [],
    key: name ? decodeString(textOf(doc, name)) : "",
    existingKeys: objectNode ? objectKeys(objectNode, doc) : [],
    locals: objectNode ? stringProps(objectNode, doc) : {},
    hasColon: true,
    hasValue: Boolean(token),
    containerFrom: objectNode?.from ?? property.from,
    containerTo: objectNode?.to ?? property.to,
  };
  if (!token || pos < token.from || pos > token.to) {
    return {
      ...base,
      partial: "",
      from: pos,
      to: pos,
      tokenFrom: pos,
      tokenTo: pos,
      enclose: "bare",
      hasValue: Boolean(token),
    };
  }
  if (token.name === "String") {
    const raw = textOf(doc, token);
    const span = clampPartial(
      doc,
      token.from + (raw.startsWith('"') ? 1 : 0),
      token.to - (raw.endsWith('"') ? 1 : 0),
      pos,
    );
    return { ...base, ...span, tokenFrom: token.from, tokenTo: token.to, enclose: "quotes" };
  }
  const span = clampPartial(doc, token.from, token.to, pos);
  return { ...base, ...span, tokenFrom: token.from, tokenTo: token.to, enclose: "raw" };
}

function bareKeyContext(objectNode, doc, pos) {
  return {
    kind: "key",
    objectPath: objectPath(objectNode, doc),
    key: "",
    partial: "",
    from: pos,
    to: pos,
    tokenFrom: pos,
    tokenTo: pos,
    nameFrom: pos,
    nameTo: pos,
    hasColon: false,
    colonTo: pos,
    hasValue: false,
    existingKeys: objectKeys(objectNode, doc),
    locals: stringProps(objectNode, doc),
    enclose: "bare",
    containerFrom: objectNode.from,
    containerTo: objectNode.to,
  };
}

function elementContext(arrayNode, doc, pos) {
  return {
    kind: "element",
    objectPath: objectPath(arrayNode, doc),
    key: null,
    partial: "",
    from: pos,
    to: pos,
    tokenFrom: pos,
    tokenTo: pos,
    enclose: "bare",
    existingKeys: [],
    locals: {},
    hasColon: false,
    hasValue: false,
    containerFrom: arrayNode.from,
    containerTo: arrayNode.to,
  };
}

function propertyOwning(node, pos) {
  let current = node;
  while (current) {
    if (current.name === "Property") {
      const value = valueChild(current);
      if (value && pos >= value.from && pos <= value.to) return current;
    }
    current = current.parent;
  }
  return null;
}

/** Where the cursor sits in the JSON: a key, a value, or an array element. */
export function contextAt(state, pos) {
  const doc = state.doc;
  const node = syntaxTree(state).resolveInner(pos, -1);
  if (!node) return null;

  const propertyName = node.name === "PropertyName"
    ? node
    : (node.parent?.name === "PropertyName" ? node.parent : null);
  if (propertyName && pos >= propertyName.from && pos <= propertyName.to) {
    return keyContext(propertyName, doc, pos);
  }

  if (VALUES.has(node.name) && node.name !== "Object" && node.name !== "Array") {
    const property = propertyOwning(node, pos);
    if (property) return valueContext(property, doc, pos, node);
  }

  if ((node.name === ":" || node.name === "Property") && (node.name === "Property" ? node : node.parent)?.name === "Property") {
    const property = node.name === "Property" ? node : node.parent;
    const colon = childNamed(property, ":");
    const name = childNamed(property, "PropertyName");
    if ((colon && pos >= colon.from) || (name && pos > name.to)) {
      return valueContext(property, doc, pos, valueChild(property));
    }
    if (name) return keyContext(name, doc, pos);
  }

  if (node.name === "Object") return bareKeyContext(node, doc, pos);
  if (node.name === "Array") return elementContext(node, doc, pos);

  let current = node.parent;
  while (current) {
    if (current.name === "Object") return bareKeyContext(current, doc, pos);
    if (current.name === "Array") return elementContext(current, doc, pos);
    current = current.parent;
  }
  return null;
}

function readValue(node, doc) {
  if (!node) return null;
  if (node.name === "Object") {
    const properties = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== "Property") continue;
      const name = childNamed(child, "PropertyName");
      if (!name) continue;
      const valueNode = valueChild(child);
      properties.push({
        key: decodeString(textOf(doc, name)),
        keyFrom: name.from,
        keyTo: name.to,
        value: valueNode ? readValue(valueNode, doc) : null,
        from: child.from,
        to: child.to,
      });
    }
    return { kind: "object", from: node.from, to: node.to, properties };
  }
  if (node.name === "Array") {
    const items = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (VALUES.has(child.name)) items.push(readValue(child, doc));
    }
    return { kind: "array", from: node.from, to: node.to, items };
  }
  if (node.name === "String") {
    return { kind: "string", value: decodeString(textOf(doc, node)), from: node.from, to: node.to };
  }
  if (node.name === "Number") {
    return { kind: "number", value: Number(textOf(doc, node)), from: node.from, to: node.to };
  }
  if (node.name === "True" || node.name === "False") {
    return { kind: "boolean", value: node.name === "True", from: node.from, to: node.to };
  }
  if (node.name === "Null") return { kind: "null", value: null, from: node.from, to: node.to };
  return null;
}

export function readJson(state) {
  const root = syntaxTree(state).topNode;
  let value = root.name === "JsonText" ? root.firstChild : root;
  while (value && !VALUES.has(value.name)) value = value.nextSibling;
  return value ? readValue(value, state.doc) : null;
}

export function rootIndexName(state) {
  const doc = readJson(state);
  if (!doc || doc.kind !== "object") return null;
  const prop = doc.properties.find((item) => item.key === "index" && item.value?.kind === "string");
  return prop ? prop.value.value : null;
}

export function syntaxDiagnostic(state) {
  const text = state.doc.toString();
  if (!text.trim()) {
    return [{ from: 0, to: 0, severity: "error", message: "Query must be valid JSON" }];
  }
  try {
    JSON.parse(text);
    return [];
  } catch (err) {
    const match = String(err.message).match(/position\s+(\d+)/i);
    const pos = match ? Math.min(Number(match[1]), text.length) : 0;
    return [{
      from: pos,
      to: Math.min(pos + 1, Math.max(text.length, 1)),
      severity: "error",
      message: "Query must be valid JSON",
    }];
  }
}
