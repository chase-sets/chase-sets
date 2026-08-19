import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { listWorkspacePackages, repoRoot } from "../lib/repo.mjs";

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];
const sourceExtensionSet = new Set(sourceExtensions);
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

function viteExecution({ packages, paths, readContent, readRecords, contextByManifest }) {
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
      const manifest = JSON.parse(readContent(manifestPath));
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

function vitestIncludePatterns(configFile, readContent, paths) {
  const source = sourceFile(configFile, readContent(configFile));
  const boundedFactoryModule = importedModuleForBinding(configFile, source, "defineBoundedContextTestConfig", paths);
  if (boundedFactoryModule) {
    const shared = sourceFile(boundedFactoryModule, readContent(boundedFactoryModule));
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

function vitestExecution({ packages, paths, readContent }) {
  const files = new Set();
  for (const workspace of packages) {
    const configFile = vitestConfigPath(workspace, paths);
    if (!configFile) continue;
    const patterns = vitestIncludePatterns(configFile, readContent, paths).map(globPattern);
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

function disposition({ relativeFile, nodeFiles, viteFiles, vitestFiles }) {
  if (nodeFiles.has(relativeFile)) return "node-enforced";
  if (viteFiles.has(relativeFile)) return "vite-excluded";
  if (vitestFiles.has(relativeFile)) return "vitest-excluded";
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
  const nodeFiles = moduleClosure({ seeds: nodeClosureSeeds, paths, packages, readContent, readRecords });
  const vite = viteExecution({ packages, paths, readContent, readRecords, contextByManifest });
  const vitestFiles = vitestExecution({ packages, paths, readContent });
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
        disposition: disposition({ relativeFile, nodeFiles, viteFiles: vite.files, vitestFiles }),
      });
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
  const discoveryViolations = [];
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
    } else if (entry.disposition === "node-enforced" && entry.attributeText !== jsonAttributeText) {
      violations.push(
        `${entry.relativeFile}: ${entry.form} ${JSON.stringify(entry.specifier)} must use exactly ${jsonAttributeText}`,
      );
    }
  }
  return { violations, warnings: [], inventory };
}
