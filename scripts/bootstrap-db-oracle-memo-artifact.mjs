import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

export const MEMO_SCHEMA = "bootstrap-db-oracle-memo/v2";
export const INPUT_SCHEMA = "bootstrap-db-oracle-memo-input/v2";
import { gitListingOptions } from "./lib/git-listing.mjs";

export const MANIFEST = ".github/bootstrap-db-oracle-memo-input.json";
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
const baseline = "54e6e7eb6e8136c9252896d8cf79bf199fc4de64";
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
const unit = /^test:db:[1-4]$/;
const fileName = /^(?!.*\.\.)(?!.*[/\\])[A-Za-z0-9][A-Za-z0-9._-]*\.db\.test\.ts$/;
const testPath = /^__tests__\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.db\.test\.ts$/;
const derivationBranch =
  /^memo-derivation\/(?!.*(?:\.\.|\/\/|@\{|\/\.|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_-]$/;

function boundValue(value, maxDepth, maxNodes) {
  const pending = [[value, 1]];
  let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    requireThat(++nodes <= maxNodes, "JSON node limit");
    if (typeof item === "number") requireThat(Number.isFinite(item) && !Object.is(item, -0), "invalid number");
    if (item === null || typeof item !== "object") continue;
    requireThat(depth <= maxDepth, "JSON depth limit");
    requireThat(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype, "JSON object prototype");
    for (const key of Reflect.ownKeys(item)) {
      requireThat(
        typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key),
        "unsafe JSON key",
      );
      if (Array.isArray(item) && key === "length") continue;
      pending.push([item[key], depth + 1]);
    }
  }
}

function integer(value, min, max, name) {
  requireThat(
    Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max,
    `${name}: integer range`,
  );
}

function text(value, pattern, min, max, name) {
  requireThat(
    typeof value === "string" && value.length >= min && value.length <= max && pattern.test(value),
    `${name}: string range`,
  );
}

function commitTree(value, name) {
  exact(value, ["commit", "tree"], name);
  requireThat(hex(value.commit, 40) && hex(value.tree, 40), `${name}: commit/tree`);
}

function map(value, pattern, min, max, visit, name) {
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, `${name}: map`);
  integer(Object.keys(value).length, min, max, name);
  for (const [key, entry] of Object.entries(value)) {
    text(key, pattern, 1, 512, name);
    if (pattern === fileName) text(key, pattern, 12, 255, name);
    safePath(key.replace(/^test:db:/, "unit-"));
    visit(entry, key);
  }
}

export function validateLiterals(v) {
  boundValue(v, 5, 32768);
  exact(v, LITERALS, "checker literals");
  let caseCount = 0;
  let bootCount = 0;
  map(
    v.bootstrapDbEnrollmentManifest,
    fileName,
    12,
    12,
    (p) => {
      exact(p, ["executionUnit", "databaseSuffix", "bootBearingCases", "cases"], "partition");
      text(p.executionUnit, unit, 9, 9, "partition unit");
      text(p.databaseSuffix, /^[a-z][a-z0-9_]*$/, 1, 63, "database suffix");
      requireThat(Array.isArray(p.cases) && p.cases.length > 0, "cases array");
      const names = new Set();
      const identities = new Set();
      for (const c of p.cases) {
        requireThat(++caseCount <= 4096, "case cardinality");
        exact(c, ["name", "referenceDurationMs", "identity"], "case");
        text(c.name, /^[^\x00-\x1f\x7f]+$/, 1, 4096, "case name");
        integer(c.referenceDurationMs, 1, 3600000, "case duration");
        requireThat(
          hex(c.identity, 16) && !names.has(c.name) && !identities.has(c.identity),
          "case identity/duplicate",
        );
        names.add(c.name);
        identities.add(c.identity);
      }
      if (p.bootBearingCases !== "all") {
        requireThat(Array.isArray(p.bootBearingCases), "boot-bearing cases");
        requireThat(new Set(p.bootBearingCases).size === p.bootBearingCases.length, "duplicate boot-bearing case");
        requireThat(
          p.bootBearingCases.every((name) => names.has(name)),
          "unknown boot-bearing case",
        );
        bootCount += p.bootBearingCases.length;
      } else bootCount += p.cases.length;
      requireThat(bootCount <= 4096, "boot-bearing cardinality");
    },
    "enrollment",
  );
  map(
    v.bootstrapDbExecutionUnitBootBearingCaseCeilings,
    unit,
    1,
    4,
    (count) => integer(count, 0, 4096, "ceiling"),
    "ceilings",
  );
  same(
    Object.keys(v.bootstrapDbExecutionUnitBootBearingCaseCeilings),
    [...new Set(Object.values(v.bootstrapDbEnrollmentManifest).map((p) => p.executionUnit))].sort(),
    "complete source units",
  );
  const model = v.bootstrapDbScheduleModel;
  exact(
    model,
    [
      "referenceRunId",
      "referenceJobId",
      "referenceJobName",
      "referenceHeadSha",
      "referenceEvent",
      "maxWorkersPerExecutionUnit",
      "testFileFixedCostMs",
      "executionUnitFixedCostMs",
      "jobOverheadMs",
      "executionUnitCeilingMs",
      "aggregateCeilingMs",
      "maximumCaseReferenceDurationMs",
      "maximumScheduledFileCount",
      "maximumEnumeratedUnitCount",
    ],
    "schedule",
  );
  for (const key of ["referenceRunId", "referenceJobId"]) integer(model[key], 1, Number.MAX_SAFE_INTEGER, key);
  text(model.referenceJobName, /^[A-Za-z0-9][A-Za-z0-9 ():._/-]*$/, 1, 256, "job name");
  requireThat(hex(model.referenceHeadSha, 40), "reference head");
  text(model.referenceEvent, /^[a-z][a-z0-9_]*$/, 1, 64, "reference event");
  integer(model.maxWorkersPerExecutionUnit, 1, 64, "workers");
  for (const key of ["testFileFixedCostMs", "executionUnitFixedCostMs", "jobOverheadMs"])
    integer(model[key], 0, 3600000, key);
  for (const key of ["executionUnitCeilingMs", "aggregateCeilingMs", "maximumCaseReferenceDurationMs"])
    integer(model[key], 1, 3600000, key);
  same(model.maximumScheduledFileCount, 12, "scheduled count");
  integer(model.maximumEnumeratedUnitCount, 1, 4, "enumerated units");
  requireThat(
    model.testFileFixedCostMs + model.executionUnitFixedCostMs < model.executionUnitCeilingMs &&
      model.executionUnitCeilingMs + model.jobOverheadMs <= model.aggregateCeilingMs,
    "schedule cost envelope",
  );
  for (const p of Object.values(v.bootstrapDbEnrollmentManifest))
    for (const c of p.cases)
      integer(c.referenceDurationMs, 1, model.maximumCaseReferenceDurationMs, "bounded case duration");
  const census = v.platformApiNonBootstrapDbCensus;
  exact(census, ["referenceRunId", "referenceJobId", "entries"], "census");
  for (const key of ["referenceRunId", "referenceJobId"]) same(census[key], model[key], "census provenance");
  map(census.entries, testPath, 0, 4096, (u) => text(u, unit, 9, 9, "census unit"), "census entries");
  requireThat(
    Object.values(census.entries).every((u) => Object.hasOwn(v.bootstrapDbExecutionUnitBootBearingCaseCeilings, u)),
    "foreign census unit",
  );
  const floor = v.bootstrapDbMeasuredOneFewerUnitFloor;
  if (floor !== null) {
    exact(
      floor,
      [
        "shippedReferenceRunId",
        "pairedReferenceRunId",
        "pairedReferenceJobId",
        "pairedArtifactSha256",
        "unitCount",
        "assignment",
        "unitMakespansMs",
      ],
      "floor",
    );
    for (const key of ["shippedReferenceRunId", "pairedReferenceRunId", "pairedReferenceJobId"])
      integer(floor[key], 1, Number.MAX_SAFE_INTEGER, key);
    requireThat(hex(floor.pairedArtifactSha256, 64), "paired artifact digest");
    integer(floor.unitCount, 1, 3, "floor unit count");
    map(floor.assignment, fileName, 12, 12, (u) => text(u, unit, 9, 9, "assignment unit"), "assignment");
    map(floor.unitMakespansMs, unit, 1, 3, (ms) => integer(ms, 0, Number.MAX_SAFE_INTEGER, "makespan"), "makespans");
    same(Object.keys(floor.unitMakespansMs).length, floor.unitCount, "floor cardinality");
    same(
      Object.keys(floor.assignment).sort(),
      Object.keys(v.bootstrapDbEnrollmentManifest).sort(),
      "complete floor files",
    );
    same(
      floor.unitCount,
      Object.keys(v.bootstrapDbExecutionUnitBootBearingCaseCeilings).length - 1,
      "one-fewer floor units",
    );
    requireThat(
      Object.values(floor.assignment).every((u) => Object.hasOwn(floor.unitMakespansMs, u)),
      "foreign floor unit",
    );
  }
  return v;
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
      "fixtures",
      "checkerLiterals",
      "inputDelta",
      "readClosureSha256",
      "toolchain",
    ],
    "manifest",
  );
  same(m.schema, INPUT_SCHEMA, "input schema");
  same(m.repository, repository, "repository");
  for (const key of ["S", "W", "E", "T"]) commitTree(m[key], key);
  exact(m.R, ["runId", "attempt", "currentJobId", "pairedJobId"], "capture pair");
  for (const key of ["runId", "currentJobId", "pairedJobId"])
    requireThat(id(m.R[key]) && Number.isSafeInteger(Number(m.R[key])), "capture numeric ID");
  same(m.R.attempt, 1, "capture attempt");
  exact(m.fixtures, ["current", "paired", "baseline"], "fixtures");
  for (const [role, name] of Object.entries({
    current: `bootstrap-db-capture-${m.R.runId}.json`,
    paired: `bootstrap-db-capture-${m.R.runId}-paired.json`,
    baseline: `db-enrollment-workload-${m.R.runId}.json`,
  })) {
    exact(m.fixtures[role], ["path", "sha256"], "fixture");
    same(m.fixtures[role].path, `${FIXTURES}/${name}`, "fixture path");
    requireThat(hex(m.fixtures[role].sha256, 64), "fixture digest");
  }
  validateLiterals(m.checkerLiterals);
  requireThat(
    Array.isArray(m.inputDelta) && m.inputDelta.length >= 1 && m.inputDelta.length <= 4,
    "input delta cardinality",
  );
  const allowed = [CHECKER, ...Object.values(m.fixtures).map((f) => f.path)];
  for (const d of m.inputDelta) {
    exact(d, ["path", "beforeSha256", "afterSha256"], "delta");
    requireThat(allowed.includes(d.path), "delta path");
    requireThat((d.beforeSha256 === null || hex(d.beforeSha256, 64)) && hex(d.afterSha256, 64), "delta digest");
  }
  same(
    m.inputDelta.map((d) => d.path),
    [...new Set(m.inputDelta.map((d) => d.path))].sort(),
    "delta order/duplicates",
  );
  requireThat(hex(m.readClosureSha256, 64), "read closure digest");
  exact(m.toolchain, ["node", "pnpm", "lockSha256"], "toolchain");
  same(m.toolchain.node, "v24.22.1", "Node");
  same(m.toolchain.pnpm, "11.0.9", "pnpm");
  requireThat(hex(m.toolchain.lockSha256, 64), "lock digest");
  return m;
}
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
  same(Object.keys(value), [...keys], `${name}: unknown/missing/unordered fields`);
}

