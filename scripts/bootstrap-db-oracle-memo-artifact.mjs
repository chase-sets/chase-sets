import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

export const MEMO_SCHEMA = "bootstrap-db-oracle-memo/v1";
export const INPUT_SCHEMA = "bootstrap-db-oracle-memo-input/v1";
export const WORKFLOW = ".github/workflows/bootstrap-db-oracle-memo.yml";
export const PLATFORM = "deployables/platform-api";
export const FIXTURES = `${PLATFORM}/__tests__/fixtures`;
export const MEMO = `${FIXTURES}/bootstrap-db-oracle-schedule-memo.json`;
export const PRODUCER = `${FIXTURES}/bootstrap-db-oracle-schedule-memo.mjs`;
export const ORACLE = `${FIXTURES}/bootstrap-db-schedule-before-subset-reuse.mjs`;
export const CHECKER = `${PLATFORM}/scripts/check-bootstrap-db-enrollment.mjs`;
export const PAYLOADS = Object.freeze(["bootstrap-db-oracle-schedule-memo.json", "receipt.json", "SHA256SUMS"]);
export const LITERALS = Object.freeze([
  "bootstrapDbEnrollmentManifest",
  "bootstrapDbExecutionUnitBootBearingCaseCeilings",
  "bootstrapDbScheduleModel",
  "platformApiNonBootstrapDbCensus",
  "bootstrapDbMeasuredOneFewerUnitFloor",
]);
const baseline = "6b0845ced2e28032c75a3e57babcb047abff7e42";
const oraclePin = "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b";
const repository = "chase-sets/chase-sets";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const limits = Object.freeze({
  manifest: 256 * 1024,
  memo: 1024 * 1024,
  receipt: 2 * 1024 * 1024,
  sums: 4096,
  zip: 4 * 1024 * 1024,
});
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const same = (left, right, reason) => {
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) {
    return assert.ok(left.equals(right), reason);
  }
  return assert.deepEqual(left, right, reason);
};
const requireThat = (condition, reason) => assert.ok(condition, reason);
const hex = (value, size) => typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const id = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);

function exact(value, keys, name) {
  requireThat(value && typeof value === "object" && !Array.isArray(value), `${name}: expected object`);
  same(Object.keys(value).sort(), [...keys].sort(), `${name}: unknown or missing fields`);
}

function boundedJson(bytes, max, name) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= max, `${name}: byte limit`);
  const value = JSON.parse(bytes.toString("utf8"));
  same(Buffer.from(canonical(value)), bytes, `${name}: canonical UTF-8 JSON/LF required (no duplicate keys)`);
  return value;
}

function safePath(path) {
  requireThat(
    typeof path === "string" && path.length > 0 && !/[\x00-\x1f\x7f\\:]/.test(path) && !path.startsWith("/"),
    "unsafe path",
  );
  requireThat(
    posix.normalize(path) === path && !path.split("/").some((part) => part === "." || part === ".." || part === ""),
    "path traversal",
  );
  return path;
}

function git(directory, args, binary = false) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: binary ? undefined : "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const blob = (directory, commit, path) => git(directory, ["cat-file", "blob", `${commit}:${safePath(path)}`], true);
const treeClosure = (directory, commit) => sha256(git(directory, ["ls-tree", "-rz", "--full-tree", commit], true));

async function hashLargeObject(directory, entry) {
  const child = spawn("git", ["-C", directory, "cat-file", "blob", entry.oid], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const finished = new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  });
  child.stderr.resume();
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of child.stdout) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const result = await finished;
  requireThat(result.code === 0 && !result.signal && bytes === entry.size, "large immutable object read failed");
  return hash.digest("hex");
}

