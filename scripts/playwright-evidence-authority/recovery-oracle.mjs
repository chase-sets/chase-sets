import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const defaults = Object.freeze({ maxDepth: 128, maxPayloads: 4096, maxBytes: 64 * 1024 * 1024, maxDecodedValues: 100_000, maxDurationMs: 10_000 });
const digest = (value) => createHash("sha256").update(value).digest("hex");

function targetRepresentations(value) {
  const utf8 = Buffer.from(value), utf16 = Buffer.from(value, "utf16le");
  const base64 = utf8.toString("base64");
  return [utf8, utf16, Buffer.from(swapUtf16(utf16)), Buffer.from(JSON.stringify(value).slice(1, -1)), Buffer.from(encodeURIComponent(value)), Buffer.from(base64), Buffer.from(base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""))];
}

function swapUtf16(bytes) {
  const result = Buffer.from(bytes);
  for (let index = 0; index + 1 < result.length; index += 2) [result[index], result[index + 1]] = [result[index + 1], result[index]];
  return result;
}

function zipEntries(bytes, limit) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  if (end < 0) throw new Error("ZIP_END");
  const count = bytes.readUInt16LE(end + 10);
  if (count > limit) throw new Error("ZIP_COUNT");
  let offset = bytes.readUInt32LE(end + 16);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP_CENTRAL");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (flags & 1 || ![0, 8].includes(method) || name.includes("\\") || name.split("/").includes("..") || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP_REFUSED");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + compressedSize), value = method === 0 ? compressed : inflateRawSync(compressed);
    if (value.length !== size) throw new Error("ZIP_SIZE");
    values.push(value);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return values;
}

function stringsFrom(value, state, depth = 0) {
  state.maxObservedDepth = Math.max(state.maxObservedDepth, depth);
  if (depth > state.limits.maxDepth) throw new Error("DEPTH_LIMIT");
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  const strings = Array.isArray(value) ? value.flatMap((entry) => stringsFrom(entry, state, depth + 1)) : Object.values(value).flatMap((entry) => stringsFrom(entry, state, depth + 1));
  if (!Array.isArray(value) && Array.isArray(value.chunks)) strings.push(value.chunks.map(String).join(value.separator === undefined ? "" : String(value.separator)));
  return strings;
}

function decodedStrings(text, state) {
  const values = [text];
  try { values.push(decodeURIComponent(text)); } catch { /* bounded unsupported input */ }
  values.push(text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&"));
  const tokens = text.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? [];
  for (const token of tokens) {
    try {
      const normalized = token.replaceAll("-", "+").replaceAll("_", "/");
      values.push(Buffer.from(normalized, "base64").toString("utf8"));
    } catch { /* invalid token is not authority */ }
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed !== undefined) values.push(...stringsFrom(parsed, state));
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length > 1) {
    const lineStrings = lines.flatMap((line) => { try { return stringsFrom(JSON.parse(line), state); } catch { return [line]; } });
    values.push(lineStrings.join(""), lineStrings.join("\n"));
  }
  return values;
}

