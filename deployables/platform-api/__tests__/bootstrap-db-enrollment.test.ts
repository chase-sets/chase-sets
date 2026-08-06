import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  maximumScheduledFileCount: 10,
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

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Platform API bootstrap DB enrollment", () => {
  it("enrolls the repository's exact case-to-file and database-suffix manifest", () => {
    const result = checkBootstrapDbEnrollment();

    expect(result.violations).toEqual([]);
    expect(result.expectedCaseCount).toBe(54);
    expect(result.caseCount).toBe(result.expectedCaseCount);
    expect(result.fileCount).toBe(8);
    expect(result.partitionUnitCount).toBe(2);
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
    if (mutation === "omitted") {
      packageJson.scripts["test:db:2"] = packageJson.scripts["test:db:2"].replace(`__tests__/${fileName}`, "");
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
    const authoritativeCases = Object.entries(bootstrapDbEnrollmentManifest)
      .filter(([fileName]) => fileName.startsWith("authoritative-seed-resume-"))
      .flatMap(([, partition]) => partition.cases);
    const casesOf = (fileName: string) => bootstrapDbEnrollmentManifest[fileName]!.cases;
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

  it("declares the settled ceilings and job overhead the aggregate expression is built from", () => {
    expect(bootstrapDbScheduleModel.executionUnitCeilingMs).toBe(420_000);
    expect(bootstrapDbScheduleModel.aggregateCeilingMs).toBe(1_080_000);
    expect(bootstrapDbScheduleModel.jobOverheadMs).toBe(48_000);
    expect(bootstrapDbScheduleModel.maxWorkersPerExecutionUnit).toBe(3);
    expect(checkBootstrapDbEnrollment().schedule.files.reduce((total, file) => total + file.caseDurationMs, 0)).toBe(
      1_247_190,
    );
  });

  // -- schedule-model shape ------------------------------------------------

  it("projects the shipped units, aggregate, and minimum unit count under the closed model", () => {
    const { schedule } = checkBootstrapDbEnrollment();

    expect(schedule.units.map((unit) => [unit.scriptName, unit.makespanMs])).toEqual([
      ["test:db:1", 332_988],
      ["test:db:2", 289_399],
    ]);
    expect(schedule.aggregateMs).toBe(622_387);
    expect(schedule.aggregateWithOverheadMs).toBe(670_387);
    expect(schedule.minimumUnitCount).toBe(2);
    expect(schedule.observedUnitCount).toBe(2);
  });

  it("accepts the shipped schedule model as a null-prototype plain record", () => {
    const nullPrototypeModel = Object.assign(Object.create(null), bootstrapDbScheduleModel);
    const result = checkBootstrapDbEnrollment({ scheduleModel: nullPrototypeModel });

    expect(Object.getPrototypeOf(nullPrototypeModel)).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.schedule.units.map((unit) => [unit.scriptName, unit.makespanMs])).toEqual([
      ["test:db:1", 332_988],
      ["test:db:2", 289_399],
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
      maximumScheduledFileCount: 11,
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
      { maximumEnumeratedUnitCount: 11 },
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
    expect(worst).toBeGreaterThan(bootstrapDbScheduleModel.executionUnitCeilingMs);
  });

  it("rejects an extra execution unit that satisfies every other invariant", async () => {
    // The shipped file set redistributed over three units: every unit stays
    // under 420s, the aggregate stays under 1080s, every case keeps its name,
    // file, database suffix, and identity — only the unit count is wasteful.
    const extraUnitAssignment: Record<string, string> = {
      "authoritative-seed-resume-core.db.test.ts": "test:db:1",
      "authoritative-seed-resume-reconciliation.db.test.ts": "test:db:1",
      "catalog-seed-aggregate-state.db.test.ts": "test:db:1",
      "bootstrap-production-reconciliation.db.test.ts": "test:db:2",
      "authoritative-seed-resume-recovery.db.test.ts": "test:db:2",
      "inventory-seed-resume.db.test.ts": "test:db:2",
      "bootstrap-scenario.db.test.ts": "test:db:3",
      "bootstrap-lock-contention.db.test.ts": "test:db:3",
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
      ceilings: { "test:db:1": 25, "test:db:2": 27, "test:db:3": 0 },
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
    const fixture = await createFixture(files, { model: singleWorkerModel() });

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

  // -- boot-bearing ceilings ------------------------------------------------

  it("rejects an execution unit pushed past its declared boot-bearing ceiling", async () => {
    const files = shippedShapedFiles();
    const largest = "test:db:2";
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
        `test:db:2 has 28 boot-bearing cases, exceeding its declared ceiling of ${bootstrapDbExecutionUnitBootBearingCaseCeilings["test:db:2"]}`,
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
