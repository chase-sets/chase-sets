import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import ts from "@chase-sets/typescript-compiler-api";
import { parseCLI, resolveConfig } from "vitest/node";

import { deriveBootstrapDbCaseIdentities, derivePlatformApiDbTestCensus } from "./check-bootstrap-db-enrollment.mjs";

/**
 * Workload freshness for the accepted bootstrap DB capture.
 *
 * A capture measures one workload. Its committed baseline binds the capture to
 * the W1-W5 workload derived from the capture's own frozen source, and the Unit
 * regression re-derives the same projection from the checked-out tree. Only a
 * workload-defining change refuses; every other byte the capture recorded
 * (`sourceBindings`, the lockfile, shared config) stays provenance, never a
 * freshness pin. Freshness never claims the runtime is unchanged: exact-head
 * hosted DB Profile Tests remain the qualification.
 *
 * - W1: the actual DB census, its whole file bytes, case identities and every
 *   `test:db:*` command, assignment and worker setting.
 * - W2: whole bytes of the static import/re-export closure W1 reaches inside
 *   the test tree plus dedicated test-support/fixture modules.
 * - W3: whole bytes of the seed/bootstrap selection, every static JSON fixture
 *   a W1-W3 module imports, and the effective boot/seed selections the API
 *   registry and context manifests make.
 * - W4: the hosted resolved Vitest configuration with lane mode unset, per
 *   execution unit, plus the hosted PostgreSQL settings.
 * - W5: the resolved `vitest` and `pg` versions of this workspace.
 */

const toolingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const platformApiPath = "deployables/platform-api";
const vitestConfigPath = `${platformApiPath}/vitest.config.ts`;
const registryPath = `${platformApiPath}/src/context-registry.ts`;
const selectionTypePath = "infrastructure/platform-runtime/api.ts";
const workflowPath = ".github/workflows/platform-pr.yml";
const lockfilePath = "pnpm-lock.yaml";

export const bootstrapDbWorkloadSelectors = Object.freeze({
  schema: "db-enrollment-workload/v1",
  w1: Object.freeze({
    census: `${platformApiPath} derivePlatformApiDbTestCensus dbEntries and bootstrapEntries`,
    scripts: `${platformApiPath}/package.json test:db:* scripts`,
  }),
  w2: Object.freeze([
    `^${platformApiPath}/__tests__/`,
    `^${platformApiPath}/src/test-support/`,
    "^contracts/[^/]+/test-support\\.ts$",
    "^bounded-contexts/.+/tests/[^/]*test-support\\.ts$",
    "^bounded-contexts/.+/tests/[^/]*fixture[^/]*\\.ts$",
  ]),
  w3: Object.freeze({
    exact: Object.freeze([
      `${platformApiPath}/src/admin-qa-actor-fixtures.ts`,
      `${platformApiPath}/src/database-pools.ts`,
      `${platformApiPath}/src/representative-commerce-state.ts`,
      "bounded-contexts/catalog/features/source-observations/api/provider-integration-profile-store.ts",
      "bounded-contexts/catalog/features/source-observations/api/representative-catalog-replay.ts",
      "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts",
      "bounded-contexts/identity/support/runtime-support/bootstrap-context.ts",
      "infrastructure/bounded-context-runtime/seed-aggregate-state.ts",
      "infrastructure/bounded-context-runtime/seeding.ts",
      "infrastructure/bounded-context-runtime/test-support.ts",
      "infrastructure/platform-runtime/api.ts",
      "infrastructure/platform-runtime/context-pools.ts",
      "infrastructure/platform-runtime/host-runtime-selection.ts",
    ]),
    patterns: Object.freeze([
      Object.freeze({ include: "^contracts/[^/]+-seed/", exclude: "\\.test\\.[^/]+$" }),
      Object.freeze({ include: "^bounded-contexts/(?:.+/)?seed\\.ts$" }),
      Object.freeze({ include: "^bounded-contexts/(?:.+/)?seed-support/" }),
      Object.freeze({ include: "^bounded-contexts/(?:.+/)?api/seeding/" }),
    ]),
    json: "static .json imports of W1-W3 modules at any path, except context.json manifests",
    selections: `${registryPath} entries projected through ${selectionTypePath} ApiContextManifest`,
  }),
  w4: Object.freeze({
    config: `${vitestConfigPath} resolved per test:db:* unit with CHASE_SETS_LANE_MODE unset`,
    fields: Object.freeze([
      "allowOnly",
      "bail",
      "clearMocks",
      "dangerouslyIgnoreUnhandledErrors",
      "env",
      "environment",
      "environmentOptions",
      "exclude",
      "execArgv",
      "fakeTimers",
      "fileParallelism",
      "globalSetup",
      "globals",
      "hookTimeout",
      "include",
      "includeSource",
      "isolate",
      "maxConcurrency",
      "maxWorkers",
      "minWorkers",
      "mockReset",
      "passWithNoTests",
      "pool",
      "poolOptions",
      "restoreMocks",
      "retry",
      "sequence",
      "setupFiles",
      "teardownTimeout",
      "testNamePattern",
      "testTimeout",
      "unstubEnvs",
      "unstubGlobals",
      "vmMemoryLimit",
    ]),
    // The hosted DB job runs on GitHub Actions with lane mode unset.
    environment: Object.freeze({ CI: "true", GITHUB_ACTIONS: "true" }),
    postgres: `${workflowPath} db-tests job`,
  }),
  w5: Object.freeze({ lockfile: lockfilePath, importer: platformApiPath, packages: Object.freeze(["pg", "vitest"]) }),
});

