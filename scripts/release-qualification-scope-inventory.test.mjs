import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModuleResolutionContextFixture } from "./check-structure/module-resolution.mjs";
import { classifySqlExecutionSurface } from "./check-structure/sql-execution-surface.mjs";
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

const neutralityAuthorityPaths = [
  fileURLToPath(new URL("./release-qualification-scope.mjs", import.meta.url)),
  modulePath,
  sweepPath,
  fileURLToPath(new URL("./release-qualification-scope-applicability.mjs", import.meta.url)),
  // Governed membership and the evaluator's SQL classification share this provider.
  fileURLToPath(new URL("./check-structure/sql-execution-surface.mjs", import.meta.url)),
  // The classifier's import candidates and the evaluator's module resolution share this provider.
  fileURLToPath(new URL("./check-structure/module-resolution.mjs", import.meta.url)),
  fileURLToPath(new URL("./lib/repo.mjs", import.meta.url)),
  fileURLToPath(new URL("./lib/cli-options.mjs", import.meta.url)),
  fileURLToPath(new URL("../packages/typescript-compiler-api/index.mjs", import.meta.url)),
  fileURLToPath(new URL("../packages/typescript-compiler-api/package.json", import.meta.url)),
].map((file) => path.relative(repoRoot, file).split(path.sep).join("/"));

const neutralityLanding = "f20b825d973d485aac601c88d15af2a84483307c";
const neutralityFork = "0d0f2d9c7efb28f5f3217b801c4c8abd6bea64ce";
const extractionChanges = [
  "M",
  "scripts/release-qualification-scope-applicability.test.mjs",
  "A",
  "scripts/release-qualification-scope-inventory.mjs",
  "A",
  "scripts/release-qualification-scope-inventory.test.mjs",
  "M",
  "scripts/release-qualification-scope.test.mjs",
];
const extractionAdditions = [
  "scripts/release-qualification-scope-inventory.mjs",
  "scripts/release-qualification-scope-inventory.test.mjs",
];
const changedAuthorities = [
  "scripts/release-qualification-scope-inventory.mjs",
  "scripts/release-qualification-scope.test.mjs",
];

