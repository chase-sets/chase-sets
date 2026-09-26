import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapDbEnrollmentManifest,
  bootstrapDbExecutionUnitBootBearingCaseCeilings,
  bootstrapDbScheduleModel,
  checkBootstrapDbEnrollment,
  deriveBootstrapDbCaseIdentities,
  type BootstrapDbEnrollmentPartition,
  type BootstrapDbScheduleModel,
} from "../scripts/check-bootstrap-db-enrollment.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));

const temporaryRoots: string[] = [];

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
 * derived from the fixture's own parsed sources in a first pass and frozen into
 * the fixture manifest in a second, which is exactly how the shipped manifest
 * was produced.
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

  const draftManifest = buildManifest(files, () => "0000000000000000");
  const derived = checkBootstrapDbEnrollment({
    platformApiRoot: root,
    manifest: draftManifest,
    executionUnitBootBearingCaseCeilings: ceilings,
    scheduleModel: model,
  }).caseIdentities;

  return { root, manifest: buildManifest(files, (name) => derived[name] ?? "0000000000000000"), ceilings, model };
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
  });
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
  computeMinimumUnitCount: (files: ScheduleFile[], model: BootstrapDbScheduleModel) => unknown;
  bestAssignmentAt: (files: ScheduleFile[], count: number, model: BootstrapDbScheduleModel) => unknown;
  calculateMinimumAndOneFewer?: (
    files: ScheduleFile[],
    model: BootstrapDbScheduleModel,
    observe?: (phase: string, count: number, assignment: number[]) => void,
  ) => unknown;
  canonicalAssignments: (length: number, count: number) => Generator<number[]>;
};

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
      `${source.slice(start, end)}\n({ computeMinimumUnitCount, bestAssignmentAt, canonicalAssignments, calculateMinimumAndOneFewer: typeof calculateMinimumAndOneFewer === 'function' ? calculateMinimumAndOneFewer : undefined })`,
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
  return JSON.stringify({
    minimum,
    aggregateWithOverheadMs: minimum.witness
      ? minimum.witness.reduce((sum, unit) => sum + unit.makespanMs, model.jobOverheadMs)
      : null,
    oneFewerUnit,
    alternatives,
  });
}

