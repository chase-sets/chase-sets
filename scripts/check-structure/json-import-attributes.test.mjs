import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectJsonImportAttributes, validateJsonImportAttributes } from "./json-import-attributes.mjs";
import { findContextRootExportViolation } from "./run.mjs";

function withFixture(files, callback) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "json-import-attributes-"));
  try {
    for (const [relativeFile, content] of Object.entries(files)) {
      const fullPath = path.join(rootDir, relativeFile);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
    }
    return callback({ rootDir, paths: new Set(Object.keys(files)) });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function contextFiles(indexSource, extraFiles = {}) {
  return {
    "bounded-contexts/example/package.json": JSON.stringify({
      name: "@chase-sets/example",
      exports: { ".": "./index.ts", "./context": "./context.json" },
    }),
    "bounded-contexts/example/context.json": JSON.stringify({
      contextName: "example",
      deployableContributions: [],
    }),
    "bounded-contexts/example/index.ts": indexSource,
    "deployables/platform-api/src/generated/api-context-registry.ts": 'import "@chase-sets/example";\n',
    ...extraFiles,
  };
}

function inspectFixture(files) {
  return withFixture(files, ({ rootDir, paths }) => inspectJsonImportAttributes({ rootDir, paths }));
}

async function validateFixture(files) {
  return withFixture(files, ({ rootDir, paths }) => validateJsonImportAttributes({ rootDir, paths }));
}

describe("JSON import-attribute production guard", () => {
  it("accepts attributed imports and exports and rejects every missing-attribute mutant", async () => {
    const canonicalImport = 'import contextManifest from "./context.json" with { type: "json" };';
    const canonicalExport = 'export { default as contextManifest } from "./context.json" with { type: "json" };';
    const controls = await validateFixture(contextFiles(`${canonicalExport}\n${canonicalImport}\n`));
    expect(controls.violations).toEqual([]);

    const mutants = [
      {
        name: "missing import attribute",
        source: `${canonicalExport}\nimport contextManifest from "./context.json";\n`,
        form: "import",
      },
      {
        name: "missing export attribute",
        source: `export { default as contextManifest } from "./context.json";\n${canonicalImport}\n`,
        form: "export",
      },
      {
        name: "comment-masked export",
        source: `// ${canonicalExport}\nexport { default as contextManifest } from "./context.json";\n${canonicalImport}\n`,
        form: "export",
      },
      {
        name: "non-exact attribute spelling",
        source: `${canonicalExport}\nimport contextManifest from "./context.json" with { type: 'json' };\n`,
        form: "import",
      },
    ];

    for (const mutant of mutants) {
      const result = await validateFixture(contextFiles(mutant.source));
      expect(result.violations, mutant.name).toContain(
        `bounded-contexts/example/index.ts: ${mutant.form} "./context.json" must use exactly with { type: "json" }`,
      );
    }
  });

  it("omits clause-level and all-type per-specifier declarations from runtime enforcement", () => {
    const inventory = inspectFixture(
      contextFiles(`
        import contextManifest from "./context.json" with { type: "json" };
        import type ContextManifest from "./context.json";
        export type { default as ExportedContextManifest } from "./context.json";
        import { type contextName } from "./context.json";
        export { type contextName as exportedContextName } from "./context.json";
      `),
    );

    expect(inventory.declarations).toHaveLength(1);
    expect(inventory.declarations[0]).toMatchObject({
      form: "import",
      disposition: "node-enforced",
      attributeText: 'with { type: "json" }',
    });

    const mixedInventory = inspectFixture(
      contextFiles(`
        import { type contextName, contextName as runtimeContextName } from "./context.json" with { type: "json" };
        export { type contextName, contextName as runtimeContextName } from "./context.json" with { type: "json" };
      `),
    );
    expect(mixedInventory.declarations).toHaveLength(2);
    expect(
      mixedInventory.declarations.map(({ form, disposition, attributeText }) => ({
        form,
        disposition,
        attributeText,
      })),
    ).toEqual([
      { form: "export", disposition: "node-enforced", attributeText: 'with { type: "json" }' },
      { form: "import", disposition: "node-enforced", attributeText: 'with { type: "json" }' },
    ]);
  });

  it("keeps escaped module specifiers inside the conservative prefilter", async () => {
    const result = await validateFixture(
      contextFiles('import contextManifest from "./context\\u002ejson" with { type: "json" };\n'),
    );

    expect(result.violations).toEqual([]);
    expect(result.inventory.declarations).toEqual([
      expect.objectContaining({
        specifier: "./context.json",
        resolved: "bounded-contexts/example/context.json",
        disposition: "node-enforced",
      }),
    ]);
  });

  it("gives the derived Node closure precedence over every exclusion set", () => {
    const inventory = inspectFixture(
      contextFiles("export const marker = true;\n", {
        "deployables/platform-api/src/generated/api-context-registry.ts":
          'import "../../../../bounded-contexts/example/renderer.tsx";\n',
        "bounded-contexts/example/renderer.tsx":
          'import contextManifest from "./context.json" with { type: "json" };\n',
      }),
    );

    expect(inventory.declarations).toEqual([
      expect.objectContaining({
        relativeFile: "bounded-contexts/example/renderer.tsx",
        disposition: "node-enforced",
      }),
    ]);
  });

  it("fails arbitrary Vite, registry, and test lookalikes closed as indeterminate", async () => {
    const attributed = 'import contextManifest from "../../../example/context.json" with { type: "json" };\n';
    const files = contextFiles("export const marker = true;\n", {
      "deployables/platform-api/src/generated/api-context-registry.ts": "export const registry = [];\n",
      "bounded-contexts/synthetic/support/runtime-support/renderer.tsx": attributed,
      "bounded-contexts/synthetic/support/runtime-support/renderer.test.ts": attributed,
      "bounded-contexts/synthetic/generated/web-context-registry.ts":
        'import contextManifest from "../../example/context.json" with { type: "json" };\n',
    });
    const result = await validateFixture(files);

    expect(
      result.inventory.declarations.map(({ relativeFile, disposition }) => ({ relativeFile, disposition })),
    ).toEqual([
      {
        relativeFile: "bounded-contexts/synthetic/generated/web-context-registry.ts",
        disposition: "indeterminate",
      },
      {
        relativeFile: "bounded-contexts/synthetic/support/runtime-support/renderer.test.ts",
        disposition: "indeterminate",
      },
      {
        relativeFile: "bounded-contexts/synthetic/support/runtime-support/renderer.tsx",
        disposition: "indeterminate",
      },
    ]);
    expect(result.violations).toHaveLength(3);
    expect(result.violations.every((violation) => violation.includes("no proven execution disposition"))).toBe(true);
  });
});

describe("real repository execution membership", () => {
  it("derives the exact real census and execution partition within the default timeout", async () => {
    const result = await validateJsonImportAttributes();

    expect(result.violations, result.violations.join("\n")).toEqual([]);
    expect(result.inventory.parserVersion).toBe("6.0.3");
    expect(result.inventory.declarations).toHaveLength(94);
    expect(result.inventory.partition).toEqual({
      "node-enforced": 39,
      "vite-excluded": 48,
      "vitest-excluded": 7,
      indeterminate: 0,
    });
    const normalized = result.inventory.declarations.map(
      ({ relativeFile, form, specifier, attributeText, resolved, disposition }) => ({
        relativeFile,
        form,
        specifier,
        attributeText,
        resolved,
        disposition,
      }),
    );
    expect(createHash("sha256").update(JSON.stringify(normalized)).digest("hex")).toBe(
      "69388d3fd68fc0b9f8bec17bb4f6f3dcac524f1d85eddccab1f5c34afb144e1f",
    );
    expect(
      result.inventory.declarations.find(
        (entry) => entry.relativeFile === "bounded-contexts/catalog/support/authoring-support/index.ts",
      ),
    ).toMatchObject({ disposition: "node-enforced", attributeText: 'with { type: "json" }' });
    expect(
      result.inventory.declarations.find(
        (entry) => entry.relativeFile === "bounded-contexts/settlement/routes/marketplace/account-desk-payout.tsx",
      ),
    ).toMatchObject({ disposition: "vite-excluded" });
    expect(
      result.inventory.declarations.find(
        (entry) => entry.relativeFile === "deployables/admin-web/app/generated/web-context-registry.ts",
      ),
    ).toMatchObject({ disposition: "vite-excluded" });
    expect(
      result.inventory.declarations.find(
        (entry) => entry.relativeFile === "bounded-contexts/ordering/tests/inventory-reservation-subscription.test.ts",
      ),
    ).toMatchObject({ disposition: "vitest-excluded" });
  });

  it("fails closed when tracked discovery collapses despite implemented contexts", async () => {
    const result = await validateJsonImportAttributes({ paths: new Set() });

    expect(result.violations).toEqual([
      "JSON import-attribute discovery collapsed despite 19 implemented context manifest(s)",
    ]);
  });
});

describe("findContextRootExportViolation", () => {
  it("accepts the attributed canonical context-root export", () => {
    expect(
      findContextRootExportViolation(
        'export { default as contextManifest } from "./context.json" with { type: "json" };\nexport const module = {};',
      ),
    ).toBeNull();
  });

  it("rejects un-attributed and extra context-root exports with the existing diagnostic", () => {
    expect(
      findContextRootExportViolation(
        'export { default as contextManifest } from "./context.json";\nexport const module = {};',
      ),
    ).toBe("context root entrypoints must export only contextManifest and module");
    expect(
      findContextRootExportViolation(
        'export { default as contextManifest } from "./context.json" with { type: "json" };\nexport const module = {};\nexport const extra = true;',
      ),
    ).toBe("context root entrypoints must export only contextManifest and module");
  });
});