export async function hashGitFiles(directory, commit, paths) {
  requireThat(hex(commit, 40), "immutable source commit required");
  const inventory = new Map();
  for (const row of git(directory, ["ls-tree", "-rlz", "--full-tree", commit]).split("\0").filter(Boolean)) {
    const match = row.match(/^([0-7]{6}) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/);
    if (match) inventory.set(match[4], { mode: match[1], oid: match[2], size: Number(match[3]) });
  }
  const batches = [];
  const large = [];
  let batch = [];
  let bytes = 0;
  for (const path of [...new Set(paths)].sort()) {
    safePath(path);
    const entry = inventory.get(path);
    requireThat(entry && ["100644", "100755"].includes(entry.mode), `missing/nonregular immutable source: ${path}`);
    if (entry.size > 16 * 1024 * 1024) {
      large.push({ path, ...entry });
      continue;
    }
    if (batch.length && (batch.length === 128 || bytes + entry.size > 16 * 1024 * 1024)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push({ path, ...entry });
    bytes += entry.size;
  }
  if (batch.length) batches.push(batch);
  const hashes = new Map();
  for (const entry of large) hashes.set(entry.path, await hashLargeObject(directory, entry));
  for (const entries of batches) {
    const output = execFileSync("git", ["-C", directory, "cat-file", "--batch"], {
      input: entries.map(({ oid }) => `${oid}\n`).join(""),
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let cursor = 0;
    for (const entry of entries) {
      const end = output.indexOf(10, cursor);
      requireThat(end >= cursor, "incomplete object batch header");
      same(
        output.subarray(cursor, end).toString("utf8"),
        `${entry.oid} blob ${entry.size}`,
        "object batch identity/size differs",
      );
      cursor = end + 1;
      requireThat(
        cursor + entry.size < output.length && output[cursor + entry.size] === 10,
        "incomplete object batch payload",
      );
      hashes.set(entry.path, sha256(output.subarray(cursor, cursor + entry.size)));
      cursor += entry.size + 1;
    }
    same(cursor, output.length, "extra object batch bytes");
  }
  return hashes;
}

export function parseManifest(bytes, expectedSha256) {
  requireThat(hex(expectedSha256, 64) && sha256(bytes) === expectedSha256, "reviewed manifest digest differs");
  const m = boundedJson(bytes, limits.manifest, "manifest");
  exact(
    m,
    [
      "schema",
      "repository",
      "S",
      "W",
      "R",
      "E",
      "T",
      "D",
      "fixtures",
      "checkerLiterals",
      "inputDelta",
      "readClosureSha256",
      "toolchain",
    ],
    "manifest",
  );
  same(m.schema, INPUT_SCHEMA, "manifest schema");
  same(m.repository, repository, "foreign repository");
  for (const role of ["S", "W", "E", "T", "D"]) {
    exact(m[role], ["commit", "tree"], role);
    requireThat(hex(m[role].commit, 40) && hex(m[role].tree, 40), `${role}: immutable commit/tree required`);
  }
  exact(m.R, ["runId", "attempt", "currentJobId", "pairedJobId"], "R");
  requireThat(
    id(m.R.runId) && id(m.R.currentJobId) && id(m.R.pairedJobId) && m.R.attempt === 1,
    "capture pair IDs/attempt",
  );
  exact(m.fixtures, ["current", "paired", "baseline"], "fixtures");
  const names = {
    current: `${FIXTURES}/bootstrap-db-capture-${m.R.runId}.json`,
    paired: `${FIXTURES}/bootstrap-db-capture-${m.R.runId}-paired.json`,
    baseline: `${FIXTURES}/db-enrollment-workload-${m.R.runId}.json`,
  };
  for (const [role, entry] of Object.entries(m.fixtures)) {
    exact(entry, ["path", "sha256"], `fixtures.${role}`);
    same(entry.path, names[role], "fixture path does not match pair");
    requireThat(hex(entry.sha256, 64), "fixture digest");
  }
  exact(m.checkerLiterals, LITERALS, "checker literals");
  requireThat(Array.isArray(m.inputDelta) && m.inputDelta.length <= 4, "input delta envelope");
  for (const entry of m.inputDelta) {
    exact(entry, ["path", "beforeSha256", "afterSha256"], "delta");
    safePath(entry.path);
    requireThat(entry.beforeSha256 === null || hex(entry.beforeSha256, 64), "delta before digest");
    requireThat(hex(entry.afterSha256, 64), "delta after digest");
  }
  same(
    m.inputDelta.map(({ path }) => path),
    [...new Set(m.inputDelta.map(({ path }) => path))].sort(),
    "delta order/duplicates",
  );
  requireThat(hex(m.readClosureSha256, 64), "read closure digest");
  exact(m.toolchain, ["node", "pnpm", "lockSha256"], "toolchain");
  same(m.toolchain.node, "v24.22.1", "fixed Node runtime");
  same(m.toolchain.pnpm, "11.0.9", "fixed pnpm runtime");
  requireThat(hex(m.toolchain.lockSha256, 64), "locked dependency digest");
  expectedKeys(m.checkerLiterals);
  return m;
}

export function expectedKeys(literals) {
  const manifest = literals.bootstrapDbEnrollmentManifest;
  const model = literals.bootstrapDbScheduleModel;
  requireThat(
    manifest && Object.keys(manifest).length === 12 && model.maximumScheduledFileCount === 12,
    "twelve-file envelope",
  );
  requireThat(
    Number.isSafeInteger(model.maxWorkersPerExecutionUnit) && model.maxWorkersPerExecutionUnit > 0,
    "workers",
  );
  requireThat(Number.isSafeInteger(model.testFileFixedCostMs) && model.testFileFixedCostMs >= 0, "fixed file cost");
  const durations = Object.values(manifest).map((file) => {
    requireThat(Array.isArray(file.cases) && file.cases.length > 0, "case costs");
    return file.cases.reduce((total, testCase) => {
      requireThat(Number.isSafeInteger(testCase.referenceDurationMs) && testCase.referenceDurationMs > 0, "case cost");
      return total + testCase.referenceDurationMs;
    }, model.testFileFixedCostMs);
  });
  const keys = [];
  for (let mask = 1; mask < 4096; mask++) {
    keys.push(JSON.stringify([model.maxWorkersPerExecutionUnit, durations.filter((_, index) => mask & (1 << index))]));
  }
  requireThat(new Set(keys).size === 4095, "conflicting profile: collapsed oracle keys");
  return keys.sort();
}

export async function inspectChecker(source) {
  const { default: ts } = await import("@chase-sets/typescript-compiler-api");
  const file = ts.createSourceFile(CHECKER, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  requireThat(file.parseDiagnostics.length === 0, "checker parse failure");
  function literal(node) {
    if (ts.isCallExpression(node)) {
      requireThat(
        node.expression.getText(file) === "Object.freeze" && node.arguments.length === 1,
        "nonliteral checker call",
      );
      return literal(node.arguments[0]);
    }
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node))
      return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    requireThat(ts.isObjectLiteralExpression(node), "nonliteral checker value");
    const entries = node.properties.map((property) => {
      requireThat(
        ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name),
        "nonliteral checker property",
      );
      return [property.name.text, literal(property.initializer)];
    });
    requireThat(new Set(entries.map(([key]) => key)).size === entries.length, "duplicate checker property");
    return Object.fromEntries(entries);
  }
  const values = {};
  const spans = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!LITERALS.includes(declaration.name.text)) continue;
      requireThat(!(declaration.name.text in values), "duplicate checker declaration");
      values[declaration.name.text] = literal(declaration.initializer);
      spans.push([declaration.initializer.getStart(file), declaration.initializer.end, declaration.name.text]);
    }
  }
  exact(values, LITERALS, "checker declarations");
  let skeleton = source;
  for (const [start, end, name] of spans.reverse())
    skeleton = `${skeleton.slice(0, start)}<${name}>${skeleton.slice(end)}`;
  return { values, skeleton };
}

