import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

// Privacy product-truth inventory.
//
// The Privacy Policy candidate may only describe behavior that current source
// entails. This collector derives that behavior from the Git-tracked
// production TypeScript partition BY CODE SHAPE — never from a filename, a
// path vocabulary, or a hand-maintained list of known cookies, storage keys,
// providers, loaders, or cache names.
//
// Five fact families are derived:
//
//   first-party-cookie               `Set-Cookie` / `document.cookie` write
//                                    sites, resolved back through local
//                                    serializers, helper parameters, and
//                                    literal/aliased name constants
//   web-storage                      `getItem`/`setItem`/`removeItem` on a
//                                    resolved Web Storage handle, including
//                                    direct member access, injected `Storage`
//                                    and `Pick<Storage, ...>` seams, local
//                                    storage helpers, and dynamic key families
//   provider-injected-client-storage external client-script loader surfaces:
//                                    the loader call, its owning non-workspace
//                                    package, the workspace dependency edges
//                                    that declare it, committed CSP
//                                    script-src/frame-src origins, and
//                                    consumer-route reachability
//   cache-storage                    object literals whose resolved type
//                                    identity is `ServiceWorkerPolicy`, plus
//                                    their composition, worker route, root
//                                    registration, and production-build guard
//   social-provider-profile          object literals whose resolved type
//                                    identity is `SocialLoginProfile`, plus
//                                    every mapped output field and the
//                                    executable provider registration
//
// Every derived member is either resolved into a fact or reported as
// `indeterminate`. There is no silent-drop arm: an unresolved binding, an
// unclassified consumer-reachable external package, an unowned CSP script
// origin, a nonliteral cache name, a missing registration, or an unreadable
// tracked file all fail closed. Callers treat any `indeterminate` entry as a
// failure.
//
// The CacheStorage derivation deliberately reads the ordinary typed policy
// object literals and their production composition. It never parses the
// generated `String.raw` service-worker body, so the generated string can
// neither become nor conceal a product-truth fact.
//
// Detection visits a signal-matched subset of the candidate partition. Each
// signal is the detector's OWN precondition (a `Set-Cookie` write site cannot
// exist without the `Set-Cookie` literal the detector matches on; a
// `ServiceWorkerPolicy` literal cannot exist without that type name), so the
// prefilter cannot narrow coverage below the grammar. It is not an independent
// path or keyword vocabulary, and the arbitrary-tracked-path controls in
// privacy-product-truth-inventory.test.ts prove it.

export const PRIVACY_PRODUCT_TRUTH_INVENTORY_VERSION = "privacy-product-truth-inventory/v1";

export const privacyProductTruthFactFamilies = [
  "first-party-cookie",
  "web-storage",
  "provider-injected-client-storage",
  "cache-storage",
  "social-provider-profile",
];

// ---------------------------------------------------------------------------
// Tracked-production partition
// ---------------------------------------------------------------------------

const testPathSegmentPattern = /(^|\/)(?:__tests__|tests|fixtures|test-fixtures|test-support)(\/|$)/;
const testSupportFileNamePattern = /-test-support\.(?:ts|tsx)$/;

export const privacyProductTruthExclusionReasons = [
  "not-typescript-source",
  "declaration-module",
  "test-module",
  "spec-module",
  "test-path-segment",
  "test-support-module",
];

/**
 * The one partition predicate. Returns the exclusion reason for a tracked
 * path, or `null` when the path is a production candidate. Exclusions are
 * published by reason so the partition is auditable rather than implicit.
 */
export function classifyPrivacyProductTruthPartitionExclusion(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  // Declarations are reported as declarations whichever TypeScript extension
  // they carry, so `.d.mts` is never mislabelled as a non-TypeScript file.
  if (/\.d\.(?:ts|mts)$/.test(normalized)) return "declaration-module";
  if (!/\.(?:ts|tsx)$/.test(normalized)) return "not-typescript-source";
  if (/\.test\.(?:ts|tsx)$/.test(normalized)) return "test-module";
  if (/\.spec\.(?:ts|tsx)$/.test(normalized)) return "spec-module";
  if (testPathSegmentPattern.test(normalized)) return "test-path-segment";
  if (testSupportFileNamePattern.test(normalized)) return "test-support-module";
  return null;
}

export function isPrivacyProductTruthCandidateModule(relativePath) {
  return classifyPrivacyProductTruthPartitionExclusion(relativePath) === null;
}

function defaultExecGit(args, repoRoot) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 28,
  });
}

/**
 * Enumerates the Git index, never the working-tree filesystem, so ignored
 * build output can never enter the partition while tracked generated modules
 * stay visible (and non-authoritative).
 */
export function listPrivacyProductTruthTrackedPaths(repoRoot, { execGit } = {}) {
  const runGit = execGit ?? ((args) => defaultExecGit(args, repoRoot));
  return runGit(["ls-files", "-z", "--cached"])
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
}

export function partitionPrivacyProductTruthPaths(trackedPaths) {
  const candidates = [];
  const excluded = [];
  for (const relativePath of trackedPaths) {
    const reason = classifyPrivacyProductTruthPartitionExclusion(relativePath);
    if (reason === null) candidates.push(relativePath);
    else excluded.push({ relativePath, reason });
  }
  return { trackedPaths: [...trackedPaths], candidates, excluded };
}

function readTrackedText(repoRoot, relativePath) {
  return readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8");
}

/** Line endings are normalized before any hashing or line indexing so a
 *  `core.autocrlf` checkout produces the same evidence digest as the LF
 *  checkout hosted CI uses. */
function normalizeSource(source) {
  return source.replaceAll("\r\n", "\n");
}

