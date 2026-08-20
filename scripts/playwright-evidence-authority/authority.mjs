import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { recoverRegisteredValue } from "./recovery-oracle.mjs";

export const repoRoot = path.resolve(import.meta.dirname, "../..");
export const authorityRoot = import.meta.dirname;
export const fixtureRoot = path.join(repoRoot, "scripts/fixtures/playwright-evidence-authority/1.60.0");
export const artifactRoot = path.join(repoRoot, "artifacts/playwright-evidence-authority");
export const grammarPath = path.join(authorityRoot, "grammar.json");
export const manifestPath = path.join(fixtureRoot, "manifest.json");
export const releasePath = path.join(authorityRoot, "release.json");
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const stableJson = (value) => `${JSON.stringify(sortObject(value))}\n`;

const protectedSurface = Object.freeze({
  "playwright.config.ts": 89,
  "playwright.stripe-appearance-evidence.config.ts": 30,
  "scripts/playwright-artifact-upload-fence.mjs": 622,
  "scripts/playwright-artifact-upload-fence.test.mjs": 343,
  "scripts/playwright-trace-secret-exposure-probe.mjs": 178,
  "infrastructure/playwright-evidence/index.ts": 409,
  "deployables/admin-web/e2e/support/retry-telemetry-reporter.ts": 35,
});
const supportedTrace = new Set([
  "context-options", "screencast-frame", "before", "input", "log", "after", "action",
  "event", "stdout", "stderr", "error", "console", "resource-snapshot", "frame-snapshot",
]);
const supportedStatus = new Set([
  "passed", "failed", "timedout", "timedOut", "interrupted", "skipped", "expected", "unexpected", "flaky",
]);

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }).trim();
}

function resolveCodeInNodeScope(root, specifier) {
  const probe = 'const{createRequire}=require("node:module");const r=createRequire(require("node:path").join(process.cwd(),"package.json"));try{r.resolve(process.argv[1]);process.stdout.write("RESOLVED_UNEXPECTEDLY")}catch(e){process.stdout.write(e.code)}';
  return execFileSync(process.execPath, ["-e", probe, specifier], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } });
}

export function resolveVendorSurface(root = repoRoot) {
  const rootRequire = createRequire(path.join(root, "package.json"));
  const refusedRoot = ["playwright/package.json", "playwright-core/package.json"]
    .map((specifier) => ({ specifier, code: resolveCodeInNodeScope(root, specifier) }));
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
  const nonExported = ["playwright/lib/worker/workerProcessEntry.js", "playwright/types/testReporter.d.ts"].map((specifier) => {
    try { scopedRequire.resolve(specifier); return { specifier, code: "RESOLVED_UNEXPECTEDLY" }; }
    catch (error) { return { specifier, code: error.code }; }
  });
  const versions = [testPackage, playwrightPackage, corePackage].map((file) => JSON.parse(readFileSync(file, "utf8")).version);
  if (versions.some((value) => value !== "1.60.0") || refusedRoot.some(({ code }) => code !== "MODULE_NOT_FOUND") || nonExported.some(({ code }) => code !== "ERR_PACKAGE_PATH_NOT_EXPORTED")) {
    throw new Error(`VENDOR_VERSION_OR_SCOPE_MISMATCH_${versions.join("_")}_${refusedRoot.map(({ code }) => code).join("_")}_${nonExported.map(({ code }) => code).join("_")}`);
  }
  return { testPackage, playwrightPackage, corePackage, sources, versions, refusedRoot, nonExported };
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error("DERIVATION_ANCHOR_MISSING");
  return source.slice(from, to);
}

