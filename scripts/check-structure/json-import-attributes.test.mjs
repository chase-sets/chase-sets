import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import {
  inspectJsonImportAttributes,
  manifestHostRegistrationFields,
  validateJsonImportAttributes,
} from "./json-import-attributes.mjs";
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

const registryBuilderNames = ["buildApiRegistry", "buildWorkerRegistry", "contributesToWebHost"];

function isContextManifestFieldAccess(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "context" &&
    node.expression.name.text === "manifest"
  );
}

function isContextManifestExpression(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "context" &&
    node.name.text === "manifest"
  );
}

function collectParamFieldReads(bodyNode, paramName) {
  const fields = new Set();
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === paramName) {
      fields.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(bodyNode);
  return fields;
}

function collectBindingNames(nameNode, names) {
  if (ts.isIdentifier(nameNode)) {
    names.add(nameNode.text);
    return;
  }
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
}

// A call's identifier can be spelled the same as an imported binding while
// actually resolving to a local function/parameter/variable declared
// in the source file (a shadow). Following the import in that case
// would certify fields from code that never runs for that call. Collect
// every locally declared name conservatively: ambiguous scope is rejected
// instead of silently attributing a call to the unrelated import.
function collectLocallyDeclaredNames(rootNode) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isFunctionLike(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
      for (const param of node.parameters) {
        collectBindingNames(param.name, names);
      }
    } else if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, names);
    } else if (ts.isClassDeclaration(node) && node.name) {
      names.add(node.name.text);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(rootNode);
  return names;
}

function resolveExternalManifestFields(moduleSpecifier, functionName, argIndex, sourceDir) {
  if (!sourceDir || !/^\.\.?\//.test(moduleSpecifier)) {
    throw new Error(`Expected a direct relative module for ${functionName}`);
  }
  const resolvedPath = path.resolve(sourceDir, moduleSpecifier);
  const externalSource = readFileSync(resolvedPath, "utf8");
  const externalFile = ts.createSourceFile(
    resolvedPath,
    externalSource,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const declarations = externalFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
  );
  const declaration = declarations[0];
  if (
    externalFile.parseDiagnostics.length > 0 ||
    declarations.length !== 1 ||
    !declaration.body ||
    !declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    declaration.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ||
    externalFile.statements.some(
      (statement) => statement !== declaration && collectLocallyDeclaredNames(statement).has(functionName),
    )
  ) {
    throw new Error(`Expected exactly one direct exported function declaration for ${functionName}`);
  }
  const param = declaration.parameters[argIndex];
  if (!param || !ts.isIdentifier(param.name)) {
    throw new Error(`Expected an identifier manifest parameter for ${functionName}`);
  }
  if (collectLocallyDeclaredNames(declaration.body).has(param.name.text)) {
    throw new Error(`Shadowed manifest parameter in ${functionName}`);
  }
  return [...collectParamFieldReads(declaration.body, param.name.text)];
}