export function readPrivacyProductTruthSources({ repoRoot, execGit } = {}) {
  const trackedPaths = listPrivacyProductTruthTrackedPaths(repoRoot, { execGit });
  const { candidates, excluded } = partitionPrivacyProductTruthPaths(trackedPaths);
  const records = candidates.map((relativePath) => {
    try {
      return { relativePath, source: normalizeSource(readTrackedText(repoRoot, relativePath)) };
    } catch (error) {
      return {
        relativePath,
        readError: `could not read tracked file (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  });
  return { trackedPaths, candidates, excluded, records, repoRoot };
}

// ---------------------------------------------------------------------------
// Package and module resolution
// ---------------------------------------------------------------------------

function readWorkspacePackages(repoRoot, trackedPaths) {
  const packages = new Map();
  for (const relativePath of trackedPaths) {
    if (!relativePath.endsWith("package.json")) continue;
    let manifestSource;
    let manifest;
    try {
      manifestSource = normalizeSource(readTrackedText(repoRoot, relativePath));
      manifest = JSON.parse(manifestSource);
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string") continue;
    packages.set(manifest.name, {
      name: manifest.name,
      manifestPath: relativePath,
      manifestSource,
      directory: path.posix.dirname(relativePath),
      exports: manifest.exports,
      dependencies: { ...manifest.dependencies },
      devDependencies: { ...manifest.devDependencies },
    });
  }
  return packages;
}

/** The exact manifest line that declares a dependency edge, so the evidence
 *  reference names the declaring line rather than the whole file. */
function dependencyDeclarationRef(pkg, dependencyName) {
  const lines = pkg.manifestSource.split("\n");
  const needle = `"${dependencyName}":`;
  const line = lines.findIndex((entry) => entry.includes(needle));
  return line < 0 ? null : `${pkg.manifestPath}:${line + 1}`;
}

function createModuleResolver(trackedPaths, workspacePackages) {
  const tracked = new Set(trackedPaths);
  const cache = new Map();

  const resolveFile = (base) => {
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.mjs`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ]) {
      if (tracked.has(candidate)) return candidate;
    }
    return null;
  };

  const pickExportTarget = (value) => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      return typeof value.default === "string" ? value.default : typeof value.types === "string" ? value.types : null;
    }
    return null;
  };

  const resolveSubpath = (pkg, subpath) => {
    const entries = pkg.exports;
    if (entries === undefined) return subpath === "." ? "./index.ts" : subpath;
    if (typeof entries === "string") return subpath === "." ? entries : null;
    if (entries[subpath] !== undefined) return pickExportTarget(entries[subpath]);
    for (const [pattern, value] of Object.entries(entries)) {
      const starIndex = pattern.indexOf("*");
      if (starIndex < 0) continue;
      const prefix = pattern.slice(0, starIndex);
      const suffix = pattern.slice(starIndex + 1);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const star = subpath.slice(prefix.length, subpath.length - suffix.length);
      const target = pickExportTarget(value);
      if (target !== null) return target.replace("*", star);
    }
    return null;
  };

  return function resolveSpecifier(specifier, fromFile) {
    const cacheKey = `${fromFile} ${specifier}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveUncached(specifier, fromFile);
    cache.set(cacheKey, resolved);
    return resolved;
  };

  function resolveUncached(specifier, fromFile) {
    if (specifier.startsWith("node:")) return { kind: "builtin", specifier };
    if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)).replace(/\/$/, "");
      const file = resolveFile(base);
      return file === null ? { kind: "unresolved", specifier } : { kind: "internal", file };
    }
    const segments = specifier.split("/");
    const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    const pkg = workspacePackages.get(packageName);
    if (pkg === undefined) return { kind: "external", packageName, specifier };
    const subpath = specifier.length > packageName.length ? `.${specifier.slice(packageName.length)}` : ".";
    const target = resolveSubpath(pkg, subpath);
    if (target === null) return { kind: "unresolved", specifier, workspacePackage: packageName };
    const file = resolveFile(path.posix.normalize(path.posix.join(pkg.directory, target)));
    return file === null
      ? { kind: "unresolved", specifier, workspacePackage: packageName }
      : { kind: "internal", file, workspacePackage: packageName };
  }
}

// ---------------------------------------------------------------------------
// Parsing and per-file symbol tables
// ---------------------------------------------------------------------------

function scriptKindFor(relativePath) {
  return relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function evidenceRef(file, node) {
  const start = file.sourceFile.getLineAndCharacterOfPosition(node.getStart(file.sourceFile)).line + 1;
  const end = file.sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return end > start ? `${file.relativePath}:${start}-${end}` : `${file.relativePath}:${start}`;
}

/** A tracked generated module announces itself in its own leading comment
 *  trivia. That is a code-shape signal, not a path convention, so a generated
 *  module moved anywhere in the tree stays marked non-authoritative. */
function hasGeneratedHeader(source) {
  const head = source.slice(0, 400);
  const firstCodeIndex = head.search(/^(?!\s*(?:\/\/|\/\*|\*|$))/m);
  const leading = firstCodeIndex < 0 ? head : head.slice(0, firstCodeIndex);
  return /generated by|auto-?generated|do not edit/i.test(leading);
}

function unwrap(node) {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else return current;
  }
}

function functionLikeName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function parameterIndex(fn, name) {
  return fn.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);
}

function returnExpressions(fn) {
  const results = [];
  if (fn.body === undefined) return results;
  if (!ts.isBlock(fn.body)) {
    results.push(fn.body);
    return results;
  }
  const visit = (node) => {
    if (isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return results;
}

function buildFileIndex(relativePath, source) {
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(relativePath));
  } catch (error) {
    return { relativePath, parseError: error instanceof Error ? error.message : String(error) };
  }

  const stringConstants = new Map();
  const arrayConstants = new Map();
  const functionsByName = new Map();
  const importBindings = new Map();
  const reExportBindings = new Map();
  const typeAliases = new Map();
  const exportedNames = new Set();

  function record(map, name, value) {
    const existing = map.get(name);
    if (existing === undefined) map.set(name, value);
    else if (existing !== null && existing.node !== value.node) map.set(name, null);
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isStringLiteralLike(initializer)) {
        record(stringConstants, node.name.text, { value: initializer.text, node: initializer, declaration: node });
      } else if (ts.isArrayLiteralExpression(initializer)) {
        record(arrayConstants, node.name.text, { node: initializer, declaration: node });
      } else if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        record(functionsByName, node.name.text, { node: initializer, declaration: node });
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      record(functionsByName, node.name.text, { node, declaration: node });
    }
    if (ts.isTypeAliasDeclaration(node) && ts.isIdentifier(node.name)) {
      typeAliases.set(node.name.text, node.type);
      if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        exportedNames.add(node.name.text);
      }
    }
    if (ts.isInterfaceDeclaration(node) && ts.isIdentifier(node.name)) {
      typeAliases.set(node.name.text, node);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) {
        importBindings.set(clause.name.text, {
          specifier,
          importedName: "default",
          typeOnly: clause.isTypeOnly,
          node: clause.name,
        });
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          importBindings.set(element.name.text, {
            specifier,
            importedName: (element.propertyName ?? element.name).text,
            typeOnly: clause.isTypeOnly === true || element.isTypeOnly === true,
            node: element,
          });
        }
      } else if (named && ts.isNamespaceImport(named)) {
        importBindings.set(named.name.text, { specifier, importedName: "*", node: named });
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const specifier =
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      for (const element of node.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        exportedNames.add(element.name.text);
        if (specifier !== undefined) {
          reExportBindings.set(element.name.text, { specifier, importedName: localName, node: element });
        }
      }
    }
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(node) && node.name) exportedNames.add(node.name.text);
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exportedNames.add(declaration.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    relativePath,
    source,
    sourceFile,
    stringConstants,
    arrayConstants,
    functionsByName,
    importBindings,
    reExportBindings,
    typeAliases,
    exportedNames,
    trackedGenerated: hasGeneratedHeader(source),
  };
}

const MAX_RESOLVE_DEPTH = 12;

function buildIndex(records, trackedPaths, workspacePackages) {
  const sourceByPath = new Map();
  for (const record of records) {
    if (record.readError === undefined) sourceByPath.set(record.relativePath, record.source);
  }
  const parsed = new Map();
  const parseFailures = [];
  const resolveSpecifier = createModuleResolver(trackedPaths, workspacePackages);

  const index = {
    sourceByPath,
    parseFailures,
    workspacePackages,
    resolveSpecifier,

    /** Lazily parses a candidate module. Returns `null` for modules outside the
     *  partition and records a fail-closed entry for parse errors. */
    file(relativePath) {
      if (parsed.has(relativePath)) return parsed.get(relativePath);
      const source = sourceByPath.get(relativePath);
      if (source === undefined) {
        parsed.set(relativePath, null);
        return null;
      }
      const built = buildFileIndex(relativePath, source);
      if (built.parseError !== undefined) {
        parseFailures.push({ relativePath, reason: built.parseError });
        parsed.set(relativePath, null);
        return null;
      }
      parsed.set(relativePath, built);
      return built;
    },

    *filesMatching(predicate) {
      for (const [relativePath, source] of sourceByPath) {
        if (!predicate(source, relativePath)) continue;
        const file = index.file(relativePath);
        if (file !== null) yield file;
      }
    },

    resolveImportedBinding(fromFile, binding, depth = 0) {
      if (depth > MAX_RESOLVE_DEPTH) return null;
      const resolved = resolveSpecifier(binding.specifier, fromFile.relativePath);
      if (resolved.kind !== "internal") return null;
      const targetFile = index.file(resolved.file);
      if (targetFile === null) return null;
      const reExport = targetFile.reExportBindings.get(binding.importedName);
      if (reExport) return index.resolveImportedBinding(targetFile, reExport, depth + 1);
      const nestedImport = targetFile.importBindings.get(binding.importedName);
      if (
        nestedImport !== undefined &&
        !targetFile.stringConstants.has(binding.importedName) &&
        !targetFile.functionsByName.has(binding.importedName) &&
        !targetFile.typeAliases.has(binding.importedName)
      ) {
        return index.resolveImportedBinding(targetFile, nestedImport, depth + 1);
      }
      return { file: targetFile, name: binding.importedName };
    },
  };

  return index;
}

// ---------------------------------------------------------------------------
// String-expression resolution (constants, aliases, helpers, templates)
// ---------------------------------------------------------------------------

/**
 * Resolves an expression to the string value it contributes, following
 * literals, local and imported constants, local helper functions with
 * argument substitution, array-join serializers, and template literals.
 *
 * Returns one of:
 *   { kind: "literal", value }               fully resolved
 *   { kind: "prefix", value }                resolved literal prefix, dynamic tail
 *   { kind: "parameter", fn, index }         caller must substitute
 *   { kind: "unresolved", reason }           fails closed
 */
function resolveStringExpression(expression, context, options = {}) {
  const { file, index, substitutions = new Map(), depth = 0 } = context;
  if (depth > MAX_RESOLVE_DEPTH) return { kind: "unresolved", reason: "resolution depth exceeded" };
  const node = unwrap(expression);

  if (ts.isStringLiteralLike(node)) return { kind: "literal", value: node.text };

  if (ts.isIdentifier(node)) {
    const substituted = substitutions.get(node.text);
    if (substituted !== undefined) {
      return resolveStringExpression(
        substituted.expression,
        {
          file: substituted.file,
          index,
          substitutions: substituted.substitutions ?? new Map(),
          depth: depth + 1,
        },
        options,
      );
    }
    const fn = enclosingFunction(node);
    if (fn !== undefined) {
      const position = parameterIndex(fn, node.text);
      if (position >= 0) return { kind: "parameter", fn, index: position };
    }
    const constant = file.stringConstants.get(node.text);
    if (constant) return { kind: "literal", value: constant.value };
    if (constant === null) return { kind: "unresolved", reason: `ambiguous constant '${node.text}'` };
    const imported = file.importBindings.get(node.text);
    if (imported !== undefined) {
      const target = index.resolveImportedBinding(file, imported);
      if (target === null) return { kind: "unresolved", reason: `unresolved import '${node.text}'` };
      const targetConstant = target.file.stringConstants.get(target.name);
      if (targetConstant) return { kind: "literal", value: targetConstant.value };
      return { kind: "unresolved", reason: `imported '${node.text}' is not a string constant` };
    }
    return { kind: "unresolved", reason: `unbound identifier '${node.text}'` };
  }

  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const resolved = resolveStringExpression(span.expression, { file, index, substitutions, depth: depth + 1 });
      if (resolved.kind === "literal") {
        value += resolved.value + span.literal.text;
        continue;
      }
      if (resolved.kind === "parameter" && value === "") return resolved;
      if (options.allowDynamicTail === true) return { kind: "prefix", value };
      return { kind: "unresolved", reason: `dynamic template span (${resolved.reason ?? resolved.kind})` };
    }
    return { kind: "literal", value };
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveStringExpression(node.whenTrue, { file, index, substitutions, depth: depth + 1 }, options);
    const whenFalse = resolveStringExpression(
      node.whenFalse,
      { file, index, substitutions, depth: depth + 1 },
      options,
    );
    if (whenTrue.kind === "literal" && whenFalse.kind === "literal" && whenTrue.value === whenFalse.value) {
      return whenTrue;
    }
    return { kind: "unresolved", reason: "conditional expression with divergent values" };
  }

  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);

    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join") {
      const target = unwrap(callee.expression);
      const arrayLiteral = ts.isArrayLiteralExpression(target)
        ? target
        : ts.isIdentifier(target)
          ? (file.arrayConstants.get(target.text)?.node ?? null)
          : null;
      if (arrayLiteral !== null && arrayLiteral.elements.length > 0) {
        return resolveStringExpression(
          arrayLiteral.elements[0],
          { file, index, substitutions, depth: depth + 1 },
          options,
        );
      }
      return { kind: "unresolved", reason: "join target is not a resolvable array literal" };
    }

    if (ts.isIdentifier(callee)) {
      const local = file.functionsByName.get(callee.text);
      const target =
        local != null && local.node !== undefined
          ? { file, fn: local.node }
          : (() => {
              const imported = file.importBindings.get(callee.text);
              if (imported === undefined) return null;
              const resolvedImport = index.resolveImportedBinding(file, imported);
              if (resolvedImport === null) return null;
              const fn = resolvedImport.file.functionsByName.get(resolvedImport.name);
              return fn != null && fn.node !== undefined ? { file: resolvedImport.file, fn: fn.node } : null;
            })();
      if (target === null) return { kind: "unresolved", reason: `unresolved call target '${callee.text}'` };

      const nextSubstitutions = new Map();
      target.fn.parameters.forEach((parameter, position) => {
        if (!ts.isIdentifier(parameter.name)) return;
        const argument = node.arguments[position];
        if (argument === undefined) return;
        nextSubstitutions.set(parameter.name.text, { expression: argument, file, substitutions });
      });

      const resolvedReturns = returnExpressions(target.fn).map((expression) =>
        resolveStringExpression(
          expression,
          { file: target.file, index, substitutions: nextSubstitutions, depth: depth + 1 },
          options,
        ),
      );
      const usable = resolvedReturns.filter((entry) => entry.kind === "literal" || entry.kind === "prefix");
      if (usable.length > 0) {
        const distinct = new Set(usable.map((entry) => `${entry.kind}:${entry.value}`));
        if (distinct.size === 1) return usable[0];
        return { kind: "unresolved", reason: `call to '${callee.text}' returns divergent strings` };
      }
      const parameterReturn = resolvedReturns.find((entry) => entry.kind === "parameter");
      if (parameterReturn !== undefined) return parameterReturn;
      return { kind: "unresolved", reason: `call to '${callee.text}' has no resolvable string return` };
    }

    return { kind: "unresolved", reason: "unsupported call shape" };
  }

  return { kind: "unresolved", reason: `unsupported expression kind ${ts.SyntaxKind[node.kind]}` };
}

// ---------------------------------------------------------------------------
// Contextual type identity (used by the CacheStorage and social families)
// ---------------------------------------------------------------------------

function typeReferenceName(typeNode) {
  if (typeNode !== undefined && ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeNode.typeName.text;
  }
  return undefined;
}

function resolveTypeMembers(typeNode, file, index, depth = 0) {
  if (typeNode === undefined || depth > 6) return undefined;
  if (ts.isTypeLiteralNode(typeNode)) return { members: typeNode.members, file };
  if (ts.isInterfaceDeclaration(typeNode)) return { members: typeNode.members, file };
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeReferenceName(typeNode);
    if (name === undefined) return undefined;
    if ((name === "Readonly" || name === "Partial" || name === "Required") && typeNode.typeArguments?.length) {
      return resolveTypeMembers(typeNode.typeArguments[0], file, index, depth + 1);
    }
    const alias = file.typeAliases.get(name);
    if (alias !== undefined) return resolveTypeMembers(alias, file, index, depth + 1);
    const imported = file.importBindings.get(name);
    if (imported !== undefined) {
      const target = index.resolveImportedBinding(file, imported);
      const targetAlias = target?.file.typeAliases.get(target.name);
      if (targetAlias !== undefined) return resolveTypeMembers(targetAlias, target.file, index, depth + 1);
    }
  }
  return undefined;
}

function callTargetOf(callExpression, file, index) {
  const callee = unwrap(callExpression.expression);
  if (!ts.isIdentifier(callee)) return null;
  const local = file.functionsByName.get(callee.text);
  if (local != null && local.node !== undefined) return { file, fn: local.node };
  const imported = file.importBindings.get(callee.text);
  if (imported === undefined) return null;
  const resolved = index.resolveImportedBinding(file, imported);
  const fn = resolved?.file.functionsByName.get(resolved.name);
  return fn != null && fn.node !== undefined ? { file: resolved.file, fn: fn.node } : null;
}

/** The declared type node an object literal is contextually checked against:
 *  a `satisfies`/`as` annotation, a declaration annotation, or the parameter
 *  type of the call it is passed to. Nested literals resolve through their
 *  parent literal's member type. */
function contextualTypeNodeOfObjectLiteral(objectLiteral, file, index, depth = 0) {
  if (depth > 6) return undefined;
  let current = objectLiteral.parent;
  let hops = 0;
  while (current !== undefined && hops < 6) {
    hops += 1;
    if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
      // `as const` is an assertion about literal-ness, not a nominal type
      // identity, so keep walking out to the real `satisfies`/annotation.
      const name = typeReferenceName(current.type);
      if (name !== undefined && name !== "const") return { typeNode: current.type, file };
      current = current.parent;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.parent;
      continue;
    }
    if (ts.isVariableDeclaration(current)) {
      return current.type === undefined ? undefined : { typeNode: current.type, file };
    }
    if (ts.isCallExpression(current)) {
      const argumentIndex = current.arguments.findIndex((argument) => unwrap(argument) === unwrap(objectLiteral));
      if (argumentIndex < 0) return undefined;
      const target = callTargetOf(current, file, index);
      const parameter = target?.fn.parameters[argumentIndex];
      return parameter?.type === undefined ? undefined : { typeNode: parameter.type, file: target.file };
    }
    if (ts.isPropertyAssignment(current) || ts.isMethodDeclaration(current)) {
      const propertyName = ts.isIdentifier(current.name)
        ? current.name.text
        : ts.isStringLiteralLike(current.name)
          ? current.name.text
          : undefined;
      const parentLiteral = current.parent;
      if (propertyName === undefined || !ts.isObjectLiteralExpression(parentLiteral)) return undefined;
      const parentType = contextualTypeNodeOfObjectLiteral(parentLiteral, file, index, depth + 1);
      const resolved = resolveTypeMembers(parentType?.typeNode, parentType?.file ?? file, index);
      const member = resolved?.members.find(
        (entry) =>
          (ts.isPropertySignature(entry) || ts.isMethodSignature(entry)) &&
          entry.name !== undefined &&
          ts.isIdentifier(entry.name) &&
          entry.name.text === propertyName,
      );
      if (member === undefined) return undefined;
      const memberType = ts.isPropertySignature(member) ? member.type : undefined;
      if (memberType !== undefined && ts.isFunctionTypeNode(memberType)) {
        return { typeNode: memberType.type, file: resolved.file };
      }
      if (ts.isMethodSignature(member) && member.type !== undefined) {
        return { typeNode: member.type, file: resolved.file };
      }
      return memberType === undefined ? undefined : { typeNode: memberType, file: resolved.file };
    }
    return undefined;
  }
  return undefined;
}

/** The declared type identity a returned object literal is checked against:
 *  the enclosing function's return annotation, or — for an unannotated
 *  callback — the contextual member type of the object literal that owns it. */
function returnedObjectTypeIdentity(objectLiteral, file, index) {
  const direct = contextualTypeNodeOfObjectLiteral(objectLiteral, file, index);
  const directName = typeReferenceName(direct?.typeNode);
  if (directName !== undefined) return directName;

  const fn = enclosingFunction(objectLiteral);
  if (fn === undefined) return undefined;
  const annotated = typeReferenceName(fn.type);
  if (annotated !== undefined) return annotated;

  // A method shorthand IS the object-literal member; an arrow/function
  // expression is the initializer of a property assignment.
  const owner = ts.isMethodDeclaration(fn) ? fn : fn.parent;
  if (owner !== undefined && (ts.isPropertyAssignment(owner) || ts.isMethodDeclaration(owner))) {
    const parentLiteral = owner.parent;
    if (ts.isObjectLiteralExpression(parentLiteral)) {
      const propertyName = ts.isIdentifier(owner.name)
        ? owner.name.text
        : ts.isStringLiteralLike(owner.name)
          ? owner.name.text
          : undefined;
      const parentType = contextualTypeNodeOfObjectLiteral(parentLiteral, file, index);
      const resolved = resolveTypeMembers(parentType?.typeNode, parentType?.file ?? file, index);
      const member = resolved?.members.find(
        (entry) =>
          (ts.isPropertySignature(entry) || ts.isMethodSignature(entry)) &&
          entry.name !== undefined &&
          ts.isIdentifier(entry.name) &&
          entry.name.text === propertyName,
      );
      if (member !== undefined) {
        const memberType = ts.isPropertySignature(member) ? member.type : member.type;
        if (memberType !== undefined && ts.isFunctionTypeNode(memberType)) return typeReferenceName(memberType.type);
        return typeReferenceName(memberType);
      }
    }
  }
  return undefined;
}

function literalPropertyValue(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteralLike(property.name)
        ? property.name.text
        : undefined;
    if (name !== propertyName) continue;
    const value = unwrap(property.initializer);
    if (ts.isStringLiteralLike(value)) return { kind: "string", value: value.text };
    if (ts.isArrayLiteralExpression(value)) {
      const entries = value.elements.map((element) => unwrap(element));
      return entries.every((element) => ts.isStringLiteralLike(element))
        ? { kind: "array", value: entries.map((element) => element.text) }
        : { kind: "unresolved" };
    }
    return { kind: "unresolved" };
  }
  return { kind: "absent" };
}

function objectLiteralPropertyNames(objectLiteral) {
  const names = [];
  let computed = false;
  for (const property of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)
    ) {
      const name = property.name;
      if (name !== undefined && ts.isIdentifier(name)) names.push(name.text);
      else if (name !== undefined && ts.isStringLiteralLike(name)) names.push(name.text);
      else computed = true;
    } else {
      computed = true;
    }
  }
  return { names, computed };
}

// ---------------------------------------------------------------------------
// Family 1: first-party cookies
// ---------------------------------------------------------------------------

const cookieHeaderName = "set-cookie";
const cookieSignal = (source) => /set-cookie/i.test(source) || source.includes("document.cookie");

function collectCookieWriteSites(file) {
  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const first = node.arguments[0] === undefined ? undefined : unwrap(node.arguments[0]);
      if (
        (method === "append" || method === "set") &&
        node.arguments.length >= 2 &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        first.text.toLowerCase() === cookieHeaderName
      ) {
        sites.push({ node, valueExpression: node.arguments[1], shape: `headers-${method}` });
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      const nameText = ts.isStringLiteralLike(name) ? name.text : ts.isIdentifier(name) ? name.text : undefined;
      if (nameText !== undefined && nameText.toLowerCase() === cookieHeaderName) {
        sites.push({ node, valueExpression: node.initializer, shape: "headers-init-property" });
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "cookie"
    ) {
      const receiver = unwrap(node.left.expression);
      if (ts.isIdentifier(receiver) && receiver.text === "document") {
        sites.push({ node, valueExpression: node.right, shape: "document-cookie" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.sourceFile);
  return sites;
}

function findCallSitesOfFunction(index, ownerFile, functionName) {
  const sites = [];
  for (const file of index.filesMatching((source) => source.includes(functionName))) {
    const localNames = new Set();
    if (file === ownerFile && file.functionsByName.has(functionName)) localNames.add(functionName);
    for (const [localName, binding] of file.importBindings) {
      if (binding.importedName !== functionName) continue;
      const resolved = index.resolveImportedBinding(file, binding);
      if (resolved !== null && resolved.file === ownerFile) localNames.add(localName);
    }
    if (localNames.size === 0) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee) && localNames.has(callee.text)) sites.push({ file, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }
  return sites;
}

function deriveFirstPartyCookies(index) {
  const subjects = new Map();
  const indeterminate = [];
  const pending = [];

  const noteSubject = (value, file, node, kind) => {
    const entry = subjects.get(value) ?? {
      subject: value,
      writeSites: new Set(),
      aliases: new Set(),
      shapes: new Set(),
      trackedGenerated: false,
    };
    const ref = evidenceRef(file, node);
    if (kind.startsWith("name-binding")) entry.aliases.add(ref);
    else entry.writeSites.add(ref);
    entry.shapes.add(kind);
    if (file.trackedGenerated) entry.trackedGenerated = true;
    subjects.set(value, entry);
  };

  const resolveWrite = (file, valueExpression, node, shape) => {
    const resolved = resolveStringExpression(valueExpression, { file, index }, { allowDynamicTail: true });
    if (resolved.kind === "literal" || resolved.kind === "prefix") {
      const name = resolved.value.split("=")[0].trim();
      if (name.length === 0) {
        indeterminate.push({
          factFamily: "first-party-cookie",
          reason: `cookie write at ${evidenceRef(file, node)} resolved to an empty cookie name`,
        });
        return;
      }
      noteSubject(name, file, node, shape);
      return;
    }
    if (resolved.kind === "parameter") {
      const owner = functionLikeName(resolved.fn);
      if (owner === undefined) {
        indeterminate.push({
          factFamily: "first-party-cookie",
          reason: `cookie write at ${evidenceRef(file, node)} flows from an anonymous helper parameter`,
        });
        return;
      }
      pending.push({ file, functionName: owner, parameterIndex: resolved.index });
      return;
    }
    indeterminate.push({
      factFamily: "first-party-cookie",
      reason: `cookie write at ${evidenceRef(file, node)} has an unresolved cookie name (${resolved.reason})`,
    });
  };

  for (const file of index.filesMatching(cookieSignal)) {
    for (const site of collectCookieWriteSites(file)) {
      resolveWrite(file, site.valueExpression, site.node, site.shape);
    }
  }

  const visitedHelpers = new Set();
  while (pending.length > 0) {
    const helper = pending.shift();
    const key = `${helper.file.relativePath}#${helper.functionName}#${helper.parameterIndex}`;
    if (visitedHelpers.has(key)) continue;
    visitedHelpers.add(key);
    const callSites = findCallSitesOfFunction(index, helper.file, helper.functionName);
    if (callSites.length === 0) {
      indeterminate.push({
        factFamily: "first-party-cookie",
        reason: `cookie-writing helper '${helper.functionName}' in ${helper.file.relativePath} has no resolvable call site`,
      });
      continue;
    }
    for (const site of callSites) {
      const argument = site.node.arguments[helper.parameterIndex];
      if (argument === undefined) {
        indeterminate.push({
          factFamily: "first-party-cookie",
          reason: `call to '${helper.functionName}' at ${evidenceRef(site.file, site.node)} omits the cookie-name argument`,
        });
        continue;
      }
      resolveWrite(site.file, argument, site.node, "cookie-writer-helper-call");
    }
  }

  // Reconcile every literal/aliased name constant that carries a derived
  // subject, so duplicate aliases collapse onto one shipped subject instead of
  // inflating the inventory.
  const derivedValues = new Set(subjects.keys());
  if (derivedValues.size > 0) {
    for (const file of index.filesMatching((source) => [...derivedValues].some((value) => source.includes(value)))) {
      for (const [name, constant] of file.stringConstants) {
        if (constant === null || !derivedValues.has(constant.value)) continue;
        noteSubject(constant.value, file, constant.declaration, `name-binding:${name}`);
      }
    }
  }

  const facts = [...subjects.values()]
    .map((entry) => ({
      factFamily: "first-party-cookie",
      subject: entry.subject,
      evidenceRefs: [...new Set([...entry.writeSites, ...entry.aliases])].sort(),
      derivationShapes: [...entry.shapes].sort(),
      trackedGeneratedDerived: entry.trackedGenerated,
      detail: {
        writeSites: [...entry.writeSites].sort(),
        aliasDeclarations: [...entry.aliases].sort(),
        aliasCount: entry.aliases.size,
      },
    }))
    .sort((left, right) => left.subject.localeCompare(right.subject));

  return { facts, indeterminate };
}