export function deriveGrammar({ sourceOverrides = {} } = {}) {
  const vendor = resolveVendorSurface();
  const bytes = Object.fromEntries(Object.entries(vendor.sources).map(([name, file]) => [name, sourceOverrides[name] ?? readFileSync(file, "utf8")]));
  const consumer = between(bytes.coreBundle, "_innerAppendEvent(event)", "_processedContextCreatedEvent()");
  const traceTypes = [...consumer.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]);
  const reporterWindow = between(bytes.reporter, "export interface FullResult", "export interface TestStep");
  if ([bytes.coreIndexDeclaration, bytes.coreProtocolDeclaration, bytes.coreStructsDeclaration, bytes.coreTypesDeclaration].some((source) => /screencast-frame|frame-snapshot|resource-snapshot|context-options/.test(source))) throw new Error("TRACE_UNION_DECLARATION_CONTRADICTION");
  const statuses = [...new Set([...reporterWindow.matchAll(/["'](passed|failed|timedout|timedOut|interrupted|skipped|expected|unexpected|flaky)["']/g)].map((match) => match[1]))];
  const referenceEdges = (type) => type === "before" || type === "after" || type === "input" || type === "log"
    ? [{ field: "callId", target: "action.callId" }]
    : type === "frame-snapshot" ? [{ field: "snapshot.resourceOverrides[].sha1", target: "resources/<sha1>" }]
      : type === "resource-snapshot" ? [{ field: "snapshot.response.content._sha1", target: "resources/<sha1>" }]
        : type === "screencast-frame" ? [{ field: "sha1", target: "resources/<sha1>" }] : [];
  const members = [
    ...traceTypes.map((type) => ({ id: `trace:${type}`, source: "coreBundle", referenceEdges: referenceEdges(type), partition: supportedTrace.has(type) ? "HANDLED" : "INDETERMINATE" })),
    ...statuses.map((status) => ({ id: `reporter:${status}`, source: "reporter", referenceEdges: [], partition: supportedStatus.has(status) ? "HANDLED" : "INDETERMINATE" })),
  ].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(members.map(({ id }) => id)).size !== members.length) throw new Error("DUPLICATE_GRAMMAR_MEMBER");
  const lockfileBytes = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"));
  return {
    schema: "playwright-evidence-authority/v1",
    playwrightVersion: "1.60.0",
    packages: { "@playwright/test": "1.60.0", playwright: "1.60.0", "playwright-core": "1.60.0" },
    derivationCommand: "node ./scripts/playwright-evidence-authority/derive-grammar.mjs --playwright-version 1.60.0 --check",
    resolution: { root: vendor.refusedRoot, chain: ["@playwright/test/package.json", "playwright/package.json", "playwright-core/package.json", "playwright-core/lib/coreBundle", "playwright/lib/runner"], nonExportedByteReads: vendor.nonExported },
    enumeration: { tracked: "git ls-files -z --cached", honors: { suffixes: [".test.ts", ".test.mts", ".spec.ts", ".spec.mts", ".d.ts", ".d.mts"], segments: ["__tests__", "e2e", "fixtures", "tests", "fixture", "test", "test-support"] }, vendor: "package-resolution-only-no-walk" },
    declarationAuthority: { playwrightCoreFiles: ["index.d.ts", "types/protocol.d.ts", "types/structs.d.ts", "types/types.d.ts"], traceEventUnionDeclared: false, reporter: "playwright/types/testReporter.d.ts" },
    digests: {
      lockfile: sha256(lockfileBytes), testPackage: sha256(readFileSync(vendor.testPackage)),
      playwrightPackage: sha256(readFileSync(vendor.playwrightPackage)), corePackage: sha256(readFileSync(vendor.corePackage)),
      ...Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha256(value)])),
    },
    defaultPartition: "INDETERMINATE",
    members,
  };
}

export function checkGrammar(candidate = deriveGrammar()) {
  const expected = readFileSync(grammarPath, "utf8");
  if (stableJson(candidate) !== expected) throw new Error("GRAMMAR_STALE_OR_INCOMPLETE");
  if (!candidate.members.length || candidate.members.some(({ partition }) => !["HANDLED", "INDETERMINATE"].includes(partition))) throw new Error("GRAMMAR_PARTITION_OPEN");
  return candidate;
}