export function recoverRegisteredValue({ registeredValue, payloads, limits = {} }) {
  const bounded = { ...defaults, ...limits }, start = performance.now();
  const state = { limits: bounded, maxObservedDepth: 0, decodedValues: 0, decodedBytes: 0, archives: 0, unsupportedBinary: 0 };
  if (typeof registeredValue !== "string" || registeredValue.length < 16 || !Array.isArray(payloads)) return { status: "INDETERMINATE", code: "INPUT_INVALID", observations: state };
  const targets = targetRepresentations(registeredValue), queue = payloads.map(Buffer.from), seenBytes = new Set(), seenStrings = new Set();
  try {
    while (queue.length) {
      if (performance.now() - start > bounded.maxDurationMs) throw new Error("TIME_LIMIT");
      if (state.decodedValues++ > bounded.maxDecodedValues || state.decodedBytes > bounded.maxBytes || queue.length > bounded.maxPayloads) throw new Error("BOUND_LIMIT");
      const bytes = queue.shift(), key = digest(bytes);
      if (seenBytes.has(key)) continue;
      seenBytes.add(key); state.decodedBytes += bytes.length;
      if (state.decodedBytes > bounded.maxBytes) throw new Error("BYTE_LIMIT");
      if (targets.some((target) => target.length && bytes.includes(target))) return { status: "HIT", code: "RECOVERABLE", observations: state };
      const zip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50, gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      if (zip) { state.archives += 1; queue.push(...zipEntries(bytes, bounded.maxPayloads)); }
      if (gzip) queue.push(gunzipSync(bytes));
      if (!zip && !gzip && (bytes.includes(0) || bytes.subarray(0, 4).toString("ascii") === "wOF2" || bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))) state.unsupportedBinary += 1;
      const text = bytes.toString("utf8");
      for (const decoded of decodedStrings(text, state)) if (!seenStrings.has(decoded)) { seenStrings.add(decoded); queue.push(Buffer.from(decoded)); }
    }
    return state.unsupportedBinary ? { status: "INDETERMINATE", code: "UNSUPPORTED_BINARY_OR_RENDERED_VALUE", observations: state } : { status: "CLEAR", code: "NOT_RECOVERED_WITHIN_BOUNDS", observations: state };
  } catch (error) {
    return { status: "INDETERMINATE", code: String(error.message).replace(/[^A-Z_]/g, "") || "BOUNDED_FAILURE", observations: state };
  }
}

export function checkConsumerIndependence(source) {
  const rules = [
    [/\b(?:from|import\s*\()\s*["'][^"']*recovery-oracle\.mjs/, "ORACLE_IMPORT"],
    [/\b(?:recoverRegisteredValue|targetRepresentations|decodedStrings|zipEntries)\b/, "RECOVERY_IMPLEMENTATION"],
    [/\bstringRepresentations\b/, "PREDECESSOR_TABLE"],
    [/(?:base64url.*utf16|utf16.*base64url)/is, "DECODER_TABLE"],
  ];
  const violations = rules.filter(([pattern]) => pattern.test(source)).map(([, code]) => code);
  return { independent: violations.length === 0, violations };
}

export function scanTrackedConsumers(root = path.resolve(import.meta.dirname, "../..")) {
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const candidates = tracked.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && !/(?:^|\/)(?:fixtures|tests?|__tests__|test-support)(?:\/|$)/.test(file) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(file));
  const scanned = candidates.filter((file) => !file.startsWith("scripts/playwright-evidence-authority/"));
  const grep = spawnSync("git", ["grep", "--cached", "-l", "-z", "-E", "recovery-oracle\\.mjs|recoverRegisteredValue|targetRepresentations|decodedStrings|zipEntries|stringRepresentations|base64url.*utf16|utf16.*base64url", "--", "*.mjs", "*.mts", "*.ts", "*.tsx", "*.js", "*.jsx"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (![0, 1].includes(grep.status)) throw new Error("TRACKED_CONSUMER_SCAN_FAILED");
  const suspicious = new Set((grep.stdout ?? "").split("\0").filter(Boolean));
  const violations = scanned.filter((file) => suspicious.has(file)).flatMap((file) => checkConsumerIndependence(readFileSync(path.join(root, file), "utf8")).violations.map((code) => ({ file, code })));
  return { totalCandidates: candidates.length, scannedCandidates: scanned.length, violations };
}

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(root, entry.name)) : entry.isFile() ? [path.join(root, entry.name)] : []);
}

async function main(argv) {
  const option = (name) => argv[argv.indexOf(name) + 1];
  const valueFile = option("--registered-value-file"), payloadRoot = option("--payload-root");
  if (!valueFile || !payloadRoot) throw new Error("ORACLE_ARGUMENTS_REQUIRED");
  const result = recoverRegisteredValue({ registeredValue: readFileSync(valueFile, "utf8").trim(), payloads: files(payloadRoot).map((file) => readFileSync(file)) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "INDETERMINATE") process.exitCode = 2;
  if (result.status === "HIT") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2)).catch(() => { process.stderr.write("recovery-oracle failed (bounded).\n"); process.exitCode = 2; });