// ---------------------------------------------------------------------------
// Family 2: Web Storage
// ---------------------------------------------------------------------------

const webStorageMethods = new Set(["getItem", "setItem", "removeItem"]);
const webStorageAreaByProperty = new Map([
  ["localStorage", "localStorage"],
  ["sessionStorage", "sessionStorage"],
]);
const webStorageSignal = (source) =>
  source.includes(".getItem(") || source.includes(".setItem(") || source.includes(".removeItem(");

function storageTypeShapeOf(typeNode, file, index, depth = 0) {
  if (typeNode === undefined || depth > 5) return undefined;
  if (ts.isUnionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      const shape = storageTypeShapeOf(member, file, index, depth + 1);
      if (shape !== undefined) return shape;
    }
    return undefined;
  }
  if (!ts.isTypeReferenceNode(typeNode)) return undefined;
  const name = typeReferenceName(typeNode);
  if (name === "Storage") return "injected-storage";
  if (name === "Pick" && typeNode.typeArguments?.length) {
    const first = typeNode.typeArguments[0];
    if (typeReferenceName(first) === "Storage") return "injected-pick-storage";
  }
  if (name === undefined) return undefined;
  const alias = file.typeAliases.get(name);
  if (alias !== undefined && !ts.isInterfaceDeclaration(alias)) {
    return storageTypeShapeOf(alias, file, index, depth + 1);
  }
  const imported = file.importBindings.get(name);
  if (imported !== undefined) {
    const target = index.resolveImportedBinding(file, imported);
    const targetAlias = target?.file.typeAliases.get(target.name);
    if (targetAlias !== undefined && !ts.isInterfaceDeclaration(targetAlias)) {
      return storageTypeShapeOf(targetAlias, target.file, index, depth + 1);
    }
  }
  return undefined;
}