const w2Patterns = bootstrapDbWorkloadSelectors.w2.map((source) => new RegExp(source));
const w3Exact = new Set(bootstrapDbWorkloadSelectors.w3.exact);
const w3Patterns = bootstrapDbWorkloadSelectors.w3.patterns.map(({ include, exclude }) => ({
  include: new RegExp(include),
  exclude: exclude ? new RegExp(exclude) : null,
}));
const skippedDirectoryNames = new Set(["node_modules", "dist", "build", "coverage"]);
const scriptKinds = new Map([
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
]);
const typeScriptSubstitutes = new Map([
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts"]],
  [".jsx", [".tsx"]],
]);

// Sections whose binding set must never be empty. JSON fixtures and used
// aliases are complete-but-possibly-empty sets.
const requiredSections = Object.freeze([
  "W1 case identities",
  "W1 census",
  "W1 file",
  "W1 partition",
  "W2 file",
  "W3 file",
  "W3 selection",
  "W4 postgres",
  "W4 unit",
  "W5 version",
]);
const knownSections = new Set([...requiredSections, "W3 json", "W4 alias"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const bootstrapDbWorkloadSelectorsSha256 = sha256(canonicalJson(bootstrapDbWorkloadSelectors));

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBindings([leftSection, leftKey], [rightSection, rightKey]) {
  return compareStrings(leftSection, rightSection) || compareStrings(leftKey, rightKey);
}

function isW3Selected(path) {
  return w3Exact.has(path) || w3Patterns.some(({ include, exclude }) => include.test(path) && !exclude?.test(path));
}

function isW2Selected(path) {
  return w2Patterns.some((pattern) => pattern.test(path));
}

function isJsonFixture(path) {
  return path.endsWith(".json") && basename(path) !== "context.json";
}

function createTree(root) {
  const absolute = (path) => resolve(root, ...path.split("/"));
  const files = new Map();
  return {
    root,
    isFile(path) {
      if (!files.has(path)) {
        try {
          files.set(path, statSync(absolute(path)).isFile());
        } catch {
          files.set(path, false);
        }
      }
      return files.get(path);
    },
    read(path) {
      try {
        return readFileSync(absolute(path));
      } catch {
        return null;
      }
    },
    // Directory entries resolved through links, so a linked mirror reads like
    // the tree it mirrors.
    entries(path) {
      let entries;
      try {
        entries = readdirSync(absolute(path), { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .sort((left, right) => compareStrings(left.name, right.name))
        .flatMap((entry) => {
          if (!entry.isSymbolicLink()) {
            return [{ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() }];
          }
          try {
            const stats = statSync(absolute(path ? `${path}/${entry.name}` : entry.name));
            return [{ name: entry.name, directory: stats.isDirectory(), file: stats.isFile() }];
          } catch {
            return [];
          }
        });
    },
  };
}

function listFiles(tree, path) {
  const files = [];
  for (const entry of tree.entries(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.directory) {
      if (!entry.name.startsWith(".") && !skippedDirectoryNames.has(entry.name)) files.push(...listFiles(tree, child));
    } else if (entry.file) {
      files.push(child);
    }
  }
  return files;
}

const edgesCache = new Map();

/**
 * Every module edge whose target executes: static imports and re-exports,
 * import-equals, and literal `import()`/`require()` calls. Type-only edges are
 * erased before execution and stay provenance. A nonliteral dynamic import is
 * returned as a gap because its target cannot be bound.
 */
function moduleEdges(path, bytes) {
  const key = `${extname(path)}:${sha256(bytes)}`;
  const cached = edgesCache.get(key);
  if (cached) return cached;
  const sourceFile = ts.createSourceFile(
    path,
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    scriptKinds.get(extname(path)) ?? ts.ScriptKind.TS,
  );
  const edges = [];
  const nonliteral = [];
  const line = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) edges.push({ specifier: literal(node.moduleSpecifier), line: line(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) edges.push({ specifier: literal(node.moduleSpecifier), line: line(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!node.isTypeOnly) edges.push({ specifier: literal(node.moduleReference.expression), line: line(node) });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier = literal(node.arguments[0]);
      if (specifier === null) nonliteral.push(line(node));
      else edges.push({ specifier, line: line(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const result = { edges: edges.filter((edge) => edge.specifier !== null), nonliteral };
  edgesCache.set(key, result);
  return result;
}

function probeModule(tree, base, extensions) {
  const candidates = [];
  const extension = posix.extname(base);
  if (extension) {
    candidates.push(base);
    for (const substitute of typeScriptSubstitutes.get(extension) ?? []) {
      candidates.push(base.slice(0, -extension.length) + substitute);
    }
  }
  candidates.push(...extensions.map((suffix) => `${base}${suffix}`));
  candidates.push(...extensions.map((suffix) => `${base}/index${suffix}`));
  return candidates.find((candidate) => tree.isFile(candidate)) ?? null;
}

/**
 * Resolves a specifier exactly as the hosted Vitest resolver would for these
 * trees: relative paths, then the workspace source aliases in their resolved
 * order, then everything else as an installed package. A workspace specifier no
 * alias claims is unresolved rather than silently opaque.
 */
function resolveModule(tree, importer, specifier, resolution) {
  if (specifier.startsWith("node:")) return { kind: "package" };
  let base;
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  } else if (specifier.startsWith("/") || /^[A-Za-z]:/.test(specifier)) {
    return { kind: "unresolved" };
  } else {
    const alias = resolution.aliases.find(({ pattern }) => pattern.test(specifier));
    if (!alias) return specifier.startsWith("@chase-sets/") ? { kind: "unresolved" } : { kind: "package" };
    resolution.usedAliases.set(alias.find, alias.replacement);
    base = posix.normalize(specifier.replace(alias.pattern, alias.replacement));
  }
  if (base.startsWith("../") || base === "..") return { kind: "unresolved" };
  const path = probeModule(tree, base, resolution.extensions);
  return path ? { kind: "file", path } : { kind: "unresolved" };
}

function classifyMember(path, w1Paths) {
  if (w1Paths.has(path)) return "W1 file";
  if (path.endsWith(".d.ts")) return null;
  if (isW3Selected(path)) return "W3 file";
  if (isW2Selected(path)) return "W2 file";
  if (isJsonFixture(path)) return "W3 json";
  return null;
}

function deriveW1(tree, gaps) {
  const platformApiRoot = resolve(tree.root, ...platformApiPath.split("/"));
  const census = derivePlatformApiDbTestCensus({ platformApiRoot });
  for (const violation of census.violations) gaps.push(`W1 census is not derivable: ${violation}`);
  const toRepo = (entry) => `${platformApiPath}/${entry}`;
  const dbEntries = census.dbEntries.map(toRepo).sort(compareStrings);
  const bootstrapEntries = census.bootstrapEntries.map(toRepo).sort(compareStrings);
  const bindings = [
    ["W1 census", "bootstrapEntries", bootstrapEntries],
    ["W1 census", "dbEntries", dbEntries],
  ];
  for (const path of dbEntries) {
    const bytes = tree.read(path);
    if (!bytes) {
      gaps.push(`W1 entry ${path} is unreadable`);
      continue;
    }
    bindings.push(["W1 file", path, sha256(bytes)]);
    bindings.push([
      "W1 case identities",
      path,
      deriveBootstrapDbCaseIdentities(basename(path), bytes.toString("utf8")),
    ]);
  }

  const packageJson = tree.read(`${platformApiPath}/package.json`);
  let scripts = {};
  try {
    scripts = JSON.parse(packageJson?.toString("utf8") ?? "").scripts ?? {};
  } catch {
    gaps.push(`${platformApiPath}/package.json is unreadable`);
  }
  // The hosted `test:db*` selector runs every string script starting with
  // `test:db:`, exactly the selection check-bootstrap-db-enrollment applies.
  const partitions = Object.entries(scripts)
    .filter(([name, command]) => name.startsWith("test:db:") && typeof command === "string")
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }));
  const units = [];
  for (const [name, command] of partitions) {
    const invocations = command.split(/\s*&&\s*/).filter((part) => /^vitest\s/.test(part.trim()));
    if (invocations.length !== 1) {
      gaps.push(`${name} must contain exactly one Vitest invocation`);
      continue;
    }
    let parsed;
    try {
      parsed = parseCLI(invocations[0].trim());
    } catch (error) {
      gaps.push(`${name} has an unreadable Vitest invocation: ${error.message}`);
      continue;
    }
    const entries = parsed.filter.map((value) => value.replaceAll("\\", "/").replace(/^\.\//, ""));
    bindings.push(["W1 partition", name, { command, entries, maxWorkers: parsed.options.maxWorkers ?? null }]);
    units.push({ name, options: parsed.options });
  }
  return { bindings, w1Paths: new Set(dbEntries), units };
}

function deriveVersions(tree, gaps) {
  const lock = tree.read(lockfilePath)?.toString("utf8");
  if (!lock) {
    gaps.push(`${lockfilePath} is unreadable`);
    return {};
  }
  const lines = lock.split(/\r?\n/);
  const importersAt = lines.indexOf("importers:");
  const start = lines.indexOf(`  ${platformApiPath}:`, importersAt);
  if (importersAt < 0 || start < 0) {
    gaps.push(`${lockfilePath} has no ${platformApiPath} importer`);
    return {};
  }
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || lines[end].startsWith("    "))) end += 1;
  const block = lines.slice(start + 1, end);
  const versions = {};
  for (const name of bootstrapDbWorkloadSelectors.w5.packages) {
    const found = [];
    block.forEach((line, index) => {
      const version = block[index + 2]?.match(/^ {8}version: (\S+)$/);
      if (line === `      ${name}:` && version) found.push(version[1].split("(")[0]);
    });
    if (found.length !== 1) gaps.push(`${lockfilePath} must resolve exactly one ${name} for ${platformApiPath}`);
    else versions[name] = found[0];
  }
  return versions;
}

function extractDbTestsJob(workflow) {
  const start = workflow?.search(/^ {2}db-tests:\s*$/m) ?? -1;
  if (!workflow || start < 0) return null;
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function resolveApiDbWorkspaceConcurrencyFromJob(job, workflowPath) {
  const envDeclarations = [...job.matchAll(/^\s*DB_WORKSPACE_CONCURRENCY:\s*(.*?)\s*$/gm)];
  if (envDeclarations.length !== 1) {
    return {
      value: null,
      gaps: [`${workflowPath} db-tests job must declare exactly one DB_WORKSPACE_CONCURRENCY environment entry`],
    };
  }

  const expression = envDeclarations[0][1];
  const expressionMatch = expression.match(
    /^\$\{\{\s*matrix\.db-workspace-group\s*==\s*'([^']+)'\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\s*\}\}$/,
  );
  if (!expressionMatch || expressionMatch[1] !== "other") {
    return {
      value: null,
      gaps: [`${workflowPath} db-tests job DB_WORKSPACE_CONCURRENCY must be an unambiguous matrix expression for api`],
    };
  }
  const [, , conditionalValue, apiValue] = expressionMatch;
  if (![conditionalValue, apiValue].every((value) => /^[1-9][0-9]*$/.test(value))) {
    return {
      value: null,
      gaps: [`${workflowPath} db-tests job DB_WORKSPACE_CONCURRENCY must resolve to positive integers`],
    };
  }

  const invocations = [...job.matchAll(/run-workspaces\.mjs\s+"test:db\*"([^\r\n]*)/g)];
  const concurrencyArguments = invocations.flatMap(([, rest]) => [
    ...rest.matchAll(/--concurrency\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g),
  ]);
  if (
    invocations.length !== 1 ||
    concurrencyArguments.length !== 1 ||
    (concurrencyArguments[0][1] ?? concurrencyArguments[0][2] ?? concurrencyArguments[0][3]) !==
      "$DB_WORKSPACE_CONCURRENCY"
  ) {
    return {
      value: null,
      gaps: [`${workflowPath} db-tests job must pass --concurrency from DB_WORKSPACE_CONCURRENCY exactly once`],
    };
  }

  return { value: apiValue, gaps: [] };
}

/** Resolves the API matrix cell's effective DB workspace concurrency. */
export function resolveApiDbWorkspaceConcurrency(workflow) {
  const workflowPath = ".github/workflows/platform-pr.yml";
  const job = extractDbTestsJob(workflow);
  if (!job) return { value: null, gaps: [`${workflowPath} has no db-tests job`] };
  return resolveApiDbWorkspaceConcurrencyFromJob(job, workflowPath);
}

function derivePostgresSettings(tree, gaps) {
  const workflow = tree.read(workflowPath)?.toString("utf8");
  const job = extractDbTestsJob(workflow);
  if (!job) {
    gaps.push(`${workflowPath} has no db-tests job`);
    return [];
  }
  const settings = {
    image: /^\s+image:\s*(\S+)\s*$/gm,
    maxConnections: /target_max_connections=(\d+)/g,
    maxLocksPerTransaction: /target_max_locks_per_transaction=(\d+)/g,
  };
  const bindings = Object.entries(settings).flatMap(([name, pattern]) => {
    const matches = [...job.matchAll(pattern)];
    if (matches.length !== 1) {
      gaps.push(`${workflowPath} db-tests job must declare exactly one ${name}`);
      return [];
    }
    return [["W4 postgres", name, matches[0][1]]];
  });
  const concurrency = resolveApiDbWorkspaceConcurrencyFromJob(job, workflowPath);
  gaps.push(...concurrency.gaps);
  if (concurrency.value !== null) bindings.push(["W4 postgres", "workspaceConcurrency", concurrency.value]);
  return bindings;
}

const hostedConfigCache = new Map();
const hostedConfigFlag = "--hosted-vitest-config";

function relativeWithin(base, path) {
  const value = relative(base, path);
  return value && !value.startsWith("..") && !isAbsolute(value) ? value.replaceAll("\\", "/") : null;
}

function projectConfigValue(value, roots, gaps, field) {
  if (typeof value === "function") {
    return { function: value.name, sha256: sha256(String(value)) };
  }
  if (value instanceof RegExp) return { regexp: String(value) };
  if (Array.isArray(value)) return value.map((entry) => projectConfigValue(entry, roots, gaps, field));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, projectConfigValue(entry, roots, gaps, field)]),
    );
  }
  if (typeof value === "string" && isAbsolute(value)) {
    for (const root of roots) {
      const path = relativeWithin(root, value);
      if (path !== null) return path;
    }
    gaps.push(`W4 ${field} resolves outside the derived tree: ${value}`);
  }
  return value;
}

/**
 * Child-process side of W4: resolves each unit's configuration with Vitest's
 * own resolver inside the copied configuration tree and projects the hosted
 * fields. Runs only under the hosted environment `deriveHostedVitestConfig`
 * pins, because Vitest reads CI-dependent defaults once at import.
 */
async function resolveHostedUnits(treeRoot, units) {
  const roots = [realpathSync(treeRoot), treeRoot];
  const result = { bindings: [], aliases: [], extensions: [], gaps: [] };
  for (const { name, options } of units) {
    const { vitestConfig, viteConfig } = await resolveConfig({
      ...options,
      root: join(treeRoot, ...platformApiPath.split("/")),
      config: join(treeRoot, ...vitestConfigPath.split("/")),
    });
    const unitGaps = [];
    const projected = Object.fromEntries(
      bootstrapDbWorkloadSelectors.w4.fields.map((field) => [
        field,
        projectConfigValue(vitestConfig[field], roots, unitGaps, field),
      ]),
    );
    result.gaps.push(...unitGaps.map((gap) => `${name} ${gap}`));
    projected.resolveExtensions = [...viteConfig.resolve.extensions];
    result.bindings.push(["W4 unit", name, projected]);
    result.extensions = [...viteConfig.resolve.extensions];
    result.aliases = viteConfig.resolve.alias.flatMap(({ find, replacement }) => {
      const path =
        typeof replacement === "string" ? roots.map((root) => relativeWithin(root, replacement)).find(Boolean) : null;
      return path ? [{ find: find instanceof RegExp ? find.source : `^${find}$`, replacement: path }] : [];
    });
  }
  return result;
}

// Host variables a Node child needs to start; nothing else of this host's
// environment reaches the hosted configuration.
const childPlatformVariables = [
  "APPDATA",
  "ComSpec",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "windir",
];

/**
 * Evaluates the hosted Vitest configuration of `tree`, once per execution unit,
 * in a child Node process whose environment is the hosted one (GitHub Actions,
 * lane mode unset) wherever this runs. The configuration's module closure and
 * every workspace manifest its aliases read are copied out of `tree` into a
 * scratch root beneath the installed tooling, so the frozen source, a mutated
 * mirror and the live checkout are evaluated identically.
 */
async function deriveHostedVitestConfig(tree, units, installedVitest, gaps) {
  const files = new Map();
  const pending = [vitestConfigPath];
  while (pending.length > 0) {
    const path = pending.shift();
    if (files.has(path)) continue;
    const bytes = tree.read(path);
    if (!bytes) {
      gaps.push(`W4 configuration module ${path} is unreadable`);
      continue;
    }
    files.set(path, bytes);
    // Only static relative modules need copying; anything else evaluation
    // reaches resolves from the installed tooling or fails resolution below.
    for (const { specifier, line } of moduleEdges(path, bytes).edges) {
      if (!specifier.startsWith(".")) continue;
      const target = probeModule(tree, posix.normalize(posix.join(posix.dirname(path), specifier)), [
        ".mjs",
        ".js",
        ".mts",
        ".ts",
      ]);
      if (target) pending.push(target);
      else gaps.push(`${path}:${line} configuration import '${specifier}' is unresolved`);
    }
  }
  for (const path of ["package.json", `${platformApiPath}/package.json`]) {
    const bytes = tree.read(path);
    if (bytes) files.set(path, bytes);
    else gaps.push(`W4 configuration input ${path} is unreadable`);
  }
  for (const top of tree.entries("")) {
    if (!top.directory || top.name.startsWith(".") || skippedDirectoryNames.has(top.name)) continue;
    for (const workspace of tree.entries(top.name)) {
      const path = `${top.name}/${workspace.name}/package.json`;
      if (workspace.directory && tree.isFile(path)) files.set(path, tree.read(path));
    }
  }
  if (gaps.length > 0) return null;

  const key = sha256(
    canonicalJson({
      installedVitest,
      files: [...files]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([path, bytes]) => [path, sha256(bytes)]),
      units: units.map(({ name, options }) => [name, options]),
    }),
  );
  if (hostedConfigCache.has(key)) return hostedConfigCache.get(key);

  const scratchParent = join(toolingRoot, "node_modules", ".cache", "db-enrollment-workload");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "w4-"));
  try {
    const treeRoot = join(scratch, "tree");
    for (const [path, bytes] of files) {
      const target = join(treeRoot, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const resultPath = join(scratch, "hosted-config.json");
    const env = Object.fromEntries(
      childPlatformVariables.flatMap((name) => (name in process.env ? [[name, process.env[name]]] : [])),
    );
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), hostedConfigFlag, treeRoot, resultPath], {
      input: JSON.stringify(units),
      env: { ...env, ...bootstrapDbWorkloadSelectors.w4.environment },
      stdio: ["pipe", "ignore", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    const evaluated = JSON.parse(readFileSync(resultPath, "utf8"));
    gaps.push(...evaluated.gaps);
    if (gaps.length > 0) return null;
    hostedConfigCache.set(key, evaluated);
    return evaluated;
  } catch (error) {
    const detail = error.stderr?.toString("utf8").trim().split("\n").at(-1) || error.message;
    gaps.push(`W4 hosted Vitest configuration could not be resolved: ${detail}`);
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readSelectionFields(tree, gaps) {
  const bytes = tree.read(selectionTypePath);
  const sourceFile =
    bytes && ts.createSourceFile(selectionTypePath, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
  const declaration = sourceFile?.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === "ApiContextManifest",
  );
  let literal = declaration?.type;
  if (literal && ts.isTypeReferenceNode(literal) && literal.typeArguments?.length === 1)
    literal = literal.typeArguments[0];
  if (!literal || !ts.isTypeLiteralNode(literal)) {
    gaps.push(`${selectionTypePath} must declare ApiContextManifest as a type literal`);
    return [];
  }
  return literal.members
    .map((member) => member.name?.getText(sourceFile))
    .filter(Boolean)
    .sort(compareStrings);
}

function deriveSelections(tree, resolution, gaps) {
  const fields = readSelectionFields(tree, gaps);
  const bytes = tree.read(registryPath);
  if (!bytes) {
    gaps.push(`${registryPath} is unreadable`);
    return [];
  }
  const sourceFile = ts.createSourceFile(registryPath, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
  const manifestImports = new Map();
  let registry = null;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings) {
      const bindings = statement.importClause.namedBindings;
      if (!ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "contextManifest") {
          manifestImports.set(element.name.text, statement.moduleSpecifier.text);
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(sourceFile) !== "apiContextRegistry") continue;
        registry = declaration.initializer;
        while (registry && (ts.isAsExpression(registry) || ts.isSatisfiesExpression(registry))) {
          registry = registry.expression;
        }
      }
    }
  }
  if (!registry || !ts.isArrayLiteralExpression(registry) || registry.elements.length === 0) {
    gaps.push(`${registryPath} must declare a non-empty apiContextRegistry array literal`);
    return [];
  }
  const selections = [];
  for (const element of registry.elements) {
    const properties = new Map(
      ts.isObjectLiteralExpression(element)
        ? element.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => [property.name.getText(sourceFile), property.initializer])
        : [],
    );
    const contextName = properties.get("contextName");
    const packageName = properties.get("packageName");
    const manifest = properties.get("manifest");
    const specifier = manifest && ts.isIdentifier(manifest) ? manifestImports.get(manifest.text) : undefined;
    if (
      !contextName ||
      !ts.isStringLiteralLike(contextName) ||
      !packageName ||
      !ts.isStringLiteralLike(packageName) ||
      !specifier
    ) {
      gaps.push(`${registryPath} has a registry entry whose context, package or manifest import is not literal`);
      continue;
    }
    const entry = resolveModule(tree, registryPath, specifier, resolution);
    const entrySource = entry.kind === "file" ? tree.read(entry.path) : null;
    const entryFile =
      entrySource && ts.createSourceFile(entry.path, entrySource.toString("utf8"), ts.ScriptTarget.Latest, true);
    const manifestExport = entryFile?.statements.find(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (exported) => exported.name.text === "contextManifest" && exported.propertyName?.text === "default",
        ),
    );
    const manifestPath =
      manifestExport && resolveModule(tree, entry.path, manifestExport.moduleSpecifier.text, resolution);
    let manifestJson = null;
    try {
      manifestJson = manifestPath?.kind === "file" ? JSON.parse(tree.read(manifestPath.path).toString("utf8")) : null;
    } catch {
      manifestJson = null;
    }
    if (!manifestJson || typeof manifestJson !== "object") {
      gaps.push(
        `${registryPath} context '${contextName.text}' manifest from '${specifier}' is unresolved or unreadable`,
      );
      continue;
    }
    selections.push([
      "W3 selection",
      `${String(selections.length).padStart(3, "0")} ${contextName.text}`,
      {
        packageName: packageName.text,
        manifest: manifestPath.path,
        selection: Object.fromEntries(fields.map((field) => [field, manifestJson[field] ?? null])),
      },
    ]);
  }
  return selections;
}

function listW3Selection(tree, gaps) {
  const listed = [];
  for (const entry of tree.entries("contracts")) {
    if (entry.directory && entry.name.endsWith("-seed")) listed.push(...listFiles(tree, `contracts/${entry.name}`));
  }
  listed.push(...listFiles(tree, "bounded-contexts"));
  const selected = listed.filter(isW3Selected);
  for (const path of bootstrapDbWorkloadSelectors.w3.exact) {
    if (!tree.isFile(path)) gaps.push(`W3 input ${path} is missing`);
    else if (!selected.includes(path)) selected.push(path);
  }
  return selected;
}

function installedVitestVersion() {
  try {
    const manifest = join(toolingRoot, ...platformApiPath.split("/"), "node_modules", "vitest", "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return null;
  }
}

/**
 * Derives the complete W1-W5 workload of the tree rooted at `repositoryRoot`.
 * Bindings are sorted `[section, key, value]` triples; `gaps` lists every input
 * that could not be read, resolved or bound. A derivation with gaps is never a
 * freshness result.
 */
export async function deriveBootstrapDbWorkload({ repositoryRoot = toolingRoot } = {}) {
  const tree = createTree(repositoryRoot);
  const gaps = [];
  const w1 = deriveW1(tree, gaps);
  const versions = deriveVersions(tree, gaps);
  const installedVitest = installedVitestVersion();
  if (versions.vitest && installedVitest !== versions.vitest) {
    gaps.push(
      `W4 cannot be evaluated: installed vitest ${installedVitest ?? "is missing"} but the tree resolves ${versions.vitest}`,
    );
  }
  const postgres = derivePostgresSettings(tree, gaps);
  const hosted = gaps.length === 0 ? await deriveHostedVitestConfig(tree, w1.units, installedVitest, gaps) : null;
  if (!hosted) {
    return {
      bindings: [],
      gaps: gaps.length > 0 ? gaps : ["W4 hosted Vitest configuration is unresolved"],
      frontier: [],
    };
  }

  const resolution = {
    aliases: hosted.aliases.map((alias) => ({ ...alias, pattern: new RegExp(alias.find) })),
    extensions: hosted.extensions,
    usedAliases: new Map(),
  };
  const members = new Map();
  const pending = [];
  const admit = (path, section) => {
    if (members.has(path)) return;
    members.set(path, section);
    pending.push(path);
  };
  for (const path of w1.w1Paths) admit(path, "W1 file");
  for (const [, , projected] of hosted.bindings) {
    for (const path of projected.setupFiles ?? []) admit(path, classifyMember(path, w1.w1Paths) ?? "W2 file");
  }
  for (const path of listW3Selection(tree, gaps)) admit(path, "W3 file");

  const bindings = [...w1.bindings, ...postgres, ...hosted.bindings];
  // Local modules a member reaches but the selectors leave opaque: the
  // immediate fixture/helper frontier, reported for audit and never bound.
  const frontier = [];
  while (pending.length > 0) {
    const path = pending.shift();
    const bytes = tree.read(path);
    if (!bytes) {
      gaps.push(`workload input ${path} is unreadable`);
      continue;
    }
    const section = members.get(path);
    if (section !== "W1 file") bindings.push([section, path, sha256(bytes)]);
    if (!scriptKinds.has(extname(path))) continue;
    const { edges, nonliteral } = moduleEdges(path, bytes);
    for (const at of nonliteral) gaps.push(`${path}:${at} has a nonliteral workload import`);
    for (const { specifier, line } of edges) {
      const target = resolveModule(tree, path, specifier, resolution);
      if (target.kind === "unresolved") gaps.push(`${path}:${line} workload import '${specifier}' is unresolved`);
      if (target.kind !== "file") continue;
      const memberSection = classifyMember(target.path, w1.w1Paths);
      if (memberSection) admit(target.path, memberSection);
      else frontier.push([`${path}:${line}`, target.path]);
    }
  }

  bindings.push(...deriveSelections(tree, resolution, gaps));
  for (const [find, replacement] of resolution.usedAliases) bindings.push(["W4 alias", find, replacement]);
  for (const [name, version] of Object.entries(versions)) bindings.push(["W5 version", name, version]);
  return { bindings: bindings.sort(compareBindings), gaps, frontier: frontier.sort(compareBindings) };
}

function bindingKey([section, key]) {
  return `${section} ${key}`;
}

const hex64 = /^[0-9a-f]{64}$/;
const hex40 = /^[0-9a-f]{40}$/;

function validateBaseline(baseline) {
  const violations = [];
  const reject = (message) => violations.push(`baseline ${message}`);
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return ["baseline is missing"];
  if (baseline.schema !== bootstrapDbWorkloadSelectors.schema)
    reject(`schema must be ${bootstrapDbWorkloadSelectors.schema}`);
  const capture = baseline.capture ?? {};
  if (typeof capture.fileName !== "string" || !capture.fileName) reject("capture fileName is missing");
  if (!hex64.test(capture.fixtureSha256 ?? "")) reject("capture fixtureSha256 is missing");
  if (!/^\d+$/.test(capture.runId ?? "")) reject("capture runId is missing");
  for (const field of ["checkoutSha", "sourceBase", "captureParent"]) {
    if (!hex40.test(capture[field] ?? "")) reject(`capture ${field} is missing`);
  }
  if (!hex40.test(baseline.source?.commit ?? "")) reject("source commit is missing");
  if (!hex64.test(baseline.selectorsSha256 ?? "")) reject("selectorsSha256 is missing");
  const bindings = baseline.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) {
    reject("bindings are missing or empty");
    return violations;
  }
  if (baseline.bindingsSha256 !== sha256(canonicalJson(bindings)))
    reject("bindings do not match bindingsSha256 (partial or edited)");
  const seen = new Set();
  bindings.forEach((binding, index) => {
    if (
      !Array.isArray(binding) ||
      binding.length !== 3 ||
      !knownSections.has(binding[0]) ||
      typeof binding[1] !== "string" ||
      !binding[1] ||
      binding[2] === null ||
      binding[2] === undefined ||
      binding[2] === ""
    ) {
      reject(`binding ${index} is malformed or partial`);
      return;
    }
    const key = bindingKey(binding);
    if (seen.has(key)) reject(`binding ${key} is duplicated`);
    seen.add(key);
    if (index > 0 && Array.isArray(bindings[index - 1]) && compareBindings(bindings[index - 1], binding) > 0) {
      reject(`binding ${key} is out of order`);
    }
    if (/ file$| json$/.test(binding[0]) && !hex64.test(binding[2])) reject(`binding ${key} has no sha256 digest`);
  });
  for (const section of requiredSections) {
    if (!bindings.some((binding) => Array.isArray(binding) && binding[0] === section))
      reject(`${section} bindings are empty`);
  }
  return violations;
}

/**
 * The single freshness rule: the derived workload must equal the workload the
 * accepted capture measured, as frozen in its baseline. Every added, removed or
 * changed workload member is named; nothing outside W1-W5 is compared.
 */
export function checkBootstrapDbWorkloadFreshness({ baseline, capture, derivation }) {
  const violations = validateBaseline(baseline);
  const bound = baseline?.capture ?? {};
  const provenance = capture?.provenance ?? {};
  if (!capture || typeof capture.fileName !== "string" || !hex64.test(capture.fixtureSha256 ?? "")) {
    violations.push("no current capture is bound; a baseline cannot certify freshness without one");
  } else {
    if (
      bound.fileName !== capture.fileName ||
      bound.fixtureSha256 !== capture.fixtureSha256 ||
      bound.runId !== provenance.runId ||
      bound.checkoutSha !== provenance.checkoutSha ||
      bound.sourceBase !== provenance.sourceBase ||
      bound.captureParent !== provenance.captureParent
    ) {
      violations.push(
        `baseline binds capture ${bound.fileName ?? "(none)"} but the current capture is ${capture.fileName}; ` +
          "derive the baseline from the current capture's own frozen source",
      );
    }
    if (baseline?.source?.commit && baseline.source.commit !== provenance.sourceBase) {
      violations.push(
        `baseline was derived from ${baseline.source.commit}, not the capture's frozen source ${provenance.sourceBase}`,
      );
    }
  }
  if (baseline?.selectorsSha256 && baseline.selectorsSha256 !== bootstrapDbWorkloadSelectorsSha256) {
    violations.push(
      "workload selectors changed since the baseline was derived; re-derive it from the capture's frozen source",
    );
  }
  for (const gap of derivation?.gaps ?? ["workload derivation is missing"])
    violations.push(`workload input refused: ${gap}`);
  if (violations.length > 0 || !derivation) return { violations };

  const runId = bound.runId;
  const expected = new Map(baseline.bindings.map((binding) => [bindingKey(binding), binding]));
  const actual = new Map(derivation.bindings.map((binding) => [bindingKey(binding), binding]));
  for (const [key, binding] of actual) {
    const frozen = expected.get(key);
    if (!frozen) {
      violations.push(`${key} is workload the capture ${runId} did not measure; re-enrollment required`);
    } else if (canonicalJson(frozen[2]) !== canonicalJson(binding[2])) {
      violations.push(`${key} changed since capture ${runId}; re-enrollment required`);
    }
  }
  for (const key of expected.keys()) {
    if (!actual.has(key))
      violations.push(
        `${key} measured by capture ${runId} is absent from the derived workload; re-enrollment required`,
      );
  }
  return { violations };
}

/**
 * Verifies that `readSourceFile` serves the exact bytes the capture measured:
 * every census file and every recorded source binding. A missing or different
 * file means the frozen source is absent or substituted.
 */
export function bindFrozenSourceToCapture({ capture, readSourceFile }) {
  const violations = [];
  const expected = [
    ...[...(capture?.files ?? []), ...(capture?.nonBootstrapFiles ?? [])].map((file) => [
      `${platformApiPath}/${file.testPath}`,
      file.sourceSha256,
    ]),
    ...Object.entries(capture?.sourceBindings ?? {}),
  ];
  if (expected.length === 0) violations.push("capture records no source digests to bind the frozen source to");
  for (const [path, digest] of expected) {
    const bytes = readSourceFile(path);
    if (!bytes) violations.push(`frozen source is missing ${path}`);
    else if (sha256(Buffer.from(bytes)) !== digest) {
      violations.push(`frozen source ${path} differs from the capture; substituted source`);
    }
  }
  return { violations };
}

export function createBootstrapDbWorkloadBaseline({ captureFileName, captureBytes, source, derivation }) {
  const capture = JSON.parse(Buffer.from(captureBytes).toString("utf8"));
  const { runId, checkoutSha, sourceBase, captureParent } = capture.provenance ?? {};
  if (derivation.gaps.length > 0) throw new Error(`workload derivation refused:\n- ${derivation.gaps.join("\n- ")}`);
  return {
    schema: bootstrapDbWorkloadSelectors.schema,
    capture: {
      fileName: captureFileName,
      fixtureSha256: sha256(captureBytes),
      runId,
      checkoutSha,
      sourceBase,
      captureParent,
    },
    source,
    selectorsSha256: bootstrapDbWorkloadSelectorsSha256,
    bindingsSha256: sha256(canonicalJson(derivation.bindings)),
    bindings: derivation.bindings,
  };
}

export function formatBootstrapDbWorkloadBaseline(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

function git(repository, args, options = {}) {
  return execFileSync("git", ["-C", repository, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
}

// A promisor or partial-clone repository makes any object read lazily fetch a
// missing object, including filter-only remotes and the older core setting.
const lazyFetchConfig =
  /^(?:extensions\.partialclone|core\.partialclonefilter|remote\..+\.(?:promisor|partialclonefilter))$/i;

/**
 * Reads Git objects only after a metadata-only preflight proves the repository
 * cannot lazily fetch: promisor or partial-clone configuration is refused
 * before every object read rather than trusted to stay local. A failed read
 * reports `failure` when given.
 */
function localObjectGit(repository, args, { failure, ...options } = {}) {
  const names = git(repository, ["config", "--list", "--name-only", "--null"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\0")
    .filter((name) => lazyFetchConfig.test(name));
  if (names.length > 0) {
    throw new Error(
      `local Git objects refused: promisor or partial-clone configuration (${[...new Set(names)].join(", ")}) could fetch a missing object; materialize the frozen source from a full clone outside CI`,
    );
  }
  try {
    return git(repository, args, options);
  } catch (error) {
    if (failure) throw new Error(failure);
    throw error;
  }
}

/**
 * Producer: materializes the capture's frozen source from local Git objects,
 * proves it is the measured source, derives its workload with the same
 * exported derivation the Unit regression uses, and writes or checks the
 * committed baseline. It never fetches; a missing object, or a repository that
 * could lazily fetch one, is a gap to resolve outside CI.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      capture: { type: "string" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
      ref: { type: "string" },
      "historical-branch": { type: "string" },
      "historical-head": { type: "string" },
    },
  });
  if (!values.capture || !values.out) {
    throw new Error(
      "usage: db-enrollment-workload.mjs --capture <capture.json> --out <baseline.json> [--check] [--ref <ref>]",
    );
  }
  const capturePath = resolve(values.capture);
  const captureBytes = readFileSync(capturePath);
  const capture = JSON.parse(captureBytes.toString("utf8"));
  const commit = capture.provenance?.sourceBase;
  if (!hex40.test(commit ?? "") || capture.provenance.captureParent !== commit) {
    throw new Error("capture provenance must name one frozen source as both sourceBase and captureParent");
  }
  localObjectGit(toolingRoot, ["cat-file", "-e", `${commit}^{commit}`], {
    stdio: "ignore",
    failure: `frozen source ${commit} is not available locally; fetch it outside CI (for example ${values.ref ?? "its pull request ref"})`,
  });
  const historicalHead = values["historical-head"];
  if (historicalHead !== undefined) {
    if (!hex40.test(historicalHead)) throw new Error("--historical-head must be a full commit SHA");
    localObjectGit(toolingRoot, ["merge-base", "--is-ancestor", commit, historicalHead], {
      stdio: "ignore",
      failure: `frozen source ${commit} is not an ancestor of historical head ${historicalHead}`,
    });
  }

  const scratch = mkdtempSync(join(tmpdir(), "bootstrap-db-frozen-"));
  try {
    const index = join(scratch, "index");
    const frozenRoot = join(scratch, "tree");
    localObjectGit(toolingRoot, ["read-tree", `--index-output=${index}`, commit]);
    localObjectGit(toolingRoot, ["checkout-index", "--all", "--force", `--prefix=${frozenRoot}/`], {
      env: { ...process.env, GIT_INDEX_FILE: index },
    });
    const binding = bindFrozenSourceToCapture({
      capture,
      readSourceFile: (path) => createTree(frozenRoot).read(path),
    });
    if (binding.violations.length > 0) throw new Error(`frozen source refused:\n- ${binding.violations.join("\n- ")}`);
    const derivation = await deriveBootstrapDbWorkload({ repositoryRoot: frozenRoot });
    const source = {
      commit,
      ...(values.ref ? { ref: values.ref } : {}),
      ...(values["historical-branch"] ? { historicalBranch: values["historical-branch"] } : {}),
      ...(historicalHead ? { historicalHead } : {}),
    };
    const outPath = resolve(values.out);
    const prettier = await import("prettier");
    const baseline = await prettier.format(
      formatBootstrapDbWorkloadBaseline(
        createBootstrapDbWorkloadBaseline({ captureFileName: basename(capturePath), captureBytes, source, derivation }),
      ),
      { ...(await prettier.resolveConfig(outPath)), filepath: outPath },
    );
    if (values.check) {
      if (!existsSync(outPath) || readFileSync(outPath, "utf8") !== baseline) {
        throw new Error(`${outPath} does not reproduce from frozen source ${commit}`);
      }
      console.log(`${basename(outPath)} reproduces from frozen source ${commit}.`);
    } else {
      writeFileSync(outPath, baseline);
      console.log(`Wrote ${basename(outPath)} from frozen source ${commit}.`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function resolveHostedConfigChild() {
  const [treeRoot, resultPath] = process.argv.slice(3);
  const units = JSON.parse(readFileSync(0, "utf8"));
  writeFileSync(resultPath, JSON.stringify(await resolveHostedUnits(treeRoot, units)));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  (process.argv[2] === hostedConfigFlag ? resolveHostedConfigChild() : main()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
