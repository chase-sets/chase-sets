import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_RECORD_REFUSAL_CODES,
  CANONICAL_RECORD_SHAPES,
  CanonicalRecordError,
  emitRecord,
  emitRecordArray,
  sha256,
} from "./canonical-record.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const EMITTER_PATH = resolve(import.meta.dirname, "canonical-record.mjs");
const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/canonical-record-v1.json");
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const AUTHORIZED_IMPORTERS = Object.freeze(["scripts/canonical-record.test.mjs"]);
const CANONICAL_PATHS = Object.freeze([
  "scripts/canonical-record.mjs",
  "scripts/canonical-record.test.mjs",
  "scripts/fixtures/canonical-record-v1.json",
]);
const VECTOR_IDENTITIES = Object.freeze(
  [
    ["V1-empty-object", 2, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
    ["V2-conserved-identity-body-only", 365, "43938cad90af75d9246b21e737b5ad610bbec04bf14f214eff4ddee107d14b66"],
    ["V3-conserved-identity-multipart", 387, "be0ef056ceccb7fbe9e267a8ba116dd8e4c4de81cc94eb8f74e2e09723982eef"],
    ["V4-escape-hostile-strings", 137, "fe7e56697bd1ba5f6c828b7daa6c9054b754eaac95fb7754ee750ea199984256"],
    ["V5-manifest-zero-parts", 226, "94ad35b3c4c358c079e490946f4c3c4f5553117ade0a8e7fd915ffae2a821c4e"],
    ["V6-manifest-one-parts", 566, "d78c2543b04182eca7154e3db3f55907487b68f20b989e04273d7f2d976927ed"],
    ["V7-manifest-two-parts", 907, "3ad5852a51241159b9aac840705e2e9f225aefa393fb6206d167c526a16c9280"],
    ["V8-parts-array-zero", 2, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
    ["V9-parts-array-one", 342, "134702b9d7952e00611bab087bfe301c0cf8558bebbe8039d4663266fd6b6de0"],
    ["V10-parts-array-two", 683, "37f181b8414fab6763a44cfc9d3b28122cb952bad907ddddd1ff6180015d59fe"],
  ].map(([id, utf8Bytes, digest]) => ({ id, utf8Bytes, sha256: digest })),
);

const IMPORTER_REFUSALS = Object.freeze([
  "IMPORTER_DATA_MODULE",
  "IMPORTER_CWD_DEPENDENT_REQUIRE",
  "IMPORTER_SYNTAX_INDETERMINATE",
  "IMPORTER_RESOLUTION_INDETERMINATE",
  "IMPORTER_PACKAGE_SCOPE_INDETERMINATE",
  "IMPORTER_CAPABILITY_INDETERMINATE",
  "IMPORTER_TRACKED_SYMLINK",
  "IMPORTER_READ_FAILURE",
  "IMPORTER_SCAN_FAILURE",
]);
const RUNTIME_ESM_VERDICTS = new Set(["RUNTIME_ESM_IMPORT", "RUNTIME_ESM_EXPORT", "RUNTIME_ESM_DYNAMIC"]);
const REGULAR_MODES = new Set(["100644", "100755"]);
const RECOGNIZED_NOT_LOADABLE = new Set([
  "ERR_INVALID_MODULE_SPECIFIER",
  "ERR_INVALID_FILE_URL_PATH",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_IMPORT_ATTRIBUTE_MISSING",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_INVALID_PACKAGE_TARGET",
  "ERR_INVALID_PACKAGE_CONFIG",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_ARG_TYPE",
  "SYNTAX_ERROR",
]);
const SHARD_BUDGET_MS = 4_500;
const CAPABILITY_SHARDS = 4;
const CENSUS_SHARDS = 8;

class ImporterAuthorityError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

function importerRefuse(code, detail) {
  throw new ImporterAuthorityError(code, detail);
}

function expectRefusal(code, action) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function emitVector(vector, value = vector.value, fields = vector.fields) {
  return vector.entryPoint === "emitRecord" ? emitRecord(value, fields) : emitRecordArray(value, fields);
}

function reverseRecords(value) {
  if (Array.isArray(value)) return value.map(reverseRecords);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseRecords(entry)]),
    );
  }
  return value;
}

function assertUniqueSetEqual(actual, expected) {
  expect(new Set(actual).size, "actual inventory must be duplicate-free").toBe(actual.length);
  expect(new Set(expected).size, "declared inventory must be duplicate-free").toBe(expected.length);
  expect(new Set(actual)).toEqual(new Set(expected));
}