export function readZipEntries(bytes, limits = { entries: 4096, bytes: 64 * 1024 * 1024 }) {
  const minimum = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  if (end < 0) throw new Error("ZIP_END_MISSING");
  const count = bytes.readUInt16LE(end + 10);
  if (count > limits.entries) throw new Error("ZIP_ENTRY_LIMIT");
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP_CENTRAL_INVALID");
    const flags = bytes.readUInt16LE(offset + 8), compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (flags & 1 || ![0, 8].includes(compression) || name.includes("\\") || path.posix.isAbsolute(name) || name.split("/").includes("..")) throw new Error("ZIP_ENTRY_REFUSED");
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP_LOCAL_INVALID");
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(data, data + compressedSize);
    const value = compression === 0 ? compressed : inflateRawSync(compressed);
    if (value.length !== size || (total += size) > limits.bytes) throw new Error("ZIP_SIZE_MISMATCH");
    entries.push({ name, bytes: value });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (new Set(entries.map(({ name }) => name.toLowerCase())).size !== entries.length) throw new Error("ZIP_DUPLICATE_NAME");
  return entries;
}

function walk(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
  }).sort();
}

function mimeAndMagic(file, bytes) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".zip" ? "application/zip" : ext === ".png" ? "image/png" : ext === ".webm" ? "video/webm" : ext === ".woff2" ? "font/woff2" : ext === ".html" ? "text/html" : ext === ".json" || ext === ".jsonl" ? "application/json" : "application/octet-stream";
  return { mime, magic: bytes.subarray(0, Math.min(8, bytes.length)).toString("hex") };
}

function sourceMembersFor(file, bytes, grammar) {
  const relative = path.relative(fixtureRoot, file).replaceAll("\\", "/");
  const members = new Set();
  if (relative === "corrupt-trace.zip") return [];
  const acceptText = (text) => {
    for (const row of grammar.members) {
      const value = row.id.slice(row.id.indexOf(":") + 1);
      if (text.includes(`"type":"${value}"`) || text.includes(`"status":"${value}"`) || text.includes(`"${value}"`)) members.add(row.id);
    }
  };
  if (relative.endsWith(".zip")) for (const entry of readZipEntries(bytes)) acceptText(entry.bytes.toString("utf8"));
  else if (/\.(?:json|jsonl|html)$/.test(relative)) acceptText(bytes.toString("utf8"));
  return [...members].sort();
}

function referenceEdgesFor(file, bytes) {
  if (!file.endsWith("trace.zip") || path.basename(file) === "corrupt-trace.zip") return [];
  const entries = readZipEntries(bytes);
  const names = new Set(entries.map(({ name }) => name));
  const edges = [];
  for (const entry of entries) {
    const text = entry.bytes.toString("utf8");
    for (const match of text.matchAll(/"(?:sha1|_sha1)":"([a-f0-9]{40})"/g)) edges.push({ from: entry.name, target: `resources/${match[1]}`, present: names.has(`resources/${match[1]}`) });
  }
  return edges.sort((a, b) => `${a.from}:${a.target}`.localeCompare(`${b.from}:${b.target}`));
}

function findOne(files, pattern, code) {
  const matches = files.filter((file) => pattern.test(file.replaceAll("\\", "/")));
  if (matches.length !== 1) throw new Error(`${code}_${matches.length}`);
  return matches[0];
}

