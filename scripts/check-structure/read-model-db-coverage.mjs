import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { listContextManifests, normalizeRelative, repoRoot } from "../lib/repo.mjs";
import {
  buildWorkspacePackageIndex,
  isValueReachableExport,
  isValueReachableImport,
  resolveBareSpecifier,
  resolveRelativeModuleFile,
} from "./server-barrel-react-free.mjs";

// Guard: a changed bounded-context module that executes SQL by code shape
// (an `<expr>.query(`/`<expr>.execute(` call whose argument resolves to real
// SQL text, by direct template literal, a local constant, a lookup on a
// locally-declared SQL-statement map, or a wrapper call that itself passes
// one of those shapes through) must be reachable from at least one db-test
// file that the owning workspace's `test:db` script actually executes.
//
// Root cause this prevents recurring: an ambiguous-column query regression
// had never executed against real PostgreSQL before merge. The DB-profile
// machinery (workspace `test:db` scripts, `chaseSets.testProfile`) already
// exists and the boot-SQL guard already solves the analogous boot-schema
// problem with a diff-scoped static check; nothing structural required a
// read-model module containing SQL to be exercised by a db test.
//
// Detection is by code shape, not path vocabulary (`read-model/` etc.): a
// module that constructs SQL but lives outside `read-model/` is still in
// scope, and a module under `read-model/` that never calls `.query()`/
// `.execute()` against real SQL text (e.g. a pure formatter) is not flagged.
//
// SQL-bearing-ness is decided by the resolved argument's own text (does it
// start with a real SQL statement keyword?), not by the receiver's name or
// declared type: this repo has no type-checked Program wired into this
// guard, so a name/type check can't reliably tell a real (possibly aliased
// or wrapped) Postgres client from a Hono request or an in-memory cache with
// a same-named `.query()`/`.execute()` method. Keying off resolved content
// instead correctly accepts `resolveProjectionDb(ctx, db).query(sql)` and
// rejects `c.req.query("id")` / `cache.query(\`some-key\`)` without needing
// to know what the receiver is.
//
// Coverage is scoped to the db-test files a workspace's own `test:db` script
// actually runs (parsed from its package.json script string, matching what
// scripts/run-workspaces.mjs invokes for CI), not every `*.db.test.ts` file
// that happens to exist on disk: a file present but not listed in `test:db`
// never executes in CI and cannot prove anything ran against real Postgres.
//
// Diff-scoped like boot-schema-ddl-discipline.mjs: only modules changed
// relative to `git merge-base origin/main HEAD` are checked. Pre-existing
// uncovered modules converge as they are next touched, not via a retroactive
// sweep or an exemption ledger. Diff discovery fails closed: a malformed
// explicit changed-file input or an indeterminate git merge-base/diff
// becomes a named violation, not a silently empty (and therefore passing)
// changed-file set; a genuinely empty diff still passes.

const sqlExecutionMethodNames = new Set(["query", "execute"]);

// Recognizes the repo's real statement vocabulary (SELECT/INSERT/UPDATE/
// DELETE plus the DDL/maintenance statements boot-schema-ddl-discipline.mjs
// already treats as real SQL). Deliberately content-based rather than
// receiver-based: see the file-level comment above.
const sqlStatementKeywordPattern =
  /^\s*(?:--[^\n]*\n\s*)*(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE|LOCK|EXPLAIN|COPY|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|VACUUM|REINDEX|ANALYZE|REFRESH)\b/i;

const functionLikeSyntaxKinds = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

export class ReadModelDbCoverageDiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReadModelDbCoverageDiscoveryError";
  }
}

function isTestFile(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.includes("/__tests__/") ||
    /\.(?:test|spec)\.[^/]+$/.test(relativeFile)
  );
}

function isExistingFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile();
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

