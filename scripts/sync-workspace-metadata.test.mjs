import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import prettier from "prettier";
import ts from "@chase-sets/typescript-compiler-api";
import { checkLocalization } from "./check-localization.mjs";
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
    expect(englishMerge).toContain('"example.key": "Example"');
    expect(englishMerge).not.toMatch(/\bimport\b|\.\.\./);
    expect(englishMerge).toContain("export type EnglishTranslationKey = keyof typeof englishTranslations;");
  });

  it("fails without writing when generated metadata is stale", async () => {
    const fixture = await createMetadataFixture();
    syncWorkspaceMetadata(fixture);
    const generatedPath = path.join(fixture.rootDir, "contracts", "localization", "locales", "en.ts");
    const staleContent = "// stale\n";
    writeFileSync(generatedPath, staleContent, "utf8");

    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).toThrow(
      /contracts\/localization\/locales\/en\.ts is stale/,
    );
    expect(readFileSync(generatedPath, "utf8")).toBe(staleContent);
  });

  it("neither generates, reports, nor deletes context registries", async () => {
    const fixture = await createMetadataFixture();
    const registryPaths = [
      "deployables/platform-api/src/context-registry.ts",
      "deployables/platform-api/src/generated/api-context-registry.ts",
      "infrastructure/platform-runtime/api-context-registry.generated.ts",
      "infrastructure/platform-runtime/web-context-registry.generated.ts",
    ];
    syncWorkspaceMetadata(fixture);
    expect(registryPaths.filter((file) => existsSync(path.join(fixture.rootDir, file)))).toEqual([]);
    expect(existsSync(path.join(fixture.rootDir, "deployables"))).toBe(false);

    for (const file of registryPaths) {
      await mkdir(path.dirname(path.join(fixture.rootDir, file)), { recursive: true });
      writeFileSync(path.join(fixture.rootDir, file), "// hand-authored or retired\n", "utf8");
    }
    const planted = snapshotFiles(fixture.rootDir);
    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).not.toThrow();
    syncWorkspaceMetadata(fixture);
    expect(snapshotFiles(fixture.rootDir)).toEqual(planted);
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

function writeFixtureSource(fixture, file, source) {
  const absolute = path.join(fixture.rootDir, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, "utf8");
}

function loadLocalizationModule(entry, snapshotPath, cache = new Map()) {
  if (cache.has(entry)) return cache.get(entry);
  const exports = {};
  cache.set(entry, exports);
  const source = readFileSync(entry, "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const require = (specifier) => {
    const target =
      specifier === "@chase-sets/primitives/money"
        ? path.join(repoRoot, "contracts/primitives/money.ts")
        : specifier === "./locales/en" && entry === path.join(repoRoot, "contracts/localization/index.ts")
          ? snapshotPath
          : path.resolve(path.dirname(entry), `${specifier}.ts`);
    return loadLocalizationModule(target, snapshotPath, cache);
  };
  new Function("require", "exports", javascript)(require, exports);
  return exports;
}

function assertCoreImportClosure(overrides = new Map()) {
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    if (!/^contracts\/(localization\/(core|money|date-time|bps-percent)|primitives\/[^/]+)\.ts$/.test(file)) {
      throw new Error(`Forbidden core dependency: ${file}`);
    }
    const source = overrides.get(file) ?? readFileSync(path.join(repoRoot, file), "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function inspect(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        specifier = node.moduleSpecifier.text;
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        specifier = node.argument.literal.text;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = node.arguments[0]?.text ?? "<dynamic>";
      }
      if (specifier) {
        const resolved =
          specifier === "@chase-sets/primitives/money"
            ? "contracts/primitives/money.ts"
            : specifier.startsWith(".")
              ? path.posix.normalize(path.posix.join(path.posix.dirname(file), `${specifier}.ts`))
              : specifier;
        visit(resolved);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(sf);
  }
  visit("contracts/localization/core.ts");
  return [...visited];
}

describe("owner-local localization bridge", () => {
  it("reads literal data without executing owner modules or accepting ambient values", async () => {
    const fixture = await createMetadataFixture();
    writeFixtureSource(
      fixture,
      fixture.trackedLocaleFiles[0],
      'throw new Error("Must never execute"); export const copy = { "example.key": "Literal {name}" } as const;',
    );
    syncWorkspaceMetadata(fixture);
    const snapshot = readFileSync(path.join(fixture.rootDir, "contracts/localization/locales/en.ts"), "utf8");
    expect(snapshot).toContain('"example.key": "Literal {name}"');
    expect(snapshot).not.toContain("throw");
    writeFixtureSource(
      fixture,
      fixture.trackedLocaleFiles[0],
      'export const copy = { "example.key": process.env.COPY } as const;',
    );
    expect(() => syncWorkspaceMetadata(fixture)).toThrow(/must be a string literal/);
  });

  it("rejects runtime, type-only and transitive forbidden core imports", () => {
    expect(assertCoreImportClosure()).toContain("contracts/primitives/money.ts");
    for (const statement of [
      'import "./index";',
      'export * from "./locales/en";',
      'import type { Translate } from "./index";',
      'type T = import("@chase-sets/catalog").Catalog;',
      'import "node:fs";',
      'import "../../bounded-contexts/catalog/index";',
      'import("../../deployables/platform-api/index");',
    ]) {
      expect(() => assertCoreImportClosure(new Map([["contracts/localization/core.ts", statement]]))).toThrow(
        /Forbidden core dependency/,
      );
    }
    expect(() => assertCoreImportClosure(new Map([["contracts/localization/money.ts", 'import "./index";']]))).toThrow(
      /Forbidden core dependency/,
    );
  });

  it("discovers only tracked locale sources across every admitted root, including nested leaves", async () => {
    const fixture = await createMetadataFixture();
    const files = [
      ...fixture.trackedLocaleFiles,
      "bounded-contexts/catalog/features/items/localization/locales/en/cards.ts",
      "infrastructure/platform-runtime/localization/locales/en.ts",
      "packages/design-system/localization/locales/en/controls/buttons.copy.ts",
      "deployables/marketplace/localization/locales/en.ts",
      "contracts/example/localization/locales/en.ts",
    ];
    for (const [i, file] of files.slice(1).entries()) {
      writeFixtureSource(fixture, file, `export const copy = { "owner.${i}": "Owner ${i}" } as const;`);
    }
    writeFixtureSource(
      fixture,
      "deployables/marketplace/localization/locales/en/untracked.ts",
      'export const copy = { "untracked.key": "Untracked" };',
    );
    execFileSync("git", ["init", "--quiet"], { cwd: fixture.rootDir });
    execFileSync("git", ["add", "--", ...files], { cwd: fixture.rootDir });
    const discovered = listTrackedLocaleModulePaths(fixture.rootDir);
    expect(discovered).toEqual([...files].sort((a, b) => a.localeCompare(b)));
    const options = { ...fixture, trackedLocaleFiles: discovered };
    const result = syncWorkspaceMetadata(options);
    expect(result.localeCatalogs.scanned).toBe(files.length);
    const output = readFileSync(path.join(fixture.rootDir, "contracts/localization/locales/en.ts"), "utf8");
    expect(output).not.toContain("untracked.key");
    for (let i = 0; i < files.length - 1; i++) expect(output).toContain(`"owner.${i}"`);
    execFileSync("git", ["add", "--", "contracts/localization/locales/en.ts"], { cwd: fixture.rootDir });
    expect(
      syncWorkspaceMetadata({ ...options, trackedLocaleFiles: listTrackedLocaleModulePaths(fixture.rootDir) })
        .localeCatalogs.scanned,
    ).toBe(files.length);
    const before = snapshotFiles(fixture.rootDir);
    syncWorkspaceMetadata(options);
    expect(snapshotFiles(fixture.rootDir)).toEqual(before);
    expect(() => syncWorkspaceMetadata({ ...options, check: true })).not.toThrow();
  });

  it("preserves real core and facade semantics through synthetic feature-local relocation", async () => {
    const fixture = await createMetadataFixture();
    const legacy = fixture.trackedLocaleFiles[0];
    const moved = "bounded-contexts/catalog/features/items/localization/locales/en/cards.ts";
    const source =
      'export const copy = { "example.key": "Hello {name}: {count}, {active}; {nil}, {unknown}." } as const;';
    writeFixtureSource(fixture, legacy, source);
    syncWorkspaceMetadata(fixture);
    const snapshotPath = path.join(fixture.rootDir, "contracts/localization/locales/en.ts");
    const observe = () => {
      const facade = loadLocalizationModule(path.join(repoRoot, "contracts/localization/index.ts"), snapshotPath);
      const core = loadLocalizationModule(path.join(repoRoot, "contracts/localization/core.ts"), snapshotPath);
      const catalog = loadLocalizationModule(
        path.join(fixture.rootDir, fixture.trackedLocaleFiles[0]),
        snapshotPath,
      ).copy;
      return [
        facade,
        { ...core, createTranslator: (options) => core.createTranslator({ ...options, catalogs: { en: catalog } }) },
      ].map((api) => {
        const missing = [];
        const translator = api.createTranslator({ onMissingTranslation: (value) => missing.push(value) });
        return {
          value: translator.t("example.key", { name: "Ada", count: 3, active: true, nil: null }),
          raw: translator.t("example.key"),
          has: translator.has("example.key"),
          absent: translator.has("missing.key"),
          sentinel: translator.t("missing.key"),
          missing,
        };
      });
    };
    const before = observe();
    expect(before[0]).toEqual(before[1]);
    expect(before[0]).toMatchObject({
      value: "Hello Ada: 3, true; {nil}, {unknown}.",
      has: true,
      absent: false,
      sentinel: "[missing:en:missing.key]",
      missing: [{ locale: "en", key: "missing.key" }],
    });
    writeFixtureSource(fixture, moved, source);
    const manifest = path.join(fixture.rootDir, "bounded-contexts/catalog/context.json");
    const context = JSON.parse(readFileSync(manifest, "utf8"));
    context.localeCatalogs = [moved];
    writeJson(manifest, context);
    // The retained old authored source must collide even when only the new path is declared.
    expect(() => syncWorkspaceMetadata({ ...fixture, trackedLocaleFiles: [legacy, moved] })).toThrow(
      /Duplicate localization key "example.key".*bounded-contexts\/catalog\/features\/items\/localization\/locales\/en\/cards.ts.*owner: catalog.*contracts\/localization\/locales\/en\/example.ts.*owner: contracts\/localization/,
    );
    rmSync(path.join(fixture.rootDir, legacy));
    fixture.trackedLocaleFiles = [moved];
    syncWorkspaceMetadata(fixture);
    expect(observe()).toEqual(before);
    const snapshot = readFileSync(snapshotPath, "utf8");
    expect(snapshot).not.toMatch(/\bimport\b|\bfrom\b|\.\.\./);
    expect(snapshot).toContain("EnglishTranslationKey = keyof typeof englishTranslations");
    expect(snapshot).not.toContain("bounded-contexts");
  });

  it("reports added, missing and deleted membership/output without mutation", async () => {
    const fixture = await createMetadataFixture();
    const nested = "contracts/localization/locales/en/nested/leaf.ts";
    writeFixtureSource(fixture, nested, 'export const copy = { "nested.key": "Nested" };');
    fixture.trackedLocaleFiles.push(nested);
    syncWorkspaceMetadata(fixture);
    const snapshot = () => snapshotFiles(fixture.rootDir);
    const newFile = "infrastructure/platform-runtime/localization/locales/en.ts";
    writeFixtureSource(fixture, newFile, 'export const copy = { "technical.key": "Technical" };');
    let before = snapshot();
    expect(() =>
      syncWorkspaceMetadata({ ...fixture, trackedLocaleFiles: [...fixture.trackedLocaleFiles, newFile], check: true }),
    ).toThrow(/en.ts is stale/);
    expect(snapshot()).toEqual(before);
    rmSync(path.join(fixture.rootDir, nested));
    before = snapshot();
    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).toThrow(
      /Failed to read tracked localization module/,
    );
    expect(snapshot()).toEqual(before);
    fixture.trackedLocaleFiles = [fixture.trackedLocaleFiles[0], "contracts/localization/locales/en/nested.ts"];
    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).toThrow(/deleted membership/);
    expect(snapshot()).toEqual(before);
    syncWorkspaceMetadata(fixture);
    expect(existsSync(path.join(fixture.rootDir, "contracts/localization/locales/en/nested.ts"))).toBe(false);
    rmSync(path.join(fixture.rootDir, "contracts/localization/locales/en.ts"));
    before = snapshot();
    expect(() =>
      syncWorkspaceMetadata({ ...fixture, trackedLocaleFiles: [fixture.trackedLocaleFiles[0]], check: true }),
    ).toThrow(/en.ts is missing/);
    expect(snapshot()).toEqual(before);
  });

  it("checks moved keys and real scoped t calls, rejecting missing keys and hardcoded copy", async () => {
    const fixture = await createMetadataFixture();
    const moved = "bounded-contexts/catalog/features/items/localization/locales/en.ts";
    const caller = "bounded-contexts/catalog/features/items/ui/card.tsx";
    writeFixtureSource(fixture, moved, 'export const copy = { ["moved.key"]: "Moved copy" } as const;');
    writeFixtureSource(
      fixture,
      caller,
      'import { createTranslator } from "@chase-sets/localization/core"; import { copy } from "../localization/locales/en"; const { t } = createTranslator({ catalogs: { en: copy } }); export const label = t("moved.key");',
    );
    const options = { rootDir: fixture.rootDir, localeFiles: [moved], trackedFiles: [moved, caller] };
    expect(checkLocalization(options)).toEqual({ checked: 1, violations: [] });
    writeFixtureSource(
      fixture,
      caller,
      'const t = (key: string) => key; export const label = t("missing.moved.key"); export const view = <button title="Hardcoded title">Hardcoded copy</button>;',
    );
    expect(checkLocalization(options).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing English translation for "missing.moved.key"'),
        expect.stringContaining("hardcoded title attribute"),
        expect.stringContaining("hardcoded JSX text"),
      ]),
    );
    writeFixtureSource(fixture, moved, "export const copy = {} as const;");
    writeFixtureSource(fixture, caller, 't("moved.key");');
    expect(checkLocalization(options).violations).toEqual([
      expect.stringContaining('missing English translation for "moved.key"'),
    ]);
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
