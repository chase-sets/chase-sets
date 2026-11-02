import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { listWorkspacePackages, repoRoot } from "../lib/repo.mjs";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];
const sourceExtensionSet = new Set(sourceExtensions);
const jsonAttributeText = 'with { type: "json" }';
const nodeClosureSeeds = [
  "deployables/platform-api/src/context-registry.ts",
  "deployables/platform-worker/src/context-registry.ts",
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

function sourceFile(relativeFile, content, work) {
  if (work) work.fullParses.push(relativeFile);
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

function trackedPaths(rootDir, work) {
  work.gitSubprocesses += 1;
  return new Set(
    execFileSync("git", ["-C", rootDir, "ls-files"], {
      encoding: "utf8",
      maxBuffer: GIT_LISTING_MAX_BUFFER,
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizePath),
  );
}

function gitGrepPaths(rootDir, patterns, work) {
  work.gitSubprocesses += 1;
  work.wholeTreeScans += 1;
  const expression = patterns.map((pattern) => pattern.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&")).join("|");
  try {
    return execFileSync(
      "git",
      ["-C", rootDir, "grep", "-Il", "-E", "-e", expression, "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
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

function declarationRecords(source) {
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

function createSourceReader(readContent, work) {
  const sources = new Map();
  return (relativeFile) => {
    if (!sources.has(relativeFile)) {
      sources.set(relativeFile, sourceFile(relativeFile, readContent(relativeFile), work));
    }
    return sources.get(relativeFile);
  };
}

function createImportReader(readContent) {
  const imports = new Map();
  return (relativeFile) => {
    if (!imports.has(relativeFile)) {
      imports.set(relativeFile, ts.preProcessFile(readContent(relativeFile), true, true).importedFiles);
    }
    return imports.get(relativeFile);
  };
}

function createRecordReader(readSource) {
  const records = new Map();
  return (relativeFile) => {
    if (!records.has(relativeFile)) {
      records.set(relativeFile, declarationRecords(readSource(relativeFile)));
    }
    return records.get(relativeFile);
  };
}

function createContentReader(rootDir, paths, work) {
  const contents = new Map();
  return (relativeFile) => {
    if (!paths.has(relativeFile)) return null;
    if (!contents.has(relativeFile)) {
      work.fileReads.push(relativeFile);
      contents.set(relativeFile, readFileSync(path.join(rootDir, relativeFile), "utf8"));
    }
    return contents.get(relativeFile);
  };
}

function moduleClosure({
  seeds,
  paths,
  packages,
  readContent,
  readRecords,
  readImports,
  localOnly = false,
  targets,
  work,
}) {
  const reverse = new Map();
  const indexed = new Set();
  const toIndex = [...seeds];
  while (toIndex.length > 0) {
    const current = toIndex.pop();
    if (indexed.has(current) || !paths.has(current) || !sourceExtensionSet.has(path.posix.extname(current))) continue;
    indexed.add(current);
    for (const { fileName } of readImports(current)) {
      const resolved = localOnly
        ? fileName.startsWith(".")
          ? resolveRelative(current, fileName, paths)
          : null
        : resolveSpecifier({ importer: current, specifier: fileName, paths, packages });
      if (!resolved || !sourceExtensionSet.has(path.posix.extname(resolved))) continue;
      if (!reverse.has(resolved)) reverse.set(resolved, new Set());
      reverse.get(resolved).add(current);
      toIndex.push(resolved);
    }
  }
  const relevant = new Set();
  const toMark = [...targets].filter((target) => indexed.has(target));
  while (toMark.length > 0) {
    const current = toMark.pop();
    if (relevant.has(current)) continue;
    relevant.add(current);
    toMark.push(...(reverse.get(current) ?? []));
  }
  const receipt = { seeds, indexed: indexed.size, relevant: [...relevant].sort(), size: 0 };
  work.closures.push(receipt);
  const closure = new Set();
  const pending = [...seeds];
  while (pending.length > 0) {
    const current = pending.pop();
    if (closure.has(current) || !paths.has(current) || !sourceExtensionSet.has(path.posix.extname(current))) continue;
    // The compiler preprocessor over-selects (including type-only edges).
    // Only the full AST below can prove an execution edge. A branch with no
    // possible path to a manifest importer cannot affect any disposition.
    if (!relevant.has(current)) continue;
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
  receipt.size = closure.size;
  return closure;
}

function workspacePackageJsonPath(workspace) {
  return normalizePath(path.posix.join(workspace.root, workspace.dirName, "package.json"));
}

function indexedWorkspacePackages(paths, discoveredPackages) {
  return discoveredPackages.filter((workspace) => paths.has(workspacePackageJsonPath(workspace)));
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

function readContextManifests(contexts, readContent) {
  const manifests = new Map();
  const violations = [];
  for (const context of contexts) {
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

function possibleManifestPaths({
  rootDir,
  paths,
  packages,
  readContent,
  readImports,
  manifestSpecifiers,
  contextByManifest,
  useGitPrefilter,
  work,
}) {
  // An escaped module specifier might not contain either ordinary marker in
  // source text. Every such spelling necessarily contains a backslash.
  // The text filter only over-selects; the compiler preprocessor decodes the
  // specifier and the authoritative full AST decides the declaration below.
  const markers = [".json", "\\", ...manifestSpecifiers];
  const sourceCandidates = useGitPrefilter
    ? gitGrepPaths(rootDir, markers, work)
    : [...paths].filter(
        (relativeFile) =>
          sourceExtensionSet.has(path.posix.extname(relativeFile)) &&
          markers.some((marker) => readContent(relativeFile).includes(marker)),
      );
  const candidates = sourceCandidates.filter(
    (relativeFile) =>
      paths.has(relativeFile) &&
      readImports(relativeFile).some(({ fileName }) => {
        const resolved = resolveSpecifier({ importer: relativeFile, specifier: fileName, paths, packages });
        return contextByManifest.has(resolved);
      }),
  );
  work.sourceIndex.prefilterCount = sourceCandidates.length;
  work.sourceIndex.candidateCount = candidates.length;
  return candidates;
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

function viteExecution({
  packages,
  paths,
  readContent,
  readRecords,
  readSource,
  readImports,
  contextByManifest,
  contextManifests,
  targets,
  work,
}) {
  const files = new Set();
  const apps = [];

  for (const workspace of packages) {
    const hostMatch = /^@chase-sets\/app-(.+)$/.exec(workspace.name);
    if (workspace.root !== "deployables" || !hostMatch) continue;
    const workspacePath = normalizePath(path.posix.join(workspace.root, workspace.dirName));
    const viteConfig = `${workspacePath}/vite.config.ts`;
    const routerConfig = `${workspacePath}/react-router.config.ts`;
    if (!paths.has(viteConfig) || !paths.has(routerConfig)) continue;
    work.configParses.push(routerConfig);
    const routerSource = readSource(routerConfig);
    const appDirectory = stringProperty(routerSource, "appDirectory") ?? "app";
    const routeRoot = resolveRelative(routerConfig, `./${appDirectory}/routes`, paths);
    if (!routeRoot) continue;

    const closure = moduleClosure({
      seeds: [routeRoot],
      paths,
      packages,
      readContent,
      readRecords,
      readImports,
      localOnly: true,
      targets,
      work,
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

function vitestConfigPath(workspace, paths) {
  const script = workspace.packageJson.scripts?.test;
  if (typeof script !== "string" || !/(?:^|\s)vitest(?:\s|$)/.test(script)) return null;
  const match = /(?:^|\s)--config\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(script);
  if (!match) return null;
  const configured = match[1] ?? match[2] ?? match[3];
  const relativeFile = normalizePath(path.posix.join(workspace.root, workspace.dirName, configured));
  return paths.has(relativeFile) ? relativeFile : null;
}

function importedModuleForBinding(configFile, source, bindingName, paths) {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(statement.importClause.namedBindings) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!statement.importClause.namedBindings.elements.some((element) => element.name.text === bindingName)) continue;
    return resolveRelative(configFile, statement.moduleSpecifier.text, paths);
  }
  return null;
}

function stringArrayVariable(source, variableName) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue;
      if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) return [];
      return declaration.initializer.elements.filter(ts.isStringLiteral).map((element) => element.text);
    }
  }
  return [];
}

function directIncludePatterns(source) {
  const patterns = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "include") ||
        (ts.isStringLiteral(node.name) && node.name.text === "include")) &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      patterns.push(...node.initializer.elements.filter(ts.isStringLiteral).map((element) => element.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return patterns;
}

function vitestIncludePatterns(configFile, readSource, paths, work) {
  work.configParses.push(configFile);
  const source = readSource(configFile);
  const boundedFactoryModule = importedModuleForBinding(configFile, source, "defineBoundedContextTestConfig", paths);
  if (boundedFactoryModule) {
    work.configParses.push(boundedFactoryModule);
    const shared = readSource(boundedFactoryModule);
    return stringArrayVariable(shared, "boundedContextTestInclude");
  }
  return directIncludePatterns(source);
}

function globPattern(pattern) {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        result += "(?:.*/)?";
      } else {
        result += ".*";
      }
    } else if (character === "*") {
      result += "[^/]*";
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${result}$`);
}

function vitestExecution({ packages, paths, readSource, work }) {
  const files = new Set();
  for (const workspace of packages) {
    const configFile = vitestConfigPath(workspace, paths);
    if (!configFile) continue;
    const patterns = vitestIncludePatterns(configFile, readSource, paths, work).map(globPattern);
    if (patterns.length === 0) continue;
    const workspacePath = normalizePath(path.posix.join(workspace.root, workspace.dirName));
    const prefix = `${workspacePath}/`;
    for (const relativeFile of paths) {
      if (!relativeFile.startsWith(prefix)) continue;
      const workspaceRelative = relativeFile.slice(prefix.length);
      if (patterns.some((pattern) => pattern.test(workspaceRelative))) files.add(relativeFile);
    }
  }
  return files;
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
  const work = { gitSubprocesses: 0, wholeTreeScans: 0, fileReads: [], fullParses: [], configParses: [], closures: [] };
  let paths = options.paths ?? trackedPaths(rootDir, work);
  paths = new Set([...paths].map(normalizePath));
  const readContent = createContentReader(rootDir, paths, work);
  const sourceIndex = [...paths].filter((file) => sourceExtensionSet.has(path.posix.extname(file))).sort();
  work.indexCandidates = sourceIndex;
  work.sourceIndex = {
    kind: "git-index-source/v1",
    pathCount: paths.size,
    sourceCount: sourceIndex.length,
    candidates: [],
  };
  // Unfiltered filesystem discovery only witnesses an index collapse below.
  // Resolution and context enrollment use Git-index members, so untracked
  // workspace metadata cannot move the partition.
  const discoveredPackages = listWorkspacePackages({ repoRoot: rootDir });
  const packages = indexedWorkspacePackages(paths, discoveredPackages);
  work.discoveredWorkspaces = discoveredPackages.map(workspacePackageJsonPath);
  work.enrolledWorkspaces = packages.map(workspacePackageJsonPath);
  const readSource = createSourceReader(readContent, work);
  const readImports = createImportReader(readContent);
  const readRecords = createRecordReader(readSource);
  const contexts = implementedContexts(packages, rootDir).filter(({ manifestPath }) => paths.has(manifestPath));
  const contextByManifest = new Map(contexts.map((context) => [context.manifestPath, context]));
  const contextManifestResult = readContextManifests(contexts, readContent);
  const manifestSpecifiers = contextManifestSpecifiers(packages);
  const candidates = possibleManifestPaths({
    rootDir,
    paths,
    packages,
    readContent,
    readImports,
    manifestSpecifiers,
    contextByManifest,
    useGitPrefilter: options.paths === undefined,
    work,
  });
  work.manifestCandidates = [...candidates].sort();
  work.sourceIndex.candidates = work.manifestCandidates;
  const nodeFiles = moduleClosure({
    seeds: nodeClosureSeeds,
    paths,
    packages,
    readContent,
    readRecords,
    readImports,
    targets: candidates,
    work,
  });
  const vite = viteExecution({
    packages,
    paths,
    readContent,
    readRecords,
    readSource,
    readImports,
    contextByManifest,
    contextManifests: contextManifestResult.manifests,
    targets: candidates,
    work,
  });
  const vitestFiles = vitestExecution({ packages, paths, readSource, work });
  const declarations = [];

  for (const relativeFile of candidates) {
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
          vitestFiles,
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
  const discoveryViolations = [...contextManifestResult.violations];
  const witnessContexts = implementedContexts(discoveredPackages, rootDir);
  if (witnessContexts.length > 0 && declarations.length === 0) {
    discoveryViolations.push(
      `JSON import-attribute discovery collapsed despite ${witnessContexts.length} implemented context manifest(s)`,
    );
  }
  const appsWithoutRegistryEntries = vite.apps.filter((app) => app.activeManifests.size === 0);
  if (appsWithoutRegistryEntries.length > 0) {
    discoveryViolations.push(
      `JSON import-attribute Vite discovery collapsed for configured React Router app(s): ${appsWithoutRegistryEntries.map((app) => app.hostName).join(", ")}`,
    );
  }
  return { parserVersion: ts.version, declarations, partition, discoveryViolations, work };
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
