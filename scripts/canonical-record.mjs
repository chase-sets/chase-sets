import { createHash } from "node:crypto";

export const CANONICAL_RECORD_SHAPES = Object.freeze(["string", "integer", "integerArray", "record", "recordArray"]);

export const CANONICAL_RECORD_REFUSAL_CODES = Object.freeze([
  "CANONICAL_SCHEMA_INVALID",
  "CANONICAL_SCHEMA_CYCLIC",
  "CANONICAL_KEY_SET_MISMATCH",
  "CANONICAL_TYPE_OUT_OF_DOMAIN",
  "CANONICAL_STRING_OUT_OF_DOMAIN",
  "CANONICAL_NUMBER_OUT_OF_DOMAIN",
  "CANONICAL_DIGEST_INPUT_NOT_BYTES",
]);

const NESTING_SHAPES = new Set(["record", "recordArray"]);
const SHAPES = new Set(CANONICAL_RECORD_SHAPES);

export class CanonicalRecordError extends Error {
  constructor(code, position) {
    super(position === undefined ? code : `${code}: ${position}`);
    this.code = code;
    this.position = position;
  }
}

function refuse(code, position) {
  throw new CanonicalRecordError(code, position);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrintableAscii(value) {
  return typeof value === "string" && /^[\x20-\x7e]*$/u.test(value);
}

function validateFields(fields, position = "schema", ancestors = new Set()) {
  if (!Array.isArray(fields)) refuse("CANONICAL_SCHEMA_INVALID", position);
  if (ancestors.has(fields)) refuse("CANONICAL_SCHEMA_CYCLIC", position);

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(fields);
  const declaredKeys = new Set();

  return fields.map((declaration, index) => {
    const declarationPosition = `${position}[${index}]`;
    if (!isObject(declaration) || typeof declaration.key !== "string" || !SHAPES.has(declaration.shape)) {
      refuse("CANONICAL_SCHEMA_INVALID", declarationPosition);
    }
    const nested = NESTING_SHAPES.has(declaration.shape);
    const expectedKeys = nested ? ["key", "shape", "fields"] : ["key", "shape"];
    const actualKeys = Object.keys(declaration);
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key) => !expectedKeys.includes(key)) ||
      !isPrintableAscii(declaration.key)
    ) {
      refuse("CANONICAL_SCHEMA_INVALID", declarationPosition);
    }
    if (declaredKeys.has(declaration.key)) refuse("CANONICAL_KEY_SET_MISMATCH", declarationPosition);
    declaredKeys.add(declaration.key);
    return nested
      ? {
          key: declaration.key,
          shape: declaration.shape,
          fields: validateFields(declaration.fields, `${declarationPosition}.fields`, nextAncestors),
        }
      : { key: declaration.key, shape: declaration.shape };
  });
}

function emitString(value, position) {
  if (!isPrintableAscii(value)) refuse("CANONICAL_STRING_OUT_OF_DOMAIN", position);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function emitInteger(value, position) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    refuse("CANONICAL_NUMBER_OUT_OF_DOMAIN", position);
  }
  return String(value);
}

function emitObject(value, fields, position) {
  if (!isObject(value)) refuse("CANONICAL_TYPE_OUT_OF_DOMAIN", position);
  const actualKeys = Object.keys(value);
  const declaredKeys = fields.map((field) => field.key);
  if (actualKeys.length !== declaredKeys.length || actualKeys.some((key) => !declaredKeys.includes(key))) {
    refuse("CANONICAL_KEY_SET_MISMATCH", position);
  }
  return `{${fields.map((field) => `${emitString(field.key, `${position}.${field.key}`)}:${emitValue(value[field.key], field, `${position}.${field.key}`)}`).join(",")}}`;
}

function emitValue(value, field, position) {
  switch (field.shape) {
    case "string":
      if (typeof value !== "string") refuse("CANONICAL_TYPE_OUT_OF_DOMAIN", position);
      return emitString(value, position);
    case "integer":
      return emitInteger(value, position);
    case "integerArray":
      if (!Array.isArray(value)) refuse("CANONICAL_TYPE_OUT_OF_DOMAIN", position);
      return `[${value.map((entry, index) => emitInteger(entry, `${position}[${index}]`)).join(",")}]`;
    case "record":
      return emitObject(value, field.fields, position);
    case "recordArray":
      if (!Array.isArray(value)) refuse("CANONICAL_TYPE_OUT_OF_DOMAIN", position);
      return `[${value.map((entry, index) => emitObject(entry, field.fields, `${position}[${index}]`)).join(",")}]`;
    default:
      return refuse("CANONICAL_SCHEMA_INVALID", position);
  }
}

function emit(value, fields, rootArray) {
  const validatedFields = validateFields(fields);
  if (rootArray) {
    if (!Array.isArray(value)) refuse("CANONICAL_TYPE_OUT_OF_DOMAIN", "root");
    return Buffer.from(
      `[${value.map((entry, index) => emitObject(entry, validatedFields, `root[${index}]`)).join(",")}]`,
      "utf8",
    );
  }
  return Buffer.from(emitObject(value, validatedFields, "root"), "utf8");
}

export function emitRecord(value, fields) {
  return emit(value, fields, false);
}

export function emitRecordArray(value, fields) {
  return emit(value, fields, true);
}

export function sha256(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    refuse("CANONICAL_DIGEST_INPUT_NOT_BYTES");
  }
  return createHash("sha256").update(bytes).digest("hex");
}