function withTempDirectory(prefix, action) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseGitIndex(output = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: ROOT })) {
  const entries = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/u.exec(row);
      if (!match) importerRefuse("IMPORTER_CAPABILITY_INDETERMINATE", `malformed Git index row ${JSON.stringify(row)}`);
      const [, mode, objectId, stage, path] = match;
      return { mode, objectId, stage: Number(stage), path: path.replaceAll("\\", "/") };
    });
  if (entries.some(({ stage }) => stage !== 0)) {
    importerRefuse("IMPORTER_CAPABILITY_INDETERMINATE", "unmerged Git index entry");
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function extensionToken(path) {
  return extname(path).toLowerCase() || "<none>";
}

function packageScopeFor(absoluteFile, readPackage = (path) => readFileSync(path, "utf8"), cache = new Map()) {
  let directory = dirname(absoluteFile);
  const normalizedRoot = process.platform === "win32" ? ROOT.toLowerCase() : ROOT;
  while ((process.platform === "win32" ? directory.toLowerCase() : directory).startsWith(normalizedRoot)) {
    if (cache.has(directory)) return cache.get(directory);
    const packagePath = join(directory, "package.json");
    try {
      const source = readPackage(packagePath);
      const value = JSON.parse(source);
      const result = { path: relative(ROOT, packagePath).replaceAll(sep, "/"), type: value.type ?? "commonjs" };
      if (result.type !== "module" && result.type !== "commonjs") {
        importerRefuse("IMPORTER_PACKAGE_SCOPE_INDETERMINATE", result.path);
      }
      cache.set(directory, result);
      return result;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof ImporterAuthorityError) throw error;
        importerRefuse("IMPORTER_PACKAGE_SCOPE_INDETERMINATE", `${packagePath}: ${error.message}`);
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  importerRefuse("IMPORTER_PACKAGE_SCOPE_INDETERMINATE", absoluteFile);
}

const gitEntries = parseGitIndex();
const regularEntries = gitEntries.filter(({ mode }) => REGULAR_MODES.has(mode));
const scopeCache = new Map();
const governedEntries = regularEntries.map((entry) => {
  const scope = packageScopeFor(resolve(ROOT, entry.path), undefined, scopeCache);
  return { ...entry, extension: extensionToken(entry.path), scopePath: scope.path, scopeType: scope.type };
});
const capabilityGroups = [
  ...new Map(governedEntries.map((entry) => [`${entry.extension}\0${entry.scopeType}`, entry])).values(),
]
  .map(({ extension, scopeType }) => ({ extension, scopeType }))
  .sort((left, right) => `${left.extension}:${left.scopeType}`.localeCompare(`${right.extension}:${right.scopeType}`));
const capabilityResults = new Map();
const capabilityTimings = [];
const censusTimings = [];
const censusRows = [];
const discoveredImporters = new Set();

function recognizedErrorCode(result) {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  for (const code of RECOGNIZED_NOT_LOADABLE) if (text.includes(code)) return code;
  if (/SyntaxError|Unexpected token|not valid JSON/iu.test(text)) return "SYNTAX_ERROR";
  return undefined;
}

function runNode(file, timeout = SHARD_BUDGET_MS) {
  const result = spawnSync(process.execPath, [file], { cwd: dirname(file), encoding: "utf8", timeout });
  if (result.error || result.signal || result.status === null) {
    importerRefuse(
      "IMPORTER_CAPABILITY_INDETERMINATE",
      result.error?.message ?? result.signal ?? "missing exit status",
    );
  }
  if (result.stdout.includes("CANONICAL_CAPABILITY_REACHED")) return { verdict: "REACHED" };
  const code = recognizedErrorCode(result);
  if (result.status !== 0 && code) return { verdict: "NOT_LOADABLE", code };
  importerRefuse(
    "IMPORTER_CAPABILITY_INDETERMINATE",
    `exit=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
  );
}

function probeCapability(group, options = {}) {
  if (options.forceUnknown)
    importerRefuse("IMPORTER_CAPABILITY_INDETERMINATE", `${group.extension}/${group.scopeType}`);
  return withTempDirectory("chase-canonical-capability-", (directory) => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: group.scopeType }));
    const candidateName = group.extension === "<none>" ? "candidate" : `candidate${group.extension}`;
    const candidate = join(directory, candidateName);
    writeFileSync(candidate, 'process.stdout.write("CANONICAL_CAPABILITY_REACHED");\n');
    const esmEntry = join(directory, "entry.mjs");
    const cjsEntry = join(directory, "entry.cjs");
    writeFileSync(esmEntry, `import ${JSON.stringify(`./${candidateName}`)};\n`);
    writeFileSync(cjsEntry, `require(${JSON.stringify(`./${candidateName}`)});\n`);
    const positions = {
      esmDirectEntry: runNode(candidate),
      esmDependency: runNode(esmEntry),
      commonJsDirectEntry: runNode(candidate),
      commonJsDependency: runNode(cjsEntry),
    };
    return { verdict: capabilityVerdict(positions), positions };
  });
}

function capabilityVerdict(positions, governedPositions = Object.keys(positions)) {
  const values = governedPositions.map((position) => positions[position]);
  if (values.length === 0 || values.some((value) => value === undefined)) {
    importerRefuse("IMPORTER_CAPABILITY_INDETERMINATE", JSON.stringify({ governedPositions, positions }));
  }
  if (values.some(({ verdict }) => verdict === "REACHED")) return "CANDIDATE";
  if (values.every(({ verdict }) => verdict === "NOT_LOADABLE")) return "EXCLUDED";
  importerRefuse("IMPORTER_CAPABILITY_INDETERMINATE", JSON.stringify({ governedPositions, positions }));
}

function scriptKindFor(path) {
  switch (extensionToken(path)) {
    case ".ts":
    case ".cts":
    case ".mts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function literalIndex(sourceFile) {
  const byText = new Map();
  const visit = (node, ancestors = []) => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const values = byText.get(node.text) ?? [];
      values.push({ node, ancestors });
      byText.set(node.text, values);
    }
    ts.forEachChild(node, (child) => visit(child, [node, ...ancestors]));
  };
  visit(sourceFile);
  return byText;
}

function classifyCompilerSpan(sourceFile, span, options = {}) {
  if (options.forceIndeterminate) return { verdict: "INDETERMINATE", owner: "InjectedUnknownRuntimePosition" };
  const match = (options.literals?.get(span.fileName) ?? [])
    .filter(({ node }) => node.getStart(sourceFile) <= span.pos && node.end >= span.end)
    .sort(({ node: left }, { node: right }) => left.end - left.pos - (right.end - right.pos))[0];
  if (!match) importerRefuse("IMPORTER_SCAN_FAILURE", `${sourceFile.fileName}:${span.pos}:${span.fileName}`);
  const { ancestors } = match;
  const importDeclaration = ancestors.find(ts.isImportDeclaration);
  if (importDeclaration) {
    return {
      verdict: importDeclaration.importClause?.isTypeOnly ? "ERASED_NON_LOADING" : "RUNTIME_ESM_IMPORT",
      owner: "ImportDeclaration",
    };
  }
  const exportDeclaration = ancestors.find(ts.isExportDeclaration);
  if (exportDeclaration) {
    return {
      verdict: exportDeclaration.isTypeOnly ? "ERASED_NON_LOADING" : "RUNTIME_ESM_EXPORT",
      owner: "ExportDeclaration",
    };
  }
  const importType = ancestors.find(ts.isImportTypeNode);
  if (importType) return { verdict: "ERASED_NON_LOADING", owner: "ImportTypeNode" };
  const externalReference = ancestors.find(ts.isExternalModuleReference);
  if (externalReference) {
    return { verdict: "RUNTIME_UNSUPPORTED_NON_LOADING", owner: "ExternalModuleReference" };
  }
  const call = ancestors.find(ts.isCallExpression);
  if (call) {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword && call.arguments.length === 1) {
      return { verdict: "RUNTIME_ESM_DYNAMIC", owner: "CallExpression.import" };
    }
    if (ts.isIdentifier(call.expression) && call.expression.text === "require" && call.arguments.length === 1) {
      return { verdict: "RUNTIME_CJS_REQUIRE", owner: "CallExpression.require" };
    }
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "require") {
      return { verdict: "KNOWN_NON_MODULE_CALL", owner: "CallExpression.propertyRequire" };
    }
  }
  const literalType = ancestors.find(ts.isLiteralTypeNode);
  if (literalType) return { verdict: "ERASED_NON_LOADING", owner: "LiteralType" };
  return { verdict: "INDETERMINATE", owner: ts.SyntaxKind[ancestors[0]?.kind] ?? "Unknown" };
}

function compilerRows(path, source, options = {}) {
  let preprocessed;
  let sourceFile;
  try {
    if (options.forceScanFailure) throw new Error("injected scan failure");
    preprocessed = ts.preProcessFile(source, true, true);
    sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKindFor(path));
  } catch (error) {
    importerRefuse("IMPORTER_SCAN_FAILURE", `${path}: ${error.message}`);
  }
  const literals = literalIndex(sourceFile);
  return preprocessed.importedFiles.map((span) => {
    const classification = classifyCompilerSpan(sourceFile, span, { ...options, literals });
    if (classification.verdict === "INDETERMINATE") {
      importerRefuse("IMPORTER_SYNTAX_INDETERMINATE", `${path}:${span.pos}:${classification.owner}`);
    }
    return { path, specifier: span.fileName, pos: span.pos, end: span.end, ...classification };
  });
}

function normalizedRealpath(path) {
  const value = realpathSync.native(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

const emitterRealpath = normalizedRealpath(EMITTER_PATH);
const resolutionMemo = new Map();
const esmResolverProgram = String.raw`
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const recognized = new Set(${JSON.stringify([...RECOGNIZED_NOT_LOADABLE])});
const output = [];
for (const row of rows) {
  try {
    const resolved = import.meta.resolve(row.specifier, row.parentUrl);
    const url = new URL(resolved);
    if (url.protocol === "node:") {
      output.push({ status: "OTHER", resolved });
      continue;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      output.push({ status: "NOT_LOADABLE", code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" });
      continue;
    }
    if (url.protocol !== "file:") {
      output.push({ status: "INDETERMINATE", detail: resolved });
      continue;
    }
    url.search = "";
    url.hash = "";
    const path = fileURLToPath(url);
    try {
      output.push({ status: "FILE", path: realpathSync.native(path), resolved });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") output.push({ status: "NOT_LOADABLE", code: error.code });
      else output.push({ status: "INDETERMINATE", detail: String(error?.stack ?? error) });
    }
  } catch (error) {
    const code = error?.code ?? (error instanceof SyntaxError ? "SYNTAX_ERROR" : undefined);
    output.push(recognized.has(code) ? { status: "NOT_LOADABLE", code } : { status: "INDETERMINATE", detail: String(error?.stack ?? error) });
  }
}
process.stdout.write(JSON.stringify(output));
`;

function resolveEsmBatch(requests, options = {}) {
  if (options.forceIndeterminate) {
    return requests.map(() => ({ status: "INDETERMINATE", detail: "injected resolver failure" }));
  }
  const result = spawnSync(
    process.execPath,
    ["--experimental-import-meta-resolve", "--input-type=module", "--eval", esmResolverProgram],
    { input: JSON.stringify(requests), encoding: "utf8", timeout: SHARD_BUDGET_MS },
  );
  if (result.error || result.signal || result.status !== 0) {
    importerRefuse(
      "IMPORTER_RESOLUTION_INDETERMINATE",
      result.error?.message ?? result.signal ?? `exit=${result.status} ${result.stderr}`,
    );
  }
  try {
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== requests.length) throw new Error("resolver cardinality mismatch");
    return values;
  } catch (error) {
    importerRefuse("IMPORTER_RESOLUTION_INDETERMINATE", error.message);
  }
}

function isNativeDrivePath(specifier) {
  return /^[a-z]:[\\/]/iu.test(specifier);
}

function isCwdDependentRequire(specifier, platform = process.platform) {
  return (
    platform === "win32" && (specifier.startsWith("/") || specifier.startsWith("\\")) && !isNativeDrivePath(specifier)
  );
}

function resolveCjs(row, options = {}) {
  if (isCwdDependentRequire(row.specifier, options.cwdPlatform)) {
    if (!options.bypassCwdGuard) importerRefuse("IMPORTER_CWD_DEPENDENT_REQUIRE", `${row.path}:${row.specifier}`);
  }
  if (options.forceIndeterminate) importerRefuse("IMPORTER_RESOLUTION_INDETERMINATE", "injected resolver failure");
  try {
    const target = createRequire(pathToFileURL(resolve(ROOT, row.path))).resolve(row.specifier);
    return { status: "FILE", path: normalizedRealpath(target), resolved: target };
  } catch (error) {
    if (RECOGNIZED_NOT_LOADABLE.has(error?.code) || error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { status: "NOT_LOADABLE", code: error.code };
    }
    importerRefuse("IMPORTER_RESOLUTION_INDETERMINATE", `${row.path}:${row.specifier}:${error.message}`);
  }
}

function classifyResolution(result, row) {
  if (result.status === "INDETERMINATE") {
    importerRefuse("IMPORTER_RESOLUTION_INDETERMINATE", `${row.path}:${row.specifier}:${result.detail}`);
  }
  if (result.status === "NOT_LOADABLE") return "NOT_LOADABLE";
  if (result.status === "OTHER") return "OTHER";
  if (result.status !== "FILE") importerRefuse("IMPORTER_RESOLUTION_INDETERMINATE", JSON.stringify(result));
  const target = process.platform === "win32" ? result.path.toLowerCase() : result.path;
  return target === emitterRealpath ? "TARGET" : "OTHER";
}

function resolveRuntimeRows(rows, options = {}) {
  const resolved = [];
  const esmPending = [];
  for (const row of rows) {
    if (!RUNTIME_ESM_VERDICTS.has(row.verdict) && row.verdict !== "RUNTIME_CJS_REQUIRE") continue;
    if (RUNTIME_ESM_VERDICTS.has(row.verdict) && row.specifier.startsWith("data:")) {
      if (!options.bypassDataGuard) importerRefuse("IMPORTER_DATA_MODULE", `${row.path}:${row.specifier}`);
      resolved.push({ ...row, resolution: "OTHER" });
      continue;
    }
    const key = `${row.verdict === "RUNTIME_CJS_REQUIRE" ? "CJS" : "ESM"}\0${row.path}\0${row.specifier}`;
    if (!options.disableMemo && resolutionMemo.has(key)) {
      resolved.push({ ...row, resolution: resolutionMemo.get(key) });
      continue;
    }
    if (row.verdict === "RUNTIME_CJS_REQUIRE") {
      const resolution = classifyResolution(resolveCjs(row, options), row);
      if (!options.disableMemo) resolutionMemo.set(key, resolution);
      resolved.push({ ...row, resolution });
    } else {
      esmPending.push({ row, key, parentUrl: pathToFileURL(resolve(ROOT, row.path)).href });
    }
  }
  if (esmPending.length > 0) {
    const uniquePending = [...new Map(esmPending.map((pending) => [pending.key, pending])).values()];
    const batchResolutions = new Map();
    const batch = resolveEsmBatch(
      uniquePending.map(({ row, parentUrl }) => ({ specifier: row.specifier, parentUrl })),
      options,
    );
    batch.forEach((result, index) => {
      const { row, key } = uniquePending[index];
      const resolution = classifyResolution(result, row);
      batchResolutions.set(key, resolution);
      if (!options.disableMemo) resolutionMemo.set(key, resolution);
    });
    for (const { row, key } of esmPending) resolved.push({ ...row, resolution: batchResolutions.get(key) });
  }
  return resolved;
}

function scanEntry(entry, options = {}) {
  if (entry.mode === "120000" && !options.bypassSymlinkMode) {
    importerRefuse("IMPORTER_TRACKED_SYMLINK", entry.path);
  }
  if (!REGULAR_MODES.has(entry.mode) && !(entry.mode === "120000" && options.bypassSymlinkMode)) {
    importerRefuse("IMPORTER_CAPABILITY_INDETERMINATE", `${entry.mode}:${entry.path}`);
  }
  let source;
  try {
    if (options.forceReadFailure) throw new Error("injected read failure");
    source = (options.readFile ?? readFileSync)(options.absolutePath ?? resolve(ROOT, entry.path), "utf8");
  } catch (error) {
    importerRefuse("IMPORTER_READ_FAILURE", `${entry.path}: ${error.message}`);
  }
  return compilerRows(entry.path, source, options);
}

function sourceForChannel(channel, specifier) {
  const quoted = JSON.stringify(specifier);
  switch (channel) {
    case "static":
      return `import { emitRecord as candidate } from ${quoted};\nprocess.stdout.write(typeof candidate === "function" ? "TARGET" : "OTHER");\n`;
    case "dynamic":
      return `const { emitRecord: candidate } = await import(${quoted});\nprocess.stdout.write(typeof candidate === "function" ? "TARGET" : "OTHER");\n`;
    case "export":
      return `export { emitRecord } from ${quoted};\n`;
    case "require":
      return `const { emitRecord: candidate } = require(${quoted});\nprocess.stdout.write(typeof candidate === "function" ? "TARGET" : "OTHER");\n`;
    default:
      throw new Error(`unknown channel ${channel}`);
  }
}

function actualLoad(directory, channel, specifier) {
  const extension = channel === "require" ? ".cjs" : ".mjs";
  const importer = join(directory, `importer-${channel}${extension}`);
  writeFileSync(importer, sourceForChannel(channel, specifier));
  let entry = importer;
  if (channel === "export") {
    entry = join(directory, "export-entry.mjs");
    writeFileSync(
      entry,
      `import { emitRecord as candidate } from ${JSON.stringify(pathToFileURL(importer).href)};\nprocess.stdout.write(typeof candidate === "function" ? "TARGET" : "OTHER");\n`,
    );
  }
  const result = spawnSync(process.execPath, [entry], { cwd: directory, encoding: "utf8", timeout: SHARD_BUDGET_MS });
  if (result.error || result.signal || result.status === null) {
    importerRefuse("IMPORTER_RESOLUTION_INDETERMINATE", result.error?.message ?? result.signal ?? "missing status");
  }
  if (result.status === 0 && (result.stdout === "TARGET" || result.stdout === "OTHER")) return result.stdout;
  const code = recognizedErrorCode(result);
  if (result.status !== 0 && code) return "NOT_LOADABLE";
  importerRefuse("IMPORTER_RESOLUTION_INDETERMINATE", `actual load exit=${result.status}: ${result.stderr}`);
}

function classifiedLoad(importer, channel, specifier, options = {}) {
  try {
    const rows = compilerRows(importer, options.source ?? sourceForChannel(channel, specifier), options);
    const runtimeRows = rows.filter(
      ({ verdict }) => RUNTIME_ESM_VERDICTS.has(verdict) || verdict === "RUNTIME_CJS_REQUIRE",
    );
    const resolved = resolveRuntimeRows(runtimeRows, { ...options, disableMemo: true });
    return {
      verdict: resolved.some(({ resolution }) => resolution === "TARGET") ? "TARGET" : "NON_TARGET",
      rows: resolved,
    };
  } catch (error) {
    if (error instanceof ImporterAuthorityError) return { verdict: "REFUSAL", code: error.code };
    throw error;
  }
}

function createFileSymlink(target, link) {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "file");
}

const loaderPathForms = Object.freeze([
  "relative",
  "query",
  "data-module",
  "fragment",
  "query-fragment",
  "safe-percent-encoding",
  "dot-walk",
  "file-url",
  "file-url-query",
  "file-url-fragment",
  "rooted",
  "native-drive",
  "raw-backslash",
  "encoded-slash",
  "encoded-backslash",
  "different-file",
  "vendor-lookalike",
  "extensionless",
  "directory-index",
  "node-builtin",
  "https-url",
  "missing",
]);
const loaderChannels = Object.freeze(["static", "dynamic", "export", "require"]);
const loaderMatrixRows = loaderPathForms.flatMap((form) => loaderChannels.map((channel) => ({ form, channel })));
const loaderMatrixEvidence = [];

function specifierForPathForm(form, channel, directory, targetLink) {
  const targetUrl = pathToFileURL(targetLink).href;
  const slashRelative = "./target.mjs";
  switch (form) {
    case "relative":
      return slashRelative;
    case "query":
      return `${slashRelative}?query`;
    case "data-module":
      return `data:text/javascript,export%20%7B%20emitRecord%20%7D%20from%20${encodeURIComponent(JSON.stringify(pathToFileURL(EMITTER_PATH).href))}`;
    case "fragment":
      return `${slashRelative}#fragment`;
    case "query-fragment":
      return `${slashRelative}?query#fragment`;
    case "safe-percent-encoding":
      return "./target%2Emjs";
    case "dot-walk":
      mkdirSync(join(directory, "nested"), { recursive: true });
      return "./nested/../target.mjs";
    case "file-url":
      return targetUrl;
    case "file-url-query":
      return `${targetUrl}?query`;
    case "file-url-fragment":
      return `${targetUrl}#fragment`;
    case "rooted":
      return pathToFileURL(targetLink).pathname;
    case "native-drive":
      return targetLink;
    case "raw-backslash":
      return ".\\target.mjs";
    case "encoded-slash":
      return "./nested%2Ftarget.mjs";
    case "encoded-backslash":
      return "./nested%5Ctarget.mjs";
    case "different-file":
      return "./benign.mjs";
    case "vendor-lookalike":
      return "./vendor/canonical-record.mjs";
    case "extensionless":
      return "./target";
    case "directory-index":
      return "./target-directory";
    case "node-builtin":
      return "node:fs";
    case "https-url":
      return "https://example.invalid/canonical-record.mjs";
    case "missing":
      return "./missing.mjs";
    default:
      throw new Error(`unknown form ${form}/${channel}`);
  }
}

function executePathFormRow({ form, channel }) {
  return withTempDirectory("chase-canonical-path-form-", (directory) => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(directory, "benign.mjs"), 'export const emitRecord = "benign";\n');
    mkdirSync(join(directory, "vendor"), { recursive: true });
    writeFileSync(join(directory, "vendor", "canonical-record.mjs"), 'export const emitRecord = "benign";\n');
    const targetLink = join(directory, "target.mjs");
    createFileSymlink(EMITTER_PATH, targetLink);
    createFileSymlink(EMITTER_PATH, join(directory, "target"));
    mkdirSync(join(directory, "target-directory"), { recursive: true });
    createFileSymlink(EMITTER_PATH, join(directory, "target-directory", "index.mjs"));
    const specifier = specifierForPathForm(form, channel, directory, targetLink);
    const importer = join(directory, `classifier-${channel}.${channel === "require" ? "cjs" : "mjs"}`);
    const actual = actualLoad(directory, channel, specifier);
    const classified = classifiedLoad(importer, channel, specifier);
    const expectedRefusal =
      channel === "require" && isCwdDependentRequire(specifier)
        ? "IMPORTER_CWD_DEPENDENT_REQUIRE"
        : form === "data-module" && channel !== "require"
          ? "IMPORTER_DATA_MODULE"
          : undefined;
    if (expectedRefusal) expect(classified).toMatchObject({ verdict: "REFUSAL", code: expectedRefusal });
    else if (actual === "TARGET") expect(classified.verdict).toBe("TARGET");
    else expect(classified.verdict).not.toBe("TARGET");
    return { form, channel, specifier, actual, classified: classified.verdict, code: classified.code ?? null };
  });
}

const aliasRows = ["internal", "external"].flatMap((aliasKind) =>
  loaderChannels.flatMap((channel) => ["target", "other", "missing"].map((state) => ({ aliasKind, channel, state }))),
);
const aliasEvidence = [];

function executeAliasRow({ aliasKind, channel, state }) {
  return withTempDirectory(`chase-canonical-alias-${state}-`, (directory) => {
    const packageValue = {
      type: "module",
      imports: { "#emitter": { import: "./internal-link.mjs", require: "./internal-link.mjs" } },
    };
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageValue));
    const externalRoot = join(directory, "node_modules", "@canonical", "emitter");
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(
      join(externalRoot, "package.json"),
      JSON.stringify({
        name: "@canonical/emitter",
        type: "module",
        exports: { import: "./external-link.mjs", require: "./external-link.mjs" },
      }),
    );
    const benign = join(directory, "benign.mjs");
    writeFileSync(benign, 'export const emitRecord = "benign";\n');
    const target = state === "target" ? EMITTER_PATH : benign;
    if (state !== "missing") {
      createFileSymlink(target, join(directory, "internal-link.mjs"));
      createFileSymlink(target, join(externalRoot, "external-link.mjs"));
    }
    const specifier = aliasKind === "internal" ? "#emitter" : "@canonical/emitter";
    const importer = join(directory, `classifier-${aliasKind}-${channel}.${channel === "require" ? "cjs" : "mjs"}`);
    const actual = actualLoad(directory, channel, specifier);
    const classified = classifiedLoad(importer, channel, specifier);
    expect(actual).toBe(state === "target" ? "TARGET" : state === "other" ? "OTHER" : "NOT_LOADABLE");
    expect(classified.verdict).toBe(state === "target" ? "TARGET" : "NON_TARGET");
    return { aliasKind, channel, state, actual, classified: classified.verdict };
  });
}