function boundedJson(bytes, max, name) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= max, `${name}: byte limit`);
  const value = JSON.parse(bytes.toString("utf8"));
  boundValue(value, name === "receipt" ? 8 : name === "memo" ? 3 : 7, name === "receipt" ? 65536 : 32768);
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
  const options = {
    encoding: binary ? undefined : "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  };
  return execFileSync(
    "git",
    ["-C", directory, ...args],
    /^(ls-tree|ls-files|diff)$/.test(args[0]) ? gitListingOptions(options) : options,
  );
}
const blob = (directory, commit, path) => git(directory, ["cat-file", "blob", `${commit}:${safePath(path)}`], true);
const treeClosure = (directory, commit) => sha256(git(directory, ["ls-tree", "-rz", "--full-tree", commit], true));

function parseObjectBatch(output, entries) {
  const values = [];
  let cursor = 0;
  for (const entry of entries) {
    const end = output.indexOf(10, cursor);
    requireThat(end >= cursor, "incomplete object batch header");
    same(
      output.subarray(cursor, end).toString("utf8"),
      `${entry.oid} ${entry.type} ${entry.size}`,
      "object batch identity/size differs",
    );
    cursor = end + 1;
    requireThat(
      cursor + entry.size < output.length && output[cursor + entry.size] === 10,
      "incomplete object batch payload",
    );
    const bytes = output.subarray(cursor, cursor + entry.size);
    same(
      createHash("sha1").update(`${entry.type} ${entry.size}\0`).update(bytes).digest("hex"),
      entry.oid,
      "immutable object digest differs",
    );
    values.push(bytes);
    cursor += entry.size + 1;
  }
  same(cursor, output.length, "extra object batch bytes");
  return values;
}