export function importCapturedCorpus() {
  const files = walk(artifactRoot);
  const selected = {
    "capture/trace.zip": findOne(files, /trace\.zip$/, "TRACE_COUNT"),
    "capture/rendered-value.png": findOne(files, /rendered-value\.png$/, "SCREENSHOT_COUNT"),
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
  for (const [relative, source] of Object.entries(selected)) {
    const destination = path.join(fixtureRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  const attachment = readZipEntries(readFileSync(selected["capture/trace.zip"])).find(({ name, bytes }) => name.startsWith("resources/") && bytes.subarray(0, 4).equals(Buffer.from([0, 1, 2, 255])));
  if (!attachment) throw new Error("OPAQUE_ATTACHMENT_MISSING");
  writeFileSync(path.join(fixtureRoot, "capture/attachment.bin"), attachment.bytes);
  const grammar = deriveGrammar();
  const controls = { schema: "playwright-evidence-controls/v1", synthetic: true, members: grammar.members.map(({ id }) => id), corruptArchive: "synthetic-truncated-zip", danglingReference: "resources/synthetic-missing" };
  writeFileSync(path.join(fixtureRoot, "declared-controls.json"), stableJson(controls));
  writeFileSync(path.join(fixtureRoot, "corrupt-trace.zip"), readFileSync(selected["capture/trace.zip"]).subarray(0, 47));
  const manifest = buildCorpusManifest();
  writeFileSync(manifestPath, stableJson(manifest));
  return manifest;
}

export function buildCorpusManifest() {
  const grammar = deriveGrammar();
  const files = walk(fixtureRoot).filter((file) => file !== manifestPath);
  const payloads = files.map((file) => {
    const bytes = readFileSync(file), relative = path.relative(fixtureRoot, file).replaceAll("\\", "/");
    return { path: relative, bytes: bytes.length, digest: sha256(bytes), ...mimeAndMagic(file, bytes), sourceMembers: sourceMembersFor(file, bytes, grammar), referenceEdges: referenceEdgesFor(file, bytes) };
  });
  const controls = payloads.find(({ path: file }) => file === "declared-controls.json");
  if (!controls) throw new Error("DECLARED_CONTROLS_MISSING");
  controls.sourceMembers = grammar.members.map(({ id }) => id);
  const covered = new Set(payloads.flatMap(({ sourceMembers }) => sourceMembers));
  if (grammar.members.some(({ id }) => !covered.has(id))) throw new Error("CORPUS_GRAMMAR_REVERSE_GAP");
  const runtime = JSON.parse(readFileSync(path.join(fixtureRoot, "capture/runtime-receipt.json"), "utf8"));
  const maxDepth = 6, payloadBytes = payloads.reduce((sum, row) => sum + row.bytes, 0), edgeCount = payloads.reduce((sum, row) => sum + row.referenceEdges.length, 0);
  const limits = {
    nestingDepth: { largestRequired: maxDepth, supportedMaximum: maxDepth, firstRefused: maxDepth + 1, unit: "levels" },
    payloadBytes: { largestRequired: payloadBytes, supportedMaximum: Math.ceil(payloadBytes * 1.25), firstRefused: Math.ceil(payloadBytes * 1.25) + 1, unit: "bytes" },
    referenceEdges: { largestRequired: edgeCount, supportedMaximum: Math.ceil(Math.max(1, edgeCount) * 1.25), firstRefused: Math.ceil(Math.max(1, edgeCount) * 1.25) + 1, unit: "count" },
    runtimeMs: { largestRequired: Math.ceil(runtime.events.at(-1).monotonicMs - runtime.events[0].monotonicMs), supportedMaximum: Math.ceil((runtime.events.at(-1).monotonicMs - runtime.events[0].monotonicMs) * 1.25), firstRefused: Math.ceil((runtime.events.at(-1).monotonicMs - runtime.events[0].monotonicMs) * 1.25) + 1, unit: "milliseconds" },
  };
  return { schema: "playwright-evidence-corpus/v1", playwrightVersion: "1.60.0", capturedAt: runtime.capturedAt, grammarDigest: sha256(stableJson(grammar)), payloads, limits };
}

export function checkCorpus() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateCorpusManifest(manifest);
  const fresh = buildCorpusManifest();
  assertCorpusMatches(manifest, fresh);
  const expected = new Set(manifest.payloads.map(({ path: file }) => file));
  const actual = new Set(walk(fixtureRoot).filter((file) => file !== manifestPath).map((file) => path.relative(fixtureRoot, file).replaceAll("\\", "/")));
  if (expected.size !== actual.size || [...expected].some((file) => !actual.has(file))) throw new Error("CORPUS_PAYLOAD_SET_OPEN");
  return manifest;
}

export function validateCorpusManifest(manifest) {
  exactKeys(manifest, ["schema", "playwrightVersion", "capturedAt", "grammarDigest", "payloads", "limits"], "corpus");
  if (!timezoneInstant(manifest.capturedAt) || manifest.playwrightVersion !== "1.60.0" || !/^[a-f0-9]{64}$/.test(manifest.grammarDigest)) throw new Error("CORPUS_PROVENANCE_INVALID");
  for (const payload of manifest.payloads) {
    exactKeys(payload, ["path", "bytes", "digest", "mime", "magic", "sourceMembers", "referenceEdges"], "payload");
    if (!Number.isSafeInteger(payload.bytes) || payload.bytes < 0 || !/^[a-f0-9]{64}$/.test(payload.digest)) throw new Error("PAYLOAD_BOUNDS_INVALID");
    for (const edge of payload.referenceEdges) { exactKeys(edge, ["from", "target", "present"], "reference_edge"); if (typeof edge.present !== "boolean") throw new Error("REFERENCE_EDGE_INVALID"); }
  }
  const paths = manifest.payloads.map(({ path: file }) => file);
  if (new Set(paths.map((file) => file.toLowerCase())).size !== paths.length || paths.some((file) => path.posix.isAbsolute(file) || file.split("/").includes(".."))) throw new Error("PAYLOAD_PATH_SET_INVALID");
  exactKeys(manifest.limits, ["nestingDepth", "payloadBytes", "referenceEdges", "runtimeMs"], "limits");
  for (const limit of Object.values(manifest.limits)) {
    exactKeys(limit, ["largestRequired", "supportedMaximum", "firstRefused", "unit"], "limit");
    if (![limit.largestRequired, limit.supportedMaximum, limit.firstRefused].every(Number.isSafeInteger) || limit.largestRequired < 0 || limit.supportedMaximum < limit.largestRequired || limit.firstRefused !== limit.supportedMaximum + 1) throw new Error("LIMIT_BOUNDS_INVALID");
  }
  return manifest;
}

export function assertCorpusMatches(candidate, fresh = buildCorpusManifest()) {
  validateCorpusManifest(candidate);
  if (stableJson(fresh) !== stableJson(candidate)) throw new Error("CORPUS_STALE_MISSING_DUPLICATE_OR_MALFORMED");
  return candidate;
}

export function reconcileGrammarCorpus(grammar, manifest) {
  const covered = new Set(manifest.payloads.flatMap(({ sourceMembers }) => sourceMembers));
  const grammarIds = new Set(grammar.members.map(({ id }) => id));
  if (grammar.members.some(({ id }) => !covered.has(id)) || manifest.payloads.some(({ sourceMembers }) => sourceMembers.some((id) => !grammarIds.has(id)))) throw new Error("GRAMMAR_CORPUS_RECONCILIATION_FAILED");
  return true;
}

export function proportionality() {
  const tracked = git(["ls-files", "--cached"]).split(/\r?\n/).filter(Boolean);
  const denominator = Object.entries(protectedSurface).map(([file, expectedLines]) => {
    if (!tracked.includes(file)) throw new Error("PROTECTED_SURFACE_MISSING");
    const lines = lineCount(readFileSync(path.join(repoRoot, file)));
    if (lines !== expectedLines) throw new Error("PROTECTED_SURFACE_DRIFT");
    return { file, lines };
  });
  const releaseFile = "scripts/playwright-evidence-authority/release.json";
  const authorityFiles = [...new Set([...tracked.filter((file) => file.startsWith("scripts/playwright-evidence-authority/") || file.startsWith("scripts/fixtures/playwright-evidence-authority/")), releaseFile])].sort();
  const lines = (file) => isText(file) ? file === releaseFile && !existsSync(path.join(repoRoot, file)) ? 1 : lineCount(readFileSync(path.join(repoRoot, file))) : 0;
  const testLines = authorityFiles.filter((file) => /\.(?:test\.mjs|spec\.ts)$/.test(file)).reduce((sum, file) => sum + lines(file), 0);
  const fixtureLines = authorityFiles.filter((file) => isText(file) && (file.startsWith("scripts/fixtures/") || file.endsWith(".json"))).reduce((sum, file) => sum + lines(file), 0);
  const executableLines = authorityFiles.reduce((sum, file) => sum + lines(file), 0) - testLines - fixtureLines;
  const measured = executableLines + testLines + fixtureLines;
  const binaryFixtureBytes = authorityFiles.filter((file) => !isText(file)).reduce((sum, file) => sum + statSync(path.join(repoRoot, file)).size, 0);
  const receipt = { denominatorFiles: denominator, denominatorLines: 1706, authorityFiles, executableLines, testLines, fixtureLines, measuredLines: measured, binaryFixtureBytes };
  return assertProportionality(receipt);
}

export function assertProportionality(receipt) {
  exactKeys(receipt, ["denominatorFiles", "denominatorLines", "authorityFiles", "executableLines", "testLines", "fixtureLines", "measuredLines", "binaryFixtureBytes"], "proportionality");
  for (const row of receipt.denominatorFiles) exactKeys(row, ["file", "lines"], "denominator_file");
  if (receipt.denominatorLines !== 1706 || receipt.denominatorFiles.length !== 7 || receipt.denominatorFiles.reduce((sum, row) => sum + row.lines, 0) !== 1706 || receipt.measuredLines !== receipt.executableLines + receipt.testLines + receipt.fixtureLines || receipt.measuredLines > receipt.denominatorLines) throw Object.assign(new Error("AUTHORITY_EXCEEDS_OR_INVALID_PROTECTED_SURFACE"), { receipt });
  return receipt;
}

function lineCount(bytes) {
  if (!bytes.length) return 0;
  const text = bytes.toString("utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
function isText(file) { return /\.(?:mjs|ts|json|jsonl|html|md)$/.test(file); }

export function binaryPolicy(manifest = checkCorpus()) {
  const bySuffix = (suffix) => manifest.payloads.find(({ path: file }) => file.endsWith(suffix));
  const opaque = bySuffix("opaque-body.bin"), opaqueBytes = readFileSync(path.join(fixtureRoot, opaque.path));
  const registeredValue = opaqueBytes.toString("utf8").match(/SYNTHETIC_REGISTERED_PROBE_VALUE_[a-f0-9]{20}/)?.[0];
  if (!registeredValue) throw new Error("REGISTERED_VALUE_NOT_RECOVERABLE_FROM_CAPTURE");
  const observed = (payload) => recoverRegisteredValue({ registeredValue, payloads: [readFileSync(path.join(fixtureRoot, payload.path))] }).status;
  const row = (payload, recoverability = observed(payload), referenceEdges = payload?.referenceEdges ?? []) => ({ bytes: payload?.bytes ?? 0, mime: payload?.mime ?? "application/octet-stream", magic: payload?.magic ?? "", digest: payload?.digest ?? sha256("unknown"), referenceEdges, recoverability });
  return {
    schema: "binary-policy/v1",
    rows: {
      woff2: row(bySuffix("font.woff2")),
      "opaque-body": row(bySuffix("opaque-body.bin")),
      attachment: row(bySuffix("attachment.bin")),
      screenshot: row(bySuffix("rendered-value.png")),
      "video-screencast": row(bySuffix("video.webm"), observed(bySuffix("video.webm")), bySuffix("trace.zip")?.referenceEdges ?? []),
      "rendered-value": row(bySuffix("rendered-value.png")),
      "unknown-dangling-reference": row(bySuffix("declared-controls.json"), "INDETERMINATE", [{ from: "synthetic-control", target: "resources/synthetic-missing", present: false }]),
    },
  };
}

export function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_NOT_OBJECT`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}_SCHEMA_OPEN_OR_INCOMPLETE`);
}

export function validateRuntimeWitness(receipt) {
  exactKeys(receipt, ["schema", "capturedAt", "retry", "events", "reporterStates"], "runtime");
  if (!timezoneInstant(receipt.capturedAt) || receipt.retry !== 1 || !Array.isArray(receipt.events) || receipt.events.map(({ kind }) => kind).join(",") !== "request,mint,register,response,teardown") throw new Error("RUNTIME_ORDER_INVALID");
  let previous = -1;
  for (const event of receipt.events) {
    exactKeys(event, ["kind", "monotonicMs", "digest"], "runtime_event");
    if (!Number.isFinite(event.monotonicMs) || event.monotonicMs <= previous || event.digest !== sha256(`${event.kind}:${event.monotonicMs}`)) throw new Error("RUNTIME_EVENT_INVALID");
    previous = event.monotonicMs;
  }
  const expectedClassifications = ["ordinary-pass", "ordinary-fail", "skip", "expected-failure", "unexpected-pass", "retry-pass", "timed-out", "interrupted"];
  if (receipt.reporterStates.map(({ classification }) => classification).join(",") !== expectedClassifications.join(",")) throw new Error("REPORTER_STATE_INVENTORY_INVALID");
  for (const state of receipt.reporterStates) {
    exactKeys(state, ["classification", "status", "expectedStatus", "annotations"], "reporter_state");
    for (const annotation of state.annotations) exactKeys(annotation, ["type", "description"], "annotation");
  }
  return receipt;
}

function timezoneInstant(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)); }

