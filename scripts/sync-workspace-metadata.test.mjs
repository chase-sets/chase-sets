import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import prettier from "prettier";
import {
  analyzeLocaleCatalogModule,
  assertNoLocaleCatalogKeyCollisions,
  listTrackedLocaleModulePaths,
  syncWorkspaceMetadata,
} from "./sync-workspace-metadata.mjs";
import { repoRoot } from "./lib/repo.mjs";

const tempRoots = [];

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function snapshotFiles(rootDir) {
  const files = [];
  const visit = (currentPath) => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push([path.relative(rootDir, entryPath), readFileSync(entryPath, "utf8")]);
      }
    }
  };
  visit(rootDir);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

async function createMetadataFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "chase-sets-metadata-"));
  tempRoots.push(rootDir);

  await mkdir(path.join(rootDir, "bounded-contexts", "catalog"), { recursive: true });
  await mkdir(path.join(rootDir, "deployables", "platform-api", "src", "generated"), {
    recursive: true,
  });
  await mkdir(path.join(rootDir, "deployables", "platform-worker", "src", "generated"), {
    recursive: true,
  });
  await mkdir(path.join(rootDir, "deployables", "admin-web", "app", "generated"), {
    recursive: true,
  });
  await mkdir(path.join(rootDir, "deployables", "marketplace", "app", "generated"), {
    recursive: true,
  });
  await mkdir(path.join(rootDir, "deployables", "public-web", "app", "generated"), {
    recursive: true,
  });
  await mkdir(path.join(rootDir, "infrastructure", "event-core-postgres"), { recursive: true });
  await mkdir(path.join(rootDir, "contracts", "localization", "locales", "en"), { recursive: true });

  writeJson(path.join(rootDir, "tsconfig.base.json"), {
    compilerOptions: {
      paths: {},
    },
  });
  writeJson(path.join(rootDir, "bounded-contexts", "catalog", "context.json"), {
    contextName: "catalog",
    localeCatalogs: ["contracts/localization/locales/en/example.ts"],
    apiDeployables: ["platform-api"],
    runtimeDeployables: ["platform-worker"],
    deployableContributions: [
      {
        deployable: "marketplace-web",
      },
    ],
  });
  writeFileSync(
    path.join(rootDir, "infrastructure", "event-core-postgres", "schema.sql"),
    "CREATE TABLE IF NOT EXISTS event_store_events (event_id text PRIMARY KEY);\n",
    "utf8",
  );
  writeFileSync(
    path.join(rootDir, "contracts", "localization", "locales", "en", "example.ts"),
    'export const exampleEnglishTranslations = {\n  "example.key": "Example",\n} as const;\n',
    "utf8",
  );

  const workspaces = [
    {
      name: "@chase-sets/catalog",
      dir: path.join(rootDir, "bounded-contexts", "catalog"),
      dirName: "catalog",
      root: "bounded-contexts",
      packageJson: {
        name: "@chase-sets/catalog",
        exports: {
          ".": "./index.ts",
          "./context": "./context.json",
        },
      },
    },
    {
      name: "@chase-sets/localization",
      dir: path.join(rootDir, "contracts", "localization"),
      dirName: "localization",
      root: "contracts",
      packageJson: {
        name: "@chase-sets/localization",
        exports: {
          ".": "./index.ts",
          "./locales/en": "./locales/en.ts",
          "./locales/en/*": "./locales/en/*.ts",
        },
      },
    },
  ];

  return {
    rootDir,
    trackedLocaleFiles: ["contracts/localization/locales/en/example.ts"],
    workspaces,
  };
}