function findLocalVariableDeclaration(node, name) {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const statement of current.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

function storageAreaFromHelperBody(fn) {
  for (const expression of returnExpressions(fn)) {
    const stack = [expression];
    while (stack.length > 0) {
      const node = unwrap(stack.pop());
      if (ts.isPropertyAccessExpression(node)) {
        const area = webStorageAreaByProperty.get(node.name.text);
        if (area !== undefined) return area;
      }
      if (ts.isConditionalExpression(node)) stack.push(node.whenTrue, node.whenFalse);
      if (ts.isBinaryExpression(node)) stack.push(node.left, node.right);
    }
  }
  return undefined;
}

/**
 * Classifies the receiver of a `getItem`/`setItem`/`removeItem` call.
 * `{ area, shape }` means the receiver is a Web Storage handle;
 * `{ storageShaped: true, unresolved }` means it looks like a storage handle
 * but cannot be resolved, which fails closed; `{ storageShaped: false }` means
 * the call is outside this family entirely.
 */
function classifyStorageReceiver(receiver, file, index) {
  const node = unwrap(receiver);

  if (ts.isPropertyAccessExpression(node)) {
    const area = webStorageAreaByProperty.get(node.name.text);
    if (area !== undefined) return { area, shape: "direct-member-access" };
    return { storageShaped: /storage/i.test(node.name.text), unresolved: `property '${node.name.text}'` };
  }

  if (ts.isIdentifier(node)) {
    const area = webStorageAreaByProperty.get(node.text);
    if (area !== undefined) return { area, shape: "global-binding" };

    const fn = enclosingFunction(node);
    const parameter = fn?.parameters.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === node.text,
    );
    if (parameter !== undefined) {
      const shape = storageTypeShapeOf(parameter.type, file, index);
      if (shape !== undefined) return { area: "injected", shape };
      const annotation = parameter.type?.getText(file.sourceFile) ?? "";
      return { storageShaped: /Storage/.test(annotation), unresolved: `parameter '${node.text}'` };
    }

    const declaration = findLocalVariableDeclaration(node, node.text);
    if (declaration !== undefined) {
      const annotated = storageTypeShapeOf(declaration.type, file, index);
      if (annotated !== undefined) return { area: "injected", shape: annotated };
      const initializer = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
      if (initializer !== undefined && ts.isPropertyAccessExpression(initializer)) {
        const aliasedArea = webStorageAreaByProperty.get(initializer.name.text);
        if (aliasedArea !== undefined) return { area: aliasedArea, shape: "aliased-member-access" };
      }
      if (initializer !== undefined && ts.isCallExpression(initializer)) {
        const callee = unwrap(initializer.expression);
        if (ts.isIdentifier(callee)) {
          const helper = file.functionsByName.get(callee.text);
          if (helper != null && helper.node !== undefined) {
            const helperShape = storageTypeShapeOf(helper.node.type, file, index);
            const helperArea = storageAreaFromHelperBody(helper.node);
            if (helperShape !== undefined || helperArea !== undefined) {
              return { area: helperArea ?? "injected", shape: "local-storage-helper" };
            }
          }
        }
      }
      const annotation = declaration.type?.getText(file.sourceFile) ?? "";
      return {
        storageShaped: /Storage/.test(annotation) || /storage/i.test(node.text),
        unresolved: `local binding '${node.text}'`,
      };
    }

    return { storageShaped: /storage/i.test(node.text), unresolved: `unbound receiver '${node.text}'` };
  }

  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee)) {
      const helper = file.functionsByName.get(callee.text);
      if (helper != null && helper.node !== undefined) {
        const helperShape = storageTypeShapeOf(helper.node.type, file, index);
        const helperArea = storageAreaFromHelperBody(helper.node);
        if (helperShape !== undefined || helperArea !== undefined) {
          return { area: helperArea ?? "injected", shape: "local-storage-helper" };
        }
      }
      return { storageShaped: /storage/i.test(callee.text), unresolved: `call to '${callee.text}'` };
    }
  }

  return { storageShaped: false, unresolved: `receiver kind ${ts.SyntaxKind[node.kind]}` };
}

