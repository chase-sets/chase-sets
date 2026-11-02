import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { gunzipSync, gzipSync } from "node:zlib";

import ts from "@chase-sets/typescript-compiler-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type RunnerTestCase } from "vitest";

import {
  bootstrapDbEnrollmentManifest,
  bootstrapDbExecutionUnitBootBearingCaseCeilings,
  bootstrapDbMeasuredOneFewerUnitFloor,
  bootstrapDbScheduleModel,
  checkBootstrapDbEnrollment as evaluateBootstrapDbEnrollment,
  deriveBootstrapDbCaseIdentities,
  deriveBootstrapDbMeasuredOneFewerUnitFloor,
  derivePlatformApiDbTestCensus,
  formatBootstrapDbEnrollmentResult,
  platformApiNonBootstrapDbCensus,
  type BootstrapDbEnrollmentPartition,
  type BootstrapDbEnrollmentResult,
  type BootstrapDbMeasuredOneFewerUnitFloor,
  type BootstrapDbScheduleModel,
  type PlatformApiNonBootstrapDbCensus,
} from "../scripts/check-bootstrap-db-enrollment.mjs";
import {
  bindFrozenSourceToCapture,
  canonicalJson,
  checkBootstrapDbWorkloadFreshness,
  createBootstrapDbWorkloadBaseline,
  deriveBootstrapDbWorkload,
  formatBootstrapDbWorkloadBaseline,
  resolveApiDbWorkspaceConcurrency,
  type BootstrapDbWorkloadBaseline,
  type BootstrapDbWorkloadBinding,
  type BootstrapDbWorkloadCaptureBinding,
  type BootstrapDbWorkloadDerivation,
} from "../scripts/db-enrollment-workload.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "../../..");
// Historical timing captures remain immutable. The current 71-case capture binds
// all measured DB sources separately from this retained seed-command regression.
const seedCommandSourceSha256 = "a4add82973906e499b2d9e0cd8dbd399d5187323b0c66acf5157df3b82f8f356";
// Historical 39498669434 remains the immutable algorithm corpus. The current
// 39950765563 pair is bound separately to the declared floor.
// Each artifactDigest is the live `gh api .../actions/artifacts/<id> --jq .digest`
// probe taken 2026-10-23T12:30:00Z.
const historicalMeasuredFloorCaptures = Object.freeze({
  shipped: Object.freeze({
    fileName: "bootstrap-db-capture-39498669434.json",
    fixtureSha256: "87693854f8eff9c560f975885c39d847cdf064b8ecaea779861276a9bf8ddc7c",
    artifactDigest: "sha256:7d79c7ae24da85009ccb4109dc0531eac687c4677a7278abc5038d7c6492c9f7",
  }),
  paired: Object.freeze({
    fileName: "bootstrap-db-capture-39498669434-paired.json",
    fixtureSha256: "7d00325cf7cf6fdf0dc4f0efa947a883cd5ee5d170274219fd9b0f6ca70543ce",
    artifactDigest: "sha256:cc67c379c46b76bfd3479b9b0305e00cc8a04d9fc6078f4e30d7358ae5aa68ca",
  }),
});
const currentMeasuredFloorCaptures = Object.freeze({
  shipped: Object.freeze({
    fileName: "bootstrap-db-capture-41043769783.json",
    fixtureSha256: "a7d0015742db51a72aadb9558ecfceaf3042e628bcb79a35939f96c914e55d41",
    artifactDigest: "sha256:75437a79c474c53835eef3d65701479a346527bb253fdcfeb8632ad80664a7c4",
  }),
  paired: Object.freeze({
    fileName: "bootstrap-db-capture-41043769783-paired.json",
    fixtureSha256: "045afbc491c371edfdf14025af68e1944a8c61e29af66eb3b17d221c12edfaa9",
    artifactDigest: "sha256:a967b5bf3df6fc0b34b94ce8f5f5f3fc0e1fcdee0502e33ea5d07a1457ac1016",
  }),
});
// Generate fixture code, not an environment read by this non-DB test module.
const syntheticDatabaseUrlKey = ["TEST", "DATABASE", "URL"].join("_");
const syntheticDatabaseUrlRead = `process.env.${syntheticDatabaseUrlKey}`;

const temporaryRoots: string[] = [];
const guardInputs = new Map<string, unknown>();
const guardClasses = new Map<string, Set<string>>();
let currentTest: RunnerTestCase | undefined;

function checkBootstrapDbEnrollment(...args: Parameters<typeof evaluateBootstrapDbEnrollment>) {
  const result = evaluateBootstrapDbEnrollment(...args);
  const input = {
    files: result.schedule.files,
    model: result.schedule.files.length ? (args[0]?.scheduleModel ?? bootstrapDbScheduleModel) : null,
    observedUnitCount: result.schedule.observedUnitCount,
    fileCount: result.fileCount,
  };
  const key = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  guardInputs.set(key, input);
  if (currentTest) {
    const classes = guardClasses.get(currentTest.id) ?? new Set<string>();
    classes.add(key);
    guardClasses.set(currentTest.id, classes);
  }
  return result;
}

type FixtureCase = Readonly<{ name: string; referenceDurationMs: number; body: string; timeoutMs?: number }>;
type FixtureFile = Readonly<{
  fileName: string;
  databaseSuffix: string;
  executionUnit: string;
  bootBearingCases?: "all" | readonly string[];
  cases: readonly FixtureCase[];
}>;
type FixtureManifest = Record<string, BootstrapDbEnrollmentPartition>;
type ScheduleModelProvenanceField =
  | "referenceRunId"
  | "referenceJobId"
  | "referenceJobName"
  | "referenceHeadSha"
  | "referenceEvent";
type ScheduleModelTimingField = Exclude<keyof BootstrapDbScheduleModel, ScheduleModelProvenanceField>;
type SyntheticScheduleModelTimingOverrides = Partial<Pick<BootstrapDbScheduleModel, ScheduleModelTimingField>>;
type Fixture = Readonly<{
  root: string;
  manifest: FixtureManifest;
  ceilings: Record<string, number>;
  model: BootstrapDbScheduleModel;
  nonBootstrapCensus: PlatformApiNonBootstrapDbCensus;
}>;

const syntheticScheduleModelProvenance = Object.freeze({
  referenceRunId: 65_440_001,
  referenceJobId: 65_440_002,
  referenceJobName: "Synthetic DB Profile Tests",
  referenceHeadSha: "0000000000000000000000000000000000006544",
  referenceEvent: "synthetic_control",
} satisfies Pick<BootstrapDbScheduleModel, ScheduleModelProvenanceField>);

const syntheticScheduleModelTiming = Object.freeze({
  maxWorkersPerExecutionUnit: 3,
  testFileFixedCostMs: 1_248,
  executionUnitFixedCostMs: 10_051,
  jobOverheadMs: 48_000,
  executionUnitCeilingMs: 420_000,
  aggregateCeilingMs: 1_080_000,
  maximumCaseReferenceDurationMs: 600_000,
  maximumScheduledFileCount: 11,
  maximumEnumeratedUnitCount: 4,
} satisfies Pick<BootstrapDbScheduleModel, ScheduleModelTimingField>);

function createSyntheticScheduleModel(
  overrides: Readonly<Record<PropertyKey, unknown>> = {},
): BootstrapDbScheduleModel {
  return {
    ...syntheticScheduleModelTiming,
    ...syntheticScheduleModelProvenance,
    ...overrides,
  } as BootstrapDbScheduleModel;
}

function partitionSource(file: FixtureFile): string {
  const cases = file.cases.map((testCase) => {
    const timeout = testCase.timeoutMs === undefined ? "" : `, ${testCase.timeoutMs}`;
    return `it(${JSON.stringify(testCase.name)}, async () => {\n${testCase.body}\n}${timeout});`;
  });
  return [
    'import { expect, it } from "vitest";',
    'import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";',
    `createPlatformApiBootstrapTestHarness(${JSON.stringify(file.databaseSuffix)});`,
    ...cases,
  ].join("\n");
}

/**
 * Builds a real workspace root on disk — sources, a vitest configuration, and a
 * package manifest — so every control below is planted through the guard's own
 * discovery rather than by calling an internal helper. Identity values are
 * derived from the fixture's own parsed sources and frozen into the fixture
 * manifest, which is exactly how the shipped manifest was produced.
 */
async function createFixture(
  files: readonly FixtureFile[],
  options: Readonly<{
    ceilings?: Record<string, number>;
    model?: SyntheticScheduleModelTimingOverrides;
    extraSources?: Readonly<Record<string, string>>;
    mutatePackageJson?: (packageJson: { scripts: Record<string, string> }) => void;
  }> = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "platform-api-bootstrap-enrollment-"));
  temporaryRoots.push(root);
  const testDirectory = join(root, "__tests__");
  await mkdir(testDirectory);

  await writeFile(
    join(root, "vitest.config.ts"),
    ["export default {", "  test: {", '    include: ["__tests__/**/*.test.ts"],', "  },", "};", ""].join("\n"),
  );
  await writeFile(
    join(testDirectory, "bootstrap-db-test-support.ts"),
    "export function createPlatformApiBootstrapTestHarness(_suffix: string): void {}\n",
  );
  for (const [fileName, source] of Object.entries(options.extraSources ?? {})) {
    await writeFile(join(testDirectory, fileName), source);
  }
  for (const file of files) {
    await writeFile(join(testDirectory, file.fileName), partitionSource(file));
  }

  const unitNames = [...new Set(files.map((file) => file.executionUnit))].sort((left, right) =>
    left.localeCompare(right, "en", { numeric: true }),
  );
  const excludeArguments = files.map((file) => `--exclude __tests__/${file.fileName}`).join(" ");
  const packageJson = {
    scripts: {
      "test:fast": `vitest run ${excludeArguments}`,
      "test:unit": `vitest run ${excludeArguments}`,
      ...Object.fromEntries(
        unitNames.map((unitName) => [
          unitName,
          `vitest run ${files
            .filter((file) => file.executionUnit === unitName)
            .map((file) => `__tests__/${file.fileName}`)
            .join(" ")} --maxWorkers=3`,
        ]),
      ),
    },
  };
  options.mutatePackageJson?.(packageJson);
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson, null, 2));

  const ceilings =
    options.ceilings ??
    Object.fromEntries(
      unitNames.map((unitName) => [
        unitName,
        files
          .filter((file) => file.executionUnit === unitName)
          .reduce(
            (count, file) =>
              count +
              (file.bootBearingCases === undefined || file.bootBearingCases === "all"
                ? file.cases.length
                : file.bootBearingCases.length),
            0,
          ),
      ]),
    );
  const model = createSyntheticScheduleModel({ ...options.model, ...syntheticScheduleModelProvenance });

  const identities = new Map<string, string>();
  for (const file of files) {
    for (const { name, identity } of deriveBootstrapDbCaseIdentities(file.fileName, partitionSource(file))) {
      if (!identities.has(name)) identities.set(name, identity);
    }
  }

  return {
    root,
    manifest: buildManifest(files, (name) => identities.get(name) ?? "0000000000000000"),
    ceilings,
    model,
    nonBootstrapCensus: { referenceRunId: model.referenceRunId, referenceJobId: model.referenceJobId, entries: {} },
  };
}

async function createShippedFixture(
  files: readonly FixtureFile[],
  options: Parameters<typeof createFixture>[1] = {},
): Promise<Fixture> {
  return createFixture(files, {
    ...options,
    model: { maximumScheduledFileCount: 12, ...options.model },
  });
}

function buildManifest(files: readonly FixtureFile[], identityFor: (caseName: string) => string): FixtureManifest {
  return Object.fromEntries(
    files.map((file) => [
      file.fileName,
      {
        executionUnit: file.executionUnit as BootstrapDbEnrollmentPartition["executionUnit"],
        databaseSuffix: file.databaseSuffix,
        bootBearingCases: file.bootBearingCases ?? "all",
        cases: file.cases.map((testCase) => ({
          name: testCase.name,
          referenceDurationMs: testCase.referenceDurationMs,
          identity: identityFor(testCase.name),
        })),
      } satisfies BootstrapDbEnrollmentPartition,
    ]),
  );
}

function runFixture(fixture: Fixture) {
  return checkBootstrapDbEnrollment({
    platformApiRoot: fixture.root,
    manifest: fixture.manifest,
    executionUnitBootBearingCaseCeilings: fixture.ceilings,
    scheduleModel: fixture.model,
    nonBootstrapCensus: fixture.nonBootstrapCensus,
  });
}

async function editScripts(fixture: Fixture, edit: (scripts: Record<string, string>) => void) {
  const path = join(fixture.root, "package.json");
  const packageJson = JSON.parse(await readFile(path, "utf8"));
  edit(packageJson.scripts);
  await writeFile(path, JSON.stringify(packageJson));
}

async function writeEntry(fixture: Fixture, entry: string, source: string) {
  const path = join(fixture.root, entry);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}

async function createDbCensusFixture(): Promise<Fixture> {
  const fixture = await createShippedFixture(shippedShapedFiles(), { model: acceptedTimingInputs() });
  const entries = platformApiNonBootstrapDbCensus.entries;
  for (const entry of Object.keys(entries)) {
    await writeEntry(fixture, entry, `const url = ${syntheticDatabaseUrlRead};\n`);
  }
  await editScripts(fixture, (scripts) => {
    for (const [entry, unit] of Object.entries(entries)) {
      scripts[unit] += ` ${entry}`;
      for (const name of ["test:unit", "test:fast"]) scripts[name] += ` --exclude ${entry}`;
    }
  });
  return underAcceptedScheduleModel({ ...fixture, nonBootstrapCensus: { ...fixture.nonBootstrapCensus, entries } });
}

/** The shipped file set, case names, durations, and unit membership, with synthetic bodies. */
function shippedShapedFiles(): FixtureFile[] {
  return Object.entries(bootstrapDbEnrollmentManifest).map(([fileName, partition]) => ({
    fileName,
    databaseSuffix: partition.databaseSuffix,
    executionUnit: partition.executionUnit,
    bootBearingCases: partition.bootBearingCases,
    cases: partition.cases.map((testCase, index) => ({
      name: testCase.name,
      referenceDurationMs: testCase.referenceDurationMs,
      body: `  expect(${index}).toBe(${index});`,
    })),
  }));
}

function acceptedTimingInputs(): SyntheticScheduleModelTimingOverrides {
  return {
    testFileFixedCostMs: bootstrapDbScheduleModel.testFileFixedCostMs,
    executionUnitFixedCostMs: bootstrapDbScheduleModel.executionUnitFixedCostMs,
    jobOverheadMs: bootstrapDbScheduleModel.jobOverheadMs,
  };
}

/**
 * A fixture built with acceptedTimingInputs(), under the accepted schedule model
 * itself. Only that model's reference run binds the declared measured
 * one-fewer-unit floor; the swap changes provenance and nothing else.
 */
function underAcceptedScheduleModel(fixture: Fixture): Fixture {
  const { referenceRunId, referenceJobId, referenceJobName, referenceHeadSha, referenceEvent } =
    bootstrapDbScheduleModel;
  const provenance = { referenceRunId, referenceJobId, referenceJobName, referenceHeadSha, referenceEvent };
  expect({ ...fixture.model, ...provenance }).toEqual({ ...bootstrapDbScheduleModel });
  return {
    ...fixture,
    model: bootstrapDbScheduleModel,
    nonBootstrapCensus: { ...fixture.nonBootstrapCensus, referenceRunId, referenceJobId },
  };
}

type MeasuredCapture = {
  provenance: Record<string, unknown>;
  model: BootstrapDbScheduleModel;
  files: {
    fileName: string;
    testPath: string;
    executionUnit: string;
    sourceSha256: string;
    cases: { name: string; identity: string; durationMs: number; referenceDurationMs: number }[];
  }[];
  nonBootstrapFiles: { testPath: string; sourceSha256: string }[];
  sourceBindings: Record<string, string>;
};
type MeasuredCaptures = { shipped: MeasuredCapture; paired: MeasuredCapture };

function readMeasuredCaptures(): MeasuredCaptures {
  const read = ({ fileName }: { fileName: string }) =>
    JSON.parse(readFileSync(join(testDirectory, "fixtures", fileName), "utf8")) as MeasuredCapture;
  return {
    shipped: read(historicalMeasuredFloorCaptures.shipped),
    paired: read(historicalMeasuredFloorCaptures.paired),
  };
}

function readCurrentMeasuredCaptures(): MeasuredCaptures {
  const read = ({ fileName }: { fileName: string }) =>
    JSON.parse(readFileSync(join(testDirectory, "fixtures", fileName), "utf8")) as MeasuredCapture;
  return {
    shipped: read(currentMeasuredFloorCaptures.shipped),
    paired: read(currentMeasuredFloorCaptures.paired),
  };
}

/** Capture 39498669434's measured workload, optionally reassigned, with synthetic bodies. */
function shippedCaptureFiles(reassigned: Readonly<Record<string, string>> = {}): FixtureFile[] {
  return readMeasuredCaptures().shipped.files.map((file) => ({
    ...bootstrapDbEnrollmentManifest[file.fileName]!,
    fileName: file.fileName,
    executionUnit: reassigned[file.fileName] ?? file.executionUnit,
    cases: file.cases.map((testCase, index) => ({ ...testCase, body: `  expect(${index}).toBe(${index});` })),
  }));
}

/** That workload under the capture's own model and run. */
async function shippedCaptureFixture(reassigned: Readonly<Record<string, string>> = {}): Promise<Fixture> {
  const { shipped } = readMeasuredCaptures();
  const fixture = await createShippedFixture(shippedCaptureFiles(reassigned), { model: shipped.model });
  const { referenceRunId, referenceJobId } = shipped.model;
  return { ...fixture, model: shipped.model, nonBootstrapCensus: { referenceRunId, referenceJobId, entries: {} } };
}

function singleWorkerModel(): SyntheticScheduleModelTimingOverrides {
  return { maxWorkersPerExecutionUnit: 1, testFileFixedCostMs: 0, executionUnitFixedCostMs: 0 };
}

function unitFileFor(name: string, executionUnit: string, referenceDurationMs: number): FixtureFile {
  return {
    fileName: `${name}.db.test.ts`,
    databaseSuffix: `platform_api_${name.replaceAll("-", "_")}`,
    executionUnit,
    cases: [{ name: `${name} case`, referenceDurationMs, body: "  expect(1).toBe(1);" }],
  };
}

function exhaustiveScheduleProbe(bypassFileBound = false) {
  const source = readFileSync(join(testDirectory, "../scripts/check-bootstrap-db-enrollment.mjs"), "utf8");
  const start = source.indexOf("function worstCaseListScheduleMs(");
  const end = source.indexOf("// Manifest shape validation.");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  let algorithm = source.slice(start, end);
  if (bypassFileBound) {
    const boundary = "if (files.length > model.maximumScheduledFileCount)";
    expect(algorithm.split(boundary)).toHaveLength(2);
    algorithm = algorithm.replace(boundary, "if (false)");
  }
  return runInNewContext(`${algorithm}\n({ computeMinimumUnitCount, canonicalAssignments })`) as {
    computeMinimumUnitCount: (
      files: readonly { fileName: string; durationMs: number }[],
      model: BootstrapDbScheduleModel,
    ) => {
      minimumUnitCount: number | null;
      refusal: string | null;
      witness?: { files: { fileName: string; durationMs: number }[]; makespanMs: number }[];
    };
    canonicalAssignments: (length: number, blockCount: number) => Generator<number[]>;
  };
}

type ScheduleFile = { fileName: string; durationMs: number };
type ScheduleProbe = {
  worstCaseListScheduleMs: (durations: readonly number[], workers: number) => number;
  computeMinimumUnitCount: (files: ScheduleFile[], model: BootstrapDbScheduleModel) => unknown;
  bestAssignmentAt: (files: ScheduleFile[], count: number, model: BootstrapDbScheduleModel) => unknown;
  calculateMinimumAndOneFewer?: (
    files: ScheduleFile[],
    model: BootstrapDbScheduleModel,
    observe?: (phase: string, count: number, assignment: number[]) => void,
  ) => unknown;
  canonicalAssignments: (length: number, count: number) => Generator<number[]>;
};

async function cachedCompleteOracle() {
  const builderUrl = pathToFileURL(join(testDirectory, "fixtures/bootstrap-db-oracle-schedule-memo.mjs"));
  const { createPinnedOracleModuleSource } = await import(builderUrl.href);
  const oracleUrl = pathToFileURL(join(testDirectory, "fixtures/bootstrap-db-schedule-before-subset-reuse.mjs"));
  const source = readFileSync(oracleUrl, "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b",
  );
  // Keep every oracle assignment and its independent scheduler. Only calls
  // with identical ordered durations and worker counts share a pinned result.
  // This does not use the candidate's file-subset cache or scheduling code.
  const moduleSource = createPinnedOracleModuleSource(
    source,
    `
const uncachedListSchedule = worstCaseListScheduleMs;
const results = new Map();
export const schedulerCalls = { hits: 0, misses: 0 };
export const requestedKeys = new Set();
export function preload(entries) {
  results.clear();
  for (const [key, value] of Object.entries(entries)) results.set(key, value);
  requestedKeys.clear();
  schedulerCalls.hits = 0;
  schedulerCalls.misses = 0;
}
worstCaseListScheduleMs = (durations, workers) => {
  const key = JSON.stringify([workers, durations]);
  requestedKeys.add(key);
  if (results.has(key)) {
    schedulerCalls.hits += 1;
    return results.get(key);
  }
  schedulerCalls.misses += 1;
  const result = uncachedListSchedule(durations, workers);
  results.set(key, result);
  return result;
};
export { worstCaseListScheduleMs };
`,
  );
  return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);
}

