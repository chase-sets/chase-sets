import { Buffer } from "node:buffer";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { ADMISSION_CONTAINED_PATH_OUTCOMES, readContainedFile } from "./admission-contained-path.mjs";

/**
 * admission-stream-source/v1 defines a Tagged Stream Source for lane-owned
 * control materialization, Stream Acquisition through the shipped bound-read
 * authority, the Supported Control Grammar, and Normalized Stream Text.
 *
 * Materialization is test/control support for a caller-supplied lane-owned,
 * single-writer directory. Acquisition performs no filesystem operation of
 * its own: it normalizes only bytes returned by readContainedFile.
 */
export const ADMISSION_STREAM_SOURCE_VERSION = "admission-stream-source/v1";

export const ADMISSION_STREAM_SOURCE_KINDS = Object.freeze(["bytes", "text", "absent"]);

const CONTAINED_SUCCESS = "contained";
const LOCAL_READ_FAILURE_REASONS = Object.freeze(["invalid-utf8", "unsupported-control-sequence"]);
const MAX_MATERIALIZED_BYTES = 1_048_576;
const MAX_CANONICAL_BASE64_LENGTH = Math.ceil(MAX_MATERIALIZED_BYTES / 3) * 4;

const containedSuccessCount = ADMISSION_CONTAINED_PATH_OUTCOMES.filter(
  (outcome) => outcome === CONTAINED_SUCCESS,
).length;
if (
  containedSuccessCount !== 1 ||
  ADMISSION_CONTAINED_PATH_OUTCOMES[0] !== CONTAINED_SUCCESS ||
  new Set(ADMISSION_CONTAINED_PATH_OUTCOMES).size !== ADMISSION_CONTAINED_PATH_OUTCOMES.length
) {
  throw new Error("admission contained-path outcomes must have one unique leading contained success");
}

export const ADMISSION_STREAM_READ_FAILURE_REASONS = Object.freeze([
  ...ADMISSION_CONTAINED_PATH_OUTCOMES.filter((outcome) => outcome !== CONTAINED_SUCCESS),
  ...LOCAL_READ_FAILURE_REASONS,
]);

function hasExactKeys(value, expectedKeys) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function isNonArrayObject(value) {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function readMember(value, key) {
  try {
    return { read: true, value: Reflect.get(value, key) };
  } catch {
    return { read: false, value: undefined };
  }
}

function isCanonicalBoundedBase64(value) {
  if (typeof value !== "string" || value.length > MAX_CANONICAL_BASE64_LENGTH) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_MATERIALIZED_BYTES && bytes.toString("base64") === value;
}

function normalizedTextBytes(text) {
  return Buffer.from(text.replaceAll("\r\n", "\n"), "utf8");
}

export function isAdmissionStreamSource(source) {
  if (!isNonArrayObject(source)) return false;

  const kindMember = readMember(source, "kind");
  if (!kindMember.read || !ADMISSION_STREAM_SOURCE_KINDS.includes(kindMember.value)) return false;

  if (kindMember.value === "absent") return hasExactKeys(source, ["kind"]);

  const payloadKey = kindMember.value === "bytes" ? "base64" : "text";
  if (!hasExactKeys(source, ["kind", payloadKey])) return false;
  const payloadMember = readMember(source, payloadKey);
  if (!payloadMember.read) return false;

  if (kindMember.value === "bytes") return isCanonicalBoundedBase64(payloadMember.value);
  if (typeof payloadMember.value !== "string" || payloadMember.value.length > MAX_MATERIALIZED_BYTES * 2) return false;
  return normalizedTextBytes(payloadMember.value).length <= MAX_MATERIALIZED_BYTES;
}

export async function materializeStreamSource(source, directory, fileName) {
  if (!isAdmissionStreamSource(source)) throw new TypeError("source must be a valid admission stream source");

  const targetPath = path.join(directory, fileName);
  if (source.kind === "absent") {
    await rm(targetPath, { force: true });
    return targetPath;
  }

  const bytes = source.kind === "bytes" ? Buffer.from(source.base64, "base64") : normalizedTextBytes(source.text);
  await writeFile(targetPath, bytes);
  return targetPath;
}

function readFailure(reason) {
  return Object.freeze({ state: "read-failure", reason });
}

function normalizedText(text) {
  return Object.freeze({ state: "ok", text });
}

export function normalizeStreamBytes(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return readFailure("invalid-utf8");
  }

  const withoutSgr = text.replace(/\u001b\[[0-9;]*m/g, "");
  const normalized = withoutSgr.replaceAll("\r\n", "\n");
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(normalized)) {
    return readFailure("unsupported-control-sequence");
  }
  return normalizedText(normalized);
}

export async function acquireStreamText(baseDirectory, relativePath, options) {
  const result = await readContainedFile(baseDirectory, relativePath, options);
  if (result.outcome !== CONTAINED_SUCCESS) return readFailure(result.outcome);
  return normalizeStreamBytes(result.bytes);
}