export function buildRelease({ review = { status: "PENDING", receipt: null } } = {}) {
  const grammar = checkGrammar(), corpus = checkCorpus(), policy = binaryPolicy(corpus), proportion = proportionality();
  const runtime = validateRuntimeWitness(JSON.parse(readFileSync(path.join(fixtureRoot, "capture/runtime-receipt.json"), "utf8")));
  const authorityFiles = proportion.authorityFiles.filter((file) => !file.endsWith("release.json"));
  const digests = Object.fromEntries(authorityFiles.map((file) => [file, sha256(readFileSync(path.join(repoRoot, file)))]));
  const derivationHead = existsSync(releasePath) ? JSON.parse(readFileSync(releasePath, "utf8")).headBinding.derivationHead : git(["rev-parse", "HEAD"]);
  const release = {
    schema: "playwright-evidence-release/v1", playwrightVersion: "1.60.0", releasedAt: runtime.capturedAt,
    headBinding: { mode: "checked-out-git-head", derivationHead },
    digests: { grammar: sha256(stableJson(grammar)), corpus: sha256(stableJson(corpus)), oracle: sha256(readFileSync(path.join(authorityRoot, "recovery-oracle.mjs"))), protocol: sha256(readFileSync(path.join(authorityRoot, "transaction.mjs"))), files: digests },
    decisions: [{ id: "5307013162", ruling: "A" }, { id: "5308182286", ruling: "A" }, { id: "5308183737", ruling: "A" }, { id: "5305457791", ruling: "A" }],
    proportionality: proportion, runtimeWitnessDigest: sha256(stableJson(runtime)), binaryPolicy: policy,
    independentReview: review,
  };
  return { ...release, receiptDigest: sha256(stableJson(release)) };
}