function hasOwnStatementList(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

// Bounded, same-file constant resolution only (module top-level plus any
// enclosing block/function body): a function *parameter* like
// `rowExists(db, sql, params)` has no initializer to resolve here and is
// conservatively treated as non-SQL-bearing rather than chasing every call
// site interprocedurally.
function collectLocalConstBindings(node) {
  const bindings = new Map();
  for (const statement of node.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bindings;
}

function resolveLocalInitializer(name, scopeStack) {
  for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
    if (scopeStack[index].has(name)) {
      return scopeStack[index].get(name);
    }
  }
  return null;
}

function resolveObjectLiteral(node, scopeStack) {
  if (!ts.isIdentifier(node)) return null;
  const initializer = resolveLocalInitializer(node.text, scopeStack);
  return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : null;
}

function propertyNameText(nameNode) {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

// Resolves whether `node` is, or locally resolves to, real SQL text. Covers
// the repo's actual argument idioms: a direct template literal
// (`db.query(\`SELECT ...\`)`), a helper-call wrapping one
// (`db.query(catalogIsoUtcListSql(\`SELECT ...\`, "updated_at"))`), a
// same-scope local constant (`const sql = \`...\`; db.query(sql)`), and a
// property/element lookup on a locally-declared SQL-statement map
// (`db.query(refreshOneMarketSignalSql[targetTable])`). Bottoms out at a
// bounded recursion depth so a self-referential or deeply nested binding
// cannot loop forever.
function isSqlBearingExpression(node, scopeStack, depth = 0) {
  if (depth > 8) return false;

  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return sqlStatementKeywordPattern.test(node.text);
  }
  if (ts.isTemplateExpression(node)) {
    return sqlStatementKeywordPattern.test(node.head.text);
  }
  if (ts.isStringLiteral(node)) {
    return sqlStatementKeywordPattern.test(node.text);
  }
  if (ts.isParenthesizedExpression(node)) {
    return isSqlBearingExpression(node.expression, scopeStack, depth + 1);
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isSqlBearingExpression(node.expression, scopeStack, depth + 1);
  }
  if (ts.isIdentifier(node)) {
    const initializer = resolveLocalInitializer(node.text, scopeStack);
    return initializer ? isSqlBearingExpression(initializer, scopeStack, depth + 1) : false;
  }
  if (ts.isCallExpression(node)) {
    return node.arguments.some((argument) => isSqlBearingExpression(argument, scopeStack, depth + 1));
  }
  if (ts.isPropertyAccessExpression(node)) {
    const objectLiteral = resolveObjectLiteral(node.expression, scopeStack);
    if (!objectLiteral) return false;
    const propertyName = node.name.text;
    const matchingProperty = objectLiteral.properties.find(
      (property) => ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName,
    );
    return matchingProperty ? isSqlBearingExpression(matchingProperty.initializer, scopeStack, depth + 1) : false;
  }
  if (ts.isElementAccessExpression(node)) {
    const objectLiteral = resolveObjectLiteral(node.expression, scopeStack);
    if (!objectLiteral) return false;
    return objectLiteral.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) && isSqlBearingExpression(property.initializer, scopeStack, depth + 1),
    );
  }

  return false;
}

// A module "executes SQL" when it calls `<expr>.query(` or `<expr>.execute(`
// with an argument that resolves to real SQL text (see
// isSqlBearingExpression). The receiver `<expr>` is unrestricted by design
// (a direct client, an aliased local, or a wrapper-call chain like
// `resolveProjectionDb(context, db).query(...)` all count); only the
// resolved argument content decides SQL-bearing-ness.
export function findExecutableSqlCallSites(sourceFile) {
  const callSites = [];

  function visit(node, scopeStack) {
    const nextScopeStack = hasOwnStatementList(node) ? [...scopeStack, collectLocalConstBindings(node)] : scopeStack;

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      sqlExecutionMethodNames.has(node.expression.name.text) &&
      node.arguments.length > 0 &&
      isSqlBearingExpression(node.arguments[0], nextScopeStack)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      callSites.push({ methodName: node.expression.name.text, line: position.line + 1 });
    }

    ts.forEachChild(node, (child) => visit(child, nextScopeStack));
  }

  visit(sourceFile, []);
  return callSites;
}

export function isSqlBearingSource(filePath, content) {
  return findExecutableSqlCallSites(parseModule(filePath, content)).length > 0;
}