function assertPinnedExtractionNeutrality(readGit = git, output = emit) {
  const refuse = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  const read = (args, code) => {
    try {
      return readGit(args);
    } catch {
      refuse(code);
    }
  };
  const nulFields = (bytes, code) => {
    try {
      if (bytes.at(-1) !== 0) refuse(code);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, -1).split("\0");
    } catch {
      refuse(code);
    }
  };
  for (const sha of [neutralityFork, neutralityLanding])
    read(["cat-file", "-e", `${sha}^{commit}`], "INVENTORY_PINNED_OBJECT_MISSING");
  const parentage = read(["rev-list", "--parents", "-n", "1", neutralityLanding], "INVENTORY_PINNED_PARENTAGE_MISMATCH")
    .toString("utf8")
    .trim()
    .split(/\s+/);
  if (JSON.stringify(parentage) !== JSON.stringify([neutralityLanding, neutralityFork]))
    refuse("INVENTORY_PINNED_PARENTAGE_MISMATCH");
  const changes = nulFields(
    read(
      ["diff", "--name-status", "-z", "--no-renames", neutralityFork, neutralityLanding],
      "INVENTORY_PINNED_CHANGED_SET_MISMATCH",
    ),
    "INVENTORY_PINNED_CHANGED_SET_MISMATCH",
  );
  if (JSON.stringify(changes) !== JSON.stringify(extractionChanges)) refuse("INVENTORY_PINNED_CHANGED_SET_MISMATCH");
  const authorityBlobs = [];
  for (const file of neutralityAuthorityPaths.filter((file) => !changedAuthorities.includes(file))) {
    const blobs = [neutralityFork, neutralityLanding].map((sha) =>
      read(["rev-parse", `${sha}:${file}`], "INVENTORY_PINNED_AUTHORITY_BLOB_MISMATCH")
        .toString("utf8")
        .trim(),
    );
    if (!/^[a-f0-9]{40}$/.test(blobs[0]) || blobs[0] !== blobs[1]) refuse("INVENTORY_PINNED_AUTHORITY_BLOB_MISMATCH");
    authorityBlobs.push({ file, blob: blobs[0] });
  }
  for (const sha of [neutralityFork, neutralityLanding]) {
    const sweep = read(
      ["show", `${sha}:scripts/release-qualification-scope.test.mjs`],
      "INVENTORY_PINNED_COUNTS_MISMATCH",
    );
    const counts = /discovered: (\d+),\s+persistentCount: (\d+),\s+ruledCount: (\d+)/.exec(sweep.toString("utf8"));
    if (!counts || JSON.stringify(counts.slice(1)) !== JSON.stringify(["169", "163", "6"]))
      refuse("INVENTORY_PINNED_COUNTS_MISMATCH");
  }
  let names;
  try {
    names = [neutralityFork, neutralityLanding].map((sha) =>
      nulFields(
        readGit(["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]),
        "INVENTORY_PINNED_RAW_NAMES_MISMATCH",
      ),
    );
  } catch {
    refuse("INVENTORY_PINNED_RAW_NAMES_MISMATCH");
  }
  if (
    names.some((files) => files.some((file) => !file) || new Set(files).size !== files.length) ||
    JSON.stringify(names[1].slice().sort()) !== JSON.stringify([...names[0], ...extractionAdditions].sort())
  )
    refuse("INVENTORY_PINNED_RAW_NAMES_MISMATCH");
  // Accepted merge-group evidence, not a recomputation under today's classifier:
  // https://github.com/chase-sets/chase-sets/actions/runs/42475185780/job/128715144001
  const proof = {
    landing: neutralityLanding,
    fork: neutralityFork,
    objectsVerified: [neutralityFork, neutralityLanding],
    parentage,
    changes,
    authorityBlobs,
    rawNames: { fork: names[0].length, landing: names[1].length, additions: extractionAdditions },
    recordedMergeGroup: {
      counts: { discovered: 169, persistentRequired: 163, ruled: 6 },
      histogram: { not_applicable: 5, isolated: 1, persistent_required: 163 },
      canonicalSha256: "2188450a40f78193636aa80c9b436786673cba630fcdea5fa8ad0181a8f68607",
      governedMembers: 3091,
    },
  };
  output("INVENTORY_PINNED_EXTRACTION_NEUTRALITY", proof);
  return proof;
}

// Independent requirements survive omission from either the reader's list or its controls.
const requiredNeutralityAuthorityPaths = [
  "scripts/release-qualification-scope.mjs",
  "scripts/release-qualification-scope-inventory.mjs",
  "scripts/release-qualification-scope.test.mjs",
  "scripts/release-qualification-scope-applicability.mjs",
  "scripts/check-structure/sql-execution-surface.mjs",
  "scripts/check-structure/module-resolution.mjs",
  "scripts/lib/repo.mjs",
  "scripts/lib/cli-options.mjs",
  "packages/typescript-compiler-api/index.mjs",
  "packages/typescript-compiler-api/package.json",
];

it("pinned extraction retains every independently required authority", () => {
  expect(neutralityAuthorityPaths).toEqual(requiredNeutralityAuthorityPaths);
  expect(changedAuthorities).toEqual([
    "scripts/release-qualification-scope-inventory.mjs",
    "scripts/release-qualification-scope.test.mjs",
  ]);
});

const expectedHistory = {
  landing: "f20b825d973d485aac601c88d15af2a84483307c",
  fork: "0d0f2d9c7efb28f5f3217b801c4c8abd6bea64ce",
};
function historicalFixture() {
  const { landing, fork } = expectedHistory;
  const nul = (fields) => Buffer.from(`${fields.join("\0")}\0`);
  const names = [ruledPath, siblingPath, "scripts/release-qualification-scope.mjs"];
  return (args) => {
    if (
      JSON.stringify(args) === JSON.stringify(["cat-file", "-e", `${fork}^{commit}`]) ||
      JSON.stringify(args) === JSON.stringify(["cat-file", "-e", `${landing}^{commit}`])
    )
      return Buffer.alloc(0);
    if (JSON.stringify(args) === JSON.stringify(["rev-list", "--parents", "-n", "1", landing]))
      return Buffer.from(`${landing} ${fork}\n`);
    if (args[0] === "diff" && args.at(-2) === fork && args.at(-1) === landing)
      return nul([
        "M",
        "scripts/release-qualification-scope-applicability.test.mjs",
        "A",
        "scripts/release-qualification-scope-inventory.mjs",
        "A",
        "scripts/release-qualification-scope-inventory.test.mjs",
        "M",
        "scripts/release-qualification-scope.test.mjs",
      ]);
    if (
      args[0] === "rev-parse" &&
      [fork, landing].some((sha) => args[1].startsWith(`${sha}:`)) &&
      requiredNeutralityAuthorityPaths.includes(args[1].slice(41))
    )
      return Buffer.from(`${"a".repeat(40)}\n`);
    if (
      args[0] === "show" &&
      [fork, landing].some((sha) => args[1] === `${sha}:scripts/release-qualification-scope.test.mjs`)
    )
      return Buffer.from("discovered: 169, persistentCount: 163, ruledCount: 6");
    if (args[0] === "ls-tree" && [fork, landing].includes(args.at(-1)))
      return nul([
        ...names,
        ...(args.at(-1) === landing
          ? [
              "scripts/release-qualification-scope-inventory.mjs",
              "scripts/release-qualification-scope-inventory.test.mjs",
            ]
          : []),
      ]);
    throw new Error(`Unexpected synthetic Git call: ${JSON.stringify(args)}`);
  };
}

it("pinned extraction reads only exact ordered immutable Git objects", () => {
  const calls = [];
  const proof = assertPinnedExtractionNeutrality((args) => {
    calls.push(args);
    return execFileSync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  });
  const { landing, fork } = expectedHistory;
  expect(calls).toEqual([
    ["cat-file", "-e", `${fork}^{commit}`],
    ["cat-file", "-e", `${landing}^{commit}`],
    ["rev-list", "--parents", "-n", "1", landing],
    ["diff", "--name-status", "-z", "--no-renames", fork, landing],
    ...requiredNeutralityAuthorityPaths
      .filter(
        (file) =>
          ![
            "scripts/release-qualification-scope-inventory.mjs",
            "scripts/release-qualification-scope.test.mjs",
          ].includes(file),
      )
      .flatMap((file) => [
        ["rev-parse", `${fork}:${file}`],
        ["rev-parse", `${landing}:${file}`],
      ]),
    ["show", `${fork}:scripts/release-qualification-scope.test.mjs`],
    ["show", `${landing}:scripts/release-qualification-scope.test.mjs`],
    ["ls-tree", "-r", "-z", "--name-only", "--full-tree", fork],
    ["ls-tree", "-r", "-z", "--name-only", "--full-tree", landing],
  ]);
  expect(proof.rawNames).toEqual({
    fork: 9692,
    landing: 9694,
    additions: [
      "scripts/release-qualification-scope-inventory.mjs",
      "scripts/release-qualification-scope-inventory.test.mjs",
    ],
  });
});

it.each(["fork", "landing"])("pinned extraction missing %s object refuses, never skips", (role) => {
  const fixture = historicalFixture();
  const output = vi.fn();
  expect(() =>
    assertPinnedExtractionNeutrality((args) => {
      if (args[0] === "cat-file" && args[2] === `${expectedHistory[role]}^{commit}`) throw new Error("missing object");
      return fixture(args);
    }, output),
  ).toThrowError(expect.objectContaining({ code: "INVENTORY_PINNED_OBJECT_MISSING" }));
  expect(output).not.toHaveBeenCalled();
});

it("pinned extraction wrong parentage refuses instead of self-comparing", () => {
  const fixture = historicalFixture();
  expect(() =>
    assertPinnedExtractionNeutrality((args) =>
      args[0] === "rev-list" ? Buffer.from(`${expectedHistory.landing} ${expectedHistory.landing}\n`) : fixture(args),
    ),
  ).toThrowError(expect.objectContaining({ code: "INVENTORY_PINNED_PARENTAGE_MISMATCH" }));
});

it.each(["modified", "deleted", "mode-only", "renamed-away"])(
  "pinned extraction changed set refuses %s authority, including rename sources",
  (change) => {
    const fixture = historicalFixture();
    expect(() =>
      assertPinnedExtractionNeutrality((args) => {
        if (args[0] !== "diff") return fixture(args);
        const status = change === "deleted" || change === "renamed-away" ? "D" : "M";
        const extra =
          `${status}\0scripts/release-qualification-scope.mjs\0` +
          (change === "renamed-away" ? "A\0scripts/SYNTHETIC-renamed-authority.mjs\0" : "");
        return Buffer.concat([fixture(args), Buffer.from(extra)]);
      }),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_PINNED_CHANGED_SET_MISMATCH" }));
  },
);

it.each(
  requiredNeutralityAuthorityPaths.filter(
    (file) =>
      !["scripts/release-qualification-scope-inventory.mjs", "scripts/release-qualification-scope.test.mjs"].includes(
        file,
      ),
  ),
)("pinned extraction changed authority blob refuses: %s", (file) => {
  const fixture = historicalFixture();
  expect(() =>
    assertPinnedExtractionNeutrality((args) =>
      args[0] === "rev-parse" && args[1] === `${expectedHistory.landing}:${file}`
        ? Buffer.from("b".repeat(40))
        : fixture(args),
    ),
  ).toThrowError(expect.objectContaining({ code: "INVENTORY_PINNED_AUTHORITY_BLOB_MISMATCH" }));
});

it.each(["fork", "landing"])("pinned extraction %s sweep must retain 169/163/6", (role) => {
  const fixture = historicalFixture();
  expect(() =>
    assertPinnedExtractionNeutrality((args) =>
      args[0] === "show" && args[1].startsWith(expectedHistory[role])
        ? Buffer.from("discovered: 168, persistentCount: 162, ruledCount: 6")
        : fixture(args),
    ),
  ).toThrowError(expect.objectContaining({ code: "INVENTORY_PINNED_COUNTS_MISMATCH" }));
});

it.each(["added", "removed", "same-count move", "invalid UTF-8", "missing NUL"])(
  "pinned extraction complete raw names refuse %s, not merely count drift",
  (mode) => {
    const fixture = historicalFixture();
    expect(() =>
      assertPinnedExtractionNeutrality((args) => {
        const bytes = fixture(args);
        if (args[0] !== "ls-tree" || args.at(-1) !== expectedHistory.landing) return bytes;
        if (mode === "added") return Buffer.concat([bytes, Buffer.from("SYNTHETIC-extra.ts\0")]);
        if (mode === "invalid UTF-8") return Buffer.from([0xff, 0]);
        if (mode === "missing NUL") return bytes.subarray(0, -1);
        return Buffer.from(
          bytes.toString("utf8").replace(`${siblingPath}\0`, mode === "removed" ? "" : "SYNTHETIC-moved.ts\0"),
        );
      }),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_PINNED_RAW_NAMES_MISMATCH" }));
  },
);

it("pinned extraction ignores ambient classifier-byte edits, governed-member removal and HEAD/event changes", () => {
  const fixture = historicalFixture();
  const baseline = assertPinnedExtractionNeutrality(fixture, () => {});
  const calls = [];
  const ambientReader = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return Buffer.from(candidate.sha);
    if (args[0] === "show" && args[1] === `${candidate.sha}:scripts/release-qualification-scope.mjs`)
      return Buffer.from(`${cleanSource}// ambient classifier edit\n`);
    if (args[0] === "ls-tree" && args.at(-1) === candidate.sha) return Buffer.from(`${ruledPath}\0`);
    return fixture(args);
  };
  vi.stubEnv("GITHUB_EVENT_NAME", "pull_request");
  vi.stubEnv("GITHUB_SHA", candidate.sha);
  vi.stubEnv("GITHUB_EVENT_PATH", "SYNTHETIC-ambient-event.json");
  try {
    expect(assertPinnedExtractionNeutrality(ambientReader, () => {})).toEqual(baseline);
    expect(
      calls.some((args) => args.some((arg) => arg.includes(candidate.sha) || arg.includes(base.sha) || arg === "HEAD")),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("AC8/AC10/AC12 real inventory stays monotonic", () => {
  let provenance;
  try {
    provenance = deriveGuardCandidateProvenance();
  } catch (error) {
    emit("INVENTORY_CANDIDATE_ROLES_REFUSED", { code: error.code, reachedClause: error.reachedClause });
    throw error;
  }
  emit("INVENTORY_CANDIDATE_ROLES", { environment: provenance.environment, roles: provenance.roles });
  const head = provenance.roles.landingCandidate.sha;
  const inputs = discoveredInputs(head);
  expect(inputs.paths.length).toBeGreaterThan(0);
  expect(inputs.readFileAt("candidate", inputs.paths[0])).toBe(
    git(["show", `${head}:${inputs.paths[0]}`]).toString("utf8"),
  );
  const inventory = buildReviewedSurfaceInventory(inputs);
  expect(inventory.registryStatus).toBe("valid");
  expect(inventory.misses).toEqual([]);
  expect(health(inventory)).toBe(true);
  expect(health({ ...inventory, registryStatus: "unreadable" })).toBe(false);
  expect(health({ ...inventory, misses: ["SYNTHETIC current-health miss"] })).toBe(false);
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
});
