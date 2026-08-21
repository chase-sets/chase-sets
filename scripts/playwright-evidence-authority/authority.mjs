import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { recoverRegisteredValue, scanTrackedConsumers } from "./recovery-oracle.mjs";
import { verifyTransactionHarness } from "./transaction.mjs";

export const repoRoot = path.resolve(import.meta.dirname, "../..");
export const authorityRoot = import.meta.dirname;
export const fixtureRoot = path.join(repoRoot, "scripts/fixtures/playwright-evidence-authority/1.60.0");
export const artifactRoot = path.join(repoRoot, "artifacts/playwright-evidence-authority");
export const grammarPath = path.join(authorityRoot, "grammar.json");
export const manifestPath = path.join(fixtureRoot, "manifest.json");
export const releasePath = path.join(authorityRoot, "release.json");
export const controlsPath = path.join(fixtureRoot, "declared-controls.json");

export const PRE_LANDING_HEAD = "pre-landing-unbound";
const UNPRODUCED_CLASSIFICATIONS = [
  "unexpected/passed",
  "expected/timedOut",
  "expected/interrupted",
  "unexpected/failed",
];
const RELEASE_FILE = "scripts/playwright-evidence-authority/release.json";
const REPO_TOKEN = "<repo>";
const DENOMINATOR_LINES = 1706;
const PROTECTED_SURFACE = Object.freeze({
  "playwright.config.ts": 89,
  "playwright.stripe-appearance-evidence.config.ts": 30,
  "scripts/playwright-artifact-upload-fence.mjs": 622,
  "scripts/playwright-artifact-upload-fence.test.mjs": 343,
  "scripts/playwright-trace-secret-exposure-probe.mjs": 178,
  "infrastructure/playwright-evidence/index.ts": 409,
  "deployables/admin-web/e2e/support/retry-telemetry-reporter.ts": 35,
});
const words = (value) => value.split(" ");
const supportedTrace = new Set(
  words(
    "context-options screencast-frame before input log after action event stdout stderr error console resource-snapshot frame-snapshot",
  ),
);
const supportedStatus = new Set(words("passed failed timedout timedOut interrupted skipped expected unexpected flaky"));

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const stableJson = (value) => `${JSON.stringify(sortObject(value))}\n`;

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function runCli(label, handler) {
  try {
    process.stdout.write(`${JSON.stringify(handler(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${label} failed (${String(error.message).replace(/[^A-Z_]/g, "")}).\n`);
    process.exitCode = 1;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lineCount(bytes) {
  if (!bytes.length) return 0;
  const text = bytes.toString("utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function isText(file) {
  return /\.(?:mjs|ts|json|jsonl|html|md)$/.test(file);
}

function walk(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(root, entry.name);
      return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
    })
    .sort();
}

/* Closed recursive schema checker: a string names a scalar domain, a function is a predicate, an array
   declares a homogeneous list, `*` declares an open-keyed map of one shape, and any other object
   declares an exact key set. Every nested value is closed, so a nested unknown key is refused. */
const domains = {
  string: (value) => typeof value === "string" && value.length > 0,
  text: (value) => typeof value === "string",
  bool: (value) => typeof value === "boolean",
  count: (value) => Number.isSafeInteger(value) && value >= 0,
  millis: (value) => Number.isFinite(value) && value >= 0 && value <= 3_600_000,
  digest: (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
  hex: (value) => typeof value === "string" && /^[a-f0-9]*$/.test(value),
  instant: (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
};
const oneOf =
  (...allowed) =>
  (value) =>
    allowed.includes(value);
const sha1Path = (value) => typeof value === "string" && /^resources\/[a-f0-9]{40}$/.test(value);

export function closed(value, schema, label) {
  if (typeof schema === "string") {
    if (!domains[schema](value)) throw new Error(`${label}_VALUE_OUT_OF_DOMAIN`);
    return value;
  }
  if (typeof schema === "function") {
    if (!schema(value)) throw new Error(`${label}_VALUE_OUT_OF_DOMAIN`);
    return value;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) throw new Error(`${label}_NOT_ARRAY`);
    value.forEach((entry, index) => closed(entry, schema[0], `${label}${index}`));
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_NOT_OBJECT`);
  if (schema["*"]) {
    for (const [key, entry] of Object.entries(value)) closed(entry, schema["*"], `${label}_${key}`);
    return value;
  }
  const actual = Object.keys(value).sort().join(",");
  if (actual !== Object.keys(schema).sort().join(",")) throw new Error(`${label}_SCHEMA_OPEN_OR_INCOMPLETE`);
  for (const [key, entry] of Object.entries(schema)) closed(value[key], entry, `${label}_${key}`);
  return value;
}

/* ---------------------------------------------------------------- host-path portability (fail closed) */

const separatorClass = "[\\\\/]";
const rootPattern = new RegExp(
  repoRoot.replaceAll("\\", "/").split("/").map(escapeRegExp).join(`${separatorClass}+`),
  "i",
);
const hostPathRules = [
  ["WINDOWS_HOME_PATH", /[A-Za-z]:[\\/]{1,2}Users[\\/]/i],
  ["MACOS_HOME_PATH", /\/Users\/[^/\s"'\\]+\//],
  ["LINUX_HOME_PATH", /\/home\/[^/\s"'\\]+\//],
  ["WORKTREE_ROOT_PATH", rootPattern],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findHostPaths(text) {
  return hostPathRules.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
}

export function toPortableText(text) {
  const posix = repoRoot.replaceAll("\\", "/");
  const windows = posix.replaceAll("/", "\\");
  let out = text;
  for (const root of [windows.replaceAll("\\", "\\\\"), windows, posix]) out = out.split(root).join(REPO_TOKEN);
  return out.replace(/<repo>[^"'\s,)\]]*/g, (match) => match.replaceAll("\\", "/").replace(/\/{2,}/g, "/"));
}

export function assertPortablePayload(name, bytes) {
  for (const entry of archiveEntries(bytes) ?? [{ name, bytes }]) {
    const codes = findHostPaths(entry.bytes.toString("utf8"));
    if (codes.length) throw new Error(`DURABLE_PAYLOAD_CARRIES_${codes[0]}`);
  }
  return true;
}

/* ------------------------------------------------------------------------------- archive read/write */

export function readZipEntries(bytes, limits = { entries: 4096, bytes: 64 * 1024 * 1024 }) {
  const minimum = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP_END_MISSING");
  const count = bytes.readUInt16LE(end + 10);
  if (count > limits.entries) throw new Error("ZIP_ENTRY_LIMIT");
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP_CENTRAL_INVALID");
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (
      flags & 1 ||
      ![0, 8].includes(compression) ||
      name.includes("\\") ||
      path.posix.isAbsolute(name) ||
      name.split("/").includes("..")
    ) {
      throw new Error("ZIP_ENTRY_REFUSED");
    }
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP_LOCAL_INVALID");
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(data, data + compressedSize);
    const value = compression === 0 ? compressed : inflateRawSync(compressed);
    if (value.length !== size || (total += size) > limits.bytes) throw new Error("ZIP_SIZE_MISMATCH");
    entries.push({ name, bytes: value });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (new Set(entries.map(({ name }) => name.toLowerCase())).size !== entries.length)
    throw new Error("ZIP_DUPLICATE_NAME");
  return entries;
}

function archiveEntries(bytes) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return null;
  try {
    return readZipEntries(bytes);
  } catch {
    return null;
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/* Deterministic deflate rewrite: no timestamps, no extra fields, entry order preserved. */
export function writeZipEntries(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.bytes, { level: 9 });
    const stored = deflated.length >= entry.bytes.length;
    const payload = stored ? entry.bytes : deflated;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt32LE(crc32(entry.bytes), 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(stored ? 0 : 8, 10);
    record.writeUInt32LE(crc32(entry.bytes), 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(header, name, payload);
    central.push(record, name);
    offset += 30 + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/* ------------------------------------------------------------------------------- vendor derivation */

function resolveCodeInNodeScope(root, specifier) {
  const probe =
    'const{createRequire}=require("node:module");const r=createRequire(require("node:path").join(process.cwd(),"package.json"));try{r.resolve(process.argv[1]);process.stdout.write("RESOLVED_UNEXPECTEDLY")}catch(e){process.stdout.write(e.code)}';
  return execFileSync(process.execPath, ["-e", probe, specifier], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
}

const resolvedVendor = new Map();

/* The lockfile-bound vendor surface cannot move inside one process, and resolving it spawns two
   scoped Node probes, so the resolution is memoized per root rather than repeated per derivation. */
export function resolveVendorSurface(root = repoRoot) {
  const cached = resolvedVendor.get(root);
  if (cached) return cached;
  const rootRequire = createRequire(path.join(root, "package.json"));
  const refusedRoot = words("playwright/package.json playwright-core/package.json").map((specifier) => ({
    specifier,
    code: resolveCodeInNodeScope(root, specifier),
  }));
  const testPackage = rootRequire.resolve("@playwright/test/package.json");
  const scopedRequire = createRequire(testPackage);
  const playwrightPackage = scopedRequire.resolve("playwright/package.json");
  const corePackage = scopedRequire.resolve("playwright-core/package.json");
  const packageDir = path.dirname(playwrightPackage);
  const coreDir = path.dirname(corePackage);
  const sources = {
    worker: path.join(packageDir, "lib/worker/workerProcessEntry.js"),
    reporter: path.join(packageDir, "types/testReporter.d.ts"),
    coreBundle: scopedRequire.resolve("playwright-core/lib/coreBundle"),
    runner: scopedRequire.resolve("playwright/lib/runner"),
    coreIndexDeclaration: path.join(coreDir, "index.d.ts"),
    coreProtocolDeclaration: path.join(coreDir, "types/protocol.d.ts"),
    coreStructsDeclaration: path.join(coreDir, "types/structs.d.ts"),
    coreTypesDeclaration: path.join(coreDir, "types/types.d.ts"),
  };
  const nonExported = words("playwright/lib/worker/workerProcessEntry.js playwright/types/testReporter.d.ts").map(
    (specifier) => {
      try {
        scopedRequire.resolve(specifier);
        return { specifier, code: "RESOLVED_UNEXPECTEDLY" };
      } catch (error) {
        return { specifier, code: error.code };
      }
    },
  );
  const versions = [testPackage, playwrightPackage, corePackage].map(
    (file) => JSON.parse(readFileSync(file, "utf8")).version,
  );
  const scopeRefused = refusedRoot.every(({ code }) => code === "MODULE_NOT_FOUND");
  const exportsRefused = nonExported.every(({ code }) => code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
  if (versions.some((value) => value !== "1.60.0") || !scopeRefused || !exportsRefused) {
    throw new Error("VENDOR_VERSION_OR_SCOPE_MISMATCH");
  }
  const vendor = { testPackage, playwrightPackage, corePackage, sources, versions, refusedRoot, nonExported };
  resolvedVendor.set(root, vendor);
  return vendor;
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error("DERIVATION_ANCHOR_MISSING");
  return source.slice(from, to);
}

const memberEdges = {
  before: [{ field: "callId", target: "action.callId" }],
  after: [{ field: "callId", target: "action.callId" }],
  input: [{ field: "callId", target: "action.callId" }],
  log: [{ field: "callId", target: "action.callId" }],
  "frame-snapshot": [{ field: "snapshot.resourceOverrides[].sha1", target: "resources/<sha1>" }],
  "resource-snapshot": [{ field: "snapshot.response.content._sha1", target: "resources/<sha1>" }],
  "screencast-frame": [{ field: "sha1", target: "resources/<sha1>" }],
};

export function deriveGrammar({ sourceOverrides = {} } = {}) {
  const vendor = resolveVendorSurface();
  const bytes = Object.fromEntries(
    Object.entries(vendor.sources).map(([name, file]) => [name, sourceOverrides[name] ?? readFileSync(file, "utf8")]),
  );
  const consumer = between(bytes.coreBundle, "_innerAppendEvent(event)", "_processedContextCreatedEvent()");
  const traceTypes = [...consumer.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]);
  const reporterWindow = between(bytes.reporter, "export interface FullResult", "export interface TestStep");
  const declarations = words(
    "coreIndexDeclaration coreProtocolDeclaration coreStructsDeclaration coreTypesDeclaration",
  );
  if (
    declarations.some((name) => /screencast-frame|frame-snapshot|resource-snapshot|context-options/.test(bytes[name]))
  ) {
    throw new Error("TRACE_UNION_DECLARATION_CONTRADICTION");
  }
  const statusPattern = /["'](passed|failed|timedout|timedOut|interrupted|skipped|expected|unexpected|flaky)["']/g;
  const statuses = [...new Set([...reporterWindow.matchAll(statusPattern)].map((match) => match[1]))];
  const members = [
    ...traceTypes.map((type) => ({
      id: `trace:${type}`,
      source: "coreBundle",
      referenceEdges: memberEdges[type] ?? [],
      partition: supportedTrace.has(type) ? "HANDLED" : "INDETERMINATE",
    })),
    ...statuses.map((status) => ({
      id: `reporter:${status}`,
      source: "reporter",
      referenceEdges: [],
      partition: supportedStatus.has(status) ? "HANDLED" : "INDETERMINATE",
    })),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (new Set(members.map(({ id }) => id)).size !== members.length) throw new Error("DUPLICATE_GRAMMAR_MEMBER");
  return {
    schema: "playwright-evidence-authority/v1",
    playwrightVersion: "1.60.0",
    packages: { "@playwright/test": "1.60.0", playwright: "1.60.0", "playwright-core": "1.60.0" },
    derivationCommand:
      "node ./scripts/playwright-evidence-authority/derive-grammar.mjs --playwright-version 1.60.0 --check",
    resolution: {
      root: vendor.refusedRoot,
      chain: words(
        "@playwright/test/package.json playwright/package.json playwright-core/package.json playwright-core/lib/coreBundle playwright/lib/runner",
      ),
      nonExportedByteReads: vendor.nonExported,
    },
    enumeration: {
      tracked: "git ls-files -z --cached",
      honors: {
        suffixes: words(".test.ts .test.mts .spec.ts .spec.mts .d.ts .d.mts"),
        segments: words("__tests__ e2e fixtures tests fixture test test-support"),
      },
      vendor: "package-resolution-only-no-walk",
    },
    declarationAuthority: {
      playwrightCoreFiles: words("index.d.ts types/protocol.d.ts types/structs.d.ts types/types.d.ts"),
      traceEventUnionDeclared: false,
      reporter: "playwright/types/testReporter.d.ts",
    },
    digests: {
      lockfile: sha256(readFileSync(path.join(repoRoot, "pnpm-lock.yaml"))),
      testPackage: sha256(readFileSync(vendor.testPackage)),
      playwrightPackage: sha256(readFileSync(vendor.playwrightPackage)),
      corePackage: sha256(readFileSync(vendor.corePackage)),
      ...Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha256(value)])),
    },
    defaultPartition: "INDETERMINATE",
    members,
  };
}

export function checkGrammar(candidate = deriveGrammar()) {
  if (stableJson(candidate) !== readFileSync(grammarPath, "utf8")) throw new Error("GRAMMAR_STALE_OR_INCOMPLETE");
  const open = candidate.members.some(({ partition }) => !["HANDLED", "INDETERMINATE"].includes(partition));
  if (!candidate.members.length || open) throw new Error("GRAMMAR_PARTITION_OPEN");
  return candidate;
}

/* ------------------------------------------------------------- observation derived from real bytes */

/* Member classes are read from the typed discriminants the producers write, never by iterating the
   grammar, so a class the grammar omits is still observable and a grammar row with no real evidence
   stays visible as an uncovered member. */
export function observedMembersFor(name, bytes) {
  const members = new Set();
  for (const entry of archiveEntries(bytes) ?? [{ name, bytes }]) {
    if (/\.(?:trace|network)$/.test(entry.name)) {
      for (const line of entry.bytes.toString("utf8").split("\n")) {
        const type = parseJson(line)?.type;
        if (typeof type === "string") members.add(`trace:${type}`);
      }
    }
    if (/(?:^|\/)report\.json$/.test(entry.name)) {
      for (const status of reporterStatusesIn(parseJson(entry.bytes.toString("utf8"))))
        members.add(`reporter:${status}`);
    }
  }
  return [...members].sort();
}

function reporterResults(report) {
  const rows = [];
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          rows.push({
            title: spec.title,
            outcome: test.status,
            expectedStatus: test.expectedStatus,
            result,
            annotations: test.annotations ?? [],
          });
        }
      }
    }
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return rows;
}

function reporterStatusesIn(report) {
  const statuses = new Set();
  for (const row of reporterResults(report)) {
    for (const value of [row.outcome, row.expectedStatus, row.result.status])
      if (typeof value === "string") statuses.add(value);
  }
  return statuses;
}

/* AC3/AC5 reporter rows: one observation per real result, each bound to the result it came from. */
export function observeReporterStates(report) {
  return reporterResults(report)
    .map((row) => ({
      classification: `${row.outcome}/${row.result.status}`,
      title: row.title,
      outcome: row.outcome,
      expectedStatus: row.expectedStatus,
      status: row.result.status,
      retry: row.result.retry ?? 0,
      annotations: row.annotations
        .map(({ type, description }) => ({ type, description: description ?? "" }))
        .sort((a, b) => (a.type < b.type ? -1 : 1)),
      resultDigest: sha256(
        stableJson({
          status: row.result.status,
          retry: row.result.retry ?? 0,
          title: row.title,
          expectedStatus: row.expectedStatus,
        }),
      ),
    }))
    .sort((a, b) => (`${a.title}${a.retry}` < `${b.title}${b.retry}` ? -1 : 1));
}

function objectDepth(value, depth = 0) {
  if (!value || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.length ? Math.max(...children.map((child) => objectDepth(child, depth + 1))) : depth;
}

/* Real nesting observation: archive-in-archive levels plus decoded object depth, never a constant. */
export function observeNestingDepth(payloads) {
  const observe = (bytes, depth) => {
    const entries = archiveEntries(bytes);
    if (entries)
      return entries.length ? Math.max(...entries.map((entry) => observe(entry.bytes, depth + 1))) : depth + 1;
    const text = bytes.toString("utf8");
    const documents = [parseJson(text), ...text.split("\n").map(parseJson)].filter(
      (value) => value && typeof value === "object",
    );
    return documents.length ? Math.max(...documents.map((value) => depth + objectDepth(value))) : depth;
  };
  return payloads.length ? Math.max(...payloads.map((bytes) => observe(bytes, 0))) : 0;
}

function mimeAndMagic(file, bytes) {
  const mimes = {
    ".zip": "application/zip",
    ".png": "image/png",
    ".webm": "video/webm",
    ".woff2": "font/woff2",
    ".html": "text/html",
    ".json": "application/json",
    ".jsonl": "application/json",
  };
  return {
    mime: mimes[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    magic: bytes.subarray(0, Math.min(8, bytes.length)).toString("hex"),
  };
}

function referenceEdgesFor(name, bytes) {
  const entries = archiveEntries(bytes) ?? [{ name, bytes }];
  const present = new Set(entries.map((entry) => entry.name));
  const edges = [];
  for (const entry of entries) {
    for (const match of entry.bytes.toString("utf8").matchAll(/"(?:sha1|_sha1)":"([a-f0-9]{40})"/g)) {
      edges.push({ from: entry.name, target: `resources/${match[1]}`, present: present.has(`resources/${match[1]}`) });
    }
  }
  return [...new Map(edges.map((edge) => [`${edge.from}:${edge.target}`, edge])).values()].sort((a, b) =>
    `${a.from}:${a.target}`.localeCompare(`${b.from}:${b.target}`),
  );
}

/* --------------------------------------------------------------------------------- corpus building */

function findOne(files, pattern, code) {
  const matches = files.filter((file) => pattern.test(file.replaceAll("\\", "/")));
  if (matches.length !== 1) throw new Error(`${code}_${matches.length}`);
  return matches[0];
}

function normalizedPayload(relative, bytes) {
  if (relative.endsWith(".json")) {
    const value = parseJson(toPortableText(bytes.toString("utf8")));
    if (value === undefined) throw new Error("CAPTURE_JSON_UNPARSEABLE");
    return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  }
  const entries = archiveEntries(bytes);
  if (entries)
    return writeZipEntries(entries.map((entry) => ({ name: entry.name, bytes: portableBytes(entry.bytes) })));
  return portableBytes(bytes);
}

function portableBytes(bytes) {
  const text = bytes.toString("utf8");
  if (!findHostPaths(text).length) return bytes;
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("HOST_PATH_IN_NON_TEXT_PAYLOAD");
  return Buffer.from(toPortableText(text), "utf8");
}

export function importCapturedCorpus() {
  const files = walk(artifactRoot);
  const selected = {
    "capture/trace.zip": findOne(files, /trace\.zip$/, "TRACE_COUNT"),
    "capture/rendered-value.png": findOne(files, /rendered-value\.png$/, "RENDERED_VALUE_COUNT"),
    "capture/screenshot.png": findOne(files, /test-failed-1\.png$/, "SCREENSHOT_COUNT"),
    "capture/video.webm": findOne(files, /video\.webm$/, "VIDEO_COUNT"),
    "capture/index.html": path.join(artifactRoot, "html-report/index.html"),
    "capture/report.json": path.join(artifactRoot, "report.json"),
    "capture/runtime-receipt.json": path.join(artifactRoot, "runtime-receipt.json"),
    "capture/storage-state.json": path.join(artifactRoot, "storage-state.json"),
    "capture/font.woff2": path.join(artifactRoot, "font.woff2"),
    "capture/opaque-body.bin": path.join(artifactRoot, "opaque-body.bin"),
  };
  if (Object.values(selected).some((file) => !existsSync(file))) throw new Error("CAPTURE_PAYLOAD_MISSING");
  rmSync(fixtureRoot, { recursive: true, force: true });
  const write = (relative, bytes) => {
    const destination = path.join(fixtureRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    return bytes;
  };
  const imported = {};
  for (const [relative, source] of Object.entries(selected)) {
    imported[relative] = write(relative, normalizedPayload(relative, readFileSync(source)));
  }
  const traceEntries = readZipEntries(imported["capture/trace.zip"]);
  const attachment = traceEntries.find(
    ({ name, bytes }) => name.startsWith("resources/") && bytes.subarray(0, 4).equals(Buffer.from([0, 1, 2, 255])),
  );
  if (!attachment) throw new Error("OPAQUE_ATTACHMENT_MISSING");
  write("capture/attachment.bin", attachment.bytes);
  const referencing = traceEntries.find(
    (entry) => entry.name.endsWith(".trace") && /"(?:sha1|_sha1)":"[a-f0-9]{40}"/.test(entry.bytes.toString("utf8")),
  );
  if (!referencing) throw new Error("DANGLING_REFERENCE_SOURCE_MISSING");
  write("dangling-reference.trace", referencing.bytes);
  write("corrupt-trace.zip", imported["capture/trace.zip"].subarray(0, 47));
  const grammar = deriveGrammar();
  const observed = new Set(
    walk(fixtureRoot)
      .filter((file) => !file.endsWith("declared-controls.json"))
      .flatMap((file) =>
        observedMembersFor(path.relative(fixtureRoot, file).replaceAll("\\", "/"), readFileSync(file)),
      ),
  );
  const report = JSON.parse(imported["capture/report.json"].toString("utf8"));
  const produced = new Set(observeReporterStates(report).map(({ classification }) => classification));
  const control = (extra) => ({
    ...extra,
    coverage: "INDETERMINATE",
    reason: "synthetic-control-without-real-corpus-evidence",
  });
  write(
    "declared-controls.json",
    Buffer.from(
      stableJson({
        schema: "playwright-evidence-controls/v1",
        synthetic: true,
        corruptArchive: "synthetic-truncated-zip",
        danglingReference: "synthetic-standalone-trace-without-its-resources",
        members: grammar.members.filter(({ id }) => !observed.has(id)).map(({ id }) => control({ id })),
        reporterControls: UNPRODUCED_CLASSIFICATIONS.filter((id) => !produced.has(id)).map((classification) =>
          control({ classification }),
        ),
      }),
      "utf8",
    ),
  );
  const manifest = buildCorpusManifest();
  writeFileSync(manifestPath, stableJson(manifest));
  return manifest;
}

export function buildCorpusManifest() {
  const grammar = deriveGrammar();
  const files = walk(fixtureRoot).filter((file) => file !== manifestPath);
  const payloads = files.map((file) => {
    const bytes = readFileSync(file);
    const relative = path.relative(fixtureRoot, file).replaceAll("\\", "/");
    assertPortablePayload(relative, bytes);
    const control = relative === "declared-controls.json";
    return {
      path: relative,
      bytes: bytes.length,
      digest: sha256(bytes),
      ...mimeAndMagic(file, bytes),
      sourceMembers: control ? [] : observedMembersFor(relative, bytes),
      referenceEdges: control ? [] : referenceEdgesFor(relative, bytes),
    };
  });
  const controls = readDeclaredControls();
  const observed = [...new Set(payloads.flatMap(({ sourceMembers }) => sourceMembers))].sort();
  const declared = controls.members.map(({ id }) => id).sort();
  const memberCoverage = grammar.members.map(({ id, partition }) => ({
    id,
    partition,
    coverage: observed.includes(id) ? "OBSERVED" : declared.includes(id) ? "DECLARED_CONTROL" : "UNCOVERED",
  }));
  const runtime = JSON.parse(readFileSync(path.join(fixtureRoot, "capture/runtime-receipt.json"), "utf8"));
  const report = JSON.parse(readFileSync(path.join(fixtureRoot, "capture/report.json"), "utf8"));
  const elapsed = Math.ceil(runtime.events.at(-1).monotonicMs - runtime.events[0].monotonicMs);
  const totalBytes = payloads.reduce((sum, row) => sum + row.bytes, 0);
  const totalEdges = payloads.reduce((sum, row) => sum + row.referenceEdges.length, 0);
  const depth = observeNestingDepth(files.map((file) => readFileSync(file)));
  return {
    schema: "playwright-evidence-corpus/v1",
    playwrightVersion: "1.60.0",
    capturedAt: runtime.capturedAt,
    grammarDigest: sha256(stableJson(grammar)),
    payloads,
    coverage: { observed, declared, memberCoverage },
    reporterStates: observeReporterStates(report),
    limits: {
      nestingDepth: headroom(depth, "levels", depth),
      payloadBytes: headroom(totalBytes, "bytes"),
      referenceEdges: headroom(totalEdges, "count"),
      runtimeMs: headroom(elapsed, "milliseconds"),
    },
  };
}

const controlsSchema = {
  schema: oneOf("playwright-evidence-controls/v1"),
  synthetic: oneOf(true),
  corruptArchive: "string",
  danglingReference: "string",
  members: [{ id: "string", coverage: oneOf("INDETERMINATE"), reason: "string" }],
  reporterControls: [{ classification: "string", coverage: oneOf("INDETERMINATE"), reason: "string" }],
};

export function readDeclaredControls() {
  return closed(JSON.parse(readFileSync(controlsPath, "utf8")), controlsSchema, "controls");
}

const edgeSchema = { from: "string", target: sha1Path, present: "bool" };
const headroom = (largestRequired, unit, supportedMaximum = Math.ceil(Math.max(1, largestRequired) * 1.25)) => ({
  largestRequired,
  supportedMaximum,
  firstRefused: supportedMaximum + 1,
  unit,
});
const limitSchema = { largestRequired: "count", supportedMaximum: "count", firstRefused: "count", unit: "string" };
const corpusSchema = {
  schema: oneOf("playwright-evidence-corpus/v1"),
  playwrightVersion: oneOf("1.60.0"),
  capturedAt: "instant",
  grammarDigest: "digest",
  payloads: [
    {
      path: "string",
      bytes: "count",
      digest: "digest",
      mime: "string",
      magic: "hex",
      sourceMembers: ["string"],
      referenceEdges: [edgeSchema],
    },
  ],
  coverage: {
    observed: ["string"],
    declared: ["string"],
    memberCoverage: [
      {
        id: "string",
        partition: oneOf("HANDLED", "INDETERMINATE"),
        coverage: oneOf("OBSERVED", "DECLARED_CONTROL", "UNCOVERED"),
      },
    ],
  },
  reporterStates: [
    {
      classification: "string",
      title: "string",
      outcome: "string",
      expectedStatus: "string",
      status: "string",
      retry: "count",
      annotations: [{ type: "string", description: "text" }],
      resultDigest: "digest",
    },
  ],
  limits: { nestingDepth: limitSchema, payloadBytes: limitSchema, referenceEdges: limitSchema, runtimeMs: limitSchema },
};

export function validateCorpusManifest(manifest) {
  closed(manifest, corpusSchema, "corpus");
  const paths = manifest.payloads.map(({ path: file }) => file);
  if (
    new Set(paths.map((file) => file.toLowerCase())).size !== paths.length ||
    paths.some((file) => path.posix.isAbsolute(file) || file.split("/").includes(".."))
  ) {
    throw new Error("PAYLOAD_PATH_SET_INVALID");
  }
  for (const limit of Object.values(manifest.limits)) {
    if (limit.supportedMaximum < limit.largestRequired || limit.firstRefused !== limit.supportedMaximum + 1)
      throw new Error("LIMIT_BOUNDS_INVALID");
  }
  return manifest;
}

export function assertCorpusMatches(candidate, fresh = buildCorpusManifest()) {
  validateCorpusManifest(candidate);
  if (stableJson(fresh) !== stableJson(candidate)) throw new Error("CORPUS_STALE_MISSING_DUPLICATE_OR_MALFORMED");
  return candidate;
}

export function checkCorpus() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertCorpusMatches(manifest);
  const expected = new Set(manifest.payloads.map(({ path: file }) => file));
  const actual = new Set(
    walk(fixtureRoot)
      .filter((file) => file !== manifestPath)
      .map((file) => path.relative(fixtureRoot, file).replaceAll("\\", "/")),
  );
  if (expected.size !== actual.size || [...expected].some((file) => !actual.has(file)))
    throw new Error("CORPUS_PAYLOAD_SET_OPEN");
  reconcileGrammarCorpus(checkGrammar(), manifest);
  return manifest;
}

/* Both arms are reachable: `observed` is derived from payload bytes and `declared` from the synthetic
   control inventory, so a corpus class the grammar omits and a grammar row nothing covers are both red. */
export function reconcileGrammarCorpus(grammar, manifest) {
  const grammarIds = new Set(grammar.members.map(({ id }) => id));
  const observed = new Set(manifest.coverage.observed);
  const declared = new Set(manifest.coverage.declared);
  if (manifest.coverage.observed.some((id) => !grammarIds.has(id)))
    throw new Error("GRAMMAR_CORPUS_FORWARD_GAP_RECONCILIATION_FAILED");
  if ([...grammarIds].some((id) => !observed.has(id) && !declared.has(id)))
    throw new Error("CORPUS_GRAMMAR_REVERSE_GAP_RECONCILIATION_FAILED");
  if ([...declared].some((id) => observed.has(id) || !grammarIds.has(id)))
    throw new Error("DECLARED_CONTROL_INVENTORY_RECONCILIATION_FAILED");
  if (manifest.coverage.memberCoverage.some(({ coverage }) => coverage === "UNCOVERED"))
    throw new Error("UNCOVERED_MEMBER_RECONCILIATION_FAILED");
  return true;
}

/* ------------------------------------------------------------------------------------ AC1 gate */

const WITHIN = "WITHIN_PROTECTED_SURFACE";
const EXCEEDS = "EXCEEDS_PROTECTED_SURFACE";
const proportionalitySchema = {
  status: oneOf(WITHIN, EXCEEDS),
  denominatorFiles: [{ file: "string", lines: "count" }],
  denominatorLines: "count",
  authorityFiles: ["string"],
  executableLines: "count",
  testLines: "count",
  fixtureLines: "count",
  measuredLines: "count",
  textFixtureBytes: "count",
  binaryFixtureBytes: "count",
};

export function proportionality() {
  const tracked = git(["ls-files", "--cached"]).split(/\r?\n/).filter(Boolean);
  const denominatorFiles = Object.entries(PROTECTED_SURFACE).map(([file, expected]) => {
    if (!tracked.includes(file)) throw new Error("PROTECTED_SURFACE_MISSING");
    const lines = lineCount(readFileSync(path.join(repoRoot, file)));
    if (lines !== expected) throw new Error("PROTECTED_SURFACE_DRIFT");
    return { file, lines };
  });
  const owned = (file) =>
    file.startsWith("scripts/playwright-evidence-authority/") ||
    file.startsWith("scripts/fixtures/playwright-evidence-authority/");
  const authorityFiles = [...new Set([...tracked.filter(owned), RELEASE_FILE])].sort();
  const absolute = (file) => path.join(repoRoot, file);
  const pending = (file) => file === RELEASE_FILE && !existsSync(absolute(file));
  const linesOf = (file) => (pending(file) ? 1 : isText(file) ? lineCount(readFileSync(absolute(file))) : 0);
  const bytesOf = (file) => (pending(file) ? 0 : statSync(absolute(file)).size);
  const isTest = (file) => /\.(?:test\.mjs|spec\.ts)$/.test(file);
  const isFixture = (file) => file.startsWith("scripts/fixtures/") || file.endsWith(".json");
  const total = (predicate, project) => authorityFiles.filter(predicate).reduce((sum, file) => sum + project(file), 0);
  const testLines = total((file) => isTest(file), linesOf);
  const fixtureLines = total((file) => !isTest(file) && isFixture(file), linesOf);
  const measuredLines = total(() => true, linesOf);
  return assertProportionality({
    status: measuredLines <= DENOMINATOR_LINES ? WITHIN : EXCEEDS,
    denominatorFiles,
    denominatorLines: DENOMINATOR_LINES,
    authorityFiles,
    executableLines: measuredLines - testLines - fixtureLines,
    testLines,
    fixtureLines,
    measuredLines,
    textFixtureBytes: total((file) => file.startsWith("scripts/fixtures/") && isText(file), bytesOf),
    binaryFixtureBytes: total((file) => !isText(file), bytesOf),
  });
}

export function assertProportionality(receipt) {
  closed(receipt, proportionalitySchema, "proportionality");
  const declared = receipt.denominatorFiles.reduce((sum, row) => sum + row.lines, 0);
  const summed = receipt.executableLines + receipt.testLines + receipt.fixtureLines;
  if (
    receipt.denominatorLines !== DENOMINATOR_LINES ||
    receipt.denominatorFiles.length !== 7 ||
    declared !== DENOMINATOR_LINES ||
    receipt.measuredLines !== summed
  ) {
    throw Object.assign(new Error("PROPORTIONALITY_RECEIPT_INVALID"), { receipt });
  }
  const over = receipt.measuredLines > receipt.denominatorLines;
  if (over && receipt.status === WITHIN)
    throw Object.assign(new Error("AUTHORITY_EXCEEDS_PROTECTED_SURFACE"), { receipt });
  if (!over && receipt.status === EXCEEDS)
    throw Object.assign(new Error("PROPORTIONALITY_STATUS_MISDECLARED"), { receipt });
  return receipt;
}

/* --------------------------------------------------------------------------- binary-policy/v1 */

export function binaryPolicy(manifest = checkCorpus()) {
  const payloadFor = (suffix) => {
    const row = manifest.payloads.find(({ path: file }) => file.endsWith(suffix));
    if (!row) throw new Error(`BINARY_POLICY_PAYLOAD_MISSING_${manifest.payloads.length}`);
    return row;
  };
  const opaque = readFileSync(path.join(fixtureRoot, payloadFor("opaque-body.bin").path));
  const registeredValue = opaque.toString("utf8").match(/SYNTHETIC_REGISTERED_PROBE_VALUE_[a-f0-9]{20}/)?.[0];
  if (!registeredValue) throw new Error("REGISTERED_VALUE_NOT_RECOVERABLE_FROM_CAPTURE");
  const row = (payload) => ({
    bytes: payload.bytes,
    mime: payload.mime,
    magic: payload.magic,
    digest: payload.digest,
    referenceEdges: payload.referenceEdges,
    recoverability: recoverRegisteredValue({
      registeredValue,
      payloads: [readFileSync(path.join(fixtureRoot, payload.path))],
    }).status,
  });
  const rows = {
    woff2: row(payloadFor("font.woff2")),
    "opaque-body": row(payloadFor("opaque-body.bin")),
    attachment: row(payloadFor("attachment.bin")),
    screenshot: row(payloadFor("capture/screenshot.png")),
    "video-screencast": row(payloadFor("video.webm")),
    "rendered-value": row(payloadFor("rendered-value.png")),
    "unknown-dangling-reference": row(payloadFor("dangling-reference.trace")),
  };
  const digests = Object.values(rows).map(({ digest }) => digest);
  if (new Set(digests).size !== digests.length) throw new Error("BINARY_POLICY_CLASS_ALIASED");
  if (!rows["unknown-dangling-reference"].referenceEdges.some(({ present }) => !present))
    throw new Error("BINARY_POLICY_DANGLING_EDGE_MISSING");
  return { schema: "binary-policy/v1", rows };
}

/* ------------------------------------------------------------------------------ runtime witness */

const runtimeSchema = {
  schema: oneOf("runtime-witness/v1"),
  capturedAt: "instant",
  retry: oneOf(1),
  events: [{ kind: "string", monotonicMs: "millis", digest: "digest" }],
};

export function validateRuntimeWitness(receipt) {
  closed(receipt, runtimeSchema, "runtime");
  if (receipt.events.map(({ kind }) => kind).join(",") !== "request,mint,register,response,teardown")
    throw new Error("RUNTIME_ORDER_INVALID");
  let previous = -1;
  for (const event of receipt.events) {
    if (event.monotonicMs <= previous || event.digest !== sha256(`${event.kind}:${event.monotonicMs}`))
      throw new Error("RUNTIME_EVENT_INVALID");
    previous = event.monotonicMs;
  }
  return receipt;
}

/* --------------------------------------------------------------------------------- release */

const releaseSchema = {
  schema: oneOf("playwright-evidence-release/v1"),
  playwrightVersion: oneOf("1.60.0"),
  releasedAt: "instant",
  headBinding: { mode: oneOf("checked-out-git-head", "pre-landing-unbound"), derivationHead: "string" },
  digests: { grammar: "digest", corpus: "digest", oracle: "digest", protocol: "digest", files: { "*": "digest" } },
  decisions: [{ id: "string", ruling: oneOf("A") }],
  proportionality: proportionalitySchema,
  runtimeWitnessDigest: "digest",
  reporterObservationDigest: "digest",
  coverageDigest: "digest",
  binaryPolicy: {
    schema: oneOf("binary-policy/v1"),
    rows: {
      "*": {
        bytes: "count",
        mime: "string",
        magic: "hex",
        digest: "digest",
        referenceEdges: [edgeSchema],
        recoverability: oneOf("HIT", "CLEAR", "INDETERMINATE"),
      },
    },
  },
  independentReview: {
    status: oneOf("PENDING", "PASS"),
    receipt: (value) => value === null || typeof value === "object",
  },
  receiptDigest: "digest",
};
const POLICY_ROWS =
  "attachment,opaque-body,rendered-value,screenshot,unknown-dangling-reference,video-screencast,woff2";
const DECISION_IDS = "5305457791,5307013162,5308182286,5308183737";

/* The head binding is derived from git, never re-read from the release it is supposed to bind. Until
   the authority lands, the tracked authority differs from HEAD and the binding is the explicit
   pre-landing sentinel, which refuses every `--expected-head` consumer by construction. */
export function liveHeadBinding() {
  const dirty = git([
    "status",
    "--porcelain",
    "--",
    "scripts/playwright-evidence-authority",
    "scripts/fixtures/playwright-evidence-authority",
  ]);
  return dirty
    ? { mode: "pre-landing-unbound", derivationHead: PRE_LANDING_HEAD }
    : { mode: "checked-out-git-head", derivationHead: git(["rev-parse", "HEAD"]) };
}

export function assertHeadBinding(headBinding) {
  const live = liveHeadBinding();
  if (headBinding.mode === "pre-landing-unbound") {
    if (headBinding.derivationHead !== PRE_LANDING_HEAD) throw new Error("RELEASE_HEAD_BINDING_INVALID");
    return headBinding;
  }
  if (!/^[a-f0-9]{40}$/.test(headBinding.derivationHead)) throw new Error("RELEASE_HEAD_BINDING_INVALID");
  if (live.mode !== "checked-out-git-head" || headBinding.derivationHead !== live.derivationHead)
    throw new Error("RELEASE_HEAD_BINDING_STALE");
  return headBinding;
}

export function buildRelease({ review = { status: "PENDING", receipt: null }, headBinding = liveHeadBinding() } = {}) {
  const grammar = checkGrammar();
  const corpus = checkCorpus();
  const policy = binaryPolicy(corpus);
  const proportion = proportionality();
  const runtime = validateRuntimeWitness(
    JSON.parse(readFileSync(path.join(fixtureRoot, "capture/runtime-receipt.json"), "utf8")),
  );
  const authorityFiles = proportion.authorityFiles.filter((file) => file !== RELEASE_FILE);
  const release = {
    schema: "playwright-evidence-release/v1",
    playwrightVersion: "1.60.0",
    releasedAt: runtime.capturedAt,
    headBinding: assertHeadBinding(headBinding),
    digests: {
      grammar: sha256(stableJson(grammar)),
      corpus: sha256(stableJson(corpus)),
      oracle: sha256(readFileSync(path.join(authorityRoot, "recovery-oracle.mjs"))),
      protocol: sha256(readFileSync(path.join(authorityRoot, "transaction.mjs"))),
      files: Object.fromEntries(authorityFiles.map((file) => [file, sha256(readFileSync(path.join(repoRoot, file)))])),
    },
    decisions: DECISION_IDS.split(",").map((id) => ({ id, ruling: "A" })),
    proportionality: proportion,
    runtimeWitnessDigest: sha256(stableJson(runtime)),
    reporterObservationDigest: sha256(stableJson(corpus.reporterStates)),
    coverageDigest: sha256(stableJson(corpus.coverage)),
    binaryPolicy: policy,
    independentReview: review,
  };
  return { ...release, receiptDigest: sha256(stableJson(release)) };
}

export function validateRelease(release, { expectedHead, requireIndependentPass = false } = {}) {
  closed(release, releaseSchema, "release");
  assertProportionality(release.proportionality);
  if (Object.keys(release.binaryPolicy.rows).sort().join(",") !== POLICY_ROWS)
    throw new Error("BINARY_POLICY_ROWS_INVALID");
  if (
    release.decisions
      .map(({ id }) => id)
      .sort()
      .join(",") !== DECISION_IDS
  )
    throw new Error("DECISION_INVENTORY_INVALID");
  if (release.independentReview.status === "PENDING" && release.independentReview.receipt !== null)
    throw new Error("PENDING_REVIEW_RECEIPT_INVALID");
  if (release.independentReview.status === "PASS") {
    closed(
      release.independentReview.receipt,
      { exactHead: (value) => /^[a-f0-9]{40}$/.test(value), reviewedAt: "instant", url: "string", digest: "digest" },
      "independent_review_receipt",
    );
  }
  const { receiptDigest, ...unsigned } = release;
  if (receiptDigest !== sha256(stableJson(unsigned))) throw new Error("RELEASE_DIGEST_INVALID");
  if (expectedHead !== undefined) {
    if (expectedHead === "[AUTHORITY_HEAD]" || !/^[a-f0-9]{40}$/.test(expectedHead))
      throw new Error("EXPECTED_HEAD_REFUSED_UNBOUND");
    if (release.headBinding.derivationHead !== expectedHead) throw new Error("EXPECTED_HEAD_REFUSED_BINDING_MISMATCH");
    if (expectedHead !== git(["rev-parse", "HEAD"])) throw new Error("EXPECTED_HEAD_REFUSED_CHECKOUT_MISMATCH");
  }
  /* A release measured above its protected surface stays inspectable but is never consumable: every
     downstream gate that binds a head or requires an independent pass refuses it outright, so the
     over-budget authority cannot be adopted without the ruling the criterion routes it to. */
  const consuming = expectedHead !== undefined || requireIndependentPass;
  if (consuming && release.proportionality.status !== WITHIN) throw new Error("PROPORTIONALITY_DECISION_REQUIRED");
  if (requireIndependentPass && release.independentReview.status !== "PASS")
    throw new Error("INDEPENDENT_REVIEW_NOT_PASS");
  return release;
}

export function checkRelease({ expectedHead, requireIndependentPass = false } = {}) {
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  validateRelease(release, { expectedHead, requireIndependentPass });
  assertHeadBinding(release.headBinding);
  const fresh = buildRelease({ review: release.independentReview, headBinding: release.headBinding });
  if (stableJson(fresh) !== stableJson(release)) throw new Error("RELEASE_STALE");
  return release;
}

/* ------------------------------------------------------------------ AC6 staging-time validators */

/* Candidate-neutral: the protocol takes validators, the authority supplies them, so staging really
   runs the reference and oracle validation AC6 names instead of tree and receipt digests alone. */
export function stagingValidators(manifest = checkCorpus()) {
  const registered = readFileSync(path.join(fixtureRoot, "capture/opaque-body.bin"))
    .toString("utf8")
    .match(/SYNTHETIC_REGISTERED_PROBE_VALUE_[a-f0-9]{20}/)?.[0];
  const expected = new Map(manifest.payloads.map((row) => [row.path, row]));
  return {
    "reference-validation": (staged) => {
      for (const [relative, bytes] of staged) {
        const row = expected.get(relative);
        if (!row) continue;
        if (stableJson(referenceEdgesFor(relative, bytes)) !== stableJson(row.referenceEdges))
          throw new Error("STAGED_REFERENCE_EDGES_CHANGED");
        assertPortablePayload(relative, bytes);
      }
    },
    "oracle-validation": (staged) => {
      if (!registered) throw new Error("STAGED_ORACLE_VALUE_MISSING");
      const observed = recoverRegisteredValue({
        registeredValue: registered,
        payloads: staged.map(([, bytes]) => bytes),
      }).status;
      if (observed !== "HIT") throw new Error(`STAGED_ORACLE_${observed}`);
    },
  };
}

/* ---------------------------------------------------------------------------------- full verify */

export function verifyAuthority(argv = []) {
  const proportion = proportionality();
  if (argv.includes("--proportionality")) return { status: "PASS", proportionality: proportion };
  const grammar = checkGrammar();
  const corpus = checkCorpus();
  const scan = scanTrackedConsumers();
  if (scan.violations.length) throw new Error("CONSUMER_INDEPENDENCE_FAILED");
  const transactionRoot = mkdtempSync(path.join(tmpdir(), "playwright-authority-conformance-"));
  let transaction;
  try {
    transaction = verifyTransactionHarness({
      source: fixtureRoot,
      transactionRoot,
      validators: stagingValidators(corpus),
    });
  } finally {
    rmSync(transactionRoot, { recursive: true, force: true });
  }
  const release = checkRelease();
  return {
    status: "PASS",
    grammarMembers: grammar.members.length,
    corpusPayloads: corpus.payloads.length,
    observedMembers: corpus.coverage.observed.length,
    declaredControls: corpus.coverage.declared.length,
    reporterObservations: corpus.reporterStates.length,
    scannedCandidates: scan.scannedCandidates,
    transactionCases: transaction.observations.length,
    headBinding: release.headBinding.mode,
    receiptDigest: release.receiptDigest,
  };
}