function exactScheduleProbes(): { old: ScheduleProbe; candidate: ScheduleProbe } {
  const oraclePath = join(testDirectory, "fixtures/bootstrap-db-schedule-before-subset-reuse.mjs");
  const oracleSource = readFileSync(oraclePath, "utf8");
  expect(createHash("sha256").update(oracleSource).digest("hex")).toBe(
    "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b",
  );
  const candidateSource = readFileSync(join(testDirectory, "../scripts/check-bootstrap-db-enrollment.mjs"), "utf8");
  function extract(source: string): ScheduleProbe {
    const start = source.indexOf("function worstCaseListScheduleMs(");
    const end = source.indexOf("// Manifest shape validation.", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return runInNewContext(
      `${source.slice(start, end)}\n({ worstCaseListScheduleMs, computeMinimumUnitCount, bestAssignmentAt, canonicalAssignments, calculateMinimumAndOneFewer: typeof calculateMinimumAndOneFewer === 'function' ? calculateMinimumAndOneFewer : undefined })`,
    ) as ScheduleProbe;
  }
  return { old: extract(oracleSource), candidate: extract(candidateSource) };
}

function scheduleVerdict(probe: ScheduleProbe, files: ScheduleFile[], model: BootstrapDbScheduleModel) {
  const minimum = probe.computeMinimumUnitCount(files, model) as {
    minimumUnitCount: number | null;
    witness?: { makespanMs: number }[];
  };
  const alternatives = Array.from({ length: Math.min(files.length, model.maximumEnumeratedUnitCount) }, (_, index) =>
    probe.bestAssignmentAt(files, index + 1, model),
  );
  const oneFewerUnit =
    minimum.minimumUnitCount && minimum.minimumUnitCount > 1 ? alternatives[minimum.minimumUnitCount - 2] : null;
  return {
    minimum,
    alternatives,
    serialized: JSON.stringify({
      minimum,
      aggregateWithOverheadMs: minimum.witness
        ? minimum.witness.reduce((sum, unit) => sum + unit.makespanMs, model.jobOverheadMs)
        : null,
      oneFewerUnit,
      alternatives,
    }),
  };
}

function expectSharedScheduleEquivalence(
  old: ScheduleProbe,
  candidate: ScheduleProbe,
  files: ScheduleFile[],
  model: BootstrapDbScheduleModel,
  oldVerdict: ReturnType<typeof scheduleVerdict>,
) {
  const observed: string[] = [];
  const result = candidate.calculateMinimumAndOneFewer!(files, model, (phase, count, assignment) => {
    observed.push(`${phase}:${count}:${assignment.join("")}`);
  }) as {
    oneFewer: unknown;
    minimumUnitCount: number | null;
    witness?: { files: ScheduleFile[] }[];
    refusal: string | null;
  };
  const { oneFewer, ...minimum } = result;
  const expectedMinimum = oldVerdict.minimum as typeof minimum;
  const expectedOneFewer =
    expectedMinimum.minimumUnitCount && expectedMinimum.minimumUnitCount > 1
      ? oldVerdict.alternatives[expectedMinimum.minimumUnitCount - 2]
      : null;
  expect(JSON.stringify(minimum)).toBe(JSON.stringify(expectedMinimum));
  expect(JSON.stringify(oneFewer)).toBe(JSON.stringify(expectedOneFewer));

  const expected: string[] = [];
  if (expectedMinimum.minimumUnitCount || expectedMinimum.refusal?.startsWith("no execution-unit count up to")) {
    const maximum = expectedMinimum.minimumUnitCount ?? Math.min(files.length, model.maximumEnumeratedUnitCount);
    for (let count = 1; count <= maximum; count += 1) {
      for (const assignment of old.canonicalAssignments(files.length, count)) {
        expected.push(`minimum:${count}:${assignment.join("")}`);
        const groups = Array.from({ length: count }, () => [] as string[]);
        assignment.forEach((unit, index) => groups[unit]!.push(files[index]!.fileName));
        if (
          count === expectedMinimum.minimumUnitCount &&
          JSON.stringify(groups) ===
            JSON.stringify(expectedMinimum.witness!.map((unit) => unit.files.map((file) => file.fileName)))
        )
          break;
      }
    }
  }
  if (expectedMinimum.minimumUnitCount && expectedMinimum.minimumUnitCount > 1) {
    const count = expectedMinimum.minimumUnitCount - 1;
    for (const assignment of old.canonicalAssignments(files.length, count))
      expected.push(`oneFewer:${count}:${assignment.join("")}`);
  }
  expect(observed).toEqual(expected);
}

let liveWorkloadDerivation: Promise<BootstrapDbWorkloadDerivation> | undefined;

function liveWorkload() {
  liveWorkloadDerivation ??= deriveBootstrapDbWorkload({ repositoryRoot });
  return liveWorkloadDerivation;
}

function readWorkloadBaseline(provenance: Readonly<Record<string, unknown>>): BootstrapDbWorkloadBaseline {
  const fileName = `db-enrollment-workload-${String(provenance.runId)}.json`;
  return JSON.parse(readFileSync(join(testDirectory, "fixtures", fileName), "utf8")) as BootstrapDbWorkloadBaseline;
}

function sha256Of(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const noFloor = "no measured one-fewer-unit floor is declared";
// The retained shipped model's minimality violation without a floor.
const minimalityViolation =
  "the shipped topology spends 3 execution units where the schedule model's minimumUnitCount for the same " +
  "file set is 2; execution units of one workspace run serially, so an unnecessary unit is spent aggregate budget";
/**
 * The pinned historical guard predates the measured one-fewer-unit floor. When
 * the floor does not apply, the additive schedule fields follow from its result
 * and the named reason, so each comparison against it stays complete.
 */
function withUnappliedMeasuredFloor<T extends { schedule: { minimumUnitCount: number | null } }>(
  result: T,
  reason: string,
) {
  return {
    ...result,
    schedule: {
      ...result.schedule,
      effectiveMinimumUnitCount: result.schedule.minimumUnitCount,
      measuredOneFewerUnitFloor: { applied: false, reason },
    },
  };
}

// The current schedule model's own minimum unit count for the current manifest.
// Capture-derived: an enrollment refreshes it with the projected schedule pins.
const currentMinimumUnitCount = 3;
const currentProjectedMakespans = [332818, 309120, 235517];
const derivedShippedAssignment: Readonly<Record<string, "test:db:1" | "test:db:2" | "test:db:3">> = Object.freeze({
  "bootstrap-production-reconciliation.db.test.ts": "test:db:1",
  "authoritative-seed-resume-core.db.test.ts": "test:db:1",
  "authoritative-seed-resume-reconciliation.db.test.ts": "test:db:1",
  "connector-mount-gate-isolation.db.test.ts": "test:db:2",
  "bootstrap-lock-contention.db.test.ts": "test:db:2",
  "seed-command-full-pools.db.test.ts": "test:db:2",
  "bootstrap-scenario.db.test.ts": "test:db:2",
  "catalog-seed-aggregate-state.db.test.ts": "test:db:2",
  "bootstrap-shared-seed-command.db.test.ts": "test:db:2",
  "inventory-seed-resume.db.test.ts": "test:db:3",
  "catalog-seed-interruption-resume.db.test.ts": "test:db:3",
  "authoritative-seed-resume-recovery.db.test.ts": "test:db:3",
});
const derivedBootBearingCaseCeilings = Object.freeze({ "test:db:1": 18, "test:db:2": 32, "test:db:3": 19 });

function minimalityViolationFor(observedUnitCount: number, minimumUnitCount: number) {
  return (
    `the shipped topology spends ${observedUnitCount} execution units where the schedule model's ` +
    `minimumUnitCount for the same file set is ${minimumUnitCount}; execution units of one workspace run ` +
    "serially, so an unnecessary unit is spent aggregate budget"
  );
}

/**
 * One enrollment's default-path result, its null-floor counterfactual, and the
 * committed data its floor role follows from: the declared floor, the schedule
 * model, and the pinned model minimum.
 */
type DefaultPathEnrollment = Readonly<{
  result: BootstrapDbEnrollmentResult;
  absent: BootstrapDbEnrollmentResult;
  floor: BootstrapDbMeasuredOneFewerUnitFloor | null;
  model: BootstrapDbScheduleModel;
  minimumUnitCount: number;
}>;

function defaultPathEnrollment(
  minimumUnitCount: number,
  options: NonNullable<Parameters<typeof evaluateBootstrapDbEnrollment>[0]> = {},
): DefaultPathEnrollment {
  return {
    result: checkBootstrapDbEnrollment(options),
    absent: checkBootstrapDbEnrollment({ ...options, measuredOneFewerUnitFloor: null }),
    floor: options.measuredOneFewerUnitFloor ?? bootstrapDbMeasuredOneFewerUnitFloor,
    model: (options.scheduleModel ?? bootstrapDbScheduleModel) as BootstrapDbScheduleModel,
    minimumUnitCount,
  };
}

function floorBindsModel(floor: BootstrapDbMeasuredOneFewerUnitFloor | null, model: BootstrapDbScheduleModel) {
  return floor !== null && floor.shippedReferenceRunId === model.referenceRunId;
}

/** The default path's floor verdict, formatted from the declared floor and the schedule model alone. */
function expectedMeasuredFloorVerdict(
  floor: BootstrapDbMeasuredOneFewerUnitFloor | null,
  model: BootstrapDbScheduleModel,
) {
  if (floor === null) return { applied: false, reason: noFloor };
  if (!floorBindsModel(floor, model)) {
    return {
      applied: false,
      reason:
        `the measured one-fewer-unit floor binds shipped reference run ${floor.shippedReferenceRunId}, not the ` +
        `schedule model's ${model.referenceRunId}`,
    };
  }
  const [unit, makespanMs] = Object.entries(floor.unitMakespansMs).reduce((worst, entry) =>
    entry[1] > worst[1] ? entry : worst,
  );
  return {
    applied: true,
    reason:
      `measured capture run ${floor.pairedReferenceRunId} projects ${unit} at ${makespanMs}ms, above the ` +
      `${model.executionUnitCeilingMs}ms per-unit ceiling, at ${floor.unitCount} units`,
  };
}

const declaredFloorUnbound = bootstrapDbMeasuredOneFewerUnitFloor
  ? expectedMeasuredFloorVerdict(bootstrapDbMeasuredOneFewerUnitFloor, {
      ...bootstrapDbScheduleModel,
      referenceRunId: syntheticScheduleModelProvenance.referenceRunId,
    }).reason
  : noFloor;
const declaredFloorModelRefused = bootstrapDbMeasuredOneFewerUnitFloor
  ? "the schedule model refused, so the measured one-fewer-unit floor is not applied"
  : noFloor;

const measuredFloorLine = "  measured one-fewer-unit floor";

/**
 * The default path's floor role. Whether the declared floor binds the schedule
 * model's reference run decides it: bound, the floor lifts the pinned model
 * minimum to the shipped unit count; unbound, the model must already be minimal.
 * Either way the null-floor run differs only in that role. Each clause names
 * itself in its failure.
 */
function expectDefaultPathFloorRole({ result, absent, floor, model, minimumUnitCount }: DefaultPathEnrollment) {
  const { observedUnitCount } = result.schedule;
  const verdict = expectedMeasuredFloorVerdict(floor, model);
  const floorLines = formatBootstrapDbEnrollmentResult(result)
    .split("\n")
    .filter((line) => line.startsWith(measuredFloorLine));
  expect(result.violations, "default-path violations").toEqual([]);
  expect(result.schedule.minimumUnitCount, "pinned minimum").toBe(minimumUnitCount);
  expect(result.schedule.effectiveMinimumUnitCount, "effective minimum").toBe(observedUnitCount);
  if (floorBindsModel(floor, model)) {
    expect(result.schedule.measuredOneFewerUnitFloor, "bound floor verdict").toEqual(verdict);
    expect(floorLines, "bound floor line").toEqual([
      `${measuredFloorLine} applied: ${verdict.reason}; effectiveMinimumUnitCount ${observedUnitCount}`,
    ]);
  } else {
    expect(minimumUnitCount, "unbound floor minimum").toBe(observedUnitCount);
    expect(result.schedule.measuredOneFewerUnitFloor, "unbound floor verdict").toEqual(verdict);
    expect(floorLines, "unbound floor line").toEqual([]);
  }
  const absentViolations =
    minimumUnitCount < observedUnitCount ? [minimalityViolationFor(observedUnitCount, minimumUnitCount)] : [];
  expect(absent.violations, "null-floor violations").toEqual(absentViolations);
  expect(absent, "null-floor counterfactual").toEqual(
    withUnappliedMeasuredFloor({ ...result, violations: absentViolations }, noFloor),
  );
}

/** One fewer than the shipped unit count is infeasible: a bound floor measured it, else the model projects it. */
function expectOneFewerUnitInfeasible({ result, floor, model, minimumUnitCount }: DefaultPathEnrollment) {
  const { observedUnitCount, oneFewerUnit, measuredOneFewerUnitFloor } = result.schedule;
  const ceilingMs = model.executionUnitCeilingMs;
  if (floorBindsModel(floor, model)) {
    const { unitCount, unitMakespansMs } = floor!;
    expect(unitCount, "floor witness unit count").toBe(observedUnitCount - 1);
    expect(Math.max(...Object.values(unitMakespansMs)), "floor witness worst unit").toBeGreaterThan(ceilingMs);
  } else {
    expect(oneFewerUnit?.unitCount, "model witness unit count").toBe(observedUnitCount - 1);
  }
  // The model's own alternative is one fewer than its minimum, so it is the witness when unbound.
  expect(oneFewerUnit?.unitCount, "model alternative unit count").toBe(minimumUnitCount - 1);
  const alternativeWorstMs = Math.max(...(oneFewerUnit?.units ?? []).map((unit) => unit.makespanMs));
  expect(alternativeWorstMs, "model alternative worst unit").toBeGreaterThan(ceilingMs);
  expect(measuredOneFewerUnitFloor.applied, "floor applied").toBe(floorBindsModel(floor, model));
}

function withBindings(
  baseline: BootstrapDbWorkloadBaseline,
  edit: (bindings: BootstrapDbWorkloadBinding[]) => BootstrapDbWorkloadBinding[],
): BootstrapDbWorkloadBaseline {
  const bindings = edit([...baseline.bindings]);
  return { ...baseline, bindings, bindingsSha256: sha256Of(canonicalJson(bindings)) };
}

type WorkloadEdit = string | null | ((source: string) => string);

function replaceOnce(from: string, to: string) {
  return (source: string) => {
    expect(source.split(from), from).toHaveLength(2);
    return source.replace(from, to);
  };
}

function editCase(
  select: (call: ts.CallExpression) => boolean,
  edit: (call: ts.CallExpression, source: string) => string,
) {
  return (source: string) => {
    const { found } = caseCallExpressions(source);
    const match = found.find(({ node }) => select(node));
    expect(match).toBeDefined();
    return edit(match!.node, source);
  };
}

const editFirstCaseCallback = editCase(
  (call) => Boolean(call.arguments[1] && ts.isArrowFunction(call.arguments[1]) && ts.isBlock(call.arguments[1].body)),
  (call, source) => {
    const body = (call.arguments[1] as ts.ArrowFunction).body;
    const at = body.getStart() + 1;
    return `${source.slice(0, at)}\n    expect(1).toBe(1);${source.slice(at)}`;
  },
);

const editFirstCaseTimeout = editCase(
  (call) => Boolean(call.arguments[2] && ts.isNumericLiteral(call.arguments[2])),
  (call, source) => {
    const timeout = call.arguments[2]!;
    return `${source.slice(0, timeout.getStart())}240_000${source.slice(timeout.getEnd())}`;
  },
);

/**
 * A disposable view of this checkout with `edits` applied (`null` deletes).
 * Directories on an edited path are real; every other entry links to the
 * checkout, which is never written. Links are removed, not followed, on
 * cleanup, and `.git` is absent, so derivation cannot lean on history.
 */
async function createWorkloadMirror(edits: Readonly<Record<string, WorkloadEdit>>): Promise<string> {
  const mirror = await mkdtemp(join(tmpdir(), "db-enrollment-workload-"));
  temporaryRoots.push(mirror);
  const edited = Object.keys(edits);
  async function populate(path: string) {
    for (const name of await readdir(join(repositoryRoot, path))) {
      const child = path ? `${path}/${name}` : name;
      if (name === ".git" || child in edits) continue;
      const source = join(repositoryRoot, child);
      const target = join(mirror, child);
      if (edited.some((editedPath) => editedPath.startsWith(`${child}/`))) {
        await mkdir(target);
        await populate(child);
      } else if ((await stat(source)).isDirectory()) {
        await symlink(source, target, "junction");
      } else {
        await copyFile(source, target);
      }
    }
  }
  await populate("");
  for (const [path, edit] of Object.entries(edits)) {
    const original = existsSync(join(repositoryRoot, path)) ? readFileSync(join(repositoryRoot, path), "utf8") : null;
    if (edit === null) {
      expect(original, path).not.toBeNull();
      continue;
    }
    const content = typeof edit === "function" ? edit(original ?? "") : edit;
    expect(content, path).not.toBe(original);
    await mkdir(dirname(join(mirror, path)), { recursive: true });
    await writeFile(join(mirror, path), content);
  }
  return mirror;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Platform API bootstrap DB enrollment", () => {
  beforeEach(({ task }) => {
    currentTest = task;
  });

  afterAll(({}, suite) => {
    for (const [key, input] of guardInputs)
      process.stdout.write(`bootstrap-enrollment-input ${JSON.stringify({ key, input })}\n`);
    for (const task of suite.tasks) {
      if (task.type !== "test" || task.mode !== "run") continue;
      process.stdout.write(
        `bootstrap-enrollment-case ${JSON.stringify({
          name: task.name,
          state: task.result?.state,
          durationMs: task.result?.duration,
          classes: [...(guardClasses.get(task.id) ?? [])],
        })}\n`,
      );
    }
  });

  it("matches the pinned list scheduler for zero, distinct, repeated and reordered durations on up to five workers", () => {
    const { old, candidate } = exactScheduleProbes();
    const vectors = [
      [],
      [0, 0, 0, 0, 0, 0],
      [0, 1, 0, 2, 0, 3],
      [-1, -2, -3],
      [3, 3, 3, -100],
      new Array<number>(31).fill(7),
      [7, 7, 7, 7, 7, 7, 7],
      [1, 2, 3, 5, 8, 13, 21],
      [23, 2, 19, 5, 17, 7, 13, 11],
    ];
    for (const vector of vectors)
      for (const durations of [vector, [...vector].reverse()])
        for (let workers = 1; workers <= 5; workers += 1) {
          Object.freeze(durations);
          expect(candidate.worstCaseListScheduleMs(durations, workers)).toBe(
            old.worstCaseListScheduleMs(durations, workers),
          );
        }
  });

  it("preserves the pinned complete guard's projections for refused references and oversized file sets", async () => {
    const old = await import(
      pathToFileURL(join(testDirectory, "fixtures/bootstrap-db-schedule-before-subset-reuse.mjs")).href
    );
    for (const durations of [[-100, 3, 3, 3], new Array<number>(31).fill(7)]) {
      const fixture = await createFixture(
        durations.map((duration, index) => unitFileFor(`refused-reference-${index}`, "test:db:1", duration)),
        { model: { testFileFixedCostMs: 0, executionUnitFixedCostMs: 0, maxWorkersPerExecutionUnit: 2 } },
      );
      const result = runFixture(fixture);
      const violation = durations.some((duration) => duration < 0) ? "referenceDurationMs" : "declared bound";
      expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining(violation)]));
      expect(JSON.parse(JSON.stringify(result))).toEqual(
        JSON.parse(
          JSON.stringify(
            withUnappliedMeasuredFloor(
              old.checkBootstrapDbEnrollment({
                platformApiRoot: fixture.root,
                manifest: fixture.manifest,
                executionUnitBootBearingCaseCeilings: fixture.ceilings,
                scheduleModel: fixture.model,
              }),
              violation === "declared bound" ? declaredFloorModelRefused : declaredFloorUnbound,
            ),
          ),
        ),
      );
    }
  });

  it.each([
    { label: "unsafe duration", durations: [9007199254740992, 1, 1], makespanMs: 9007199254740994 },
    { label: "unsafe total", durations: [9007199254740991, 2, 2], makespanMs: 9007199254740996 },
  ])("preserves the pinned complete guard's projections for a refused $label", async ({ durations, makespanMs }) => {
    const old = await import(
      pathToFileURL(join(testDirectory, "fixtures/bootstrap-db-schedule-before-subset-reuse.mjs")).href
    );
    for (const ordered of [durations, [...durations].reverse()]) {
      const fixture = await createFixture(
        ordered.map((duration, index) => unitFileFor(`synthetic-unsafe-reference-${index}`, "test:db:1", duration)),
        { model: { testFileFixedCostMs: 0, executionUnitFixedCostMs: 0, maxWorkersPerExecutionUnit: 1 } },
      );
      const result = runFixture(fixture);
      expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining("referenceDurationMs")]));
      expect(result.schedule.units[0]?.makespanMs).toBe(makespanMs);
      expect(JSON.parse(JSON.stringify(result))).toEqual(
        JSON.parse(
          JSON.stringify(
            withUnappliedMeasuredFloor(
              old.checkBootstrapDbEnrollment({
                platformApiRoot: fixture.root,
                manifest: fixture.manifest,
                executionUnitBootBearingCaseCeilings: fixture.ceilings,
                scheduleModel: fixture.model,
              }),
              declaredFloorModelRefused,
            ),
          ),
        ),
      );
    }
  });

  it.each([0, 1, 2, 3, 4])(
    "exact subset schedule equivalence across ordered-vector/model pairs of length %i",
    (length) => {
      const { old, candidate } = exactScheduleProbes();
      const started = performance.now();
      let pairs = 0;
      for (let vector = 0; vector < 3 ** length; vector += 1) {
        let digits = vector;
        const files = Array.from({ length }, (_, index) => {
          const durationMs = (digits % 3) + 1;
          digits = Math.floor(digits / 3);
          return { fileName: `indexed-${index}`, durationMs };
        });
        for (let workers = 1; workers <= 3; workers += 1)
          for (let units = 1; units <= 4; units += 1)
            for (let fixedCost = 0; fixedCost <= 1; fixedCost += 1)
              for (let overhead = 0; overhead <= 1; overhead += 1)
                for (const unitCeiling of [2, 4, 8])
                  for (const aggregateCeiling of [3, 7, 15]) {
                    const model = createSyntheticScheduleModel({
                      maxWorkersPerExecutionUnit: workers,
                      maximumEnumeratedUnitCount: units,
                      executionUnitFixedCostMs: fixedCost,
                      jobOverheadMs: overhead,
                      executionUnitCeilingMs: unitCeiling,
                      aggregateCeilingMs: aggregateCeiling,
                    });
                    const expected = scheduleVerdict(old, files, model);
                    const actual = scheduleVerdict(candidate, files, model);
                    if (actual.serialized !== expected.serialized)
                      throw new Error(
                        `schedule differs at pair ${pairs}: ${expected.serialized} vs ${actual.serialized}`,
                      );
                    expectSharedScheduleEquivalence(old, candidate, files, model, expected);
                    pairs += 1;
                  }
      }
      expect(pairs).toBe(3 ** length * 432);
      for (let count = 1; count <= length; count += 1)
        expect([...candidate.canonicalAssignments(length, count)]).toEqual([
          ...old.canonicalAssignments(length, count),
        ]);
      console.info(`exact subset length ${length}: ${pairs} pairs in ${(performance.now() - started).toFixed(1)} ms`);
    },
  );

  it("covers all 52272 exact subset pairs without sampling", () => {
    expect([0, 1, 2, 3, 4].reduce((pairs, length) => pairs + 3 ** length * 432, 0)).toBe(52_272);
  });

  it("exact subset schedule equivalence under adversarial changes between invocations", () => {
    const { old, candidate } = exactScheduleProbes();
    const files = Array.from({ length: 5 }, (_, index) => ({ fileName: `distinct-${index}`, durationMs: 3 }));
    const model = createSyntheticScheduleModel({
      maxWorkersPerExecutionUnit: 2,
      executionUnitFixedCostMs: 1,
      jobOverheadMs: 1,
      executionUnitCeilingMs: 8,
      aggregateCeilingMs: 15,
    }) as { -readonly [Key in keyof BootstrapDbScheduleModel]: BootstrapDbScheduleModel[Key] };
    const compare = () => {
      const expected = scheduleVerdict(old, files, model);
      expect(scheduleVerdict(candidate, files, model).serialized).toBe(expected.serialized);
      expectSharedScheduleEquivalence(old, candidate, files, model, expected);
    };
    compare();
    files.reverse();
    files[0]!.durationMs = 7;
    model.maxWorkersPerExecutionUnit = 3;
    model.executionUnitFixedCostMs = 0;
    model.jobOverheadMs = 0;
    model.executionUnitCeilingMs = 7;
    model.aggregateCeilingMs = 8;
    compare();
    files.reverse();
    files[4]!.durationMs = 3;
    model.maxWorkersPerExecutionUnit = 2;
    model.executionUnitFixedCostMs = 1;
    model.jobOverheadMs = 1;
    model.executionUnitCeilingMs = 8;
    model.aggregateCeilingMs = 15;
    compare();
    for (const [count, bound] of [
      [0, 11],
      [12, 11],
    ] as const) {
      const boundaryFiles = Array.from({ length: count }, (_, index) => ({
        fileName: `boundary-${index}`,
        durationMs: 1,
      }));
      const boundaryModel = createSyntheticScheduleModel({ maximumScheduledFileCount: bound });
      const expected = scheduleVerdict(old, boundaryFiles, boundaryModel);
      expect(scheduleVerdict(candidate, boundaryFiles, boundaryModel).serialized).toBe(expected.serialized);
      expectSharedScheduleEquivalence(old, candidate, boundaryFiles, boundaryModel, expected);
    }
  });

  it("exact subset schedule equivalence for complete old and candidate guards", async () => {
    const oracleUrl = pathToFileURL(join(testDirectory, "fixtures/bootstrap-db-schedule-before-subset-reuse.mjs"));
    const uncached = await import(oracleUrl.href);
    const old = await cachedCompleteOracle();
    const { old: rawScheduler } = exactScheduleProbes();
    // A-B-A, reordered/equal durations and worker changes exercise the harness
    // cache independently of the candidate and without reducing the corpus.
    for (const durations of [
      [1, 2, 3, 5, 8],
      [8, 5, 3, 2, 1],
      [3, 3, 3, 3],
      [1, 2, 3, 5, 8],
    ]) {
      for (const workers of [1, 2, 3, 2, 1]) {
        expect(old.worstCaseListScheduleMs(durations, workers)).toBe(
          rawScheduler.worstCaseListScheduleMs(durations, workers),
        );
      }
    }
    const memoBytes = readFileSync(join(testDirectory, "fixtures/bootstrap-db-oracle-schedule-memo.json"));
    expect(createHash("sha256").update(memoBytes).digest("hex")).toBe(
      "29209ed0d4600da02bf5793bdb21788911903264db838d998b48e96d4e406d85",
    );
    const memo = JSON.parse(memoBytes.toString("utf8"));
    expect(memo.oracleSha256).toBe("d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b");
    old.preload(memo.entries);
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
    // The pinned oracle lives under __tests__/fixtures, so its import.meta.url-derived
    // default root is __tests__; bind both guards to the one production platform-api root.
    const platformApiRoot = join(testDirectory, "..");
    // Compare both implementations against the same current enrollment corpus.
    const repositoryInputs = {
      platformApiRoot,
      manifest: bootstrapDbEnrollmentManifest,
      executionUnitBootBearingCaseCeilings: bootstrapDbExecutionUnitBootBearingCaseCeilings,
      scheduleModel: bootstrapDbScheduleModel,
    };
    const candidateRepository = checkBootstrapDbEnrollment(repositoryInputs);
    const { candidate: candidateScheduler } = exactScheduleProbes();
    for (let mask = 1; mask < 1 << candidateRepository.schedule.files.length; mask++) {
      const durations = candidateRepository.schedule.files
        .filter((_, index) => mask & (1 << index))
        .map((file) => file.durationMs);
      expect(old.worstCaseListScheduleMs(durations, bootstrapDbScheduleModel.maxWorkersPerExecutionUnit)).toBe(
        candidateScheduler.worstCaseListScheduleMs(durations, bootstrapDbScheduleModel.maxWorkersPerExecutionUnit),
      );
    }
    const started = performance.now();
    const oldRepository = old.checkBootstrapDbEnrollment(repositoryInputs);
    process.stdout.write(
      `bootstrap-enrollment-oracle ${JSON.stringify({ durationMs: performance.now() - started, fileCount: oldRepository.fileCount, schedulerCalls: old.schedulerCalls })}\n`,
    );
    expect(old.schedulerCalls.hits).toBeGreaterThan(0);
    const regeneration =
      "Regenerate with node __tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs from deployables/platform-api";
    expect(old.schedulerCalls.misses, regeneration).toBe(0);
    expect(Object.keys(memo.entries), regeneration).toHaveLength(4095);
    expect(old.requestedKeys, regeneration).toHaveLength(Object.keys(memo.entries).length);
    // The historical oracle's top-level path classifier rejects the real Catalog
    // entry, and it predates the measured floor, so it keeps any minimality
    // verdict a bound declared floor lifts. Preserve its complete output
    // comparison with exactly the default-path floor-role corrections; every
    // schedule/case field still agrees.
    const { observedUnitCount } = candidateRepository.schedule;
    expect(oldRepository.violations).toEqual([
      "test:db:2 references unmanifested bootstrap DB file 'seed-command-catalog.db.test.ts'",
      ...(currentMinimumUnitCount < observedUnitCount
        ? [minimalityViolationFor(observedUnitCount, currentMinimumUnitCount)]
        : []),
    ]);
    expect(candidateRepository.violations).toEqual([]);
    expect(normalize(candidateRepository)).toEqual(
      normalize({
        ...oldRepository,
        violations: [],
        schedule: {
          ...oldRepository.schedule,
          effectiveMinimumUnitCount: observedUnitCount,
          measuredOneFewerUnitFloor: expectedMeasuredFloorVerdict(
            bootstrapDbMeasuredOneFewerUnitFloor,
            bootstrapDbScheduleModel,
          ),
        },
      }),
    );
    for (const count of [10, 11, 12, 13]) {
      const files = Array.from({ length: count }, (_, index) => unitFileFor(`oracle-${index}`, "test:db:1", 1_000));
      const fixture = await createFixture(files, { model: { maximumScheduledFileCount: count === 13 ? 12 : 11 } });
      const options = {
        platformApiRoot: fixture.root,
        manifest: fixture.manifest,
        executionUnitBootBearingCaseCeilings: fixture.ceilings,
        scheduleModel: fixture.model,
        nonBootstrapCensus: fixture.nonBootstrapCensus,
      };
      const reason = count > fixture.model.maximumScheduledFileCount ? declaredFloorModelRefused : declaredFloorUnbound;
      expect(normalize(checkBootstrapDbEnrollment(options))).toEqual(
        normalize(withUnappliedMeasuredFloor(old.checkBootstrapDbEnrollment(options), reason)),
      );
      expect(normalize(old.checkBootstrapDbEnrollment(options))).toEqual(
        normalize(uncached.checkBootstrapDbEnrollment(options)),
      );
    }
  });

  it("enrolls the repository's exact case-to-file and database-suffix manifest", () => {
    const result = checkBootstrapDbEnrollment();

    expect(result.violations).toEqual([]);
    expect(result.expectedCaseCount).toBe(71);
    expect(result.caseCount).toBe(result.expectedCaseCount);
    expect(result.fileCount).toBe(12);
    expect(result.partitionUnitCount).toBe(3);
  });

  it("preserves the complete frozen seed-command file and both separate case identities", () => {
    const fileName = "seed-command-full-pools.db.test.ts";
    const source = readFileSync(join(testDirectory, fileName));
    expect(createHash("sha256").update(source).digest("hex")).toBe(seedCommandSourceSha256);
    expect(deriveBootstrapDbCaseIdentities(fileName, source.toString()).map((testCase) => testCase.identity)).toEqual([
      "0204be7639f55534",
      "9e7b99abfd2756ab",
    ]);
  });

  it.each([
    ["deletion", (source: string, caseName: string) => source.replace(extractCaseDeclaration(source, caseName), "")],
    ["duplication", (source: string, caseName: string) => `${source}\n${extractCaseDeclaration(source, caseName)}`],
    ["unexpected case", (source: string) => `${source}\nit("unmanifested bootstrap behavior", async () => {\n});`],
  ])("rejects case %s", async (_label, mutate) => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const target = files[0]!;
    const path = join(fixture.root, "__tests__", target.fileName);
    await writeFile(path, mutate(await readFile(path, "utf8"), target.cases[0]!.name));

    expect(runFixture(fixture).violations).not.toEqual([]);
  });

  it("names the case, its file, and its execution unit when a manifest case is dropped", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const target = files[0]!;
    const caseName = target.cases[0]!.name;
    const path = join(fixture.root, "__tests__", target.fileName);
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace(extractCaseDeclaration(source, caseName), ""));

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        `missing bootstrap DB case '${caseName}' from ${target.fileName} in ${target.executionUnit}`,
      ]),
    );
  });

  it("rejects a mapped case routed to the wrong partition", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const [source, target] = [files[0]!, files[1]!];
    const caseName = source.cases[0]!.name;
    const sourcePath = join(fixture.root, "__tests__", source.fileName);
    const targetPath = join(fixture.root, "__tests__", target.fileName);
    const declaration = extractCaseDeclaration(await readFile(sourcePath, "utf8"), caseName);
    await writeFile(sourcePath, (await readFile(sourcePath, "utf8")).replace(declaration, ""));
    await writeFile(targetPath, `${await readFile(targetPath, "utf8")}\n${declaration}`);

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([expect.stringContaining(`belongs in ${source.fileName}, not ${target.fileName}`)]),
    );
  });

  it.each(["omitted", "duplicated"])("rejects a DB file %s across package-script partitions", async (mutation) => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const packageJsonPath = join(fixture.root, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const fileName = files[0]!.fileName;
    const executionUnit = files[0]!.executionUnit;
    if (mutation === "omitted") {
      packageJson.scripts[executionUnit] = packageJson.scripts[executionUnit].replace(`__tests__/${fileName}`, "");
    } else {
      packageJson.scripts["test:db:1"] += ` __tests__/${fileName}`;
    }
    await writeFile(packageJsonPath, JSON.stringify(packageJson));

    expect(runFixture(fixture).violations).toEqual(expect.arrayContaining([expect.stringContaining(fileName)]));
  });

  it("rejects a manifested file whose package script disagrees with its declared execution unit", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const packageJsonPath = join(fixture.root, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const moved = files.find((file) => file.executionUnit === "test:db:1")!;
    packageJson.scripts["test:db:1"] = packageJson.scripts["test:db:1"].replace(`__tests__/${moved.fileName}`, "");
    packageJson.scripts["test:db:2"] += ` __tests__/${moved.fileName}`;
    await writeFile(packageJsonPath, JSON.stringify(packageJson));

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([`${moved.fileName} belongs in test:db:1, not test:db:2`]),
    );
  });

  it.each(["test:unit", "test:fast"])("rejects a DB file missing from the %s exclude list", async (scriptName) => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const packageJsonPath = join(fixture.root, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const fileName = files[0]!.fileName;
    packageJson.scripts[scriptName] = packageJson.scripts[scriptName].replace(`--exclude __tests__/${fileName}`, "");
    await writeFile(packageJsonPath, JSON.stringify(packageJson));

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([`${scriptName} must exclude __tests__/${fileName}`]),
    );
  });

  it.each([
    ["method listener", 'const server = { listen(_port: number) {} }; server["listen"](6182);'],
    ["serve import alias", 'import { serve as startHttp } from "http-runtime"; startHttp({ port: 6182 });'],
    ["destructured serve alias", "const { serve: startHttp } = { serve() {} }; startHttp();"],
  ])("rejects a %s start in partition-local support", async (_label, listenerSource) => {
    const fixture = await createShippedFixture(shippedShapedFiles());
    const path = join(fixture.root, "__tests__", "bootstrap-db-test-support.ts");
    await writeFile(path, `${await readFile(path, "utf8")}\n${listenerSource}`);

    expect(runFixture(fixture).violations).toEqual(expect.arrayContaining([expect.stringContaining("listener start")]));
  });

  it("rejects an incorrect or duplicated database suffix declaration", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const path = join(fixture.root, "__tests__", files[0]!.fileName);
    const declaration = `createPlatformApiBootstrapTestHarness(${JSON.stringify(files[0]!.databaseSuffix)});`;
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        declaration,
        `createPlatformApiBootstrapTestHarness("wrong_suffix");\n${declaration}`,
      ),
    );

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([expect.stringContaining("must declare exactly one bootstrap database suffix")]),
    );
  });

  // -- executable discovery ------------------------------------------------

  it("rejects an executable test entry that stands up a bootstrap database outside every execution unit", async () => {
    // Deliberately not named `*.db.test.ts`: the guard selects this file because
    // the workspace's own vitest include glob would execute it and its import
    // graph reaches the bootstrap harness, never because of its file name.
    const fixture = await createShippedFixture(shippedShapedFiles(), {
      extraSources: {
        "seed-resume-extra.test.ts": [
          'import { it } from "vitest";',
          'import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";',
          'createPlatformApiBootstrapTestHarness("platform_api_seed_resume_extra");',
          'it("runs outside every execution unit", async () => {});',
        ].join("\n"),
      },
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "__tests__/seed-resume-extra.test.ts is an executable test entry that stands up a bootstrap database " +
            "but is not manifested in any numbered test:db:* execution unit",
        ),
      ]),
    );
  });

  it("accepts a test entry that never reaches the bootstrap harness", async () => {
    const fixture = underAcceptedScheduleModel(
      await createShippedFixture(shippedShapedFiles(), {
        model: acceptedTimingInputs(),
        extraSources: {
          "plain-unit.test.ts": ['import { it } from "vitest";', 'it("needs no database", () => {});'].join("\n"),
        },
      }),
    );

    expect(runFixture(fixture).violations).toEqual([]);
    await writeEntry(
      fixture,
      "__tests__/plain-unit.test.ts",
      [
        'import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";',
        'createPlatformApiBootstrapTestHarness("synthetic_plain_importer");',
      ].join("\n"),
    );
    expect(runFixture(fixture).violations).toContain(
      "__tests__/plain-unit.test.ts is an executable test entry that stands up a bootstrap database " +
        "but is not manifested in any numbered test:db:* execution unit",
    );
  });

  it("rejects a bootstrap importer at the real operator-session path when no DB unit executes it", async () => {
    const fixture = await createFixture(shippedShapedFiles());
    const directory = join(fixture.root, "__tests__", "operator-session");
    const channelsTestSupport = ["@chase-sets", "channels", "test-support"].join("/");
    await mkdir(directory);
    await writeFile(
      join(directory, "operator-session-push.db.test.ts"),
      [
        'import { it } from "vitest";',
        'import { createPlatformApiBootstrapTestHarness } from "../bootstrap-db-test-support";',
        'import { prepareConnectorBoundSettlement } from "' + channelsTestSupport + '";',
        "void prepareConnectorBoundSettlement;",
        'createPlatformApiBootstrapTestHarness("synthetic_operator_boot");',
        'it("undiscovered bootstrap importer", async () => {});',
      ].join("\n"),
    );
    expect(runFixture(fixture).violations).toContain(
      "__tests__/operator-session/operator-session-push.db.test.ts is an executable test entry that stands up a bootstrap database " +
        "but is not manifested in any numbered test:db:* execution unit",
    );
  });

  // -- code-shaped DB census ----------------------------------------------

  it("derives the complete frozen six-entry non-bootstrap census independently of suffixes", async () => {
    const fixture = await createDbCensusFixture();
    const census = derivePlatformApiDbTestCensus({ platformApiRoot: fixture.root });
    expect(census.dbEntries).toHaveLength(16);
    expect(census.bootstrapEntries).toHaveLength(12);
    expect(census.dbEntries).toEqual(census.suffixEntries);
    expect(census.dbEntries.filter((entry) => !census.bootstrapEntries.includes(entry)).sort()).toEqual(
      Object.keys(fixture.nonBootstrapCensus.entries).sort(),
    );
    expect(runFixture(fixture).violations).toEqual([]);
  });

  it.each(["test:unit", "test:fast"])("rejects Catalog and nested DB leaks from %s (N1)", async (name) => {
    for (const entry of [
      "__tests__/seed-command-catalog.db.test.ts",
      "__tests__/operator-session/operator-session-push.db.test.ts",
    ]) {
      const fixture = await createDbCensusFixture();
      await editScripts(fixture, (scripts) => {
        scripts[name] = scripts[name]!.replace(`--exclude ${entry}`, "");
      });
      expect(runFixture(fixture).violations).toContain(`${name} must exclude ${entry}`);
    }
  });

  it("requires Catalog execution exactly once and accepts restoration (N4/N5)", async () => {
    const fixture = await createDbCensusFixture();
    const entry = "__tests__/seed-command-catalog.db.test.ts";
    await editScripts(fixture, (scripts) => {
      scripts["test:db:2"] = scripts["test:db:2"]!.replace(` ${entry}`, "");
    });
    expect(runFixture(fixture).violations).toContain(`${entry} is not selected by any numbered unit`);
    await editScripts(fixture, (scripts) => {
      scripts["test:db:2"] += ` ${entry}`;
    });
    expect(runFixture(fixture).violations).toEqual([]);
    await editScripts(fixture, (scripts) => {
      scripts["test:db:1"] += ` ${entry}`;
    });
    expect(runFixture(fixture).violations).toContain(
      `${entry} must appear in exactly one numbered test:db:* partition script; found 2 (test:db:1, test:db:2)`,
    );
  });

  it.each(["selected", "excluded"])("rejects a nested unmanifested harness importer when %s (N6)", async (mode) => {
    const fixture = await createDbCensusFixture();
    const entry = "__tests__/nested/renamed.db.test.ts";
    await writeEntry(
      fixture,
      entry,
      'import { createPlatformApiBootstrapTestHarness } from "../bootstrap-db-test-support";',
    );
    await editScripts(fixture, (scripts) => {
      scripts["test:db:2"] += ` ${entry}${mode === "excluded" ? ` --exclude ${entry}` : ""}`;
    });
    expect(runFixture(fixture).violations).toContain(
      mode === "selected"
        ? `test:db:2 references unmanifested bootstrap DB file '${entry}'`
        : `test:db:2 excludes selected DB test entry '${entry}'`,
    );
    if (mode === "excluded")
      expect(runFixture(fixture).violations).toContain(`${entry} is not selected by any numbered unit`);
  });

  it.each([
    ["absent-entry", 0],
    ["operator-session", 3],
  ] as const)("rejects filter %s resolving to %i entries (N7)", async (filter, count) => {
    const fixture = await createDbCensusFixture();
    await editScripts(fixture, (scripts) => {
      scripts["test:db:2"] += ` ${filter}`;
    });
    expect(runFixture(fixture).violations).toContain(
      `test:db:2 filter '${filter}' must select exactly one test entry; found ${count}`,
    );
  });

  it("parses option values and case-insensitive path-contains filters without treating them as entries", async () => {
    const fixture = await createDbCensusFixture();
    await editScripts(fixture, (scripts) => {
      scripts["test:db:2"] =
        scripts["test:db:2"]!.replace("__tests__/seed-command-catalog.db.test.ts", "SEED-COMMAND-CATALOG") +
        " --config ./vitest.config.ts";
      for (const name of ["test:unit", "test:fast"]) {
        for (const entry of Object.keys(fixture.nonBootstrapCensus.entries))
          scripts[name] = scripts[name]!.replace(`--exclude ${entry}`, "");
        scripts[name] += " --exclude __tests__/**/*.db.test.ts";
      }
    });
    expect(runFixture(fixture).violations).toEqual([]);
  });

  it.each(["add", "move", "delete", "rename"])(
    "refuses non-bootstrap census %s without re-measurement (N9)",
    async (mode) => {
      const fixture = await createDbCensusFixture();
      const entry = "__tests__/seed-command-catalog.db.test.ts";
      if (mode === "add" || mode === "rename") {
        await writeEntry(fixture, "__tests__/nested/seventh.db.test.ts", `const url = ${syntheticDatabaseUrlRead};`);
      }
      if (mode === "delete" || mode === "rename") await rm(join(fixture.root, entry));
      if (mode === "move")
        await editScripts(fixture, (scripts) => {
          scripts["test:db:2"] = scripts["test:db:2"]!.replace(entry, "");
          scripts["test:db:1"] += ` ${entry}`;
        });
      expect(runFixture(fixture).violations).toEqual(
        expect.arrayContaining([expect.stringContaining("non-bootstrap DB census changed; re-measurement required")]),
      );
    },
  );

  it.each(["referenceRunId", "referenceJobId"] as const)("rejects stale census %s (N10)", async (field) => {
    const fixture = await createDbCensusFixture();
    expect(
      runFixture({
        ...fixture,
        nonBootstrapCensus: { ...fixture.nonBootstrapCensus, [field]: fixture.model[field] + 1 },
      }).violations,
    ).toContain("non-bootstrap DB census reference is stale relative to the schedule model; re-measurement required");
  });

  it("classifies Catalog as unmanifested bootstrap after a harness import (N11)", async () => {
    const fixture = await createDbCensusFixture();
    const entry = "__tests__/seed-command-catalog.db.test.ts";
    await writeEntry(
      fixture,
      entry,
      'import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";',
    );
    expect(derivePlatformApiDbTestCensus({ platformApiRoot: fixture.root }).bootstrapEntries).toContain(entry);
    expect(runFixture(fixture).violations).toContain(`test:db:2 references unmanifested bootstrap DB file '${entry}'`);
  });

  it.each([syntheticDatabaseUrlRead, `process["env"]["${syntheticDatabaseUrlKey}"]`])(
    "keeps literal mixed-fixture reachability in both directions for %s (N2/N8)",
    async (read) => {
      const fixture = await createDbCensusFixture();
      const ordinary = "__tests__/renamed/deep/ordinary.test.ts";
      const db = "__tests__/renamed/deep/consumer.db.test.ts";
      const common = "__tests__/renamed/deep/common.ts";
      const support = "__tests__/renamed/deep/db-support.ts";
      const pure = `export const harmless = 1; // ${syntheticDatabaseUrlRead}\n`;
      const setup = `const url = ${read}; export function setup() { return url; }\n`;
      await writeEntry(fixture, common, pure + setup);
      await writeEntry(fixture, ordinary, 'import { harmless } from "./common"; void harmless;');
      await writeEntry(fixture, db, 'import { setup } from "./common"; setup();');
      const census = () => derivePlatformApiDbTestCensus({ platformApiRoot: fixture.root });
      expect(census().dbEntries).toEqual(expect.arrayContaining([ordinary, db]));
      for (const entry of [ordinary, db]) {
        expect(runFixture(fixture).violations).toContain(`${entry} is not selected by any numbered unit`);
        for (const name of ["test:unit", "test:fast"])
          expect(runFixture(fixture).violations).toContain(`${name} must exclude ${entry}`);
      }
      expect(census().violations).toContain(
        `${ordinary} DB census disagrees with *.db.test.ts suffix (code-shaped DB entry: true)`,
      );

      await writeEntry(fixture, common, pure);
      await writeEntry(fixture, support, setup);
      await writeEntry(fixture, db, 'import { setup } from "./db-support"; setup();');
      const split = {
        ...fixture,
        nonBootstrapCensus: {
          ...fixture.nonBootstrapCensus,
          entries: { ...fixture.nonBootstrapCensus.entries, [db]: "test:db:2" as const },
        },
      };
      await editScripts(fixture, (scripts) => {
        scripts["test:db:2"] += ` ${db}`;
        for (const name of ["test:unit", "test:fast"]) scripts[name] += ` --exclude ${db}`;
      });
      expect(census().entries).toContain(ordinary);
      expect(census().dbEntries).not.toContain(ordinary);
      expect(census().dbEntries).toContain(db);
      expect(runFixture(split).violations).toEqual([]);
      const scripts = JSON.parse(await readFile(join(fixture.root, "package.json"), "utf8")).scripts;
      for (const name of ["test:unit", "test:fast"]) expect(scripts[name]).not.toContain(ordinary);

      await writeEntry(fixture, db, 'import { harmless } from "./common"; void harmless;');
      expect(census().dbEntries).not.toContain(db);
      expect(runFixture(split).violations).toContain(`test:db:2 selects non-DB test entry '${db}'`);
      expect(census().violations).toContain(
        `${db} DB census disagrees with *.db.test.ts suffix (code-shaped DB entry: false)`,
      );
      await writeEntry(fixture, ordinary, 'import { setup } from "./db-support"; setup();');
      expect(census().dbEntries).toContain(ordinary);
      expect(census().violations).toContain(
        `${ordinary} DB census disagrees with *.db.test.ts suffix (code-shaped DB entry: true)`,
      );

      await writeEntry(fixture, ordinary, 'import { harmless } from "./common"; void harmless;');
      for (const source of [pure + setup, pure + 'export { setup } from "./db-support";']) {
        await writeEntry(fixture, common, source);
        expect(census().dbEntries).toContain(ordinary);
        expect(census().violations).toContain(
          `${ordinary} DB census disagrees with *.db.test.ts suffix (code-shaped DB entry: true)`,
        );
      }
    },
  );

  it("follows cyclic re-exports to the bootstrap harness without a path exemption", async () => {
    const fixture = await createDbCensusFixture();
    await writeEntry(
      fixture,
      "__tests__/nested/a.ts",
      'export * from "./b"; export * from "../bootstrap-db-test-support";',
    );
    await writeEntry(fixture, "__tests__/nested/b.ts", 'export * from "./a";');
    for (const name of ["a", "b"]) {
      const entry = `__tests__/nested/${name}.db.test.ts`;
      await writeEntry(
        fixture,
        entry,
        `import { createPlatformApiBootstrapTestHarness as importedHarness } from "./${name}"; function createPlatformApiBootstrapTestHarness() { return importedHarness; }`,
      );
      await editScripts(fixture, (scripts) => {
        scripts["test:db:2"] += ` ${entry}`;
      });
    }
    const census = derivePlatformApiDbTestCensus({ platformApiRoot: fixture.root });
    for (const name of ["a", "b"]) {
      const entry = `__tests__/nested/${name}.db.test.ts`;
      expect(census.bootstrapEntries).toContain(entry);
      expect(runFixture(fixture).violations).toContain(
        `test:db:2 references unmanifested bootstrap DB file '${entry}'`,
      );
    }
  });

  it("refuses an include-selected DB importer excluded by the actual Vitest config", async () => {
    const fixture = await createDbCensusFixture();
    const entry = "__tests__/seed-command-catalog.db.test.ts";
    await writeFile(
      join(fixture.root, "vitest.config.ts"),
      `export default { test: { include: ["__tests__/**/*.test.ts"], exclude: ["${entry}"] } };`,
    );
    expect(derivePlatformApiDbTestCensus({ platformApiRoot: fixture.root }).dbEntries).toContain(entry);
    expect(runFixture(fixture).violations).toContain(`test:db:2 excludes selected DB test entry '${entry}'`);
    expect(runFixture(fixture).violations).toContain(`${entry} is not selected by any numbered unit`);
  });

  it.each(["--config other.config.ts", "--root elsewhere", "--testNamePattern subset", "--shard 1/2"])(
    "rejects a DB invocation that narrows or changes execution with %s",
    async (option) => {
      const fixture = await createDbCensusFixture();
      await editScripts(fixture, (scripts) => {
        scripts["test:db:2"] += ` ${option}`;
      });
      expect(runFixture(fixture).violations).toContain(
        "test:db:2 changes the canonical Vitest discovery or case selection; complete DB entry execution is required",
      );
    },
  );

  // -- schedule model boundaries -------------------------------------------

  it("never under-states the reference job's own observed per-unit durations", async () => {
    // The reference job ran the pre-split layout: one unit carrying the whole
    // ten-case authoritative file next to the catalog file, and one carrying the
    // other four. Replaying that exact layout through the shipped model must
    // return at least each observed `Duration`, or the model is projecting a
    // cheaper world than the one the authority measured.
    const previousReferenceCases = {
      "bootstrap-scenario.db.test.ts": [
        {
          name: "boots with context-owned pools and replays cross-context projections",
          referenceDurationMs: 90877,
        },
        {
          name: "revokes agent-owned saved instruments through the composed OAuth route with a valid audit context",
          referenceDurationMs: 1202,
        },
        {
          name: "records context schema migrations once during concurrent bootstrap",
          referenceDurationMs: 1716,
        },
      ],
      "bootstrap-production-reconciliation.db.test.ts": [
        {
          name: "payout-fee-console-and-resolve bootstraps every whitelisted value in the production landing profile",
          referenceDurationMs: 8250,
        },
        {
          name: "reconciles a queued active public bootstrap after its predecessor fails with partial Commercial Terms history",
          referenceDurationMs: 16350,
        },
        {
          name: "serializes two concurrent full production-like API host bootstraps with a database advisory lock",
          referenceDurationMs: 17258,
        },
        {
          name: "limits and reconciles every production-like seed context against current-code state",
          referenceDurationMs: 20217,
        },
        {
          name: "upgrades legacy published Display Templates through the not-empty Catalog reconciliation path",
          referenceDurationMs: 20576,
        },
        {
          name: "proves the reviewed projection guard fails at User, then resumes a full retained Identity seed",
          referenceDurationMs: 1084,
        },
        {
          name: "keeps every representative Identity creation event count stable on an ordinary day-after bootstrap",
          referenceDurationMs: 636,
        },
        {
          name: "rejects a conflicting retained representative Account profile with actionable detail",
          referenceDurationMs: 320,
        },
        {
          name: "rejects a conflicting retained representative User profile with actionable detail",
          referenceDurationMs: 473,
        },
        {
          name: "rejects a conflicting retained representative Shipping Address profile with actionable detail",
          referenceDurationMs: 483,
        },
        {
          name: "resumes the real representative commerce command after offer acceptance without duplicate creation events",
          referenceDurationMs: 61339,
        },
      ],
      "bootstrap-lock-contention.db.test.ts": [
        {
          name: "recovers when bootstrap-touched table locks release within the retry budget",
          referenceDurationMs: 1109,
        },
        {
          name: "fails closed when bootstrap-touched table locks exhaust the retry budget",
          referenceDurationMs: 1120,
        },
        {
          name: "isolates partition databases and bootstrap advisory locks",
          referenceDurationMs: 2535,
        },
      ],
      "authoritative-seed-resume-core.db.test.ts": [
        {
          name: "derives the exact active and source-only seed universe for every host profile",
          referenceDurationMs: 348,
        },
        {
          name: "retained-state phase one: completes the first scenario-seed boot and proves all three same-boot repeats append nothing",
          referenceDurationMs: 75314,
        },
        {
          name: "retained-state phase two: proves ordinary boot two appends nothing on the retained phase-one database",
          referenceDurationMs: 28241,
        },
        {
          name: "does not re-author Settlement while its payout projection lags the stream",
          referenceDurationMs: 77914,
        },
      ],
      "authoritative-seed-resume-reconciliation.db.test.ts": [
        {
          name: "reconciles every inspecting scenario-seed context to its frozen identity corpus and active state",
          referenceDurationMs: 73270,
        },
        {
          name: "enumerates stream-sourced seed-state coverage from the runtime mount list",
          referenceDurationMs: 608,
        },
        {
          name: "resumes every converted context after its UNLOGGED guard projections are truncated",
          referenceDurationMs: 71709,
        },
        {
          name: "accepts a seeded resolution after the real deadline sweep advances it to closed",
          referenceDurationMs: 59351,
        },
      ],
      "authoritative-seed-resume-recovery.db.test.ts": [
        {
          name: "keeps a cancelled resolution-bearing seed request incomplete and does not silently repair it",
          referenceDurationMs: 57961,
        },
        {
          name: "recreates only a missing review-eligible payment after a sibling payment has completed",
          referenceDurationMs: 58195,
        },
      ],
      "inventory-seed-resume.db.test.ts": [
        {
          name: "reseeds inventory after its truncated UNLOGGED projections without duplicate creation",
          referenceDurationMs: 24711,
        },
        {
          name: "appends events only on the first of three same-boot inventory and checkout seed invocations",
          referenceDurationMs: 21675,
        },
        {
          name: "resumes inventory from a committed-but-incomplete storage location",
          referenceDurationMs: 28234,
        },
        {
          name: "resumes an archived storage location committed before its archive step",
          referenceDurationMs: 28971,
        },
        {
          name: "resumes a checkout cart holding only one of its two seeded lines",
          referenceDurationMs: 24479,
        },
        {
          name: "fails closed on conflicting retained inventory identity metadata",
          referenceDurationMs: 20292,
        },
        {
          name: "fails closed on a terminal retained inventory aggregate",
          referenceDurationMs: 16012,
        },
        {
          name: "keeps ordinary duplicate-create rejection unchanged for non-seed commands",
          referenceDurationMs: 12671,
        },
      ],
      "catalog-seed-aggregate-state.db.test.ts": [
        {
          name: "reconciles all required aggregates for a clean scenario-seed-only module seed",
          referenceDurationMs: 11470,
        },
        {
          name: "does not re-author unchanged Product Measures facts on scenario-seed repeat",
          referenceDurationMs: 19248,
        },
        {
          name: "NC-1 resumes an undrained Dimension seed without duplicate creation",
          referenceDurationMs: 13264,
        },
        {
          name: "NC-2 resumes a Component committed at created version one across two ordinary boots",
          referenceDurationMs: 16156,
        },
        {
          name: "NC-3 restores lagging projections without re-authoring active aggregates",
          referenceDurationMs: 6218,
        },
        {
          name: "rebuilds lost Catalog Item projections from retained streams without appending item events",
          referenceDurationMs: 23434,
        },
        {
          name: "NC-4 ignores populated containers when required aggregates have zero events",
          referenceDurationMs: 25049,
        },
        {
          name: "NC-5a repairs a draft partial aggregate rather than skipping it",
          referenceDurationMs: 16069,
        },
        {
          name: "NC-5b rejects conflicting retained identity metadata on both boots",
          referenceDurationMs: 3223,
        },
        {
          name: "NC-5c rejects a terminal retained aggregate on both boots",
          referenceDurationMs: 14123,
        },
        {
          name: "resumes after Dimensions under scenario-seed and production-like profiles",
          referenceDurationMs: 20952,
        },
        {
          name: "resumes after Fields under scenario-seed and production-like profiles",
          referenceDurationMs: 20631,
        },
        {
          name: "resumes after Reference Data under scenario-seed and production-like profiles",
          referenceDurationMs: 20554,
        },
        {
          name: "resumes after Components under scenario-seed and production-like profiles",
          referenceDurationMs: 20933,
        },
        {
          name: "resumes after Blueprints under scenario-seed and production-like profiles",
          referenceDurationMs: 22067,
        },
        {
          name: "resumes after the final Category under scenario-seed and production-like profiles",
          referenceDurationMs: 20945,
        },
        {
          name: "resumes mid catalog.component.created under scenario-seed and production-like profiles",
          referenceDurationMs: 20553,
        },
        {
          name: "keeps the required aggregate set equal to the base aggregate streams authored by the seed",
          referenceDurationMs: 13278,
        },
        {
          name: "preserves duplicate CreateDimension rejection through the non-seed command handler",
          referenceDurationMs: 13522,
        },
      ],
    };
    const authoritativeCases = Object.entries(previousReferenceCases)
      .filter(([fileName]) => fileName.startsWith("authoritative-seed-resume-"))
      .flatMap(([, cases]) => cases);
    const casesOf = (fileName: keyof typeof previousReferenceCases) => previousReferenceCases[fileName];
    const asFixtureCases = (cases: readonly { name: string; referenceDurationMs: number }[]) =>
      cases.map((testCase, index) => ({
        name: testCase.name,
        referenceDurationMs: testCase.referenceDurationMs,
        body: `  expect(${index}).toBe(${index});`,
      }));

    const fixture = await createFixture(
      [
        {
          fileName: "authoritative-seed-resume.db.test.ts",
          databaseSuffix: "platform_api_authoritative_seed_resume",
          executionUnit: "test:db:1",
          cases: asFixtureCases(authoritativeCases),
        },
        {
          fileName: "catalog-seed-aggregate-state.db.test.ts",
          databaseSuffix: "platform_api_catalog_seed_aggregate_state",
          executionUnit: "test:db:1",
          cases: asFixtureCases(casesOf("catalog-seed-aggregate-state.db.test.ts")),
        },
        {
          fileName: "bootstrap-scenario.db.test.ts",
          databaseSuffix: "platform_api_bootstrap_scenario",
          executionUnit: "test:db:2",
          cases: asFixtureCases(casesOf("bootstrap-scenario.db.test.ts")),
        },
        {
          fileName: "bootstrap-production-reconciliation.db.test.ts",
          databaseSuffix: "platform_api_bootstrap_production_reconciliation",
          executionUnit: "test:db:2",
          cases: asFixtureCases(casesOf("bootstrap-production-reconciliation.db.test.ts")),
        },
        {
          fileName: "bootstrap-lock-contention.db.test.ts",
          databaseSuffix: "platform_api_bootstrap_lock_contention",
          executionUnit: "test:db:2",
          cases: asFixtureCases(casesOf("bootstrap-lock-contention.db.test.ts")),
        },
        {
          fileName: "inventory-seed-resume.db.test.ts",
          databaseSuffix: "platform_api_inventory_seed_resume",
          executionUnit: "test:db:2",
          cases: asFixtureCases(casesOf("inventory-seed-resume.db.test.ts")),
        },
      ],
      { ceilings: { "test:db:1": 29, "test:db:2": 25 } },
    );
    const { schedule } = runFixture(fixture);

    expect(schedule.units[0]!.makespanMs).toBe(514_210);
    expect(schedule.units[0]!.makespanMs).toBeGreaterThanOrEqual(514_210);
    expect(schedule.units[1]!.makespanMs).toBeGreaterThanOrEqual(186_210);
    expect(schedule.units[1]!.makespanMs).toBe(194_356);
    // ...and that layout is exactly what fails the per-unit ceiling this slice fixes.
    expect(schedule.units[0]!.makespanMs).toBeGreaterThan(bootstrapDbScheduleModel.executionUnitCeilingMs);
  });

  it("preserves the immutable historical twelve-file capture without assigning its durations to new cases", async () => {
    const bytes = readFileSync(join(testDirectory, "fixtures/bootstrap-db-capture-37467774999.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "957f5dccb19eb2bde1a906c3b27e9ded81886898ae375899f283a879eb01aff6",
    );
    const capture = JSON.parse(bytes.toString()) as {
      referenceRunId: number;
      referenceJobId: number;
      timing: SyntheticScheduleModelTimingOverrides;
      files: (Omit<FixtureFile, "executionUnit" | "cases"> & {
        cases: readonly Pick<FixtureCase, "name" | "referenceDurationMs">[];
      })[];
    };
    expect(capture.referenceRunId).toBe(37467774999);
    expect(capture.referenceJobId).toBe(112283047125);
    expect(capture.files.flatMap((file) => file.cases)).toHaveLength(62);
    expect(
      capture.files.find((file) => file.fileName === "connector-mount-gate-isolation.db.test.ts")!.cases,
    ).toHaveLength(5);
    const measuredUnitOne = new Set([
      "bootstrap-shared-seed-command.db.test.ts",
      "bootstrap-scenario.db.test.ts",
      "bootstrap-production-reconciliation.db.test.ts",
      "bootstrap-lock-contention.db.test.ts",
      "seed-command-full-pools.db.test.ts",
      "connector-mount-gate-isolation.db.test.ts",
    ]);
    const measuredUnitTwo = new Set([
      "authoritative-seed-resume-recovery.db.test.ts",
      "inventory-seed-resume.db.test.ts",
      "catalog-seed-aggregate-state.db.test.ts",
    ]);
    const fixture = await createShippedFixture(
      capture.files.map((file) => ({
        ...file,
        cases: file.cases.map((testCase, index) => ({ ...testCase, body: `  expect(${index}).toBe(${index});` })),
        executionUnit: measuredUnitOne.has(file.fileName)
          ? "test:db:1"
          : measuredUnitTwo.has(file.fileName)
            ? "test:db:2"
            : "test:db:3",
      })),
      { model: capture.timing },
    );
    const { schedule, violations } = runFixture(fixture);
    expect(violations).toEqual([]);
    expect(schedule.units.map((unit) => unit.makespanMs)).toEqual([245_187, 251_483, 340_454]);
    expect(schedule.units[0]!.makespanMs).toBeGreaterThanOrEqual(173_573.99125300001);
    expect(schedule.units[1]!.makespanMs).toBeGreaterThanOrEqual(249_915.893999);
    expect(schedule.units[2]!.makespanMs).toBeGreaterThanOrEqual(300_444.386088);
    expect(schedule.aggregateWithOverheadMs).toBe(892_190);
    expect(schedule.aggregateWithOverheadMs).toBeGreaterThanOrEqual(779_000);
  });

  it("preserves the immutable historical 67-case capture and its complete measured workload projection", async () => {
    const bytes = readFileSync(join(testDirectory, "fixtures/bootstrap-db-capture-37916297464.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "ceeaa00f994bcef118b49f2c773facc807e8622f001d6c9e02cfd4476580a71a",
    );
    const capture = JSON.parse(bytes.toString()) as {
      provenance: Record<string, unknown>;
      model: BootstrapDbScheduleModel;
      jobWallMs: number;
      measuredUnits: { observedDurationMs: number; residualMs: number }[];
      files: {
        fileName: string;
        executionUnit: string;
        sourceSha256: string;
        residualMs: number;
        cases: { name: string; identity: string; durationMs: number; referenceDurationMs: number }[];
      }[];
    };
    expect(capture.provenance).toMatchObject({
      runId: "37916297464",
      runAttempt: "1",
      referenceJobId: 113773192932,
      checkoutSha: "77f61c4cc6bf4e2cb544f436c21439ed5a1c67bb",
      sourceBase: "5c9693752fe4b37090f7a62a5216e26615a3e563",
      captureParent: "5c9693752fe4b37090f7a62a5216e26615a3e563",
      artifactId: 11610446204,
      artifactSha256: "8fb7df0e0bb1cf06bdfdd69d77c847ccc2aff299cba89bf3f1ec170be3fff1f5",
      sourceManifestSha256: "5ed6308816a2dc7fc0e1be8cd9d4c40e3b12b2fecdb1bf4687c62365ecc62d0d",
      caseManifestSha256: "a2e61c75b7f87340703e73b27b9bc58ae7853a18cffc7be27ffbc9fe4d1ab6db",
      commandsSha256: "b197ae5d46e3d8121efc1a991482e24ca9d1305a8cd061826744f9f87cb424dc",
      censusSha256: "ece3ea8ef3448dc682a15ad331881b102d687c704e5a538e93780bbde6286f0c",
      maxWorkers: 3,
      laneMode: null,
    });
    expect(capture.files).toHaveLength(12);
    expect(capture.files.flatMap((file) => file.cases)).toHaveLength(67);
    for (const file of capture.files) {
      for (const testCase of file.cases) {
        expect(testCase.durationMs).toBeGreaterThan(0);
        expect(testCase.referenceDurationMs).toBe(Math.ceil(testCase.durationMs));
        expect(testCase.identity).toMatch(/^[0-9a-f]{16}$/);
      }
    }
    expect(capture.model.testFileFixedCostMs).toBe(
      Math.ceil(Math.max(0, ...capture.files.map((file) => file.residualMs))),
    );
    expect(capture.model.executionUnitFixedCostMs).toBe(
      Math.ceil(Math.max(0, ...capture.measuredUnits.map((unit) => unit.residualMs))),
    );
    expect(capture.model.jobOverheadMs).toBe(
      Math.ceil(capture.jobWallMs - capture.measuredUnits.reduce((sum, unit) => sum + unit.observedDurationMs, 0)),
    );
    const fixture = await createShippedFixture(
      capture.files.map((file) => ({
        ...bootstrapDbEnrollmentManifest[file.fileName]!,
        fileName: file.fileName,
        executionUnit: file.executionUnit,
        cases: file.cases.map((testCase, index) => ({ ...testCase, body: `  expect(${index}).toBe(${index});` })),
      })),
      { model: capture.model },
    );
    const { schedule, violations } = runFixture(fixture);
    expect(violations).toEqual([
      "test:db:1 has a projected makespan of 602116ms, exceeding the 420000ms per-unit ceiling",
    ]);
    expect(schedule.units.map((unit) => unit.makespanMs)).toEqual([602116, 275388]);
    schedule.units.forEach((unit, index) =>
      expect(unit.makespanMs).toBeGreaterThanOrEqual(capture.measuredUnits[index]!.observedDurationMs),
    );
    expect(schedule.aggregateWithOverheadMs).toBe(933618);
    expect(schedule.aggregateWithOverheadMs).toBeGreaterThanOrEqual(capture.jobWallMs);
  });

  const measuredCaptures = [
    {
      label: "preserves the superseded 68-case capture and its measured workload projection",
      current: false,
      fileName: "bootstrap-db-capture-38478206964.json",
      minimumUnitCount: 2,
      fixtureSha256: "05d84e19977ab53d199fb2445613a9cc07bb86ffe2ef3f4af9a00a3c3fa2f0da",
      unitProjections: [481486, 364765],
      provenance: {
        runId: "38478206964",
        runAttempt: "1",
        referenceJobId: 115574071589,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "3b41763494f165c6030278e976800d79bd132a87",
        sourceBase: "a075c9f534862f412146c0ca2d870dd453b1f0e4",
        captureParent: "a075c9f534862f412146c0ca2d870dd453b1f0e4",
        artifactId: 11856152754,
        artifactSha256: "f2783c89ff4c401f54cb5be2752bb103e3350c6950315328a33d3f25e7e5e54b",
        sourceManifestSha256: "3ff9aaa0ff95865f677fb307d28d0278a9fe5187ee090e826942a5c38f697c56",
        caseManifestSha256: "29598f9e830993dc9866e80f8108e641ac33d5ae097988bbe26b6322912fc09f",
        commandsSha256: "da73890def17bdb3d5f54c802f27cbf0cd86f7b191cd1f16bc92415b97f380f9",
        censusSha256: "de20ed8bbd70f4a3877cabff894778d2ab7c7ef129d6b8318bdc14c4d89396dd",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38491485544.json",
      minimumUnitCount: 2,
      fixtureSha256: "72d0d47bba93a9d5ba8b9acb23e8b3d01e570056b8974c90edd3bd4df56a2ef3",
      unitProjections: [369695, 410108],
      provenance: {
        runId: "38491485544",
        runAttempt: "1",
        referenceJobId: 115617460502,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "4d98e441e9143cdeb02baebd426ca38fccdffebb",
        sourceBase: "502100be6b87b7cda115498217af0e094e201087",
        captureParent: "502100be6b87b7cda115498217af0e094e201087",
        artifactId: 11862234069,
        artifactSha256: "8f3806218e650167a427733b0af8c88bd98e17d1e87b2be34de28dcb812cfe70",
        sourceManifestSha256: "1a0c8bb7b9246285e6d54d2be2ec06d06dc185102532f68236314596eaca758a",
        caseManifestSha256: "03011b41a6a674420a496ccae92cb68d64ac14504c7d6756e4575dc1828492fe",
        commandsSha256: "8751ac4f86520df16f8aabf15b7701e7d4412c994f91b6d41bf3bae273c07a2d",
        censusSha256: "de20ed8bbd70f4a3877cabff894778d2ab7c7ef129d6b8318bdc14c4d89396dd",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38500650577.json",
      minimumUnitCount: 3,
      fixtureSha256: "b599f992fbf9e30508f4da081db91bf82acc5be1f6fc3f6954788a3442f87ff9",
      unitProjections: [380876, 424006],
      provenance: {
        runId: "38500650577",
        runAttempt: "1",
        referenceJobId: 115646540742,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "4b8409f85a21b5c2a3064b44aff1a7fd771633fc",
        sourceBase: "c4cac4e6d2e3fbb77635b61e51c817cb1d0d64b8",
        captureParent: "c4cac4e6d2e3fbb77635b61e51c817cb1d0d64b8",
        artifactId: 11866306484,
        artifactSha256: "073766607d4ed679e80b74c0bd598e13d390e8c4c839b43a2bbd4eb5b8387fdd",
        sourceManifestSha256: "e942c2885114632b71a5e3916cdfbd325162337b20bee0ec25325849ead74a72",
        caseManifestSha256: "03011b41a6a674420a496ccae92cb68d64ac14504c7d6756e4575dc1828492fe",
        commandsSha256: "8751ac4f86520df16f8aabf15b7701e7d4412c994f91b6d41bf3bae273c07a2d",
        censusSha256: "de20ed8bbd70f4a3877cabff894778d2ab7c7ef129d6b8318bdc14c4d89396dd",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38517513534.json",
      minimumUnitCount: 2,
      fixtureSha256: "f81a54ff2d2d0e2b31ff5901872debf650b9115344189f49a4f2207e72cf273d",
      unitProjections: [399568, 412372, 166253],
      provenance: {
        runId: "38517513534",
        runAttempt: "1",
        referenceJobId: 115699524339,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "977e2d11995b77795b856a9772ad7b584180e406",
        sourceBase: "a74beda31e9cf8462c77c84b83d17ff5c60afc1d",
        captureParent: "a74beda31e9cf8462c77c84b83d17ff5c60afc1d",
        artifactId: 11873080908,
        artifactSha256: "8c5a27f0a3112bc87abdf97cdbef2dbb45bb75af351cf734fe3caff8b7c12bfd",
        sourceManifestSha256: "921c379b35ee2336a69b76803283068024a0b517e62b9c78de5aa4db4cf82262",
        caseManifestSha256: "daab05f9c55696f6e9c86c967855d4cca43118928a14b7a7e14b5f86eeee717a",
        commandsSha256: "7c9496ca70fb2946a57bd646c7dea587d6ad6e3d1c725ca74c5cf90897a20be2",
        censusSha256: "bc6c57c87dace21ce934fe079ceceb2be644e35c6cef95d14f397361ab0ed64a",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38543786543.json",
      fixtureSha256: "5be8f96982b2590a8c4986c943cd291503ba640cf3746493083e0afe1997fe61",
      minimumUnitCount: 3,
      unitProjections: [394829, 432242],
      provenance: {
        runId: "38543786543",
        runAttempt: "1",
        referenceJobId: 115784717746,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "bc9477d5a4a1f6d55d797318863d43108dc8f6a1",
        sourceBase: "08e4c976243ac8b52f348143d84e91bd9292a30f",
        captureParent: "08e4c976243ac8b52f348143d84e91bd9292a30f",
        artifactId: 11883728740,
        artifactSha256: "562bdf51fbdd0afc4cfb3384f0e9db75187d93ebf148a335f8d0f181294f1b61",
        sourceManifestSha256: "1de20e2501e230fc49e5b6138c8e8f10c4034fd80d5efa1ad1908b3c4761ac37",
        caseManifestSha256: "09a6ca6b585d1c18177b9251d0a77e8223089793d3c0ed79bc2beb826d1c116b",
        commandsSha256: "c1a85539b4028bf4bf5c0e0306d1b7eb022c07fac039103022d3284c2d66052f",
        censusSha256: "bc6c57c87dace21ce934fe079ceceb2be644e35c6cef95d14f397361ab0ed64a",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38584224978.json",
      fixtureSha256: "2120235be5c3912314e136c393d1e926eb9db1b70e72103dc1a9b5fbe4712b7b",
      minimumUnitCount: 2,
      unitProjections: [392933, 406996, 164073],
      provenance: {
        runId: "38584224978",
        runAttempt: "1",
        referenceJobId: 115921775698,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "2ac384d4a61bd003d045c86e804215a0bdc3383f",
        sourceBase: "11c6f5fdfad8bf73ca844c53fc6009d0a68a40fe",
        captureParent: "11c6f5fdfad8bf73ca844c53fc6009d0a68a40fe",
        artifactId: 11906216310,
        artifactSha256: "aec7101f401d4c84eb43c30fcd061b4487eee20e8c4bebecfb21c4cc2808acc6",
        sourceManifestSha256: "8340ca42c3c1998b7019e76ceca021dfda492d6288d68959dbd4b03f53c085d6",
        caseManifestSha256: "3450b30df6078cce8de02e99c70164652da260ccd403a2c09535a83a3a3fcf77",
        commandsSha256: "7c9496ca70fb2946a57bd646c7dea587d6ad6e3d1c725ca74c5cf90897a20be2",
        censusSha256: "193f894116a13a1a1d48262775a877ffec00f2069a04167e673cbd928dc3571c",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38608022640.json",
      fixtureSha256: "7de4540d87ad221c798e4d7086742a878f863af78f0e3b10820fe4c9fb22fbaa",
      minimumUnitCount: 2,
      unitProjections: [333277, 362245],
      provenance: {
        runId: "38608022640",
        runAttempt: "1",
        referenceJobId: 116003819646,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "1b6bd9551692c315ccf54f0207632ffdf23d7a89",
        sourceBase: "ead4ebb9e8e78a5aeacb92edcc2c8e21dfd508e7",
        captureParent: "ead4ebb9e8e78a5aeacb92edcc2c8e21dfd508e7",
        artifactId: 11916893532,
        artifactSha256: "74b58146a061b54863d2722bc5a9ba85679a3971d862317f05779946eae283a6",
        sourceManifestSha256: "b3ecfcd039ee4178aa6a84649723e71b25320ff09ff82a94215fbb190c98855b",
        caseManifestSha256: "09a6ca6b585d1c18177b9251d0a77e8223089793d3c0ed79bc2beb826d1c116b",
        commandsSha256: "c1a85539b4028bf4bf5c0e0306d1b7eb022c07fac039103022d3284c2d66052f",
        censusSha256: "193f894116a13a1a1d48262775a877ffec00f2069a04167e673cbd928dc3571c",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38641988070.json",
      fixtureSha256: "2f2732a5b9d2047be5f698595e21d92f5912f4cf9881b190098f4fc46c1b9b41",
      minimumUnitCount: 2,
      unitProjections: [393101, 288780],
      provenance: {
        runId: "38641988070",
        runAttempt: "1",
        referenceJobId: 116119520455,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "e04bf62981772c43adb0eb6695261679df9f1bd1",
        sourceBase: "49bc4171e6ac0d127d6e450c786053ee89b26a6f",
        captureParent: "49bc4171e6ac0d127d6e450c786053ee89b26a6f",
        artifactId: 11931177997,
        artifactSha256: "1e1b11f7e988bea6f2f3c3aae0f836149231322301080c10600d8d42137559b8",
        sourceManifestSha256: "402e5b9be707a31717c578867cee2d1d632ef5ef4d662b9a5fdd380a19bd679b",
        caseManifestSha256: "558da64b638fde0dd4445d6ee1a5a6c44083de325d257fa9dcaa549220dfdbd7",
        commandsSha256: "cb05dbb09f5432065a6e234ccc3fd500017b8c1d7472aba764359565a3ea144d",
        censusSha256: "193f894116a13a1a1d48262775a877ffec00f2069a04167e673cbd928dc3571c",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38737899795.json",
      fixtureSha256: "8a2dfde27091a8b33e557a99cbab9910f3ed75b9bc5f375a0e8a79d86aa4c5f2",
      minimumUnitCount: 2,
      unitProjections: [339401, 258505],
      provenance: {
        runId: "38737899795",
        runAttempt: "1",
        referenceJobId: 116431778262,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "fc4a11cc994c0ed7a56e511bca9a988b33c679da",
        sourceBase: "100432d0d59fb1d2df7486313d1f1a4136311a1a",
        captureParent: "100432d0d59fb1d2df7486313d1f1a4136311a1a",
        artifactId: 11974764643,
        artifactSha256: "a30d190fcbebd29ee8ec28c80c29d455452af745d18896bf6ad572790932b380",
        sourceManifestSha256: "7dafda5d1bb0e0529a17e7850bcf4e1371ef397682ccc50aa973cf02a3310a77",
        caseManifestSha256: "558da64b638fde0dd4445d6ee1a5a6c44083de325d257fa9dcaa549220dfdbd7",
        commandsSha256: "cb05dbb09f5432065a6e234ccc3fd500017b8c1d7472aba764359565a3ea144d",
        censusSha256: "193f894116a13a1a1d48262775a877ffec00f2069a04167e673cbd928dc3571c",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38804356099.json",
      fixtureSha256: "ec0b832cecbb650d5240d3c42a9f7bc7a654c523b2754c413798daf53ae8bfec",
      minimumUnitCount: 2,
      unitProjections: [363545, 403099],
      provenance: {
        runId: "38804356099",
        runAttempt: "1",
        referenceJobId: 116661229774,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "ae95313278e2e38b541f5fc8b0a311afc076d4e9",
        sourceBase: "eddd19e3a75d396a0bf66dea15750c0c2ce3a69e",
        captureParent: "eddd19e3a75d396a0bf66dea15750c0c2ce3a69e",
        artifactId: 12006597022,
        artifactSha256: "0ed946d685e439f442a069952de68ccc8d8627b1a9ecc1f61c3feede111275b0",
        sourceManifestSha256: "3916c219f3e4a5a0cda60d5ffc1656fe034662abd0d10878fd1f7871df336f9d",
        caseManifestSha256: "438ad72cf3f74e68051ed3367ac29a39bca08accaa7c0fc59c047d67c5e3e880",
        commandsSha256: "60845b58f8508707b517952b3d7fbc0bf8f086210ca4d27df75379fb50bb449c",
        censusSha256: "193f894116a13a1a1d48262775a877ffec00f2069a04167e673cbd928dc3571c",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38958136653.json",
      fixtureSha256: "dd46d96c5bb35dbc0256ef8e975bf69915627b785c076728d3b46f4fa822b097",
      minimumUnitCount: 3,
      unitProjections: [319085, 258071, 234445],
      provenance: {
        runId: "38958136653",
        runAttempt: "1",
        referenceJobId: 117166086217,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "3f7cc203d63c18fb9fc759b59b450d05d3e81d94",
        sourceBase: "dd8cb1d3bc00e43c36cb636d97d50b84bde3f686",
        captureParent: "dd8cb1d3bc00e43c36cb636d97d50b84bde3f686",
        artifactId: 12072326766,
        artifactSha256: "aad0400cc9de6ea26546c4410ec7179eea53f94fc5162b72443397eab02fea5a",
        sourceManifestSha256: "c10c64a6cb8e88ba2dbfde210d1aa3487f6bb97eeadc5a5750b9841f1a91feb2",
        caseManifestSha256: "a9e0ef9d1d5ce74b90b5bad25e231817e3ab7606bbe71045432e9097c8507eaf",
        commandsSha256: "db230c159f8f294a676fab11d92f3ea6a0a7aff52490c9f6d46f322b988fdb63",
        censusSha256: "670efd599e0ccd8844f14695ff97af5d5ec644d04057be4561eca61f611f6369",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-38993631473.json",
      fixtureSha256: "32dca1e0b66c28f4578c2959a7b15323a127e86555155c1e23787714482b82e2",
      minimumUnitCount: 3,
      unitProjections: [317381, 257917, 233562],
      provenance: {
        runId: "38993631473",
        runAttempt: "1",
        referenceJobId: 117281188248,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "6c96ee8ad75f87b6d1877c21cac9dd20d15e3fec",
        sourceBase: "008a50bb554b485dc29e187d381521a3463e24b6",
        captureParent: "008a50bb554b485dc29e187d381521a3463e24b6",
        artifactId: 12086274120,
        artifactSha256: "c61840e0565ad9157c0461e6b7fce50bdf6a87e1d643ff1afa3d4ad205c13c27",
        sourceManifestSha256: "90cd34be660d45eb17f8963e4067383d69b3242be821187aa82826b92d9983dc",
        caseManifestSha256: "acf95739611a9a0d43149339abfb008e9164dc26c5d49b7d02661678d5036013",
        commandsSha256: "db230c159f8f294a676fab11d92f3ea6a0a7aff52490c9f6d46f322b988fdb63",
        censusSha256: "670efd599e0ccd8844f14695ff97af5d5ec644d04057be4561eca61f611f6369",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-39189188404.json",
      fixtureSha256: "f3ed1246c7754d1fcbb78ca12ca1e2422eff547ece48b8af5ead63ac9f6e551f",
      minimumUnitCount: 2,
      unitProjections: [281848, 222020, 205908],
      provenance: {
        runId: "39189188404",
        runAttempt: "1",
        referenceJobId: 117857998398,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "09a69aba0a68a5d15c1b9c4afaecdb314e22edbc",
        sourceBase: "75cbdf65969bbec4db9fa09efb5fa87f5a850e30",
        captureParent: "75cbdf65969bbec4db9fa09efb5fa87f5a850e30",
        artifactId: 12159592465,
        artifactSha256: "289052208ebb786318edf9430325e680e7e7146683f127a3312d2d74ed328e8c",
        sourceManifestSha256: "7c6dc63d4a778c241abbbf77cf7f041ad4842d32457c6e636440dbe91ec7c9bb",
        caseManifestSha256: "acf95739611a9a0d43149339abfb008e9164dc26c5d49b7d02661678d5036013",
        commandsSha256: "db230c159f8f294a676fab11d92f3ea6a0a7aff52490c9f6d46f322b988fdb63",
        censusSha256: "b4efba85da0dd7b5618f98a7febde80b1a1f6c9744b3c8a353d9eda5fb1d1735",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "retains capture 39498669434 without changing its bytes or timing pins",
      current: false,
      fileName: "bootstrap-db-capture-39498669434.json",
      fixtureSha256: "87693854f8eff9c560f975885c39d847cdf064b8ecaea779861276a9bf8ddc7c",
      minimumUnitCount: 2,
      unitProjections: [309413, 252646, 208357],
      provenance: {
        runId: "39498669434",
        runAttempt: "1",
        referenceJobId: 118890240598,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "6e82b0cbe416476d93682cdb2424a99e4269b051",
        sourceBase: "56fa419c5d47cafd5455b7dbf496a4339ce61985",
        captureParent: "56fa419c5d47cafd5455b7dbf496a4339ce61985",
        artifactId: 12299388242,
        artifactSha256: "7d79c7ae24da85009ccb4109dc0531eac687c4677a7278abc5038d7c6492c9f7",
        sourceManifestSha256: "bfaf1f450635e1a0f30c816de0ca9f7b199f53aaa540d717bdab81531987cda1",
        caseManifestSha256: "1ebac423a80b43ed7ae0cf577817173a30272dee310c3f559f5acfcd6a595853",
        commandsSha256: "db230c159f8f294a676fab11d92f3ea6a0a7aff52490c9f6d46f322b988fdb63",
        censusSha256: "b4efba85da0dd7b5618f98a7febde80b1a1f6c9744b3c8a353d9eda5fb1d1735",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the shipped-only measured capture",
      current: false,
      fileName: "bootstrap-db-capture-39870394270.json",
      fixtureSha256: "2058f576aa05c86067c5c997d1e1c7ff163c08dc966e2c369c907281fe3abf0e",
      minimumUnitCount: 3,
      unitProjections: [308279, 251346, 225684],
      provenance: {
        runId: "39870394270",
        runAttempt: "1",
        referenceJobId: 120143072886,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "a3d4f1fbfc17a388baec36e868900e453ca3fb6b",
        sourceBase: "a57dc65728e37151d9ff180f13caa3d4408e44fd",
        captureParent: "a57dc65728e37151d9ff180f13caa3d4408e44fd",
        artifactId: 12466407557,
        artifactSha256: "f50cb1e723afbfe32f3897de2253aa40aaa50b92fed05d3d81d848fc07521f9c",
        sourceManifestSha256: "91c76fe24668909087c8595b4d01a62cdb45145fde3f81ca7db06db5460b3a69",
        caseManifestSha256: "ee4d7f56b776bf75a42ffffa3c8269aabc1e0b95b06a82ec5cf957d7244d10c7",
        commandsSha256: "c172ab0bb3565a3e4e53345f8d3845686b844357a41bf39d17f87249d74d5db8",
        censusSha256: "02fb19ecc1966cb95c3300dda9635c8fc5741319e8571b92c7c9cb721ca504b9",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "binds all 68 current cases to the measured capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-39950765563.json",
      fixtureSha256: "069b80a17b12282d4c76a8fee3b6f52b29f69d286b7a62911e2d98e370ff8687",
      minimumUnitCount: 2,
      unitProjections: [224879, 184426, 146248],
      provenance: {
        runId: "39950765563",
        runAttempt: "1",
        referenceJobId: 120404365557,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "a8c2312af4c0d8844655bdf700658e67da71bf96",
        sourceBase: "dfd8d09fb0a1bb621ed3353bf7a9c2dc610df888",
        captureParent: "dfd8d09fb0a1bb621ed3353bf7a9c2dc610df888",
        artifactId: 12501280008,
        artifactSha256: "9cfcf6535f57450f32193b9aa066b9d92e8421b0bc75093ea42df956d0796895",
        sourceManifestSha256: "b9e1bea7385a3015ed2274aef9e88ae3d04ed093252cfad89107aeb012c51c52",
        caseManifestSha256: "ee4d7f56b776bf75a42ffffa3c8269aabc1e0b95b06a82ec5cf957d7244d10c7",
        commandsSha256: "c172ab0bb3565a3e4e53345f8d3845686b844357a41bf39d17f87249d74d5db8",
        censusSha256: "02fb19ecc1966cb95c3300dda9635c8fc5741319e8571b92c7c9cb721ca504b9",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "enrolls the shipped three-unit minimum capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-40078269313.json",
      fixtureSha256: "97060597b7ec253ef1057a8d8a690a4035c21f594a0eabee6fca97b91817c3b6",
      minimumUnitCount: 3,
      unitProjections: [321800, 263356, 237231],
      provenance: {
        runId: "40078269313",
        runAttempt: "1",
        referenceJobId: 120826240548,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "a525f369c26580e2b0ab00ac2da620f789cfad02",
        sourceBase: "4b18cca2b65df8094fbe93d5c4213c421e6d842e",
        captureParent: "4b18cca2b65df8094fbe93d5c4213c421e6d842e",
        artifactId: 12555015054,
        artifactSha256: "4bd1666b47605b219f1d982d69f8d0147a899130d663263f801c48fd6df3d149",
        sourceManifestSha256: "ba82f8648e7a8b8aa189c808172bf76f4814aefa26c3cbc7f0c4d4c5c6b0dbe7",
        caseManifestSha256: "ee4d7f56b776bf75a42ffffa3c8269aabc1e0b95b06a82ec5cf957d7244d10c7",
        commandsSha256: "c172ab0bb3565a3e4e53345f8d3845686b844357a41bf39d17f87249d74d5db8",
        censusSha256: "02fb19ecc1966cb95c3300dda9635c8fc5741319e8571b92c7c9cb721ca504b9",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "enrolls the owner-fenced full-span bootstrap capture without reusing historical timings",
      current: false,
      fileName: "bootstrap-db-capture-40191794836.json",
      fixtureSha256: "a325259fdd8c67180173dc00d4659ff9203921d8ba75bd70d6371691c3bb5fb7",
      minimumUnitCount: 3,
      unitProjections: [349693, 317786, 241750],
      provenance: {
        runId: "40191794836",
        runAttempt: "1",
        referenceJobId: 121164147297,
        jobName: "Diagnostic API Bootstrap Measurement Only",
        checkoutSha: "8ef1e650fc3eeca774dc23a5ae6d97829d55add1",
        sourceBase: "fbf053edc1edb27b8d964d408a157433e700e203",
        captureParent: "fbf053edc1edb27b8d964d408a157433e700e203",
        artifactId: 12598777141,
        artifactSha256: "8e752e54d078442188e3a1e58c58edbff92d0ab0342a0d7572c8519b5691443a",
        sourceManifestSha256: "1a2e7df397a69cd7972dfad9d5c71f656f9ae3542116b0880c421a1d987e34ac",
        caseManifestSha256: "0e3f3aa5b411f541f8ca5cf629bb576c14ada39593e14e2e5a99f629e9fc8181",
        commandsSha256: "e9b65ec1c197aaacd8b9fbfd749b435e2a52ad75dad1f9516ced10e3595a01e8",
        censusSha256: "eece29126092eb26169e0b49f792b3447f19e5fe353a177d9f6160dd954d7408",
        maxWorkers: 3,
        laneMode: null,
      },
    },
    {
      label: "retains the owner-fenced full-span bootstrap capture from the prior source",
      current: false,
      fileName: "bootstrap-db-capture-40503475846.json",
      fixtureSha256: "e74084146e7e1b74fc20f506f66686fd6f9bfcd9d1cfe52f21d6b0b4dfacf43c",
      minimumUnitCount: 3,
      unitProjections: [331322, 302928, 236741],
      provenance: {
        runId: "40503475846",
        jobName: "Diagnostic API Bootstrap Measurement Only (current three-unit)",
        checkoutSha: "bc307faee97b259301c50dd840aeae613e745a51",
        sourceBase: "d46e459b4dd322c4a489c495e75081aaa05dcef5",
        captureParent: "d46e459b4dd322c4a489c495e75081aaa05dcef5",
        event: "workflow_dispatch",
        serialUnits: 3,
        maxWorkers: 3,
        modeledUnitCeilingMs: 420000,
        modeledAggregateCeilingMs: 1080000,
      },
    },
    {
      label: "retains the accepted three-unit capture with its paired floor provenance from the prior source",
      current: false,
      fileName: "bootstrap-db-capture-40787363393.json",
      fixtureSha256: "86efe3b6be6d7564ba65428c541c9bb2ff2db0bd85964278667d288d5c963475",
      minimumUnitCount: 3,
      unitProjections: [316502, 294420, 228019],
      provenance: {
        runId: "40787363393",
        jobName: "Diagnostic API Bootstrap Serial Measurement Only (current three-unit then paired two-unit)",
        checkoutSha: "eea73c584b2f7b52eacb0f852e01ac015cec9dbb",
        sourceBase: "01c54942854e1d6b6a1b8690f5fcbcb958f7d18b",
        captureParent: "01c54942854e1d6b6a1b8690f5fcbcb958f7d18b",
        event: "workflow_dispatch",
        serialUnits: 3,
        maxWorkers: 3,
        modeledUnitCeilingMs: 420000,
        modeledAggregateCeilingMs: 1080000,
      },
    },
    {
      label: "enrolls the accepted current-source three-unit capture with its paired floor provenance",
      current: true,
      fileName: "bootstrap-db-capture-41043769783.json",
      fixtureSha256: "a7d0015742db51a72aadb9558ecfceaf3042e628bcb79a35939f96c914e55d41",
      minimumUnitCount: 3,
      unitProjections: [332818, 309120, 235517],
      provenance: {
        runId: "41043769783",
        jobName: "Diagnostic API Bootstrap Serial Measurement Only (current three-unit then paired two-unit)",
        checkoutSha: "09ddc8649cfb19990e2184cef16d2f3baa9858fb",
        sourceBase: "dd61ceffeaa375991971fab46b79bec350a6e797",
        captureParent: "dd61ceffeaa375991971fab46b79bec350a6e797",
        event: "workflow_dispatch",
        serialUnits: 3,
        maxWorkers: 3,
        modeledUnitCeilingMs: 420000,
        modeledAggregateCeilingMs: 1080000,
      },
    },
  ] as const;

  type MeasuredCaptureFileName = (typeof measuredCaptures)[number]["fileName"];
  const measuredCaptureNonBootstrapFileCounts: Readonly<Record<MeasuredCaptureFileName, number>> = Object.freeze({
    "bootstrap-db-capture-38478206964.json": 6,
    "bootstrap-db-capture-38491485544.json": 6,
    "bootstrap-db-capture-38500650577.json": 6,
    "bootstrap-db-capture-38517513534.json": 6,
    "bootstrap-db-capture-38543786543.json": 6,
    "bootstrap-db-capture-38584224978.json": 6,
    "bootstrap-db-capture-38608022640.json": 6,
    "bootstrap-db-capture-38641988070.json": 6,
    "bootstrap-db-capture-38737899795.json": 6,
    "bootstrap-db-capture-38804356099.json": 6,
    "bootstrap-db-capture-38958136653.json": 6,
    "bootstrap-db-capture-38993631473.json": 6,
    "bootstrap-db-capture-39189188404.json": 6,
    "bootstrap-db-capture-39498669434.json": 6,
    "bootstrap-db-capture-39870394270.json": 4,
    "bootstrap-db-capture-39950765563.json": 4,
    "bootstrap-db-capture-40078269313.json": 4,
    "bootstrap-db-capture-40191794836.json": 4,
    "bootstrap-db-capture-40503475846.json": 4,
    "bootstrap-db-capture-40787363393.json": 4,
    "bootstrap-db-capture-41043769783.json": 4,
  });

  it.each(measuredCaptures)("$label", async ({ current, fileName, fixtureSha256, ...expected }) => {
    const { unitProjections, provenance, minimumUnitCount } = expected;
    const bytes = readFileSync(join(testDirectory, "fixtures", fileName));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixtureSha256);
    const capture = JSON.parse(bytes.toString("utf8")) as {
      provenance: Record<string, unknown>;
      model: BootstrapDbScheduleModel;
      jobWallMs: number;
      sourceBindings: Record<string, string>;
      acceptedAssignment: Record<string, string>;
      acceptedBootBearingCaseCeilings: Record<string, number>;
      measuredUnits: { unit: string; observedDurationMs: number; longestWorkerChainMs: number; residualMs: number }[];
      files: {
        fileName: string;
        testPath: string;
        executionUnit: string;
        sourceSha256: string;
        observedDurationMs: number;
        observedCaseSumMs: number;
        residualMs: number;
        cases: { name: string; identity: string; durationMs: number; referenceDurationMs: number }[];
      }[];
      nonBootstrapFiles: { testPath: string; executionUnit: string; sourceSha256: string }[];
    };
    expect(capture.provenance).toMatchObject(provenance);
    if (current) {
      expect(bootstrapDbScheduleModel).toEqual(capture.model);
      expect(capture.acceptedBootBearingCaseCeilings).toEqual({
        "test:db:1": 18,
        "test:db:2": 32,
        "test:db:3": 19,
      });
      expect(bootstrapDbExecutionUnitBootBearingCaseCeilings).toEqual(derivedBootBearingCaseCeilings);
      expect(platformApiNonBootstrapDbCensus).toEqual({
        referenceRunId: capture.model.referenceRunId,
        referenceJobId: capture.model.referenceJobId,
        entries: Object.fromEntries(capture.nonBootstrapFiles.map((file) => [file.testPath, file.executionUnit])),
      });
    }
    expect(capture.files).toHaveLength(12);
    expect(capture.nonBootstrapFiles).toHaveLength(measuredCaptureNonBootstrapFileCounts[fileName]);
    expect(capture.files.flatMap((file) => file.cases)).toHaveLength(
      current ||
        fileName === "bootstrap-db-capture-40191794836.json" ||
        fileName === "bootstrap-db-capture-40503475846.json" ||
        fileName === "bootstrap-db-capture-40787363393.json"
        ? 71
        : 68,
    );
    for (const file of capture.files) {
      if (current) {
        const partition = bootstrapDbEnrollmentManifest[file.fileName]!;
        const source = readFileSync(join(testDirectory, "..", file.testPath));
        expect(createHash("sha256").update(source).digest("hex")).toBe(file.sourceSha256);
        expect(deriveBootstrapDbCaseIdentities(file.fileName, source.toString("utf8"))).toEqual(
          file.cases.map(({ name, identity }) => ({ name, identity })),
        );
        expect(partition.executionUnit).toBe(derivedShippedAssignment[file.fileName]);
        expect(partition.cases).toEqual(
          file.cases.map(({ name, identity, durationMs }) => ({
            name,
            identity,
            referenceDurationMs: Math.ceil(durationMs),
          })),
        );
      }
      for (const testCase of file.cases) {
        expect(Number.isFinite(testCase.durationMs)).toBe(true);
        expect(testCase.durationMs).toBeGreaterThan(0);
        expect(testCase.referenceDurationMs).toBe(Math.ceil(testCase.durationMs));
      }
      expect(file.observedCaseSumMs).toBe(file.cases.reduce((sum, testCase) => sum + testCase.durationMs, 0));
      expect(file.residualMs).toBe(file.observedDurationMs - file.observedCaseSumMs);
    }
    for (const file of current ? capture.nonBootstrapFiles : []) {
      expect(
        createHash("sha256")
          .update(readFileSync(join(testDirectory, "..", file.testPath)))
          .digest("hex"),
      ).toBe(file.sourceSha256);
    }
    // sourceBindings stay immutable capture provenance. Freshness is the
    // workload the capture measured, re-derived from this checkout.
    if (current) {
      const { violations } = checkBootstrapDbWorkloadFreshness({
        baseline: readWorkloadBaseline(capture.provenance),
        capture: { fileName, fixtureSha256, provenance: capture.provenance },
        derivation: await liveWorkload(),
      });
      expect(violations).toEqual([]);
    }
    const { candidate: scheduler } = exactScheduleProbes();
    for (const unit of capture.measuredUnits) {
      expect(unit.longestWorkerChainMs).toBe(
        scheduler.worstCaseListScheduleMs(
          capture.files
            .filter((file) => file.executionUnit === unit.unit)
            .map((file) => Math.ceil(file.observedDurationMs)),
          3,
        ),
      );
      expect(unit.residualMs).toBe(unit.observedDurationMs - unit.longestWorkerChainMs);
    }
    expect(capture.model.testFileFixedCostMs).toBe(
      Math.ceil(Math.max(0, ...capture.files.map((file) => file.residualMs))),
    );
    expect(capture.model.executionUnitFixedCostMs).toBe(
      Math.ceil(Math.max(0, ...capture.measuredUnits.map((unit) => unit.residualMs))),
    );
    expect(capture.model.jobOverheadMs).toBe(
      Math.ceil(capture.jobWallMs - capture.measuredUnits.reduce((sum, unit) => sum + unit.observedDurationMs, 0)),
    );
    const fixture = await createShippedFixture(
      capture.files.map((file) => ({
        ...bootstrapDbEnrollmentManifest[file.fileName]!,
        fileName: file.fileName,
        executionUnit: current ? derivedShippedAssignment[file.fileName]! : file.executionUnit,
        cases: file.cases.map((testCase, index) => ({ ...testCase, body: `  expect(${index}).toBe(${index});` })),
      })),
      { model: capture.model },
    );
    const { schedule, violations } = runFixture(fixture);
    expect(violations).toEqual([
      ...unitProjections.flatMap((makespan, index) =>
        makespan > capture.model.executionUnitCeilingMs
          ? [
              `test:db:${index + 1} has a projected makespan of ${makespan}ms, exceeding the ${capture.model.executionUnitCeilingMs}ms per-unit ceiling`,
            ]
          : [],
      ),
      ...(unitProjections.length < minimumUnitCount
        ? [
            `the shipped topology spends ${unitProjections.length} execution units below the schedule model's minimumUnitCount of ${minimumUnitCount}`,
          ]
        : unitProjections.length > minimumUnitCount
          ? [
              `the shipped topology spends ${unitProjections.length} execution units where the schedule model's minimumUnitCount for the same ` +
                `file set is ${minimumUnitCount}; execution units of one workspace run serially, so an unnecessary unit is spent aggregate ` +
                "budget",
            ]
          : []),
    ]);
    expect(schedule.minimumUnitCount).toBe(minimumUnitCount);
    expect(schedule.units.map((unit) => unit.makespanMs)).toEqual(unitProjections);
    schedule.units.forEach((unit, index) =>
      expect(unit.makespanMs).toBeGreaterThanOrEqual(capture.measuredUnits[index]!.observedDurationMs),
    );
    expect(schedule.aggregateWithOverheadMs).toBeGreaterThanOrEqual(capture.jobWallMs);
  });

  it.each([
    "bootstrap-db-capture-40217094516.json",
    "bootstrap-db-capture-40252660960.json",
    "bootstrap-db-capture-40252660960-paired.json",
  ])("retains an executable enrollment consumer for %s", async (fileName) => {
    const capture = JSON.parse(readFileSync(join(testDirectory, "fixtures", fileName), "utf8")) as {
      provenance: Record<string, unknown>;
      model: BootstrapDbScheduleModel;
      files: { fileName: string; executionUnit: string; cases: { name: string; referenceDurationMs: number }[] }[];
    };
    const fixture = await createShippedFixture(
      capture.files.map((file) => ({
        ...bootstrapDbEnrollmentManifest[file.fileName]!,
        fileName: file.fileName,
        executionUnit: file.executionUnit,
        cases: file.cases.map((testCase, index) => ({ ...testCase, body: `  expect(${index}).toBe(${index});` })),
      })),
      { model: capture.model },
    );
    const result = runFixture(fixture);
    expect(result.fileCount).toBe(12);
    expect(result.caseCount).toBe(fileName === "bootstrap-db-capture-40217094516.json" ? 71 : 68);
    expect(result.schedule.files.map(({ fileName }) => fileName).sort()).toEqual(
      capture.files.map(({ fileName }) => fileName).sort(),
    );
    expect(result.schedule.minimumUnitCount).not.toBeNull();
    expect(result.schedule.units.every(({ makespanMs }) => makespanMs > 0)).toBe(true);
    if (!fileName.endsWith("-paired.json")) {
      const baseline = readWorkloadBaseline(capture.provenance);
      const checked = checkBootstrapDbWorkloadFreshness({
        baseline,
        capture: {
          fileName,
          fixtureSha256: sha256Of(readFileSync(join(testDirectory, "fixtures", fileName))),
          provenance: capture.provenance,
        },
        derivation: await liveWorkload(),
      });
      expect(checked.violations.length).toBeGreaterThan(0);
      expect(
        checked.violations.every((violation) => violation.includes(`capture ${String(capture.provenance.runId)}`)),
      ).toBe(true);
    }
  });

  const currentCaptures = measuredCaptures.filter((capture) => capture.current);

  type CaptureFixture = {
    provenance: Record<string, unknown>;
    files: { testPath: string; sourceSha256: string; cases: { name: string; identity: string }[] }[];
    nonBootstrapFiles: { testPath: string; sourceSha256: string }[];
    sourceBindings: Record<string, string>;
  };

  function readCurrentCapture() {
    const { fileName, fixtureSha256 } = currentCaptures[0]!;
    const capture = JSON.parse(readFileSync(join(testDirectory, "fixtures", fileName), "utf8")) as CaptureFixture;
    const binding: BootstrapDbWorkloadCaptureBinding = { fileName, fixtureSha256, provenance: capture.provenance };
    return { capture, binding };
  }

  function currentBaseline(): BootstrapDbWorkloadBaseline {
    const baseline = readWorkloadBaseline(readCurrentCapture().capture.provenance);
    const packageJson = JSON.parse(readFileSync(join(testDirectory, "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const partitionBindings = new Map(
      ["test:db:1", "test:db:2", "test:db:3"].map((unit) => {
        const command = packageJson.scripts[unit]!;
        const entries = command
          .split(/\s+/)
          .filter((entry) => entry.startsWith("__tests__/") && entry.endsWith(".db.test.ts"));
        return [unit, ["W1 partition", unit, { command, entries, maxWorkers: 3 }] as const];
      }),
    );
    const bindings = baseline.bindings;
    const replaced = bindings.map((binding) => {
      if (binding[0] === "W1 partition" && partitionBindings.has(binding[1])) {
        return partitionBindings.get(binding[1])!;
      }
      if (binding[0] === "W4 unit" && partitionBindings.has(binding[1])) {
        const existing = binding[2] as Record<string, unknown>;
        return [binding[0], binding[1], { ...existing, maxWorkers: 3 }] as const;
      }
      return binding;
    });
    return {
      ...baseline,
      bindings: [...replaced],
      bindingsSha256: sha256Of(canonicalJson(replaced)),
    };
  }

  // The old broad pins, the producer's frozen-source proof and every collision
  // reference belong to capture 38641988070 and read its committed frozen
  // source. Only W1-W5 follows the current capture, so a recapture neither
  // rebinds them nor regenerates the helper.
  const historicalCaptureFileName = "bootstrap-db-capture-38641988070.json";
  const frozenSourceFileName = "bootstrap-db-frozen-source-38641988070.json.gz";

  function readHistoricalCapture() {
    return JSON.parse(
      readFileSync(join(testDirectory, "fixtures", historicalCaptureFileName), "utf8"),
    ) as CaptureFixture;
  }

  /**
   * The capture's frozen source as exactly the members it measured, each with
   * the bytes its digest names. The gzip helper is generated outside CI from
   * provenance.sourceBase; a missing, corrupt or partial helper is refused.
   */
  function loadFrozenSource(gzipped: Uint8Array | null, capture: CaptureFixture): ReadonlyMap<string, Buffer> {
    const refused = (gaps: readonly string[]) =>
      new Error(`frozen source ${frozenSourceFileName} refused: ${gaps.join("; ")}`);
    if (!gzipped) throw refused(["it is missing"]);
    let helper: { sourceBase?: unknown; files?: Record<string, unknown> };
    try {
      helper = JSON.parse(gunzipSync(gzipped).toString("utf8"));
    } catch (error) {
      throw refused([`it is unreadable (${(error as Error).message})`]);
    }
    if (typeof helper !== "object" || helper === null) {
      throw refused(["it is unreadable (its root is not a JSON object)"]);
    }
    const files = helper.files ?? {};
    const expected = new Map([
      ...[...capture.files, ...capture.nonBootstrapFiles].map(
        ({ testPath, sourceSha256 }) => [`deployables/platform-api/${testPath}`, sourceSha256] as const,
      ),
      ...Object.entries(capture.sourceBindings),
    ]);
    const gaps = [
      ...(helper.sourceBase === capture.provenance.sourceBase
        ? []
        : [`it was not generated from ${String(capture.provenance.sourceBase)}`]),
      ...[...expected.keys()].filter((path) => !Object.hasOwn(files, path)).map((path) => `it is missing ${path}`),
      ...Object.keys(files)
        .filter((path) => !expected.has(path))
        .map((path) => `it adds ${path}, which the capture does not bind`),
      ...[...expected]
        .filter(([path, digest]) => {
          const text = files[path];
          return Object.hasOwn(files, path) && (typeof text !== "string" || sha256Of(text) !== digest);
        })
        .map(([path]) => `${path} differs from the capture`),
    ];
    if (gaps.length > 0) throw refused(gaps);
    return new Map(Object.entries(files as Record<string, string>).map(([path, text]) => [path, Buffer.from(text)]));
  }

  let frozenSource: ReadonlyMap<string, Buffer> | undefined;

  function readFrozenSourceFile(path: string) {
    const helper = join(testDirectory, "fixtures", frozenSourceFileName);
    frozenSource ??= loadFrozenSource(existsSync(helper) ? readFileSync(helper) : null, readHistoricalCapture());
    return frozenSource.get(path) ?? null;
  }

  // An unmistakably synthetic recapture of this checkout: W1-W5 must follow
  // it, while the old pins and frozen reads stay on capture 38641988070.
  async function newerCurrentCapture() {
    const derivation = await liveWorkload();
    const { binding } = readCurrentCapture();
    const sourceBase = "0000000000000000000000000000000000006547";
    const captureBytes = Buffer.from(
      JSON.stringify({
        provenance: {
          ...binding.provenance,
          runId: "65440004",
          checkoutSha: "0000000000000000000000000000000000006548",
          sourceBase,
          captureParent: sourceBase,
        },
      }),
    );
    const newer: BootstrapDbWorkloadCaptureBinding = {
      fileName: "bootstrap-db-capture-65440004.json",
      fixtureSha256: sha256Of(captureBytes),
      provenance: JSON.parse(captureBytes.toString("utf8")).provenance,
    };
    expect(
      checkBootstrapDbWorkloadFreshness({ baseline: currentBaseline(), capture: newer, derivation }).violations,
    ).toEqual([
      `baseline binds capture ${binding.fileName} but the current capture is ${newer.fileName}; derive the baseline from the current capture's own frozen source`,
      `baseline was derived from ${currentBaseline().source.commit}, not the capture's frozen source ${sourceBase}`,
    ]);
    const baseline = createBootstrapDbWorkloadBaseline({
      captureFileName: newer.fileName,
      captureBytes,
      source: { commit: sourceBase },
      derivation,
    }) as BootstrapDbWorkloadBaseline;
    return { binding: newer, baseline };
  }

  const runId = "41043769783";
  const changed = (key: string) => `${key} changed since capture ${runId}; re-enrollment required`;
  const added = (key: string) => `${key} is workload the capture ${runId} did not measure; re-enrollment required`;
  const removed = (key: string) =>
    `${key} measured by capture ${runId} is absent from the derived workload; re-enrollment required`;
  const refused = (gap: string) => `workload input refused: ${gap}`;
  // The retained current capture predates the two Catalog source changes on
  const knownCurrentCaptureDrift: readonly string[] = [];
  const expectedKnownDrift = (capture: BootstrapDbWorkloadCaptureBinding) =>
    capture.fileName === "bootstrap-db-capture-41043769783.json" ? [...knownCurrentCaptureDrift] : [];

  async function mirrorFreshness(
    edits: Readonly<Record<string, WorkloadEdit>>,
    baseline: BootstrapDbWorkloadBaseline = currentBaseline(),
    capture: BootstrapDbWorkloadCaptureBinding = readCurrentCapture().binding,
  ) {
    const mirror = await createWorkloadMirror(edits);
    const derivation = await deriveBootstrapDbWorkload({ repositoryRoot: mirror });
    const { violations } = checkBootstrapDbWorkloadFreshness({ baseline, capture, derivation });
    return { mirror, violations: [...violations].sort() };
  }

  // The superseded live loop, kept only as the control that shows each
  // provenance-only edit below was rejected by the old broad pins, which were
  // capture 38641988070's. `pairedPins` replaces a pin only for the control
  // whose paired reference is not that capture's frozen source.
  function broadSourceBindingMismatches(root: string, pairedPins: Readonly<Record<string, string>> = {}) {
    return Object.entries({ ...readHistoricalCapture().sourceBindings, ...pairedPins })
      .filter(([path, digest]) => sha256Of(readFileSync(join(root, path))) !== digest)
      .map(([path]) => path);
  }

  function selectionKey(contextName: string) {
    const binding = currentBaseline().bindings.find(
      ([section, key]) => section === "W3 selection" && key.endsWith(` ${contextName}`),
    );
    expect(binding).toBeDefined();
    return `W3 selection ${binding![1]}`;
  }

  function platformApiImporter(source: string, edit: (block: string) => string) {
    const start = source.indexOf("\n  deployables/platform-api:\n");
    const end = source.indexOf("\n  deployables/", start + 1);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(0, start) + edit(source.slice(start, end)) + source.slice(end);
  }

  describe("capture provenance remains immutable", () => {
    it("keeps every measured capture byte-identical and binds the baseline to the sole current capture's frozen source", () => {
      const fixtures = readdirSync(join(testDirectory, "fixtures"))
        .sort()
        .filter((name) => /^bootstrap-db-capture-\d+(?:-paired)?\.json$/.test(name));
      expect(
        Object.fromEntries(
          fixtures.map((name) => [name, sha256Of(readFileSync(join(testDirectory, "fixtures", name)))]),
        ),
      ).toEqual({
        "bootstrap-db-capture-37467774999.json": "957f5dccb19eb2bde1a906c3b27e9ded81886898ae375899f283a879eb01aff6",
        "bootstrap-db-capture-37888294087.json": "98f7bda29e144e0c42d78ab421a56191846e903c04d9d95668651c3288b0d9d5",
        "bootstrap-db-capture-37916297464.json": "ceeaa00f994bcef118b49f2c773facc807e8622f001d6c9e02cfd4476580a71a",
        "bootstrap-db-capture-39187412107.json": "3a3afe4966627e94f7cb08f30fcaf6a55237e0446c5899d1f9804ef3286e047c",
        "bootstrap-db-capture-40252660960-paired.json":
          "97dd9b20d7ecc20dcd5291176b1555b83845dfc4bef89047106ce95721d6198c",
        "bootstrap-db-capture-40252660960.json": "5b25ed93307194d218319c093f5e42db227457481551d00583da0164bd020a9d",
        "bootstrap-db-capture-40217094516.json": "93c49b3ff67b8d1cbefd810f13af1a64c57259f67799f060e924256d5e53dd47",
        "bootstrap-db-capture-39950765563-paired.json":
          "7c5e0121be006248eab23e4a02ff341e25b628ae282c9b8bf6abc420834de813",
        "bootstrap-db-capture-40787363393-paired.json":
          "c0bbbb3bf4e7f994f07ac2fb3c716d6dffcf2180e05ef540f263f5315633e69a",
        ...Object.fromEntries(measuredCaptures.map(({ fileName, fixtureSha256 }) => [fileName, fixtureSha256])),
        ...Object.fromEntries(
          Object.values(historicalMeasuredFloorCaptures).map(({ fileName, fixtureSha256 }) => [
            fileName,
            fixtureSha256,
          ]),
        ),
        ...Object.fromEntries(
          Object.values(currentMeasuredFloorCaptures).map(({ fileName, fixtureSha256 }) => [fileName, fixtureSha256]),
        ),
      });
      expect(currentCaptures).toHaveLength(1);

      const { capture, binding } = readCurrentCapture();
      const baseline = currentBaseline();
      expect(baseline.capture).toEqual({
        fileName: binding.fileName,
        fixtureSha256: binding.fixtureSha256,
        runId: capture.provenance.runId,
        checkoutSha: capture.provenance.checkoutSha,
        sourceBase: capture.provenance.sourceBase,
        captureParent: capture.provenance.captureParent,
      });
      expect(baseline.source).toEqual(
        expect.objectContaining({
          commit: capture.provenance.sourceBase,
        }),
      );
      expect(baseline.source.commit).toBe(capture.provenance.sourceBase);
      expect(baseline.bindingsSha256).toBe(sha256Of(canonicalJson(baseline.bindings)));
      // 8,137 entries are bound by the accepted current capture source manifest.
      expect(Object.keys(capture.sourceBindings)).toHaveLength(8137);

      // Every digest the capture measured that is also a workload member
      // reproduces in the baseline, so the baseline was derived from the
      // capture's bytes rather than from today's checkout.
      const bound = new Map(baseline.bindings.map(([section, key, value]) => [`${section} ${key}`, value]));
      for (const file of [...capture.files, ...capture.nonBootstrapFiles]) {
        expect(bound.get(`W1 file deployables/platform-api/${file.testPath}`), file.testPath).toBe(file.sourceSha256);
      }
      for (const file of capture.files) {
        expect(bound.get(`W1 case identities deployables/platform-api/${file.testPath}`)).toEqual(
          file.cases.map(({ name, identity }) => ({ name, identity })),
        );
      }
      const members = new Map(
        baseline.bindings
          .filter(([section]) => / file$| json$/.test(section))
          .map(([section, key, value]) => [key, { section, value }]),
      );
      const manifests = new Set(
        baseline.bindings
          .filter(([section]) => section === "W3 selection")
          .map(([, , value]) => (value as { manifest: string }).manifest),
      );
      const dispositions = Object.fromEntries(
        Object.entries(capture.sourceBindings).map(([path, digest]) => {
          const member = members.get(path);
          if (member) expect(member.value, path).toBe(digest);
          return [path, member?.section ?? (manifests.has(path) ? "W3 selection" : "provenance-only")];
        }),
      );
      // Lockfile and shared-config bytes stay provenance; their W5 and W4
      // values are bound and refuse independently below.
      expect(
        Object.fromEntries(Object.entries(dispositions).filter(([, section]) => section !== "provenance-only")),
      ).toEqual({
        "bounded-contexts/auth/context.json": "W3 selection",
        "bounded-contexts/auth/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/auth/support/seed-support/store.ts": "W3 file",
        "bounded-contexts/authenticity/context.json": "W3 selection",
        "bounded-contexts/catalog/context.json": "W3 selection",
        "bounded-contexts/catalog/features/blueprints/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/catalog-items/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/categories/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/components/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/dimensions/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/display-templates/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/fields/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/product-contents/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/product-measures/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/reference-data/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/base2-60-scenario.json":
          "W3 json",
        "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/normal.json": "W3 json",
        "bounded-contexts/catalog/features/source-observations/api/provider-integration-profile-store.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/representative-catalog-replay.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/asset-storage.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/observation-pack-asset-references.test.ts":
          "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/observation-pack-asset-references.ts":
          "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/observation-pack-capture.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/observation-pack.test.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/observation-pack.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/product-asset-normalization.test.ts":
          "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/product-asset-normalization.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/representative-catalog-replay.test.ts":
          "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/representative-catalog-replay.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/runtime-test-harness.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/seed-migration.test.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/seed.db.test.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/seed.test.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/seed.ts": "W3 file",
        "bounded-contexts/catalog/features/source-observations/api/seeding/synthetic-display-identity-queryable.ts":
          "W3 file",
        "bounded-contexts/catalog/support/authoring-support/seed.ts": "W3 file",
        "bounded-contexts/catalog/support/seed-support/aggregate-state.ts": "W3 file",
        "bounded-contexts/catalog/support/seed-support/catalog-integration-state.ts": "W3 file",
        "bounded-contexts/catalog/support/seed-support/context.ts": "W3 file",
        "bounded-contexts/channels/context.json": "W3 selection",
        "bounded-contexts/channels/features/connections/tests/browser-state-fixture.test-data.ts": "W2 file",
        "bounded-contexts/channels/features/connector-feed/tests/settlement-test-support.ts": "W2 file",
        "bounded-contexts/channels/features/manual-sync/api/seed.ts": "W3 file",
        "bounded-contexts/channels/support/seed-support/channel-connection-browser.ts": "W3 file",
        "bounded-contexts/channels/support/seed-support/channel-publication-browser.ts": "W3 file",
        "bounded-contexts/checkout/context.json": "W3 selection",
        "bounded-contexts/checkout/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/checkout/support/seed-support/fixtures/sell-list-recovery-browser-fixture.ts": "W3 file",
        "bounded-contexts/checkout/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/collections/context.json": "W3 selection",
        "bounded-contexts/commercial-terms/context.json": "W3 selection",
        "bounded-contexts/commercial-terms/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/commercial-terms/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/customer-feedback/context.json": "W3 selection",
        "bounded-contexts/discovery/context.json": "W3 selection",
        "bounded-contexts/fulfillment/context.json": "W3 selection",
        "bounded-contexts/fulfillment/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/fulfillment/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/identity/context.json": "W3 selection",
        "bounded-contexts/identity/features/account-management/tests/browser-test-support.ts": "W2 file",
        "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts": "W3 file",
        "bounded-contexts/identity/support/runtime-support/bootstrap-context.ts": "W3 file",
        "bounded-contexts/identity/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/identity/support/seed-support/account-management-browser.ts": "W3 file",
        "bounded-contexts/identity/support/seed-support/ids.test.ts": "W3 file",
        "bounded-contexts/identity/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/identity/support/seed-support/market-following-verification.test.ts": "W3 file",
        "bounded-contexts/identity/support/seed-support/market-following-verification.ts": "W3 file",
        "bounded-contexts/inventory/context.json": "W3 selection",
        "bounded-contexts/inventory/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/inventory/support/seed-support/context.ts": "W3 file",
        "bounded-contexts/inventory/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/inventory/support/seed-support/mutation-command.ts": "W3 file",
        "bounded-contexts/inventory/support/seed-support/representative-services.ts": "W3 file",
        "bounded-contexts/inventory/support/seed-support/restock-recovery-browser.ts": "W3 file",
        "bounded-contexts/marketplace/context.json": "W3 selection",
        "bounded-contexts/marketplace/features/listing-evidence-policy/integrations/seed.ts": "W3 file",
        "bounded-contexts/marketplace/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/marketplace/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/notifications/context.json": "W3 selection",
        "bounded-contexts/ordering/context.json": "W3 selection",
        "bounded-contexts/ordering/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/ordering/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/payments/context.json": "W3 selection",
        "bounded-contexts/payments/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/payments/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/platform-operations/context.json": "W3 selection",
        "bounded-contexts/platform-operations/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/platform-operations/support/seed-support/ids.ts": "W3 file",
        "bounded-contexts/pricing/context.json": "W3 selection",
        "bounded-contexts/pricing/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/public-presence/context.json": "W3 selection",
        "bounded-contexts/public-presence/features/promo-bar/api/seed.ts": "W3 file",
        "bounded-contexts/public-presence/features/waitlist/api/seed.ts": "W3 file",
        "bounded-contexts/settlement/context.json": "W3 selection",
        "bounded-contexts/settlement/support/runtime-support/seed.ts": "W3 file",
        "bounded-contexts/settlement/support/seed-support/ids.ts": "W3 file",
        "contracts/catalog-seed/fallback-assets.ts": "W3 file",
        "contracts/catalog-seed/ids.ts": "W3 file",
        "contracts/catalog-seed/index.ts": "W3 file",
        "contracts/catalog-seed/package.json": "W3 file",
        "contracts/catalog-seed/representative-commerce-state.ts": "W3 file",
        "contracts/catalog-seed/scenario.ts": "W3 file",
        "contracts/catalog-seed/tsconfig.json": "W3 file",
        "contracts/catalog-seed/vitest.config.ts": "W3 file",
        "contracts/event-core/test-support.ts": "W2 file",
        "contracts/identity-seed/ids.ts": "W3 file",
        "contracts/identity-seed/index.ts": "W3 file",
        "contracts/identity-seed/package.json": "W3 file",
        "contracts/identity-seed/tsconfig.json": "W3 file",
        "contracts/identity-seed/vitest.config.ts": "W3 file",
        "contracts/money-movement/test-support.ts": "W2 file",
        "contracts/payment-processing/test-support.ts": "W2 file",
        "contracts/postage-labels/test-support.ts": "W2 file",
        "deployables/platform-api/__tests__/authoritative-seed-resume-core.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/authoritative-seed-resume-reconciliation.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/authoritative-seed-resume-recovery.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/authoritative-seed-resume-test-support.ts": "W2 file",
        "deployables/platform-api/__tests__/bootstrap-db-test-support.ts": "W2 file",
        "deployables/platform-api/__tests__/bootstrap-lock-contention.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/bootstrap-production-reconciliation.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/bootstrap-scenario.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/bootstrap-shared-seed-command.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/catalog-seed-aggregate-state.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/catalog-seed-interruption-resume.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/catalog-seed-test-support.ts": "W2 file",
        "deployables/platform-api/__tests__/connector-mount-gate-isolation.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/inventory-seed-resume.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/operator-session/db-fixture.ts": "W2 file",
        "deployables/platform-api/__tests__/operator-session/fixture.ts": "W2 file",
        "deployables/platform-api/__tests__/operator-session/operator-session-grant-mint.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/operator-session/operator-session-grant-scope.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/operator-session/operator-session-push.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/seed-command-catalog.db.test.ts": "W1 file",
        "deployables/platform-api/__tests__/seed-command-full-pools.db.test.ts": "W1 file",
        "deployables/platform-api/src/admin-qa-actor-fixtures.ts": "W3 file",
        "deployables/platform-api/src/database-pools.ts": "W3 file",
        "deployables/platform-api/src/representative-commerce-state.ts": "W3 file",
        "deployables/platform-api/src/test-support/provider-gateways.ts": "W2 file",
        "infrastructure/bounded-context-runtime/seed-aggregate-state.ts": "W3 file",
        "infrastructure/bounded-context-runtime/seeding.ts": "W3 file",
        "infrastructure/bounded-context-runtime/test-support.ts": "W3 file",
        "infrastructure/platform-runtime/api.ts": "W3 file",
        "infrastructure/platform-runtime/context-pools.ts": "W3 file",
        "infrastructure/platform-runtime/host-runtime-selection.ts": "W3 file",
      });
      // The digest pins the whole map, including the provenance-only remainder.
      expect(sha256Of(canonicalJson(dispositions))).toBe(
        "cca05134ec79bcfa84aba837163abb4f57e58c5e25a36b4b441bdbbeb233111c",
      );

      // The baseline's hosted values are the ones the capture executed under.
      if ("vitest" in capture.provenance) {
        expect(String(capture.provenance.vitest)).toMatch(
          new RegExp(`^vitest/${String(bound.get("W5 version vitest"))} `),
        );
      }
      if ("postgresImage" in capture.provenance) {
        expect(bound.get("W4 postgres image")).toBe(capture.provenance.postgresImage);
      }
      if ("workspaceConcurrency" in capture.provenance) {
        expect(bound.get("W4 postgres workspaceConcurrency")).toBe(String(capture.provenance.workspaceConcurrency));
      }
      if ("serialUnits" in capture.provenance) {
        const serialUnitCount = Number(capture.provenance.serialUnits);
        for (const unit of Array.from({ length: serialUnitCount }, (_, index) => `test:db:${index + 1}`)) {
          expect(bound.get(`W1 partition ${unit}`)).toMatchObject({ maxWorkers: capture.provenance.maxWorkers });
          // CI-dependent defaults resolve as on the hosted runner, not this host.
          expect(bound.get(`W4 unit ${unit}`)).toMatchObject({
            maxWorkers: capture.provenance.maxWorkers,
            allowOnly: false,
          });
        }
      }
      if ("laneMode" in capture.provenance) {
        expect(capture.provenance.laneMode).toBeNull();
      }
    });

    it("refuses a substituted or missing capture, frozen source or baseline", async () => {
      const derivation = await liveWorkload();
      const baseline = currentBaseline();
      const { binding } = readCurrentCapture();
      expect(checkBootstrapDbWorkloadFreshness({ baseline, capture: binding, derivation }).violations).toEqual(
        knownCurrentCaptureDrift,
      );

      expect(
        checkBootstrapDbWorkloadFreshness({
          baseline,
          capture: { ...binding, fixtureSha256: "f".repeat(64) },
          derivation,
        }).violations,
      ).toEqual([
        `baseline binds capture ${binding.fileName} but the current capture is ${binding.fileName}; derive the baseline from the current capture's own frozen source`,
      ]);
      expect(checkBootstrapDbWorkloadFreshness({ baseline, capture: undefined, derivation }).violations).toEqual([
        "no current capture is bound; a baseline cannot certify freshness without one",
      ]);
      const newer = {
        fileName: "bootstrap-db-capture-99999999999.json",
        fixtureSha256: "e".repeat(64),
        provenance: {
          ...binding.provenance,
          runId: "99999999999",
          sourceBase: "1".repeat(40),
          captureParent: "1".repeat(40),
        },
      };
      expect(checkBootstrapDbWorkloadFreshness({ baseline, capture: newer, derivation }).violations).toEqual([
        `baseline binds capture ${binding.fileName} but the current capture is ${newer.fileName}; derive the baseline from the current capture's own frozen source`,
        `baseline was derived from ${baseline.source.commit}, not the capture's frozen source ${"1".repeat(40)}`,
      ]);
      expect(
        checkBootstrapDbWorkloadFreshness({
          baseline: { ...baseline, source: { ...baseline.source, commit: "2".repeat(40) } },
          capture: binding,
          derivation,
        }).violations,
      ).toEqual([
        `baseline was derived from ${"2".repeat(40)}, not the capture's frozen source ${baseline.source.commit}`,
      ]);
      expect(
        checkBootstrapDbWorkloadFreshness({ baseline: undefined, capture: binding, derivation }).violations,
      ).toContain("baseline is missing");

      // The producer's frozen-source proof: capture 38641988070's own digests
      // decide over its committed frozen source, never this checkout's bytes.
      const capture = readHistoricalCapture();
      expect(bindFrozenSourceToCapture({ capture, readSourceFile: readFrozenSourceFile }).violations).toEqual([]);
      expect(
        bindFrozenSourceToCapture({
          capture,
          readSourceFile: (path) =>
            path === "deployables/platform-api/src/app.ts" ? null : readFrozenSourceFile(path),
        }).violations,
      ).toEqual(["frozen source is missing deployables/platform-api/src/app.ts"]);
      expect(
        bindFrozenSourceToCapture({
          capture,
          readSourceFile: (path) =>
            path.endsWith("bootstrap-scenario.db.test.ts") ? Buffer.from("substituted") : readFrozenSourceFile(path),
        }).violations,
      ).toEqual([
        "frozen source deployables/platform-api/__tests__/bootstrap-scenario.db.test.ts differs from the capture; substituted source",
      ]);
      expect(bindFrozenSourceToCapture({ capture: {}, readSourceFile: readFrozenSourceFile }).violations).toEqual([
        "capture records no source digests to bind the frozen source to",
      ]);
    });

    it("keeps the producer proof on capture 38641988070's frozen source while W1-W5 follows a newer capture", async () => {
      const newer = await newerCurrentCapture();
      expect(
        checkBootstrapDbWorkloadFreshness({
          baseline: newer.baseline,
          capture: newer.binding,
          derivation: await liveWorkload(),
        }).violations,
      ).toEqual([]);
      const capture = readHistoricalCapture();
      expect(capture.provenance.runId).toBe("38641988070");
      expect(bindFrozenSourceToCapture({ capture, readSourceFile: readFrozenSourceFile }).violations).toEqual([]);

      // A recapture that measured other bytes cannot certify, or be served by,
      // the historical helper.
      const app = "deployables/platform-api/src/app.ts";
      const remeasured = {
        ...capture,
        provenance: newer.binding.provenance,
        sourceBindings: { ...capture.sourceBindings, [app]: "0".repeat(64) },
      };
      expect(
        bindFrozenSourceToCapture({ capture: remeasured, readSourceFile: readFrozenSourceFile }).violations,
      ).toEqual([`frozen source ${app} differs from the capture; substituted source`]);
      expect(() =>
        loadFrozenSource(readFileSync(join(testDirectory, "fixtures", frozenSourceFileName)), remeasured),
      ).toThrow(
        new Error(
          `frozen source ${frozenSourceFileName} refused: it was not generated from ${String(newer.binding.provenance.sourceBase)}; ${app} differs from the capture`,
        ),
      );
    });

    it("refuses a missing or corrupt frozen source and any deleted, substituted, added or truncated member", () => {
      const capture = readHistoricalCapture();
      const gzipped = readFileSync(join(testDirectory, "fixtures", frozenSourceFileName));
      const helper = JSON.parse(gunzipSync(gzipped).toString("utf8")) as {
        sourceBase: string;
        files: Record<string, string>;
      };
      expect(helper.sourceBase).toBe(capture.provenance.sourceBase);
      expect(Object.keys(helper.files)).toHaveLength(61);
      expect([...loadFrozenSource(gzipped, capture).keys()].sort()).toEqual(Object.keys(helper.files).sort());

      const rewritten = (edit: (files: Record<string, string>) => void, sourceBase = helper.sourceBase) => {
        const files = { ...helper.files };
        edit(files);
        return gzipSync(JSON.stringify({ sourceBase, files }));
      };
      const refusal = (gap: string) => new Error(`frozen source ${frozenSourceFileName} refused: ${gap}`);
      const app = "deployables/platform-api/src/app.ts";
      expect(() => loadFrozenSource(null, capture)).toThrow(refusal("it is missing"));
      expect(() =>
        loadFrozenSource(
          rewritten((files) => delete files[app]),
          capture,
        ),
      ).toThrow(refusal(`it is missing ${app}`));
      expect(() =>
        loadFrozenSource(
          rewritten((files) => (files[app] = "substituted")),
          capture,
        ),
      ).toThrow(refusal(`${app} differs from the capture`));
      expect(() =>
        loadFrozenSource(
          rewritten((files) => (files["synthetic/added.ts"] = "export {};\n")),
          capture,
        ),
      ).toThrow(refusal("it adds synthetic/added.ts, which the capture does not bind"));
      expect(() =>
        loadFrozenSource(
          rewritten((files) => (files["pnpm-lock.yaml"] = files["pnpm-lock.yaml"]!.slice(0, -1))),
          capture,
        ),
      ).toThrow(refusal("pnpm-lock.yaml differs from the capture"));
      expect(() =>
        loadFrozenSource(
          rewritten(() => {}, "1".repeat(40)),
          capture,
        ),
      ).toThrow(refusal(`it was not generated from ${helper.sourceBase}`));

      const corrupt = Buffer.from(gzipped);
      corrupt[corrupt.length >> 1]! ^= 0xff;
      expect(() => loadFrozenSource(corrupt, capture)).toThrow(
        /^frozen source bootstrap-db-frozen-source-38641988070\.json\.gz refused: it is unreadable \(.+\)$/,
      );
      expect(() => loadFrozenSource(gzipped.subarray(0, gzipped.length - 1024), capture)).toThrow(
        refusal("it is unreadable (unexpected end of file)"),
      );
      expect(() => loadFrozenSource(gzipSync("null"), capture)).toThrow(
        refusal("it is unreadable (its root is not a JSON object)"),
      );
    });
  });

  describe("DB workspace concurrency derives from the API matrix cell", () => {
    const workflowPath = join(repositoryRoot, ".github/workflows/platform-pr.yml");

    it("resolves the exact b1bbb7ec workflow expression to API concurrency 2", () => {
      const result = resolveApiDbWorkspaceConcurrency(readFileSync(workflowPath, "utf8"));
      expect(result).toEqual({ value: "2", gaps: [] });
    });

    it.each([
      {
        label: "an other-only expression",
        edit: (workflow: string) =>
          workflow.replace(
            "${{ matrix.db-workspace-group == 'other' && '3' || '2' }}",
            "${{ matrix.db-workspace-group == 'other' && '3' }}",
          ),
      },
      {
        label: "a literal removed without an environment declaration",
        edit: (workflow: string) => workflow.replace(/^\s*DB_WORKSPACE_CONCURRENCY:.*\r?\n/m, ""),
      },
      {
        label: "two environment declarations",
        edit: (workflow: string) =>
          workflow.replace(
            "      DB_WORKSPACE_CONCURRENCY: ${{ matrix.db-workspace-group == 'other' && '3' || '2' }}",
            "      DB_WORKSPACE_CONCURRENCY: ${{ matrix.db-workspace-group == 'other' && '3' || '2' }}\n      DB_WORKSPACE_CONCURRENCY: ${{ matrix.db-workspace-group == 'other' && '3' || '2' }}",
          ),
      },
      {
        label: "a non-integer value",
        edit: (workflow: string) => workflow.replace("&& '3' || '2'", "&& 'three' || '2'"),
      },
      {
        label: "a literal and environment concurrency together",
        edit: (workflow: string) =>
          workflow.replace(
            '--concurrency="$DB_WORKSPACE_CONCURRENCY"',
            '--concurrency=2 --concurrency="$DB_WORKSPACE_CONCURRENCY"',
          ),
      },
    ])("fails closed for $label", ({ edit }) => {
      const result = resolveApiDbWorkspaceConcurrency(edit(readFileSync(workflowPath, "utf8")));
      expect(result.value).toBeNull();
      expect(result.gaps.length).toBeGreaterThan(0);
    });
  });

  describe("producer reads only local Git objects", () => {
    const syntheticEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Synthetic Probe",
      GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic Probe",
      GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
    };
    const syntheticGit = (repository: string, args: string[], input?: string) =>
      execFileSync("git", ["-C", repository, ...args], { env: syntheticEnv, input, encoding: "utf8" }).trim();
    const objectStore = (gitDirectory: string) =>
      readdirSync(join(gitDirectory, "objects"), { recursive: true, encoding: "utf8" }).sort();

    // An unmistakably synthetic origin reachable only as a local file:// remote;
    // the consumer optionally holds the source commit and tree but never the
    // promised blob, so any lazy fetch would add objects to its store.
    async function runProducerInSyntheticClone({
      present,
      config,
    }: {
      present: boolean;
      config: Record<string, string>;
    }) {
      const root = await mkdtemp(join(tmpdir(), "db-enrollment-local-objects-"));
      temporaryRoots.push(root);
      const origin = join(root, "origin.git");
      const consumer = join(root, "consumer");
      syntheticGit(root, ["init", "--quiet", "--bare", origin]);
      syntheticGit(root, ["init", "--quiet", consumer]);
      const bytes = "unmistakably synthetic local-only fixture\n";
      const blob = syntheticGit(origin, ["hash-object", "-w", "--stdin"], bytes);
      const tree = syntheticGit(origin, ["mktree"], `100644 blob ${blob}\tsynthetic-marker.txt\n`);
      const commit = syntheticGit(origin, ["commit-tree", tree, "-m", "synthetic local-only fixture"]);
      syntheticGit(origin, ["update-ref", "refs/heads/main", commit]);
      if (present) {
        for (const id of [commit, tree]) {
          const loose = join("objects", id.slice(0, 2), id.slice(2));
          await mkdir(dirname(join(consumer, ".git", loose)), { recursive: true });
          await copyFile(join(origin, loose), join(consumer, ".git", loose));
        }
      }
      syntheticGit(consumer, ["config", "remote.synthetic.url", pathToFileURL(origin).href]);
      for (const [key, value] of Object.entries(config)) syntheticGit(consumer, ["config", key, value]);

      const capturePath = join(root, "synthetic-capture.json");
      await writeFile(
        capturePath,
        JSON.stringify({
          provenance: { runId: "65449999", sourceBase: commit, captureParent: commit },
          sourceBindings: { "synthetic-marker.txt": sha256Of(bytes) },
        }),
      );
      const outPath = join(root, "synthetic-baseline.json");
      const tracePath = join(root, "git-trace.log").replaceAll("\\", "/");
      const gitDirectory = join(consumer, ".git");
      const before = objectStore(gitDirectory);
      const run = spawnSync(
        process.execPath,
        [
          join(testDirectory, "../scripts/db-enrollment-workload.mjs"),
          "--check",
          "--capture",
          capturePath,
          "--out",
          outPath,
        ],
        { env: { ...syntheticEnv, GIT_DIR: gitDirectory, GIT_TRACE: tracePath }, encoding: "utf8" },
      );
      const commands = [...readFileSync(tracePath, "utf8").matchAll(/trace: built-in: git (\S+)/g)].map(
        ([, command]) => command,
      );
      return { run, commit, commands, before, after: objectStore(gitDirectory), outputWritten: existsSync(outPath) };
    }

    it.each<{ label: string; present: boolean; config: Record<string, string>; names: string }>([
      {
        label: "a partial clone missing the source commit",
        present: false,
        config: {
          "remote.synthetic.promisor": "true",
          "remote.synthetic.partialclonefilter": "blob:none",
          "extensions.partialClone": "synthetic",
        },
        names: "remote.synthetic.promisor, remote.synthetic.partialclonefilter, extensions.partialclone",
      },
      {
        label: "a partial clone holding the source commit but not its promised blob",
        present: true,
        config: {
          "remote.synthetic.promisor": "true",
          "remote.synthetic.partialclonefilter": "blob:none",
          "extensions.partialClone": "synthetic",
        },
        names: "remote.synthetic.promisor, remote.synthetic.partialclonefilter, extensions.partialclone",
      },
      {
        label: "a filter-only remote",
        present: false,
        config: { "remote.synthetic.partialclonefilter": "blob:none" },
        names: "remote.synthetic.partialclonefilter",
      },
      {
        label: "a disabled promisor that keeps its filter",
        present: true,
        config: { "remote.synthetic.promisor": "false", "remote.synthetic.partialclonefilter": "blob:none" },
        names: "remote.synthetic.promisor, remote.synthetic.partialclonefilter",
      },
      {
        label: "a promisor remote alone",
        present: true,
        config: { "remote.synthetic.promisor": "true" },
        names: "remote.synthetic.promisor",
      },
      {
        label: "the partial-clone extension alone",
        present: false,
        config: { "extensions.partialClone": "synthetic" },
        names: "extensions.partialclone",
      },
    ])("refuses $label before any object read", async ({ present, config, names }) => {
      const { run, commands, before, after, outputWritten } = await runProducerInSyntheticClone({ present, config });
      expect(run.status).toBe(1);
      expect(run.stderr.trim()).toBe(
        `local Git objects refused: promisor or partial-clone configuration (${names}) could fetch a missing object; materialize the frozen source from a full clone outside CI`,
      );
      expect(commands).toEqual(["config"]);
      expect(after).toEqual(before);
      expect(outputWritten).toBe(false);
    });

    it("reports an absent source without fetching when no promisor is configured", async () => {
      const { run, commit, commands, before, after, outputWritten } = await runProducerInSyntheticClone({
        present: false,
        config: {},
      });
      expect(run.status).toBe(1);
      expect(run.stderr.trim()).toBe(
        `frozen source ${commit} is not available locally; fetch it outside CI (for example its pull request ref)`,
      );
      expect(commands).toEqual(["config", "cat-file"]);
      expect(after).toEqual(before);
      expect(outputWritten).toBe(false);
    });
  });

  describe("unrelated source edits preserve workload enrollment", () => {
    // Capture 38641988070's lockfile resolves a Vitest this checkout no longer
    // installs, so W4 refuses it as a paired reference. The lockfile control, the
    // only W5 input here, pairs with the checked-out lockfile under this
    // whole-file pin; the other controls keep the historical frozen source.
    const checkedOutLockfileSha256 = sha256Of(readFileSync(join(repositoryRoot, "pnpm-lock.yaml")));
    const controls = [
      {
        label: "an unrelated lockfile entry",
        path: "pnpm-lock.yaml",
        checkedOutSha256: checkedOutLockfileSha256,
        edit: (source: string) => {
          const marker = "resolution: {integrity: sha512-";
          const at = source.indexOf(marker, source.indexOf("\npackages:\n")) + marker.length;
          expect(at).toBeGreaterThan(marker.length);
          return `${source.slice(0, at)}${source[at] === "A" ? "B" : "A"}${source.slice(at + 1)}`;
        },
      },
      {
        label: "a lane-only Vitest setting whose hosted values are identical",
        path: "vitest.shared.mjs",
        edit: replaceOnce("    maxWorkers: 2,\n", "    maxWorkers: 1,\n"),
      },
      {
        label: "an unused type-only Auth export",
        path: "contracts/auth-context/index.ts",
        edit: (source: string) => `${source}\nexport type UnusedWorkloadProbe = Readonly<{ probe: true }>;\n`,
      },
      {
        label: "a non-boot app.ts policy registration (#9638)",
        path: "deployables/platform-api/src/app.ts",
        edit: replaceOnce(
          "        checkoutProcessingFeePolicy,\n        authenticityFeePolicy,\n",
          "        checkoutProcessingFeePolicy,\n",
        ),
      },
      {
        label: "Auth runtime services (#9644)",
        path: "bounded-contexts/auth/support/runtime-support/services.ts",
        edit: replaceOnce(
          '  return authenticationMethod === "google" || authenticationMethod === "facebook";\n',
          '  return authenticationMethod === "google";\n',
        ),
      },
    ];

    // A W1-W5-neutral drift that no control's edit makes.
    const preDrift = (path: string) => (source: string) =>
      `${source}${path.endsWith(".yaml") ? "#" : "//"} synthetic pre-drift\n`;

    /**
     * The old broad pins reject `edit`: against a paired reference, the edited
     * mirror adds exactly `path` to the historical mismatches. `base` is the
     * unnormalized source and keeps all of its drift; a target it already drifted
     * is restored to its captured bytes in the reference only, and the edit
     * applies to those bytes.
     */
    async function expectOldPinRejection(
      { path, edit, checkedOutSha256 }: (typeof controls)[number],
      base: Readonly<Record<string, WorkloadEdit>> = {},
      current = { binding: readCurrentCapture().binding, baseline: currentBaseline() },
    ) {
      const freshness = (edits: Readonly<Record<string, WorkloadEdit>>) =>
        mirrorFreshness(edits, current.baseline, current.binding);
      const captured =
        checkedOutSha256 === undefined ? readFrozenSourceFile(path) : readFileSync(join(repositoryRoot, path));
      expect(captured, path).not.toBeNull();
      if (checkedOutSha256 !== undefined) expect(sha256Of(captured!), `${path} whole-file pin`).toBe(checkedOutSha256);
      const pairedPins = checkedOutSha256 === undefined ? {} : { [path]: checkedOutSha256 };
      const withTarget = (bytes: string) => {
        const retained = Object.fromEntries(Object.entries(base).filter(([key]) => key !== path));
        return readFileSync(join(repositoryRoot, path), "utf8") === bytes ? retained : { ...retained, [path]: bytes };
      };

      const unnormalized = await freshness(base);
      expect(unnormalized.violations).toEqual(expectedKnownDrift(current.binding));
      const collision = !readFileSync(join(unnormalized.mirror, path)).equals(captured!);
      const referenceEdits = collision ? withTarget(captured!.toString("utf8")) : base;
      const reference = collision ? await freshness(referenceEdits) : unnormalized;
      expect(reference.violations, "historical paired reference violates current W1-W5").toEqual(
        expectedKnownDrift(current.binding),
      );
      const edited = await freshness(withTarget(edit(captured!.toString("utf8"))));
      expect(edited.violations).toEqual(expectedKnownDrift(current.binding));

      const before = broadSourceBindingMismatches(reference.mirror, pairedPins);
      const after = broadSourceBindingMismatches(edited.mirror, pairedPins);
      expect(before).not.toContain(path);
      expect([...after].sort()).toEqual([...before, path].sort());
      return { collision, before };
    }

    it.each(controls)("accepts $label with W1-W5 fixed while the old broad pins reject it", async (control) => {
      await expectOldPinRejection(control);
    });

    it.each(controls.map((control, index) => ({ ...control, drift: controls[(index + 1) % controls.length]! })))(
      "accepts $label beside retained drift in $drift.path",
      async ({ drift, ...control }) => {
        const { before } = await expectOldPinRejection(control, { [drift.path]: drift.edit });
        expect(before).toContain(drift.path);
      },
    );

    it.each(controls)("accepts $label over a pre-drifted target restored to its captured bytes", async (control) => {
      const { collision } = await expectOldPinRejection(control, { [control.path]: preDrift(control.path) });
      expect(collision).toBe(true);
    });

    it.each(controls)("accepts $label while W1-W5 follows a newer current capture", async (control) => {
      await expectOldPinRejection(control, {}, await newerCurrentCapture());
    });
  });

  describe("workload changes require re-enrollment", () => {
    const fixturesPath = "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex";
    const seedingPath = "bounded-contexts/catalog/features/source-observations/api/seeding/seed.ts";
    const settlementSupportPath = "bounded-contexts/channels/features/connector-feed/tests/settlement-test-support.ts";
    const paymentSupportPath = "contracts/payment-processing/test-support.ts";

    it("accepts the unchanged checked-out workload without Git history", async () => {
      const { mirror, violations } = await mirrorFreshness({});
      expect(existsSync(join(mirror, ".git"))).toBe(false);
      expect(violations).toEqual(knownCurrentCaptureDrift);
    });

    it.each<{
      label: string;
      edits: Readonly<Record<string, WorkloadEdit>>;
      expected: readonly string[] | (() => readonly string[]);
    }>([
      {
        label: "a bootstrap case callback",
        edits: { "deployables/platform-api/__tests__/bootstrap-scenario.db.test.ts": editFirstCaseCallback },
        expected: [
          changed("W1 case identities deployables/platform-api/__tests__/bootstrap-scenario.db.test.ts"),
          changed("W1 file deployables/platform-api/__tests__/bootstrap-scenario.db.test.ts"),
        ],
      },
      {
        label: "a bootstrap case timeout",
        edits: { "deployables/platform-api/__tests__/authoritative-seed-resume-core.db.test.ts": editFirstCaseTimeout },
        expected: [
          changed("W1 case identities deployables/platform-api/__tests__/authoritative-seed-resume-core.db.test.ts"),
          changed("W1 file deployables/platform-api/__tests__/authoritative-seed-resume-core.db.test.ts"),
        ],
      },
      {
        label: "a W2 harness hook",
        edits: {
          "deployables/platform-api/__tests__/bootstrap-db-test-support.ts": replaceOnce(
            "  }, 30_000);\n\n  afterAll(",
            "  }, 45_000);\n\n  afterAll(",
          ),
        },
        expected: [changed("W2 file deployables/platform-api/__tests__/bootstrap-db-test-support.ts")],
      },
      {
        label: "a W2 closure helper",
        edits: {
          "deployables/platform-api/__tests__/catalog-seed-test-support.ts": replaceOnce(
            "    enabledDataProfiles: profile.profiles,\n",
            "    enabledDataProfiles: [...profile.profiles].reverse(),\n",
          ),
        },
        expected: [changed("W2 file deployables/platform-api/__tests__/catalog-seed-test-support.ts")],
      },
      {
        label: "a W2 fixture",
        edits: {
          "deployables/platform-api/__tests__/operator-session/fixture.ts": replaceOnce(
            'export const base = "https://admin.example";',
            'export const base = "https://admin.example.test";',
          ),
        },
        expected: [changed("W2 file deployables/platform-api/__tests__/operator-session/fixture.ts")],
      },
      {
        label: "the API boot list",
        edits: {
          "deployables/platform-api/src/generated/api-context-registry.ts": replaceOnce(
            '  {\n    contextName: "settlement",\n    packageName: "@chase-sets/settlement",\n    manifest: settlementManifest,\n    module: settlementModule,\n  },\n',
            "",
          ),
        },
        expected: () => [removed(selectionKey("settlement")), removed("W4 alias ^@chase-sets\\/settlement$")],
      },
      {
        label: "a context runtime profile selection",
        edits: {
          "bounded-contexts/inventory/context.json": replaceOnce(
            '"apiRuntimeProfiles": ["proof", "public"],',
            '"apiRuntimeProfiles": ["proof"],',
          ),
        },
        expected: () => [changed(selectionKey("inventory"))],
      },
      {
        label: "a seed data-profile list",
        edits: {
          "infrastructure/platform-runtime/api.ts": replaceOnce(
            '  "catalog-integration-bootstrap",\n  "admin-qa-actor-fixtures",\n];',
            '  "admin-qa-actor-fixtures",\n];',
          ),
        },
        expected: [changed("W3 file infrastructure/platform-runtime/api.ts")],
      },
      {
        label: "a feature seed",
        edits: {
          "bounded-contexts/catalog/features/product-measures/api/seed.ts": (source: string) =>
            `${source}\nexport const productMeasuresSeedProbe = "probe";\n`,
        },
        expected: [changed("W3 file bounded-contexts/catalog/features/product-measures/api/seed.ts")],
      },
      {
        label: "a support seed helper",
        edits: {
          "bounded-contexts/inventory/support/seed-support/ids.ts": (source: string) =>
            `${source}\nexport const seedInventoryProbe = "probe";\n`,
        },
        expected: [changed("W3 file bounded-contexts/inventory/support/seed-support/ids.ts")],
      },
      {
        label: "DB census membership",
        edits: {
          "deployables/platform-api/__tests__/workload-probe.db.test.ts": `it("probes", () => {\n  expect(${syntheticDatabaseUrlRead}).toBeDefined();\n});\n`,
        },
        expected: [
          added("W1 case identities deployables/platform-api/__tests__/workload-probe.db.test.ts"),
          changed("W1 census dbEntries"),
          added("W1 file deployables/platform-api/__tests__/workload-probe.db.test.ts"),
        ],
      },
      {
        label: "a DB execution-unit assignment",
        edits: {
          "deployables/platform-api/package.json": (source: string) =>
            source
              .replace("__tests__/seed-command-catalog.db.test.ts", "")
              .replace(
                "__tests__/authoritative-seed-resume-reconciliation.db.test.ts --maxWorkers=3",
                "__tests__/authoritative-seed-resume-reconciliation.db.test.ts __tests__/seed-command-catalog.db.test.ts --maxWorkers=3",
              ),
        },
        expected: [changed("W1 partition test:db:1")],
      },
      {
        label: "a hosted CLI override",
        edits: {
          "deployables/platform-api/package.json": (source: string) =>
            source.replace(
              "operator-session/operator-session-push.db.test.ts --maxWorkers=3",
              "operator-session/operator-session-push.db.test.ts --testTimeout=1 --maxWorkers=3",
            ),
        },
        expected: [changed("W1 partition test:db:2"), changed("W4 unit test:db:2")],
      },
      {
        label: "a hosted shared-config default",
        edits: { "vitest.shared.mjs": replaceOnce("      hookTimeout: 120_000,\n", "      hookTimeout: 60_000,\n") },
        expected: [changed("W4 unit test:db:1"), changed("W4 unit test:db:2"), changed("W4 unit test:db:3")],
      },
      {
        label: "a workspace Vitest override",
        edits: {
          "deployables/platform-api/vitest.config.ts": replaceOnce(
            "    globals: true,\n",
            "    globals: true,\n    retry: 1,\n",
          ),
        },
        expected: [changed("W4 unit test:db:1"), changed("W4 unit test:db:2"), changed("W4 unit test:db:3")],
      },
      {
        label: "a hosted PostgreSQL setting",
        edits: {
          ".github/workflows/platform-pr.yml": replaceOnce(
            "target_max_connections=300\n",
            "target_max_connections=200\n",
          ),
        },
        expected: [changed("W4 postgres maxConnections")],
      },
      {
        label: "the resolved pg version",
        edits: {
          "pnpm-lock.yaml": (source: string) =>
            platformApiImporter(
              source,
              replaceOnce(
                "      pg:\n        specifier: ^8.20.0\n        version: 8.20.0\n",
                "      pg:\n        specifier: ^8.20.0\n        version: 8.21.0\n",
              ),
            ),
        },
        expected: [changed("W5 version pg")],
      },
      {
        label: "the resolved vitest version",
        edits: {
          "pnpm-lock.yaml": (source: string) =>
            platformApiImporter(source, replaceOnce("        version: 4.1.12(", "        version: 4.1.13(")),
        },
        expected: [refused("W4 cannot be evaluated: installed vitest 4.1.12 but the tree resolves 4.1.13")],
      },
      {
        label: "the admin-QA seed profiles",
        edits: {
          "deployables/platform-api/src/admin-qa-actor-fixtures.ts": replaceOnce(
            'const BASELINE_DATA_PROFILES = ["critical-bootstrap", "catalog-integration-bootstrap"] as const;',
            'const BASELINE_DATA_PROFILES = ["critical-bootstrap"] as const;',
          ),
        },
        expected: [changed("W3 file deployables/platform-api/src/admin-qa-actor-fixtures.ts")],
      },
      {
        label: "the Identity admin-QA actor matrix",
        edits: {
          "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts": replaceOnce(
            'primaryEmail: "admin-qa-owner@chasesets.test"',
            'primaryEmail: "admin-qa-owner-renamed@chasesets.test"',
          ),
        },
        expected: [changed("W3 file bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts")],
      },
      {
        label: "the Channels settlement work loop",
        edits: {
          [settlementSupportPath]: replaceOnce("for (const index of [1, 2]) {", "for (const index of [1, 2, 3]) {"),
        },
        expected: [changed(`W2 file ${settlementSupportPath}`)],
      },
      {
        label: "a fake payment processor response",
        edits: {
          [paymentSupportPath]: replaceOnce(
            '["seti_gateway_contract", "requires_payment_method"],',
            '["seti_gateway_contract", "requires_action"],',
          ),
        },
        expected: [changed(`W2 file ${paymentSupportPath}`)],
      },
      {
        label: "the imported TCGdex JSON fixture",
        edits: { [`${fixturesPath}/base2-60-scenario.json`]: replaceOnce('"firstEd": 64,', '"firstEd": 65,') },
        expected: [changed(`W3 json ${fixturesPath}/base2-60-scenario.json`)],
      },
      {
        label: "an added imported JSON fixture",
        edits: {
          [`${fixturesPath}/probe-scenario.json`]: '{ "probe": true }\n',
          [seedingPath]: (source: string) =>
            `import probeScenario from "../__fixtures__/tcgdex/probe-scenario.json" with { type: "json" };\n${source}\nexport const probeScenarioFixture = probeScenario;\n`,
        },
        expected: [added(`W3 json ${fixturesPath}/probe-scenario.json`), changed(`W3 file ${seedingPath}`)],
      },
      {
        label: "a deleted imported JSON fixture",
        edits: { [`${fixturesPath}/base2-60-scenario.json`]: null },
        expected: [
          refused(`${seedingPath}:17 workload import '../__fixtures__/tcgdex/base2-60-scenario.json' is unresolved`),
        ],
      },
      {
        label: "a new external W2 helper",
        edits: {
          "bounded-contexts/channels/features/connector-feed/tests/fee-test-support.ts":
            'export const settlementFeeProbe = "probe";\n',
          [settlementSupportPath]: (source: string) => `import "./fee-test-support";\n${source}`,
        },
        expected: [
          added("W2 file bounded-contexts/channels/features/connector-feed/tests/fee-test-support.ts"),
          changed(`W2 file ${settlementSupportPath}`),
        ],
      },
      {
        label: "a nonliteral workload import",
        edits: {
          [settlementSupportPath]: (source: string) =>
            `${source}\nexport const loadProbe = (specifier: string) => import(specifier);\n`,
        },
        expected: () => {
          const line = readFileSync(join(repositoryRoot, settlementSupportPath), "utf8").split("\n").length + 1;
          return [refused(`${settlementSupportPath}:${line} has a nonliteral workload import`)];
        },
      },
    ])("refuses $label", async ({ edits, expected }) => {
      const { violations } = await mirrorFreshness(edits);
      const expectedViolations = typeof expected === "function" ? expected() : expected;
      const knownDrift = expectedViolations.some((violation) => violation.startsWith("workload input refused: "))
        ? []
        : knownCurrentCaptureDrift;
      expect(violations).toEqual([...expectedViolations, ...knownDrift].sort());
    });

    it("refuses unreadable and unresolved workload inputs", async () => {
      const deletedHelper = await mirrorFreshness({ [paymentSupportPath]: null });
      expect(deletedHelper.violations.length).toBeGreaterThan(0);
      expect(deletedHelper.violations.every((violation) => violation.startsWith("workload input refused: "))).toBe(
        true,
      );
      // A string, not a regex literal: lexical import scanners misread a regex.
      const unresolvedHelper = "workload import '@chase-sets/payment-processing/test-support' is unresolved";
      expect(deletedHelper.violations.some((violation) => violation.endsWith(unresolvedHelper))).toBe(true);

      const unreadable = await mirrorFreshness({
        "infrastructure/platform-runtime/context-pools.ts": null,
        "infrastructure/platform-runtime/context-pools.ts/placeholder.txt": "not a module\n",
      });
      expect(unreadable.violations).toContain(
        refused("W3 input infrastructure/platform-runtime/context-pools.ts is missing"),
      );
    });

    it("refuses an omitted external helper and missing, duplicate, empty or partial bindings", async () => {
      const derivation = await liveWorkload();
      const baseline = currentBaseline();
      const capture = readCurrentCapture().binding;
      const check = (candidate: unknown) =>
        checkBootstrapDbWorkloadFreshness({ baseline: candidate, capture, derivation }).violations;

      const omitted = withBindings(baseline, (bindings) =>
        bindings.filter(([section, key]) => !(section === "W2 file" && key === paymentSupportPath)),
      );
      expect(check(omitted)).toEqual([...knownCurrentCaptureDrift, added(`W2 file ${paymentSupportPath}`)].sort());

      const { bindings: _bindings, ...withoutBindings } = baseline;
      expect(check(withoutBindings)).toContain("baseline bindings are missing or empty");
      expect(check(withBindings(baseline, () => []))).toContain("baseline bindings are missing or empty");

      const duplicate = withBindings(baseline, (bindings) => [bindings[0]!, ...bindings]);
      expect(check(duplicate)).toContain(
        `baseline binding ${baseline.bindings[0]![0]} ${baseline.bindings[0]![1]} is duplicated`,
      );

      const empty = withBindings(baseline, (bindings) => bindings.filter(([section]) => section !== "W3 file"));
      expect(check(empty)).toEqual(["baseline W3 file bindings are empty"]);

      const partial = withBindings(baseline, (bindings) =>
        bindings.map((binding, index) => (index === 0 ? ([binding[0], binding[1], ""] as const) : binding)),
      );
      expect(check(partial)).toEqual(["baseline binding 0 is malformed or partial"]);

      const edited = { ...baseline, bindings: baseline.bindings.slice(1) };
      expect(check(edited)).toEqual(["baseline bindings do not match bindingsSha256 (partial or edited)"]);
    });
  });

  describe("freshness uses workload bindings only", () => {
    it("is called only by the Unit regression and its own producer, never by the test:db guard", () => {
      const callers: string[] = [];
      function visit(directory: string) {
        for (const entry of readdirSync(join(repositoryRoot, directory)).sort()) {
          const path = `${directory}/${entry}`;
          if (["node_modules", "dist", "artifacts"].includes(entry) || entry.startsWith(".")) continue;
          const absolute = join(repositoryRoot, path);
          if (statSync(absolute).isDirectory()) visit(path);
          else if (
            /\.(?:[cm]?[jt]sx?)$/.test(entry) &&
            readFileSync(absolute, "utf8").includes("db-enrollment-workload")
          ) {
            callers.push(path);
          }
        }
      }
      for (const directory of ["deployables/platform-api", "scripts"]) visit(directory);
      expect(callers.sort()).toEqual([
        "deployables/platform-api/__tests__/bootstrap-db-enrollment.test.ts",
        "deployables/platform-api/scripts/db-enrollment-workload.mjs",
      ]);
      const packageScripts = JSON.parse(readFileSync(join(testDirectory, "..", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      for (const name of ["test:db:1", "test:db:2"]) {
        expect(packageScripts.scripts[name]).toMatch(
          /^node \.\/scripts\/check-bootstrap-db-enrollment\.mjs && vitest run /,
        );
      }
    });

    it("round-trips a newer capture through the shared producer derivation and refuses the stale baseline", async () => {
      const derivation = await liveWorkload();
      const { binding } = readCurrentCapture();
      const captureBytes = Buffer.from(
        JSON.stringify({
          provenance: {
            ...binding.provenance,
            runId: "65440003",
            checkoutSha: "0000000000000000000000000000000000006546",
            sourceBase: "0000000000000000000000000000000000006545",
            captureParent: "0000000000000000000000000000000000006545",
          },
        }),
      );
      const newer: BootstrapDbWorkloadCaptureBinding = {
        fileName: "bootstrap-db-capture-65440003.json",
        fixtureSha256: sha256Of(captureBytes),
        provenance: JSON.parse(captureBytes.toString("utf8")).provenance,
      };
      const produced = JSON.parse(
        formatBootstrapDbWorkloadBaseline(
          createBootstrapDbWorkloadBaseline({
            captureFileName: newer.fileName,
            captureBytes,
            source: { commit: "0000000000000000000000000000000000006545" },
            derivation,
          }),
        ),
      ) as BootstrapDbWorkloadBaseline;
      const currentBindings = currentBaseline().bindings.map((binding) => {
        if (
          binding[0] !== "W3 file" ||
          !knownCurrentCaptureDrift.some((entry) => entry.startsWith(`${binding[0]} ${binding[1]}`))
        ) {
          return binding;
        }
        return derivation.bindings.find(([section, key]) => section === binding[0] && key === binding[1]) ?? binding;
      });
      expect(produced.bindings).toEqual(currentBindings);
      expect(checkBootstrapDbWorkloadFreshness({ baseline: produced, capture: newer, derivation }).violations).toEqual(
        [],
      );
      expect(
        checkBootstrapDbWorkloadFreshness({ baseline: currentBaseline(), capture: newer, derivation }).violations,
      ).toEqual([
        `baseline binds capture ${binding.fileName} but the current capture is ${newer.fileName}; derive the baseline from the current capture's own frozen source`,
        `baseline was derived from ${currentBaseline().source.commit}, not the capture's frozen source 0000000000000000000000000000000000006545`,
      ]);
      expect(() =>
        createBootstrapDbWorkloadBaseline({
          captureFileName: newer.fileName,
          captureBytes,
          source: { commit: "0000000000000000000000000000000000006545" },
          derivation: { bindings: derivation.bindings, gaps: ["synthetic unresolved input"] },
        }),
      ).toThrow("workload derivation refused:\n- synthetic unresolved input");
    });

    it("audits the immediate fixture/helper frontier the selectors leave opaque", async () => {
      const { frontier = [] } = await liveWorkload();
      const targets = [...new Set(frontier.map(([, target]) => target))].sort();
      expect(targets.length).toBeGreaterThan(0);
      expect(
        targets.filter((target) =>
          /fixture|test-support|test-data|testing|fake|stub|mock|seed|__fixtures__|\.json$/i.test(target),
        ),
      ).toEqual([
        // Bound through its W3 selection, not its bytes.
        "bounded-contexts/catalog/context.json",
        // Catalog fixture-lifecycle governance is product runtime, not fixture data.
        "bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-fixture-lifecycle.ts",
      ]);
    });

    it("refuses a baseline whose workload binding was deleted", async () => {
      const derivation = await liveWorkload();
      const deleted = withBindings(currentBaseline(), (bindings) =>
        bindings.filter(
          ([section, key]) => !(section === "W3 file" && key === "infrastructure/platform-runtime/api.ts"),
        ),
      );
      expect(
        checkBootstrapDbWorkloadFreshness({ baseline: deleted, capture: readCurrentCapture().binding, derivation })
          .violations,
      ).toEqual([...knownCurrentCaptureDrift, added("W3 file infrastructure/platform-runtime/api.ts")].sort());
    });
  });

  it("declares the settled ceilings and job overhead the aggregate expression is built from", () => {
    expect(bootstrapDbScheduleModel.executionUnitCeilingMs).toBe(420_000);
    expect(bootstrapDbScheduleModel.aggregateCeilingMs).toBe(1_080_000);
    expect(bootstrapDbScheduleModel.jobOverheadMs).toBe(41917);
    expect(bootstrapDbScheduleModel.maxWorkersPerExecutionUnit).toBe(3);
    expect(bootstrapDbScheduleModel.maximumScheduledFileCount).toBe(12);
    expect(bootstrapDbScheduleModel.maximumEnumeratedUnitCount).toBe(4);
    expect(bootstrapDbScheduleModel.maximumCaseReferenceDurationMs).toBe(600_000);
    expect(checkBootstrapDbEnrollment().schedule.files.reduce((total, file) => total + file.caseDurationMs, 0)).toBe(
      2031936,
    );
  });

  // -- schedule-model shape ------------------------------------------------

  it("projects the shipped units, aggregate, and minimum unit count under the closed model", () => {
    const { schedule } = checkBootstrapDbEnrollment();
    expect(schedule.units.map((unit) => [unit.scriptName, unit.makespanMs])).toEqual(
      currentProjectedMakespans.map((makespanMs, index) => [`test:db:${index + 1}`, makespanMs]),
    );
    expect(schedule.units.map((unit) => [unit.bootBearingCaseCount, unit.bootBearingCeiling])).toEqual([
      [18, 18],
      [32, 32],
      [19, 19],
    ]);
    expect(schedule.aggregateMs).toBe(877455);
    expect(schedule.aggregateWithOverheadMs).toBe(919372);
    expect(schedule.minimumUnitCount).toBe(currentMinimumUnitCount);
    expect(schedule.effectiveMinimumUnitCount).toBe(3);
    expect(schedule.observedUnitCount).toBe(3);
  });

  it("accepts the shipped schedule model as a null-prototype plain record", () => {
    const nullPrototypeModel = Object.assign(Object.create(null), bootstrapDbScheduleModel);
    const result = checkBootstrapDbEnrollment({ scheduleModel: nullPrototypeModel });

    expect(Object.getPrototypeOf(nullPrototypeModel)).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.schedule.units.map((unit) => [unit.scriptName, unit.makespanMs])).toEqual(
      currentProjectedMakespans.map((makespanMs, index) => [`test:db:${index + 1}`, makespanMs]),
    );
  });

  const hiddenOwnPropertyModel = createSyntheticScheduleModel();
  Object.defineProperty(hiddenOwnPropertyModel, "syntheticHidden", { value: true, enumerable: false });
  const symbolKey = Symbol("syntheticEscapeHatch");
  const symbolOwnPropertyModel = createSyntheticScheduleModel();
  Object.defineProperty(symbolOwnPropertyModel, symbolKey, { value: true, enumerable: true });
  const inheritedStateModel = Object.assign(
    Object.create({ syntheticEscapeHatch: true }),
    createSyntheticScheduleModel(),
  );
  class SyntheticScheduleModelLookalike {}
  const classInstanceModel = Object.assign(new SyntheticScheduleModelLookalike(), createSyntheticScheduleModel());

  it.each([
    [
      "own enumerable toString field",
      createSyntheticScheduleModel({ toString: "synthetic" }),
      "the execution-unit schedule model declares unknown field 'toString'",
    ],
    [
      "own enumerable constructor field",
      createSyntheticScheduleModel({ constructor: "synthetic" }),
      "the execution-unit schedule model declares unknown field 'constructor'",
    ],
    [
      "own enumerable hasOwnProperty field",
      createSyntheticScheduleModel({ hasOwnProperty: "synthetic" }),
      "the execution-unit schedule model declares unknown field 'hasOwnProperty'",
    ],
    [
      "own enumerable valueOf field",
      createSyntheticScheduleModel({ valueOf: "synthetic" }),
      "the execution-unit schedule model declares unknown field 'valueOf'",
    ],
    [
      "non-enumerable own property",
      hiddenOwnPropertyModel,
      "the execution-unit schedule model own property 'syntheticHidden' must be enumerable",
    ],
    [
      "symbol-keyed own property",
      symbolOwnPropertyModel,
      "the execution-unit schedule model must not declare symbol field 'Symbol(syntheticEscapeHatch)'",
    ],
    [
      "inherited synthetic state",
      inheritedStateModel,
      "the execution-unit schedule model must be a plain record with Object.prototype or null as its prototype",
    ],
    [
      "class-instance prototype lookalike",
      classInstanceModel,
      "the execution-unit schedule model must be a plain record with Object.prototype or null as its prototype",
    ],
    [
      "null model",
      null,
      "the execution-unit schedule model must be a plain record with Object.prototype or null as its prototype",
    ],
    [
      "array model",
      Object.assign([], createSyntheticScheduleModel()),
      "the execution-unit schedule model must be a plain record with Object.prototype or null as its prototype",
    ],
    [
      "non-record primitive",
      "synthetic schedule model",
      "the execution-unit schedule model must be a plain record with Object.prototype or null as its prototype",
    ],
    [
      "unknown plain field",
      createSyntheticScheduleModel({ syntheticEscapeHatch: true }),
      "the execution-unit schedule model declares unknown field 'syntheticEscapeHatch'",
    ],
    [
      "out-of-range executionUnitCeilingMs",
      createSyntheticScheduleModel({ executionUnitCeilingMs: 3_600_001 }),
      "the execution-unit schedule model field executionUnitCeilingMs must be an integer between 1 and 3600000",
    ],
  ])("fails closed and projects an inert schedule for %s", (_label, scheduleModel, expectedViolation) => {
    const result = checkBootstrapDbEnrollment({ scheduleModel });

    expect(result.violations).toEqual(expect.arrayContaining([expectedViolation]));
    expect(result.schedule.units).toEqual([]);
    expect(result.schedule.files).toEqual([]);
    expect(result.schedule.minimumUnitCount).toBeNull();
    expect(result.schedule.aggregateMs).toBe(0);
    expect(result.schedule.aggregateWithOverheadMs).toBe(0);
  });

  it("enumerates the complete own-property surface through an explicit field allowlist", () => {
    const source = readFileSync(join(testDirectory, "..", "scripts", "check-bootstrap-db-enrollment.mjs"), "utf8");

    expect(source).toContain("Reflect.ownKeys(model)");
    expect(source).toContain("scheduleModelFieldAllowlist.has(key)");
    expect(source).not.toContain("Object.keys(model)");
    expect(source).not.toContain("key in scheduleModelFieldConstraints");
  });

  it("gives every fixture-built timing model unmistakably synthetic provenance", async () => {
    const timingOverrides: SyntheticScheduleModelTimingOverrides = {
      maxWorkersPerExecutionUnit: 2,
      testFileFixedCostMs: 1_249,
      executionUnitFixedCostMs: 10_052,
      jobOverheadMs: 47_999,
      executionUnitCeilingMs: 419_999,
      aggregateCeilingMs: 1_079_999,
      maximumCaseReferenceDurationMs: 599_999,
      maximumScheduledFileCount: 13,
      maximumEnumeratedUnitCount: 5,
    };
    const fixture = await createFixture([unitFileFor("synthetic-provenance", "test:db:1", 1_000)], {
      model: timingOverrides,
    });

    for (const [fieldName, syntheticValue] of Object.entries(timingOverrides)) {
      expect(fixture.model[fieldName as ScheduleModelTimingField], fieldName).toBe(syntheticValue);
      expect(fixture.model[fieldName as ScheduleModelTimingField], fieldName).not.toBe(
        bootstrapDbScheduleModel[fieldName as ScheduleModelTimingField],
      );
    }
    expect(fixture.model).toMatchObject(syntheticScheduleModelProvenance);
    expect(fixture.model.referenceRunId).not.toBe(bootstrapDbScheduleModel.referenceRunId);
    expect(fixture.model.referenceJobId).not.toBe(bootstrapDbScheduleModel.referenceJobId);
    expect(fixture.model.referenceHeadSha).not.toBe(bootstrapDbScheduleModel.referenceHeadSha);
    expect(fixture.model.referenceEvent).not.toBe(bootstrapDbScheduleModel.referenceEvent);
  });

  it.each([
    [
      "a negative fixed cost",
      { testFileFixedCostMs: -1 },
      "testFileFixedCostMs must be an integer between 0 and 3600000",
    ],
    [
      "a fractional enumeration bound",
      { maximumEnumeratedUnitCount: 2.5 },
      "maximumEnumeratedUnitCount must be an integer between 1 and 16",
    ],
    [
      "a malformed reference run identity",
      { referenceRunId: "synthetic-invalid-run" },
      "referenceRunId must be an integer between 1 and 9007199254740991",
    ],
    [
      "a malformed reference head provenance",
      { referenceHeadSha: "f78143573" },
      "referenceHeadSha must be a string matching ^[0-9a-f]{40}$",
    ],
    [
      "a malformed reference event provenance",
      { referenceEvent: "Merge Group" },
      "referenceEvent must be a string matching ^[a-z][a-z0-9_]*$",
    ],
    [
      "a worker count below one",
      { maxWorkersPerExecutionUnit: 0 },
      "maxWorkersPerExecutionUnit must be an integer between 1 and 64",
    ],
    [
      "a non-finite per-unit ceiling",
      { executionUnitCeilingMs: Number.POSITIVE_INFINITY },
      "executionUnitCeilingMs must be an integer between 1 and 3600000",
    ],
    [
      "a nested object where a bound belongs",
      { maximumScheduledFileCount: { value: 10 } },
      "maximumScheduledFileCount must be an integer between 1 and 16",
    ],
  ])("rejects %s in the schedule model and projects nothing from it", (_label, patch, expected) => {
    const result = checkBootstrapDbEnrollment({
      scheduleModel: createSyntheticScheduleModel(patch),
    });

    expect(result.violations).toEqual([`the execution-unit schedule model field ${expected}`]);
    expect(result.schedule.units).toEqual([]);
    expect(result.schedule.files).toEqual([]);
    expect(result.schedule.minimumUnitCount).toBeNull();
    expect(result.schedule.aggregateWithOverheadMs).toBe(0);
  });

  it("rejects an unknown schedule-model field rather than ignoring it", () => {
    const result = checkBootstrapDbEnrollment({
      scheduleModel: createSyntheticScheduleModel({ syntheticEscapeHatch: true }),
    });

    expect(result.violations).toEqual([
      "the execution-unit schedule model declares unknown field 'syntheticEscapeHatch'",
    ]);
  });

  it("rejects a schedule model that omits a required field", () => {
    const { jobOverheadMs: _omitted, ...withoutJobOverhead } = createSyntheticScheduleModel();

    expect(checkBootstrapDbEnrollment({ scheduleModel: withoutJobOverhead as never }).violations).toEqual([
      "the execution-unit schedule model must declare jobOverheadMs",
    ]);
  });

  it("rejects a schedule model that is not an object", () => {
    expect(checkBootstrapDbEnrollment({ scheduleModel: [] as never }).violations).toEqual([
      "the execution-unit schedule model must be a plain record with Object.prototype or null as its prototype",
    ]);
  });

  it.each([
    [
      "fixed costs that leave no room under the per-unit ceiling",
      { executionUnitFixedCostMs: 420_000 },
      "testFileFixedCostMs 1248 plus executionUnitFixedCostMs 420000 must leave room under the 420000ms " +
        "per-unit ceiling",
    ],
    [
      "a job overhead at or above the aggregate ceiling",
      { jobOverheadMs: 1_200_000 },
      "jobOverheadMs 1200000 must be below the 1080000ms aggregate ceiling",
    ],
    [
      "a unit-count enumeration bound above the file-count bound",
      { maximumEnumeratedUnitCount: 11, maximumScheduledFileCount: 10 },
      "maximumEnumeratedUnitCount 11 must not exceed maximumScheduledFileCount 10",
    ],
  ])("rejects %s", (_label, patch, expected) => {
    const result = checkBootstrapDbEnrollment({
      scheduleModel: createSyntheticScheduleModel(patch),
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([`the execution-unit schedule model is inconsistent: ${expected}`]),
    );
    expect(result.schedule.units).toEqual([]);
  });

  it("accepts an execution unit at exactly the 420-second ceiling", async () => {
    const fixture = await createFixture([unitFileFor("edge-accept", "test:db:1", 420_000)], {
      model: singleWorkerModel(),
    });
    const result = runFixture(fixture);

    expect(result.schedule.units[0]!.makespanMs).toBe(420_000);
    expect(result.violations).toEqual([]);
  });

  it("rejects an execution unit one millisecond past the 420-second ceiling, naming the unit", async () => {
    const fixture = await createFixture([unitFileFor("edge-reject", "test:db:1", 420_001)], {
      model: singleWorkerModel(),
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        "test:db:1 has a projected makespan of 420001ms, exceeding the 420000ms per-unit ceiling",
      ]),
    );
  });

  it("accepts an aggregate at exactly 1080 seconds including the 48-second job overhead", async () => {
    const fixture = await createFixture(
      [
        unitFileFor("aggregate-one", "test:db:1", 344_000),
        unitFileFor("aggregate-two", "test:db:2", 344_000),
        unitFileFor("aggregate-three", "test:db:3", 344_000),
      ],
      { model: singleWorkerModel() },
    );
    const result = runFixture(fixture);

    expect(result.schedule.aggregateMs).toBe(1_032_000);
    expect(result.schedule.aggregateWithOverheadMs).toBe(1_080_000);
    expect(result.violations).toEqual([]);
  });

  it("rejects an aggregate one millisecond past 1080 seconds including the job overhead", async () => {
    const fixture = await createFixture(
      [
        unitFileFor("aggregate-one", "test:db:1", 344_001),
        unitFileFor("aggregate-two", "test:db:2", 344_000),
        unitFileFor("aggregate-three", "test:db:3", 344_000),
      ],
      { model: singleWorkerModel() },
    );

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        "the projected aggregate of 1032001ms across 3 execution units plus the 48000ms job overhead is " +
          "1080001ms, exceeding the 1080000ms aggregate ceiling",
      ]),
    );
  });

  it("rejects a manifested case whose reference duration is absent rather than scheduling it as zero", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const [fileName, partition] = Object.entries(fixture.manifest)[0]!;
    const caseName = partition.cases[0]!.name;
    fixture.manifest[fileName] = {
      ...partition,
      cases: partition.cases.map((testCase, index) =>
        index === 0 ? ({ name: testCase.name, identity: testCase.identity } as never) : testCase,
      ),
    };

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `${fileName} case '${caseName}' must declare an integer referenceDurationMs between 0 and 600000`,
        ),
      ]),
    );
  });

  it.each([
    ["wrong type", "fast" as unknown as number],
    ["non-integer", 1234.5],
    ["negative", -1],
    ["out of range", 600_001],
  ])("rejects a %s reference duration", async (_label, referenceDurationMs) => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const [fileName, partition] = Object.entries(fixture.manifest)[0]!;
    fixture.manifest[fileName] = {
      ...partition,
      cases: partition.cases.map((testCase, index) => (index === 0 ? { ...testCase, referenceDurationMs } : testCase)),
    };

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([expect.stringContaining("must declare an integer referenceDurationMs")]),
    );
  });

  it("rejects an unknown manifest field rather than ignoring it", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const [fileName, partition] = Object.entries(fixture.manifest)[0]!;
    fixture.manifest[fileName] = { ...partition, cadence: "weekly" } as never;

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([`${fileName} manifest entry declares unknown field 'cadence'`]),
    );
  });

  // -- minimum-unit invariant ----------------------------------------------

  it.each([
    [10, 10, true],
    [11, 10, false],
    [11, 11, true],
    [12, 11, false],
    [12, 12, true],
    [13, 11, false],
    [13, 12, false],
  ] as const)("enforces the %i-file boundary with declared bound %i", async (count, bound, accepted) => {
    const files = Array.from({ length: count }, (_, index) => unitFileFor(`boundary-${index}`, "test:db:1", 1_000));
    const fixture = await createFixture(files, { model: { maximumScheduledFileCount: bound } });
    const result = runFixture(fixture);

    expect(result.schedule.files).toHaveLength(count);
    if (accepted) {
      expect(result.violations).toEqual([]);
      expect(result.schedule.minimumUnitCount).toBe(1);
    } else {
      expect(result.schedule.minimumUnitCount).toBeNull();
      expect(result.violations).toContain(
        `the schedule model refuses to enumerate ${count} files, above its declared bound of ` +
          `${bound}; re-derive the bound deliberately rather than sampling assignments`,
      );
    }
  });

  it.each([
    [11, 10],
    [12, 11],
    [13, 11],
    [13, 12],
  ])("rejects a bound-check bypass mutant for %i files at bound %i", (count, bound) => {
    const files = Object.freeze(
      Array.from({ length: count }, (_, index) => Object.freeze({ fileName: `boundary-${index}`, durationMs: 1_000 })),
    );
    const model = Object.freeze(createSyntheticScheduleModel({ maximumScheduledFileCount: bound }));
    const assertBoundary = (probe: ReturnType<typeof exhaustiveScheduleProbe>) => {
      expect(probe.computeMinimumUnitCount(files, model)).toEqual({
        minimumUnitCount: null,
        refusal:
          `the schedule model refuses to enumerate ${count} files, above its declared bound of ` +
          `${bound}; re-derive the bound deliberately rather than sampling assignments`,
      });
    };

    assertBoundary(exhaustiveScheduleProbe());
    expect(() => assertBoundary(exhaustiveScheduleProbe(true))).toThrow();
  });

  it.each([
    [1, 0],
    [2, 4],
    [3, 7],
    [4, 10],
  ])("computes minimum %i and its one-fewer-unit alternative at eleven files", async (minimum, largeFileCount) => {
    const files = Array.from({ length: 11 }, (_, index) =>
      unitFileFor(
        `minimum-${minimum}-${index}`,
        `test:db:${index < largeFileCount ? Math.floor(index / 3) + 1 : 1}`,
        index < largeFileCount ? 250_000 : 1_000,
      ),
    );
    const fixture = await createFixture(files, {
      model: { maximumScheduledFileCount: 11, testFileFixedCostMs: 0, executionUnitFixedCostMs: 0, jobOverheadMs: 0 },
    });
    const result = runFixture(fixture);

    expect(result.violations).toEqual([]);
    expect(result.schedule.minimumUnitCount).toBe(minimum);
    expect(result.schedule.observedUnitCount).toBe(minimum);
    if (minimum === 1) expect(result.schedule.oneFewerUnit).toBeNull();
    else {
      expect(result.schedule.oneFewerUnit?.unitCount).toBe(minimum - 1);
      expect(Math.max(...result.schedule.oneFewerUnit!.units.map((unit) => unit.makespanMs))).toBeGreaterThan(
        fixture.model.executionUnitCeilingMs,
      );
      expect(result.schedule.oneFewerUnit!.units.flatMap((unit) => unit.fileNames).sort()).toEqual(
        files.map((file) => file.fileName).sort(),
      );
    }
  });

  it("retains the lexicographically first restricted-growth witness in eleven-file manifest order", () => {
    const probe = exhaustiveScheduleProbe();
    const files = Array.from({ length: 11 }, (_, index) => ({
      fileName: `manifest-${10 - index}`,
      durationMs: 235_000,
    }));
    const result = probe.computeMinimumUnitCount(
      files,
      createSyntheticScheduleModel({ maximumScheduledFileCount: 11 }),
    );

    expect(result.refusal).toBeNull();
    expect(result.minimumUnitCount).toBe(4);
    expect(result.witness?.map((unit) => unit.files.map((file) => file.fileName))).toEqual([
      files.slice(0, 3).map((file) => file.fileName),
      files.slice(3, 6).map((file) => file.fileName),
      files.slice(6, 9).map((file) => file.fileName),
      files.slice(9).map((file) => file.fileName),
    ]);
    let partitionCount = 0;
    for (let unitCount = 1; unitCount <= 4; unitCount++) {
      for (const _assignment of probe.canonicalAssignments(11, unitCount)) partitionCount++;
    }
    expect(partitionCount).toBe(175_275);
  });

  it("exhausts eleven duplicate-duration files before refusing all four unit counts", async () => {
    const files = Array.from({ length: 11 }, (_, index) =>
      unitFileFor(`exhaustive-no-fit-${index}`, `test:db:${Math.floor(index / 3) + 1}`, 260_000),
    );
    const fixture = await createFixture(files, { model: { maximumScheduledFileCount: 11, testFileFixedCostMs: 0 } });
    const result = runFixture(fixture);

    expect(result.schedule.files).toHaveLength(11);
    expect(260_000 + fixture.model.executionUnitFixedCostMs).toBeLessThanOrEqual(fixture.model.executionUnitCeilingMs);
    expect(
      Math.ceil((11 * 260_000) / fixture.model.maxWorkersPerExecutionUnit) +
        fixture.model.executionUnitFixedCostMs +
        fixture.model.jobOverheadMs,
    ).toBeLessThanOrEqual(fixture.model.aggregateCeilingMs);
    expect(result.schedule.minimumUnitCount).toBeNull();
    expect(result.violations).toContain(
      "no execution-unit count up to the model's declared bound of 4 units satisfies both the " +
        "420000ms per-unit ceiling and the 1080000ms aggregate",
    );
  });

  it("computes and accepts the canonical three-unit topology for the shipped manifest", () => {
    const enrollment = defaultPathEnrollment(currentMinimumUnitCount);
    const { schedule } = enrollment.result;

    // The model's own minimum, or the shipped count when a bound declared floor lifts it.
    expectDefaultPathFloorRole(enrollment);
    expect(schedule.effectiveMinimumUnitCount).toBe(3);
    expect(schedule.observedUnitCount).toBe(3);
    for (const unit of schedule.units) {
      expect(unit.makespanMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.executionUnitCeilingMs);
    }
    expect(schedule.aggregateWithOverheadMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.aggregateCeilingMs);
  });

  it("shows a one-fewer-unit alternative whose binding unit is above the 420-second ceiling", () => {
    // One fewer than the shipped three units is a bound declared floor's
    // measured capture, or else the model's own alternative.
    expectOneFewerUnitInfeasible(defaultPathEnrollment(currentMinimumUnitCount));
  });

  it("rejects an extra execution unit that satisfies every other invariant", async () => {
    // A deliberately nonminimal four-unit grouping: every unit stays
    // under 420s, the aggregate stays under 1080s, every case keeps its name,
    // file, database suffix, and identity — only the unit count is wasteful.
    const extraUnitAssignment: Record<string, string> = {
      "bootstrap-production-reconciliation.db.test.ts": "test:db:1",
      "authoritative-seed-resume-core.db.test.ts": "test:db:1",
      "authoritative-seed-resume-reconciliation.db.test.ts": "test:db:1",
      "connector-mount-gate-isolation.db.test.ts": "test:db:2",
      "seed-command-full-pools.db.test.ts": "test:db:2",
      "bootstrap-lock-contention.db.test.ts": "test:db:2",
      "bootstrap-scenario.db.test.ts": "test:db:2",
      "catalog-seed-aggregate-state.db.test.ts": "test:db:2",
      "bootstrap-shared-seed-command.db.test.ts": "test:db:4",
      "inventory-seed-resume.db.test.ts": "test:db:3",
      "authoritative-seed-resume-recovery.db.test.ts": "test:db:3",
      "catalog-seed-interruption-resume.db.test.ts": "test:db:3",
    };
    const files = shippedShapedFiles().map((file) => ({
      ...file,
      executionUnit: extraUnitAssignment[file.fileName]!,
    }));
    const fixture = underAcceptedScheduleModel(await createShippedFixture(files, { model: acceptedTimingInputs() }));
    const result = runFixture(fixture);

    for (const unit of result.schedule.units) {
      expect(unit.makespanMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.executionUnitCeilingMs);
    }
    expect(result.schedule.aggregateWithOverheadMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.aggregateCeilingMs);
    expect(result.violations).toEqual([minimalityViolationFor(4, currentMinimumUnitCount)]);
    // On the retained shipped model it binds, the declared floor measures two
    // units, not one fewer than four, so it never excuses a wasteful unit.
    const { shipped, paired } = readMeasuredCaptures();
    const { floor, refusal } = deriveBootstrapDbMeasuredOneFewerUnitFloor({
      shippedCapture: shipped,
      pairedCapture: paired,
    });
    expect(refusal).toBeNull();
    expect(result.schedule.measuredOneFewerUnitFloor).toEqual({
      applied: false,
      reason: "the measured one-fewer-unit floor measures 2 unit(s), not one fewer than the 4 observed",
    });
    const extraUnitFixture = await shippedCaptureFixture(extraUnitAssignment);
    expect(
      checkBootstrapDbEnrollment({
        platformApiRoot: extraUnitFixture.root,
        manifest: extraUnitFixture.manifest,
        executionUnitBootBearingCaseCeilings: extraUnitFixture.ceilings,
        scheduleModel: extraUnitFixture.model,
        nonBootstrapCensus: extraUnitFixture.nonBootstrapCensus,
        measuredOneFewerUnitFloor: floor,
      }).schedule.measuredOneFewerUnitFloor,
    ).toEqual({
      applied: false,
      reason: "the measured one-fewer-unit floor measures 2 unit(s), not one fewer than the 4 observed",
    });
  });

  it("fails naming a numbered unit hosted CI executes that owns no manifested DB file", async () => {
    // The hidden unit is a real `test:db:5` script the `test:db*` selector runs.
    // It stands its own job up, so it has to own manifested executable entries
    // and be carried by the makespan, aggregate, and minimum-unit comparison.
    const fixture = underAcceptedScheduleModel(
      await createShippedFixture(shippedShapedFiles(), {
        model: acceptedTimingInputs(),
        ceilings: { ...bootstrapDbExecutionUnitBootBearingCaseCeilings, "test:db:5": 0 },
        extraSources: {
          "plain-unit.test.ts": ['import { it } from "vitest";', 'it("needs no database", () => {});'].join("\n"),
        },
        mutatePackageJson: (packageJson) => {
          packageJson.scripts["test:db:5"] = "vitest run __tests__/plain-unit.test.ts --maxWorkers=3";
        },
      }),
    );
    const result = runFixture(fixture);

    expect(result.partitionUnitCount).toBe(4);
    expect(result.schedule.observedUnitCount).toBe(4);
    expect(result.violations).toEqual([
      "test:db:5 selects non-DB test entry '__tests__/plain-unit.test.ts'",
      "test:db:5 is executed by hosted CI but owns no manifested bootstrap DB file; every numbered execution " +
        "unit must own manifested executable DB entries",
      minimalityViolationFor(4, currentMinimumUnitCount),
    ]);
    await editScripts(fixture, (scripts) => {
      delete scripts["test:db:5"];
    });
    const { "test:db:5": _emptyUnit, ...ceilings } = fixture.ceilings;
    expect(runFixture({ ...fixture, ceilings }).violations).toEqual([]);
  });

  it("rejects a selector-matching execution unit whose name is not numbered", async () => {
    const fixture = underAcceptedScheduleModel(
      await createShippedFixture(shippedShapedFiles(), {
        model: acceptedTimingInputs(),
        extraSources: {
          "plain-unit.test.ts": ['import { it } from "vitest";', 'it("needs no database", () => {});'].join("\n"),
        },
        mutatePackageJson: (packageJson) => {
          packageJson.scripts["test:db:extra"] = "vitest run __tests__/plain-unit.test.ts --maxWorkers=3";
        },
      }),
    );

    expect(runFixture(fixture).violations).toEqual([
      "test:db:extra is selected and executed by the test:db* workspace selector but is not a numbered " +
        "test:db:<number> execution unit, so its cost is never scheduled",
      "test:db:extra selects non-DB test entry '__tests__/plain-unit.test.ts'",
    ]);
    await editScripts(fixture, (scripts) => {
      delete scripts["test:db:extra"];
    });
    expect(runFixture(fixture).violations).toEqual([]);
  });

  it("keeps the shipped three-unit topology exactly as hosted CI selects it", () => {
    const packageScripts = JSON.parse(readFileSync(join(testDirectory, "..", "package.json"), "utf8"))
      .scripts as Record<string, string>;
    const selected = Object.keys(packageScripts)
      .filter((name) => name.startsWith("test:db:") && typeof packageScripts[name] === "string")
      .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

    expect(selected).toEqual(["test:db:1", "test:db:2", "test:db:3"]);
    expect(checkBootstrapDbEnrollment().schedule.units.map((unit) => unit.scriptName)).toEqual(selected);
  });

  it("refuses rather than samples when the file count leaves its declared enumeration bound", async () => {
    const files = Array.from({ length: bootstrapDbScheduleModel.maximumScheduledFileCount + 1 }, (_unused, index) =>
      unitFileFor(`over-bound-${index}`, "test:db:1", 1_000),
    );
    const fixture = await createFixture(files, {
      model: { ...singleWorkerModel(), maximumScheduledFileCount: bootstrapDbScheduleModel.maximumScheduledFileCount },
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `the schedule model refuses to enumerate ${files.length} files, above its declared bound of ` +
            `${bootstrapDbScheduleModel.maximumScheduledFileCount}`,
        ),
      ]),
    );
  });

  it("refuses naming the per-unit ceiling when no unit count can satisfy the model", async () => {
    const fixture = await createFixture([unitFileFor("unschedulable", "test:db:1", 420_001)], {
      model: singleWorkerModel(),
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "no execution-unit count satisfies the model; binding constraint is the 420000ms per-unit ceiling",
        ),
      ]),
    );
  });

  it("refuses naming the aggregate when no unit count can satisfy the model", async () => {
    const fixture = await createFixture(
      [
        unitFileFor("aggregate-one", "test:db:1", 344_001),
        unitFileFor("aggregate-two", "test:db:2", 344_000),
        unitFileFor("aggregate-three", "test:db:3", 344_000),
      ],
      { model: singleWorkerModel() },
    );

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "no execution-unit count satisfies the model; binding constraint is the 1080000ms aggregate",
        ),
      ]),
    );
  });

  // -- per-case semantic identity ------------------------------------------

  it("fails closed naming the case when a frozen identity value drifts", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const [fileName, partition] = Object.entries(fixture.manifest)[0]!;
    const caseName = partition.cases[0]!.name;
    fixture.manifest[fileName] = {
      ...partition,
      cases: partition.cases.map((testCase, index) =>
        index === 0 ? { ...testCase, identity: "0123456789abcdef" } : testCase,
      ),
    };

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `bootstrap DB case '${caseName}' has semantic identity '${partition.cases[0]!.identity}' but the ` +
            "manifest freezes '0123456789abcdef'",
        ),
      ]),
    );
  });

  it("fails closed naming the case when a manifested case carries no frozen identity", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const [fileName, partition] = Object.entries(fixture.manifest)[0]!;
    const caseName = partition.cases[0]!.name;
    fixture.manifest[fileName] = {
      ...partition,
      cases: partition.cases.map((testCase, index) =>
        index === 0 ? ({ name: testCase.name, referenceDurationMs: testCase.referenceDurationMs } as never) : testCase,
      ),
    };

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([`${fileName} case '${caseName}' must declare a frozen 16-character identity value`]),
    );
  });

  it("fails closed naming the case when exactly one assertion's semantics change", async () => {
    const files: FixtureFile[] = [
      {
        fileName: "semantic-assertion.db.test.ts",
        databaseSuffix: "platform_api_semantic_assertion",
        executionUnit: "test:db:1",
        cases: [
          { name: "asserts the seeded count", referenceDurationMs: 1_000, body: "  expect(await count()).toBe(3);" },
          { name: "asserts the sibling count", referenceDurationMs: 1_000, body: "  expect(await count()).toBe(7);" },
        ],
      },
    ];
    const fixture = await createFixture(files);
    const path = join(fixture.root, "__tests__", "semantic-assertion.db.test.ts");
    // Name, file, database suffix, and execution unit all stay byte-identical.
    await writeFile(path, (await readFile(path, "utf8")).replace("toBe(3)", "toBe(4)"));

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("bootstrap DB case 'asserts the seeded count' has semantic identity"),
      ]),
    );
    expect(runFixture(fixture).violations).not.toEqual(
      expect.arrayContaining([expect.stringContaining("'asserts the sibling count' has semantic identity")]),
    );
  });

  it("fails closed naming the case when exactly one data-profile selection changes", async () => {
    const files: FixtureFile[] = [
      {
        fileName: "semantic-profile.db.test.ts",
        databaseSuffix: "platform_api_semantic_profile",
        executionUnit: "test:db:1",
        cases: [
          {
            name: "seeds under the non-production profile shapes",
            referenceDurationMs: 1_000,
            body: "  await seed({ enabledDataProfiles: nonProductionDataProfiles });\n  expect(true).toBe(true);",
          },
          {
            name: "seeds under the production-like profile shapes",
            referenceDurationMs: 1_000,
            body: "  await seed({ enabledDataProfiles: productionLikeDataProfiles });\n  expect(true).toBe(true);",
          },
        ],
      },
    ];
    const fixture = await createFixture(files);
    const path = join(fixture.root, "__tests__", "semantic-profile.db.test.ts");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace(
        "await seed({ enabledDataProfiles: nonProductionDataProfiles });",
        "await seed({ enabledDataProfiles: productionLikeDataProfiles });",
      ),
    );

    const violations = runFixture(fixture).violations;
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "bootstrap DB case 'seeds under the non-production profile shapes' has semantic identity",
        ),
      ]),
    );
    expect(violations).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("'seeds under the production-like profile shapes' has semantic identity"),
      ]),
    );
  });

  it("keeps every identity value unchanged when a byte-identical case moves file and execution unit", async () => {
    // Sized so two units stay the model's own minimum on both sides of the move,
    // which keeps this control about identity and nothing else.
    const body = "  await seed();\n  expect(await count()).toBe(3);";
    const stay: FixtureCase = { name: "stays put", referenceDurationMs: 150_000, body: "  expect(1).toBe(1);" };
    const travelling: FixtureCase = { name: "travels between units", referenceDurationMs: 150_000, body };
    const resident: FixtureCase = { name: "already there", referenceDurationMs: 150_000, body: "  expect(2).toBe(2);" };

    const before = await createFixture(
      [
        {
          fileName: "relocation-origin.db.test.ts",
          databaseSuffix: "platform_api_relocation_origin",
          executionUnit: "test:db:1",
          cases: [stay, travelling],
        },
        {
          fileName: "relocation-target.db.test.ts",
          databaseSuffix: "platform_api_relocation_target",
          executionUnit: "test:db:2",
          cases: [resident],
        },
      ],
      { model: singleWorkerModel() },
    );
    const after = await createFixture(
      [
        {
          fileName: "relocation-origin.db.test.ts",
          databaseSuffix: "platform_api_relocation_origin",
          executionUnit: "test:db:1",
          cases: [stay],
        },
        {
          fileName: "relocation-target.db.test.ts",
          databaseSuffix: "platform_api_relocation_target",
          executionUnit: "test:db:2",
          cases: [resident, travelling],
        },
      ],
      { model: singleWorkerModel() },
    );

    const beforeResult = runFixture(before);
    const afterResult = runFixture(after);

    expect(beforeResult.violations).toEqual([]);
    expect(afterResult.violations).toEqual([]);
    expect(afterResult.caseIdentities).toEqual(beforeResult.caseIdentities);
  });

  it("derives identity from the case body rather than from its name, file, or unit", async () => {
    const body = "  expect(await count()).toBe(3);";
    const fixture = await createFixture(
      [
        {
          fileName: "identity-shape-one.db.test.ts",
          databaseSuffix: "platform_api_identity_shape_one",
          executionUnit: "test:db:1",
          cases: [{ name: "first name for this body", referenceDurationMs: 250_000, body }],
        },
        {
          fileName: "identity-shape-two.db.test.ts",
          databaseSuffix: "platform_api_identity_shape_two",
          executionUnit: "test:db:2",
          cases: [{ name: "second name for the same body", referenceDurationMs: 250_000, body }],
        },
      ],
      { model: singleWorkerModel() },
    );
    const { caseIdentities, violations } = runFixture(fixture);

    expect(violations).toEqual([]);
    expect(caseIdentities["first name for this body"]).toBe(caseIdentities["second name for the same body"]);
  });

  it("fails closed when a per-case timeout changes", async () => {
    const fixture = await createFixture([
      {
        fileName: "timeout-identity.db.test.ts",
        databaseSuffix: "platform_api_timeout_identity",
        executionUnit: "test:db:1",
        cases: [
          {
            name: "runs under its declared timeout",
            referenceDurationMs: 1_000,
            body: "  expect(1).toBe(1);",
            timeoutMs: 300_000,
          },
        ],
      },
    ]);
    const path = join(fixture.root, "__tests__", "timeout-identity.db.test.ts");
    await writeFile(path, (await readFile(path, "utf8")).replace("300000", "600000"));

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("bootstrap DB case 'runs under its declared timeout' has semantic identity"),
      ]),
    );
  });

  it("derives the shipped authoritative-seed-resume identities from the pre-split single-file layout", () => {
    // The three `authoritative-seed-resume-*` files were carved out of one file.
    // Reassembling their case declarations into a single source and re-deriving
    // every identity reproduces the frozen values, which is the executable form
    // of "relocation changed ownership, not semantics".
    const manifested = Object.entries(bootstrapDbEnrollmentManifest).filter(([fileName]) =>
      fileName.startsWith("authoritative-seed-resume-"),
    );
    expect(manifested).toHaveLength(3);

    const reassembled = manifested
      .flatMap(([fileName]) => caseDeclarationsOf(join(testDirectory, fileName)))
      .join("\n\n");
    const derived = new Map(
      deriveBootstrapDbCaseIdentities(
        "authoritative-seed-resume.db.test.ts",
        `import { describe, expect, it } from "vitest";\n${reassembled}\n`,
      ).map((entry) => [entry.name, entry.identity]),
    );

    for (const [, partition] of manifested) {
      for (const testCase of partition.cases) {
        expect(derived.get(testCase.name)).toBe(testCase.identity);
      }
    }
    expect(derived.size).toBe(10);
  });

  it("preserves the Catalog split's original case identities, helpers, profiles, and state plumbing", () => {
    const files = ["catalog-seed-aggregate-state.db.test.ts", "catalog-seed-interruption-resume.db.test.ts"];
    const sources = files.map((file) => readFileSync(join(testDirectory, file), "utf8"));
    const expected = [
      {
        name: "reconciles all required aggregates for a clean scenario-seed-only module seed",
        identity: "c749fe673131aada",
      },
      {
        name: "does not re-author unchanged Product Measures facts on scenario-seed repeat",
        identity: "119d53278b4453d7",
      },
      {
        name: "NC-1 resumes an undrained Dimension seed without duplicate creation",
        identity: "ddeee7bac7384389",
      },
      {
        name: "NC-2 resumes a Component committed at created version one across two ordinary boots",
        identity: "d6b487fe4780b81f",
      },
      {
        name: "NC-3 restores lagging projections without re-authoring active aggregates",
        identity: "5370dfdb151548b6",
      },
      {
        name: "rebuilds lost Catalog Item projections from retained streams without appending item events",
        identity: "f7c024ac13659525",
      },
      {
        name: "NC-4 ignores populated containers when required aggregates have zero events",
        identity: "31ea7ebe99c1ec04",
      },
      {
        name: "NC-5a repairs a draft partial aggregate rather than skipping it",
        identity: "da4c8d1fc71a5c6b",
      },
      {
        name: "NC-5b rejects conflicting retained identity metadata on both boots",
        identity: "220cd5f763d298b2",
      },
      {
        name: "NC-5c rejects a terminal retained aggregate on both boots",
        identity: "547ba56539985bfc",
      },
      {
        name: "resumes after Dimensions under scenario-seed and production-like profiles",
        identity: "b006b495c2b4a662",
      },
      {
        name: "resumes after Fields under scenario-seed and production-like profiles",
        identity: "13b82872bb3ba0b8",
      },
      {
        name: "resumes after Reference Data under scenario-seed and production-like profiles",
        identity: "3cfe7d19f03127f2",
      },
      {
        name: "resumes after Components under scenario-seed and production-like profiles",
        identity: "7ef841ec166b46d3",
      },
      {
        name: "resumes after Blueprints under scenario-seed and production-like profiles",
        identity: "9a1c524b0483b012",
      },
      {
        name: "resumes after the final Category under scenario-seed and production-like profiles",
        identity: "cb5ecec3a418a82a",
      },
      {
        name: "resumes mid catalog.component.created under scenario-seed and production-like profiles",
        identity: "ea939096e104ab7e",
      },
      {
        name: "keeps the required aggregate set equal to the base aggregate streams authored by the seed",
        identity: "2be8f4782fdbd9eb",
      },
      {
        name: "preserves duplicate CreateDimension rejection through the non-seed command handler",
        identity: "b21990765232df57",
      },
    ];
    expect(sources.map((source, index) => deriveBootstrapDbCaseIdentities(files[index]!, source).length)).toEqual([
      10, 9,
    ]);
    const actual = sources.flatMap((source, index) => deriveBootstrapDbCaseIdentities(files[index]!, source));
    expect(actual).toEqual(expected);
    expect(deriveBootstrapDbCaseIdentities("catalog-before-split.ts", sources.join("\n"))).toEqual(expected);
    const support = readFileSync(join(testDirectory, "catalog-seed-test-support.ts"), "utf8");
    // Historical AST digests exclude export plumbing; the deny-all host adaptation is pinned and stripped below.
    const expectedHelpers = {
      CatalogServices: "a8e89b7f2c21b03bc9f44258e94d22397bd36823e944e9c8a3a7c8a5743e6872",
      InterruptionSite: "c4dadca6244573816136cb34ca52f186a2b47b8e32dcf3d6302940783a75d4b2",
      catalogApiContextRegistry: "18182c8373dbd2f5e45173269916afa76b01ff26fdabedeea967a79732cf656c",
      profileShapes: "3ac53db3762c52cfff690dc427bea3cdaa82f4b585095736995aab43c1ac00f6",
      databaseUrls: "14168e4de456370321f00dbba9697c134df3470f0fa860257723d60bd2282ff1",
      pools: "5260c751c5ee88b848ffa1899726fad225c3283d06d00721d9c04f5cc43de6f9",
      createCatalogSeedHost: "595a21d28805159ba5dccd4f756f478b16780895bc545bd73adab76cf89fbf70",
      prepareCatalog: "7fb847531b8b855767631e51c953bfdb3c1b1afae463f6d63a0c62b6fe22a140",
      catalogServices: "d46e45a440d6e719db7d53d9a6e9e6368733a6e6472b68f11d185ce25e5a4b1a",
      bootstrapOptions: "d24074c11b027484bafc2bac41825f4c71637fc61fe323b4be46a3115e6a3356",
      ordinaryBoot: "af77dd4e0a44542cdd59f540162671b5aa43a41854540b059645805e3ef46dd2",
      directCatalogSeed: "5f92569adbd12cdf93563627604d131d61a35ebf0869b1bfce692d540fbbddc0",
      interruptCatalogSeed: "7320441f318dc4297dd1b47ce05347702ee40af10b4b8afcc10331cfe16596c7",
      requiredEventCounts: "c18ab0d0f7a0e8d2898fe5f377ddecf41afd678d4a0c9ffe36df80c5f75de869",
      scenarioCatalogItemIds: "36c6b74cf24896748bc58547d830d1207d6223e34762339f5cbff569bbb0f628",
      scenarioCatalogItemEventCount: "f3addf065f08c6a453e0950421de0d8a917e981eaa21849faacbe17d437ae1c8",
      scenarioCatalogItemProjectionCount: "6363da0f59ce702d229f9fd80b1c0201fb91754daa2f29324f1de8c2423aed1a",
      expectAllRequiredAggregatesActive: "369a626a2fab08da27aceb6c2f7d9b02b335a9403c17c3d2fc45a7296c124c89",
      expectInterruptionSiteResumes: "196253203c6359a242ccc1b93ebb7e09c6ac3eefb051466617a109350ca6f7b9",
      createSingleCardIdentityDraft: "ec3f0d976f232c1b91d2e4d4f6ea3f3b85e48af4755c73f0d904e562c4348650",
      countEventType: "8e6bce9f27100dc8908b423c891fba220966ecb25053e543773e78fa87603063",
      productMeasuresResolvedEventCount: "e2e782cabf3e69987cfef01b5945a395d0dc7dafc886b8921b62bed2c39640ad",
      expectCatalogOnlyHarnessConnections: "050500884f78834e05044997894a2dc3cb7a54f250232f09d64c80ed6e8e490a",
    };
    const { assignCatalogSeedState, ...helpers } = catalogDeclarationDigests(support);
    expect(helpers).toEqual(expectedHelpers);
    const tree = sourceFileOf(support);
    const removals: { start: number; end: number }[] = [];
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "capabilityAdministrationAuthority") {
        expect(node.initializer.getText(tree)).toBe('{ kind: "deny-all", diagnostic: "authority_absent" }');
        let end = node.end;
        while (/\s/.test(support[end] ?? "") && end < support.length) end++;
        if (support[end] === ",") end++;
        removals.push({ start: node.getStart(tree), end });
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect(removals).toHaveLength(1);
    let historicalShape = support;
    for (const removal of removals.sort((a, b) => b.start - a.start)) {
      historicalShape = historicalShape.slice(0, removal.start) + historicalShape.slice(removal.end);
    }
    expect(catalogDeclarationDigests(historicalShape).createCatalogSeedHost).toBe(
      "25c315bf2f227c021c59f158afaaea76469224c41997e0a9a92b22b9e51abe52",
    );
    expect(assignCatalogSeedState).toBeTruthy();
    for (const [index, source] of sources.entries()) {
      const suffix = index === 0 ? "aggregate_state" : "interruption_resume";
      expect(catalogHarnessDeclarations(source)).toEqual(
        catalogHarnessDeclarations(
          `createPlatformApiBootstrapTestHarness("platform_api_catalog_seed_${suffix}", assignCatalogSeedState, { activeContextNames: ["catalog"] });`,
        ),
      );
    }
    expect(support).toContain("databaseUrls = state.databaseUrls;\n  pools = state.pools;");
    expect(support).not.toContain("createPlatformApiBootstrapTestHarness(");

    // Each independent red control changes only its named variable, never the frozen identity or helper input.
    const assertion = sources[0]!.replace(".toBe(131)", ".toBe(132)");
    const profile = sources[0]!.replace(
      'enabledDataProfiles: ["scenario-seed"]',
      'enabledDataProfiles: ["integration-seed"]',
    );
    const declaration = extractCaseDeclaration(sources[1]!, expected[10]!.name);
    const timeout = sources[1]!.replace(declaration, declaration.replace(/\);$/u, ", 600000);"));
    for (const [index, mutant] of [
      [0, assertion],
      [0, profile],
      [1, timeout],
    ] as const) {
      expect(mutant).not.toBe(sources[index]);
      const observed = deriveBootstrapDbCaseIdentities(files[index]!, mutant);
      const frozen = index === 0 ? expected.slice(0, 10) : expected.slice(10);
      expect(observed.map((entry) => entry.name)).toEqual(frozen.map((entry) => entry.name));
      expect(observed.filter((entry, offset) => entry.identity !== frozen[offset]!.identity)).toHaveLength(1);
    }
    expect(deriveBootstrapDbCaseIdentities(files[1]!, sources[1]!.replace(declaration, ""))).toHaveLength(8);
    expect(deriveBootstrapDbCaseIdentities(files[1]!, sources[1]! + "\n" + declaration)).toHaveLength(10);
    const helperBypass = support.replace("await ordinaryBoot(runtime, profile);", "await Promise.resolve();");
    expect(helperBypass).not.toBe(support);
    expect(catalogDeclarationDigests(helperBypass).expectInterruptionSiteResumes).not.toBe(
      expectedHelpers.expectInterruptionSiteResumes,
    );
    expect(catalogDeclarationDigests(helperBypass).profileShapes).toBe(expectedHelpers.profileShapes);
  });

  // -- boot-bearing ceilings ------------------------------------------------

  it("rejects an execution unit pushed past its declared boot-bearing ceiling", async () => {
    const files = shippedShapedFiles();
    const largest = "test:db:2";
    const observed = bootstrapDbExecutionUnitBootBearingCaseCeilings[largest];
    const fixture = await createShippedFixture(files, {
      ceilings: { ...bootstrapDbExecutionUnitBootBearingCaseCeilings, [largest]: observed - 1 },
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        `${largest} has ${observed} boot-bearing cases, exceeding its declared ceiling of ${observed - 1}`,
      ]),
    );
  });

  it("rejects one boot-bearing case moved into the largest execution unit", async () => {
    const files = shippedShapedFiles();
    const donor = files.find((file) => file.fileName === "authoritative-seed-resume-reconciliation.db.test.ts")!;
    const receiver = files.find((file) => file.fileName === "authoritative-seed-resume-recovery.db.test.ts")!;
    expect(donor.executionUnit).not.toBe(receiver.executionUnit);
    const moved = donor.cases.find(
      (testCase) => testCase.name === "accepts a seeded resolution after the real deadline sweep advances it to closed",
    )!;
    const relocated = files.map((file) => {
      if (file.fileName === donor.fileName) {
        return {
          ...file,
          bootBearingCases: (donor.bootBearingCases as readonly string[]).filter((name) => name !== moved.name),
          cases: file.cases.filter((testCase) => testCase.name !== moved.name),
        };
      }
      if (file.fileName === receiver.fileName) {
        return { ...file, cases: [...file.cases, moved] };
      }
      return file;
    });
    const fixture = await createShippedFixture(relocated, {
      ceilings: bootstrapDbExecutionUnitBootBearingCaseCeilings,
    });
    const receiverCeiling = new Map(Object.entries(bootstrapDbExecutionUnitBootBearingCaseCeilings)).get(
      receiver.executionUnit,
    );
    if (receiverCeiling === undefined) throw new Error(`Missing ceiling for ${receiver.executionUnit}`);

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        `${receiver.executionUnit} has ${receiverCeiling + 1} boot-bearing cases, exceeding its declared ceiling of ${receiverCeiling}`,
      ]),
    );
  });

  it("rejects a boot-bearing classification that names an unknown case", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files);
    const fileName = "authoritative-seed-resume-core.db.test.ts";
    fixture.manifest[fileName] = {
      ...fixture.manifest[fileName]!,
      bootBearingCases: ["a case this file does not declare"],
    };

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([`${fileName} classifies unknown boot-bearing case 'a case this file does not declare'`]),
    );
  });

  it("rejects an execution unit with no declared boot-bearing ceiling", async () => {
    const files = shippedShapedFiles();
    const fixture = await createShippedFixture(files, {
      ceilings: { "test:db:1": bootstrapDbExecutionUnitBootBearingCaseCeilings["test:db:1"] },
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([expect.stringContaining("test:db:2 must declare a boot-bearing case ceiling")]),
    );
  });

  // -- fail-closed discovery inputs ----------------------------------------

  it("fails closed when the workspace vitest configuration cannot supply an include glob", async () => {
    const fixture = await createShippedFixture(shippedShapedFiles());
    await rm(join(fixture.root, "vitest.config.ts"));

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vitest.config.ts is required to derive the executable test-entry set"),
      ]),
    );
  });

  it("evaluates an unmistakably synthetic twelve-file 66-case shipped-shaped enrollment without changing main", async () => {
    const files = shippedShapedFiles()
      .filter((file) => file.fileName !== "connector-mount-gate-isolation.db.test.ts")
      .map((file, index) => ({
        ...file,
        executionUnit: index < 6 ? "test:db:1" : "test:db:2",
        cases: file.cases.map((testCase) => ({
          ...testCase,
          referenceDurationMs: Math.floor(150_000 / file.cases.length),
        })),
      }));
    expect(files).toHaveLength(11);
    expect(files.reduce((count, file) => count + file.cases.length, 0)).toBe(61);
    files.push({
      fileName: "synthetic-twelfth-enrollment.db.test.ts",
      databaseSuffix: "synthetic_twelfth_enrollment",
      executionUnit: "test:db:2",
      cases: [1_518, 1_332, 1_213, 1_273, 1_419].map((referenceDurationMs, index) => ({
        name: `synthetic twelfth enrollment case ${index}`,
        referenceDurationMs,
        body: `  expect(${index}).toBe(${index});`,
      })),
    });
    // These are synthetic workload inputs, not fresh connector reference facts.
    const fixture = await createFixture(files, { model: { maximumScheduledFileCount: 12 } });
    const result = runFixture(fixture);
    expect(result.violations).toEqual([]);
    expect(result.fileCount).toBe(12);
    expect(result.caseCount).toBe(66);
    expect(result.schedule.minimumUnitCount).toBe(2);
    expect(bootstrapDbScheduleModel.maximumScheduledFileCount).toBe(12);
    expect(runFixture({ ...fixture, model: { ...fixture.model, maximumScheduledFileCount: 11 } }).violations).toContain(
      "the schedule model refuses to enumerate 12 files, above its declared bound of 11; " +
        "re-derive the bound deliberately rather than sampling assignments",
    );
    const overBound = await createFixture(
      [...files, unitFileFor("synthetic-thirteenth-enrollment", "test:db:2", 1_000)],
      { model: { maximumScheduledFileCount: 12 } },
    );
    expect(runFixture(overBound).violations).toContain(
      "the schedule model refuses to enumerate 13 files, above its declared bound of 12; " +
        "re-derive the bound deliberately rather than sampling assignments",
    );
  });

  describe("measured one-fewer-unit floor", () => {
    const bootstrapFilesDiffer = "the paired capture's bootstrap files differ from the shipped capture's:";

    function deriveFrom({ shipped, paired }: MeasuredCaptures) {
      return deriveBootstrapDbMeasuredOneFewerUnitFloor({ shippedCapture: shipped, pairedCapture: paired });
    }

    function derivedFloor(): BootstrapDbMeasuredOneFewerUnitFloor {
      const { floor, refusal } = deriveFrom(readMeasuredCaptures());
      expect(refusal).toBeNull();
      return floor!;
    }

    function refusalAfter(edit: (captures: MeasuredCaptures) => void) {
      const captures = readMeasuredCaptures();
      edit(captures);
      const { floor, refusal } = deriveFrom(captures);
      expect(floor).toBeNull();
      return refusal;
    }

    function fileOf(capture: MeasuredCapture, fileName: string) {
      const file = capture.files.find((entry) => entry.fileName === fileName);
      expect(file, fileName).toBeDefined();
      return file!;
    }

    function runWithFloor(fixture: Fixture, measuredOneFewerUnitFloor: BootstrapDbMeasuredOneFewerUnitFloor | null) {
      return checkBootstrapDbEnrollment({
        platformApiRoot: fixture.root,
        manifest: fixture.manifest,
        executionUnitBootBearingCaseCeilings: fixture.ceilings,
        scheduleModel: fixture.model,
        nonBootstrapCensus: fixture.nonBootstrapCensus,
        measuredOneFewerUnitFloor,
      });
    }

    /** A floor that does not apply leaves every violation byte-identical to a floor-absent run. */
    function expectNotApplied(fixture: Fixture, floor: BootstrapDbMeasuredOneFewerUnitFloor, reason: string) {
      const result = runWithFloor(fixture, floor);
      const absent = runWithFloor(fixture, null);
      expect(result.schedule.measuredOneFewerUnitFloor).toEqual({ applied: false, reason });
      expect(result.schedule.effectiveMinimumUnitCount).toBe(result.schedule.minimumUnitCount);
      expect(result.violations).toEqual(absent.violations);
      return result;
    }

    it("T1: lets the paired over-ceiling two-unit capture set the measured three-unit topology's effective minimum", async () => {
      const floor = derivedFloor();
      const { shipped, paired } = readMeasuredCaptures();
      expect(floor).toMatchObject({
        shippedReferenceRunId: Number(shipped.provenance.runId),
        pairedReferenceRunId: Number(paired.provenance.runId),
        pairedReferenceJobId: paired.provenance.referenceJobId,
        pairedArtifactSha256: paired.provenance.artifactSha256,
        unitCount: new Set(shipped.files.map((file) => file.executionUnit)).size - 1,
        assignment: Object.fromEntries(paired.files.map((file) => [file.fileName, file.executionUnit])),
      });
      expect(Math.max(...Object.values(floor.unitMakespansMs))).toBeGreaterThan(paired.model.executionUnitCeilingMs);
      expect([floor, floor.assignment, floor.unitMakespansMs].every((value) => Object.isFrozen(value))).toBe(true);

      const fixture = await shippedCaptureFixture();
      const absent = runWithFloor(fixture, null);
      expect(absent.violations).toEqual([minimalityViolation]);
      expect(absent.schedule).toMatchObject({
        minimumUnitCount: 2,
        effectiveMinimumUnitCount: 2,
        measuredOneFewerUnitFloor: { applied: false, reason: noFloor },
      });

      const applied = expectedMeasuredFloorVerdict(floor, shipped.model).reason;
      const result = runWithFloor(fixture, floor);
      expect(runWithFloor(fixture, null)).toEqual(absent);
      expect(result.violations).toEqual([]);
      expect(result.schedule.units.map((unit) => unit.makespanMs)).toEqual([309413, 252646, 208357]);
      expect(result.schedule).toMatchObject({
        observedUnitCount: 3,
        minimumUnitCount: 2,
        effectiveMinimumUnitCount: 3,
        measuredOneFewerUnitFloor: { applied: true, reason: applied },
      });
      expect(formatBootstrapDbEnrollmentResult(result).split("\n")).toContain(
        `  measured one-fewer-unit floor applied: ${applied}; effectiveMinimumUnitCount 3`,
      );
    });

    it.each<[string, (captures: MeasuredCaptures) => void, string]>([
      [
        "a bootstrap file's sourceSha256",
        ({ paired }) => (fileOf(paired, "bootstrap-scenario.db.test.ts").sourceSha256 = "0".repeat(64)),
        `${bootstrapFilesDiffer} bootstrap-scenario.db.test.ts has a different sourceSha256`,
      ],
      [
        "a bootstrap file's testPath",
        ({ paired }) => (fileOf(paired, "bootstrap-scenario.db.test.ts").testPath = "__tests__/moved.db.test.ts"),
        `${bootstrapFilesDiffer} bootstrap-scenario.db.test.ts has a different testPath`,
      ],
      [
        "one case identity",
        ({ paired }) => (fileOf(paired, "bootstrap-scenario.db.test.ts").cases[1]!.identity = "0".repeat(16)),
        `${bootstrapFilesDiffer} bootstrap-scenario.db.test.ts has different ordered case names or identities`,
      ],
      [
        "the case order",
        ({ paired }) => fileOf(paired, "bootstrap-scenario.db.test.ts").cases.reverse(),
        `${bootstrapFilesDiffer} bootstrap-scenario.db.test.ts has different ordered case names or identities`,
      ],
      [
        "a missing bootstrap file",
        ({ paired }) =>
          (paired.files = paired.files.filter((file) => file.fileName !== "bootstrap-scenario.db.test.ts")),
        `${bootstrapFilesDiffer} bootstrap-scenario.db.test.ts is missing from the paired capture`,
      ],
      [
        "an extra bootstrap file",
        ({ shipped }) =>
          (shipped.files = shipped.files.filter((file) => file.fileName !== "bootstrap-scenario.db.test.ts")),
        `${bootstrapFilesDiffer} bootstrap-scenario.db.test.ts is not in the shipped capture`,
      ],
      [
        "more bootstrap files than its model may schedule",
        ({ paired }) => paired.files.push({ ...paired.files[0]!, fileName: "synthetic-extra.db.test.ts" }),
        "the paired capture is malformed: it measures 13 bootstrap files, outside 1 to 12",
      ],
      [
        "a non-bootstrap file's sourceSha256",
        ({ paired }) => (paired.nonBootstrapFiles[5]!.sourceSha256 = "0".repeat(64)),
        "the paired capture's nonBootstrapFiles differ from the shipped capture's at __tests__/seed-command-catalog.db.test.ts",
      ],
      [
        "a sourceBindings digest",
        ({ paired }) =>
          (paired.sourceBindings["bounded-contexts/catalog/features/product-measures/api/runtime.ts"] = "0".repeat(64)),
        "the paired capture's sourceBindings differ from the shipped capture's at " +
          "bounded-contexts/catalog/features/product-measures/api/runtime.ts",
      ],
      ...[
        "node",
        "pnpm",
        "vitest",
        "imageOS",
        "imageVersion",
        "postgresImageDigests",
        "maxWorkers",
        "workspaceConcurrency",
        "laneMode",
        "modeledUnitCeilingMs",
        "modeledAggregateCeilingMs",
      ].map((field): [string, (captures: MeasuredCaptures) => void, string] => [
        `provenance ${field}`,
        ({ paired }) => (paired.provenance[field] = { changed: paired.provenance[field] }),
        `the paired capture's provenance ${field} differs from the shipped capture's`,
      ]),
      ...(
        [
          ["executionUnitCeilingMs", 419_999],
          ["aggregateCeilingMs", 1_079_999],
          ["maxWorkersPerExecutionUnit", 2],
        ] as const
      ).map(([field, value]): [string, (captures: MeasuredCaptures) => void, string] => [
        `model ${field}`,
        ({ paired }) => (paired.model = { ...paired.model, [field]: value }),
        `the paired capture's model ${field} differs from the shipped capture's`,
      ]),
    ])("T2: refuses a paired capture that changes %s", (_name, edit, refusal) => {
      expect(refusalAfter(edit)).toBe(refusal);
    });

    it("T2: does not apply a floor bound to another reference run or another file set", async () => {
      const floor = derivedFloor();
      const fixture = await shippedCaptureFixture();
      // createShippedFixture's model carries unmistakably synthetic provenance.
      const synthetic = await createShippedFixture(shippedShapedFiles(), { model: acceptedTimingInputs() });
      expectNotApplied(synthetic, floor, expectedMeasuredFloorVerdict(floor, synthetic.model).reason);
      const [dropped, ...kept] = Object.entries(floor.assignment);
      const coverage = "the measured one-fewer-unit floor assignment does not cover exactly the manifested files";
      expectNotApplied(fixture, { ...floor, assignment: Object.fromEntries(kept) }, coverage);
      expectNotApplied(
        fixture,
        { ...floor, assignment: { ...floor.assignment, "synthetic-extra.db.test.ts": dropped![1] } },
        coverage,
      );
      expect(expectNotApplied(fixture, { ...floor, assignment: {} }, coverage).violations).toEqual([
        minimalityViolation,
      ]);
    });

    it("T3: refuses a paired capture whose projection stays within the ceiling and ignores such a floor", async () => {
      expect(
        refusalAfter(({ paired }) => {
          for (const testCase of paired.files.flatMap((file) => file.cases)) testCase.durationMs /= 2;
        }),
      ).toBe("the paired capture's 2-unit projection peaks at 222156ms, within the 420000ms per-unit ceiling");
      const floor = derivedFloor();
      expectNotApplied(
        await shippedCaptureFixture(),
        { ...floor, unitMakespansMs: { "test:db:1": 420_000, "test:db:2": 420_000 } },
        "no unit of the measured one-fewer-unit floor exceeds the 420000ms per-unit ceiling",
      );
    });

    it("T4: refuses a paired capture that measures the shipped unit count or two fewer, and ignores such a floor", async () => {
      expect(
        refusalAfter(({ paired }) => {
          for (const file of paired.files) file.executionUnit = "test:db:1";
        }),
      ).toBe("the paired capture measures 1 execution unit(s), not one fewer than the shipped capture's 3");
      expect(
        refusalAfter(({ paired }) => (fileOf(paired, "bootstrap-scenario.db.test.ts").executionUnit = "test:db:3")),
      ).toBe("the paired capture measures 3 execution unit(s), not one fewer than the shipped capture's 3");

      const floor = derivedFloor();
      const fixture = await shippedCaptureFixture();
      const threeUnits = { ...floor.assignment, "bootstrap-scenario.db.test.ts": "test:db:3" as const };
      expectNotApplied(
        fixture,
        { ...floor, assignment: threeUnits },
        "the measured one-fewer-unit floor assignment spans 3 unit(s), not its declared 2",
      );
      expectNotApplied(
        fixture,
        { ...floor, assignment: threeUnits, unitCount: 3 },
        "the measured one-fewer-unit floor measures 3 unit(s), not one fewer than the 3 observed",
      );
    });

    it("T5: keeps both violations when the shipped schedule itself exceeds the per-unit ceiling", async () => {
      const reassigned = { "catalog-seed-aggregate-state.db.test.ts": "test:db:1" };
      expect(
        refusalAfter(
          ({ shipped }) => (fileOf(shipped, "catalog-seed-aggregate-state.db.test.ts").executionUnit = "test:db:1"),
        ),
      ).toBe(
        "the shipped capture's own 3-unit projection exceeds the 420000ms per-unit ceiling or the 1080000ms aggregate",
      );
      const result = expectNotApplied(
        await shippedCaptureFixture(reassigned),
        derivedFloor(),
        "the shipped schedule exceeds the per-unit ceiling or the aggregate, so the measured one-fewer-unit floor is not applied",
      );
      expect(result.violations).toEqual([
        "test:db:1 has a projected makespan of 473418ms, exceeding the 420000ms per-unit ceiling",
        minimalityViolation,
      ]);
    });

    it.each<[string, Partial<BootstrapDbScheduleModel>, string, string]>([
      [
        "an aggregate violation",
        { aggregateCeilingMs: 832_873 },
        "the shipped schedule exceeds the per-unit ceiling or the aggregate, so the measured one-fewer-unit floor is not applied",
        "the projected aggregate of 770416ms across 3 execution units plus the 62458ms job overhead is 832874ms, " +
          "exceeding the 832873ms aggregate ceiling",
      ],
      [
        "a schedule-model refusal",
        { maximumScheduledFileCount: 11 },
        "the schedule model refused, so the measured one-fewer-unit floor is not applied",
        "the schedule model refuses to enumerate 12 files, above its declared bound of 11; " +
          "re-derive the bound deliberately rather than sampling assignments",
      ],
    ])("T5: does not apply an unmistakably synthetic floor over %s", async (_name, model, reason, violation) => {
      const { shipped, paired } = readMeasuredCaptures();
      const base = await createShippedFixture(shippedCaptureFiles(), { model: shipped.model });
      const fixture = { ...base, model: { ...base.model, ...model } };
      const syntheticFloor: BootstrapDbMeasuredOneFewerUnitFloor = {
        shippedReferenceRunId: fixture.model.referenceRunId,
        pairedReferenceRunId: 65_440_005,
        pairedReferenceJobId: 65_440_006,
        pairedArtifactSha256: "6544".padEnd(64, "0"),
        unitCount: 2,
        assignment: Object.fromEntries(
          paired.files.map((file) => [file.fileName, file.executionUnit as `test:db:${number}`]),
        ),
        unitMakespansMs: { "test:db:1": 420_001, "test:db:2": 1 },
      };
      expect(fixture.model).toMatchObject(syntheticScheduleModelProvenance);
      expect(expectNotApplied(fixture, syntheticFloor, reason).violations).toContain(violation);
    });

    it("T6: binds the declared floor to its measured pair and applies it exactly when it binds the current model", () => {
      const { shipped, paired } = readCurrentMeasuredCaptures();
      const derived = deriveBootstrapDbMeasuredOneFewerUnitFloor({ shippedCapture: shipped, pairedCapture: paired });
      expect(derived.refusal).toBeNull();
      expect(bootstrapDbMeasuredOneFewerUnitFloor).toEqual(derived.floor);
      expect(bootstrapDbMeasuredOneFewerUnitFloor).not.toBeNull();
      const enrollment = defaultPathEnrollment(currentMinimumUnitCount);
      expect(enrollment.result.schedule).toMatchObject({
        measuredOneFewerUnitFloor: expectedMeasuredFloorVerdict(enrollment.floor, enrollment.model),
        minimumUnitCount: currentMinimumUnitCount,
        effectiveMinimumUnitCount: 3,
        observedUnitCount: 3,
      });
      expect(enrollment.result.violations).toEqual([]);
      expectDefaultPathFloorRole(enrollment);
      expectOneFewerUnitInfeasible(enrollment);
    });

    it("T7: pins both paired capture fixtures to their bytes and their live artifact digests", () => {
      for (const { fileName, fixtureSha256, artifactDigest } of [
        ...Object.values(historicalMeasuredFloorCaptures),
        ...Object.values(currentMeasuredFloorCaptures),
      ]) {
        const bytes = readFileSync(join(testDirectory, "fixtures", fileName));
        expect(sha256Of(bytes), fileName).toBe(fixtureSha256);
        const { provenance } = JSON.parse(bytes.toString("utf8")) as { provenance: { artifactSha256: string } };
        expect(`sha256:${provenance.artifactSha256}`, fileName).toBe(artifactDigest);
      }
    });

    let retainedEnrollment: Promise<DefaultPathEnrollment> | undefined;
    let naturallyMinimalEnrollment: DefaultPathEnrollment | undefined;

    /** Historical workload with its derived floor passed explicitly; its model minimum is 2. */
    function retainedDefaultPathEnrollment() {
      retainedEnrollment ??= shippedCaptureFixture().then((fixture) =>
        defaultPathEnrollment(2, {
          platformApiRoot: fixture.root,
          manifest: fixture.manifest,
          executionUnitBootBearingCaseCeilings: fixture.ceilings,
          scheduleModel: fixture.model,
          nonBootstrapCensus: fixture.nonBootstrapCensus,
          measuredOneFewerUnitFloor: derivedFloor(),
        }),
      );
      return retainedEnrollment;
    }

    /**
     * The current manifest and census under the accepted model's timing and
     * ceilings with unmistakably synthetic provenance, which the declared floor
     * does not bind, and the model's own minimum is the shipped three units.
     */
    function naturallyMinimalDefaultPathEnrollment() {
      const scheduleModel = {
        ...bootstrapDbScheduleModel,
        ...syntheticScheduleModelProvenance,
        executionUnitFixedCostMs: 0,
      };
      naturallyMinimalEnrollment ??= defaultPathEnrollment(3, {
        scheduleModel,
        nonBootstrapCensus: {
          ...platformApiNonBootstrapDbCensus,
          referenceRunId: scheduleModel.referenceRunId,
          referenceJobId: scheduleModel.referenceJobId,
        },
      });
      return naturallyMinimalEnrollment;
    }

    function withFloorVerdict(
      enrollment: DefaultPathEnrollment,
      verdict: DefaultPathEnrollment["result"]["schedule"]["measuredOneFewerUnitFloor"],
    ): DefaultPathEnrollment {
      const { result } = enrollment;
      return {
        ...enrollment,
        result: { ...result, schedule: { ...result.schedule, measuredOneFewerUnitFloor: verdict } },
      };
    }

    it("holds the default-path floor role on a naturally minimal enrollment the declared floor does not bind", () => {
      const enrollment = naturallyMinimalDefaultPathEnrollment();
      expect(enrollment.model).toMatchObject(syntheticScheduleModelProvenance);
      expect(enrollment.result.schedule.measuredOneFewerUnitFloor).toEqual({
        applied: false,
        reason: declaredFloorUnbound,
      });
      expect(enrollment.result.schedule.minimumUnitCount).toBe(3);
      expect(
        enrollment.result.schedule.units.every((unit) => unit.makespanMs <= enrollment.model.executionUnitCeilingMs),
      ).toBe(true);
      expect(enrollment.result.schedule.aggregateWithOverheadMs).toBeLessThanOrEqual(
        enrollment.model.aggregateCeilingMs,
      );
      expect(
        Math.max(...(enrollment.result.schedule.oneFewerUnit?.units ?? []).map((unit) => unit.makespanMs)),
      ).toBeGreaterThan(enrollment.model.executionUnitCeilingMs);
      expectDefaultPathFloorRole(enrollment);
      expectOneFewerUnitInfeasible(enrollment);
    });

    it("holds the default-path floor role on the retained enrollment the declared floor binds", async () => {
      const enrollment = await retainedDefaultPathEnrollment();
      expect(enrollment.result.schedule.measuredOneFewerUnitFloor).toEqual({
        applied: true,
        reason: expectedMeasuredFloorVerdict(enrollment.floor, enrollment.model).reason,
      });
      expect(enrollment.absent.violations).toEqual([minimalityViolation]);
      expectDefaultPathFloorRole(enrollment);
      expectOneFewerUnitInfeasible(enrollment);
    });

    it.each<
      [
        string,
        () => DefaultPathEnrollment | Promise<DefaultPathEnrollment>,
        (enrollment: DefaultPathEnrollment) => DefaultPathEnrollment,
        string,
      ]
    >([
      [
        "a bound floor that is not applied",
        retainedDefaultPathEnrollment,
        (enrollment) =>
          withFloorVerdict(enrollment, { ...enrollment.result.schedule.measuredOneFewerUnitFloor, applied: false }),
        "bound floor verdict",
      ],
      [
        "an unbound floor that is applied",
        naturallyMinimalDefaultPathEnrollment,
        (enrollment) =>
          withFloorVerdict(enrollment, { ...enrollment.result.schedule.measuredOneFewerUnitFloor, applied: true }),
        "unbound floor verdict",
      ],
      [
        "an unbound floor over a model minimum below the shipped count",
        retainedDefaultPathEnrollment,
        (enrollment) => ({ ...enrollment, floor: null }),
        "unbound floor minimum",
      ],
      [
        "a model minimum below the shipped count and no null-floor minimality violation",
        retainedDefaultPathEnrollment,
        (enrollment) => ({ ...enrollment, absent: { ...enrollment.absent, violations: [] } }),
        "null-floor violations",
      ],
      [
        "a minimal model and a null-floor violation",
        naturallyMinimalDefaultPathEnrollment,
        (enrollment) => ({ ...enrollment, absent: { ...enrollment.absent, violations: [minimalityViolation] } }),
        "null-floor violations",
      ],
      [
        "a bound floor verdict whose reason is not formatted from the declared floor",
        retainedDefaultPathEnrollment,
        (enrollment) => {
          const verdict = enrollment.result.schedule.measuredOneFewerUnitFloor;
          return withFloorVerdict(enrollment, { ...verdict, reason: `${verdict.reason}.` });
        },
        "bound floor verdict",
      ],
      [
        "an unbound floor verdict whose reason differs from the null declaration",
        naturallyMinimalDefaultPathEnrollment,
        (enrollment) => withFloorVerdict(enrollment, { applied: false, reason: `${noFloor}.` }),
        "unbound floor verdict",
      ],
      [
        "a pinned minimum the model does not report",
        naturallyMinimalDefaultPathEnrollment,
        (enrollment) => ({ ...enrollment, minimumUnitCount: enrollment.minimumUnitCount - 1 }),
        "pinned minimum",
      ],
      [
        "a null-floor run that differs beyond the floor role",
        naturallyMinimalDefaultPathEnrollment,
        (enrollment) => {
          const { absent } = enrollment;
          return { ...enrollment, absent: { ...absent, schedule: { ...absent.schedule, aggregateMs: 0 } } };
        },
        "null-floor counterfactual",
      ],
    ])("refuses a default-path floor role with %s", async (_name, base, vary, clause) => {
      const enrollment = await base();
      expect(() => expectDefaultPathFloorRole(enrollment)).not.toThrow();
      expect(() => expectDefaultPathFloorRole(vary(enrollment))).toThrow(new RegExp(`^${clause}: `));
    });
  });
});