// Same specifier/value-reachability rules as server-barrel-react-free.mjs's
// walkGraph for static import/export edges (those are unconditional
// module-load-time effects and always count), but a dynamic `import()` only
// counts when it is not nested inside any function-like body. A conditional
// dynamic import inside a function this guard cannot prove is ever called is
// not execution proof — a never-called function containing
// `import("./queries")` must not certify coverage — so it is conservatively
// excluded rather than treated as reachable.
export function collectReadModelModuleReferences(sourceFile) {
  const references = [];

  function visit(node, insideFunction) {
    const nextInsideFunction = insideFunction || functionLikeSyntaxKinds.has(node.kind);

    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({ specifier: node.moduleSpecifier.text, valueReachable: isValueReachableImport(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({ specifier: node.moduleSpecifier.text, valueReachable: isValueReachableExport(node) });
    } else if (
      !nextInsideFunction &&
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      references.push({ specifier: node.arguments[0].text, valueReachable: true });
    }

    ts.forEachChild(node, (child) => visit(child, nextInsideFunction));
  }

  visit(sourceFile, false);
  return references;
}

// Collects every repo file transitively value-reachable from `entryAbsPath`,
// including the entry itself. Mirrors server-barrel-react-free.mjs's
// walkGraph traversal (same relative/bare-specifier resolution) but records
// the full visited set instead of hunting for a specific forbidden node.
function collectReachableFiles({ entryAbsPath, packageIndex, referenceCache }) {
  const visited = new Set();
  const queue = [entryAbsPath];

  while (queue.length > 0) {
    const absPath = queue.shift();
    const normalizedAbs = path.resolve(absPath);
    if (visited.has(normalizedAbs) || !isExistingFile(normalizedAbs)) {
      continue;
    }
    visited.add(normalizedAbs);

    let references = referenceCache.get(normalizedAbs);
    if (references === undefined) {
      const content = readFileSync(normalizedAbs, "utf8");
      references = collectReadModelModuleReferences(parseModule(normalizedAbs, content));
      referenceCache.set(normalizedAbs, references);
    }

    for (const reference of references) {
      if (!reference.valueReachable) continue;

      if (reference.specifier.startsWith(".")) {
        const resolved = resolveRelativeModuleFile(normalizedAbs, reference.specifier);
        if (resolved) queue.push(resolved);
        continue;
      }

      const bare = resolveBareSpecifier(reference.specifier, packageIndex);
      if (bare?.absolutePath) {
        queue.push(bare.absolutePath);
      }
    }
  }

  return visited;
}

// Extracts the file-path arguments from a workspace's `test:db` script
// string (e.g. `vitest run --config ./tests/vitest.config.mjs
// features/a.db.test.ts features/b.db.test.ts`) — the exact command
// scripts/run-workspaces.mjs invokes for CI's db-profile test run. A
// `*.db.test.ts` file that exists on disk but isn't one of these tokens is
// never executed by test:db and must not certify coverage.
export function parseTestDbScriptEntryFiles(scriptCommand) {
  return scriptCommand
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith("-"))
    .filter((token) => /\.(?:mts|cts|tsx?)$/.test(token));
}

function loadExecutableDbTestFiles({ contextAbsRoot }) {
  const packageJsonPath = path.join(contextAbsRoot, "package.json");
  if (!isExistingFile(packageJsonPath)) {
    return [];
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return [];
  }

  const testDbScript = packageJson.scripts?.["test:db"];
  if (typeof testDbScript !== "string") {
    return [];
  }

  return parseTestDbScriptEntryFiles(testDbScript)
    .map((relativeFile) => path.resolve(contextAbsRoot, relativeFile))
    .filter((absPath) => isExistingFile(absPath));
}

// Fails closed: a malformed CHANGED_FILES_JSON or an indeterminate git
// merge-base/diff throws a named ReadModelDbCoverageDiscoveryError instead
// of silently returning an empty (and therefore trivially passing)
// changed-file set. A genuinely resolved empty diff still returns [].
function readChangedFilePaths({ repoRoot: rootDir }) {
  const envValue = process.env.CHANGED_FILES_JSON;
  if (envValue) {
    let parsed;
    try {
      parsed = JSON.parse(envValue);
    } catch (error) {
      throw new ReadModelDbCoverageDiscoveryError(
        `CHANGED_FILES_JSON is not valid JSON (${error instanceof Error ? error.message : String(error)}); refusing to certify read-model DB coverage with an indeterminate changed-file set.`,
      );
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new ReadModelDbCoverageDiscoveryError(
        "CHANGED_FILES_JSON must be a JSON array of strings; refusing to certify read-model DB coverage with an indeterminate changed-file set.",
      );
    }
    return parsed;
  }

  let mergeBase;
  try {
    mergeBase = execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    throw new ReadModelDbCoverageDiscoveryError(
      `Could not resolve git merge-base against origin/main (${error instanceof Error ? error.message : String(error)}); refusing to certify read-model DB coverage with an indeterminate diff scope.`,
    );
  }

  let output;
  try {
    output = execFileSync("git", ["diff", "--name-only", `${mergeBase}...HEAD`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    throw new ReadModelDbCoverageDiscoveryError(
      `git diff --name-only against merge-base ${mergeBase} failed (${error instanceof Error ? error.message : String(error)}); refusing to certify read-model DB coverage with an indeterminate diff scope.`,
    );
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadContextManifestsForCli(rootDir) {
  return new Map(
    listContextManifests({ repoRoot: rootDir }).map((context) => [
      `bounded-contexts/${context.dirName}`,
      {
        root: `bounded-contexts/${context.dirName}`,
        dirName: context.dirName,
        manifest: context.manifest,
        packageName: context.manifest.packageName,
      },
    ]),
  );
}

function formatViolationMessage({ relativeFile, context }) {
  return (
    `${relativeFile} contains executable SQL (a .query()/.execute() call resolving to real SQL text) but no db-test ` +
    `file that ${context.packageName}'s (${context.root}) \`test:db\` script actually runs imports it, directly or ` +
    `transitively. Add or extend a *.db.test.ts under ${context.root} that is listed in its \`test:db\` script and ` +
    `imports ${relativeFile} (directly, or transitively through the module it exercises) so this SQL executes ` +
    `against real PostgreSQL.`
  );
}

const DIFF_DISCOVERY_VIOLATION_FILE = "<repository diff discovery>";

export async function findReadModelDbCoverageViolations(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const contexts = options.contextManifests
    ? [...options.contextManifests.values()]
    : [...loadContextManifestsForCli(rootDir).values()];

  let changedFilePaths;
  try {
    changedFilePaths = (options.changedFilePaths ?? readChangedFilePaths({ repoRoot: rootDir })).map((filePath) =>
      filePath.replaceAll("\\", "/"),
    );
  } catch (error) {
    if (error instanceof ReadModelDbCoverageDiscoveryError) {
      return [{ file: DIFF_DISCOVERY_VIOLATION_FILE, workspace: "(repository-wide)", message: error.message }];
    }
    throw error;
  }

  const packageIndex = buildWorkspacePackageIndex({ repoRoot: rootDir });
  const referenceCache = new Map();
  const violations = [];

  for (const context of contexts) {
    const contextAbsRoot = path.join(rootDir, context.root);
    if (!existsSync(contextAbsRoot)) {
      continue;
    }

    const changedModulePaths = changedFilePaths.filter(
      (relativeFile) =>
        relativeFile.startsWith(`${context.root}/`) && /\.tsx?$/.test(relativeFile) && !isTestFile(relativeFile),
    );

    const sqlBearingModules = [];
    for (const relativeFile of changedModulePaths) {
      const absPath = path.join(rootDir, relativeFile);
      if (!isExistingFile(absPath)) {
        continue;
      }
      const content = readFileSync(absPath, "utf8");
      if (isSqlBearingSource(absPath, content)) {
        sqlBearingModules.push({ relativeFile, absPath: path.resolve(absPath) });
      }
    }

    if (sqlBearingModules.length === 0) {
      continue;
    }

    const dbTestFiles = loadExecutableDbTestFiles({ contextAbsRoot });

    const reachableFromDbTests = new Set();
    for (const dbTestFile of dbTestFiles) {
      for (const reachableFile of collectReachableFiles({ entryAbsPath: dbTestFile, packageIndex, referenceCache })) {
        reachableFromDbTests.add(reachableFile);
      }
    }

    for (const sqlModule of sqlBearingModules) {
      if (reachableFromDbTests.has(sqlModule.absPath)) {
        continue;
      }

      violations.push({
        file: sqlModule.relativeFile,
        workspace: context.packageName,
        message: formatViolationMessage({ relativeFile: sqlModule.relativeFile, context }),
      });
    }
  }

  violations.sort((left, right) => left.file.localeCompare(right.file));
  return violations;
}

export async function validateReadModelDbCoverage(options = {}) {
  const violations = await findReadModelDbCoverageViolations(options);
  return { violations: violations.map((violation) => violation.message), warnings: [] };
}

async function main() {
  const contextManifests = loadContextManifestsForCli(repoRoot);
  const result = await validateReadModelDbCoverage({ contextManifests });

  if (result.violations.length > 0) {
    console.error("Read-model DB coverage guard failed.");
    for (const message of result.violations) {
      console.error(`- ${message}`);
    }
    process.exit(1);
  }

  console.log(
    "Read-model DB coverage guard passed: every changed SQL-bearing module has a same-workspace db-test importer.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
