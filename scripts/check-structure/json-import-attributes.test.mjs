import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import {
  inspectJsonImportAttributes,
  manifestHostRegistrationFields,
  validateJsonImportAttributes,
} from "./json-import-attributes.mjs";
import { findContextRootExportViolation, isApprovedCrossContextTypeContractImport } from "./run.mjs";
import { CONTEXT_REGISTRY_HOST_ARMS, workspaceRoots } from "../lib/repo.mjs";

// Counts full-repository censuses at the module boundary across both entry
// points. Fixture and path-scoped calls are not full censuses.
const fullCensus = vi.hoisted(() => ({ invocations: 0 }));
vi.mock("./json-import-attributes.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  const { repoRoot } = await import("../lib/repo.mjs");
  const { resolve } = await import("node:path");
  const counted =
    (census) =>
    (options = {}) => {
      if (
        options.paths === undefined &&
        (options.rootDir === undefined || resolve(options.rootDir) === resolve(repoRoot))
      ) {
        fullCensus.invocations += 1;
      }
      return census(options);
    };
  return {
    ...actual,
    inspectJsonImportAttributes: counted(actual.inspectJsonImportAttributes),
    validateJsonImportAttributes: counted(actual.validateJsonImportAttributes),
  };
});

// Freezes the census data. Compiler nodes stay mutable because the compiler
// may cache data on them.
function deepFreeze(value) {
  const prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== Array.prototype) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

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
    "deployables/platform-api/src/context-registry.ts": 'import "@chase-sets/example";\n',
    ...extraFiles,
  };
}