describe.sequential("chase-sets-canonical/v1", () => {
  it("fixture identities are pinned against the published table", () => {
    expect(FIXTURE.vectors.map(({ id, utf8Bytes, sha256: value }) => ({ id, utf8Bytes, sha256: value }))).toEqual(
      VECTOR_IDENTITIES,
    );
    for (const vector of FIXTURE.vectors) {
      const bytes = Buffer.from(vector.canonicalText, "utf8");
      expect(bytes.length).toBe(vector.utf8Bytes);
      expect(digest(bytes)).toBe(vector.sha256);
    }
    const mutation = structuredClone(FIXTURE);
    const vector = mutation.vectors.find(({ id }) => id === "V4-escape-hostile-strings");
    vector.value.plain = "z b/c-d_e.f";
    vector.canonicalText = vector.canonicalText.replace("a b/c-d_e.f", "z b/c-d_e.f");
    vector.sha256 = digest(Buffer.from(vector.canonicalText, "utf8"));
    expect(mutation.vectors.map(({ id, utf8Bytes, sha256: value }) => ({ id, utf8Bytes, sha256: value }))).not.toEqual(
      VECTOR_IDENTITIES,
    );
  });

  it("emitter reproduces every committed golden vector", () => {
    expect(FIXTURE.schemaVersion).toBe("canonical-record-v1");
    expect(FIXTURE.vectors).toHaveLength(10);
    for (const vector of FIXTURE.vectors) {
      const bytes = emitVector(vector);
      expect(bytes).toEqual(Buffer.from(vector.canonicalText, "utf8"));
      expect(bytes.length).toBe(vector.utf8Bytes);
      expect(sha256(bytes)).toBe(vector.sha256);
      expect(emitVector(vector, reverseRecords(vector.value))).toEqual(bytes);
    }
  });

  it("manifest closure and canonical framing hold", () => {
    for (const [manifestId, partsId] of [
      ["V5-manifest-zero-parts", "V8-parts-array-zero"],
      ["V6-manifest-one-parts", "V9-parts-array-one"],
      ["V7-manifest-two-parts", "V10-parts-array-two"],
    ]) {
      const manifest = FIXTURE.vectors.find(({ id }) => id === manifestId);
      const parts = FIXTURE.vectors.find(({ id }) => id === partsId);
      expect(manifest.value.partsDigest).toBe(digest(Buffer.from(parts.canonicalText, "utf8")));
      expect(emitVector(manifest, JSON.parse(manifest.canonicalText))).toEqual(
        Buffer.from(manifest.canonicalText, "utf8"),
      );
    }
    for (const vector of FIXTURE.vectors) {
      const bytes = Buffer.from(vector.canonicalText, "utf8");
      expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(vector.canonicalText).not.toMatch(/^[\s]|[\s]$/u);
      expect(JSON.stringify(JSON.parse(vector.canonicalText))).toBe(vector.canonicalText);
    }
    expect(FIXTURE.vectors.find(({ id }) => id === "V8-parts-array-zero").canonicalText).toBe("[]");
    expect(() => JSON.parse('{"x":1,"x":2}', (key, value) => value)).not.toThrow();
    const duplicateKeyDetector = (text) => {
      const keys = [...text.matchAll(/(?:^|[{,])"([^"\\]+)":/gu)].map((match) => match[1]);
      if (keys.length !== new Set(keys).size) throw new Error("duplicate key");
    };
    expect(() => duplicateKeyDetector('{"x":1,"x":2}')).toThrow("duplicate key");
    for (const mutation of ["\ufeff{}", " {}", "{}\n"]) {
      expect(() => {
        const bytes = Buffer.from(mutation, "utf8");
        if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || /^\s|\s$/u.test(mutation))
          throw new Error();
      }).toThrow();
    }
  });

  it("the recursive domain is closed at every depth", () => {
    const fields = [
      { key: "name", shape: "string" },
      { key: "count", shape: "integer" },
      { key: "numbers", shape: "integerArray" },
      { key: "child", shape: "record", fields: [{ key: "value", shape: "integer" }] },
      { key: "rows", shape: "recordArray", fields: [{ key: "value", shape: "integer" }] },
    ];
    const value = { name: 'a " \\ /', count: 0, numbers: [2, 1], child: { value: 3 }, rows: [{ value: 4 }] };
    const bytes = emitRecord(value, fields);
    expect(emitRecord(reverseRecords(value), fields)).toEqual(bytes);
    const reversedFields = [...fields].reverse();
    expect(emitRecord(value, reversedFields)).not.toEqual(bytes);
    expect(emitRecord({ ...value, numbers: [1, 2] }, fields)).not.toEqual(bytes);
    expect(emitRecord({ name: "null", count: 0, numbers: [], child: { value: 0 }, rows: [] }, fields)).toBeInstanceOf(
      Buffer,
    );
    expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord({ ...value, name: null }, fields));
    expectRefusal("CANONICAL_KEY_SET_MISMATCH", () => emitRecord({ ...value, child: { value: 3, extra: 1 } }, fields));
    expectRefusal("CANONICAL_NUMBER_OUT_OF_DOMAIN", () => emitRecord({ ...value, rows: [{ value: -1 }] }, fields));
    expectRefusal("CANONICAL_STRING_OUT_OF_DOMAIN", () => emitRecord({ ...value, name: "\n" }, fields));
    const schemaCycle = [];
    schemaCycle.push({ key: "self", shape: "record", fields: schemaCycle });
    expectRefusal("CANONICAL_SCHEMA_CYCLIC", () => emitRecord({ self: {} }, schemaCycle));
    const valueCycle = {};
    valueCycle.self = valueCycle;
    expectRefusal("CANONICAL_KEY_SET_MISMATCH", () =>
      emitRecord(valueCycle, [{ key: "self", shape: "record", fields: [{ key: "end", shape: "string" }] }]),
    );
    expect(CANONICAL_RECORD_SHAPES).toEqual(["string", "integer", "integerArray", "record", "recordArray"]);
    expect(CANONICAL_RECORD_REFUSAL_CODES).toHaveLength(7);
    const controls = new Map([
      ["CANONICAL_SCHEMA_INVALID", () => emitRecord({}, {})],
      ["CANONICAL_SCHEMA_CYCLIC", () => emitRecord({ self: {} }, schemaCycle)],
      ["CANONICAL_KEY_SET_MISMATCH", () => emitRecord({ x: 1 }, [])],
      ["CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord([], [])],
      ["CANONICAL_STRING_OUT_OF_DOMAIN", () => emitRecord({ x: "\n" }, [{ key: "x", shape: "string" }])],
      ["CANONICAL_NUMBER_OUT_OF_DOMAIN", () => emitRecord({ x: -1 }, [{ key: "x", shape: "integer" }])],
      ["CANONICAL_DIGEST_INPUT_NOT_BYTES", () => sha256("bytes")],
    ]);
    expect([...controls.keys()].sort()).toEqual([...CANONICAL_RECORD_REFUSAL_CODES].sort());
    for (const [code, action] of controls) expectRefusal(code, action);
    expect(new CanonicalRecordError("CANONICAL_SCHEMA_INVALID").code).toBe("CANONICAL_SCHEMA_INVALID");
  });

  it("proxies refuse before any trap can run", () => {
    const fields = [{ key: "value", shape: "integer" }];
    let traps = 0;
    const handler = new Proxy(
      {},
      {
        get(_target, name) {
          if (typeof name === "string") {
            return () => {
              traps += 1;
              return name === "getPrototypeOf" ? Object.prototype : Reflect[name];
            };
          }
          return undefined;
        },
      },
    );
    const valueProxy = new Proxy({ value: 1 }, handler);
    expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord(valueProxy, fields));
    expect(traps).toBe(0);
    const declarationProxy = new Proxy({ key: "value", shape: "integer" }, handler);
    expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecord({ value: 1 }, [declarationProxy]));
    expect(traps).toBe(0);
    const { proxy: revoked, revoke } = Proxy.revocable([], {});
    revoke();
    expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecordArray(revoked, []));
    expect(emitRecord({ value: 1 }, fields)).toBeInstanceOf(Buffer);
    expect(emitRecord(JSON.parse('{"value":1}'), fields)).toBeInstanceOf(Buffer);
    expect(emitRecord(Object.freeze({ value: 1 }), fields)).toBeInstanceOf(Buffer);
    expect(emitRecord(Object.assign(Object.create(null), { value: 1 }), fields)).toBeInstanceOf(Buffer);
  });

  it("array positions admit only dense data arrays", () => {
    const integerArrayFields = [{ key: "values", shape: "integerArray" }];
    const recordArrayFields = [{ key: "values", shape: "recordArray", fields: [{ key: "n", shape: "integer" }] }];
    const constructors = [
      () => new Array(1),
      (entry) => [entry, , entry],
      (entry, onGet) => Object.defineProperty([entry], "0", { enumerable: true, get: () => onGet(entry) }),
      (entry) => Object.assign([entry], { [Symbol("extra")]: true }),
      (entry) => Object.assign([entry], { extra: true }),
      (entry) => Object.defineProperty([entry], "0", { enumerable: false }),
      (entry) => Object.setPrototypeOf([entry], Object.create(Array.prototype)),
      (entry) => {
        const value = [entry, entry];
        value.length = 5;
        return value;
      },
    ];
    for (const build of constructors) {
      let getters = 0;
      const onGet = (entry) => {
        getters += 1;
        return entry;
      };
      const schema = build({ key: "value", shape: "integer" }, onGet);
      const integers = build(1, onGet);
      const records = build({ n: 1 }, onGet);
      expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecord({}, schema));
      expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecordArray(integers, []));
      expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord({ values: integers }, integerArrayFields));
      expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord({ values: records }, recordArrayFields));
      expect(getters).toBe(0);
    }
    for (const values of [[], [1], JSON.parse("[1,2]"), Object.freeze([1, 2])]) {
      expect(emitRecord({ values }, integerArrayFields)).toBeInstanceOf(Buffer);
    }
    expect(emitRecordArray([], []).toString()).toBe("[]");
    const context = vm.createContext({});
    const crossRealmRecord = vm.runInContext("({ value: 1 })", context);
    const crossRealmArray = vm.runInContext("[1]", context);
    const crossRealmNullRecord = vm.runInContext("Object.assign(Object.create(null), { value: 1 })", context);
    expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () =>
      emitRecord(crossRealmRecord, [{ key: "value", shape: "integer" }]),
    );
    expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord({ values: crossRealmArray }, integerArrayFields));
    expect(emitRecord(crossRealmNullRecord, [{ key: "value", shape: "integer" }])).toBeInstanceOf(Buffer);
  });

  it("the fixture is consumable without the emitter", () => {
    const independent = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    expect(independent.vectors).toHaveLength(10);
    for (const { canonicalText, utf8Bytes, sha256: expected } of independent.vectors) {
      const bytes = Buffer.from(canonicalText, "utf8");
      expect(bytes.length).toBe(utf8Bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
  });
});

