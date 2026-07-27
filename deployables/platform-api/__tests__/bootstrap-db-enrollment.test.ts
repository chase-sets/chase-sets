import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapDbEnrollmentManifest,
  checkBootstrapDbEnrollment,
} from "../scripts/check-bootstrap-db-enrollment.mjs";

const temporaryRoots: string[] = [];

async function createFixture(transform: (sources: Map<string, string>) => void = () => undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "platform-api-bootstrap-enrollment-"));
  temporaryRoots.push(root);
  const testDirectory = join(root, "__tests__");
  await mkdir(testDirectory);

  const sources = new Map<string, string>();
  for (const [fileName, partition] of Object.entries(bootstrapDbEnrollmentManifest)) {
    const cases = partition.cases.map((caseName) => `it(${JSON.stringify(caseName)}, () => undefined);`).join("\n");
    sources.set(
      fileName,
      [
        'import { it } from "vitest";',
        'import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";',
        `createPlatformApiBootstrapTestHarness(${JSON.stringify(partition.databaseSuffix)});`,
        cases,
      ].join("\n"),
    );
  }
  sources.set(
    "bootstrap-db-test-support.ts",
    "export function createPlatformApiBootstrapTestHarness(_suffix: string): void {}",
  );

  transform(sources);
  await Promise.all([...sources].map(([fileName, source]) => writeFile(join(testDirectory, fileName), source)));
  const partitionFiles = Object.keys(bootstrapDbEnrollmentManifest);
  const excludeArguments = partitionFiles.map((fileName) => `--exclude __tests__/${fileName}`).join(" ");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "test:fast": `vitest run ${excludeArguments}`,
        "test:unit": `vitest run ${excludeArguments}`,
        "test:db:1": `vitest run ${partitionFiles
          .slice(0, Math.ceil(partitionFiles.length / 2))
          .map((fileName) => `__tests__/${fileName}`)
          .join(" ")}`,
        "test:db:2": `vitest run ${partitionFiles
          .slice(Math.ceil(partitionFiles.length / 2))
          .map((fileName) => `__tests__/${fileName}`)
          .join(" ")}`,
      },
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Platform API bootstrap DB enrollment", () => {
  it("enrolls the repository's exact case-to-file and database-suffix manifest", () => {
    const result = checkBootstrapDbEnrollment();

    expect(result.violations).toEqual([]);
    expect(result.expectedCaseCount).toBe(48);
    expect(result.caseCount).toBe(result.expectedCaseCount);
  });

  it.each([
    [
      "deletion",
      (source: string, caseName: string) => source.replace(`it(${JSON.stringify(caseName)}, () => undefined);`, ""),
    ],
    [
      "duplication",
      (source: string, caseName: string) => `${source}\nit(${JSON.stringify(caseName)}, () => undefined);`,
    ],
    ["unexpected case", (source: string) => `${source}\nit("unmanifested bootstrap behavior", () => undefined);`],
  ])("rejects case %s", async (_label, mutate) => {
    const [firstFile, firstPartition] = Object.entries(bootstrapDbEnrollmentManifest)[0]!;
    const root = await createFixture((sources) => {
      sources.set(firstFile, mutate(sources.get(firstFile)!, firstPartition.cases[0]!));
    });

    expect(checkBootstrapDbEnrollment({ platformApiRoot: root }).violations).not.toEqual([]);
  });

  it("rejects a mapped case routed to the wrong partition", async () => {
    const entries = Object.entries(bootstrapDbEnrollmentManifest);
    const [sourceFile, sourcePartition] = entries[0]!;
    const [targetFile] = entries[1]!;
    const caseName = sourcePartition.cases[0]!;
    const declaration = `it(${JSON.stringify(caseName)}, () => undefined);`;
    const root = await createFixture((sources) => {
      sources.set(sourceFile, sources.get(sourceFile)!.replace(declaration, ""));
      sources.set(targetFile, `${sources.get(targetFile)!}\n${declaration}`);
    });

    expect(checkBootstrapDbEnrollment({ platformApiRoot: root }).violations).toEqual(
      expect.arrayContaining([expect.stringContaining(`belongs in ${sourceFile}, not ${targetFile}`)]),
    );
  });

  it.each(["omitted", "duplicated"])("rejects a DB file %s across package-script partitions", async (mutation) => {
    const root = await createFixture();
    const packageJsonPath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const fileName = Object.keys(bootstrapDbEnrollmentManifest)[0]!;
    if (mutation === "omitted") {
      packageJson.scripts["test:db:1"] = packageJson.scripts["test:db:1"].replace(`__tests__/${fileName}`, "");
    } else {
      packageJson.scripts["test:db:2"] += ` __tests__/${fileName}`;
    }
    await writeFile(packageJsonPath, JSON.stringify(packageJson));

    expect(checkBootstrapDbEnrollment({ platformApiRoot: root }).violations).toEqual(
      expect.arrayContaining([expect.stringContaining(fileName)]),
    );
  });

  it.each(["test:unit", "test:fast"])("rejects a DB file missing from the %s exclude list", async (scriptName) => {
    const root = await createFixture();
    const packageJsonPath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const fileName = Object.keys(bootstrapDbEnrollmentManifest)[0]!;
    packageJson.scripts[scriptName] = packageJson.scripts[scriptName].replace(`--exclude __tests__/${fileName}`, "");
    await writeFile(packageJsonPath, JSON.stringify(packageJson));

    expect(checkBootstrapDbEnrollment({ platformApiRoot: root }).violations).toEqual(
      expect.arrayContaining([expect.stringContaining(`${scriptName} must exclude __tests__/${fileName}`)]),
    );
  });

  it.each([
    ["method listener", 'const server = { listen(_port: number) {} }; server["listen"](6182);'],
    ["serve import alias", 'import { serve as startHttp } from "http-runtime"; startHttp({ port: 6182 });'],
    ["destructured serve alias", "const { serve: startHttp } = { serve() {} }; startHttp();"],
  ])("rejects a %s start in partition-local support", async (_label, listenerSource) => {
    const root = await createFixture((sources) => {
      sources.set("bootstrap-db-test-support.ts", `${sources.get("bootstrap-db-test-support.ts")!}\n${listenerSource}`);
    });

    expect(checkBootstrapDbEnrollment({ platformApiRoot: root }).violations).toEqual(
      expect.arrayContaining([expect.stringContaining("listener start")]),
    );
  });

  it("rejects an incorrect or duplicated database suffix declaration", async () => {
    const [firstFile, firstPartition] = Object.entries(bootstrapDbEnrollmentManifest)[0]!;
    const declaration = `createPlatformApiBootstrapTestHarness(${JSON.stringify(firstPartition.databaseSuffix)});`;
    const root = await createFixture((sources) => {
      sources.set(
        firstFile,
        sources
          .get(firstFile)!
          .replace(declaration, 'createPlatformApiBootstrapTestHarness("wrong_suffix");\n' + declaration),
      );
    });

    expect(checkBootstrapDbEnrollment({ platformApiRoot: root }).violations).toEqual(
      expect.arrayContaining([expect.stringContaining("must declare exactly one bootstrap database suffix")]),
    );
  });
});
