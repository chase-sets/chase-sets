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
type Fixture = Readonly<{
  root: string;
  manifest: FixtureManifest;
  ceilings: Record<string, number>;
  model: BootstrapDbScheduleModel;
}>;

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
    model?: Partial<BootstrapDbScheduleModel>;
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
  const model: BootstrapDbScheduleModel = { ...bootstrapDbScheduleModel, ...options.model };

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

function singleWorkerModel(): Partial<BootstrapDbScheduleModel> {
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