export function validateRelease(release, { expectedHead, requireIndependentPass = false } = {}) {
  exactKeys(release, ["schema", "playwrightVersion", "releasedAt", "headBinding", "digests", "decisions", "proportionality", "runtimeWitnessDigest", "binaryPolicy", "independentReview", "receiptDigest"], "release");
  exactKeys(release.headBinding, ["mode", "derivationHead"], "head_binding");
  exactKeys(release.independentReview, ["status", "receipt"], "independent_review");
  exactKeys(release.digests, ["grammar", "corpus", "oracle", "protocol", "files"], "release_digests");
  if (release.schema !== "playwright-evidence-release/v1" || release.playwrightVersion !== "1.60.0" || ![release.digests.grammar, release.digests.corpus, release.digests.oracle, release.digests.protocol, release.runtimeWitnessDigest, ...Object.values(release.digests.files)].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("RELEASE_DIGEST_SHAPE_INVALID");
  assertProportionality(release.proportionality);
  if (!Array.isArray(release.decisions) || release.decisions.length !== 4) throw new Error("DECISION_INVENTORY_INVALID");
  for (const decision of release.decisions) { exactKeys(decision, ["id", "ruling"], "decision"); if (decision.ruling !== "A") throw new Error("DECISION_RULING_INVALID"); }
  if (release.decisions.map(({ id }) => id).sort().join(",") !== ["5305457791", "5307013162", "5308182286", "5308183737"].join(",")) throw new Error("DECISION_INVENTORY_INVALID");
  if (!timezoneInstant(release.releasedAt) || !/^[a-f0-9]{40}$/.test(release.headBinding.derivationHead) || release.headBinding.mode !== "checked-out-git-head") throw new Error("RELEASE_HEAD_BINDING_INVALID");
  if (expectedHead !== undefined && (expectedHead === "[AUTHORITY_HEAD]" || !/^[a-f0-9]{40}$/.test(expectedHead) || expectedHead !== git(["rev-parse", "HEAD"]))) throw new Error("EXPECTED_HEAD_REFUSED");
  if (requireIndependentPass && release.independentReview.status !== "PASS") throw new Error("INDEPENDENT_REVIEW_NOT_PASS");
  if (release.independentReview.status === "PENDING" && release.independentReview.receipt !== null) throw new Error("PENDING_REVIEW_RECEIPT_INVALID");
  if (release.independentReview.status === "PASS") {
    exactKeys(release.independentReview.receipt, ["exactHead", "reviewedAt", "url", "digest"], "independent_review_receipt");
    if (!/^[a-f0-9]{40}$/.test(release.independentReview.receipt.exactHead) || !timezoneInstant(release.independentReview.receipt.reviewedAt) || !/^[a-f0-9]{64}$/.test(release.independentReview.receipt.digest)) throw new Error("INDEPENDENT_REVIEW_RECEIPT_INVALID");
  }
  const { receiptDigest, ...unsigned } = release;
  if (receiptDigest !== sha256(stableJson(unsigned))) throw new Error("RELEASE_DIGEST_INVALID");
  const rows = release.binaryPolicy.rows;
  exactKeys(release.binaryPolicy, ["schema", "rows"], "binary_policy");
  if (JSON.stringify(Object.keys(rows).sort()) !== JSON.stringify(["attachment", "opaque-body", "rendered-value", "screenshot", "unknown-dangling-reference", "video-screencast", "woff2"])) throw new Error("BINARY_POLICY_ROWS_INVALID");
  for (const [id, row] of Object.entries(rows)) {
    exactKeys(row, ["bytes", "mime", "magic", "digest", "referenceEdges", "recoverability"], `binary_${id}`);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.digest) || !["HIT", "CLEAR", "INDETERMINATE"].includes(row.recoverability)) throw new Error("BINARY_POLICY_VALUE_INVALID");
    for (const edge of row.referenceEdges) exactKeys(edge, ["from", "target", "present"], "binary_reference_edge");
  }
  return release;
}

export function checkRelease({ expectedHead, requireIndependentPass = false } = {}) {
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  validateRelease(release, { expectedHead, requireIndependentPass });
  const fresh = buildRelease({ review: release.independentReview });
  if (stableJson(fresh) !== stableJson(release)) throw new Error("RELEASE_STALE");
  return release;
}
