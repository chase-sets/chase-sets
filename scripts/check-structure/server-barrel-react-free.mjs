import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";
import { listContextManifests, listWorkspacePackages, normalizeRelative, repoRoot } from "../lib/repo.mjs";

// Guard: a value import from a context's /server barrel (or a
// deployable-server-consumed index.ts) must never transitively pull in a .tsx
// module or the design-system package.
//
// Root cause this prevents recurring: a headless server bootstrap (evaluated
// via `tsx src/bootstrap.ts`, no JSX/browser runtime) crashed with
// `ReferenceError: React is not defined` because a context's server.ts
// re-exported a React component alongside its API clients, and nothing on the
// bootstrap path had ever imported that barrel before. SSR would have hidden
// the bug (a browser/SSR runtime has React available); a headless bootstrap
// script has no React runtime at all, so the very first value import of a
// .tsx module blows up.
//
// Why an AST module-graph walk instead of a raw text/regex scanner: the
// failure mode is transitive — server.ts can be clean while re-exporting a
// helper that itself imports a UI module three files away — and a scanner
// that only reads the entry file's own text cannot see that. Each file is
// parsed with ts.createSourceFile and walked with ts.forEachChild so every
// import, re-export, and dynamic import() is found regardless of nesting or
// template-literal substitutions a raw scanner loop can mis-tokenize.
//
// Type-only imports/re-exports are excluded from the graph: `import type` and
// `export type` (whole-declaration or per-specifier) are erased before tsx/
// esbuild ever evaluates the module, so they cannot be the runtime crash this
// guard exists to catch. Only value-reachable edges are followed.

export const designSystemPackageName = "@chase-sets/design-system";

const moduleFileExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const reactModuleExtensions = new Set([".tsx", ".jsx"]);
const deployableServerRoots = ["deployables/platform-api", "deployables/platform-worker"];

function isTestFile(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.includes("/__tests__/") ||
    /\.(?:test|spec)\.[^/]+$/.test(relativeFile)
  );
}

function scriptKindFor(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseModule(absPath, content) {
  return ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, false, scriptKindFor(absPath));
}

