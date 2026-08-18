import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { listWorkspacePackages, repoRoot } from "../lib/repo.mjs";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const jsonAttributeText = 'with { type: "json" }';
const nodeClosureSeeds = [
  "deployables/platform-api/src/generated/api-context-registry.ts",
  "deployables/platform-worker/src/generated/worker-context-registry.ts",
];

function normalizePath(value) {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function scriptKind(relativeFile) {
  return relativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function trackedPaths(rootDir) {
  return new Set(
    execFileSync("git", ["-C", rootDir, "ls-files"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizePath),
  );
}

function resolveRelative(importer, specifier, paths) {
  const target = normalizePath(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [
    target,
    ...[...sourceExtensions].map((extension) => `${target}${extension}`),
    `${target}/index.ts`,
    `${target}/index.tsx`,
  ];
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

function packageResolution(packages, specifier) {
  for (const workspace of packages) {
    if (specifier !== workspace.name && !specifier.startsWith(`${workspace.name}/`)) continue;
    const subpath = specifier === workspace.name ? "." : `./${specifier.slice(workspace.name.length + 1)}`;
    const target = workspace.packageJson.exports?.[subpath];
    return typeof target === "string"
      ? normalizePath(path.posix.join(workspace.root, workspace.dirName, target))
      : null;
  }
  return null;
}

function resolveSpecifier({ importer, specifier, paths, packages }) {
  if (specifier.startsWith(".")) return resolveRelative(importer, specifier, paths);
  return packageResolution(packages, specifier);
}

function isValueDeclaration(declaration) {
  return !(
    (ts.isImportDeclaration(declaration) && declaration.importClause?.isTypeOnly) ||
    (ts.isExportDeclaration(declaration) && declaration.isTypeOnly)
  );
}

function declarationRecords(relativeFile, content) {
  const source = ts.createSourceFile(relativeFile, content, ts.ScriptTarget.Latest, true, scriptKind(relativeFile));
  return source.statements.flatMap((statement) => {
    if (
      !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
      !isValueDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [];
    }

    return [
      {
        declaration: statement,
        form: ts.isImportDeclaration(statement) ? "import" : "export",
        specifier: statement.moduleSpecifier.text,
        attributeText: statement.attributes?.getText(source) ?? null,
      },
    ];
  });
}

function nodeClosure({ paths, packages, contents }) {
  const closure = new Set();
  const pending = [...nodeClosureSeeds];
  while (pending.length > 0) {
    const current = pending.pop();
    if (closure.has(current) || !paths.has(current) || !sourceExtensions.has(path.posix.extname(current))) continue;
    closure.add(current);
    for (const record of declarationRecords(current, contents.get(current))) {
      const resolved = resolveSpecifier({ importer: current, specifier: record.specifier, paths, packages });
      if (resolved && sourceExtensions.has(path.posix.extname(resolved))) pending.push(resolved);
    }
  }
  return closure;
}

function disposition({ relativeFile, nodeFiles }) {
  if (nodeFiles.has(relativeFile)) return "node-enforced";
  if (relativeFile.endsWith(".tsx") || /\/generated\/web-context-registry\.ts$/.test(relativeFile))
    return "vite-excluded";
  if (/\.(?:test|spec)\.(?:ts|mts|cts)$/.test(relativeFile)) return "vitest-excluded";
  return "indeterminate";
}

export function findJsonImportAttributeViolation(content, expectedDeclarations) {
  for (const expectedDeclaration of expectedDeclarations) {
    if (!content.includes(expectedDeclaration)) {
      return `must use the standard JSON import attribute: ${expectedDeclaration}`;
    }
  }
  return null;
}

export function inspectJsonImportAttributes({ rootDir = repoRoot, paths = trackedPaths(rootDir) } = {}) {
  const packages = listWorkspacePackages({ repoRoot: rootDir });
  const contents = new Map(
    [...paths]
      .filter((relativeFile) => sourceExtensions.has(path.posix.extname(relativeFile)))
      .map((relativeFile) => [relativeFile, readFileSync(path.join(rootDir, relativeFile), "utf8")]),
  );
  const nodeFiles = nodeClosure({ paths, packages, contents });
  const declarations = [];

  for (const [relativeFile, content] of contents) {
    for (const record of declarationRecords(relativeFile, content)) {
      const resolved = resolveSpecifier({ importer: relativeFile, specifier: record.specifier, paths, packages });
      if (!resolved || !/^bounded-contexts\/[^/]+\/context\.json$/.test(resolved)) continue;
      declarations.push({ ...record, relativeFile, resolved, disposition: disposition({ relativeFile, nodeFiles }) });
    }
  }

  declarations.sort((left, right) =>
    `${left.relativeFile}:${left.form}:${left.specifier}`.localeCompare(
      `${right.relativeFile}:${right.form}:${right.specifier}`,
    ),
  );
  const partition = Object.fromEntries(
    ["node-enforced", "vite-excluded", "vitest-excluded", "indeterminate"].map((name) => [
      name,
      declarations.filter((entry) => entry.disposition === name).length,
    ]),
  );
  return { parserVersion: ts.version, declarations, partition };
}

export async function validateJsonImportAttributes(options = {}) {
  const inventory = inspectJsonImportAttributes(options);
  const violations = [];
  for (const entry of inventory.declarations) {
    if (entry.disposition === "indeterminate") {
      violations.push(
        `${entry.relativeFile}: relevant context-manifest declaration has no proven execution disposition`,
      );
    } else if (entry.disposition === "node-enforced" && entry.attributeText !== jsonAttributeText) {
      violations.push(
        `${entry.relativeFile}: ${entry.form} ${JSON.stringify(entry.specifier)} must use exactly ${jsonAttributeText}`,
      );
    }
  }
  return { violations, warnings: [], inventory };
}