function immutableReads() {
  const repositories = new Map();
  const state = (directory) => {
    const key = resolve(directory);
    if (!repositories.has(key)) repositories.set(key, { objects: new Map(), commits: new Map(), trees: new Map() });
    return repositories.get(key);
  };
  const batch = (directory, args, entries) =>
    execFileSync("git", ["-C", directory, "cat-file", ...args], {
      input: entries.map(({ oid }) => `${oid}\n`).join(""),
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  const load = (directory, requests) => {
    const objects = state(directory).objects;
    const missing = [...new Map(requests.map((r) => [r.oid, r])).values()].filter((r) => !objects.has(r.oid));
    for (let start = 0; start < missing.length; start += 128) {
      const group = missing.slice(start, start + 128);
      for (const entry of group) requireThat(hex(entry.oid, 40), "full immutable object required");
      const metadata = batch(directory, ["--batch-check"], group);
      const rows = metadata.toString("utf8").split("\n");
      same(rows.pop(), "", "incomplete object metadata");
      same(rows.length, group.length, "object metadata count differs");
      const entries = group.map((entry, i) => {
        const match = rows[i].match(/^([a-f0-9]{40}) (commit|blob) (0|[1-9][0-9]*)$/);
        requireThat(
          match && match[1] === entry.oid && match[2] === entry.type,
          "object metadata identity/type differs",
        );
        const size = Number(match[3]);
        requireThat(Number.isSafeInteger(size) && size <= 32 * 1024 * 1024, "immutable object byte limit");
        return { ...entry, size };
      });
      let pending = [];
      let size = 0;
      const flush = () => {
        if (!pending.length) return;
        const values = parseObjectBatch(batch(directory, ["--batch"], pending), pending);
        pending.forEach((entry, i) => objects.set(entry.oid, { type: entry.type, bytes: values[i] }));
        pending = [];
        size = 0;
      };
      for (const entry of entries) {
        if (entry.size > 16 * 1024 * 1024) {
          flush();
          const bytes = git(directory, ["cat-file", entry.type, entry.oid], true);
          same(bytes.length, entry.size, "large immutable object size differs");
          same(
            createHash("sha1").update(`${entry.type} ${entry.size}\0`).update(bytes).digest("hex"),
            entry.oid,
            "immutable object digest differs",
          );
          objects.set(entry.oid, { type: entry.type, bytes });
        } else {
          if (size + entry.size > 16 * 1024 * 1024) flush();
          pending.push(entry);
          size += entry.size;
        }
      }
      flush();
    }
    for (const entry of requests) same(objects.get(entry.oid).type, entry.type, "immutable object type differs");
  };
  const commits = (directory, ids) => {
    load(
      directory,
      ids.map((oid) => ({ oid, type: "commit" })),
    );
    for (const oid of ids) {
      const header = state(directory).objects.get(oid).bytes.toString("utf8").split("\n\n", 1)[0].split("\n");
      requireThat(/^tree [a-f0-9]{40}$/.test(header[0]), "immutable commit tree header");
      const parents = [];
      let i = 1;
      while (header[i]?.startsWith("parent ")) {
        requireThat(/^parent [a-f0-9]{40}$/.test(header[i]), "immutable commit parent header");
        parents.push(header[i++].slice(7));
      }
      requireThat(!header.slice(i).some((row) => /^(tree|parent) /.test(row)), "misplaced immutable commit header");
      state(directory).commits.set(oid, { tree: header[0].slice(5), parents });
    }
  };
  const tree = (directory, commit) => {
    requireThat(hex(commit, 40), "immutable tree commit required");
    const trees = state(directory).trees;
    const oid = state(directory).commits.get(commit)?.tree ?? commit;
    if (!trees.has(oid)) {
      const raw = git(directory, ["ls-tree", "-rz", "--full-tree", oid], true);
      const entries = new Map();
      let cursor = 0;
      while (cursor < raw.length) {
        const end = raw.indexOf(0, cursor);
        const tab = raw.indexOf(9, cursor);
        requireThat(end > cursor && tab > cursor && tab < end, "incomplete immutable tree record");
        const header = raw
          .subarray(cursor, tab)
          .toString("utf8")
          .match(/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})$/);
        requireThat(header, "invalid immutable tree header");
        const path = raw.subarray(tab + 1, end).toString("hex");
        requireThat(path && !entries.has(path), "duplicate/empty immutable tree path");
        entries.set(path, { mode: header[1], type: header[2], oid: header[3] });
        cursor = end + 1;
      }
      trees.set(oid, { raw, entries });
    }
    return trees.get(oid);
  };
  const entry = (directory, commit, path) =>
    tree(directory, commit).entries.get(Buffer.from(safePath(path)).toString("hex"));
  const prepare = (directory, files) => {
    const requests = files.map(([commit, path]) => {
      const value = entry(directory, commit, path);
      requireThat(
        value?.type === "blob" && ["100644", "100755"].includes(value.mode),
        `missing/nonregular immutable source: ${path}`,
      );
      return { oid: value.oid, type: "blob" };
    });
    load(directory, requests);
  };
  const source = (directory, commit, path) => {
    const value = entry(directory, commit, path);
    requireThat(
      value?.type === "blob" && ["100644", "100755"].includes(value.mode),
      `missing/nonregular immutable source: ${path}`,
    );
    const object = state(directory).objects.get(value.oid);
    requireThat(object?.type === "blob", "immutable source not prepared");
    return object.bytes;
  };
  return { commits, commit: (directory, oid) => state(directory).commits.get(oid), tree, entry, prepare, source };
}

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
    requireThat(cursor + 46 + nameLength + extraLength + commentLength <= end, "ZIP central name bounds");
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
  let finish = 0;
  for (const [start, stop] of ranges.sort(([a], [b]) => a - b)) {
    same(start, finish, "ZIP hidden local data");
    finish = stop;
  }
  same(finish, zip.readUInt32LE(end + 16), "ZIP local closure");
  return files;
}

export async function admitProfile(m, { objectRoot = root, helperSha, event, inputRoot } = {}) {
  parseManifest(Buffer.from(canonical(m)), sha256(Buffer.from(canonical(m))));
  same(helperSha, m.T.commit, "wrong helper T");
  requireThat(event, "opened event evidence required");
  for (const key of ["head", "base", "merge"]) commitTree(event[key], `event ${key}`);
  const reads = immutableReads();
  reads.commits(objectRoot, [
    ...["S", "W", "E", "T"].map((role) => m[role].commit),
    ...["head", "base", "merge"].map((key) => event[key].commit),
  ]);
  for (const role of ["S", "W", "E", "T"]) {
    requireThat(reads.commit(objectRoot, m[role].commit), `${role} commit`);
    same(reads.commit(objectRoot, m[role].commit).tree, m[role].tree, `${role} tree`);
  }
  for (const key of ["head", "base", "merge"]) {
    same(reads.commit(objectRoot, event[key].commit).tree, event[key].tree, `event ${key} tree`);
  }
  git(objectRoot, ["merge-base", "--is-ancestor", m.T.commit, event.base.commit]);
  git(objectRoot, ["merge-base", "--is-ancestor", m.S.commit, m.E.commit]);
  const merged = spawnSync("git", ["-C", objectRoot, "merge-base", "--is-ancestor", m.E.commit, "origin/main"], {
    windowsHide: true,
  });
  requireThat(!merged.error && merged.status === 1, "E must remain unmerged");
  same(reads.commit(objectRoot, m.W.commit).parents.join(" "), m.S.commit, "W sole S parent");
  same(
    git(objectRoot, ["diff", "--no-renames", "--name-status", m.S.commit, m.W.commit]).trim(),
    "A\t.github/workflows/10365-bootstrap-db-input-capture.yml",
    "capture-only W",
  );
  same(reads.commit(objectRoot, event.head.commit).parents.join(" "), m.E.commit, "D sole E parent");
  const expectedD = [`A\t${MANIFEST}`];
  if (!reads.entry(objectRoot, m.E.commit, WORKFLOW)) expectedD.push(`A\t${WORKFLOW}`);
  same(
    git(objectRoot, ["diff", "--no-renames", "--name-status", m.E.commit, event.head.commit]).trim().split("\n"),
    expectedD.sort(),
    "D data-only delta",
  );
  const workflowCommits = [m.T.commit, event.base.commit, event.head.commit, event.merge.commit];
  reads.prepare(objectRoot, [
    [event.head.commit, MANIFEST],
    ...workflowCommits.map((commit) => [commit, WORKFLOW]),
    ...[
      ...m.inputDelta.map((d) => d.path),
      PRODUCER,
      ORACLE,
      MEMO,
      "pnpm-lock.yaml",
      CHECKER,
      ...Object.values(m.fixtures).map((f) => f.path),
    ].map((path) => [m.E.commit, path]),
    ...[MEMO, ...m.inputDelta.filter((d) => reads.entry(objectRoot, m.S.commit, d.path)).map((d) => d.path)].map(
      (path) => [m.S.commit, path],
    ),
  ]);
  const source = (commit, path) => reads.source(objectRoot, commit, path);
  same(source(event.head.commit, MANIFEST), Buffer.from(canonical(m)), "D manifest bytes");
  same(reads.entry(objectRoot, m.E.commit, MANIFEST), undefined, "manifest absent from E/main");
  same(git(objectRoot, ["ls-tree", "origin/main", "--", MANIFEST]).trim(), "", "manifest absent from E/main");
  for (const commit of [m.T.commit, event.base.commit, event.head.commit, event.merge.commit]) {
    requireThat(reads.entry(objectRoot, commit, WORKFLOW)?.mode === "100644", "regular workflow blob");
    same(source(commit, WORKFLOW), source(m.T.commit, WORKFLOW), "workflow not T-identical");
  }
  same(
    reads.commit(objectRoot, event.merge.commit).parents,
    [event.base.commit, event.head.commit],
    "G exact B/D parents",
  );
  const changed = git(objectRoot, ["diff", "--no-renames", "--name-only", m.S.commit, m.E.commit])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  same(
    changed,
    m.inputDelta.map((d) => d.path),
    "E exact reviewed delta",
  );
  for (const d of m.inputDelta) {
    requireThat(reads.entry(objectRoot, m.E.commit, d.path)?.mode === "100644", "regular E input");
    same(sha256(source(m.E.commit, d.path)), d.afterSha256, "E after bytes");
    const exists = reads.entry(objectRoot, m.S.commit, d.path);
    same(exists ? sha256(source(m.S.commit, d.path)) : null, d.beforeSha256, "S before bytes");
  }
  for (const path of [PRODUCER, ORACLE])
    same(source(m.E.commit, path), blob(root, baseline, path), "baseline producer/oracle");
  same(source(m.E.commit, MEMO), source(m.S.commit, MEMO), "old memo retained");
  same(sha256(reads.tree(objectRoot, m.E.commit).raw), m.readClosureSha256, "E complete read closure");
  same(sha256(source(m.E.commit, "pnpm-lock.yaml")), m.toolchain.lockSha256, "E locked dependencies");
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]) {
    same(
      reads.entry(objectRoot, m.S.commit, path),
      reads.entry(objectRoot, m.E.commit, path),
      "dependency/absence closure",
    );
  }
  const actual = await inspectChecker(source(m.E.commit, CHECKER).toString("utf8"));
  const original = await inspectChecker(blob(root, baseline, CHECKER).toString("utf8"));
  same(actual.skeleton, original.skeleton, "checker skeleton/control-base");
  same(canonical(actual.values), canonical(m.checkerLiterals), "E literal values/order");
  const fixtures = Object.fromEntries(
    Object.entries(m.fixtures).map(([key, f]) => {
      const bytes = source(m.E.commit, f.path);
      requireThat(bytes.length <= limits.receipt, "capture fixture limit");
      same(sha256(bytes), f.sha256, "accepted fixture bytes");
      return [key, JSON.parse(bytes)];
    }),
  );
  requireThat(inputRoot, "independent S/input data checkout required");
  cleanInput(inputRoot, m);
  await validateIndependentProfileWithReads(m, fixtures, { objectRoot, inputRoot }, reads);
  return fixtures;
}