export function validateCapturePair(m, current, paired, baselineValue, readSourceDigest) {
  for (const [capture, role, jobId] of [
    [current, "current-three-unit", m.R.currentJobId],
    [paired, "paired-two-unit", m.R.pairedJobId],
  ]) {
    const p = capture.provenance;
    requireThat(p && p.repository === repository && p.role === role, "foreign capture role/repository");
    same(String(p.runId), m.R.runId, "capture run differs");
    same(String(p.runAttempt), "1", "capture attempt differs");
    same(String(p.referenceJobId), jobId, "capture pair job differs");
    same(p.checkoutSha, m.W.commit, "capture W differs");
    same(p.sourceBase, m.S.commit, "capture S differs");
    same(p.captureParent, m.S.commit, "capture parent differs");
    same(p.parents, [m.S.commit], "capture sole parent differs");
    const bindings = [
      ...[...(capture.files ?? []), ...(capture.nonBootstrapFiles ?? [])].map((file) => [
        `${PLATFORM}/${file.testPath}`,
        file.sourceSha256,
      ]),
      ...Object.entries(capture.sourceBindings ?? {}),
    ];
    requireThat(bindings.length > 0, "capture source bindings missing");
    for (const [path, digest] of bindings) {
      safePath(path);
      requireThat(hex(digest, 64) && readSourceDigest(path) === digest, `capture input drift: ${path}`);
    }
  }
  same(current.model, m.checkerLiterals.bootstrapDbScheduleModel, "accepted model differs from checker literals");
  same(String(current.model.referenceRunId), m.R.runId, "checker capture run differs");
  same(String(current.model.referenceJobId), m.R.currentJobId, "checker capture job differs");
  same(current.model.referenceHeadSha, m.W.commit, "checker capture head differs");
  const manifest = m.checkerLiterals.bootstrapDbEnrollmentManifest;
  same(
    current.files.map((file) => file.fileName),
    Object.keys(manifest),
    "accepted scheduled file order differs",
  );
  for (const file of current.files) {
    same(file.testPath, `__tests__/${file.fileName}`, "accepted test path differs");
    same(
      file.cases.map(({ name, referenceDurationMs, identity }) => ({ name, referenceDurationMs, identity })),
      manifest[file.fileName].cases,
      "accepted case costs/identities differ",
    );
  }
  same(baselineValue.schema, "db-enrollment-workload/v1", "baseline schema");
  same(baselineValue.capture.fixtureSha256, m.fixtures.current.sha256, "baseline fixture digest");
  same(String(baselineValue.capture.runId), m.R.runId, "baseline run");
  same(baselineValue.capture.checkoutSha, m.W.commit, "baseline W");
  same(baselineValue.source.commit, m.S.commit, "baseline S");
  requireThat(Array.isArray(baselineValue.bindings) && baselineValue.bindings.length > 0, "baseline W1-W5 missing");
  requireThat(hex(baselineValue.bindingsSha256, 64), "baseline binding digest missing");
}