describe.sequential("canonical importer authority", () => {
  for (let shard = 0; shard < CAPABILITY_SHARDS; shard += 1) {
    it(`candidate capability covers every governed loader position [shard ${shard + 1}/${CAPABILITY_SHARDS}]`, () => {
      const started = performance.now();
      const groups = capabilityGroups.filter((_group, index) => index % CAPABILITY_SHARDS === shard);
      for (const group of groups)
        capabilityResults.set(`${group.extension}\0${group.scopeType}`, probeCapability(group));
      const elapsedMs = performance.now() - started;
      capabilityTimings.push({ shard: shard + 1, elapsedMs, groups: groups.length });
      expect(elapsedMs).toBeLessThan(SHARD_BUDGET_MS);
    });
  }

  it("candidate capability covers every governed loader position", () => {
    expect(capabilityResults.size).toBe(capabilityGroups.length);
    for (const { extension, scopeType } of capabilityGroups) {
      const result = capabilityResults.get(`${extension}\0${scopeType}`);
      expect(Object.keys(result.positions)).toEqual([
        "esmDirectEntry",
        "esmDependency",
        "commonJsDirectEntry",
        "commonJsDependency",
      ]);
      expect(["CANDIDATE", "EXCLUDED"]).toContain(result.verdict);
    }
    for (const extension of [".tsx", ".css", ".md", ".png"]) {
      const group = capabilityGroups.find((entry) => entry.extension === extension);
      expect(group, `${extension} must exist in the tracked capability surface`).toBeDefined();
      const result = capabilityResults.get(`${group.extension}\0${group.scopeType}`);
      expect(result.positions.esmDirectEntry.verdict).toBe("NOT_LOADABLE");
      expect(result.positions.commonJsDependency.verdict).toBe("REACHED");
      expect(result.verdict).toBe("CANDIDATE");
      expect(capabilityVerdict(result.positions, ["esmDirectEntry"])).toBe("EXCLUDED");
    }
    const jsonGroup = capabilityGroups.find(({ extension }) => extension === ".json");
    expect(capabilityResults.get(`${jsonGroup.extension}\0${jsonGroup.scopeType}`).verdict).toBe("EXCLUDED");
  });

  it("arbitrary-extension plants discriminate four-position capability from a direct-entry-only mutant", () => {
    withTempDirectory("chase-canonical-capability-plants-", (directory) => {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      const plants = [".tsx", ".css", ".md", ".png"].map((extension, index) => {
        const group = capabilityGroups.find((entry) => entry.extension === extension);
        const capability = capabilityResults.get(`${group.extension}\0${group.scopeType}`);
        const plantDirectory = join(directory, `arbitrary-${index}`, "nested");
        mkdirSync(plantDirectory, { recursive: true });
        const path = join(plantDirectory, `runtime-importer${extension}`);
        const specifier = EMITTER_PATH;
        const source = sourceForChannel("require", specifier);
        writeFileSync(path, source);
        return { capability, extension, path, source, specifier };
      });

      const discover = (governedPositions) => {
        const discovered = [];
        for (const plant of plants) {
          if (capabilityVerdict(plant.capability.positions, governedPositions) === "EXCLUDED") continue;
          const classification = classifiedLoad(plant.path, "require", plant.specifier, { source: plant.source });
          expect(classification.verdict, plant.extension).toBe("TARGET");
          discovered.push(plant.path);
        }
        return discovered;
      };

      const fourPositionDiscoveries = discover([
        "esmDirectEntry",
        "esmDependency",
        "commonJsDirectEntry",
        "commonJsDependency",
      ]);
      const directEntryOnlyDiscoveries = discover(["esmDirectEntry"]);
      expect(fourPositionDiscoveries).toEqual(plants.map(({ path }) => path));
      expect([...AUTHORIZED_IMPORTERS, ...fourPositionDiscoveries]).not.toEqual(AUTHORIZED_IMPORTERS);
      expect([...AUTHORIZED_IMPORTERS, ...directEntryOnlyDiscoveries]).toEqual(AUTHORIZED_IMPORTERS);
    });
  });

  const candidateEntries = () =>
    governedEntries.filter(
      ({ extension, scopeType }) => capabilityResults.get(`${extension}\0${scopeType}`)?.verdict === "CANDIDATE",
    );
  const censusShardEntries = Array.from({ length: CENSUS_SHARDS }, () => []);

  it("compiler span joining is initialized before timed corpus shards", () => {
    const rows = compilerRows("warmup.ts", 'import type { X } from "./target.mjs";');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: "ERASED_NON_LOADING", owner: "ImportDeclaration" });
    const buckets = censusShardEntries.map((entries, shard) => ({ entries, shard, weight: 0 }));
    const weighted = candidateEntries()
      .map((entry) => {
        try {
          return { entry, weight: lstatSync(resolve(ROOT, entry.path)).size + 4_096 };
        } catch {
          return { entry, weight: 4_096 };
        }
      })
      .sort((left, right) => right.weight - left.weight || left.entry.path.localeCompare(right.entry.path));
    for (const value of weighted) {
      const bucket = [...buckets].sort((left, right) => left.weight - right.weight || left.shard - right.shard)[0];
      bucket.entries.push(value.entry);
      bucket.weight += value.weight;
    }
    expect(censusShardEntries.flat()).toHaveLength(candidateEntries().length);
  });

  for (let shard = 0; shard < CENSUS_SHARDS; shard += 1) {
    it(`corpus census and memoized resolution stay inside the unchanged timeout [shard ${shard + 1}/${CENSUS_SHARDS}]`, () => {
      const started = performance.now();
      const entries = censusShardEntries[shard];
      const runtimeRows = [];
      for (const entry of entries) {
        const rows = scanEntry(entry);
        censusRows.push(...rows);
        runtimeRows.push(
          ...rows.filter(({ verdict }) => RUNTIME_ESM_VERDICTS.has(verdict) || verdict === "RUNTIME_CJS_REQUIRE"),
        );
      }
      for (const row of resolveRuntimeRows(runtimeRows)) {
        if (row.resolution === "TARGET") discoveredImporters.add(row.path);
      }
      const elapsedMs = performance.now() - started;
      censusTimings.push({
        shard: shard + 1,
        elapsedMs,
        candidates: entries.length,
        runtimeSpecifiers: runtimeRows.length,
      });
      expect(elapsedMs).toBeLessThan(SHARD_BUDGET_MS);
    });
  }

  it("every compiler-reported specifier has one governed runtime verdict", () => {
    const candidates = candidateEntries();
    expect(censusRows.length).toBeGreaterThan(0);
    const verdicts = new Map();
    for (const row of censusRows) verdicts.set(row.verdict, (verdicts.get(row.verdict) ?? 0) + 1);
    const expectedVerdicts = new Set([
      "RUNTIME_ESM_IMPORT",
      "RUNTIME_ESM_EXPORT",
      "RUNTIME_ESM_DYNAMIC",
      "RUNTIME_CJS_REQUIRE",
      "ERASED_NON_LOADING",
      "KNOWN_NON_MODULE_CALL",
      "RUNTIME_UNSUPPORTED_NON_LOADING",
    ]);
    expect([...verdicts.keys()].every((value) => expectedVerdicts.has(value))).toBe(true);
    expect([...verdicts.values()].reduce((sum, value) => sum + value, 0)).toBe(censusRows.length);
    const stoppingExtensions = new Set([".mjs", ".ts", ".mts", "<none>"]);
    const stoppingRows = censusRows.filter(({ path }) => stoppingExtensions.has(extensionToken(path)));
    const stoppingOwners = new Set(stoppingRows.map(({ owner }) => owner.replace(/\..*$/u, "")));
    expect(stoppingRows.length).toBeGreaterThan(0);
    expect(stoppingOwners.has("LiteralType") || stoppingOwners.has("ImportTypeNode")).toBe(true);
    expect(stoppingOwners.has("ExternalModuleReference")).toBe(true);
    expect(candidates.length).toBe(
      governedEntries.filter(
        ({ extension, scopeType }) => capabilityResults.get(`${extension}\0${scopeType}`).verdict === "CANDIDATE",
      ).length,
    );
  });

  it("governed runtime syntax agrees with the compiler-derived partition", () => {
    withTempDirectory("chase-canonical-syntax-", (directory) => {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(
        join(directory, "target.mjs"),
        'process.stdout.write("TARGET;"); export const value = 1; export class X {}\n',
      );
      const controls = [
        [
          "import-type-declaration",
          'import type { X } from "./target.mjs"; process.stdout.write("ENTRY");',
          ".ts",
          "ERASED_NON_LOADING",
          false,
        ],
        [
          "export-type-declaration",
          'export type { X } from "./target.mjs"; process.stdout.write("ENTRY");',
          ".ts",
          "ERASED_NON_LOADING",
          false,
        ],
        [
          "import-type-node",
          'type T = import("./target.mjs").X; process.stdout.write("ENTRY");',
          ".ts",
          "ERASED_NON_LOADING",
          false,
        ],
        [
          "specifier-import-type",
          'import { type X } from "./target.mjs"; process.stdout.write("ENTRY");',
          ".ts",
          "RUNTIME_ESM_IMPORT",
          true,
        ],
        [
          "empty-import",
          'import {} from "./target.mjs"; process.stdout.write("ENTRY");',
          ".mjs",
          "RUNTIME_ESM_IMPORT",
          true,
        ],
        [
          "specifier-export-type",
          'export { type X } from "./target.mjs"; process.stdout.write("ENTRY");',
          ".ts",
          "RUNTIME_ESM_EXPORT",
          true,
        ],
        [
          "value-import",
          'import { value } from "./target.mjs"; process.stdout.write("ENTRY" + value);',
          ".mjs",
          "RUNTIME_ESM_IMPORT",
          true,
        ],
        [
          "value-export",
          'export { value } from "./target.mjs"; process.stdout.write("ENTRY");',
          ".mjs",
          "RUNTIME_ESM_EXPORT",
          true,
        ],
        [
          "dynamic-import",
          'await import("./target.mjs"); process.stdout.write("ENTRY");',
          ".mjs",
          "RUNTIME_ESM_DYNAMIC",
          true,
        ],
        [
          "literal-require",
          'require("./target.mjs"); process.stdout.write("ENTRY");',
          ".cjs",
          "RUNTIME_CJS_REQUIRE",
          true,
        ],
        [
          "import-equals",
          'import target = require("./target.mjs"); process.stdout.write("ENTRY");',
          ".ts",
          "RUNTIME_UNSUPPORTED_NON_LOADING",
          false,
        ],
      ];
      for (const [name, source, extension, expectedVerdict, targetLoaded] of controls) {
        const file = join(directory, `${name}${extension}`);
        writeFileSync(file, source);
        const rows = compilerRows(file, source);
        expect(rows).toHaveLength(1);
        expect(rows[0].verdict).toBe(expectedVerdict);
        const result = spawnSync(process.execPath, [file], {
          cwd: directory,
          encoding: "utf8",
          timeout: SHARD_BUDGET_MS,
        });
        if (name === "import-equals") {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
        } else {
          expect(result.status).toBe(0);
          expect(result.stdout.includes("TARGET;")).toBe(targetLoaded);
          expect(result.stdout).toContain("ENTRY");
        }
      }
      expectRefusal("IMPORTER_SYNTAX_INDETERMINATE", () =>
        compilerRows(join(directory, "unknown.mjs"), 'await import("./target.mjs", { with: { type: "json" } });'),
      );
      expectRefusal("IMPORTER_SYNTAX_INDETERMINATE", () =>
        compilerRows(join(directory, "injected-unknown.mjs"), 'import "./target.mjs";', {
          forceIndeterminate: true,
        }),
      );
    });
  });

  it("corpus shards stay inside the unchanged timeout", () => {
    expect(capabilityTimings).toHaveLength(CAPABILITY_SHARDS);
    expect(censusTimings).toHaveLength(CENSUS_SHARDS);
    expect(Math.max(...capabilityTimings.map(({ elapsedMs }) => elapsedMs))).toBeLessThan(SHARD_BUDGET_MS);
    expect(Math.max(...censusTimings.map(({ elapsedMs }) => elapsedMs))).toBeLessThan(SHARD_BUDGET_MS);
    const aggregateBudget = (CAPABILITY_SHARDS + CENSUS_SHARDS) * SHARD_BUDGET_MS;
    const total = [...capabilityTimings, ...censusTimings].reduce((sum, { elapsedMs }) => sum + elapsedMs, 0);
    expect(total).toBeLessThan(aggregateBudget);
    console.info(
      JSON.stringify({
        tracked: gitEntries.length,
        regular: regularEntries.length,
        symlinks: gitEntries.filter(({ mode }) => mode === "120000").length,
        groups: capabilityGroups.length,
        candidates: candidateEntries().length,
        specifiers: censusRows.length,
        capabilityTimings,
        censusTimings,
      }),
    );
  });

  it("the authorized importer inventory is exact", () => {
    assertUniqueSetEqual([...discoveredImporters].sort(), [...AUTHORIZED_IMPORTERS]);
  });
});