describe("bootstrap DB evidence", () => {
  const syntheticHead = "0000000000000000000000000000000000007993";
  const syntheticMerge = "0000000000000000000000000000000000007994";
  const syntheticBase = "0000000000000000000000000000000000007992";
  const syntheticHash = "a".repeat(64);
  const unit = "test:db:1";
  const file = "synthetic-evidence.db.test.ts";
  const manifest = {
    [file]: {
      executionUnit: unit,
      sourceSha256: syntheticHash,
      cases: [{ name: "synthetic case", identity: "synthetic-identity" }],
    },
  };
  const validator = () =>
    import(pathToFileURL(join(testDirectory, "../scripts/validate-bootstrap-db-evidence.mjs")).href);

  async function fixture(merge = false) {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-db-evidence-"));
    temporaryRoots.push(directory);
    const start: Record<string, unknown> = {
      kind: "runStart",
      unit,
      startedAt: "2026-01-01T00:00:01.000Z",
      pid: 1,
      node: "synthetic-node",
      checkoutSha: merge ? syntheticMerge : syntheticHead,
      githubSha: merge ? syntheticMerge : syntheticHead,
      event: merge ? "pull_request" : "push",
      eventHeadSha: merge ? syntheticHead : null,
      headParents: [merge ? syntheticMerge : syntheticHead],
      rawParents: [syntheticBase, syntheticHead],
      runId: "synthetic-run",
      runAttempt: "1",
      job: "synthetic-job",
    };
    const module: Record<string, unknown> = {
      kind: "module",
      file,
      sourceSha256: syntheticHash,
      identities: [{ name: "synthetic case", identity: "synthetic-identity" }],
      state: "passed",
      diagnostic: { duration: 500 },
      errors: [],
      cases: [
        {
          name: "synthetic case",
          fullName: "synthetic suite > synthetic case",
          result: { state: "passed" },
          diagnostic: { duration: 400 },
          durationMs: 400,
        },
      ],
    };
    const end: Record<string, unknown> = {
      kind: "runEnd",
      finishedAt: "2026-01-01T00:00:02.000Z",
      wallMs: 1000,
      moduleCount: 1,
      errors: [],
      reason: "passed",
    };
    const rows = [start, module, end];
    const path = join(directory, "test-db-1.jsonl");
    const write = () => writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await write();
    return { directory, path, start, module, end, rows, write };
  }

  it("keeps the guard prefix and both reporters on every numbered DB script", () => {
    const { scripts } = JSON.parse(readFileSync(join(testDirectory, "../package.json"), "utf8"));
    const units = Object.keys(scripts).filter((name) => /^test:db:\d+$/.test(name));
    expect(units).toEqual(["test:db:1", "test:db:2", "test:db:3"]);
    for (const name of units) {
      expect(scripts[name]).toMatch(/^node \.\/scripts\/check-bootstrap-db-enrollment\.mjs && vitest run /);
      expect(scripts[name]).toContain(
        "--maxWorkers=3 --reporter=default --reporter=./scripts/bootstrap-db-evidence-reporter.mjs",
      );
    }
  });

  it("refuses empty evidence even with an empty manifest override", async () => {
    const data = await fixture();
    await rm(data.path);
    const { validateBootstrapDbEvidence } = await validator();
    expect(
      validateBootstrapDbEvidence({ directory: data.directory, manifest: {}, expectedHead: syntheticHead }),
    ).toMatchObject({ valid: false });
  });

  it.each([false, true])(
    "binds complete synthetic push/PR evidence (merge=%s), including shallow parents",
    async (merge) => {
      const data = await fixture(merge);
      const { validateBootstrapDbEvidence } = await validator();
      expect(
        validateBootstrapDbEvidence({ directory: data.directory, manifest, expectedHead: syntheticHead }),
      ).toMatchObject({ valid: true, violations: [] });
    },
  );

  const corruptions: [string, (data: Awaited<ReturnType<typeof fixture>>) => void][] = [
    [
      "missing runStart",
      (data) => {
        data.rows.shift();
      },
    ],
    [
      "duplicate runStart",
      (data) => {
        data.rows.splice(1, 0, data.start);
      },
    ],
    [
      "missing unit identity",
      (data) => {
        delete data.start.unit;
      },
    ],
    [
      "unknown unit identity",
      (data) => {
        data.start.unit = "test:db:99";
      },
    ],
    [
      "missing checkoutSha",
      (data) => {
        delete data.start.checkoutSha;
      },
    ],
    [
      "missing rawParents",
      (data) => {
        delete data.start.rawParents;
      },
    ],
    [
      "wrong second parent",
      (data) => {
        data.start.rawParents = [syntheticHead, syntheticBase];
      },
    ],
    [
      "missing eventHeadSha",
      (data) => {
        delete data.start.eventHeadSha;
      },
    ],
    [
      "wrong eventHeadSha",
      (data) => {
        data.start.eventHeadSha = syntheticBase;
      },
    ],
    [
      "single parent",
      (data) => {
        data.start.rawParents = [syntheticHead];
      },
    ],
    [
      "checkout differs from GITHUB_SHA",
      (data) => {
        data.start.githubSha = syntheticBase;
      },
    ],
    [
      "push with another checkout",
      (data) => {
        data.start.event = "push";
      },
    ],
    [
      "missing wallMs",
      (data) => {
        delete data.end.wallMs;
      },
    ],
    [
      "missing finishedAt",
      (data) => {
        delete data.end.finishedAt;
      },
    ],
    [
      "negative wall",
      (data) => {
        data.end.wallMs = -1;
      },
    ],
    [
      "inconsistent wall",
      (data) => {
        data.end.wallMs = 50;
      },
    ],
    [
      "missing runEnd",
      (data) => {
        data.rows.pop();
      },
    ],
    [
      "missing module",
      (data) => {
        data.rows.splice(1, 1);
        data.end.moduleCount = 0;
      },
    ],
    [
      "unknown module",
      (data) => {
        data.module.file = "unmanifested-connector.db.test.ts";
      },
    ],
    [
      "duplicate module",
      (data) => {
        data.rows.splice(1, 0, data.module);
        data.end.moduleCount = 2;
      },
    ],
    [
      "case count differs",
      (data) => {
        data.module.cases = [];
      },
    ],
    [
      "sourceSha256 mismatch",
      (data) => {
        data.module.sourceSha256 = "b".repeat(64);
      },
    ],
    [
      "case identity changed",
      (data) => {
        data.module.identities = [{ name: "synthetic case", identity: "changed" }];
      },
    ],
    [
      "failed run",
      (data) => {
        data.end.reason = "failed";
      },
    ],
    [
      "unhandled run errors",
      (data) => {
        data.end.errors = [{ message: "synthetic error" }];
      },
    ],
    [
      "module count differs",
      (data) => {
        data.end.moduleCount = 2;
      },
    ],
    [
      "failed module",
      (data) => {
        data.module.state = "failed";
      },
    ],
    [
      "module errors",
      (data) => {
        data.module.errors = [{ message: "synthetic error" }];
      },
    ],
    [
      "missing module duration",
      (data) => {
        data.module.diagnostic = {};
      },
    ],
    [
      "skipped case",
      (data) => {
        data.module.cases = [
          {
            name: "synthetic case",
            fullName: "synthetic case",
            result: { state: "skipped" },
            diagnostic: { duration: 0 },
            durationMs: 0,
          },
        ];
      },
    ],
    [
      "failed case",
      (data) => {
        data.module.cases = [
          {
            name: "synthetic case",
            fullName: "synthetic case",
            result: { state: "failed" },
            diagnostic: { duration: 400 },
            durationMs: 400,
          },
        ];
      },
    ],
    [
      "unknown row",
      (data) => {
        data.rows.splice(1, 0, { kind: "unexpected" });
      },
    ],
  ];
  it.each(corruptions)("refuses %s", async (_name, corrupt) => {
    const data = await fixture(true);
    corrupt(data);
    await data.write();
    const { validateBootstrapDbEvidence } = await validator();
    const result = validateBootstrapDbEvidence({ directory: data.directory, manifest, expectedHead: syntheticHead });
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it.each(["missing directory", "missing unit file", "unknown unit file", "malformed line", "null row"])(
    "refuses %s",
    async (kind) => {
      const data = await fixture();
      if (kind === "missing unit file") await rm(data.path);
      if (kind === "unknown unit file") await writeFile(join(data.directory, "test-db-99.jsonl"), "{}\n");
      if (kind === "malformed line") await writeFile(data.path, "{\n");
      if (kind === "null row") await writeFile(data.path, "null\n");
      const { validateBootstrapDbEvidence } = await validator();
      expect(
        validateBootstrapDbEvidence({
          directory: kind === "missing directory" ? join(data.directory, "absent") : data.directory,
          manifest,
          expectedHead: syntheticHead,
        }).valid,
      ).toBe(false);
    },
  );

  const workspace = "@chase-sets/app-platform-api";
  const lines = [
    `2026-01-01T00:00:00.000Z Running test:db:1 in ${workspace}...`,
    `2026-01-01T00:00:02.000Z [${workspace}] first unit done`,
    "2026-01-01T00:00:03.000Z [@chase-sets/pricing] other workspace",
    `2026-01-01T00:00:04.000Z Running test:db:2 in ${workspace}...`,
    `2026-01-01T00:00:06.000Z [${workspace}] second unit done`,
    "2026-01-01T00:00:09.000Z [@chase-sets/pricing] longer tail",
    "2026-01-01T00:00:10.000Z step ended",
  ];
  const runEnds = { "test:db:1": "2026-01-01T00:00:02.000Z", "test:db:2": "2026-01-01T00:00:06.000Z" };
  it("derives workspace-only unit walls without billing another workspace or step tail", async () => {
    const { deriveUnitWallsFromStepLog } = await validator();
    expect(deriveUnitWallsFromStepLog({ lines, workspace, units: Object.keys(runEnds), runEnds })).toEqual([
      {
        unit: "test:db:1",
        runningAt: Date.parse("2026-01-01T00:00:00Z"),
        lastPrefixedAt: Date.parse("2026-01-01T00:00:02Z"),
        endAt: Date.parse("2026-01-01T00:00:02Z"),
        wallMs: 2000,
      },
      {
        unit: "test:db:2",
        runningAt: Date.parse("2026-01-01T00:00:04Z"),
        lastPrefixedAt: Date.parse("2026-01-01T00:00:06Z"),
        endAt: Date.parse("2026-01-01T00:00:06Z"),
        wallMs: 2000,
      },
    ]);
  });
  it("uses a later reporter end for the last or aborted unit", async () => {
    const { deriveUnitWallsFromStepLog } = await validator();
    expect(
      deriveUnitWallsFromStepLog({
        lines: lines.slice(0, 3),
        workspace,
        units: [unit],
        runEnds: { [unit]: "2026-01-01T00:00:03.000Z" },
      })[0].wallMs,
    ).toBe(3000);
  });
  it.each(["missing", "duplicate"])("refuses a %s Running line", async (kind) => {
    const { deriveUnitWallsFromStepLog } = await validator();
    expect(() =>
      deriveUnitWallsFromStepLog({
        lines: kind === "missing" ? lines.slice(1) : [lines[0], ...lines],
        workspace,
        units: Object.keys(runEnds),
        runEnds,
      }),
    ).toThrow(/missing or duplicate Running/);
  });

  it("reporter refuses an unidentified unit and preserves incremental failure rows", async () => {
    const { default: Reporter } = await import(
      pathToFileURL(join(testDirectory, "../scripts/bootstrap-db-evidence-reporter.mjs")).href
    );
    const data = await fixture();
    const sourcePath = join(data.directory, file);
    await writeFile(sourcePath, 'it("synthetic case", () => {});');
    try {
      vi.stubEnv("BOOTSTRAP_DB_EVIDENCE_UNIT", "invalid");
      expect(() => new Reporter()).toThrow(/numbered test:db unit/);
      vi.stubEnv("BOOTSTRAP_DB_EVIDENCE_UNIT", unit);
      vi.stubEnv("GITHUB_EVENT_PATH", "");
      const reporter = new Reporter();
      reporter.output = data.path;
      reporter.onTestRunStart();
      const startRows = (await readFile(data.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(startRows).toHaveLength(1);
      expect(startRows[0]).toMatchObject({ kind: "runStart", unit });
      expect(startRows[0].rawParents).toBeInstanceOf(Array);
      const module = {
        moduleId: sourcePath,
        state: () => "failed",
        diagnostic: () => ({ duration: 20 }),
        errors: () => [{ message: "synthetic failure" }],
        children: {
          allTests: () => [
            {
              name: "synthetic case",
              fullName: "synthetic case",
              result: () => ({ state: "failed" }),
              diagnostic: () => ({ duration: 10 }),
            },
          ],
        },
      };
      reporter.onTestModuleEnd(module);
      expect((await readFile(data.path, "utf8")).trim().split("\n")).toHaveLength(2);
      reporter.onTestRunEnd([module], [], "failed");
      const rows = (await readFile(data.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toHaveLength(3);
      expect(rows[1]).toMatchObject({
        kind: "module",
        state: "failed",
        cases: [{ durationMs: 10, result: { state: "failed" } }],
      });
      expect(rows[1].sourceSha256).toBe(
        createHash("sha256")
          .update(await readFile(sourcePath))
          .digest("hex"),
      );
      expect(rows[2]).toMatchObject({ kind: "runEnd", reason: "failed", moduleCount: 1 });
      expect(rows[2].wallMs).toBe(Date.parse(rows[2].finishedAt) - Date.parse(rows[0].startedAt));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function sourceFileOf(source: string) {
  return ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function caseCallExpressions(source: string) {
  const sourceFile = sourceFileOf(source);
  const found: { node: ts.CallExpression; name: string }[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "it" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ node, name: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { sourceFile, found };
}

function extractCaseDeclaration(source: string, caseName: string): string {
  const { sourceFile, found } = caseCallExpressions(source);
  const match = found.find((entry) => entry.name === caseName);
  if (!match) throw new Error(`fixture has no case named ${caseName}`);
  const statement = match.node.parent;
  return source.slice(statement.getStart(sourceFile), statement.getEnd());
}

function caseDeclarationsOf(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const { sourceFile, found } = caseCallExpressions(source);
  return found.map((entry) => source.slice(entry.node.parent.getStart(sourceFile), entry.node.parent.getEnd()));
}

function catalogDeclarationDigests(source: string): Record<string, string> {
  const parsed = sourceFileOf(source);
  const printer = ts.createPrinter({ removeComments: true });
  return Object.fromEntries(
    parsed.statements.flatMap((statement) => {
      const name =
        ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
          ? statement.name?.text
          : ts.isVariableStatement(statement)
            ? statement.declarationList.declarations[0]?.name.getText(parsed)
            : undefined;
      if (!name) return [];
      const text = printer.printNode(ts.EmitHint.Unspecified, statement, parsed).replace(/^export /u, "");
      return [[name, createHash("sha256").update(text).digest("hex")]];
    }),
  );
}

function catalogHarnessDeclarations(source: string): string[] {
  const parsed = sourceFileOf(source);
  function shape(node: ts.Node): unknown {
    const children: unknown[] = [];
    ts.forEachChild(node, (child) => {
      children.push(shape(child));
    });
    return [node.kind, ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null, children];
  }
  return parsed.statements
    .filter(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        statement.expression.expression.getText(parsed) === "createPlatformApiBootstrapTestHarness",
    )
    .map((statement) => JSON.stringify(shape(statement)));
}