function expectSharedScheduleEquivalence(
  old: ScheduleProbe,
  candidate: ScheduleProbe,
  files: ScheduleFile[],
  model: BootstrapDbScheduleModel,
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
  const expectedMinimum = old.computeMinimumUnitCount(files, model) as typeof minimum;
  const expectedOneFewer =
    expectedMinimum.minimumUnitCount && expectedMinimum.minimumUnitCount > 1
      ? old.bestAssignmentAt(files, expectedMinimum.minimumUnitCount - 1, model)
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

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Platform API bootstrap DB enrollment", () => {
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
                    if (actual !== expected)
                      throw new Error(`schedule differs at pair ${pairs}: ${expected} vs ${actual}`);
                    expectSharedScheduleEquivalence(old, candidate, files, model);
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
      expect(scheduleVerdict(candidate, files, model)).toBe(scheduleVerdict(old, files, model));
      expectSharedScheduleEquivalence(old, candidate, files, model);
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
      expect(scheduleVerdict(candidate, boundaryFiles, boundaryModel)).toBe(
        scheduleVerdict(old, boundaryFiles, boundaryModel),
      );
      expectSharedScheduleEquivalence(old, candidate, boundaryFiles, boundaryModel);
    }
  });

  it("exact subset schedule equivalence for complete old and candidate guards", async () => {
    const oracleUrl = pathToFileURL(join(testDirectory, "fixtures/bootstrap-db-schedule-before-subset-reuse.mjs"));
    const old = await import(oracleUrl.href);
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
    // The pinned oracle lives under __tests__/fixtures, so its import.meta.url-derived
    // default root is __tests__; bind both guards to the one production platform-api root.
    const platformApiRoot = join(testDirectory, "..");
    expect(normalize(checkBootstrapDbEnrollment({ platformApiRoot }))).toEqual(
      normalize(old.checkBootstrapDbEnrollment({ platformApiRoot })),
    );
    for (const count of [10, 11, 12, 13]) {
      const files = Array.from({ length: count }, (_, index) => unitFileFor(`oracle-${index}`, "test:db:1", 1_000));
      const fixture = await createFixture(files, { model: { maximumScheduledFileCount: count === 13 ? 12 : 11 } });
      const options = {
        platformApiRoot: fixture.root,
        manifest: fixture.manifest,
        executionUnitBootBearingCaseCeilings: fixture.ceilings,
        scheduleModel: fixture.model,
      };
      expect(normalize(checkBootstrapDbEnrollment(options))).toEqual(
        normalize(old.checkBootstrapDbEnrollment(options)),
      );
    }
  });

  it("enrolls the repository's exact case-to-file and database-suffix manifest", () => {
    const result = checkBootstrapDbEnrollment();

    expect(result.violations).toEqual([]);
    expect(result.expectedCaseCount).toBe(57);
    expect(result.caseCount).toBe(result.expectedCaseCount);
    expect(result.fileCount).toBe(11);
    expect(result.partitionUnitCount).toBe(2);
  });

  it("preserves the complete frozen seed-command file and both separate case identities", () => {
    const fileName = "seed-command-full-pools.db.test.ts";
    const source = readFileSync(join(testDirectory, fileName));
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "21112a33cfbe069967b24c03321a5d35842519376128bae813836dbf4bf79bbe",
    );
    expect(deriveBootstrapDbCaseIdentities(fileName, source.toString()).map((testCase) => testCase.identity)).toEqual([
      "68dfd0998ec22c33",
      "9e7b99abfd2756ab",
    ]);
  });

  it.each([
    ["deletion", (source: string, caseName: string) => source.replace(extractCaseDeclaration(source, caseName), "")],
    ["duplication", (source: string, caseName: string) => `${source}\n${extractCaseDeclaration(source, caseName)}`],
    ["unexpected case", (source: string) => `${source}\nit("unmanifested bootstrap behavior", async () => {\n});`],
  ])("rejects case %s", async (_label, mutate) => {
    const files = shippedShapedFiles();
    const fixture = await createFixture(files);
    const target = files[0]!;
    const path = join(fixture.root, "__tests__", target.fileName);
    await writeFile(path, mutate(await readFile(path, "utf8"), target.cases[0]!.name));

    expect(runFixture(fixture).violations).not.toEqual([]);
  });

  it("names the case, its file, and its execution unit when a manifest case is dropped", async () => {
    const files = shippedShapedFiles();
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(shippedShapedFiles());
    const path = join(fixture.root, "__tests__", "bootstrap-db-test-support.ts");
    await writeFile(path, `${await readFile(path, "utf8")}\n${listenerSource}`);

    expect(runFixture(fixture).violations).toEqual(expect.arrayContaining([expect.stringContaining("listener start")]));
  });

  it("rejects an incorrect or duplicated database suffix declaration", async () => {
    const files = shippedShapedFiles();
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(shippedShapedFiles(), {
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
    const fixture = await createFixture(shippedShapedFiles(), {
      extraSources: {
        "plain-unit.test.ts": ['import { it } from "vitest";', 'it("needs no database", () => {});'].join("\n"),
      },
    });

    expect(runFixture(fixture).violations).toEqual([]);
  });

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

  it("never under-states the sole eleven-file measurement's two units or owning-job wall clock", async () => {
    expect(bootstrapDbScheduleModel.referenceRunId).toBe(36141162335);
    expect(bootstrapDbScheduleModel.referenceJobId).toBe(108091066485);
    expect(bootstrapDbScheduleModel.referenceJobName).toBe("Diagnostic API Bootstrap Measurement Only");
    expect(bootstrapDbScheduleModel.referenceHeadSha).toBe("83caeeed92c345a59abe2d1755e32e2c7bee2e39");
    expect(bootstrapDbScheduleModel.referenceEvent).toBe("push");
    expect(bootstrapDbScheduleModel.testFileFixedCostMs).toBe(1_593);
    expect(bootstrapDbScheduleModel.executionUnitFixedCostMs).toBe(18_576);
    const measuredUnitOne = new Set([
      "authoritative-seed-resume-core.db.test.ts",
      "authoritative-seed-resume-reconciliation.db.test.ts",
      "catalog-seed-interruption-resume.db.test.ts",
    ]);
    // The fixture keeps synthetic provenance; only its timing inputs reproduce
    // the complete, immutable measurement, never another run or local timing.
    const fixture = await createFixture(
      shippedShapedFiles().map((file) => ({
        ...file,
        executionUnit: measuredUnitOne.has(file.fileName) ? "test:db:1" : "test:db:2",
      })),
      {
        model: {
          testFileFixedCostMs: bootstrapDbScheduleModel.testFileFixedCostMs,
          executionUnitFixedCostMs: bootstrapDbScheduleModel.executionUnitFixedCostMs,
          jobOverheadMs: bootstrapDbScheduleModel.jobOverheadMs,
        },
      },
    );
    const { schedule } = runFixture(fixture);
    expect(schedule.units.map((unit) => unit.makespanMs)).toEqual([295_728, 449_242]);
    expect(schedule.units[0]!.makespanMs).toBeGreaterThanOrEqual(289_699.315844);
    expect(schedule.units[1]!.makespanMs).toBeGreaterThanOrEqual(367_435.189544);
    expect(schedule.aggregateWithOverheadMs).toBe(791_836);
    expect(schedule.aggregateWithOverheadMs).toBeGreaterThanOrEqual(704_000);
  });

  it("declares the settled ceilings and job overhead the aggregate expression is built from", () => {
    expect(bootstrapDbScheduleModel.executionUnitCeilingMs).toBe(420_000);
    expect(bootstrapDbScheduleModel.aggregateCeilingMs).toBe(1_080_000);
    expect(bootstrapDbScheduleModel.jobOverheadMs).toBe(46_866);
    expect(bootstrapDbScheduleModel.maxWorkersPerExecutionUnit).toBe(3);
    expect(checkBootstrapDbEnrollment().schedule.files.reduce((total, file) => total + file.caseDurationMs, 0)).toBe(
      1_666_557,
    );
  });

  // -- schedule-model shape ------------------------------------------------

  it("projects the shipped units, aggregate, and minimum unit count under the closed model", () => {
    const { schedule } = checkBootstrapDbEnrollment();

    expect(schedule.units.map((unit) => [unit.scriptName, unit.makespanMs])).toEqual([
      ["test:db:1", 408_909],
      ["test:db:2", 336_061],
    ]);
    expect(schedule.units.map((unit) => [unit.bootBearingCaseCount, unit.bootBearingCeiling])).toEqual([
      [38, 38],
      [17, 17],
    ]);
    expect(schedule.aggregateMs).toBe(744_970);
    expect(schedule.aggregateWithOverheadMs).toBe(791_836);
    expect(schedule.minimumUnitCount).toBe(2);
    expect(schedule.observedUnitCount).toBe(2);
  });

  it("accepts the shipped schedule model as a null-prototype plain record", () => {
    const nullPrototypeModel = Object.assign(Object.create(null), bootstrapDbScheduleModel);
    const result = checkBootstrapDbEnrollment({ scheduleModel: nullPrototypeModel });

    expect(Object.getPrototypeOf(nullPrototypeModel)).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.schedule.units.map((unit) => [unit.scriptName, unit.makespanMs])).toEqual([
      ["test:db:1", 408_909],
      ["test:db:2", 336_061],
    ]);
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
      maximumScheduledFileCount: 12,
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
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files);
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

  it("computes a minimumUnitCount of 2 for the shipped manifest and ships exactly that", () => {
    const { schedule } = checkBootstrapDbEnrollment();

    expect(schedule.minimumUnitCount).toBe(2);
    expect(schedule.observedUnitCount).toBe(2);
    for (const unit of schedule.units) {
      expect(unit.makespanMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.executionUnitCeilingMs);
    }
    expect(schedule.aggregateWithOverheadMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.aggregateCeilingMs);
  });

  it("shows a one-fewer-unit alternative whose binding unit is above the 420-second ceiling", () => {
    const { schedule } = checkBootstrapDbEnrollment();

    expect(schedule.oneFewerUnit?.unitCount).toBe(1);
    const worst = Math.max(...(schedule.oneFewerUnit?.units ?? []).map((unit) => unit.makespanMs));
    expect(worst).toBe(757_694);
    expect(worst).toBeGreaterThan(bootstrapDbScheduleModel.executionUnitCeilingMs);
  });

  it("rejects an extra execution unit that satisfies every other invariant", async () => {
    // A deliberately nonminimal three-unit grouping: every unit stays
    // under 420s, the aggregate stays under 1080s, every case keeps its name,
    // file, database suffix, and identity — only the unit count is wasteful.
    const extraUnitAssignment: Record<string, string> = {
      "authoritative-seed-resume-core.db.test.ts": "test:db:1",
      "authoritative-seed-resume-reconciliation.db.test.ts": "test:db:1",
      "catalog-seed-interruption-resume.db.test.ts": "test:db:1",
      "catalog-seed-aggregate-state.db.test.ts": "test:db:3",
      "authoritative-seed-resume-recovery.db.test.ts": "test:db:2",
      "inventory-seed-resume.db.test.ts": "test:db:3",
      "bootstrap-scenario.db.test.ts": "test:db:2",
      "bootstrap-production-reconciliation.db.test.ts": "test:db:2",
      "bootstrap-lock-contention.db.test.ts": "test:db:2",
      "bootstrap-shared-seed-command.db.test.ts": "test:db:3",
      "seed-command-full-pools.db.test.ts": "test:db:2",
    };
    const files = shippedShapedFiles().map((file) => ({
      ...file,
      executionUnit: extraUnitAssignment[file.fileName]!,
    }));
    const fixture = await createFixture(files);
    const result = runFixture(fixture);

    for (const unit of result.schedule.units) {
      expect(unit.makespanMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.executionUnitCeilingMs);
    }
    expect(result.schedule.aggregateWithOverheadMs).toBeLessThanOrEqual(bootstrapDbScheduleModel.aggregateCeilingMs);
    expect(result.violations).toEqual([
      "the shipped topology spends 3 execution units where the schedule model's minimumUnitCount for the same " +
        "file set is 2; execution units of one workspace run serially, so an unnecessary unit is spent aggregate " +
        "budget",
    ]);
  });

  it("fails naming a numbered unit hosted CI executes that owns no manifested DB file", async () => {
    // The hidden unit is a real `test:db:3` script the `test:db*` selector runs.
    // It stands its own job up, so it has to own manifested executable entries
    // and be carried by the makespan, aggregate, and minimum-unit comparison.
    const fixture = await createFixture(shippedShapedFiles(), {
      ceilings: { ...bootstrapDbExecutionUnitBootBearingCaseCeilings, "test:db:3": 0 },
      extraSources: {
        "plain-unit.test.ts": ['import { it } from "vitest";', 'it("needs no database", () => {});'].join("\n"),
      },
      mutatePackageJson: (packageJson) => {
        packageJson.scripts["test:db:3"] = "vitest run __tests__/plain-unit.test.ts --maxWorkers=3";
      },
    });
    const result = runFixture(fixture);

    expect(result.partitionUnitCount).toBe(3);
    expect(result.schedule.observedUnitCount).toBe(3);
    expect(result.violations).toEqual([
      "test:db:3 is executed by hosted CI but owns no manifested bootstrap DB file; every numbered execution " +
        "unit must own manifested executable DB entries",
      "the shipped topology spends 3 execution units where the schedule model's minimumUnitCount for the same " +
        "file set is 2; execution units of one workspace run serially, so an unnecessary unit is spent aggregate " +
        "budget",
    ]);
  });

  it("rejects a selector-matching execution unit whose name is not numbered", async () => {
    const fixture = await createFixture(shippedShapedFiles(), {
      extraSources: {
        "plain-unit.test.ts": ['import { it } from "vitest";', 'it("needs no database", () => {});'].join("\n"),
      },
      mutatePackageJson: (packageJson) => {
        packageJson.scripts["test:db:extra"] = "vitest run __tests__/plain-unit.test.ts --maxWorkers=3";
      },
    });

    expect(runFixture(fixture).violations).toEqual([
      "test:db:extra is selected and executed by the test:db* workspace selector but is not a numbered " +
        "test:db:<number> execution unit, so its cost is never scheduled",
    ]);
  });

  it("keeps the shipped two-unit topology exactly as hosted CI selects it", () => {
    const packageScripts = JSON.parse(readFileSync(join(testDirectory, "..", "package.json"), "utf8"))
      .scripts as Record<string, string>;
    const selected = Object.keys(packageScripts)
      .filter((name) => name.startsWith("test:db:") && typeof packageScripts[name] === "string")
      .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

    expect(selected).toEqual(["test:db:1", "test:db:2"]);
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
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files);
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
        identity: "f78d626bdd98a1c4",
      },
      {
        name: "does not re-author unchanged Product Measures facts on scenario-seed repeat",
        identity: "a0661cfb08a350b5",
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
    // AST digests captured from f8b1c5eb3a1efb51703ff9df61c0aa6554cf6ef7, excluding only export plumbing.
    const expectedHelpers = {
      CatalogServices: "a8e89b7f2c21b03bc9f44258e94d22397bd36823e944e9c8a3a7c8a5743e6872",
      InterruptionSite: "c4dadca6244573816136cb34ca52f186a2b47b8e32dcf3d6302940783a75d4b2",
      catalogApiContextRegistry: "18182c8373dbd2f5e45173269916afa76b01ff26fdabedeea967a79732cf656c",
      profileShapes: "3ac53db3762c52cfff690dc427bea3cdaa82f4b585095736995aab43c1ac00f6",
      databaseUrls: "14168e4de456370321f00dbba9697c134df3470f0fa860257723d60bd2282ff1",
      pools: "5260c751c5ee88b848ffa1899726fad225c3283d06d00721d9c04f5cc43de6f9",
      createCatalogSeedHost: "25c315bf2f227c021c59f158afaaea76469224c41997e0a9a92b22b9e51abe52",
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
    const assertion = sources[0]!.replace(".toBe(130)", ".toBe(131)");
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
    const largest = "test:db:1";
    const observed = bootstrapDbExecutionUnitBootBearingCaseCeilings[largest];
    const fixture = await createFixture(files, {
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
    const donor = files.find((file) => file.fileName === "authoritative-seed-resume-core.db.test.ts")!;
    const receiver = files.find((file) => file.fileName === "authoritative-seed-resume-recovery.db.test.ts")!;
    const moved = donor.cases.find(
      (testCase) => testCase.name === "does not re-author Settlement while its payout projection lags the stream",
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
    const fixture = await createFixture(relocated, {
      ceilings: bootstrapDbExecutionUnitBootBearingCaseCeilings,
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        `test:db:1 has 39 boot-bearing cases, exceeding its declared ceiling of ${bootstrapDbExecutionUnitBootBearingCaseCeilings["test:db:1"]}`,
      ]),
    );
  });

  it("rejects a boot-bearing classification that names an unknown case", async () => {
    const files = shippedShapedFiles();
    const fixture = await createFixture(files);
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
    const fixture = await createFixture(files, {
      ceilings: { "test:db:1": bootstrapDbExecutionUnitBootBearingCaseCeilings["test:db:1"] },
    });

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([expect.stringContaining("test:db:2 must declare a boot-bearing case ceiling")]),
    );
  });

  // -- fail-closed discovery inputs ----------------------------------------

  it("fails closed when the workspace vitest configuration cannot supply an include glob", async () => {
    const fixture = await createFixture(shippedShapedFiles());
    await rm(join(fixture.root, "vitest.config.ts"));

    expect(runFixture(fixture).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vitest.config.ts is required to derive the executable test-entry set"),
      ]),
    );
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