function zeroHostContextFiles(entrySource, manifest = { contextName: "atlas" }, extraFiles = {}) {
  return {
    "bounded-contexts/atlas/package.json": JSON.stringify({
      name: "@chase-sets/atlas",
      exports: { ".": "./entry.ts", "./context": "./context.json" },
    }),
    "bounded-contexts/atlas/context.json": typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    "bounded-contexts/atlas/entry.ts": entrySource,
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
        "deployables/platform-api/src/context-registry.ts":
          'import "../../../bounded-contexts/example/renderer.tsx";\n',
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
      "deployables/platform-api/src/context-registry.ts": "export const registry = [];\n",
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

describe("manifest-only execution disposition", () => {
  const attributed = 'export { default as contextManifest } from "./context.json" with { type: "json" };\n';

  it("classifies only an exact-attributed self-owned zero-host context root", async () => {
    const result = await validateFixture(zeroHostContextFiles(attributed));

    expect(result.violations).toEqual([]);
    expect(result.inventory.declarations).toEqual([
      expect.objectContaining({
        relativeFile: "bounded-contexts/atlas/entry.ts",
        resolved: "bounded-contexts/atlas/context.json",
        disposition: "manifest-only",
      }),
    ]);
  });

  it.each([
    ["missing attribute", 'export { default as contextManifest } from "./context.json";\n'],
    ["non-exact attribute", "export { default as contextManifest } from \"./context.json\" with { type: 'json' };\n"],
  ])("keeps exact attribute enforcement for %s", async (_name, source) => {
    const result = await validateFixture(zeroHostContextFiles(source));

    expect(result.inventory.declarations).toEqual([expect.objectContaining({ disposition: "manifest-only" })]);
    expect(result.violations).toEqual([
      'bounded-contexts/atlas/entry.ts: export "./context.json" must use exactly with { type: "json" }',
    ]);
  });

  it.each([
    ["apiDeployables", ["unregistered-host"]],
    ["runtimeDeployables", ["unregistered-host"]],
    ["sourceRuntimeDeployables", ["unregistered-host"]],
    ["sourceRuntimeProfiles", [{ profile: "unregistered-host" }]],
    ["deployableContributions", [{ deployable: "unregistered-host" }]],
    ["shellContributions", [{ deployable: "unregistered-host" }]],
  ])("exits when %s is non-empty", async (field, value) => {
    const result = await validateFixture(zeroHostContextFiles(attributed, { contextName: "atlas", [field]: value }));

    expect(result.inventory.declarations).toEqual([expect.objectContaining({ disposition: "indeterminate" })]);
    expect(result.violations).toEqual([
      "bounded-contexts/atlas/entry.ts: relevant context-manifest declaration has no proven execution disposition",
    ]);
  });

  it("keeps non-root and foreign-manifest declarations indeterminate", async () => {
    const nonRoot = await validateFixture(
      zeroHostContextFiles(
        "export const module = {};\n",
        { contextName: "atlas" },
        {
          "bounded-contexts/atlas/parts/reader.ts":
            'import contextManifest from "../context.json" with { type: "json" };\n',
        },
      ),
    );
    expect(nonRoot.inventory.declarations).toEqual([
      expect.objectContaining({
        relativeFile: "bounded-contexts/atlas/parts/reader.ts",
        disposition: "indeterminate",
      }),
    ]);

    const foreign = await validateFixture(
      zeroHostContextFiles(
        'import contextManifest from "@chase-sets/orbit/context" with { type: "json" };\n',
        { contextName: "atlas" },
        {
          "bounded-contexts/orbit/package.json": JSON.stringify({
            name: "@chase-sets/orbit",
            exports: { ".": "./entry.ts", "./context": "./context.json" },
          }),
          "bounded-contexts/orbit/context.json": JSON.stringify({ contextName: "orbit" }),
          "bounded-contexts/orbit/entry.ts": "export const module = {};\n",
        },
      ),
    );
    expect(foreign.inventory.declarations).toEqual([
      expect.objectContaining({
        relativeFile: "bounded-contexts/atlas/entry.ts",
        resolved: "bounded-contexts/orbit/context.json",
        disposition: "indeterminate",
      }),
    ]);
    expect([...nonRoot.violations, ...foreign.violations]).toEqual([
      "bounded-contexts/atlas/parts/reader.ts: relevant context-manifest declaration has no proven execution disposition",
      "bounded-contexts/atlas/entry.ts: relevant context-manifest declaration has no proven execution disposition",
    ]);
  });

  it("fails closed with a named violation when the owning manifest is malformed", async () => {
    const result = await validateFixture(zeroHostContextFiles(attributed, '{"contextName":'));

    expect(result.inventory.declarations).toEqual([expect.objectContaining({ disposition: "indeterminate" })]);
    expect(result.violations).toEqual([
      "bounded-contexts/atlas/context.json: implemented context manifest is not usable JSON",
      "bounded-contexts/atlas/entry.ts: relevant context-manifest declaration has no proven execution disposition",
    ]);
  });
});

describe("manifest host-registration predicate parity", () => {
  it("names exactly the fields of the context-registry host admission arms", () => {
    expect([...manifestHostRegistrationFields].sort()).toEqual([
      "apiDeployables",
      "deployableContributions",
      "runtimeDeployables",
      "shellContributions",
      "sourceRuntimeDeployables",
      "sourceRuntimeProfiles",
    ]);
    expect([...manifestHostRegistrationFields].sort()).toEqual(
      [...new Set(CONTEXT_REGISTRY_HOST_ARMS.map((arm) => arm.field))].sort(),
    );
  });
});

describe("real repository execution membership", () => {
  it("retains cyclic value paths without promoting type-only edges or parsing irrelevant branches", () => {
    withFixture(
      contextFiles('export { default as contextManifest } from "./context.json" with { type: "json" };', {
        "deployables/platform-api/src/context-registry.ts":
          'import "../../../bounded-contexts/example/bridge"; import "../../../bounded-contexts/example/unused";',
        "bounded-contexts/example/bridge.ts": 'export * from "./loop"; import type { Shape } from "./types";',
        "bounded-contexts/example/loop.ts": 'export * from "./bridge"; export * from "./index";',
        "bounded-contexts/example/types.ts": 'import contextManifest from "./context.json"; export type Shape = {};',
        "bounded-contexts/example/unused.ts": "export const unrelated = true;",
      }),
      ({ rootDir, paths }) => {
        const result = inspectJsonImportAttributes({ rootDir, paths });
        expect(result.declarations.map(({ relativeFile, disposition }) => [relativeFile, disposition])).toEqual([
          ["bounded-contexts/example/index.ts", "node-enforced"],
          ["bounded-contexts/example/types.ts", "indeterminate"],
        ]);
        expect(result.work.fileReads).toContain("bounded-contexts/example/unused.ts");
        expect(result.work.fullParses).not.toContain("bounded-contexts/example/unused.ts");
        expect(result.work.fullParses.length).toBe(new Set(result.work.fullParses).size);
      },
    );
  });

  it("keeps the Git-index census digest unchanged after ignored and untracked generated output", () => {
    withFixture(
      contextFiles('export { default as contextManifest } from "./context.json" with { type: "json" };', {
        ".gitignore": "generated/\n",
      }),
      ({ rootDir }) => {
        const git = (...args) => execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", timeout: 10_000 });
        git("init", "--quiet");
        git("add", ".");
        const digest = () => {
          const inventory = inspectJsonImportAttributes({ rootDir });
          const records = inventory.declarations.map(
            ({ relativeFile, form, specifier, attributeText, resolved, disposition }) => ({
              relativeFile,
              form,
              specifier,
              attributeText,
              resolved,
              disposition,
            }),
          );
          return {
            digest: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
            partition: inventory.partition,
            candidates: inventory.work.indexCandidates,
          };
        };
        const before = digest();
        mkdirSync(path.join(rootDir, "generated"));
        writeFileSync(
          path.join(rootDir, "generated/ignored.ts"),
          'import manifest from "../bounded-contexts/example/context.json";',
        );
        writeFileSync(
          path.join(rootDir, "untracked.ts"),
          'export { default } from "./bounded-contexts/example/context.json";',
        );
        const after = digest();
        expect(git("status", "--porcelain", "--ignored")).toContain("!! generated/");
        expect(git("status", "--porcelain", "--ignored")).toContain("?? untracked.ts");
        expect(after).toEqual(before);
        console.info(JSON.stringify({ ignoredOutputDigest: { before: before.digest, after: after.digest } }));
      },
    );
  });

  it.each([
    ["an untracked manifest for a tracked workspace", "bounded-contexts/draft/context.json", { contextName: "draft" }],
    [
      "an untracked workspace resolving a tracked importer",
      "bounded-contexts/rogue/package.json",
      { name: "@chase-sets/rogue", exports: { ".": "../example/extra.ts" } },
    ],
  ])("keeps the Git-index partition unchanged after %s", (_case, untrackedFile, untrackedJson) => {
    withFixture(
      contextFiles(
        'export { default as contextManifest } from "./context.json" with { type: "json" };\n' +
          'import draft from "@chase-sets/draft/context" with { type: "json" };',
        {
          "deployables/platform-api/src/context-registry.ts":
            'import "@chase-sets/example";\nimport "@chase-sets/rogue";\n',
          "bounded-contexts/example/extra.ts": 'import manifest from "./context.json" with { type: "json" };',
          "bounded-contexts/draft/package.json": JSON.stringify({
            name: "@chase-sets/draft",
            exports: { "./context": "./context.json" },
          }),
        },
      ),
      ({ rootDir }) => {
        const git = (...args) => execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", timeout: 10_000 });
        git("init", "--quiet");
        git("add", ".");
        const inspect = () => {
          const { declarations, partition, discoveryViolations, work } = inspectJsonImportAttributes({ rootDir });
          const records = declarations.map(({ relativeFile, specifier, resolved, disposition }) => ({
            relativeFile,
            specifier,
            resolved,
            disposition,
          }));
          return { census: { records, partition, discoveryViolations }, work };
        };
        const before = inspect();
        expect(before.census.partition).toMatchObject({ "node-enforced": 1, indeterminate: 1 });
        mkdirSync(path.dirname(path.join(rootDir, untrackedFile)), { recursive: true });
        writeFileSync(path.join(rootDir, untrackedFile), JSON.stringify(untrackedJson));
        const after = inspect();
        expect(git("status", "--porcelain")).toContain(`?? ${path.posix.dirname(untrackedFile)}/`);
        expect(after.census).toEqual(before.census);
        expect(after.work.enrolledWorkspaces).toEqual(before.work.enrolledWorkspaces);
      },
    );
  });

  // Only the two real-repository tests share this hook, so a hook failure
  // cannot skip the fixture controls in the enclosing describe.
  describe("shared real-repository census", () => {
    let census;

    beforeAll(async () => {
      census = deepFreeze(await validateJsonImportAttributes());
    });

    it("census work stays source-bounded", () => {
      expect(fullCensus.invocations).toBe(1);
      expect(Object.isFrozen(census.inventory.work.fileReads)).toBe(true);
      const { inventory } = census;
      const { work } = inventory;
      const parseSources = new Set([
        ...work.manifestCandidates,
        ...work.configParses,
        ...work.closures.flatMap(({ relevant }) => relevant),
      ]);
      console.info(
        JSON.stringify({
          censusWork: {
            fullCensusInvocations: fullCensus.invocations,
            gitSubprocesses: work.gitSubprocesses,
            wholeTreeScans: work.wholeTreeScans,
            indexCandidates: work.indexCandidates.length,
            discoveredWorkspaces: work.discoveredWorkspaces.length,
            enrolledWorkspaces: work.enrolledWorkspaces.length,
            sourceIndex: {
              kind: work.sourceIndex.kind,
              pathCount: work.sourceIndex.pathCount,
              sourceCount: work.sourceIndex.sourceCount,
              prefilterCount: work.sourceIndex.prefilterCount,
              candidateCount: work.sourceIndex.candidateCount,
            },
            distinctReads: new Set(work.fileReads).size,
            repeatedReads: work.fileReads.length - new Set(work.fileReads).size,
            fullParses: work.fullParses.length,
            repeatedParses: work.fullParses.length - new Set(work.fullParses).size,
            sourceDerivedParseCeiling: parseSources.size,
            closures: work.closures.map(({ seeds, indexed, relevant, size }) => ({
              seeds,
              indexed,
              relevant: relevant.length,
              size,
            })),
          },
        }),
      );
      expect(
        work.fullParses.length,
        "full parses exceed source-derived manifest ancestor/config ceiling",
      ).toBeLessThanOrEqual(parseSources.size);
      expect(work.fullParses.every((file) => parseSources.has(file))).toBe(true);
      expect(work.fileReads.length).toBe(new Set(work.fileReads).size);
      expect(work.fullParses.length).toBe(new Set(work.fullParses).size);
      expect(work.wholeTreeScans).toBeLessThanOrEqual(1);
      expect(work.gitSubprocesses).toBe(2);
      // One independent Git listing is the oracle for every index assertion.
      const trackedFiles = execFileSync("git", ["ls-files"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: GIT_LISTING_MAX_BUFFER,
      })
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const indexedSources = trackedFiles.filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file)).sort();
      expect(work.indexCandidates).toEqual(indexedSources);
      expect(work.sourceIndex).toMatchObject({
        kind: "git-index-source/v1",
        pathCount: new Set(trackedFiles).size,
        sourceCount: indexedSources.length,
        candidateCount: work.manifestCandidates.length,
      });
      expect(work.sourceIndex.candidates).toEqual(work.manifestCandidates);
      expect(work.sourceIndex.prefilterCount).toBeGreaterThanOrEqual(work.sourceIndex.candidateCount);
      const indexedSourceSet = new Set(indexedSources);
      expect(
        work.fileReads.filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file)).every((file) => indexedSourceSet.has(file)),
      ).toBe(true);
      const workspacePackageJson = new RegExp(`^(?:${workspaceRoots.join("|")})/[^/]+/package\\.json$`);
      const indexedWorkspaces = trackedFiles.filter((file) => workspacePackageJson.test(file)).sort();
      expect([...work.enrolledWorkspaces].sort()).toEqual(indexedWorkspaces);
    });

    it("derives the exact real census and execution partition within the default timeout", () => {
      expect(fullCensus.invocations).toBe(1);
      const result = census;

      expect(result.violations, result.violations.join("\n")).toEqual([]);
      expect(result.inventory.parserVersion).toBe("6.0.3");
      expect(result.inventory.declarations).toHaveLength(138);
      expect(result.inventory.partition).toEqual({
        "node-enforced": 57,
        "vite-excluded": 54,
        "vitest-excluded": 27,
        "manifest-only": 0,
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
        "052e5a10f855839d16ccb8a5e69cd0791bc725f2996f54afca5d531c740d596a",
      );
      expect(
        normalized.filter(
          (entry) =>
            entry.relativeFile ===
            "bounded-contexts/pricing/features/pricing-health/tests/pricing-health-route.test.tsx",
        ),
      ).toEqual([
        {
          relativeFile: "bounded-contexts/pricing/features/pricing-health/tests/pricing-health-route.test.tsx",
          form: "import",
          specifier: "../../../context.json",
          attributeText: null,
          resolved: "bounded-contexts/pricing/context.json",
          disposition: "vitest-excluded",
        },
      ]);
      expect(
        normalized.filter((entry) => entry.relativeFile.startsWith("bounded-contexts/pricing/routes/marketplace/")),
      ).toEqual([
        {
          relativeFile: "bounded-contexts/pricing/routes/marketplace/account-desk-repricing-policy.tsx",
          form: "import",
          specifier: "../../context.json",
          attributeText: null,
          resolved: "bounded-contexts/pricing/context.json",
          disposition: "vite-excluded",
        },
        {
          relativeFile: "bounded-contexts/pricing/routes/marketplace/account-desk-repricing.tsx",
          form: "import",
          specifier: "../../context.json",
          attributeText: null,
          resolved: "bounded-contexts/pricing/context.json",
          disposition: "vite-excluded",
        },
      ]);
      expect(
        normalized.filter(
          (entry) => entry.relativeFile === "bounded-contexts/pricing/tests/account-repricing-route.test.ts",
        ),
      ).toEqual([
        {
          relativeFile: "bounded-contexts/pricing/tests/account-repricing-route.test.ts",
          form: "import",
          specifier: "../context.json",
          attributeText: null,
          resolved: "bounded-contexts/pricing/context.json",
          disposition: "vitest-excluded",
        },
      ]);
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
          (entry) => entry.relativeFile === "deployables/admin-web/app/context-registry.ts",
        ),
      ).toMatchObject({ disposition: "vite-excluded" });
      expect(
        result.inventory.declarations.find(
          (entry) =>
            entry.relativeFile === "bounded-contexts/ordering/tests/inventory-reservation-subscription.test.ts",
        ),
      ).toMatchObject({ disposition: "vitest-excluded" });
      expect(
        result.inventory.declarations.find(
          (entry) =>
            entry.relativeFile ===
            "bounded-contexts/platform-operations/features/seller-compliance-sales/read-model/projection.test.ts",
        ),
      ).toMatchObject({
        disposition: "vitest-excluded",
        resolved: "bounded-contexts/platform-operations/context.json",
        attributeText: 'with { type: "json" }',
      });
    });
  });

  it("fails closed when tracked discovery collapses despite implemented contexts", async () => {
    const result = await validateJsonImportAttributes({ paths: new Set() });

    expect(result.violations).toEqual([
      "JSON import-attribute discovery collapsed despite 20 implemented context manifest(s)",
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

  it("accepts only the closed Channels root contract", () => {
    const channelsRoot = readFileSync(
      path.resolve(import.meta.dirname, "../..", "bounded-contexts/channels/index.ts"),
      "utf8",
    );
    const diagnostic = "context root entrypoint exports must match the approved closed contract";

    expect(findContextRootExportViolation(channelsRoot, "bounded-contexts/channels")).toBeNull();
    expect(
      findContextRootExportViolation(
        channelsRoot.replace(/^export \{ buildConnectorManifest \}[^\n]+\n/m, ""),
        "bounded-contexts/channels",
      ),
    ).toBe(diagnostic);
    expect(
      findContextRootExportViolation(
        channelsRoot.replace("  type UpdatePriceQuantityInput,\n", ""),
        "bounded-contexts/channels",
      ),
    ).toBe(diagnostic);
    expect(
      findContextRootExportViolation(`${channelsRoot}\nexport const extra = true;`, "bounded-contexts/channels"),
    ).toBe(diagnostic);
  });
});

describe("approved cross-context type contracts", () => {
  it("accepts only the registered public type contracts at their Economics consumers", () => {
    expect(
      isApprovedCrossContextTypeContractImport(
        "bounded-contexts/pricing/features/economics/domain/contracts.ts",
        "@chase-sets/channels",
        'import type { ChannelEnvironment, ChannelProviderIdentity } from "@chase-sets/channels";',
      ),
    ).toBe(true);
    expect(
      isApprovedCrossContextTypeContractImport(
        "bounded-contexts/pricing/features/economics/integrations/native-commercial-terms/provider.ts",
        "@chase-sets/commercial-terms/server",
        'import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";',
      ),
    ).toBe(true);
  });

  it("rejects value imports, unregistered symbols, and consumers outside Economics", () => {
    expect(
      isApprovedCrossContextTypeContractImport(
        "bounded-contexts/pricing/features/economics/domain/contracts.ts",
        "@chase-sets/channels",
        'import { ChannelProviderIdentity } from "@chase-sets/channels";',
      ),
    ).toBe(false);
    expect(
      isApprovedCrossContextTypeContractImport(
        "bounded-contexts/pricing/features/economics/domain/contracts.ts",
        "@chase-sets/channels",
        'import type { ChannelProviderRegistry } from "@chase-sets/channels";',
      ),
    ).toBe(false);
    expect(
      isApprovedCrossContextTypeContractImport(
        "bounded-contexts/pricing/features/recommendations/domain/contracts.ts",
        "@chase-sets/channels",
        'import type { ChannelProviderIdentity } from "@chase-sets/channels";',
      ),
    ).toBe(false);
  });
});
