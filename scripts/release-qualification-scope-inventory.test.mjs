import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModuleResolutionContextFixture } from "./check-structure/module-resolution.mjs";
import { classifySqlExecutionSurface, listNonTestTypeScriptModules } from "./check-structure/sql-execution-surface.mjs";
import { deriveGuardCandidateProvenance } from "./check-structure/guard-candidate-provenance.mjs";
import { evaluateReleaseQualificationApplicability } from "./release-qualification-scope-applicability.mjs";
import {
  classifyReleaseQualificationScope,
  collectReleaseWorkflowScriptReferences,
  RELEASE_QUALIFICATION_SCOPE_CLASSES,
  releaseQualificationScopeRegistry,
} from "./release-qualification-scope.mjs";
import { buildReviewedSurfaceInventory } from "./release-qualification-scope-inventory.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const modulePath = fileURLToPath(new URL("./release-qualification-scope-inventory.mjs", import.meta.url));
const sweepPath = fileURLToPath(new URL("./release-qualification-scope.test.mjs", import.meta.url));
const ruledPath = "bounded-contexts/synthetic/features/referrals/domain/algebra.ts";
const siblingPath = "bounded-contexts/synthetic/features/referrals/domain/other.ts";
const cleanSource = "export const value = 1;\n";
const now = () => 1753100000000;
const base = { sha: "a".repeat(40), treeSha: "b".repeat(40) };
const candidate = { sha: "c".repeat(40), treeSha: "d".repeat(40) };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const emit = (label, value) => process.stdout.write(`${label} ${JSON.stringify(value)}\n`);
const git = (args) => execFileSync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const health = (inventory) => inventory.registryStatus === "valid" && inventory.misses.length === 0;
const exactMiss = (file = ruledPath) => `${file}: expected persistent_required, got isolated (application_runtime)`;
const roots = [];
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const applicability = () => freeze({ kind: "pure-module/v1", modules: [{ path: ruledPath, specifiers: [] }] });
const registryFor = (contract = applicability()) => ({
  ...releaseQualificationScopeRegistry,
  reviewedNonPersistentSurfaces: [
    {
      pattern: new RegExp(`^${ruledPath.replaceAll(".", "\\.")}$`),
      expectedClass: "isolated",
      rationale: "Synthetic pure module.",
      applicability: contract,
    },
  ],
});