function extractRegistryBuilderManifestFields(content, sourceDir) {
  const source = ts.createSourceFile("registry-builders.mjs", content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length > 0) throw new Error("Malformed registry builder source");
  const fields = new Set();
  const visitedBuilders = new Set();
  const localNames = collectLocallyDeclaredNames(source);

  const importedFrom = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const recordBinding = (name, aliased) => {
      const bindings = importedFrom.get(name) ?? [];
      bindings.push({ moduleSpecifier: statement.moduleSpecifier.text, aliased });
      importedFrom.set(name, bindings);
    };
    if (statement.importClause?.name) recordBinding(statement.importClause.name.text, true);
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) recordBinding(named.name.text, true);
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) recordBinding(element.name.text, Boolean(element.propertyName));
    }
  }

  for (const statement of source.statements) {
    if (
      !ts.isFunctionDeclaration(statement) ||
      !statement.name ||
      !registryBuilderNames.includes(statement.name.text)
    ) {
      continue;
    }
    visitedBuilders.add(statement.name.text);
    const visit = (node) => {
      if (isContextManifestFieldAccess(node)) {
        fields.add(node.name.text);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && importedFrom.has(node.expression.text)) {
        const manifestArgIndex = node.arguments.findIndex((argument) => isContextManifestExpression(argument));
        if (manifestArgIndex === -1) {
          ts.forEachChild(node, visit);
          return;
        }
        if (localNames.has(node.expression.text)) {
          throw new Error(
            `${statement.name.text}: call to "${node.expression.text}" is shadowed by a local declaration; refusing to follow the import.`,
          );
        }
        const bindings = importedFrom.get(node.expression.text);
        if (bindings.length !== 1 || bindings[0].aliased) {
          throw new Error(`Ambiguous or aliased import binding for ${node.expression.text}`);
        }
        for (const field of resolveExternalManifestFields(
          bindings[0].moduleSpecifier,
          node.expression.text,
          manifestArgIndex,
          sourceDir,
        )) {
          fields.add(field);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  return { builders: [...visitedBuilders].sort(), fields: [...fields].sort() };
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
  it("matches all three live registry builders", () => {
    const sourceUrl = new URL("../sync-workspace-metadata.mjs", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8");
    const extracted = extractRegistryBuilderManifestFields(source, path.dirname(fileURLToPath(sourceUrl)));

    expect(extracted.builders).toEqual([...registryBuilderNames].sort());
    expect(extracted.fields).toEqual([...manifestHostRegistrationFields].sort());
  });

  it("detects a seventh field read by a registry builder", () => {
    const extracted = extractRegistryBuilderManifestFields(`
      function buildApiRegistry(_outputPath, _hostName, contexts) {
        return contexts.filter((context) => context.manifest.apiDeployables || context.manifest.seventhField);
      }
      function buildWorkerRegistry() {}
      function contributesToWebHost() {}
    `);

    expect(extracted.fields).toEqual(["apiDeployables", "seventhField"]);
  });

  const importedHelperSource = `
    export function contextManifestContributesToApiHost(manifest, hostName) {
      return manifest.apiDeployables?.includes(hostName) || manifest.deployableContributions ||
        manifest.runtimeDeployables || manifest.shellContributions ||
        manifest.sourceRuntimeDeployables || manifest.sourceRuntimeProfiles;
    }
  `;

  it("fails closed when a local function declaration shadows the imported helper", () => {
    withFixture({ "helper.mjs": importedHelperSource }, ({ rootDir }) => {
      const source = `
        import { contextManifestContributesToApiHost } from "./helper.mjs";
        function buildApiRegistry(_outputPath, hostName, contexts) {
          function contextManifestContributesToApiHost() {
            return false;
          }
          return contexts.filter((context) => contextManifestContributesToApiHost(context.manifest, hostName));
        }
        function buildWorkerRegistry() {}
        function contributesToWebHost() {}
      `;

      expect(() => extractRegistryBuilderManifestFields(source, rootDir)).toThrow(/shadow/i);
    });
  });

  it("fails closed when a nested parameter ambiguously shadows the imported helper", () => {
    withFixture({ "helper.mjs": importedHelperSource }, ({ rootDir }) => {
      const source = `
        import { contextManifestContributesToApiHost } from "./helper.mjs";
        function buildApiRegistry(_outputPath, hostName, contexts) {
          return contexts
            .map((context) => context)
            .filter((context, contextManifestContributesToApiHost) =>
              contextManifestContributesToApiHost(context.manifest, hostName),
            );
        }
        function buildWorkerRegistry() {}
        function contributesToWebHost() {}
      `;

      expect(() => extractRegistryBuilderManifestFields(source, rootDir)).toThrow(/shadow/i);
    });
  });

  it("rejects an import alias even when a matching decoy declaration exists", () => {
    withFixture(
      {
        "helper.mjs": `${importedHelperSource}\nexport function ownerCheck(manifest) { return manifest.apiDeployables; }`,
      },
      ({ rootDir }) => {
        const source = `
        import { contextManifestContributesToApiHost as ownerCheck } from "./helper.mjs";
        function buildApiRegistry(_outputPath, hostName, contexts) {
          return contexts.filter((context) => ownerCheck(context.manifest, hostName));
        }
        function buildWorkerRegistry() {}
        function contributesToWebHost() {}
      `;

        expect(() => extractRegistryBuilderManifestFields(source, rootDir)).toThrow(/alias/i);
      },
    );
  });

  it("rejects a re-export instead of a direct declaration", () => {
    withFixture(
      {
        "real-helper.mjs": importedHelperSource,
        "reexport-helper.mjs": 'export { contextManifestContributesToApiHost } from "./real-helper.mjs";\n',
      },
      ({ rootDir }) => {
        const source = `
          import { contextManifestContributesToApiHost } from "./reexport-helper.mjs";
          function buildApiRegistry(_outputPath, hostName, contexts) {
            return contexts.filter((context) => contextManifestContributesToApiHost(context.manifest, hostName));
          }
          function buildWorkerRegistry() {}
          function contributesToWebHost() {}
        `;

        expect(() => extractRegistryBuilderManifestFields(source, rootDir)).toThrow(/direct exported/);
      },
    );
  });

  it("throws when the imported module does not exist", () => {
    withFixture({}, ({ rootDir }) => {
      const source = `
        import { contextManifestContributesToApiHost } from "./missing-helper.mjs";
        function buildApiRegistry(_outputPath, hostName, contexts) {
          return contexts.filter((context) => contextManifestContributesToApiHost(context.manifest, hostName));
        }
        function buildWorkerRegistry() {}
        function contributesToWebHost() {}
      `;

      expect(() => extractRegistryBuilderManifestFields(source, rootDir)).toThrow(/ENOENT/);
    });
  });

  const directHelperBuilder = `
    import { contextManifestContributesToApiHost } from "./helper.mjs";
    function buildApiRegistry(_outputPath, hostName, contexts) {
      return contexts.filter((context) => contextManifestContributesToApiHost(context.manifest, hostName));
    }
    function buildWorkerRegistry() {}
    function contributesToWebHost() {}
  `;

  it("follows the direct exported helper and detects a seventh field in that real imported source", () => {
    for (const seventhField of [false, true]) {
      const helper = seventhField
        ? importedHelperSource.replace(
            "manifest.runtimeDeployables",
            "manifest.seventhField || manifest.runtimeDeployables",
          )
        : importedHelperSource;
      withFixture({ "helper.mjs": helper }, ({ rootDir }) => {
        expect(extractRegistryBuilderManifestFields(directHelperBuilder, rootDir).fields).toEqual(
          [...manifestHostRegistrationFields, ...(seventhField ? ["seventhField"] : [])].sort(),
        );
      });
    }
  });

  it.each([
    ["duplicate import", 'import { contextManifestContributesToApiHost } from "./second-helper.mjs";'],
    [
      "duplicate specifier",
      'import { contextManifestContributesToApiHost, contextManifestContributesToApiHost } from "./second-helper.mjs";',
    ],
    ["top-level shadow", "const contextManifestContributesToApiHost = () => false;"],
  ])("rejects %s instead of certifying the unrelated six-field helper", (_name, declaration) => {
    withFixture({ "helper.mjs": importedHelperSource, "second-helper.mjs": importedHelperSource }, ({ rootDir }) => {
      expect(() => extractRegistryBuilderManifestFields(`${declaration}\n${directHelperBuilder}`, rootDir)).toThrow(
        /ambiguous|shadow/i,
      );
    });
  });

  it.each([
    ["duplicate declaration", `${importedHelperSource}\n${importedHelperSource}`],
    ["unexported declaration", importedHelperSource.replace("export function", "function")],
    [
      "destructured parameter",
      "export function contextManifestContributesToApiHost({ apiDeployables }) { return apiDeployables; }",
    ],
    [
      "shadowed manifest parameter",
      "export function contextManifestContributesToApiHost(manifest) { return ((manifest) => manifest.apiDeployables)({}); }",
    ],
  ])("rejects an imported helper with a %s", (_name, helper) => {
    withFixture({ "helper.mjs": helper }, ({ rootDir }) => {
      expect(() => extractRegistryBuilderManifestFields(directHelperBuilder, rootDir)).toThrow(/exported|parameter/i);
    });
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