export async function admitProfile(m, { objectRoot = root, dispatchSha, helperSha, requireUnmerged = true } = {}) {
  same(dispatchSha, m.D.commit, "wrong dispatch head");
  same(helperSha, m.T.commit, "wrong helper checkout");
  for (const role of ["S", "W", "E", "T", "D"]) {
    same(
      git(objectRoot, ["rev-parse", `${m[role].commit}^{commit}`]).trim(),
      m[role].commit,
      `${role} commit resolution`,
    );
    same(git(objectRoot, ["rev-parse", `${m[role].commit}^{tree}`]).trim(), m[role].tree, `${role} tree resolution`);
  }
  git(objectRoot, ["merge-base", "--is-ancestor", m.T.commit, "origin/main"]);
  git(objectRoot, ["merge-base", "--is-ancestor", m.S.commit, m.E.commit]);
  if (requireUnmerged) {
    const mergedInput = spawnSync("git", ["-C", objectRoot, "merge-base", "--is-ancestor", m.E.commit, "origin/main"], {
      windowsHide: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    requireThat(!mergedInput.error && mergedInput.status === 1, "E must be an unmerged enrollment projection");
  }
  same(git(objectRoot, ["show", "-s", "--format=%P", m.W.commit]).trim(), m.S.commit, "W sole S parent");
  same(
    git(objectRoot, ["diff", "--no-renames", "--name-status", m.S.commit, m.W.commit]).trim(),
    "A\t.github/workflows/10365-bootstrap-db-input-capture.yml",
    "W capture-only delta",
  );
  same(
    blob(objectRoot, m.D.commit, WORKFLOW),
    blob(objectRoot, m.T.commit, WORKFLOW),
    "D workflow not reviewed T bytes",
  );
  for (const role of ["T", "D"]) {
    requireThat(
      git(objectRoot, ["ls-tree", m[role].commit, "--", WORKFLOW]).startsWith("100644 blob "),
      "workflow must be a regular reviewed file",
    );
  }
  if (m.D.commit !== m.E.commit) {
    same(git(objectRoot, ["show", "-s", "--format=%P", m.D.commit]).trim(), m.E.commit, "D sole E parent");
    same(
      git(objectRoot, ["diff", "--no-renames", "--name-status", m.E.commit, m.D.commit]).trim(),
      `A\t${WORKFLOW}`,
      "D workflow-only addition",
    );
  }
  const allowed = [CHECKER, ...Object.values(m.fixtures).map(({ path }) => path)];
  const changed = git(objectRoot, ["diff", "--no-renames", "--name-only", m.S.commit, m.E.commit])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  requireThat(
    changed.every((path) => allowed.includes(path)),
    "widened E input delta",
  );
  same(
    changed,
    m.inputDelta.map(({ path }) => path),
    "reviewed E delta differs",
  );
  for (const entry of m.inputDelta) {
    const exists = git(objectRoot, ["ls-tree", m.S.commit, "--", entry.path]).trim();
    const mode = git(objectRoot, ["ls-tree", m.E.commit, "--", entry.path]).split(" ")[0];
    requireThat(mode === "100644" || (entry.path === CHECKER && mode === "100755"), "nonregular enrollment input");
    same(exists ? sha256(blob(objectRoot, m.S.commit, entry.path)) : null, entry.beforeSha256, "delta before bytes");
    same(sha256(blob(objectRoot, m.E.commit, entry.path)), entry.afterSha256, "delta after bytes");
  }
  for (const path of [PRODUCER, ORACLE]) {
    same(blob(objectRoot, m.E.commit, path), blob(root, baseline, path), `baseline producer/oracle differs: ${path}`);
  }
  same(blob(objectRoot, m.E.commit, MEMO), blob(objectRoot, m.S.commit, MEMO), "old memo must be retained in E");
  same(treeClosure(objectRoot, m.E.commit), m.readClosureSha256, "reviewed full read closure differs");
  same(sha256(blob(objectRoot, m.E.commit, "pnpm-lock.yaml")), m.toolchain.lockSha256, "dependency lock differs");
  same(
    JSON.parse(blob(objectRoot, m.E.commit, "package.json")).packageManager,
    "pnpm@11.0.9",
    "package manager differs",
  );
  const actual = await inspectChecker(blob(objectRoot, m.E.commit, CHECKER).toString("utf8"));
  const original = await inspectChecker(blob(root, baseline, CHECKER).toString("utf8"));
  same(actual.skeleton, original.skeleton, "checker token/order/algorithm/control-base change");
  for (const name of LITERALS) {
    same(
      canonical(actual.values[name]),
      canonical(m.checkerLiterals[name]),
      `reviewed checker literals/order differ: ${name}`,
    );
  }
  const fixtures = Object.fromEntries(
    Object.entries(m.fixtures).map(([key, entry]) => {
      const bytes = blob(objectRoot, m.E.commit, entry.path);
      same(sha256(bytes), entry.sha256, `accepted ${key} fixture digest differs`);
      return [key, JSON.parse(bytes)];
    }),
  );
  const sourcePaths = [fixtures.current, fixtures.paired].flatMap((capture) => [
    ...[...(capture.files ?? []), ...(capture.nonBootstrapFiles ?? [])].map((file) => `${PLATFORM}/${file.testPath}`),
    ...Object.keys(capture.sourceBindings ?? {}),
  ]);
  const sourceHashes = await hashGitFiles(objectRoot, m.S.commit, sourcePaths);
  validateCapturePair(m, fixtures.current, fixtures.paired, fixtures.baseline, (path) => sourceHashes.get(path));
  return fixtures;
}

export function cleanInput(directory, m) {
  same(git(directory, ["rev-parse", "HEAD"]).trim(), m.E.commit, "input checkout differs");
  same(git(directory, ["status", "--porcelain", "--untracked-files=normal"]).trim(), "", "dirty E checkout");
  same(treeClosure(directory, "HEAD"), m.readClosureSha256, "input read closure differs");
}

export async function validateWorkloadBaseline(m, current, baselineValue, derivation) {
  const { checkBootstrapDbWorkloadFreshness } =
    await import("../deployables/platform-api/scripts/db-enrollment-workload.mjs");
  const result = checkBootstrapDbWorkloadFreshness({
    baseline: baselineValue,
    capture: {
      fileName: m.fixtures.current.path.split("/").at(-1),
      fixtureSha256: m.fixtures.current.sha256,
      provenance: current.provenance,
    },
    derivation,
  });
  same(result.violations, [], "canonical baseline/workload drift");
}

function fingerprint(directory, { excludeMemo = false } = {}) {
  const paths = git(directory, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    if (excludeMemo && path === MEMO) continue;
    safePath(path);
    const file = resolve(directory, path);
    requireThat(lstatSync(file).isFile(), `nonregular source file: ${path}`);
    hash.update(`${path}\0${sha256(readFileSync(file))}\n`);
  }
  return hash.digest("hex");
}

export function validateMemo(bytes, literals, stdout) {
  const memo = boundedJson(bytes, limits.memo, "memo");
  exact(memo, ["oracleSha256", "entries"], "memo");
  same(memo.oracleSha256, oraclePin, "oracle pin differs");
  same(Object.keys(memo.entries), expectedKeys(literals), "wrong or unordered [workers,durations] corpus");
  requireThat(
    Object.values(memo.entries).every((value) => Number.isSafeInteger(value) && value >= 0),
    "invalid schedule values",
  );
  exact(stdout, ["mode", "entries", "sha256", "durationMs"], "producer stdout");
  requireThat(
    stdout.mode === "write" && stdout.entries === 4095 && Number.isFinite(stdout.durationMs) && stdout.durationMs >= 0,
    "producer stdout mode/count/duration",
  );
  same(stdout.sha256, sha256(bytes), "stdout/file SHA differs");
  return memo;
}

function sums(memo, receipt) {
  return Buffer.from(`${sha256(memo)}  ${PAYLOADS[0]}\n${sha256(receipt)}  receipt.json\n`);
}

function validateReceipt(receipt, m, manifestSha256) {
  exact(
    receipt,
    ["schema", "kind", "manifestSha256", "profile", "readClosure", "producer", "output", "run"],
    "receipt",
  );
  same(receipt.schema, MEMO_SCHEMA, "receipt schema");
  same(receipt.kind, "deterministic-derivation", "receipt kind");
  same(receipt.profile, m, "receipt immutable profile differs");
  same(receipt.manifestSha256, manifestSha256, "receipt manifest digest differs");
  exact(receipt.readClosure, ["before", "after"], "read closure");
  requireThat(hex(receipt.readClosure.before, 64), "read closure hash missing");
  same(receipt.readClosure.before, receipt.readClosure.after, "producer changed read closure");
  exact(receipt.producer, ["command", "cwd", "stdout", "startedAt", "completedAt"], "producer");
  same(
    receipt.producer.command,
    "node __tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs",
    "wrong producer command",
  );
  same(receipt.producer.cwd, PLATFORM, "wrong producer cwd");
  exact(receipt.output, ["path", "sha256", "oracleSha256", "keys"], "output");
  same(receipt.output.path, PAYLOADS[0], "output path");
  same(receipt.output.oracleSha256, oraclePin, "output oracle");
  same(receipt.output.keys, 4095, "output key count");
  exact(
    receipt.run,
    [
      "repository",
      "workflow",
      "workflowRef",
      "workflowSha",
      "ref",
      "runId",
      "attempt",
      "jobKey",
      "checkRunId",
      "checkout",
      "helper",
      "node",
      "pnpm",
      "runnerOs",
      "runnerImage",
      "runnerImageVersion",
    ],
    "run",
  );
  const run = receipt.run;
  same(run.repository, repository, "run repository");
  same(run.workflow, WORKFLOW, "run workflow");
  requireThat(typeof run.ref === "string" && /^refs\/heads\/[a-zA-Z0-9_./-]+$/.test(run.ref), "run branch ref");
  same(run.workflowRef, `${repository}/${WORKFLOW}@${run.ref}`, "workflow ref");
  same(run.workflowSha, m.D.commit, "run workflow SHA");
  requireThat(
    id(run.runId) && id(run.checkRunId) && run.attempt === 1 && run.jobKey === "deriveMemo",
    "run/job identity",
  );
  same(run.checkout, m.E, "run input E");
  same(run.helper, m.T, "run helper T");
  same(run.node, m.toolchain.node, "runtime Node");
  same(run.pnpm, m.toolchain.pnpm, "runtime pnpm");
  same(run.runnerOs, "Linux", "runner OS");
  same(run.runnerImage, "ubuntu-latest", "runner class");
  requireThat(
    typeof run.runnerImageVersion === "string" && run.runnerImageVersion.length > 0,
    "runner image version missing",
  );
  const start = Date.parse(receipt.producer.startedAt);
  const end = Date.parse(receipt.producer.completedAt);
  requireThat(
    Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start < 30 * 60 * 1000,
    "producer timestamps/budget",
  );
}

export function validateArtifact(files, m, manifestSha256) {
  same([...files.keys()].sort(), [...PAYLOADS].sort(), "partial artifact or extra paths");
  const memo = files.get(PAYLOADS[0]);
  const receiptBytes = files.get("receipt.json");
  const receipt = boundedJson(receiptBytes, limits.receipt, "receipt");
  requireThat(files.get("SHA256SUMS").length <= limits.sums, "sums limit");
  validateReceipt(receipt, m, manifestSha256);
  validateMemo(memo, m.checkerLiterals, receipt.producer.stdout);
  same(receipt.output.sha256, sha256(memo), "receipt/file SHA differs");
  same(files.get("SHA256SUMS"), sums(memo, receiptBytes), "payload checksum bytes differ");
  return receipt;
}

export function readArtifactZip(zip) {
  requireThat(Buffer.isBuffer(zip) && zip.length >= 22 && zip.length <= limits.zip, "ZIP compressed limit");
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  requireThat(end >= 0 && zip.readUInt32LE(end) === 0x06054b50, "ZIP end missing");
  requireThat(end + 22 + zip.readUInt16LE(end + 20) === zip.length, "ZIP trailing bytes");
  requireThat(
    zip.readUInt16LE(end + 4) === 0 &&
      zip.readUInt16LE(end + 6) === 0 &&
      zip.readUInt16LE(end + 8) === 3 &&
      zip.readUInt16LE(end + 10) === 3,
    "ZIP disk/count",
  );
  const centralSize = zip.readUInt32LE(end + 12);
  let cursor = zip.readUInt32LE(end + 16);
  requireThat(cursor + centralSize === end, "ZIP central bounds");
  const files = new Map();
  const ranges = [];
  for (let index = 0; index < 3; index++) {
    requireThat(cursor + 46 <= end && zip.readUInt32LE(cursor) === 0x02014b50, "ZIP central record");
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const expanded = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    requireThat(PAYLOADS.includes(name) && !files.has(name), "ZIP wrong/duplicate/traversal path");
    requireThat((mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000, "ZIP link/nonregular entry");
    requireThat((flags & ~0x808) === 0 && [0, 8].includes(method), "ZIP encrypted/unsupported method");
    same(zip.readUInt16LE(cursor + 34), 0, "ZIP entry disk differs");
    const max = name === "receipt.json" ? limits.receipt : name === "SHA256SUMS" ? limits.sums : limits.memo;
    requireThat(expanded > 0 && expanded <= max && compressed <= limits.zip, "ZIP expanded limit");
    requireThat(
      offset + 30 <= zip.readUInt32LE(end + 16) && zip.readUInt32LE(offset) === 0x04034b50,
      "ZIP local record",
    );
    same(zip.readUInt16LE(offset + 6), flags, "ZIP flags differ");
    same(zip.readUInt16LE(offset + 8), method, "ZIP method differs");
    if (!(flags & 8)) {
      same(zip.readUInt32LE(offset + 14), checksum, "ZIP local CRC differs");
      same(zip.readUInt32LE(offset + 18), compressed, "ZIP local compressed size differs");
      same(zip.readUInt32LE(offset + 22), expanded, "ZIP local expanded size differs");
    }
    const localNameLength = zip.readUInt16LE(offset + 26);
    same(zip.subarray(offset + 30, offset + 30 + localNameLength).toString("utf8"), name, "ZIP local path differs");
    const data = offset + 30 + localNameLength + zip.readUInt16LE(offset + 28);
    requireThat(data + compressed <= zip.readUInt32LE(end + 16), "ZIP local payload bounds");
    requireThat(
      !ranges.some(([start, finish]) => offset < finish && data + compressed > start),
      "ZIP overlapping entries",
    );
    let finish = data + compressed;
    if (flags & 8) {
      requireThat(finish + 12 <= zip.readUInt32LE(end + 16), "ZIP descriptor missing");
      if (zip.readUInt32LE(finish) === 0x08074b50) finish += 4;
      requireThat(finish + 12 <= zip.readUInt32LE(end + 16), "ZIP descriptor bounds");
      same(zip.readUInt32LE(finish), checksum, "ZIP descriptor CRC differs");
      same(zip.readUInt32LE(finish + 4), compressed, "ZIP descriptor compressed size differs");
      same(zip.readUInt32LE(finish + 8), expanded, "ZIP descriptor expanded size differs");
      finish += 12;
    }
    requireThat(
      !ranges.some(([start, previousEnd]) => offset < previousEnd && finish > start),
      "ZIP overlapping descriptors",
    );
    ranges.push([offset, finish]);
    const input = zip.subarray(data, data + compressed);
    const bytes = method === 8 ? inflateRawSync(input, { maxOutputLength: max }) : input;
    same(bytes.length, expanded, "ZIP expanded size differs");
    same(crc32(bytes), checksum, "ZIP CRC differs");
    files.set(name, bytes);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  same(cursor, end, "ZIP unknown central data");
  return files;
}

export function preflightWorkflow(workflow, runs) {
  requireThat(
    workflow.path === WORKFLOW && workflow.state === "active" && Number.isSafeInteger(workflow.id),
    "workflow registration unavailable",
  );
  requireThat(
    Array.isArray(runs) && runs.every((run) => run.workflow_id === workflow.id),
    "foreign/unbounded run inventory",
  );
  requireThat(!runs.some((run) => run.status !== "completed"), "queued/in-progress run: dispatch refused");
  return { workflowId: workflow.id, path: workflow.path, state: workflow.state, observedAt: new Date().toISOString() };
}

export function acceptCompletedArtifact({ m, manifestSha256, run, jobs, artifact, zip }) {
  requireThat(
    run.status === "completed" && run.conclusion === "success" && run.run_attempt === 1,
    "completed successful attempt 1 required",
  );
  same(run.head_sha, m.D.commit, "wrong run head D");
  same(run.path, WORKFLOW, "wrong workflow path");
  same(run.event, "workflow_dispatch", "wrong event");
  same(run.repository.full_name, repository, "wrong run repository");
  requireThat(
    !artifact.expired && artifact.name === `bootstrap-db-oracle-memo-${run.id}-1`,
    "expired/missing/foreign artifact",
  );
  same(artifact.workflow_run.id, run.id, "artifact run differs");
  same(artifact.workflow_run.head_sha, m.D.commit, "artifact head differs");
  same(artifact.digest, `sha256:${sha256(zip)}`, "outer artifact digest differs");
  const receipt = validateArtifact(readArtifactZip(zip), m, manifestSha256);
  same(receipt.run.runId, String(run.id), "receipt run differs");
  same(receipt.run.ref, `refs/heads/${run.head_branch}`, "receipt run ref differs");
  const matches = jobs.filter((job) => job.check_run_url?.endsWith(`/check-runs/${receipt.run.checkRunId}`));
  same(matches.length, 1, "missing/duplicate job check-run join");
  const job = matches[0];
  requireThat(
    Number.isSafeInteger(job.id) &&
      job.run_id === run.id &&
      job.run_attempt === 1 &&
      job.head_sha === m.D.commit &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      job.name === "Derive Canonical Bootstrap Memo",
    "wrong/skipped/red numeric job",
  );
  for (const name of [
    "Admit immutable profile",
    "Verify clean input",
    "Run fixed producer",
    "Validate canonical payloads",
    "Upload canonical memo",
  ]) {
    const steps = job.steps.filter((step) => step.name === name);
    requireThat(
      steps.length === 1 &&
        steps[0].status === "completed" &&
        steps[0].conclusion === "success" &&
        Date.parse(steps[0].completed_at) >= Date.parse(steps[0].started_at),
      `skipped/missing step: ${name}`,
    );
  }
  requireThat(
    Date.parse(job.started_at) <= Date.parse(receipt.producer.startedAt) &&
      Date.parse(job.completed_at) >= Date.parse(receipt.producer.completedAt),
    "receipt outside executed job",
  );
  const producerStep = job.steps.find((step) => step.name === "Run fixed producer");
  requireThat(
    Date.parse(producerStep.started_at) <= Date.parse(receipt.producer.startedAt) &&
      Date.parse(producerStep.completed_at) + 1000 > Date.parse(receipt.producer.completedAt),
    "receipt outside executed producer step",
  );
  return {
    kind: "accepted-deterministic-derivation",
    runUrl: run.html_url,
    jobUrl: job.html_url,
    jobId: job.id,
    checkRunId: receipt.run.checkRunId,
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    memoSha256: receipt.output.sha256,
    receiptSha256: sha256(readArtifactZip(zip).get("receipt.json")),
    sumsSha256: sha256(readArtifactZip(zip).get("SHA256SUMS")),
  };
}

export function checkApplication(m, publication, { objectRoot = root, acceptedMemoSha256 } = {}) {
  requireThat(hex(publication, 40), "immutable P required");
  requireThat(hex(acceptedMemoSha256, 64), "accepted derivation memo digest required");
  same(
    sha256(blob(objectRoot, publication, MEMO)),
    acceptedMemoSha256,
    "publication memo differs from accepted artifact",
  );
  for (const path of [PRODUCER, ORACLE, CHECKER, ...Object.values(m.fixtures).map(({ path }) => path)]) {
    same(blob(objectRoot, publication, path), blob(objectRoot, m.E.commit, path), `publication input drift: ${path}`);
  }
  return {
    kind: "application-probe-not-acceptance",
    publication,
    rawCheck: "PENDING_HOST",
    mergeGroupRawCheck: "PENDING_HOST",
    enrollmentAssertions: "PENDING_HOST",
    authority: "canonical-author-only; no automatic application or landing",
  };
}

function api(path, binary = false) {
  const bytes = execFileSync("gh", ["api", `repos/${repository}/${path}`], {
    maxBuffer: limits.zip + 1024 * 1024,
    windowsHide: true,
  });
  return binary ? bytes : JSON.parse(bytes);
}

function pages(path, field) {
  const entries = [];
  for (let page = 1; page <= 10; page++) {
    const response = api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    requireThat(
      Array.isArray(response[field]) && Number.isSafeInteger(response.total_count) && response.total_count <= 1000,
      "API inventory bound/shape",
    );
    entries.push(...response[field]);
    if (entries.length === response.total_count) return entries;
    requireThat(response[field].length === 100, "partial API inventory");
  }
  throw new Error("API pagination incomplete");
}

function environmentManifest() {
  const bytes = Buffer.from(process.env.MEMO_MANIFEST_JSON ?? "");
  return {
    m: parseManifest(bytes, process.env.MEMO_MANIFEST_SHA256),
    manifestSha256: process.env.MEMO_MANIFEST_SHA256,
  };
}

export function parseCommand(args) {
  const [command, ...rest] = args;
  requireThat(
    ["admit", "verify-input", "derive", "validate", "preflight", "accept", "application"].includes(command),
    "explicit known command required",
  );
  if (["admit", "verify-input", "validate", "preflight"].includes(command))
    same(rest, [], "command accepts no overrides");
  if (command === "derive")
    same(
      rest,
      ["--out", "../artifacts/bootstrap-db-oracle-memo/bootstrap-db-oracle-schedule-memo.json"],
      "fixed output only",
    );
  if (command === "accept") requireThat(rest.length === 2 && rest.every(id), "numeric run and artifact IDs required");
  if (command === "application")
    requireThat(
      rest.length === 3 && hex(rest[0], 40) && rest.slice(1).every(id),
      "immutable P and numeric run/artifact IDs required",
    );
  return { command, rest };
}

function completedAcceptance(m, manifestSha256, runId, artifactId) {
  requireThat(id(runId) && id(artifactId), "numeric run and artifact IDs required");
  const run = api(`actions/runs/${runId}`);
  const jobs = pages(`actions/runs/${runId}/attempts/1/jobs`, "jobs");
  const artifacts = pages(`actions/runs/${runId}/artifacts`, "artifacts");
  const candidates = artifacts.filter((artifact) => String(artifact.id) === artifactId);
  same(candidates.length, 1, "missing/duplicate artifact");
  return acceptCompletedArtifact({
    m,
    manifestSha256,
    run,
    jobs,
    artifact: candidates[0],
    zip: api(`actions/artifacts/${artifactId}/zip`, true),
  });
}

async function main(args) {
  const { command, rest } = parseCommand(args);
  if (command === "preflight") {
    same(rest, [], "preflight accepts no overrides");
    const workflow = api(`actions/workflows/${WORKFLOW.split("/").at(-1)}`);
    const runs = pages(`actions/workflows/${workflow.id}/runs?exclude_pull_requests=true`, "workflow_runs");
    console.log(canonical(preflightWorkflow(workflow, runs)));
    return;
  }
  const { m, manifestSha256 } = environmentManifest();
  same(git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim(), "", "dirty helper T checkout");
  if (command === "accept") {
    await admitProfile(m, {
      dispatchSha: m.D.commit,
      helperSha: git(root, ["rev-parse", "HEAD"]).trim(),
      requireUnmerged: false,
    });
    requireThat(rest.length === 2 && rest.every(id), "accept requires numeric run and artifact IDs");
    console.log(canonical(completedAcceptance(m, manifestSha256, ...rest)));
    return;
  }
  if (command === "application") {
    await admitProfile(m, {
      dispatchSha: m.D.commit,
      helperSha: git(root, ["rev-parse", "HEAD"]).trim(),
      requireUnmerged: false,
    });
    requireThat(rest.length === 3, "application requires immutable P, run ID and artifact ID");
    const accepted = completedAcceptance(m, manifestSha256, rest[1], rest[2]);
    console.log(canonical(checkApplication(m, rest[0], { acceptedMemoSha256: accepted.memoSha256 })));
    return;
  }
  await admitProfile(m, { dispatchSha: process.env.GITHUB_SHA, helperSha: git(root, ["rev-parse", "HEAD"]).trim() });
  if (command === "admit") {
    same(rest, [], "admit accepts no overrides");
    same(process.env.INPUT_SHA, m.E.commit, "input checkout selector differs");
    same(process.env.GITHUB_RUN_ATTEMPT, "1", "rerun refused");
    return;
  }
  const inputRoot = resolve(root, "../input");
  if (command === "verify-input") {
    same(rest, [], "verify-input accepts no overrides");
    cleanInput(inputRoot, m);
    const { deriveBootstrapDbWorkload } =
      await import("../deployables/platform-api/scripts/db-enrollment-workload.mjs");
    const derivation = await deriveBootstrapDbWorkload({ repositoryRoot: inputRoot });
    same(derivation.gaps, [], "W1-W5 workload derivation gaps");
    const baselineValue = JSON.parse(readFileSync(resolve(inputRoot, m.fixtures.baseline.path)));
    const { deriveBootstrapDbMeasuredOneFewerUnitFloor } =
      await import("../deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs");
    const current = JSON.parse(readFileSync(resolve(inputRoot, m.fixtures.current.path)));
    const paired = JSON.parse(readFileSync(resolve(inputRoot, m.fixtures.paired.path)));
    await validateWorkloadBaseline(m, current, baselineValue, derivation);
    const floor = deriveBootstrapDbMeasuredOneFewerUnitFloor({ shippedCapture: current, pairedCapture: paired });
    requireThat(!floor.refusal, `paired floor refused: ${floor.refusal}`);
    same(floor.floor, m.checkerLiterals.bootstrapDbMeasuredOneFewerUnitFloor, "accepted paired floor differs");
    return;
  }
  const output = resolve(root, "../artifacts/bootstrap-db-oracle-memo");
  if (command === "validate") {
    same(rest, [], "validate accepts no overrides");
    const files = new Map(
      readdirSync(output).map((name) => {
        requireThat(lstatSync(resolve(output, name)).isFile(), "nonregular artifact payload");
        return [name, readFileSync(resolve(output, name))];
      }),
    );
    validateArtifact(files, m, manifestSha256);
    return;
  }
  same(
    rest,
    ["--out", "../artifacts/bootstrap-db-oracle-memo/bootstrap-db-oracle-schedule-memo.json"],
    "fixed output only",
  );
  same(process.env.GITHUB_RUN_ATTEMPT, "1", "rerun refused");
  same(process.version, m.toolchain.node, "installed Node differs");
  const pnpm = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  same(pnpm, m.toolchain.pnpm, "installed pnpm differs");
  cleanInput(inputRoot, m);
  const before = fingerprint(inputRoot, { excludeMemo: true });
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [resolve(inputRoot, PRODUCER)], {
    cwd: resolve(inputRoot, PLATFORM),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CHASE_SETS_LANE_MODE: "" },
  });
  if (result.error) throw result.error;
  requireThat(result.status === 0 && !result.signal, `producer failed: ${result.status}; ${result.stderr}`);
  const completedAt = new Date().toISOString();
  const stdout = JSON.parse(result.stdout.trim());
  const memo = readFileSync(resolve(inputRoot, MEMO));
  validateMemo(memo, m.checkerLiterals, stdout);
  requireThat(["", MEMO].includes(git(inputRoot, ["diff", "--name-only"]).trim()), "only memo may change");
  same(git(inputRoot, ["ls-files", "--others", "--exclude-standard"]).trim(), "", "producer created unexpected files");
  const after = fingerprint(inputRoot, { excludeMemo: true });
  same(before, after, "producer changed source/read closure");
  const receipt = {
    schema: MEMO_SCHEMA,
    kind: "deterministic-derivation",
    manifestSha256,
    profile: m,
    readClosure: { before, after },
    producer: {
      command: "node __tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs",
      cwd: PLATFORM,
      stdout,
      startedAt,
      completedAt,
    },
    output: { path: PAYLOADS[0], sha256: sha256(memo), oracleSha256: oraclePin, keys: 4095 },
    run: {
      repository: process.env.GITHUB_REPOSITORY,
      workflow: WORKFLOW,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      ref: process.env.GITHUB_REF,
      runId: process.env.GITHUB_RUN_ID,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      jobKey: process.env.GITHUB_JOB,
      checkRunId: process.env.MEMO_CHECK_RUN_ID,
      checkout: m.E,
      helper: m.T,
      node: process.version,
      pnpm,
      runnerOs: process.env.RUNNER_OS,
      runnerImage: "ubuntu-latest",
      runnerImageVersion: process.env.ImageVersion,
    },
  };
  const receiptBytes = Buffer.from(canonical(receipt));
  const files = new Map([
    [PAYLOADS[0], memo],
    ["receipt.json", receiptBytes],
    ["SHA256SUMS", sums(memo, receiptBytes)],
  ]);
  validateArtifact(files, m, manifestSha256);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output, { recursive: false });
  for (const [name, bytes] of files) writeFileSync(resolve(output, name), bytes, { flag: "wx" });
  console.log(
    canonical({
      kind: receipt.kind,
      memoSha256: sha256(memo),
      receiptSha256: sha256(receiptBytes),
      sumsSha256: sha256(files.get("SHA256SUMS")),
    }),
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`STOP_TO_HOST: ${error.message}`);
    process.exitCode = 1;
  }
}
