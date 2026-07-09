import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncWorkspaceMetadata } from "./sync-workspace-metadata.mjs";

const tempRoots = [];

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

  writeJson(path.join(rootDir, "tsconfig.base.json"), {
    compilerOptions: {
      paths: {},
    },
  });
  writeJson(path.join(rootDir, "bounded-contexts", "catalog", "context.json"), {
    contextName: "catalog",
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
  ];

  return { rootDir, workspaces };
}

afterEach(() => {
  for (const rootDir of tempRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("sync-workspace-metadata --check", () => {
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
  });

  it("fails without writing when generated metadata is stale", async () => {
    const fixture = await createMetadataFixture();
    syncWorkspaceMetadata(fixture);
    const generatedPath = path.join(
      fixture.rootDir,
      "deployables",
      "platform-api",
      "src",
      "generated",
      "api-context-registry.ts",
    );
    const staleContent = "// stale\n";
    writeFileSync(generatedPath, staleContent, "utf8");

    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).toThrow(/Workspace metadata is out of date:/);
    expect(readFileSync(generatedPath, "utf8")).toBe(staleContent);
  });

  it("reports legacy generated files as drift without deleting them", async () => {
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

    expect(() => syncWorkspaceMetadata({ ...fixture, check: true })).toThrow(
      /api-context-registry\.generated\.ts should be deleted/,
    );
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
});