function deriveWebStorage(index) {
  const subjects = new Map();
  const indeterminate = [];

  for (const file of index.filesMatching(webStorageSignal)) {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        webStorageMethods.has(node.expression.name.text) &&
        node.arguments.length >= 1
      ) {
        const method = node.expression.name.text;
        const ref = evidenceRef(file, node);
        const receiver = classifyStorageReceiver(node.expression.expression, file, index);
        if (receiver.area !== undefined) {
          const key = resolveStringExpression(node.arguments[0], { file, index }, { allowDynamicTail: true });
          if (key.kind === "literal" || key.kind === "prefix") {
            const subject = key.kind === "literal" ? key.value : `${key.value}*`;
            if (subject.trim().length === 0 || subject === "*") {
              indeterminate.push({
                factFamily: "web-storage",
                reason: `Web Storage ${method} at ${ref} resolved to an empty key`,
              });
            } else {
              const entry = subjects.get(subject) ?? {
                subject,
                areas: new Set(),
                shapes: new Set(),
                operations: new Set(),
                refs: new Set(),
                dynamic: false,
                trackedGenerated: false,
              };
              entry.areas.add(receiver.area);
              entry.shapes.add(receiver.shape);
              entry.operations.add(method);
              entry.refs.add(ref);
              entry.dynamic = entry.dynamic || key.kind === "prefix";
              if (file.trackedGenerated) entry.trackedGenerated = true;
              subjects.set(subject, entry);
            }
          } else {
            indeterminate.push({
              factFamily: "web-storage",
              reason: `Web Storage ${method} at ${ref} has an unresolved key (${key.reason})`,
            });
          }
        } else if (receiver.storageShaped === true) {
          indeterminate.push({
            factFamily: "web-storage",
            reason: `Web Storage ${method} at ${ref} has a Storage-shaped but unresolved receiver (${receiver.unresolved})`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }

  const facts = [...subjects.values()]
    .map((entry) => ({
      factFamily: "web-storage",
      subject: entry.subject,
      evidenceRefs: [...entry.refs].sort(),
      derivationShapes: [...entry.shapes].sort(),
      trackedGeneratedDerived: entry.trackedGenerated,
      detail: {
        storageAreas: [...entry.areas].sort(),
        operations: [...entry.operations].sort(),
        dynamicKeyFamily: entry.dynamic,
      },
    }))
    .sort((left, right) => left.subject.localeCompare(right.subject));

  return { facts, indeterminate };
}

// ---------------------------------------------------------------------------
// Family 3: provider-injected client-side storage surface authority
// ---------------------------------------------------------------------------

const cspScriptDirectives = ["script-src", "frame-src"];
const externalOriginPattern = /https:\/\/[a-z0-9.*-]+\.[a-z]{2,}/gi;

function deriveConsumerRouteGraph(index, repoRoot, trackedPaths, consumerDeployables) {
  const importsOf = new Map();
  const externalPackagesOf = new Map();

  for (const [relativePath, source] of index.sourceByPath) {
    const preprocessed = ts.preProcessFile(source, true, true);
    const internal = [];
    const external = new Set();
    for (const reference of preprocessed.importedFiles) {
      const resolved = index.resolveSpecifier(reference.fileName, relativePath);
      if (resolved.kind === "internal") internal.push(resolved.file);
      else if (resolved.kind === "external") external.add(resolved.packageName);
    }
    importsOf.set(relativePath, internal);
    externalPackagesOf.set(relativePath, external);
  }

  const routeModules = new Map();
  const unresolvedRoutes = [];
  for (const manifestPath of trackedPaths.filter((entry) => entry.endsWith("/context.json"))) {
    let manifest;
    try {
      manifest = JSON.parse(readTrackedText(repoRoot, manifestPath));
    } catch {
      continue;
    }
    for (const contribution of manifest.deployableContributions ?? []) {
      if (!consumerDeployables.includes(contribution.deployable)) continue;
      for (const route of contribution.routes ?? []) {
        const specifier = String(route.fileExport ?? "");
        const routePath = `/${String(route.routePath ?? "").replace(/^\//, "")}`;
        const resolved = index.resolveSpecifier(specifier.startsWith(".") ? specifier : `./${specifier}`, manifestPath);
        if (resolved.kind !== "internal") {
          unresolvedRoutes.push({ manifestPath, routePath, specifier });
          continue;
        }
        const paths = routeModules.get(resolved.file) ?? new Set();
        paths.add(routePath);
        routeModules.set(resolved.file, paths);
      }
    }
  }

  const routesByModule = new Map();
  for (const [routeFile, routePaths] of routeModules) {
    const seen = new Set([routeFile]);
    const stack = [routeFile];
    while (stack.length > 0) {
      const current = stack.pop();
      const reached = routesByModule.get(current) ?? new Set();
      for (const routePath of routePaths) reached.add(routePath);
      routesByModule.set(current, reached);
      for (const next of importsOf.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
  }

  return { importsOf, externalPackagesOf, routesByModule, unresolvedRoutes };
}

function deriveCspScriptOrigins(index) {
  const origins = new Map();
  const signal = (source) => cspScriptDirectives.some((directive) => source.includes(directive));
  for (const file of index.filesMatching(signal)) {
    const visit = (node) => {
      if (ts.isStringLiteralLike(node)) {
        const directive = cspScriptDirectives.find((entry) => node.text.startsWith(`${entry} `));
        if (directive !== undefined) {
          for (const match of node.text.matchAll(externalOriginPattern)) {
            const entry = origins.get(match[0]) ?? { origin: match[0], directives: new Set(), refs: new Set() };
            entry.directives.add(directive);
            entry.refs.add(evidenceRef(file, node));
            origins.set(match[0], entry);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }
  return origins;
}

function deriveDirectExternalScriptInjections(index) {
  const injections = [];
  const signal = (source) => source.includes("<script") || /\.src\s*=/.test(source);
  for (const file of index.filesMatching(signal)) {
    const visit = (node) => {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText(file.sourceFile) === "script" &&
        node.attributes.properties.some(
          (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file.sourceFile) === "src",
        )
      ) {
        injections.push({ ref: evidenceRef(file, node), shape: "jsx-script-src" });
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "src"
      ) {
        const value = unwrap(node.right);
        if (ts.isStringLiteralLike(value) && /^https?:\/\//i.test(value.text)) {
          injections.push({ ref: evidenceRef(file, node), shape: "dom-script-src-assignment" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }
  return injections;
}

function deriveProviderInjectedClientStorage(index, graph, externalPackageClassifications) {
  const facts = [];
  const indeterminate = [];
  const observedExternalPackages = new Set();

  const dependencyOwners = new Map();
  for (const pkg of index.workspacePackages.values()) {
    for (const [dependency, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const owners = dependencyOwners.get(dependency) ?? [];
      owners.push({
        workspacePackage: pkg.name,
        manifestPath: pkg.manifestPath,
        declarationRef: dependencyDeclarationRef(pkg, dependency),
        versionRange: range,
      });
      dependencyOwners.set(dependency, owners);
    }
  }

  const cspOrigins = deriveCspScriptOrigins(index);
  const unclassifiedPackages = new Map();

  for (const [relativePath, routes] of [...graph.routesByModule].sort(([left], [right]) => left.localeCompare(right))) {
    const externals = graph.externalPackagesOf.get(relativePath);
    if (externals === undefined) continue;
    for (const packageName of [...externals].sort()) {
      observedExternalPackages.add(packageName);
      const classification = externalPackageClassifications[packageName];
      if (classification === undefined) {
        const modules = unclassifiedPackages.get(packageName) ?? [];
        modules.push(relativePath);
        unclassifiedPackages.set(packageName, modules);
        continue;
      }
      if (classification.kind !== "client-script-loader") continue;

      const file = index.file(relativePath);
      if (file === null) {
        indeterminate.push({
          factFamily: "provider-injected-client-storage",
          reason: `consumer-reachable module ${relativePath} imports client-script loader '${packageName}' but could not be parsed`,
        });
        continue;
      }

      const callSites = [];
      for (const [localName, binding] of file.importBindings) {
        if (binding.typeOnly === true) continue;
        const resolvedSpecifier = index.resolveSpecifier(binding.specifier, relativePath);
        if (resolvedSpecifier.kind !== "external" || resolvedSpecifier.packageName !== packageName) continue;
        const visit = (node) => {
          if (ts.isCallExpression(node)) {
            const callee = unwrap(node.expression);
            if (ts.isIdentifier(callee) && callee.text === localName) {
              callSites.push({ exportName: binding.importedName, ref: evidenceRef(file, node) });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(file.sourceFile);
      }
      if (callSites.length === 0) continue;

      const owners = (dependencyOwners.get(packageName) ?? []).sort((left, right) =>
        left.workspacePackage.localeCompare(right.workspacePackage),
      );
      if (owners.length === 0 || owners.some((owner) => owner.declarationRef === null)) {
        indeterminate.push({
          factFamily: "provider-injected-client-storage",
          reason: `external client-script loader '${packageName}' called from ${relativePath} has no resolvable workspace dependency declaration`,
        });
        continue;
      }
      if (routes.size === 0) {
        indeterminate.push({
          factFamily: "provider-injected-client-storage",
          reason: `external client-script loader '${packageName}' called from ${relativePath} has no resolvable consumer-route reachability`,
        });
        continue;
      }

      const ownedOrigins = (classification.scriptOrigins ?? []).filter((origin) => cspOrigins.has(origin)).sort();
      facts.push({
        factFamily: "provider-injected-client-storage",
        subject: `${packageName}@${relativePath}`,
        evidenceRefs: [
          ...callSites.map((site) => site.ref),
          ...owners.map((owner) => owner.declarationRef),
          ...ownedOrigins.flatMap((origin) => [...(cspOrigins.get(origin)?.refs ?? [])]),
        ]
          .filter((value, position, all) => all.indexOf(value) === position)
          .sort(),
        derivationShapes: ["committed-csp-origin", "external-loader-call", "workspace-dependency-edge"],
        trackedGeneratedDerived: file.trackedGenerated,
        detail: {
          providerPackage: packageName,
          loaderModule: relativePath,
          loaderExports: [...new Set(callSites.map((site) => site.exportName))].sort(),
          loaderCallRefs: callSites.map((site) => site.ref).sort(),
          consumerRoutes: [...routes].sort(),
          dependencyOwners: owners.map((owner) => `${owner.workspacePackage}@${owner.versionRange}`),
          cspScriptOrigins: ownedOrigins,
        },
      });
    }
  }

  for (const [packageName, modules] of [...unclassifiedPackages].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...new Set(modules)].sort();
    indeterminate.push({
      factFamily: "provider-injected-client-storage",
      reason:
        `external package '${packageName}' is imported by ${sorted.length} consumer-reachable production module(s) ` +
        `(for example ${sorted[0]}) but carries no client-surface classification`,
    });
  }

  const declaredOrigins = new Set();
  for (const classification of Object.values(externalPackageClassifications)) {
    if (classification.kind !== "client-script-loader") continue;
    for (const origin of classification.scriptOrigins ?? []) declaredOrigins.add(origin);
  }
  for (const [origin, entry] of cspOrigins) {
    if (declaredOrigins.has(origin)) continue;
    indeterminate.push({
      factFamily: "provider-injected-client-storage",
      reason: `committed CSP ${[...entry.directives].sort().join("/")} origin '${origin}' (${[...entry.refs].sort().join(", ")}) is not owned by any classified external client-script loader`,
    });
  }

  for (const injection of deriveDirectExternalScriptInjections(index)) {
    indeterminate.push({
      factFamily: "provider-injected-client-storage",
      reason: `direct external script injection (${injection.shape}) at ${injection.ref} is not covered by a classified external client-script loader`,
    });
  }

  for (const route of graph.unresolvedRoutes) {
    indeterminate.push({
      factFamily: "provider-injected-client-storage",
      reason: `consumer route '${route.routePath}' declared in ${route.manifestPath} does not resolve to a tracked module (${route.specifier})`,
    });
  }

  return {
    facts: facts.sort((left, right) => left.subject.localeCompare(right.subject)),
    indeterminate,
    observedExternalPackages: [...observedExternalPackages].sort(),
    cspScriptOrigins: [...cspOrigins.keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// Family 4: CacheStorage (typed ServiceWorkerPolicy literals)
// ---------------------------------------------------------------------------

const serviceWorkerPolicyTypeName = "ServiceWorkerPolicy";
const serviceWorkerRegistrationExport = "registerAppServiceWorker";

function deployableOf(relativePath) {
  const match = /^deployables\/([^/]+)\//.exec(relativePath);
  return match === null ? null : match[1];
}

function declaringVariableName(node) {
  let current = node.parent;
  let hops = 0;
  while (current !== undefined && hops < 6) {
    hops += 1;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function deriveDeployableRoutePaths(index) {
  const routePaths = new Map();
  for (const file of index.filesMatching((_source, relativePath) =>
    /^deployables\/[^/]+\/app\/routes\.ts$/.test(relativePath),
  )) {
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.arguments.length >= 2) {
        const callee = unwrap(node.expression);
        const routePath = unwrap(node.arguments[0]);
        const moduleSpecifier = unwrap(node.arguments[1]);
        if (
          ts.isIdentifier(callee) &&
          callee.text === "route" &&
          ts.isStringLiteralLike(routePath) &&
          ts.isStringLiteralLike(moduleSpecifier)
        ) {
          const resolved = index.resolveSpecifier(`./${moduleSpecifier.text}`, file.relativePath);
          if (resolved.kind === "internal") {
            routePaths.set(resolved.file, { routePath: `/${routePath.text.replace(/^\//, "")}` });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }
  return routePaths;
}

function registrationIsProductionGuarded(runtimeFile) {
  const entry = runtimeFile.functionsByName.get(serviceWorkerRegistrationExport);
  if (entry == null || entry.node === undefined || entry.node.body === undefined) return false;
  let guarded = false;
  const visit = (node) => {
    if (ts.isIfStatement(node)) {
      const condition = node.expression.getText(runtimeFile.sourceFile).trim();
      if (condition.startsWith("!") && /isProductionBuild\(\)/.test(condition)) guarded = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(entry.node.body);
  return guarded;
}

function findServiceWorkerRegistrationRoots(index) {
  const roots = [];
  for (const file of index.filesMatching((source) => /serviceworker/i.test(source))) {
    for (const [localName, binding] of file.importBindings) {
      if (binding.typeOnly === true) continue;
      const resolved = index.resolveImportedBinding(file, binding);
      if (resolved === null || resolved.name !== serviceWorkerRegistrationExport) continue;
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          const callee = unwrap(node.expression);
          if (ts.isIdentifier(callee) && callee.text === localName) {
            roots.push({
              relativePath: file.relativePath,
              ref: evidenceRef(file, node),
              deployable: deployableOf(file.relativePath),
              productionGuarded: registrationIsProductionGuarded(resolved.file),
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.sourceFile);
    }
  }
  return roots;
}

function findServiceWorkerComposition(policyFile, policyName) {
  if (policyName === undefined) return {};
  let result = {};
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = unwrap(node.expression);
      const argument = unwrap(node.arguments[0]);
      if (
        ts.isIdentifier(callee) &&
        callee.text === "buildServiceWorkerSource" &&
        ts.isIdentifier(argument) &&
        argument.text === policyName
      ) {
        result = {
          ref: evidenceRef(policyFile, node),
          sourceExport: declaringVariableName(node),
          sourceModule: policyFile.relativePath,
        };
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(policyFile.sourceFile);
  return result;
}

function findServiceWorkerRoute(index, composition, routePaths) {
  if (composition.sourceExport === undefined) return null;
  for (const file of index.filesMatching((source) => source.includes(composition.sourceExport))) {
    for (const [localName, binding] of file.importBindings) {
      if (binding.importedName !== composition.sourceExport) continue;
      const resolved = index.resolveImportedBinding(file, binding);
      if (resolved === null || resolved.file.relativePath !== composition.sourceModule) continue;
      let found = null;
      const visit = (node) => {
        if (ts.isCallExpression(node) && node.arguments.length >= 1) {
          const callee = unwrap(node.expression);
          const argument = unwrap(node.arguments[0]);
          if (
            ts.isIdentifier(callee) &&
            callee.text.endsWith("ServiceWorkerRoute") &&
            ts.isIdentifier(argument) &&
            argument.text === localName
          ) {
            found = { ref: evidenceRef(file, node), routePath: routePaths.get(file.relativePath)?.routePath ?? null };
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.sourceFile);
      if (found !== null && found.routePath !== null) return found;
    }
  }
  return null;
}

function deriveCacheStorage(index) {
  const facts = [];
  const indeterminate = [];
  const routePaths = deriveDeployableRoutePaths(index);
  const registrationRoots = findServiceWorkerRegistrationRoots(index);

  for (const file of index.filesMatching((source) => source.includes(serviceWorkerPolicyTypeName))) {
    const literals = [];
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const identity = contextualTypeNodeOfObjectLiteral(node, file, index);
        if (typeReferenceName(identity?.typeNode) === serviceWorkerPolicyTypeName) literals.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);

    for (const literal of literals) {
      const ref = evidenceRef(file, literal);
      const cacheName = literalPropertyValue(literal, "cacheName");
      if (cacheName.kind !== "string" || cacheName.value.trim().length === 0) {
        indeterminate.push({
          factFamily: "cache-storage",
          reason: `typed ServiceWorkerPolicy at ${ref} has a nonliteral or empty cacheName`,
        });
        continue;
      }

      const policyName = declaringVariableName(literal);
      const deployable = deployableOf(file.relativePath);
      const composition = findServiceWorkerComposition(file, policyName);
      const workerRoute = findServiceWorkerRoute(index, composition, routePaths);
      const registration = registrationRoots.find((root) => root.deployable === deployable) ?? null;

      const problems = [];
      if (deployable === null) problems.push("the policy is not owned by a deployable");
      if (policyName === undefined) problems.push("the policy literal is not bound to a named declaration");
      if (composition.sourceExport === undefined)
        problems.push("the policy is not composed by buildServiceWorkerSource");
      if (workerRoute === null) problems.push("the policy has no createServiceWorkerRoute worker route");
      if (registration === null) problems.push("the policy has no root registration call");
      else if (registration.productionGuarded !== true)
        problems.push("the root registration is not production-build guarded");

      const excludedExactPaths = literalPropertyValue(literal, "excludedExactPaths");
      const excludedPathPrefixes = literalPropertyValue(literal, "excludedPathPrefixes");
      const coreAssets = literalPropertyValue(literal, "coreAssets");
      const credentialed = literalPropertyValue(literal, "credentialedRequestHandling");
      if (
        excludedExactPaths.kind !== "array" ||
        excludedPathPrefixes.kind !== "array" ||
        coreAssets.kind !== "array" ||
        (credentialed.kind !== "string" && credentialed.kind !== "absent")
      ) {
        problems.push("the policy has a nonliteral policy field");
      }

      if (problems.length > 0) {
        indeterminate.push({
          factFamily: "cache-storage",
          reason: `CacheStorage subject '${cacheName.value}' at ${ref} is unclassified: ${problems.join("; ")}`,
        });
        continue;
      }

      facts.push({
        factFamily: "cache-storage",
        subject: cacheName.value,
        evidenceRefs: [ref, composition.ref, workerRoute.ref, registration.ref].sort(),
        derivationShapes: ["root-registration", "typed-service-worker-policy", "worker-route"],
        trackedGeneratedDerived: file.trackedGenerated,
        detail: {
          deployable,
          policyModule: file.relativePath,
          credentialedRequestHandling: credentialed.kind === "string" ? credentialed.value : "allow",
          excludedExactPaths: excludedExactPaths.value,
          excludedPathPrefixes: excludedPathPrefixes.value,
          coreAssets: coreAssets.value,
          workerRoutePath: workerRoute.routePath,
          registrationRoot: registration.relativePath,
          registeredOnlyInProductionBuilds: registration.productionGuarded,
        },
      });
    }
  }

  return { facts: facts.sort((left, right) => left.subject.localeCompare(right.subject)), indeterminate };
}

// ---------------------------------------------------------------------------
// Family 5: social-login provider profile mappings
// ---------------------------------------------------------------------------

const socialLoginProfileTypeName = "SocialLoginProfile";

function enclosingExportedFunctionName(node, file) {
  let current = node.parent;
  while (current !== undefined) {
    if (isFunctionLike(current)) {
      const name = ts.isFunctionDeclaration(current) ? current.name?.text : functionLikeName(current);
      if (name !== undefined && file.exportedNames.has(name)) return name;
    }
    current = current.parent;
  }
  return undefined;
}

function deriveSocialProviderProfiles(index) {
  const subjects = new Map();
  const indeterminate = [];

  for (const file of index.filesMatching((source) => source.includes(socialLoginProfileTypeName))) {
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const identity = returnedObjectTypeIdentity(node, file, index);
        if (identity === socialLoginProfileTypeName) {
          const providerName = literalPropertyValue(node, "providerName");
          const { names, computed } = objectLiteralPropertyNames(node);
          const ref = evidenceRef(file, node);
          if (providerName.kind !== "string") {
            if (providerName.kind === "absent") {
              // A SocialLoginProfile literal that carries no provider identity
              // cannot be attributed to a shipped provider.
              indeterminate.push({
                factFamily: "social-provider-profile",
                reason: `SocialLoginProfile mapping at ${ref} declares no providerName`,
              });
            } else {
              indeterminate.push({
                factFamily: "social-provider-profile",
                reason: `SocialLoginProfile mapping at ${ref} has a nonliteral providerName`,
              });
            }
            return;
          }
          if (computed) {
            indeterminate.push({
              factFamily: "social-provider-profile",
              reason: `SocialLoginProfile mapping at ${ref} has a computed or spread output field`,
            });
            return;
          }
          const entry = subjects.get(providerName.value) ?? {
            subject: providerName.value,
            fields: new Set(),
            refs: new Set(),
            owners: new Set(),
            trackedGenerated: false,
          };
          for (const name of names) entry.fields.add(name);
          entry.refs.add(ref);
          const owner = enclosingExportedFunctionName(node, file);
          if (owner !== undefined) entry.owners.add(`${file.relativePath}#${owner}`);
          if (file.trackedGenerated) entry.trackedGenerated = true;
          subjects.set(providerName.value, entry);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }

  const facts = [];
  for (const entry of [...subjects.values()].sort((left, right) => left.subject.localeCompare(right.subject))) {
    const registrations = new Set();
    for (const owner of entry.owners) {
      const [ownerPath, ownerName] = owner.split("#");
      const ownerFile = index.file(ownerPath);
      if (ownerFile === null) continue;
      for (const site of findCallSitesOfFunction(index, ownerFile, ownerName)) {
        registrations.add(evidenceRef(site.file, site.node));
      }
    }
    if (registrations.size === 0) {
      indeterminate.push({
        factFamily: "social-provider-profile",
        reason: `social provider '${entry.subject}' has a SocialLoginProfile mapping but no executable registration call site`,
      });
      continue;
    }
    facts.push({
      factFamily: "social-provider-profile",
      subject: entry.subject,
      evidenceRefs: [...new Set([...entry.refs, ...registrations])].sort(),
      derivationShapes: ["executable-registration", "provider-profile-mapper"],
      trackedGeneratedDerived: entry.trackedGenerated,
      detail: {
        mappedProfileFields: [...entry.fields].sort(),
        profileMapperRefs: [...entry.refs].sort(),
        registrationRefs: [...registrations].sort(),
      },
    });
  }

  return { facts, indeterminate };
}

// ---------------------------------------------------------------------------
// Derivation entry points
// ---------------------------------------------------------------------------

export const defaultConsumerDeployables = ["marketplace-web", "public-web"];

/**
 * Derives every fact family from an already-loaded set of source records. Pure
 * with respect to the working tree apart from reading tracked manifests, so
 * partition fixtures and one-variable mutants run the exact production
 * derivation rather than a lookalike.
 */
export function derivePrivacyProductTruthInventory(input) {
  const {
    records,
    trackedPaths,
    excluded = [],
    repoRoot,
    externalPackageClassifications = {},
    consumerDeployables = defaultConsumerDeployables,
  } = input;

  const workspacePackages = readWorkspacePackages(repoRoot, trackedPaths);
  const index = buildIndex(records, trackedPaths, workspacePackages);

  const readFailures = records
    .filter((record) => record.readError !== undefined)
    .map((record) => ({ relativePath: record.relativePath, reason: record.readError }));

  const graph = deriveConsumerRouteGraph(index, repoRoot, trackedPaths, consumerDeployables);

  const cookies = deriveFirstPartyCookies(index);
  const webStorage = deriveWebStorage(index);
  const provider = deriveProviderInjectedClientStorage(index, graph, externalPackageClassifications);
  const cacheStorage = deriveCacheStorage(index);
  const socialProviders = deriveSocialProviderProfiles(index);

  const facts = [
    ...cookies.facts,
    ...webStorage.facts,
    ...provider.facts,
    ...cacheStorage.facts,
    ...socialProviders.facts,
  ].sort((left, right) =>
    left.factFamily === right.factFamily
      ? left.subject.localeCompare(right.subject)
      : left.factFamily.localeCompare(right.factFamily),
  );

  const indeterminate = [
    ...readFailures.map((failure) => ({
      factFamily: "partition",
      reason: `${failure.relativePath}: ${failure.reason}`,
    })),
    ...index.parseFailures.map((failure) => ({
      factFamily: "partition",
      reason: `${failure.relativePath}: could not parse (${failure.reason})`,
    })),
    ...cookies.indeterminate,
    ...webStorage.indeterminate,
    ...provider.indeterminate,
    ...cacheStorage.indeterminate,
    ...socialProviders.indeterminate,
  ].sort((left, right) => left.reason.localeCompare(right.reason));

  const excludedByReason = Object.fromEntries(privacyProductTruthExclusionReasons.map((reason) => [reason, 0]));
  for (const entry of excluded) excludedByReason[entry.reason] = (excludedByReason[entry.reason] ?? 0) + 1;

  const trackedGeneratedFiles = [...index.sourceByPath.keys()]
    .filter((relativePath) => hasGeneratedHeader(index.sourceByPath.get(relativePath)))
    .sort();

  const partition = {
    trackedTotal: trackedPaths.length,
    candidateTotal: records.length,
    scannedTotal: index.sourceByPath.size,
    trackedGeneratedTotal: trackedGeneratedFiles.length,
    readFailureTotal: readFailures.length,
    parseFailureTotal: index.parseFailures.length,
    excludedTotal: excluded.length,
    excludedByReason,
  };

  return {
    version: PRIVACY_PRODUCT_TRUTH_INVENTORY_VERSION,
    partition,
    facts,
    indeterminate,
    readFailures,
    trackedGeneratedFiles,
    observedExternalPackages: provider.observedExternalPackages,
    cspScriptOrigins: provider.cspScriptOrigins,
    consumerRouteModuleTotal: graph.routesByModule.size,
    sourceDigest: computeInventoryDigest(facts, partition),
  };
}

function computeInventoryDigest(facts, partition) {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        facts: facts.map((fact) => ({
          factFamily: fact.factFamily,
          subject: fact.subject,
          evidenceRefs: fact.evidenceRefs,
          detail: fact.detail,
        })),
        candidateTotal: partition.candidateTotal,
        scannedTotal: partition.scannedTotal,
      }),
    )
    .digest("hex")}`;
}

export function collectPrivacyProductTruthInventory({
  repoRoot,
  execGit,
  externalPackageClassifications,
  consumerDeployables,
} = {}) {
  return derivePrivacyProductTruthInventory({
    ...readPrivacyProductTruthSources({ repoRoot, execGit }),
    externalPackageClassifications,
    consumerDeployables,
  });
}

// ---------------------------------------------------------------------------
// Cited-source evidence digest
// ---------------------------------------------------------------------------

const citedRefPattern = /^(.+?):(\d+)(?:-(\d+))?$/;

export function readCitedSourceSlice(repoRoot, ref) {
  const match = citedRefPattern.exec(ref.trim());
  if (match === null) return { ref, error: "not a 'path:line' or 'path:start-end' reference" };
  const [, relativePath, startText, endText] = match;
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  if (end < start) return { ref, error: "inverted line range" };
  let content;
  try {
    content = normalizeSource(readTrackedText(repoRoot, relativePath));
  } catch (error) {
    return { ref, error: `unreadable cited source (${error instanceof Error ? error.message : String(error)})` };
  }
  const lines = content.split("\n");
  if (start < 1 || end > lines.length) return { ref, error: "cited line range is outside the file" };
  return { ref, relativePath, start, end, text: lines.slice(start - 1, end).join("\n") };
}

/**
 * The Privacy fingerprint input for cited product truth: the stable sort of
 * the resolved binding tuples plus the exact (line-ending normalized) bytes of
 * every cited source range. A change to any cited loader, manifest edge, CSP
 * policy, service-worker policy, registration root, cookie/Web Storage/provider
 * mapper — or to the binding set itself — moves this digest and therefore
 * stales only the Privacy publication module.
 */
export function computePrivacyCitedSourceDigest(repoRoot, bindings) {
  const resolved = [];
  const errors = [];
  for (const binding of [...bindings].sort((left, right) => left.factId.localeCompare(right.factId))) {
    const citedSources = [];
    for (const ref of [...binding.evidenceRefs].sort()) {
      const slice = readCitedSourceSlice(repoRoot, ref);
      if (slice.error !== undefined) {
        errors.push(`${binding.factId}: ${ref} — ${slice.error}`);
        continue;
      }
      citedSources.push({ ref: slice.ref, text: slice.text });
    }
    resolved.push({
      factId: binding.factId,
      noticeBoundary: binding.classification.noticeBoundary,
      factFamily: binding.classification.factFamily,
      inventorySubject: binding.inventorySubject,
      factualSummary: binding.factualSummary,
      consumingSectionIds: [...new Set((binding.disclosures ?? []).map((disclosure) => disclosure.sectionId))].sort(),
      requiredDisclosureTokens: (binding.disclosures ?? [])
        .flatMap((disclosure) => disclosure.requiredTokens.map((token) => `${disclosure.sectionId}:${token}`))
        .sort(),
      citedSources,
    });
  }
  if (errors.length > 0) {
    throw new Error(`Privacy cited-source evidence could not be resolved:\n${errors.join("\n")}`);
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(resolved)).digest("hex")}`;
}
