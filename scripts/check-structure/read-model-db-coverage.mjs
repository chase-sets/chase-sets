import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";
import { listContextManifests, normalizeRelative, repoRoot } from "../lib/repo.mjs";
import {
  buildWorkspacePackageIndex,
  collectModuleReferences,
  resolveBareSpecifier,
  resolveRelativeModuleFile,
} from "./server-barrel-react-free.mjs";

// Guard: a changed bounded-context module that executes SQL by code shape
// (an `<expr>.query(` or `<expr>.execute(` call whose first argument is a
// template literal) must be reachable from at least one same-workspace
// `*.db.test.ts` file's import graph.
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
// `.execute()` with a SQL template (e.g. a pure formatter) is not flagged.
//
// Diff-scoped like boot-schema-ddl-discipline.mjs: only modules changed
// relative to `git merge-base origin/main HEAD` are checked. Pre-existing
// uncovered modules converge as they are next touched, not via a retroactive
// sweep or an exemption ledger.

const sqlExecutionMethodNames = new Set(["query", "execute"]);

function isTestFile(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.includes("/__tests__/") ||
    /\.(?:test|spec)\.[^/]+$/.test(relativeFile)
  );
}

function isDbTestFile(relativeFile) {
  return relativeFile.endsWith(".db.test.ts");
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

function isTemplateLiteralArgument(node) {
  return ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

// A module "executes SQL" when it calls `<expr>.query(` or `<expr>.execute(`
// with a template-literal first argument (the repo's actual query idiom,
// e.g. `db.query(\`SELECT ...\`, values)`, `pool.query(\`...\`)`,
// `client.execute(\`...\`)`). This shape excludes non-SQL lookalikes such as
// Hono's `c.req.query("id")` (a string-literal argument, not a template).
export function findExecutableSqlCallSites(sourceFile) {
  const callSites = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      sqlExecutionMethodNames.has(node.expression.name.text) &&
      node.arguments.length > 0 &&
      isTemplateLiteralArgument(node.arguments[0])
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      callSites.push({ methodName: node.expression.name.text, line: position.line + 1 });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return callSites;
}

export function isSqlBearingSource(filePath, content) {
  return findExecutableSqlCallSites(parseModule(filePath, content)).length > 0;
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
      references = collectModuleReferences(parseModule(normalizedAbs, content));
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

function readChangedFilePaths({ repoRoot: rootDir }) {
  const envValue = process.env.CHANGED_FILES_JSON;
  if (envValue) {
    try {
      const parsed = JSON.parse(envValue);
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
    } catch {
      return [];
    }
  }

  try {
    const mergeBase = execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const output = execFileSync("git", ["diff", "--name-only", `${mergeBase}...HEAD`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
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
    `${relativeFile} contains executable SQL (a .query()/.execute() call against a SQL template) but no ` +
    `*.db.test.ts in workspace ${context.packageName} (${context.root}) imports it, directly or transitively. ` +
    `Add or extend a *.db.test.ts under ${context.root} that imports ${relativeFile} (directly, or transitively ` +
    `through the module it exercises) so this SQL executes against real PostgreSQL.`
  );
}

export async function findReadModelDbCoverageViolations(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const contexts = options.contextManifests
    ? [...options.contextManifests.values()]
    : [...loadContextManifestsForCli(rootDir).values()];
  const changedFilePaths = (options.changedFilePaths ?? readChangedFilePaths({ repoRoot: rootDir })).map((filePath) =>
    filePath.replaceAll("\\", "/"),
  );
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

    const dbTestFiles = (
      await collectFiles(contextAbsRoot, {
        extensions: new Set([".ts"]),
        skippedDirectories: defaultSkippedDirectories,
      })
    ).filter((filePath) => isDbTestFile(normalizeRelative(filePath, rootDir)));

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
