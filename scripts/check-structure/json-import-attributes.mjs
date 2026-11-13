import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { CONTEXT_REGISTRY_HOST_ARMS, listWorkspacePackages, repoRoot } from "../lib/repo.mjs";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];
const sourceExtensionSet = new Set(sourceExtensions);
const jsonAttributeText = 'with { type: "json" }';
const nodeClosureSeeds = [
  "deployables/platform-api/src/context-registry.ts",
  "deployables/platform-worker/src/context-registry.ts",
];
export const manifestHostRegistrationFields = Object.freeze([
  ...new Set(CONTEXT_REGISTRY_HOST_ARMS.map((arm) => arm.field)),
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
  // Fixed strings need no escaping. Git for Windows did not honor escapes in
  // an -E alternation: `\.json` matched like `.json` and `\\` matched nothing.
  const expressions = patterns.flatMap((pattern) => ["-e", pattern]);
  try {
    return execFileSync(
      "git",
      ["-C", rootDir, "grep", "-I", "-l", "-F", ...expressions, "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
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

const packageOrderByName = new WeakMap();

function packageResolution(packages, specifier) {
  if (!packageOrderByName.has(packages)) {
    const orderByName = new Map();
    packages.forEach((workspace, order) => {
      if (!orderByName.has(workspace.name)) orderByName.set(workspace.name, order);
    });
    packageOrderByName.set(packages, orderByName);
  }
  const orderByName = packageOrderByName.get(packages);
  // The first workspace in package order named by the specifier itself or by
  // a prefix that ends before one of its slashes.
  let order = orderByName.get(specifier);
  for (let slash = specifier.indexOf("/"); slash !== -1; slash = specifier.indexOf("/", slash + 1)) {
    const prefixOrder = orderByName.get(specifier.slice(0, slash));
    if (prefixOrder !== undefined && (order === undefined || prefixOrder < order)) order = prefixOrder;
  }
  if (order === undefined) return null;
  const workspace = packages[order];
  const subpath = specifier === workspace.name ? "." : `./${specifier.slice(workspace.name.length + 1)}`;
  const target = workspace.packageJson.exports?.[subpath];
  return typeof target === "string" ? normalizePath(path.posix.join(workspace.root, workspace.dirName, target)) : null;
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

const quotedSpanPatterns = [/"([^"\r\n]*)/g, /'([^'\r\n]*)/g];

// Every import and export declaration specifier is a string literal. Without
// a backslash, a string literal's value is the text after its opening quote up
// to the next same quote, carriage return or line feed (the scanner keeps line
// and paragraph separators), so that span after every quote over-selects
// every specifier the full AST can record.
function quotedSpans(content) {
  const spans = new Set();
  for (const pattern of quotedSpanPatterns) {
    for (const [, span] of content.matchAll(pattern)) spans.add(span);
  }
  return Array.from(spans, (fileName) => ({ fileName }));
}

function createImportReader(readContent) {
  const imports = new Map();
  return (relativeFile) => {
    if (!imports.has(relativeFile)) {
      const content = readContent(relativeFile);
      imports.set(
        relativeFile,
        content.includes("\\") ? ts.preProcessFile(content, true, true).importedFiles : quotedSpans(content),
      );
    }
    return imports.get(relativeFile);
  };
}

// Decodes every backslash escape the way a string literal does, except that
// \b, \f, \n, \r, \t and \v keep their letter and a malformed escape drops
// only its backslash. Outside a string literal a backslash never starts an
// escape that reaches a string's opening quote, so the decoded text contains
// each string literal's value apart from those control characters and
// backslashes, neither of which occurs in a marker. Line continuations,
// including over line and paragraph separators (\p{Zl}, \p{Zp}), decode to "".
function decodeEscapes(content) {
  return content.replace(
    /\\(?:u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\s\S]))/g,
    (escape, codePoint, unicode, hex, octal, other) => {
      if (codePoint !== undefined) {
        const value = Number.parseInt(codePoint, 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : escape.slice(1);
      }
      if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
      if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8));
      return /^(?:\r\n|[\r\n\p{Zl}\p{Zp}])$/u.test(other) ? "" : other;
    },
  );
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
  const forward = new Map();
  const reverse = new Map();
  const indexed = new Set();
  const toIndex = [...seeds];
  while (toIndex.length > 0) {
    const current = toIndex.pop();
    if (indexed.has(current) || !paths.has(current) || !sourceExtensionSet.has(path.posix.extname(current))) continue;
    indexed.add(current);
    const children = new Set();
    forward.set(current, children);
    for (const { fileName } of readImports(current)) {
      const resolved = localOnly
        ? fileName.startsWith(".")
          ? resolveRelative(current, fileName, paths)
          : null
        : resolveSpecifier({ importer: current, specifier: fileName, paths, packages });
      if (!resolved || !sourceExtensionSet.has(path.posix.extname(resolved))) continue;
      children.add(resolved);
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
    // The import reader over-selects (including type-only edges).
    // Only the full AST below can prove an execution edge. A branch with no
    // possible path to a manifest importer cannot affect any disposition.
    if (!relevant.has(current)) continue;
    const content = readContent(current);
    if (content === null) continue;
    closure.add(current);
    if (!content.includes("import") && !content.includes("export")) continue;
    // Execution edges are a subset of the indexed edges, so a file whose
    // relevant indexed children are all in the closure cannot extend it.
    if ([...forward.get(current)].every((child) => closure.has(child) || !relevant.has(child))) continue;
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
  // A relative specifier resolves to a manifest only when its last normalized
  // segment is the manifest file name, so an unescaped spelling contains that
  // name (an importer directory cannot share a tracked file's path). Package
  // specifiers are matched whole. An escaped spelling might contain neither
  // marker, but every such spelling contains a backslash, and its decoded
  // value still contains a marker.
  // The text filters only over-select; the import reader decodes the
  // specifier and the authoritative full AST decides the declaration below.
  const manifestNames = new Set([...contextByManifest.keys()].map((manifestPath) => path.posix.basename(manifestPath)));
  const nameMarkers = [...manifestNames, ...manifestSpecifiers];
  const nameMarkerPattern = new RegExp(
    nameMarkers.map((marker) => marker.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&")).join("|") || "(?!)",
  );
  const markers = [...manifestNames, "\\", ...manifestSpecifiers];
  const sourceCandidates = useGitPrefilter
    ? gitGrepPaths(rootDir, markers, work)
    : [...paths].filter(
        (relativeFile) =>
          sourceExtensionSet.has(path.posix.extname(relativeFile)) &&
          markers.some((marker) => readContent(relativeFile).includes(marker)),
      );
  const candidates = sourceCandidates.filter((relativeFile) => {
    if (!paths.has(relativeFile)) return false;
    const content = readContent(relativeFile);
    // Without a backslash, the prefilter already matched a name marker.
    if (content.includes("\\") && !nameMarkerPattern.test(decodeEscapes(content))) return false;
    return readImports(relativeFile).some(({ fileName }) => {
      const resolved = resolveSpecifier({ importer: relativeFile, specifier: fileName, paths, packages });
      return contextByManifest.has(resolved);
    });
  });
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
  const patternsByPrefix = new Map();
  for (const workspace of packages) {
    const configFile = vitestConfigPath(workspace, paths);
    if (!configFile) continue;
    const patterns = vitestIncludePatterns(configFile, readSource, paths, work).map(globPattern);
    if (patterns.length === 0) continue;
    const workspacePath = normalizePath(path.posix.join(workspace.root, workspace.dirName));
    const prefix = `${workspacePath}/`;
    patternsByPrefix.set(prefix, [...(patternsByPrefix.get(prefix) ?? []), ...patterns]);
  }
  // One pass over the index: each path is tested only against the workspaces
  // whose directory prefix it starts with.
  const files = new Set();
  for (const relativeFile of paths) {
    for (let slash = relativeFile.indexOf("/"); slash !== -1; slash = relativeFile.indexOf("/", slash + 1)) {
      const patterns = patternsByPrefix.get(relativeFile.slice(0, slash + 1));
      const workspaceRelative = relativeFile.slice(slash + 1);
      if (patterns?.some((pattern) => pattern.test(workspaceRelative))) files.add(relativeFile);
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
  // Tracked paths are already normalized.
  const paths = options.paths ? new Set([...options.paths].map(normalizePath)) : trackedPaths(rootDir, work);
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