afterEach(() => {
  for (const rootDir of tempRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("sync-workspace-metadata --check", () => {
  it("treats canonical context manifests as generator-owned bytes", async () => {
    const fileInfo = await prettier.getFileInfo(path.join(repoRoot, "bounded-contexts", "inventory", "context.json"), {
      ignorePath: path.join(repoRoot, ".prettierignore"),
    });
    expect(fileInfo.ignored).toBe(true);
  });

  it("composes a source-backed manifest, writes its canonical bytes, and checks stale canonical data without downstream fallback", async () => {
    const fixture = await createMetadataFixture();
    await mkdir(path.join(fixture.rootDir, "bounded-contexts", "catalog", "features", "catalog"), { recursive: true });
    writeFileSync(
      path.join(fixture.rootDir, "bounded-contexts", "catalog", "features", "catalog", "metadata.json"),
      '{"localeCatalogs":["contracts/localization/locales/en/example.ts"],"apiDeployables":["platform-api"]}\n',
      "utf8",
    );
    writeFileSync(
      path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.source.mjs"),
      'import metadata from "./features/catalog/metadata.json" with { type: "json" };\nexport const contextManifest = { contextName: "catalog", ...metadata, runtimeDeployables: ["platform-worker"], deployableContributions: [{ deployable: "marketplace-web" }] };\n',
      "utf8",
    );

    syncWorkspaceMetadata(fixture);
    const canonicalPath = path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.json");
    const canonical = readFileSync(canonicalPath, "utf8");
    expect(canonical).toBe(
      '{\n  "contextName": "catalog",\n  "localeCatalogs": [\n    "contracts/localization/locales/en/example.ts"\n  ],\n  "apiDeployables": [\n    "platform-api"\n  ],\n  "runtimeDeployables": [\n    "platform-worker"\n  ],\n  "deployableContributions": [\n    {\n      "deployable": "marketplace-web"\n    }\n  ]\n}\n',
    );
    expect(JSON.parse(canonical)).toMatchObject({ contextName: "catalog", localeCatalogs: fixture.trackedLocaleFiles });
    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).not.toThrow();

    writeFileSync(canonicalPath, `${canonical}\n`, "utf8");
    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).toThrow(
      /bounded-contexts\/catalog\/context\.json is stale/,
    );
    expect(readFileSync(canonicalPath, "utf8")).toBe(`${canonical}\n`);
  });

  it("keeps canonical and downstream bytes stable when source contexts are enumerated in reverse order", async () => {
    const fixture = await createMetadataFixture();
    const secondDir = path.join(fixture.rootDir, "bounded-contexts", "catalog-two");
    await mkdir(secondDir, { recursive: true });
    writeFileSync(path.join(secondDir, "package.json"), '{"name":"@chase-sets/catalog-two"}\n');
    writeFileSync(
      path.join(secondDir, "context.json"),
      '{"contextName":"catalog-two","apiDeployables":["platform-api"],"runtimeDeployables":["platform-worker"]}\n',
    );
    writeFileSync(
      path.join(secondDir, "context.source.mjs"),
      'export default { contextName: "catalog-two", apiDeployables: ["platform-api"], runtimeDeployables: ["platform-worker"] };\n',
    );
    fixture.workspaces.push({
      name: "@chase-sets/catalog-two",
      dir: secondDir,
      dirName: "catalog-two",
      root: "bounded-contexts",
      packageJson: { name: "@chase-sets/catalog-two" },
    });

    syncWorkspaceMetadata(fixture);
    const readOutputs = () =>
      [
        "bounded-contexts/catalog/context.json",
        "bounded-contexts/catalog-two/context.json",
        "contracts/localization/locales/en.ts",
      ].map((file) => readFileSync(path.join(fixture.rootDir, file), "utf8"));
    const first = readOutputs();
    syncWorkspaceMetadata({ ...fixture, workspaces: [...fixture.workspaces].reverse() });
    const second = readOutputs();
    expect(second).toEqual(first);
  });

  it("fails closed when a source cannot compose instead of reading canonical context.json", async () => {
    const fixture = await createMetadataFixture();
    writeFileSync(
      path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.source.mjs"),
      'throw new Error("malformed source");\n',
      "utf8",
    );

    expect(() => syncWorkspaceMetadata(fixture)).toThrow(/malformed source/);
  });

  it("rejects duplicate identities inside a source-owned contribution family", async () => {
    const fixture = await createMetadataFixture();
    writeFileSync(
      path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.source.mjs"),
      'export default { contextName: "catalog", apiDeployables: ["platform-api"], projectionGroups: [{ projectionName: "catalog" }, { projectionName: "catalog" }] };\n',
      "utf8",
    );

    expect(() => syncWorkspaceMetadata(fixture)).toThrow(
      /Duplicate context contribution identity "projectionName:catalog"/,
    );
  });

  it("fails closed with the authored source path when a declared fragment is absent", async () => {
    const fixture = await createMetadataFixture();
    writeFileSync(
      path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.source.mjs"),
      'import metadata from "./features/catalog/metadata.json" with { type: "json" }; export default { contextName: "catalog", ...metadata };\n',
      "utf8",
    );

    expect(() => syncWorkspaceMetadata(fixture)).toThrow(
      /Failed to compose context source .*bounded-contexts.*catalog.*context\.source\.mjs/,
    );
  });

  it("reports only canonical drift when source composition is current but canonical JSON is semantically stale", async () => {
    const fixture = await createMetadataFixture();
    writeFileSync(
      path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.source.mjs"),
      'export default { contextName: "catalog", apiDeployables: ["platform-api"] };\n',
      "utf8",
    );
    syncWorkspaceMetadata(fixture);
    const canonicalPath = path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.json");
    const stale = JSON.parse(readFileSync(canonicalPath, "utf8"));
    stale.apiDeployables = ["platform-worker"];
    writeJson(canonicalPath, stale);

    const beforeCheck = snapshotFiles(fixture.rootDir);
    let error;
    try {
      syncWorkspaceMetadata({ ...fixture, check: true });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toContain("Workspace metadata is out of date:");
    expect(error?.message.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- bounded-contexts/catalog/context.json is stale",
    ]);
    expect(snapshotFiles(fixture.rootDir)).toEqual(beforeCheck);
    expect(JSON.parse(readFileSync(canonicalPath, "utf8")).apiDeployables).toEqual(["platform-worker"]);
  });

  it("passes when generated metadata is current", async () => {
    const fixture = await createMetadataFixture();

    syncWorkspaceMetadata(fixture);

    expect(readFileSync(path.join(fixture.rootDir, "tsconfig.base.json"), "utf8")).toMatch(
      /^\/\/ Workspace tsconfigs extend this file or tsconfig\.vitest\.json;/,
    );
    const tsconfigBase = JSON.parse(
      readFileSync(path.join(fixture.rootDir, "tsconfig.base.json"), "utf8").replace(/^\/\/.*\n/, ""),
    );
    expect(tsconfigBase.compilerOptions).toMatchObject({
      module: "Preserve",
      moduleResolution: "Bundler",
    });
    expect(tsconfigBase.compilerOptions).not.toHaveProperty("importsNotUsedAsValues");
    expect(tsconfigBase.compilerOptions).not.toHaveProperty("preserveValueImports");
    expect(tsconfigBase.compilerOptions).not.toHaveProperty("verbatimModuleSyntax");
    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).not.toThrow();
    const englishMerge = readFileSync(
      path.join(fixture.rootDir, "contracts", "localization", "locales", "en.ts"),
      "utf8",
    );
    expect(englishMerge).toContain("// Generated by scripts/sync-workspace-metadata.mjs. Do not edit by hand.");
    expect(englishMerge).toContain('import { exampleEnglishTranslations } from "./en/example";');
    expect(englishMerge).toContain("export type EnglishTranslationKey = keyof typeof englishTranslations;");
  });

  it("does not overwrite hand-authored registries", async () => {
    const fixture = await createMetadataFixture();
    syncWorkspaceMetadata(fixture);
    const generatedPath = path.join(fixture.rootDir, "deployables", "platform-api", "src", "context-registry.ts");
    const authoredContent = "export const apiContextRegistry = [] as const;\n";
    writeFileSync(generatedPath, authoredContent, "utf8");

    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).not.toThrow();
    expect(readFileSync(generatedPath, "utf8")).toBe(authoredContent);
  });

  it("does not sweep legacy files because registry ownership is no longer generated", async () => {
    const fixture = await createMetadataFixture();
    syncWorkspaceMetadata(fixture);
    const legacyPath = path.join(
      fixture.rootDir,
      "infrastructure",
      "platform-runtime",
      "api-context-registry.generated.ts",
    );
    await mkdir(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, "// legacy\n", "utf8");

    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).not.toThrow();
    expect(readFileSync(legacyPath, "utf8")).toBe("// legacy\n");
  });

  it("fails when the generated event-core Postgres schema is stale", async () => {
    const fixture = await createMetadataFixture();
    syncWorkspaceMetadata(fixture);
    const generatedPath = path.join(fixture.rootDir, "infrastructure", "event-core-postgres", "schema.ts");
    const staleContent = 'export const eventCorePostgresSchemaSql = "stale";\n';
    writeFileSync(generatedPath, staleContent, "utf8");

    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).toThrow(
      /infrastructure\/event-core-postgres\/schema\.ts is stale/,
    );
    expect(readFileSync(generatedPath, "utf8")).toBe(staleContent);
  });

  it("fails closed when locale catalog discovery cannot run git", () => {
    expect(() =>
      listTrackedLocaleModulePaths("opaque-root", {
        execGit() {
          throw new Error("synthetic git outage");
        },
      }),
    ).toThrow(/Failed to discover tracked localization modules with git ls-files: synthetic git outage/);
  });

  it("fails closed when an optional localeCatalogs declaration has the wrong shape", async () => {
    const fixture = await createMetadataFixture();
    const manifestPath = path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.localeCatalogs = "contracts/localization/locales/en/example.ts";
    writeJson(manifestPath, manifest);

    expect(() => syncWorkspaceMetadata(fixture)).toThrow(
      /Invalid localeCatalogs .* expected an array of tracked module paths/,
    );
  });

  it("fails closed when a localeCatalogs declaration names no discovered module", async () => {
    const fixture = await createMetadataFixture();
    const manifestPath = path.join(fixture.rootDir, "bounded-contexts", "catalog", "context.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.localeCatalogs = ["contracts/localization/locales/en/absent.ts"];
    writeJson(manifestPath, manifest);

    expect(() => syncWorkspaceMetadata(fixture)).toThrow(
      /Invalid localeCatalogs entry .* no tracked or generated locale module exists/,
    );
  });

  it("refuses to overwrite a tracked namespace module that is not generated", async () => {
    const fixture = await createMetadataFixture();
    syncWorkspaceMetadata(fixture);
    const outputPath = path.join(fixture.rootDir, "contracts", "localization", "locales", "en.ts");
    writeFileSync(outputPath, 'export const manual = { "manual.key": "Manual" } as const;\n', "utf8");

    expect(() =>
      syncWorkspaceMetadata({
        ...fixture,
        trackedLocaleFiles: [...fixture.trackedLocaleFiles, "contracts/localization/locales/en.ts"],
      }),
    ).toThrow(/Tracked localization merge .* is not a generated artifact; refusing to overwrite it/);
  });
});

describe("localization catalog collision detection", () => {
  it("names the duplicate key and both owners for syntax-diverse modules at arbitrary paths", () => {
    const first = analyzeLocaleCatalogModule({
      filePath: "opaque/quartz.ts",
      ownerLabel: "owner-one",
      source: 'export const violet = { "shared.key": "First" } as const;',
    });
    const second = analyzeLocaleCatalogModule({
      filePath: "strange/sibling.ts",
      ownerLabel: "owner-two",
      source: 'const amber = { ["shared.key" as const]: "Second" } as const;\nexport { amber as surface };',
    });

    expect(() => assertNoLocaleCatalogKeyCollisions([first, second])).toThrow(
      /Duplicate localization key "shared\.key".*"opaque\/quartz\.ts" \(owner: owner-one\).*"strange\/sibling\.ts" \(owner: owner-two\)/,
    );
  });
});
