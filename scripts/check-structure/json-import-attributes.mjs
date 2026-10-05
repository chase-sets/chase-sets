import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { listWorkspacePackages, repoRoot } from "../lib/repo.mjs";
import { discoverConfigTests } from "./db-profile-script-canonical-form.mjs";

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];
const sourceExtensionSet = new Set(sourceExtensions);
const jsonAttributeText = 'with { type: "json" }';
const nodeClosureSeeds = [
  "deployables/platform-api/src/generated/api-context-registry.ts",
  "deployables/platform-worker/src/generated/worker-context-registry.ts",
];
export const manifestHostRegistrationFields = Object.freeze([
  "apiDeployables",
  "runtimeDeployables",
  "sourceRuntimeDeployables",
  "sourceRuntimeProfiles",
  "deployableContributions",
  "shellContributions",
]);

function normalizePath(value) {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function scriptKind(relativeFile) {
  return relativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function sourceFile(relativeFile, content) {
  return ts.createSourceFile(
    relativeFile,
    content,
    {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
    },
    false,
    scriptKind(relativeFile),
  );
}

function trackedPaths(rootDir) {
  return new Set(
    execFileSync("git", ["-C", rootDir, "ls-files"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizePath),
  );
}

function gitGrepPaths(rootDir, patterns) {
  try {
    return execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "grep",
        "-IlF",
        ...patterns.flatMap((pattern) => ["-e", pattern]),
        "--",
        "*.ts",
        "*.tsx",
        "*.mts",
        "*.cts",
      ],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizePath);
  } catch (error) {
    if (error?.status === 1) return [];
    throw error;
  }
}

function resolveRelative(importer, specifier, paths) {
  const target = normalizePath(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [
    target,
    ...sourceExtensions.map((extension) => `${target}${extension}`),
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
  if (ts.isImportDeclaration(declaration)) {
    const clause = declaration.importClause;
    if (clause?.isTypeOnly) return false;
    if (
      clause &&
      !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((specifier) => specifier.isTypeOnly)
    ) {
      return false;
    }
  }

  if (ts.isExportDeclaration(declaration)) {
    if (declaration.isTypeOnly) return false;
    if (
      declaration.exportClause &&
      ts.isNamedExports(declaration.exportClause) &&
      declaration.exportClause.elements.length > 0 &&
      declaration.exportClause.elements.every((specifier) => specifier.isTypeOnly)
    ) {
      return false;
    }
  }

  return true;
}

function declarationRecords(relativeFile, content) {
  const source = sourceFile(relativeFile, content);
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

function createRecordReader(readContent) {
  const records = new Map();
  return (relativeFile) => {
    if (!records.has(relativeFile)) {
      records.set(relativeFile, declarationRecords(relativeFile, readContent(relativeFile)));
    }
    return records.get(relativeFile);
  };
}

function createContentReader(rootDir, paths) {
  const contents = new Map();
  return (relativeFile) => {
    if (!paths.has(relativeFile)) return null;
    if (!contents.has(relativeFile)) {
      contents.set(relativeFile, readFileSync(path.join(rootDir, relativeFile), "utf8"));
    }
    return contents.get(relativeFile);
  };
}

function moduleClosure({ seeds, paths, packages, readContent, readRecords, localOnly = false }) {
  const closure = new Set();
  const pending = [...seeds];
  while (pending.length > 0) {
    const current = pending.pop();
    if (closure.has(current) || !paths.has(current) || !sourceExtensionSet.has(path.posix.extname(current))) continue;
    const content = readContent(current);
    if (content === null) continue;
    closure.add(current);
    if (!content.includes("import") && !content.includes("export")) continue;
    for (const record of readRecords(current)) {
      const resolved = localOnly
        ? record.specifier.startsWith(".")
          ? resolveRelative(current, record.specifier, paths)
          : null
        : resolveSpecifier({ importer: current, specifier: record.specifier, paths, packages });
      if (resolved && sourceExtensionSet.has(path.posix.extname(resolved))) pending.push(resolved);
    }
  }
  return closure;
}

function implementedContexts(packages, rootDir) {
  return packages.flatMap((workspace) => {
    if (workspace.root !== "bounded-contexts") return [];
    const contextTarget = workspace.packageJson.exports?.["./context"];
    if (typeof contextTarget !== "string") return [];
    const manifestPath = normalizePath(path.posix.join(workspace.root, workspace.dirName, contextTarget));
    if (!/^bounded-contexts\/[^/]+\/context\.json$/.test(manifestPath)) return [];
    const fullManifestPath = path.join(rootDir, manifestPath);
    if (!existsSync(fullManifestPath)) return [];
    const rootTarget = workspace.packageJson.exports?.["."];
    return [
      {
        contextName: workspace.dirName,
        manifestPath,
        rootEntryPath:
          typeof rootTarget === "string"
            ? normalizePath(path.posix.join(workspace.root, workspace.dirName, rootTarget))
            : null,
      },
    ];
  });
}

function readContextManifests(contexts, paths, readContent) {
  const manifests = new Map();
  const violations = [];
  for (const context of contexts) {
    if (!paths.has(context.manifestPath)) continue;
    try {
      const manifest = JSON.parse(readContent(context.manifestPath));
      if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new TypeError("context manifest must be a JSON object");
      }
      manifests.set(context.manifestPath, manifest);
    } catch {
      violations.push(`${context.manifestPath}: implemented context manifest is not usable JSON`);
    }
  }
  return { manifests, violations };
}

function contextManifestSpecifiers(packages) {
  const specifiers = new Set();
  for (const workspace of packages) {
    for (const [subpath, target] of Object.entries(workspace.packageJson.exports ?? {})) {
      if (typeof target !== "string") continue;
      const resolved = normalizePath(path.posix.join(workspace.root, workspace.dirName, target));
      if (!/^bounded-contexts\/[^/]+\/context\.json$/.test(resolved)) continue;
      specifiers.add(subpath === "." ? workspace.name : `${workspace.name}/${subpath.slice(2)}`);
    }
  }
  return specifiers;
}

function possibleManifestSource(content, manifestSpecifiers) {
  return ts
    .preProcessFile(content, true, true)
    .importedFiles.some(({ fileName }) => fileName.endsWith(".json") || manifestSpecifiers.has(fileName));
}

function possibleManifestPaths({ rootDir, paths, readContent, manifestSpecifiers, useGitPrefilter }) {
  if (!useGitPrefilter) {
    return [...paths].filter(
      (relativeFile) =>
        sourceExtensionSet.has(path.posix.extname(relativeFile)) &&
        possibleManifestSource(readContent(relativeFile), manifestSpecifiers),
    );
  }

  const ordinary = new Set(gitGrepPaths(rootDir, [".json", ...manifestSpecifiers]));
  // An escaped module specifier might not contain either ordinary marker in
  // source text. Every such spelling necessarily contains a backslash, while
  // every static import/export declaration necessarily contains its keyword.
  // Their intersection deliberately over-selects and is then parsed by the
  // authoritative TypeScript AST below.
  const escaped = new Set(gitGrepPaths(rootDir, ["\\"]));
  const declarations = new Set(gitGrepPaths(rootDir, ["import", "export"]));
  for (const relativeFile of escaped) {
    if (declarations.has(relativeFile)) ordinary.add(relativeFile);
  }
  return [...ordinary].filter(
    (relativeFile) => paths.has(relativeFile) && possibleManifestSource(readContent(relativeFile), manifestSpecifiers),
  );
}

function stringProperty(source, propertyName) {
  let value = null;
  const visit = (node) => {
    if (
      value === null &&
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === propertyName) ||
        (ts.isStringLiteral(node.name) && node.name.text === propertyName)) &&
      ts.isStringLiteral(node.initializer)
    ) {
      value = node.initializer.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return value;
}

function viteExecution({ packages, paths, readContent, readRecords, contextByManifest, contextManifests }) {
  const files = new Set();
  const apps = [];

  for (const workspace of packages) {
    const hostMatch = /^@chase-sets\/app-(.+)$/.exec(workspace.name);
    if (workspace.root !== "deployables" || !hostMatch) continue;
    const workspacePath = normalizePath(path.posix.join(workspace.root, workspace.dirName));
    const viteConfig = `${workspacePath}/vite.config.ts`;
    const routerConfig = `${workspacePath}/react-router.config.ts`;
    if (!paths.has(viteConfig) || !paths.has(routerConfig)) continue;
    const routerSource = sourceFile(routerConfig, readContent(routerConfig));
    const appDirectory = stringProperty(routerSource, "appDirectory") ?? "app";
    const routeRoot = resolveRelative(routerConfig, `./${appDirectory}/routes`, paths);
    if (!routeRoot) continue;

    const closure = moduleClosure({
      seeds: [routeRoot],
      paths,
      packages,
      readContent,
      readRecords,
      localOnly: true,
    });
    const activeManifests = new Set();
    for (const relativeFile of closure) {
      for (const record of readRecords(relativeFile)) {
        const resolved = resolveSpecifier({
          importer: relativeFile,
          specifier: record.specifier,
          paths,
          packages,
        });
        if (!resolved || !contextByManifest.has(resolved)) continue;
        files.add(relativeFile);
        activeManifests.add(resolved);
      }
    }

    const hostName = hostMatch[1];
    for (const manifestPath of activeManifests) {
      const context = contextByManifest.get(manifestPath);
      const manifest = contextManifests.get(manifestPath);
      if (!manifest) continue;
      for (const contribution of manifest.deployableContributions ?? []) {
        if (contribution?.deployable !== hostName || !Array.isArray(contribution.routes)) continue;
        for (const route of contribution.routes) {
          if (typeof route?.fileExport !== "string" || !route.fileExport.startsWith(".")) continue;
          const resolved = resolveRelative(manifestPath, route.fileExport, paths);
          if (resolved && sourceExtensionSet.has(path.posix.extname(resolved))) files.add(resolved);
        }
      }
      if (!context) throw new Error(`missing implemented context for ${manifestPath}`);
    }
    apps.push({ hostName, routeRoot, activeManifests });
  }

  return { files, apps };
}

function vitestExecution({ packages, paths }) {
  const files = new Set();
  const violations = [];
  const cache = new Map();
  for (const workspace of packages) {
    const workspacePath = normalizePath(path.posix.join(workspace.root, workspace.dirName));
    const prefix = `${workspacePath}/`;
    const workspaceFiles = [...paths]
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length));
    const configs = new Set();
    for (const [name, script] of Object.entries(workspace.packageJson.scripts ?? {})) {
      if (!/^(?:test|test:unit|test:db(?::[1-9]\d*)?)$/.test(name)) continue;
      // Admit the canonical command grammar, not shell expressions or inferred membership.
      const match = /^vitest run --config ((?:\.\/)?[\w./-]+\.(?:mjs|ts))$/.exec(script);
      if (match) configs.add(match[1]);
      else if (/(?:^|\s)vitest(?:\s|$)/.test(script))
        violations.push(`${workspace.name} ${name}: cannot derive Vitest execution from a noncanonical command`);
    }
    for (const configPath of configs) {
      try {
        const selected = discoverConfigTests(workspace.dir, configPath, workspaceFiles, cache);
        for (const file of selected.files) files.add(`${prefix}${file}`);
      } catch (error) {
        violations.push(`${workspace.name} ${configPath}: cannot derive Vitest execution; ${error.message}`);
      }
    }
  }
  return { files, violations };
}

function hasNoHostRegistration(manifest) {
  return manifestHostRegistrationFields.every(
    (field) => manifest[field] === undefined || (Array.isArray(manifest[field]) && manifest[field].length === 0),
  );
}

function disposition({
  relativeFile,
  resolved,
  nodeFiles,
  viteFiles,
  vitestFiles,
  contextByManifest,
  contextManifests,
}) {
  if (nodeFiles.has(relativeFile)) return "node-enforced";
  if (viteFiles.has(relativeFile)) return "vite-excluded";
  if (vitestFiles.has(relativeFile)) return "vitest-excluded";
  const context = contextByManifest.get(resolved);
  const manifest = contextManifests.get(resolved);
  if (context?.rootEntryPath === relativeFile && manifest && hasNoHostRegistration(manifest)) return "manifest-only";
  return "indeterminate";
}

export function inspectJsonImportAttributes(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  let paths = options.paths ?? trackedPaths(rootDir);
  const useGitPrefilter = options.paths === undefined;
  paths = new Set([...paths].map(normalizePath));
  const packages = listWorkspacePackages({ repoRoot: rootDir });
  const readContent = createContentReader(rootDir, paths);
  const readRecords = createRecordReader(readContent);
  const contexts = implementedContexts(packages, rootDir);
  const contextByManifest = new Map(contexts.map((context) => [context.manifestPath, context]));
  const contextManifestResult = readContextManifests(contexts, paths, readContent);
  const nodeFiles = moduleClosure({ seeds: nodeClosureSeeds, paths, packages, readContent, readRecords });
  const vite = viteExecution({
    packages,
    paths,
    readContent,
    readRecords,
    contextByManifest,
    contextManifests: contextManifestResult.manifests,
  });
  const vitest = vitestExecution({ packages, paths });
  const manifestSpecifiers = contextManifestSpecifiers(packages);
  const declarations = [];

  const candidates = possibleManifestPaths({
    rootDir,
    paths,
    readContent,
    manifestSpecifiers,
    useGitPrefilter,
  });
  for (const relativeFile of candidates) {
    const content = readContent(relativeFile);
    for (const record of readRecords(relativeFile)) {
      const resolved = resolveSpecifier({ importer: relativeFile, specifier: record.specifier, paths, packages });
      if (!resolved || !contextByManifest.has(resolved)) continue;
      declarations.push({
        ...record,
        relativeFile,
        resolved,
        disposition: disposition({
          relativeFile,
          resolved,
          nodeFiles,
          viteFiles: vite.files,
          vitestFiles: vitest.files,
          contextByManifest,
          contextManifests: contextManifestResult.manifests,
        }),
      });
    }
  }

  declarations.sort((left, right) =>
    `${left.relativeFile}:${left.form}:${left.specifier}`.localeCompare(
      `${right.relativeFile}:${right.form}:${right.specifier}`,
    ),
  );
  const partition = Object.fromEntries(
    ["node-enforced", "vite-excluded", "vitest-excluded", "manifest-only", "indeterminate"].map((name) => [
      name,
      declarations.filter((entry) => entry.disposition === name).length,
    ]),
  );
  const discoveryViolations = [...contextManifestResult.violations, ...vitest.violations];
  if (contexts.length > 0 && declarations.length === 0) {
    discoveryViolations.push(
      `JSON import-attribute discovery collapsed despite ${contexts.length} implemented context manifest(s)`,
    );
  }
  const appsWithoutRegistryEntries = vite.apps.filter((app) => app.activeManifests.size === 0);
  if (appsWithoutRegistryEntries.length > 0) {
    discoveryViolations.push(
      `JSON import-attribute Vite discovery collapsed for configured React Router app(s): ${appsWithoutRegistryEntries.map((app) => app.hostName).join(", ")}`,
    );
  }
  return { parserVersion: ts.version, declarations, partition, discoveryViolations };
}

export async function validateJsonImportAttributes(options = {}) {
  const inventory = inspectJsonImportAttributes(options);
  const violations = [...inventory.discoveryViolations];
  for (const entry of inventory.declarations) {
    if (entry.disposition === "indeterminate") {
      violations.push(
        `${entry.relativeFile}: relevant context-manifest declaration has no proven execution disposition`,
      );
    } else if (
      (entry.disposition === "node-enforced" || entry.disposition === "manifest-only") &&
      entry.attributeText !== jsonAttributeText
    ) {
      violations.push(
        `${entry.relativeFile}: ${entry.form} ${JSON.stringify(entry.specifier)} must use exactly ${jsonAttributeText}`,
      );
    }
  }
  return { violations, warnings: [], inventory };
}