function corpus(source = cleanSource, { omitSqlContracts = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "reviewed-inventory-"));
  roots.push(root);
  const files = {
    "pnpm-workspace.yaml": "packages: []\n",
    "contracts/event-core/event-store.ts": "export interface EventStore { readStream(stream: string): unknown }\n",
    "contracts/event-core/complete-stream.ts":
      "export interface CompleteStreamReader { readCompleteStream(stream: string): unknown }\n",
    "infrastructure/event-core-postgres/types.ts":
      "export interface PgQueryable { query(...args: unknown[]): unknown }\nexport interface PgPoolClient extends PgQueryable {}\nexport interface PgTransactionalPool extends PgQueryable {}\n",
    "infrastructure/event-core-postgres/index.ts": 'export * from "./types";\n',
    "bounded-contexts/synthetic/features/referrals/api/referral-code-reconciliation.ts": cleanSource,
    [ruledPath]: source,
    [siblingPath]: source,
  };
  if (omitSqlContracts) {
    delete files["infrastructure/event-core-postgres/types.ts"];
    delete files["infrastructure/event-core-postgres/index.ts"];
  }
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  const readFileAt = (_ref, file) => files[file] ?? null;
  const resolutionContext = buildModuleResolutionContextFixture({ files: Object.keys(files), packages: [] });
  const evaluateApplicability = (input) =>
    evaluateReleaseQualificationApplicability({
      ...input,
      repoRoot: root,
      readFile: (file) => files[file] ?? null,
      readFileAt,
      resolutionContext,
      sqlClassifier: (request) => classifySqlExecutionSurface({ ...request, repoRoot: root }),
    });
  return {
    root,
    files,
    resolutionContext,
    input: {
      paths: [ruledPath],
      readFileAt,
      registry: registryFor(),
      classify: classifyReleaseQualificationScope,
      evaluateApplicability,
      releaseWorkflowScriptReferences: new Set(),
      base,
      candidate,
      now,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

function admittedCheck(build, input) {
  const inventory = build(input);
  expect(inventory.registryStatus).toBe("valid");
  expect(inventory.records[0]).toMatchObject({
    expectedClass: "isolated",
    class: "isolated",
    applies: true,
    withdrawalCodes: [],
    miss: null,
  });
  expect(inventory.misses).toEqual([]);
  expect(health(inventory)).toBe(true);
  return inventory;
}

function withdrawnCheck(build, input) {
  const inventory = build(input);
  expect(inventory.registryStatus).toBe("valid");
  expect(inventory.records[0]).toMatchObject({
    expectedClass: "persistent_required",
    class: "isolated",
    applies: false,
    reasonCodes: ["application_runtime"],
    miss: exactMiss(),
  });
  expect(inventory.records[0].withdrawalCodes.length).toBeGreaterThan(0);
  expect(inventory.misses).toEqual([exactMiss()]);
  expect(health(inventory)).toBe(false);
  return inventory;
}

describe("reviewed surface inventory", () => {
  it("AC1 closes result, record and count keys and deduplicates paths", () => {
    const { input } = corpus();
    const inventory = admittedCheck(buildReviewedSurfaceInventory, { ...input, paths: [ruledPath, ruledPath] });
    expect(Reflect.ownKeys(inventory)).toEqual(["records", "misses", "counts", "registryStatus"]);
    expect(Reflect.ownKeys(inventory.records[0])).toEqual([
      "path",
      "matchedPattern",
      "applicabilityKind",
      "applies",
      "withdrawalCodes",
      "expectedClass",
      "class",
      "reasonCodes",
      "miss",
    ]);
    expect(inventory.counts).toEqual({ discovered: 1, persistentRequired: 0, ruled: 1 });
    expect(Reflect.ownKeys(inventory.counts)).toEqual(["discovered", "persistentRequired", "ruled"]);
  });

  it.each(
    ["g", "y"].flatMap((flags) =>
      [0, 7].flatMap((lastIndex) => [false, true].map((frozen) => ({ flags, lastIndex, frozen }))),
    ),
  )(
    "AC1 preserves stateful ruling purity ($flags, lastIndex=$lastIndex, frozen=$frozen)",
    ({ flags, lastIndex, frozen }) => {
      const { input } = corpus();
      const pattern = new RegExp(
        "^bounded-contexts/synthetic/features/referrals/domain/(?:algebra|other)\\.ts$",
        flags,
      );
      pattern.lastIndex = lastIndex;
      if (frozen) Object.freeze(pattern);
      const registry = registryFor(freeze({ kind: "path-scope/v0" }));
      registry.reviewedNonPersistentSurfaces[0].pattern = pattern;
      const evaluateApplicability = vi.fn(() => {
        throw new Error("path-scope evaluator must not run");
      });
      const request = { ...input, registry, evaluateApplicability };

      const first = buildReviewedSurfaceInventory(request);
      const firstLastIndex = pattern.lastIndex;
      const second = buildReviewedSurfaceInventory(request);

      expect(second).toEqual(first);
      expect(firstLastIndex).toBe(lastIndex);
      expect(pattern.lastIndex).toBe(lastIndex);
      expect(first.registryStatus).toBe("valid");
      expect(first.counts).toEqual({ discovered: 1, persistentRequired: 0, ruled: 1 });
      expect(first.misses).toEqual([]);
      expect(first.records[0]).toMatchObject({ matchedPattern: pattern.source, expectedClass: "isolated" });

      const multiple = buildReviewedSurfaceInventory({ ...request, paths: [ruledPath, siblingPath] });
      expect(multiple.counts).toEqual({ discovered: 2, persistentRequired: 0, ruled: 2 });
      expect(multiple.misses).toEqual([]);
      expect(multiple.records.map((record) => record.matchedPattern)).toEqual([pattern.source, pattern.source]);
      expect(multiple.records.map((record) => record.expectedClass)).toEqual(["isolated", "isolated"]);
      expect(pattern.lastIndex).toBe(lastIndex);
      expect(evaluateApplicability).not.toHaveBeenCalled();
    },
  );

  it("AC1 requires every capability, with no evaluator default", () => {
    const { input } = corpus();
    admittedCheck(buildReviewedSurfaceInventory, input);
    for (const key of Object.keys(input)) {
      const { [key]: _omitted, ...missing } = input;
      expect(() => buildReviewedSurfaceInventory(missing), key).toThrow(`Missing inventory capability: ${key}`);
    }
  });

  it("AC2/AC4 separates admitted and withdrawn health using the real classifier", () => {
    const admitted = corpus();
    const withdrawn = corpus('export async function load(store) { return store.readStream("s"); }\n');
    const good = admittedCheck(buildReviewedSurfaceInventory, admitted.input);
    const bad = withdrawnCheck(buildReviewedSurfaceInventory, withdrawn.input);
    const independent = classifyReleaseQualificationScope({
      ...withdrawn.input,
      changedFiles: [{ path: ruledPath, status: "modified" }],
    });
    expect(independent).toMatchObject({
      class: "isolated",
      reasonCodes: ["application_runtime"],
      generatedAt: new Date(now()).toISOString(),
    });
    emit(
      "INVENTORY_HEALTH_MATRIX",
      [good, bad].map((value) => ({
        expected: value.records[0].expectedClass,
        class: value.records[0].class,
        misses: value.misses,
        status: value.registryStatus,
        health: health(value),
        regression: "withdrawnCheck",
      })),
    );
  });

  it.each(["missing applicability", "unknown kind", "unfrozen specifier"])(
    "AC3 marks %s unreadable without invented misses",
    (name) => {
      const { input } = corpus();
      let registry;
      if (name === "missing applicability") {
        const { applicability: _omitted, ...entry } = input.registry.reviewedNonPersistentSurfaces[0];
        registry = { ...input.registry, reviewedNonPersistentSurfaces: [entry] };
      } else if (name === "unknown kind") registry = registryFor(freeze({ kind: "future/v9" }));
      else
        registry = registryFor(
          Object.freeze({
            kind: "pure-module/v1",
            modules: Object.freeze([
              Object.freeze({
                path: ruledPath,
                specifiers: Object.freeze([{ specifier: "node:crypto", binding: "value" }]),
              }),
            ]),
          }),
        );
      const inventory = buildReviewedSurfaceInventory({ ...input, registry });
      expect(inventory.registryStatus).toBe("unreadable");
      expect(inventory.misses).toEqual([]);
      expect(inventory.records).toHaveLength(1);
      expect(inventory.records[0]).toMatchObject({
        expectedClass: "persistent_required",
        class: "persistent_required",
        reasonCodes: ["unreadable_metadata"],
        miss: null,
      });
      expect(health(inventory)).toBe(false);
      emit("INVENTORY_MALFORMED", { name, inventory, health: health(inventory) });
    },
  );

  it.each([
    'export * from "../api/referral-code-reconciliation";\n',
    'export async function load(pool) { return pool.query("SELECT * FROM t"); }\n',
    'export async function load(store) { return store.readStream("s"); }\n',
  ])("AC5 original probe withdraws the ruling: %s", (source) => {
    const { input } = corpus(source);
    const inventory = withdrawnCheck(buildReviewedSurfaceInventory, input);
    const independent = input.classify({ ...input, changedFiles: [{ path: ruledPath, status: "modified" }] });
    expect(inventory.records[0].class).toBe(independent.class);
    expect(inventory.records[0].reasonCodes).toEqual(independent.reasonCodes);
    emit("INVENTORY_ORIGINAL_PROBE", { source, inventory, classifier: independent, health: health(inventory) });
    const restored = corpus();
    const green = admittedCheck(buildReviewedSurfaceInventory, restored.input);
    emit("INVENTORY_CONTENT_RESTORED", {
      sha256: digest(restored.files[ruledPath]),
      inventory: green,
      health: health(green),
    });
  });

  it.each(["removed", "moved"])("AC6 %s ruling defaults to persistent without calling the evaluator", (mode) => {
    const { input } = corpus();
    const evaluateApplicability = vi.fn(() => {
      throw new Error("unmatched evaluator");
    });
    const file = mode === "moved" ? siblingPath : ruledPath;
    const registry = mode === "removed" ? { ...input.registry, reviewedNonPersistentSurfaces: [] } : input.registry;
    const inventory = buildReviewedSurfaceInventory({ ...input, paths: [file], registry, evaluateApplicability });
    expect(inventory.records[0]).toMatchObject({
      matchedPattern: null,
      applicabilityKind: null,
      applies: false,
      expectedClass: "persistent_required",
      miss: exactMiss(file),
    });
    expect(inventory.misses).toEqual([exactMiss(file)]);
    expect(evaluateApplicability).not.toHaveBeenCalled();
  });

  it("AC7 preserves fail-closed polarity and the byte-identical original miss template", () => {
    const { input } = corpus();
    const inventory = buildReviewedSurfaceInventory({
      ...input,
      classify: () => ({ class: "persistent_required", reasonCodes: ["seed_bootstrap_import_reconciliation"] }),
    });
    expect(inventory.records[0].expectedClass).toBe("isolated");
    expect(inventory.misses).toEqual([]);
    expect(health(inventory)).toBe(true);
    const historical = git(["show", "2b80e185:scripts/release-qualification-scope.test.mjs"]).toString("utf8");
    const template = '`${filePath}: expected ${expected}, got ${record.class} (${record.reasonCodes.join(", ")})`';
    expect(historical).toContain(template);
    expect(readFileSync(modulePath, "utf8")).toContain(template);
  });

  it("AC8 withdrawn expectation is exactly persistent_required, never below its baseline", () => {
    const { input } = corpus('export async function load(store) { return store.readStream("s"); }\n');
    const inventory = withdrawnCheck(buildReviewedSurfaceInventory, input);
    const record = inventory.records[0];
    expect(RELEASE_QUALIFICATION_SCOPE_CLASSES.indexOf(record.expectedClass)).toBeGreaterThanOrEqual(
      RELEASE_QUALIFICATION_SCOPE_CLASSES.indexOf("isolated"),
    );
    expect(record.expectedClass).toBe("persistent_required");
    expect(RELEASE_QUALIFICATION_SCOPE_CLASSES).toContain(record.expectedClass);
  });

  it("AC9 path-scope preserves expectation and never evaluates", () => {
    const { input } = corpus();
    const evaluateApplicability = vi.fn(() => {
      throw new Error("path-scope evaluator");
    });
    const inventory = buildReviewedSurfaceInventory({
      ...input,
      registry: registryFor(freeze({ kind: "path-scope/v0" })),
      evaluateApplicability,
    });
    expect(inventory.records[0]).toMatchObject({
      applicabilityKind: "path-scope/v0",
      expectedClass: "isolated",
      applies: true,
      withdrawalCodes: [],
    });
    expect(evaluateApplicability).not.toHaveBeenCalled();
  });

  it("AC11 corpus has real SQL contracts; omitting them refuses", () => {
    const complete = corpus();
    admittedCheck(buildReviewedSurfaceInventory, complete.input);
    expect(complete.files["infrastructure/event-core-postgres/index.ts"]).toBe('export * from "./types";\n');
    const missing = corpus(cleanSource, { omitSqlContracts: true });
    expect(() => buildReviewedSurfaceInventory(missing.input)).toThrowError(
      expect.objectContaining({ code: "SQL_CONTRACT_MODULE_MISSING" }),
    );
    emit("INVENTORY_CORPUS_CONTRACTS", {
      declarations: ["PgQueryable", "PgPoolClient", "PgTransactionalPool"],
      missing: "SQL_CONTRACT_MODULE_MISSING",
    });
  });
});

function checkSweepWiring(source) {
  const start = source.indexOf(
    'it("classifies every discovered caller persistent_required unless a reviewed ruling covers it"',
  );
  const end = source.indexOf("\n  it(", start + 1);
  const sweep = source.slice(start, end);
  expect(sweep).toContain("buildReviewedSurfaceInventory({");
  expect(sweep).toContain("paths: discovered,");
  expect(sweep).toContain("readFileAt: realReadFileAt,");
  expect(sweep).toContain('expect(inventory.registryStatus).toBe("valid")');
  expect(sweep).toContain("expect(inventory.misses).toEqual([])");
  expect(sweep).not.toMatch(/\.find\(|misses\.push|ruling\?\.expectedClass/);
  return sweep;
}

it("AC2 sweep wiring uses real discovery, reader and verdict", () => {
  checkSweepWiring(readFileSync(sweepPath, "utf8"));
});

async function isolatedModule(source) {
  const root = mkdtempSync(path.join(tmpdir(), "reviewed-inventory-mutant-"));
  roots.push(root);
  const target = path.join(root, "inventory.mjs");
  const isolated = source.replace(
    /from "(\.\/[^"]+)"/g,
    (_match, specifier) => `from ${JSON.stringify(new URL(specifier, pathToFileURL(modulePath)).href)}`,
  );
  writeFileSync(target, isolated);
  let revision = 0;
  return {
    target,
    isolated,
    load: async (bytes) => {
      writeFileSync(target, bytes);
      return (await import(`${pathToFileURL(target).href}?revision=${revision++}`)).buildReviewedSurfaceInventory;
    },
  };
}

it.each([
  ["always applies", "evaluation.applies", "true", "withdrawn"],
  [
    "below baseline",
    'applies ? ruling.expectedClass : "persistent_required"',
    'applies ? ruling.expectedClass : "not_applicable"',
    "monotonic",
  ],
  [
    "no raise",
    'applies ? ruling.expectedClass : "persistent_required"',
    'applies ? ruling.expectedClass : "isolated"',
    "withdrawn",
  ],
  [
    "inverted polarity",
    'record.class !== "persistent_required"',
    'record.class === "persistent_required"',
    "persistent",
  ],
  ["ambient fs", "const records = [];", 'fs.readFileSync("SYNTHETIC-ambient-read"); const records = [];', "ambient"],
  [
    "ambient git",
    "const records = [];",
    'childProcess.execFileSync("git", ["rev-parse", "HEAD"]); const records = [];',
    "ambient",
  ],
])("AC1/AC2/AC7/AC8 mutant %s is red and restores exact bytes", async (name, before, after, mode) => {
  const original = readFileSync(modulePath, "utf8");
  const { input } = corpus(
    ["withdrawn", "monotonic"].includes(mode)
      ? 'export async function load(store) { return store.readStream("s"); }\n'
      : cleanSource,
  );
  const isolated = await isolatedModule(original);
  const check = (build) => {
    if (mode === "withdrawn") return withdrawnCheck(build, input);
    if (mode === "monotonic") {
      const result = build(input);
      expect(result.records[0]).toMatchObject({ applies: false });
      expect(result.records[0].withdrawalCodes.length).toBeGreaterThan(0);
      expect(RELEASE_QUALIFICATION_SCOPE_CLASSES.indexOf(result.records[0].expectedClass)).toBeGreaterThanOrEqual(
        RELEASE_QUALIFICATION_SCOPE_CLASSES.indexOf("isolated"),
      );
      return;
    }
    if (mode === "persistent") {
      const result = build({ ...input, classify: () => ({ class: "persistent_required", reasonCodes: [] }) });
      expect(result.misses).toEqual([]);
      return;
    }
    const stubInput = {
      ...input,
      evaluateApplicability: () => ({ applies: true, withdrawalCodes: [] }),
      classify: () => ({ class: "isolated", reasonCodes: ["application_runtime"] }),
    };
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ambient fs forbidden");
    });
    vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("ambient git forbidden");
    });
    syncBuiltinESMExports();
    try {
      admittedCheck(build, stubInput);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  };
  expect(isolated.isolated.split(before)).toHaveLength(2);
  let mutant = isolated.isolated.replace(before, after);
  if (name === "ambient fs") mutant = 'import fs from "node:fs";\n' + mutant;
  if (name === "ambient git") mutant = 'import childProcess from "node:child_process";\n' + mutant;
  try {
    check(await isolated.load(isolated.isolated));
    const build = await isolated.load(mutant);
    expect(() => check(build)).toThrow();
    emit("INVENTORY_MUTANT_RED", { name });
  } finally {
    const restored = await isolated.load(isolated.isolated);
    expect(digest(readFileSync(isolated.target))).toBe(digest(isolated.isolated));
    expect(digest(readFileSync(modulePath))).toBe(digest(original));
    check(restored);
    emit("INVENTORY_MUTANT_RESTORED_GREEN", {
      name,
      restoredFileSha256: digest(readFileSync(isolated.target)),
      sourceSha256: digest(readFileSync(modulePath)),
    });
  }
});