export function isValueReachableImport(statement) {
  const clause = statement.importClause;
  if (!clause) return true; // `import "./x"` side-effect import
  if (clause.isTypeOnly) return false; // `import type ... from "./x"`
  if (clause.name) return true; // default binding is always a value
  const bindings = clause.namedBindings;
  if (!bindings) return true;
  if (ts.isNamespaceImport(bindings)) return true; // `import * as ns from "./x"`
  if (ts.isNamedImports(bindings)) {
    return bindings.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

export function isValueReachableExport(statement) {
  if (statement.isTypeOnly) return false; // `export type { X } from "./x"`
  const clause = statement.exportClause;
  if (!clause) return true; // bare `export * from "./x"`
  if (ts.isNamespaceExport(clause)) return true; // `export * as ns from "./x"`
  if (ts.isNamedExports(clause)) {
    return clause.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

// Full recursive walk (not a top-level-statement scan): dynamic `import()`
// calls can appear nested inside functions, and ts.forEachChild is immune to
// the template-literal blind spots a raw scanner loop is prone to.
export function collectModuleReferences(sourceFile) {
  const references = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({ specifier: node.moduleSpecifier.text, valueReachable: isValueReachableImport(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({ specifier: node.moduleSpecifier.text, valueReachable: isValueReachableExport(node) });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      references.push({ specifier: node.arguments[0].text, valueReachable: true });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function isExistingFile(candidate) {
  if (!existsSync(candidate)) return false;
  return statSync(candidate).isFile();
}

export function resolveRelativeModuleFile(fromFileAbs, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const basePath = path.resolve(path.dirname(fromFileAbs), specifier);
  const candidates = [
    basePath,
    ...moduleFileExtensions.map((extension) => `${basePath}${extension}`),
    ...moduleFileExtensions.map((extension) => path.join(basePath, `index${extension}`)),
  ];

  return candidates.find((candidate) => isExistingFile(candidate)) ?? null;
}

function normalizeExportTarget(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return value.import ?? value.default ?? value.types ?? null;
  }
  return null;
}

export function resolveExportsSubpath(exportsField, subpath) {
  if (!exportsField) return null;
  if (typeof exportsField === "string") {
    return subpath === "." ? exportsField : null;
  }

  if (exportsField[subpath] !== undefined) {
    return normalizeExportTarget(exportsField[subpath]);
  }

  for (const [pattern, target] of Object.entries(exportsField)) {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) continue;

    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
      const targetValue = normalizeExportTarget(target);
      if (targetValue) return targetValue.replace("*", matched);
    }
  }

  return null;
}

export function buildWorkspacePackageIndex({ repoRoot: rootDir }) {
  const index = new Map();
  for (const pkg of listWorkspacePackages({ repoRoot: rootDir })) {
    index.set(pkg.name, { dir: pkg.dir, exports: pkg.packageJson.exports ?? null });
  }
  return index;
}

export function resolveBareSpecifier(specifier, packageIndex) {
  for (const [packageName, info] of packageIndex.entries()) {
    let subpath = null;
    if (specifier === packageName) {
      subpath = ".";
    } else if (specifier.startsWith(`${packageName}/`)) {
      subpath = `.${specifier.slice(packageName.length)}`;
    } else {
      continue;
    }

    const target = resolveExportsSubpath(info.exports, subpath);
    return { packageName, absolutePath: target ? path.resolve(info.dir, target) : null };
  }

  return null;
}

function isDesignSystemSpecifier(specifier) {
  return specifier === designSystemPackageName || specifier.startsWith(`${designSystemPackageName}/`);
}

function violationKey(violation) {
  return `${violation.entryFile}::${violation.type}::${violation.file}::${violation.specifier ?? ""}`;
}

function walkGraph({ entryAbsPath, entryRelativeFile, repoRoot: rootDir, packageIndex, referenceCache }) {
  const violations = new Map();
  const visited = new Set();
  const queue = [{ absPath: entryAbsPath, chain: [] }];

  while (queue.length > 0) {
    const { absPath, chain } = queue.shift();
    const normalizedAbs = path.resolve(absPath);
    if (visited.has(normalizedAbs) || !isExistingFile(normalizedAbs)) {
      continue;
    }
    visited.add(normalizedAbs);

    const relativeFile = normalizeRelative(normalizedAbs, rootDir);
    const nextChain = [...chain, relativeFile];

    if (reactModuleExtensions.has(path.extname(normalizedAbs))) {
      const violation = {
        entryFile: entryRelativeFile,
        type: "tsx-module",
        file: relativeFile,
        chain: nextChain,
      };
      violations.set(violationKey(violation), violation);
      continue;
    }

    let references = referenceCache.get(normalizedAbs);
    if (references === undefined) {
      const content = readFileSync(normalizedAbs, "utf8");
      references = collectModuleReferences(parseModule(normalizedAbs, content));
      referenceCache.set(normalizedAbs, references);
    }

    for (const reference of references) {
      if (!reference.valueReachable) continue;

      if (isDesignSystemSpecifier(reference.specifier)) {
        const violation = {
          entryFile: entryRelativeFile,
          type: "design-system-import",
          file: relativeFile,
          specifier: reference.specifier,
          chain: nextChain,
        };
        violations.set(violationKey(violation), violation);
        continue;
      }

      if (reference.specifier.startsWith(".")) {
        const resolved = resolveRelativeModuleFile(normalizedAbs, reference.specifier);
        if (resolved) queue.push({ absPath: resolved, chain: nextChain });
        continue;
      }

      const bare = resolveBareSpecifier(reference.specifier, packageIndex);
      if (bare?.absolutePath) {
        queue.push({ absPath: bare.absolutePath, chain: nextChain });
      }
    }
  }

  return [...violations.values()];
}

async function findDeployableServerConsumedPackageNames({ repoRoot: rootDir, packageNames }) {
  const consumed = new Set();
  const targetNames = new Set(packageNames);

  for (const deployableRoot of deployableServerRoots) {
    const absoluteRoot = path.join(rootDir, deployableRoot);
    if (!existsSync(absoluteRoot)) continue;

    const files = await collectFiles(absoluteRoot, {
      extensions: new Set([".ts", ".tsx", ".mts", ".cts"]),
      skippedDirectories: defaultSkippedDirectories,
    });

    for (const filePath of files) {
      const relativeFile = normalizeRelative(filePath, rootDir);
      if (isTestFile(relativeFile)) continue;

      const content = readFileSync(filePath, "utf8");
      const references = collectModuleReferences(parseModule(filePath, content));

      for (const reference of references) {
        if (!reference.valueReachable) continue;
        if (targetNames.has(reference.specifier)) {
          consumed.add(reference.specifier);
        }
      }
    }
  }

  return consumed;
}

function formatChain(chain) {
  return chain.join(" -> ");
}

function formatViolation(violation) {
  if (violation.type === "tsx-module") {
    return (
      `${violation.entryFile}: transitive import graph reaches React/JSX module ${violation.file}. ` +
      "Context server barrels (and deployable-server-consumed index.ts files) must stay React-free; move UI-bearing " +
      "exports behind ./web.ts (or a dedicated UI export subpath) instead. " +
      `Chain: ${formatChain(violation.chain)}`
    );
  }

  return (
    `${violation.entryFile}: transitive import graph imports ${designSystemPackageName} (specifier ` +
    `${JSON.stringify(violation.specifier)}) from ${violation.file}. Context server barrels (and deployable-server-` +
    `consumed index.ts files) must stay React-free; move design-system-consuming code behind ./web.ts (or a ` +
    `dedicated UI export subpath) instead. Chain: ${formatChain(violation.chain)}`
  );
}

export async function findServerBarrelReactFreeViolations(options = {}) {
  const rootDir = options.repoRoot ?? repoRoot;
  const contextManifests = options.contextManifests ?? loadContextManifestsForCli(rootDir);

  const packageIndex = buildWorkspacePackageIndex({ repoRoot: rootDir });
  const referenceCache = new Map();
  const contexts = [...contextManifests.values()];

  const deployableServerConsumedPackageNames = await findDeployableServerConsumedPackageNames({
    repoRoot: rootDir,
    packageNames: contexts.map((context) => context.packageName),
  });

  const violations = [];

  for (const context of contexts) {
    const contextAbsRoot = path.join(rootDir, context.root);
    const entries = [];

    const serverEntryAbs = path.join(contextAbsRoot, "server.ts");
    if (existsSync(serverEntryAbs)) {
      entries.push({ absPath: serverEntryAbs, relativeFile: `${context.root}/server.ts` });
    }

    const indexEntryAbs = path.join(contextAbsRoot, "index.ts");
    if (existsSync(indexEntryAbs) && deployableServerConsumedPackageNames.has(context.packageName)) {
      entries.push({ absPath: indexEntryAbs, relativeFile: `${context.root}/index.ts` });
    }

    for (const entry of entries) {
      const entryViolations = walkGraph({
        entryAbsPath: entry.absPath,
        entryRelativeFile: entry.relativeFile,
        repoRoot: rootDir,
        packageIndex,
        referenceCache,
      });
      violations.push(...entryViolations);
    }
  }

  violations.sort((left, right) => {
    if (left.entryFile !== right.entryFile) return left.entryFile.localeCompare(right.entryFile);
    return left.file.localeCompare(right.file);
  });

  return violations;
}

export async function checkServerBarrelReactFree(options = {}) {
  const violations = await findServerBarrelReactFreeViolations(options);
  return { passed: violations.length === 0, violations, messages: violations.map(formatViolation) };
}

// Convenience wrapper matching the { violations, warnings } shape the other
// check-structure/run.mjs phase validators return, so this guard plugs into
// runStructureCheck the same way validateCrossContextReadInventory and
// validateGlossaryCoverage do.
export async function validateServerBarrelReactFree(options = {}) {
  const violations = await findServerBarrelReactFreeViolations(options);
  return { violations: violations.map(formatViolation), warnings: [] };
}

function loadContextManifestsForCli(rootDir) {
  return new Map(
    listContextManifests({ repoRoot: rootDir }).map((context) => [
      `bounded-contexts/${context.dirName}`,
      {
        root: `bounded-contexts/${context.dirName}`,
        manifest: context.manifest,
        packageName: context.manifest.packageName,
      },
    ]),
  );
}

async function main() {
  const contextManifests = loadContextManifestsForCli(repoRoot);
  const result = await checkServerBarrelReactFree({ contextManifests });

  if (!result.passed) {
    console.error("Server-barrel React-free guard failed.");
    for (const message of result.messages) {
      console.error(`- ${message}`);
    }
    process.exit(1);
  }

  console.log(`Server barrels stay React-free across ${contextManifests.size} bounded contexts.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