export function cleanInput(directory, m) {
  same(git(directory, ["rev-parse", "HEAD"]).trim(), m.E.commit, "input checkout E");
  same(git(directory, ["status", "--porcelain", "--untracked-files=normal"]).trim(), "", "dirty E checkout");
  same(treeClosure(directory, "HEAD"), m.readClosureSha256, "clean input closure");
}

export async function validateIndependentProfile(m, fixtures, { objectRoot, inputRoot }) {
  return validateIndependentProfileWithReads(m, fixtures, { objectRoot, inputRoot }, immutableReads());
}

async function validateIndependentProfileWithReads(m, fixtures, { objectRoot, inputRoot }, reads) {
  const { default: ts } = await import("@chase-sets/typescript-compiler-api");
  const { deriveBootstrapDbCaseIdentities, derivePlatformApiDbTestCensus, deriveBootstrapDbMeasuredOneFewerUnitFloor } =
    await import("../deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs");
  const { parseCLI } = await import("vitest/node");
  const { bindFrozenSourceToCapture } = await import("../deployables/platform-api/scripts/db-enrollment-workload.mjs");
  reads.prepare(
    objectRoot,
    [
      CHECKER,
      `${PLATFORM}/package.json`,
      ...[fixtures.current, fixtures.paired].flatMap((capture) => [
        ...[...(capture?.files ?? []), ...(capture?.nonBootstrapFiles ?? [])].map((f) => `${PLATFORM}/${f.testPath}`),
        ...Object.keys(capture?.sourceBindings ?? {}),
      ]),
    ].map((path) => [m.S.commit, path]),
  );
  const source = (path) => reads.source(objectRoot, m.S.commit, path);
  const frozen = (await inspectChecker(source(CHECKER).toString("utf8"))).values;
  const census = derivePlatformApiDbTestCensus({ platformApiRoot: resolve(inputRoot, PLATFORM) });
  same(census.violations, [], "independent source census");
  const F = census.bootstrapEntries.map((p) => p.slice("__tests__/".length));
  same([...F].sort(), Object.keys(frozen.bootstrapDbEnrollmentManifest).sort(), "S bootstrap inventory");
  const scripts = JSON.parse(source(`${PLATFORM}/package.json`)).scripts;
  const U = Object.keys(scripts)
    .filter((n) => n.startsWith("test:db:"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const assignments = {};
  for (const u of U) {
    const invocations = scripts[u].split(/\s*&&\s*/).filter((p) => /^vitest\s/.test(p));
    same(invocations.length, 1, "one immutable unit invocation");
    for (const filter of parseCLI(invocations[0]).filter) {
      const matches = census.dbEntries.filter((path) =>
        path.toLowerCase().includes(filter.replace(/^\.\//, "").toLowerCase()),
      );
      same(matches.length, 1, "source unit membership");
      requireThat(!Object.hasOwn(assignments, matches[0]), "duplicate source unit");
      assignments[matches[0]] = u;
    }
  }
  same(Object.keys(assignments).sort(), [...census.dbEntries].sort(), "complete unit census");
  for (const [capture, role, jobId] of [
    [fixtures.current, "current-three-unit", m.R.currentJobId],
    [fixtures.paired, "paired-two-unit", m.R.pairedJobId],
  ]) {
    const p = capture.provenance;
    same(p.repository, repository, "capture repository");
    same(p.role, role, "capture role");
    same(String(p.runId), m.R.runId, "capture run");
    same(String(p.runAttempt), "1", "capture attempt");
    same(String(p.referenceJobId), jobId, "capture job");
    same(p.checkoutSha, m.W.commit, "capture W");
    same(p.sourceBase, m.S.commit, "capture S");
    same(p.captureParent, m.S.commit, "capture parent");
    same(p.parents, [m.S.commit], "capture sole parent");
    same(
      bindFrozenSourceToCapture({ capture, readSourceFile: source }).violations,
      [],
      "independent source digest bindings",
    );
    same(capture.files.map((f) => f.fileName).sort(), [...F].sort(), "accepted F membership");
    same(
      capture.nonBootstrapFiles.map((f) => f.testPath).sort(),
      census.dbEntries.filter((p) => !census.bootstrapEntries.includes(p)).sort(),
      "accepted C membership",
    );
  }
  const current = fixtures.current;
  const model = current.model;
  for (const key of [
    "maxWorkersPerExecutionUnit",
    "executionUnitCeilingMs",
    "aggregateCeilingMs",
    "maximumCaseReferenceDurationMs",
    "maximumScheduledFileCount",
    "maximumEnumeratedUnitCount",
  ])
    same(model[key], frozen.bootstrapDbScheduleModel[key], "immutable S model limit");
  const residual = (items) => Math.ceil(Math.max(0, ...items.map((i) => i.residualMs)));
  same(model.testFileFixedCostMs, residual(current.files), "measured file residual");
  same(model.executionUnitFixedCostMs, residual(current.measuredUnits), "measured unit residual");
  requireThat(Number.isFinite(current.jobWallMs), "measured job wall");
  same(
    model.jobOverheadMs,
    Math.ceil(Math.max(0, current.jobWallMs - current.measuredUnits.reduce((s, u) => s + u.observedDurationMs, 0))),
    "measured job residual",
  );
  const manifest = {};
  const ceilings = Object.fromEntries(U.map((u) => [u, 0]));
  for (const f of current.files) {
    const p = frozen.bootstrapDbEnrollmentManifest[f.fileName];
    const sourceText = source(`${PLATFORM}/${f.testPath}`).toString("utf8");
    const parsed = ts.createSourceFile(f.fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    requireThat(parsed.parseDiagnostics.length === 0, "S bootstrap source parse");
    const suffixes = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createPlatformApiBootstrapTestHarness"
      ) {
        requireThat(
          node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]),
          "S database suffix literal",
        );
        suffixes.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    same(suffixes, [p.databaseSuffix], "independent S database suffix");
    const identities = deriveBootstrapDbCaseIdentities(f.fileName, sourceText);
    same(
      f.cases.map(({ name, identity }) => ({ name, identity })),
      identities,
      "independent case identities/order",
    );
    same(f.executionUnit, assignments[f.testPath], "source assignment");
    const cases = f.cases.map((c) => ({
      name: c.name,
      referenceDurationMs: Math.ceil(c.durationMs),
      identity: c.identity,
    }));
    manifest[f.fileName] = {
      executionUnit: assignments[f.testPath],
      databaseSuffix: p.databaseSuffix,
      bootBearingCases: p.bootBearingCases,
      cases,
    };
    ceilings[assignments[f.testPath]] += p.bootBearingCases === "all" ? cases.length : p.bootBearingCases.length;
  }
  const floor = deriveBootstrapDbMeasuredOneFewerUnitFloor({ shippedCapture: current, pairedCapture: fixtures.paired });
  // The pinned derivation reports a valid non-floor through its refusal field too.
  // Only its post-validation, one-fewer topology within-ceiling result is eligible.
  const validNullFloor =
    floor.floor === null &&
    /^the paired capture's [1-3]-unit projection peaks at [0-9]+ms, within the [0-9]+ms per-unit ceiling$/.test(
      floor.refusal,
    );
  requireThat(!floor.refusal || validNullFloor, "accepted pair floor refused");
  const expected = {
    bootstrapDbEnrollmentManifest: manifest,
    bootstrapDbExecutionUnitBootBearingCaseCeilings: ceilings,
    bootstrapDbScheduleModel: model,
    platformApiNonBootstrapDbCensus: {
      referenceRunId: model.referenceRunId,
      referenceJobId: model.referenceJobId,
      entries: Object.fromEntries(current.nonBootstrapFiles.map((f) => [f.testPath, assignments[f.testPath]])),
    },
    bootstrapDbMeasuredOneFewerUnitFloor: floor.floor,
  };
  validateLiterals(expected);
  same(canonical(m.checkerLiterals), canonical(expected), "independently accepted S/pair keys/values/order");
  same(String(model.referenceRunId), m.R.runId, "model pair run");
  same(String(model.referenceJobId), m.R.currentJobId, "model pair job");
  same(model.referenceHeadSha, m.W.commit, "model W");
}

function instant(value, name, apiTime = false) {
  text(
    value,
    apiTime ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    20,
    24,
    name,
  );
  const ms = Date.parse(value);
  requireThat(
    Number.isFinite(ms) && new Date(ms).toISOString() === value.replace(/(?<=:\d\d)Z$/, ".000Z"),
    `${name}: UTC calendar`,
  );
  return ms;
}

export function validateReceipt(r, m, digest) {
  boundValue(r, 8, 65536);
  exact(
    r,
    ["schema", "kind", "manifestSha256", "profile", "readClosure", "producer", "output", "event", "run"],
    "receipt",
  );
  same(r.schema, MEMO_SCHEMA, "v1 is readable history, never current authority");
  same(r.kind, "deterministic-derivation", "receipt kind");
  parseManifest(Buffer.from(canonical(r.profile)), digest);
  same(r.profile, m, "receipt profile");
  same(r.manifestSha256, digest, "receipt manifest digest");
  exact(r.readClosure, ["before", "after"], "read closure");
  requireThat(hex(r.readClosure.before, 64), "read closure hash");
  same(r.readClosure.after, r.readClosure.before, "producer read closure changed");
  exact(r.producer, ["command", "cwd", "stdout", "startedAt", "completedAt"], "producer");
  same(r.producer.command, "node __tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs", "fixed producer");
  same(r.producer.cwd, PLATFORM, "fixed cwd");
  const stdout = r.producer.stdout;
  exact(stdout, ["mode", "entries", "sha256", "durationMs"], "stdout");
  same(stdout.mode, "write", "stdout mode");
  same(stdout.entries, 4095, "stdout keys");
  requireThat(
    hex(stdout.sha256, 64) &&
      Number.isFinite(stdout.durationMs) &&
      !Object.is(stdout.durationMs, -0) &&
      stdout.durationMs >= 0 &&
      stdout.durationMs <= 1800000,
    "stdout digest/duration",
  );
  const start = instant(r.producer.startedAt, "producer start");
  const end = instant(r.producer.completedAt, "producer end");
  requireThat(end >= start && end - start <= 1800000, "producer budget");
  exact(r.output, ["path", "sha256", "oracleSha256", "keys"], "output");
  same(r.output.path, PAYLOADS[0], "memo path");
  same(r.output.sha256, stdout.sha256, "stdout/file SHA");
  same(r.output.oracleSha256, oraclePin, "oracle pin");
  same(r.output.keys, 4095, "output keys");
  const e = r.event;
  exact(
    e,
    [
      "eventName",
      "action",
      "repository",
      "prNumber",
      "headRef",
      "head",
      "base",
      "merge",
      "openedMergeState",
      "openedMergeSha",
      "ref",
      "bodySha256",
      "bodyBytes",
    ],
    "event",
  );
  same(e.eventName, "pull_request", "event name");
  same(e.action, "opened", "opened only");
  same(e.repository, repository, "event repository");
  integer(e.prNumber, 1, Number.MAX_SAFE_INTEGER, "PR number");
  text(e.headRef, derivationBranch, 17, 255, "head ref");
  for (const key of ["head", "base", "merge"]) commitTree(e[key], `event ${key}`);
  requireThat(
    e.head.commit !== e.merge.commit && e.base.commit !== e.merge.commit && e.head.commit !== e.base.commit,
    "D/B/G distinct",
  );
  requireThat(["absent", "null", "sha"].includes(e.openedMergeState), "opened merge state");
  if (e.openedMergeState === "sha") same(e.openedMergeSha, e.merge.commit, "present M must equal G");
  else same(e.openedMergeSha, null, "absent/null M");
  same(e.ref, `refs/pull/${e.prNumber}/merge`, "merge ref");
  const body = `bootstrap-db-oracle-memo-input-sha256: ${digest}\n`;
  same(e.bodySha256, sha256(Buffer.from(body)), "captured body digest");
  same(e.bodyBytes, 104, "captured body bytes");
  const run = r.run;
  exact(
    run,
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
  same(run.repository, repository, "run repository");
  same(run.workflow, WORKFLOW, "run workflow");
  same(run.workflowRef, `${repository}/${WORKFLOW}@${e.ref}`, "workflow context ref");
  requireThat(hex(run.workflowSha, 40), "actual workflow context SHA");
  same(run.ref, e.ref, "run ref");
  for (const key of ["runId", "checkRunId"])
    requireThat(id(run[key]) && Number.isSafeInteger(Number(run[key])), "safe run/check ID");
  same(run.attempt, 1, "attempt1 only");
  same(run.jobKey, "deriveMemo", "owning job key");
  same(run.checkout, m.E, "input E");
  same(run.helper, m.T, "helper T");
  same(run.node, m.toolchain.node, "runtime Node");
  same(run.pnpm, m.toolchain.pnpm, "runtime pnpm");
  same(run.runnerOs, "Linux", "runner OS");
  same(run.runnerImage, "ubuntu-latest", "runner class");
  text(run.runnerImageVersion, /^[A-Za-z0-9._-]+$/, 1, 128, "runner image version");
  return r;
}

export function validateArtifact(files, m, digest) {
  same([...files.keys()].sort(), [...PAYLOADS].sort(), "partial artifact or extra paths");
  const receiptBytes = files.get("receipt.json");
  const r = validateReceipt(boundedJson(receiptBytes, limits.receipt, "receipt"), m, digest);
  validateMemo(files.get(PAYLOADS[0]), m.checkerLiterals, r.producer.stdout);
  requireThat(files.get("SHA256SUMS").length <= limits.sums, "sums limit");
  same(files.get("SHA256SUMS"), sums(files.get(PAYLOADS[0]), receiptBytes), "two-payload checksum bytes");
  return r;
}

export function preflightWorkflow(workflow, runs) {
  requireThat(workflow.path === WORKFLOW && workflow.state === "active", "workflow registration unavailable");
  integer(workflow.id, 1, Number.MAX_SAFE_INTEGER, "workflow ID");
  requireThat(Array.isArray(runs) && runs.every((r) => r.workflow_id === workflow.id), "foreign run inventory");
  requireThat(
    runs.every((r) => r.status === "completed"),
    "single flight: pending/in-flight refuses opening",
  );
  return {
    workflowId: workflow.id,
    path: workflow.path,
    state: workflow.state,
    runs,
    observedAt: new Date().toISOString(),
  };
}

export function acceptCompletedArtifact({ m, manifestSha256, freeze, currentPr, lifecycle, run, jobs, artifact, zip }) {
  requireThat(
    run.status === "completed" && run.conclusion === "success" && run.run_attempt === 1,
    "completed-success attempt1 required",
  );
  const files = readArtifactZip(zip);
  const r = validateArtifact(files, m, manifestSha256);
  requireThat(freeze.preflight, "pre-open registration inventory required");
  preflightWorkflow(
    { id: freeze.preflight.workflowId, path: freeze.preflight.path, state: freeze.preflight.state },
    freeze.preflight.runs,
  );
  requireThat(
    instant(freeze.preflight.observedAt, "preflight time") <= instant(freeze.observedAt, "freeze time"),
    "preflight precedes freeze",
  );
  same(run.workflow_id, freeze.preflight.workflowId, "registered workflow identity");
  requireThat(
    Array.isArray(lifecycle) && lifecycle.every((e) => !["closed", "reopened", "merged"].includes(e.event)),
    "reopen/closed lifecycle refuses original run",
  );
  same(freeze.head, r.event.head.commit, "pre-open D freeze");
  same(freeze.base, r.event.base.commit, "pre-open B freeze");
  same(freeze.input, m.E.commit, "pre-open E freeze");
  same(freeze.manifestSha256, manifestSha256, "pre-open manifest freeze");
  same(freeze.bodySha256, r.event.bodySha256, "pre-open body freeze");
  requireThat(
    instant(freeze.observedAt, "freeze time") <= instant(currentPr.created_at, "PR creation", true),
    "freeze must precede opening",
  );
  same(currentPr.number, r.event.prNumber, "PR identity");
  same(currentPr.head.sha, freeze.head, "synchronize/drift");
  same(currentPr.base.sha, freeze.base, "base drift");
  same(currentPr.body, `bootstrap-db-oracle-memo-input-sha256: ${manifestSha256}\n`, "body drift");
  same(currentPr.state, "open", "closed/reopened lifecycle must stop");
  same(currentPr.merged, false, "derivation PR never merged");
  same(run.head_sha, freeze.head, "run head D");
  same(run.path, WORKFLOW, "workflow path");
  same(run.event, "pull_request", "run event");
  same(run.repository.full_name, repository, "run repository");
  same(String(run.id), r.run.runId, "receipt run ID");
  same(run.head_branch, r.event.headRef, "head branch");
  const matches = jobs.filter(
    (j) => j.check_run_url === `https://api.github.com/repos/${repository}/check-runs/${r.run.checkRunId}`,
  );
  same(matches.length, 1, "exact-one numeric job/check join");
  same(jobs.filter((j) => j.name === "Derive Canonical Bootstrap Memo").length, 1, "exact-one owning job name");
  const job = matches[0];
  integer(job.id, 1, Number.MAX_SAFE_INTEGER, "job ID");
  requireThat(
    job.run_id === run.id &&
      job.run_attempt === 1 &&
      job.head_sha === freeze.head &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      job.name === "Derive Canonical Bootstrap Memo",
    "wrong/skipped/red job",
  );
  const jobStart = instant(job.started_at, "job start", true);
  const jobEnd = instant(job.completed_at, "job end", true);
  let previous = jobStart;
  let producerStep;
  for (const name of [
    "Admit immutable profile",
    "Verify clean input",
    "Run fixed producer",
    "Validate canonical payloads",
    "Upload canonical memo",
  ]) {
    const steps = job.steps.filter((s) => s.name === name);
    requireThat(
      steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success",
      `missing/skipped/red/duplicate step: ${name}`,
    );
    const step = steps[0];
    const start = instant(step.started_at, "step start", true);
    const end = instant(step.completed_at, "step end", true);
    requireThat(start >= previous && end >= start && end <= jobEnd, "step order/containment");
    previous = end;
    if (name === "Run fixed producer") producerStep = step;
  }
  const start = instant(r.producer.startedAt, "producer start");
  const end = instant(r.producer.completedAt, "producer end");
  requireThat(
    start >= jobStart &&
      end <= jobEnd + 999 &&
      start >= instant(producerStep.started_at, "producer step start", true) &&
      end <= instant(producerStep.completed_at, "producer step end", true) + 999,
    "producer outside owning execution",
  );
  integer(artifact.id, 1, Number.MAX_SAFE_INTEGER, "artifact ID");
  requireThat(
    artifact.expired === false && artifact.name === `bootstrap-db-oracle-memo-${run.id}-1`,
    "expired/foreign artifact",
  );
  same(artifact.workflow_run.id, run.id, "artifact run");
  same(artifact.workflow_run.head_sha, freeze.head, "artifact D");
  same(artifact.digest, `sha256:${sha256(zip)}`, "outer ZIP digest");
  same(artifact.size_in_bytes, zip.length, "archive size");
  requireThat(
    instant(artifact.created_at, "artifact creation", true) >= end - 999 &&
      instant(artifact.created_at, "artifact creation", true) <= jobEnd + 999 &&
      instant(artifact.expires_at, "artifact expiry", true) > Date.now(),
    "artifact timestamps",
  );
  return {
    kind: "accepted-deterministic-derivation",
    runUrl: `https://github.com/${repository}/actions/runs/${run.id}`,
    jobUrl: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,
    jobId: job.id,
    checkRunId: r.run.checkRunId,
    artifactUrl: `https://github.com/${repository}/actions/runs/${run.id}/artifacts/${artifact.id}`,
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    memoSha256: r.output.sha256,
    receiptSha256: sha256(files.get("receipt.json")),
    sumsSha256: sha256(files.get("SHA256SUMS")),
  };
}

export function checkApplication(m, publication, { objectRoot = root, acceptedMemoSha256 } = {}) {
  requireThat(hex(publication, 40) && hex(acceptedMemoSha256, 64), "immutable P/accepted digest");
  same(sha256(blob(objectRoot, publication, MEMO)), acceptedMemoSha256, "publication memo");
  for (const path of [PRODUCER, ORACLE, CHECKER, ...Object.values(m.fixtures).map((f) => f.path)])
    same(blob(objectRoot, publication, path), blob(objectRoot, m.E.commit, path), "publication input drift");
  return {
    kind: "application-probe-not-acceptance",
    publication,
    rawCheck: "PENDING_HOST",
    mergeGroupRawCheck: "PENDING_HOST",
    enrollmentAssertions: "PENDING_HOST",
    authority: "canonical-author-only; no automatic application or landing",
  };
}

export function collectPages(readApi, path, field) {
  const rows = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const response = readApi(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    integer(response.total_count, 0, 1000, "API total");
    if (total === undefined) total = response.total_count;
    same(response.total_count, total, "API inventory changed");
    requireThat(Array.isArray(response[field]) && response[field].length <= 100, "API page shape");
    rows.push(...response[field]);
    requireThat(rows.length <= total, "API total overflow");
    if (rows.length === total) {
      same(new Set(rows.map((r) => r.id)).size, rows.length, "API duplicate IDs");
      return rows;
    }
    same(response[field].length, 100, "partial API inventory");
  }
  throw Error("API pagination incomplete");
}

function api(path, binary = false) {
  const bytes = execFileSync("gh", ["api", `repos/${repository}/${path}`], {
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return binary ? bytes : JSON.parse(bytes);
}

export function discoverCompletedArtifact({ m, manifestSha256, freeze, runId, artifactId, readApi = api }) {
  requireThat(id(runId) && id(artifactId), "numeric run/artifact IDs");
  const run = readApi(`actions/runs/${runId}`);
  requireThat(
    run.status === "completed" &&
      run.conclusion === "success" &&
      run.run_attempt === 1 &&
      run.head_sha === freeze.head &&
      run.path === WORKFLOW &&
      run.event === "pull_request",
    "ineligible run before discovery/download",
  );
  const jobs = collectPages(readApi, `actions/runs/${runId}/attempts/1/jobs`, "jobs");
  const artifacts = collectPages(readApi, `actions/runs/${runId}/artifacts`, "artifacts");
  const matching = artifacts.filter((a) => a.name === `bootstrap-db-oracle-memo-${runId}-1`);
  same(matching.length, 1, "exact-one canonical artifact");
  same(String(matching[0].id), artifactId, "selected artifact ID");
  const zip = readApi(`actions/artifacts/${artifactId}/zip`, true);
  const r = validateArtifact(readArtifactZip(zip), m, manifestSha256);
  const merge = readApi(`git/commits/${r.event.merge.commit}`);
  same(merge.sha, r.event.merge.commit, "immutable G API identity");
  same(merge.tree.sha, r.event.merge.tree, "immutable G API tree");
  same(
    merge.parents.map((p) => p.sha),
    [r.event.base.commit, r.event.head.commit],
    "immutable G API parents",
  );
  const currentPr = readApi(`pulls/${r.event.prNumber}`);
  const lifecycle = [];
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const events = readApi(`issues/${r.event.prNumber}/events?per_page=100&page=${page}`);
    requireThat(Array.isArray(events) && events.length <= 100, "lifecycle page shape");
    lifecycle.push(...events);
    if (events.length < 100) {
      complete = true;
      break;
    }
  }
  requireThat(
    complete && new Set(lifecycle.map((e) => e.id)).size === lifecycle.length,
    "lifecycle incomplete/duplicate",
  );
  return {
    accepted: acceptCompletedArtifact({
      m,
      manifestSha256,
      freeze,
      currentPr,
      lifecycle,
      run,
      jobs,
      artifact: matching[0],
      zip,
    }),
    receipt: r,
  };
}

// merge-tree --write-tree with -z, --no-messages and an explicit --merge-base needs Git 2.40.
const mergeSupport = Object.freeze({ major: 2, minor: 40 });
const mergeLimits = Object.freeze({ output: 1024 * 1024, unmergedRecords: 192 });

export function spawnGit(directory, args, input = "") {
  return spawnSync("git", ["-C", directory, ...args], {
    input,
    maxBuffer: mergeLimits.output,
    windowsHide: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function gitStdout(runGit, directory, args, name, input) {
  const result = runGit(directory, args, input);
  requireThat(
    result && !result.error && !result.signal && result.status === 0 && Buffer.isBuffer(result.stdout),
    `${name}: unexpected Git exit or output`,
  );
  return result.stdout;
}

function requireCommits(runGit, directory, oids, name) {
  const input = oids.map((oid) => `${oid}\n`).join("");
  const rows = gitStdout(runGit, directory, ["cat-file", "--batch-check"], `${name} objects`, input)
    .toString("utf8")
    .split("\n");
  same(rows.pop(), "", `${name} objects: incomplete inventory`);
  same(rows.length, oids.length, `${name} objects: inventory count`);
  oids.forEach((oid, i) => {
    requireThat(rows[i] !== `${oid} missing`, `${name} missing object ${oid}`);
    requireThat(new RegExp(`^${oid} commit [1-9][0-9]*$`).test(rows[i]), `${name} non-commit object ${oid}`);
  });
}

function regularBlob(runGit, directory, treeish, path, name) {
  const listing = gitStdout(runGit, directory, ["ls-tree", "-z", "--full-tree", treeish, "--", path], name);
  const match = /^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listing.toString("utf8"));
  requireThat(match?.[2] === path, `missing/nonregular ${name}`);
  return match[1];
}

function probeMerge(runGit, directory, base, head) {
  const bases = gitStdout(runGit, directory, ["merge-base", "--all", base, head], "B/D merge-base")
    .toString("utf8")
    .split("\n");
  same(bases.pop(), "", "B/D merge-base: incomplete output");
  requireThat(bases.length === 1 && hex(bases[0], 40), "B/D merge-base unknown: multiple or malformed bases");
  const probe = runGit(directory, [
    "merge-tree",
    "--write-tree",
    "-z",
    "--no-messages",
    `--merge-base=${bases[0]}`,
    base,
    head,
  ]);
  // Exit 0 is clean and 1 is a conflict; any other exit, signal or spawn error leaves the result unknown.
  requireThat(
    probe && !probe.error && !probe.signal && [0, 1].includes(probe.status) && Buffer.isBuffer(probe.stdout),
    "B/D merge probe: unexpected Git exit",
  );
  const fields = probe.stdout.toString("utf8").split("\0");
  same(fields.pop(), "", "B/D merge probe: incomplete output");
  const tree = fields.shift();
  requireThat(hex(tree, 40), "B/D merge probe: malformed tree");
  if (probe.status === 0) {
    same(fields, [], "B/D merge probe: unexpected clean output");
    return { mergeBase: bases[0], tree };
  }
  requireThat(
    fields.length <= mergeLimits.unmergedRecords,
    "B/D merge conflict refuses opening: unmerged bound exceeded",
  );
  const paths = [];
  for (const record of fields) {
    const match = /^[0-7]{6} [a-f0-9]{40} [1-3]\t([^\0]+)$/.exec(record);
    requireThat(match, "B/D merge conflict refuses opening: malformed unmerged record");
    if (paths.at(-1) !== match[1]) paths.push(match[1]);
  }
  assert.fail(`B/D merge conflict refuses opening: ${paths.length} unmerged ${JSON.stringify(paths)}`);
}

function manifestTarget(runGit, directory, head) {
  const oid = regularBlob(runGit, directory, head, MANIFEST, "D manifest");
  const bytes = gitStdout(runGit, directory, ["cat-file", "blob", oid], "D manifest bytes");
  let m;
  try {
    m = boundedJson(bytes, limits.manifest, "manifest");
  } catch (error) {
    assert.fail(`unparsable D manifest: ${String(error?.message).split("\n")[0]}`);
  }
  same(m?.schema, INPUT_SCHEMA, "D manifest schema");
  same(m.repository, repository, "D manifest repository");
  commitTree(m.T, "D manifest T");
  return { T: m.T, manifestSha256: sha256(bytes) };
}

function liveCommit(readApi, ref) {
  const live = readApi(`git/ref/${ref}`);
  requireThat(
    live?.ref === `refs/${ref}` && live.object?.type === "commit" && hex(live.object.sha, 40),
    `live refs/${ref} unavailable`,
  );
  return live.object.sha;
}

/**
 * Pre-open guard: GitHub never runs the opened-only derivation for a conflicted B/D pair, so the
 * single opening would be spent with no run. The computed merge tree is a diagnostic, never G.
 * The live main/branch recheck is the last step, after the probe and the workflow comparison.
 */
export function preOpenMergeability({ base, head, branch, objectRoot = root, readApi = api, runGit = spawnGit }) {
  requireThat(hex(base, 40) && hex(head, 40) && base !== head, "exact distinct full 40-hex B/D OIDs required");
  text(branch, derivationBranch, 17, 255, "memo-derivation branch");
  const version = /^git version (\d+)\.(\d+)\./.exec(
    gitStdout(runGit, objectRoot, ["version"], "Git version").toString("utf8"),
  );
  requireThat(
    version &&
      (Number(version[1]) > mergeSupport.major ||
        (Number(version[1]) === mergeSupport.major && Number(version[2]) >= mergeSupport.minor)),
    "Git without merge-tree --write-tree --merge-base support",
  );
  requireCommits(runGit, objectRoot, [base, head], "B/D");
  const { mergeBase, tree } = probeMerge(runGit, objectRoot, base, head);
  const { T, manifestSha256 } = manifestTarget(runGit, objectRoot, head);
  requireCommits(runGit, objectRoot, [T.commit], "manifest T");
  const header = gitStdout(runGit, objectRoot, ["cat-file", "commit", T.commit], "manifest T commit");
  same(header.toString("utf8").split("\n", 1)[0], `tree ${T.tree}`, "manifest T tree");
  const workflowBlob = regularBlob(runGit, objectRoot, T.commit, WORKFLOW, "T workflow");
  for (const [name, treeish] of [
    ["B", base],
    ["D", head],
    ["merge tree", tree],
  ])
    same(
      regularBlob(runGit, objectRoot, treeish, WORKFLOW, `${name} workflow`),
      workflowBlob,
      "workflow blob differs across T/B/D/merge tree",
    );
  same(liveCommit(readApi, "heads/main"), base, "stale B: live main differs");
  same(liveCommit(readApi, `heads/${branch}`), head, "stale D: live derivation head differs");
  return {
    kind: "pre-open-mergeability-record",
    authority: "pre-open diagnostic only; diagnosticMergeTree is never G or opened-event authority",
    observedAt: new Date().toISOString(),
    base,
    head,
    branch,
    T,
    manifestSha256,
    mergeBase,
    result: "clean",
    unmergedPaths: [],
    diagnosticMergeTree: tree,
    workflow: { path: WORKFLOW, mode: "100644", blob: workflowBlob },
  };
}

export function parseCommand(args) {
  const [command, ...rest] = args;
  requireThat(
    ["admit", "verify-input", "derive", "validate", "preflight", "accept", "application", "mergeability"].includes(
      command,
    ),
    "explicit known command required",
  );
  if (["admit", "verify-input", "validate", "preflight"].includes(command)) same(rest, [], "no command overrides");
  if (command === "derive")
    same(
      rest,
      ["--out", "../artifacts/bootstrap-db-oracle-memo/bootstrap-db-oracle-schedule-memo.json"],
      "fixed producer/output only",
    );
  if (command === "accept") requireThat(rest.length === 2 && rest.every(id), "numeric run/artifact only");
  if (command === "application")
    requireThat(rest.length === 3 && hex(rest[0], 40) && rest.slice(1).every(id), "immutable P/run/artifact only");
  if (command === "mergeability")
    requireThat(
      rest.length === 3 &&
        hex(rest[0], 40) &&
        hex(rest[1], 40) &&
        rest[0] !== rest[1] &&
        derivationBranch.test(rest[2]),
      "full B/D OIDs and memo-derivation branch only",
    );
  return { command, rest };
}

export async function validateWorkloadBaseline(m, current, baselineValue, derivation) {
  const { checkBootstrapDbWorkloadFreshness, createBootstrapDbWorkloadBaseline } =
    await import("../deployables/platform-api/scripts/db-enrollment-workload.mjs");
  same(baselineValue.source.commit, m.S.commit, "baseline source S");
  const expected = createBootstrapDbWorkloadBaseline({
    captureFileName: m.fixtures.current.path.split("/").at(-1),
    captureBytes: Buffer.from(JSON.stringify(current)),
    source: baselineValue.source,
    derivation,
  });
  expected.capture.fixtureSha256 = m.fixtures.current.sha256;
  same(baselineValue, expected, "independent baseline values");
  const result = checkBootstrapDbWorkloadFreshness({
    baseline: baselineValue,
    capture: {
      fileName: m.fixtures.current.path.split("/").at(-1),
      fixtureSha256: m.fixtures.current.sha256,
      provenance: current.provenance,
    },
    derivation,
  });
  same(result.violations, [], "W1-W5 workload drift");
}

async function main(args) {
  const { command, rest } = parseCommand(args);
  if (command === "preflight") {
    const workflow = api(`actions/workflows/${WORKFLOW.split("/").at(-1)}`);
    const runs = collectPages(api, `actions/workflows/${workflow.id}/runs`, "workflow_runs");
    console.log(canonical(preflightWorkflow(workflow, runs)));
    return;
  }
  if (command === "mergeability") {
    const [base, head, branch] = rest;
    console.log(canonical(preOpenMergeability({ base, head, branch })));
    return;
  }
  const record = boundedJson(readFileSync(process.env.MEMO_BOOTSTRAP), limits.receipt, "receipt");
  const { manifest: m, manifestSha256, event } = record;
  parseManifest(Buffer.from(canonical(m)), manifestSha256);
  same(git(root, ["rev-parse", "HEAD"]).trim(), m.T.commit, "clean landed helper T");
  same(git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim(), "", "dirty helper T");
  const objectRoot = resolve(root, "../objects");
  const inputRoot = resolve(root, "../input");
  if (command === "accept" || command === "application") {
    const freeze = JSON.parse(readFileSync(process.env.MEMO_FREEZE));
    const result = discoverCompletedArtifact({
      m,
      manifestSha256,
      freeze,
      runId: rest.at(-2),
      artifactId: rest.at(-1),
    });
    same(result.receipt.event, record.event, "original captured event, never hydrated");
    same(result.receipt.run.workflowSha, record.workflowSha, "captured workflow context SHA");
    same(result.receipt.run.workflowRef, record.workflowRef, "captured workflow context ref");
    await admitProfile(m, { objectRoot, helperSha: m.T.commit, event: result.receipt.event, inputRoot });
    same(
      blob(objectRoot, record.workflowSha, WORKFLOW),
      blob(objectRoot, m.T.commit, WORKFLOW),
      "actual workflow context bytes",
    );
    console.log(
      canonical(
        command === "accept"
          ? result.accepted
          : checkApplication(m, rest[0], { objectRoot, acceptedMemoSha256: result.accepted.memoSha256 }),
      ),
    );
    return;
  }
  same(process.env.GITHUB_RUN_ATTEMPT, "1", "rerun refused");
  same(event.merge.commit, process.env.GITHUB_SHA, "actual runner G");
  if (command !== "validate") await admitProfile(m, { objectRoot, helperSha: m.T.commit, event, inputRoot });
  if (command === "admit") return;
  if (command === "verify-input") {
    const { deriveBootstrapDbWorkload } =
      await import("../deployables/platform-api/scripts/db-enrollment-workload.mjs");
    const derivation = await deriveBootstrapDbWorkload({ repositoryRoot: inputRoot });
    same(derivation.gaps, [], "W1-W5 derivation gaps");
    await validateWorkloadBaseline(
      m,
      JSON.parse(readFileSync(resolve(inputRoot, m.fixtures.current.path))),
      JSON.parse(readFileSync(resolve(inputRoot, m.fixtures.baseline.path))),
      derivation,
    );
    return;
  }
  const output = resolve(root, "../artifacts/bootstrap-db-oracle-memo");
  if (command === "validate") {
    const files = new Map(
      readdirSync(output).map((name) => {
        requireThat(lstatSync(resolve(output, name)).isFile(), "regular payload required");
        return [name, readFileSync(resolve(output, name))];
      }),
    );
    validateArtifact(files, m, manifestSha256);
    return;
  }
  same(process.version, m.toolchain.node, "installed Node");
  const pnpm = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  same(pnpm, m.toolchain.pnpm, "installed pnpm");
  const before = fingerprint(inputRoot, { excludeMemo: true });
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [resolve(inputRoot, PRODUCER)], {
    cwd: resolve(inputRoot, PLATFORM),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CHASE_SETS_LANE_MODE: "" },
  });
  requireThat(
    !result.error && result.status === 0 && !result.signal,
    "fixed producer failed; payload diagnostics withheld",
  );
  const completedAt = new Date().toISOString();
  const stdout = JSON.parse(result.stdout.trim());
  const memo = readFileSync(resolve(inputRoot, MEMO));
  validateMemo(memo, m.checkerLiterals, stdout);
  requireThat(["", MEMO].includes(git(inputRoot, ["diff", "--name-only"]).trim()), "only memo may change");
  same(git(inputRoot, ["ls-files", "--others", "--exclude-standard"]).trim(), "", "unexpected producer file");
  const after = fingerprint(inputRoot, { excludeMemo: true });
  same(before, after, "read closure changed");
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
    event,
    run: {
      repository: process.env.GITHUB_REPOSITORY,
      workflow: WORKFLOW,
      workflowRef: record.workflowRef,
      workflowSha: record.workflowSha,
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
  console.log(canonical({ kind: receipt.kind, memoSha256: sha256(memo), receiptSha256: sha256(receiptBytes) }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `STOP_TO_HOST: ${error instanceof assert.AssertionError ? error.message.split("\n")[0].slice(0, 160) : "memo input or operation refused"}; payloads withheld`,
    );
    process.exitCode = 1;
  }
}