it.each([
  ["fixture-only paths", "paths: discovered,", 'paths: ["SYNTHETIC-fixture.ts"],'],
  ["fixture-only reader", "readFileAt: realReadFileAt,", 'readFileAt: () => "export const fixture = true;",'],
])("AC2 wiring mutant %s is red and exact restoration green", (name, before, after) => {
  const source = readFileSync(sweepPath, "utf8");
  const sweep = checkSweepWiring(source);
  expect(sweep.split(before)).toHaveLength(2);
  expect(() => checkSweepWiring(source.replace(sweep, sweep.replace(before, after)))).toThrow();
  expect(digest(readFileSync(sweepPath))).toBe(digest(source));
  checkSweepWiring(source);
  emit("INVENTORY_WIRING_RESTORED_GREEN", { name, sourceSha256: digest(readFileSync(sweepPath)) });
});

it("AC1 has no fs, child-process or process capability imports or ambient references", () => {
  const source = readFileSync(modulePath, "utf8");
  expect(source).not.toMatch(/node:(?:fs|child_process|process)|\bprocess\b/);
  const { input } = corpus();
  admittedCheck(buildReviewedSurfaceInventory, input);
});

function discoveredInputs(sha) {
  const tracked = git(["ls-tree", "-r", "-z", "--name-only", sha]).toString("utf8").split("\0").filter(Boolean);
  const excluded =
    /\.(?:md|mdx)$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__fixtures__|tests|test-support|fixtures)\//;
  const token =
    /(?:^|[-_./])(?:seed|seeds|seeding|bootstrap|reconcile|reconciliation|backfill)(?=[-_./]|$)|import-to-promotion|representative-commerce|integration-reset/i;
  const importCandidates = new Set(
    git(["grep", "-l", "-z", "-E", "runtime-support/seed|seed-support/|/seeding", sha, "--", "*.ts", "*.tsx", "*.mjs"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((file) => file.slice(sha.length + 1)),
  );
  const candidates = tracked.filter(
    (file) =>
      /^(?:bounded-contexts|contracts|deployables|infrastructure|scripts)\//.test(file) &&
      !excluded.test(file) &&
      (token.test(file) || importCandidates.has(file)),
  );
  const readable = tracked.filter(
    (file) => candidates.includes(file) || file === "package.json" || /^\.github\/(?:workflows|actions)\//.test(file),
  );
  const payload = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: readable.map((file) => `${sha}:${file}\n`).join(""),
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const contents = new Map();
  let offset = 0;
  for (const file of readable) {
    const newline = payload.indexOf(10, offset);
    expect(newline).toBeGreaterThanOrEqual(offset);
    const header = payload.toString("utf8", offset, newline).split(" ");
    expect(header[1]).toBe("blob");
    const size = Number(header[2]);
    expect(Number.isSafeInteger(size) && size >= 0).toBe(true);
    const start = newline + 1;
    expect(payload[start + size]).toBe(10);
    contents.set(file, payload.toString("utf8", start, start + size));
    offset = start + size + 1;
  }
  expect(offset).toBe(payload.length);
  const readFileAt = (_ref, file) => contents.get(file) ?? null;
  const seedImport = /from\s+["'][^"']*(?:runtime-support\/seed|seed-support\/|\/seeding)["']/;
  const paths = candidates.filter((file) => token.test(file) || seedImport.test(readFileAt("candidate", file) ?? ""));
  const releaseWorkflowScriptReferences = collectReleaseWorkflowScriptReferences({
    registry: releaseQualificationScopeRegistry,
    readFileAt,
  });
  return {
    paths,
    readFileAt,
    registry: releaseQualificationScopeRegistry,
    classify: classifyReleaseQualificationScope,
    evaluateApplicability: (input) =>
      evaluateReleaseQualificationApplicability({
        ...input,
        repoRoot,
        readFile: (file) => readFileAt("candidate", file),
        readFileAt,
        resolutionContext: buildModuleResolutionContextFixture({ files: tracked, packages: [] }),
        sqlClassifier: classifySqlExecutionSurface,
      }),
    releaseWorkflowScriptReferences,
    base,
    candidate,
    now,
  };
}

it("AC8/AC10/AC12 real inventory stays monotonic and canonical classifier records equal merge-base", () => {
  let provenance;
  try {
    provenance = deriveGuardCandidateProvenance();
  } catch (error) {
    emit("INVENTORY_CANDIDATE_ROLES_REFUSED", { code: error.code, reachedClause: error.reachedClause });
    throw error;
  }
  emit("INVENTORY_CANDIDATE_ROLES", { environment: provenance.environment, roles: provenance.roles });
  const head = provenance.roles.landingCandidate.sha;
  const fork = provenance.roles.forkPoint.sha;
  const inputs = discoveredInputs(head);
  const before = head === fork ? inputs : discoveredInputs(fork);
  const inventory = buildReviewedSurfaceInventory(inputs);
  expect(inventory.registryStatus).toBe("valid");
  expect(inventory.misses).toEqual([]);
  const without = buildReviewedSurfaceInventory({
    ...inputs,
    evaluateApplicability: () => ({ applies: true, withdrawalCodes: [] }),
  });
  expect(inventory.records).toHaveLength(inputs.paths.length);
  for (const [index, record] of inventory.records.entries()) {
    expect(RELEASE_QUALIFICATION_SCOPE_CLASSES.indexOf(record.expectedClass)).toBeGreaterThanOrEqual(
      RELEASE_QUALIFICATION_SCOPE_CLASSES.indexOf(without.records[index].expectedClass),
    );
  }
  const classifier = (input) =>
    input.paths
      .slice()
      .sort()
      .map((file) => ({
        path: file,
        ...input.classify({ ...input, changedFiles: [{ path: file, status: "modified" }] }),
      }));
  const records = classifier(inputs);
  const original = classifier(before);
  expect(records).toEqual(original);
  const histogram = (rows) =>
    Object.fromEntries(
      RELEASE_QUALIFICATION_SCOPE_CLASSES.map((kind) => [kind, rows.filter((row) => row.class === kind).length]),
    );
  expect(histogram(records)).toEqual(histogram(original));
  expect(digest(JSON.stringify(records))).toBe(digest(JSON.stringify(original)));
  expect(git(["show", `${head}:scripts/release-qualification-scope.mjs`])).toEqual(
    git(["show", `${fork}:scripts/release-qualification-scope.mjs`]),
  );
  const pinned = /discovered: (\d+),\s+persistentCount: (\d+),\s+ruledCount: (\d+)/.exec(
    git(["show", `${fork}:scripts/release-qualification-scope.test.mjs`]).toString("utf8"),
  );
  expect(pinned).not.toBeNull();
  expect(inventory.counts).toEqual({
    discovered: Number(pinned[1]),
    persistentRequired: Number(pinned[2]),
    ruled: Number(pinned[3]),
  });
  const tree = (sha) =>
    git(["rev-parse", `${sha}^{tree}`])
      .toString("utf8")
      .trim();
  if (head !== fork) expect(tree(head)).not.toBe(tree(fork));
  const raw = (sha) => git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]);
  const governed = (sha) => {
    const bytes = raw(sha);
    const names = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(bytes.at(-1)).toBe(0);
    return listNonTestTypeScriptModules(repoRoot, { execGit: () => names });
  };
  expect(governed(head)).toEqual(governed(fork));
  emit("INVENTORY_MERGE_BASE_NEUTRALITY", {
    head,
    mergeBase: fork,
    headTree: tree(head),
    baseTree: tree(fork),
    counts: inventory.counts,
    histogram: histogram(records),
    canonicalSha256: digest(JSON.stringify(records)),
    comparedPaths: inventory.records.length,
    governedMembers: governed(head).length,
  });
});