describe.sequential("actual loader discriminators", () => {
  const pathFormShards = 8;
  for (let shard = 0; shard < pathFormShards; shard += 1) {
    it(`executes the channel/path-form matrix [shard ${shard + 1}/${pathFormShards}]`, () => {
      const rows = loaderMatrixRows.filter((_row, index) => index % pathFormShards === shard);
      const failures = [];
      for (const row of rows) {
        try {
          loaderMatrixEvidence.push(executePathFormRow(row));
        } catch (error) {
          loaderMatrixEvidence.push({ ...row, actual: "ERROR", classified: "ERROR", code: null });
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "channel/path-form matrix failures");
    });
  }

  const aliasShards = 4;
  for (let shard = 0; shard < aliasShards; shard += 1) {
    it(`executes package aliases in distinct temp packages [shard ${shard + 1}/${aliasShards}]`, () => {
      const rows = aliasRows.filter((_row, index) => index % aliasShards === shard);
      aliasEvidence.push(...rows.map(executeAliasRow));
    });
  }

  it("actual loader resolution binds every alias and path form to emitter realpath", () => {
    expect(loaderPathForms).toHaveLength(22);
    expect(loaderMatrixEvidence).toHaveLength(4 * 22);
    expect(aliasEvidence).toHaveLength(2 * 4 * 3);
    for (const aliasKind of ["internal", "external"]) {
      for (const channel of loaderChannels) {
        const rows = aliasEvidence.filter((row) => row.aliasKind === aliasKind && row.channel === channel);
        expect(rows.map(({ state }) => state).sort()).toEqual(["missing", "other", "target"]);
        expect(rows.find(({ state }) => state === "target")).toMatchObject({ actual: "TARGET", classified: "TARGET" });
        expect(rows.find(({ state }) => state === "other")).toMatchObject({
          actual: "OTHER",
          classified: "NON_TARGET",
        });
        expect(rows.find(({ state }) => state === "missing")).toMatchObject({
          actual: "NOT_LOADABLE",
          classified: "NON_TARGET",
        });
      }
    }
    const dataRows = loaderMatrixEvidence.filter(({ form }) => form === "data-module");
    expect(dataRows.filter(({ channel }) => channel !== "require").every(({ actual }) => actual === "TARGET")).toBe(
      true,
    );
    expect(
      dataRows.filter(({ channel }) => channel !== "require").every(({ code }) => code === "IMPORTER_DATA_MODULE"),
    ).toBe(true);
    expect(
      loaderMatrixEvidence.find(({ form, channel }) => form === "raw-backslash" && channel === "static").actual,
    ).toBe("NOT_LOADABLE");
    expect(
      loaderMatrixEvidence.find(({ form, channel }) => form === "raw-backslash" && channel === "require").actual,
    ).toBe("TARGET");
    expect(
      loaderMatrixEvidence.find(({ form, channel }) => form === "native-drive" && channel === "require").actual,
    ).toBe("TARGET");
    for (const form of ["query", "fragment", "file-url", "file-url-query", "file-url-fragment"]) {
      expect(loaderMatrixEvidence.find((row) => row.form === form && row.channel === "require").actual).toBe(
        "NOT_LOADABLE",
      );
    }
  });
});

describe.sequential("fail-closed importer controls", () => {
  it("every importer authority gap refuses by name before false green", () => {
    withTempDirectory("chase-canonical-refusals-", (directory) => {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      const importer = join(directory, "candidate.mjs");
      writeFileSync(importer, "");
      const emitterUrl = pathToFileURL(EMITTER_PATH).href;
      const dataSpecifier = `data:text/javascript,export%20%7B%20emitRecord%20%7D%20from%20${encodeURIComponent(JSON.stringify(emitterUrl))}`;
      const dataCandidate = classifiedLoad(importer, "dynamic", dataSpecifier);
      const dataBypass = classifiedLoad(importer, "dynamic", dataSpecifier, { bypassDataGuard: true });
      expect(dataCandidate).toMatchObject({ verdict: "REFUSAL", code: "IMPORTER_DATA_MODULE" });
      expect(dataBypass.verdict).toBe("NON_TARGET");

      const emitterRoot = parse(EMITTER_PATH).root;
      const rooted = `/${EMITTER_PATH.slice(emitterRoot.length).replaceAll("\\", "/")}`;
      const cwdOptions = { cwdPlatform: "win32" };
      const cwdCandidate = classifiedLoad(importer.replace(/\.mjs$/u, ".cjs"), "require", rooted, cwdOptions);
      const cwdBypass = classifiedLoad(importer.replace(/\.mjs$/u, ".cjs"), "require", rooted, {
        ...cwdOptions,
        bypassCwdGuard: true,
      });
      expect(cwdCandidate).toMatchObject({ verdict: "REFUSAL", code: "IMPORTER_CWD_DEPENDENT_REQUIRE" });
      expect(cwdBypass.verdict).toBe("TARGET");

      const unknownRuntimeSource = `await import(${JSON.stringify(emitterUrl)}, { with: { type: "json" } });`;
      expectRefusal("IMPORTER_SYNTAX_INDETERMINATE", () => compilerRows(importer, unknownRuntimeSource));
      expectRefusal("IMPORTER_SYNTAX_INDETERMINATE", () =>
        compilerRows(importer, `import ${JSON.stringify(emitterUrl)};`, { forceIndeterminate: true }),
      );
      expect(compilerRows(importer, `import ${JSON.stringify(emitterUrl)};`)[0].verdict).toBe("RUNTIME_ESM_IMPORT");

      const runtimeRow = compilerRows(importer, `import ${JSON.stringify(emitterUrl)};`)[0];
      expectRefusal("IMPORTER_RESOLUTION_INDETERMINATE", () =>
        resolveRuntimeRows([runtimeRow], { forceIndeterminate: true, disableMemo: true }),
      );
      expect(resolveRuntimeRows([runtimeRow], { disableMemo: true })[0].resolution).toBe("TARGET");

      const repositoryScopedImporter = resolve(ROOT, "synthetic-package-scope-control.mjs");
      expectRefusal("IMPORTER_PACKAGE_SCOPE_INDETERMINATE", () =>
        packageScopeFor(repositoryScopedImporter, () => {
          const error = new Error("injected unreadable scope");
          error.code = "EACCES";
          throw error;
        }),
      );
      expect(packageScopeFor(repositoryScopedImporter).type).toBe("module");

      const group = { extension: ".tsx", scopeType: "module" };
      expectRefusal("IMPORTER_CAPABILITY_INDETERMINATE", () => probeCapability(group, { forceUnknown: true }));
      expect(probeCapability(group).verdict).toBe("CANDIDATE");

      const regular = { mode: "100644", objectId: "0".repeat(40), stage: 0, path: importer };
      expectRefusal("IMPORTER_READ_FAILURE", () =>
        scanEntry(regular, { forceReadFailure: true, absolutePath: importer }),
      );
      expect(scanEntry(regular, { absolutePath: importer })).toEqual([]);
      expectRefusal("IMPORTER_SCAN_FAILURE", () =>
        scanEntry(regular, { forceScanFailure: true, absolutePath: importer }),
      );
      expect(scanEntry(regular, { absolutePath: importer })).toEqual([]);

      const symlinkEntry = { mode: "120000", objectId: "1".repeat(40), stage: 0, path: importer };
      let reads = 0;
      expectRefusal("IMPORTER_TRACKED_SYMLINK", () =>
        scanEntry(symlinkEntry, {
          readFile() {
            reads += 1;
            return "";
          },
        }),
      );
      expect(reads).toBe(0);
      expect(scanEntry(symlinkEntry, { bypassSymlinkMode: true, readFile: () => "" })).toEqual([]);
    });
    expect(IMPORTER_REFUSALS).toHaveLength(9);
  });

  it("tracked object mode binds importer bytes", () => {
    withTempDirectory("chase-canonical-symlink-index-", (directory) => {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["config", "core.symlinks", "true"], { cwd: directory });
      const target = join(directory, "untracked-target.mjs");
      const candidate = join(directory, "candidate.mjs");
      writeFileSync(target, "export const benign = true;\n");
      createFileSymlink("untracked-target.mjs", candidate);
      execFileSync("git", ["add", "candidate.mjs"], { cwd: directory });
      const before = parseGitIndex(execFileSync("git", ["ls-files", "-s", "-z"], { cwd: directory }))[0];
      expect(before.mode).toBe("120000");
      const firstBytes = readFileSync(candidate, "utf8");
      expectRefusal("IMPORTER_TRACKED_SYMLINK", () =>
        scanEntry({ ...before, path: candidate }, { absolutePath: candidate }),
      );
      const firstBypass = scanEntry(
        { ...before, path: candidate },
        { bypassSymlinkMode: true, absolutePath: candidate },
      );

      writeFileSync(target, `import ${JSON.stringify(pathToFileURL(EMITTER_PATH).href)};\n`);
      const after = parseGitIndex(execFileSync("git", ["ls-files", "-s", "-z"], { cwd: directory }))[0];
      const secondBytes = readFileSync(candidate, "utf8");
      expect(after.objectId).toBe(before.objectId);
      expect(secondBytes).not.toBe(firstBytes);
      expectRefusal("IMPORTER_TRACKED_SYMLINK", () =>
        scanEntry({ ...after, path: candidate }, { absolutePath: candidate }),
      );
      const secondBypass = scanEntry(
        { ...after, path: candidate },
        { bypassSymlinkMode: true, absolutePath: candidate },
      );
      expect(firstBypass).toEqual([]);
      expect(secondBypass).toHaveLength(1);
    });
  });

  it("tracked ignored generated and declaration paths stay enrolled while untracked output stays out", () => {
    const candidatePaths = new Set(
      governedEntries
        .filter(
          ({ extension, scopeType }) => capabilityResults.get(`${extension}\0${scopeType}`)?.verdict === "CANDIDATE",
        )
        .map(({ path }) => path),
    );
    const declarations = regularEntries.map(({ path }) => path).filter((path) => /\.d\.[cm]?ts$/iu.test(path));
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.every((path) => candidatePaths.has(path))).toBe(true);
    const generatedLooking = regularEntries
      .map(({ path }) => path)
      .filter((path) => /(?:^|\/)(?:generated|dist|build|coverage)(?:\/|$)|\.generated\./iu.test(path));
    expect(generatedLooking.length).toBeGreaterThan(0);
    expect(
      generatedLooking.filter((path) => extensionToken(path) !== ".json").every((path) => candidatePaths.has(path)),
    ).toBe(true);
    const trackedIgnored = execFileSync("git", ["ls-files", "-ci", "--exclude-standard", "-z"], { cwd: ROOT })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((path) => path.replaceAll("\\", "/"));
    expect(trackedIgnored.length).toBeGreaterThan(0);
    for (const path of trackedIgnored) {
      const entry = governedEntries.find((candidate) => candidate.path === path);
      expect(entry).toBeDefined();
      if (capabilityResults.get(`${entry.extension}\0${entry.scopeType}`).verdict === "CANDIDATE") {
        expect(candidatePaths.has(path)).toBe(true);
      }
    }
    const before = parseGitIndex().map(({ mode, objectId, path }) => ({ mode, objectId, path }));
    const output = mkdtempSync(join(ROOT, ".canonical-record-build-probe-"));
    try {
      writeFileSync(
        join(output, "untracked-built-output.mjs"),
        `import ${JSON.stringify(pathToFileURL(EMITTER_PATH).href)};\n`,
      );
      const after = parseGitIndex().map(({ mode, objectId, path }) => ({ mode, objectId, path }));
      expect(after).toEqual(before);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("the canonical footprint is exactly three files", () => {
    const visible = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((path) => path.replaceAll("\\", "/"));
    assertUniqueSetEqual(
      visible.filter((path) => path.includes("canonical-record")),
      [...CANONICAL_PATHS],
    );
  });
});
