import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { listChangedFiles } from "./change-scope.mjs";
import { GIT_LISTING_MAX_BUFFER } from "./lib/git-listing.mjs";
import { listWorkspacePackages, normalizePath, normalizeRelative, repoRoot, workspaceRoots } from "./lib/repo.mjs";

const programs = [
  ["source", "tsconfig.json"],
  ["strict", "tsconfig.strict.json"],
  ["test", "tsconfig.tests.json"],
];
const typecheckRoots = new Set(workspaceRoots);
const typeScriptPath = /\.(?:[cm]?ts|tsx)$/i;
const declarationPath = /\.d\.[cm]?ts$/i;
const globalInputPath =
  /^(?:package\.json|pnpm-lock\.yaml|tsconfig(?:\.[^/]+)?\.json|vitest\.shared\.mjs|[^/]+\.d\.ts)$/i;
const workspaceConfigPath = /^(?:package\.json|tsconfig[^/]*\.json)$/i;

export class TypecheckInputError extends Error {
  exitCode = 2;

  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function deriveChangedFiles({ root = repoRoot, env = process.env, execFile = execFileSync } = {}) {
  if (env.CHANGED_FILES_JSON !== undefined) {
    let files;
    try {
      files = JSON.parse(env.CHANGED_FILES_JSON);
    } catch {
      throw new TypecheckInputError("TYPECHECK_CHANGED_CHANGED_FILES_INVALID", "CHANGED_FILES_JSON must be valid JSON");
    }
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || !file.trim())) {
      throw new TypecheckInputError(
        "TYPECHECK_CHANGED_CHANGED_FILES_INVALID",
        "CHANGED_FILES_JSON must be an array of non-empty file paths",
      );
    }
    return files;
  }
  try {
    return listChangedFiles("origin/main", "HEAD", { cwd: root, execFileSync: execFile });
  } catch (error) {
    throw new TypecheckInputError(
      "TYPECHECK_CHANGED_DERIVATION_FAILED",
      `could not derive changed files (${error.message})`,
    );
  }
}

export function parseWorkspaceSelectors(argv) {
  const names = [];
  for (const arg of argv) {
    const [flag, ...values] = arg.split("=");
    const value = values.length === 1 ? values[0] : "";
    const entries = flag === "--workspace-list" ? value.split(",") : flag === "--workspace" ? [value] : [];
    if (!entries.length || entries.some((name) => !name || name !== name.trim() || name.includes(","))) {
      throw new TypecheckInputError("TYPECHECK_SCOPE_INVALID_SELECTOR", `invalid workspace selector: ${arg}`);
    }
    names.push(...entries);
  }
  return [...new Set(names)];
}

function readFullPrograms(root) {
  const fail = (diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  };
  return programs.map(([name, config]) => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path.join(root, config),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: fail,
      },
    );
    if (parsed.errors.length) fail(parsed.errors[0]);
    return {
      name,
      config,
      roots: parsed.fileNames.map((file) => normalizeRelative(file, root)),
      options: parsed.options,
    };
  });
}

function hasGlobalDeclaration(file, content) {
  if (declarationPath.test(file) || !/\bdeclare\b/.test(content)) return false;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest);
  function visit(node) {
    return (
      (ts.isModuleDeclaration(node) &&
        (Boolean(node.flags & ts.NodeFlags.GlobalAugmentation) ||
          (Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) &&
            !(node.flags & ts.NodeFlags.Namespace)))) ||
      ts.forEachChild(node, visit)
    );
  }
  return Boolean(visit(source));
}

function hasGlobalContext(file, content, references = ts.preProcessFile(content, false)) {
  const { referencedFiles, typeReferenceDirectives, libReferenceDirectives } = references;
  return Boolean(
    hasGlobalDeclaration(file, content) ||
    referencedFiles.length ||
    typeReferenceDirectives.length ||
    libReferenceDirectives.length,
  );
}

function mergeBaseFileReader(root) {
  const hasGit = existsSync(path.join(root, ".git"));
  const options = { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: GIT_LISTING_MAX_BUFFER };
  let base;
  return (file) => {
    if (!hasGit) return;
    base ??= execFileSync("git", ["merge-base", "origin/main", "HEAD"], options).trim();
    if (execFileSync("git", ["--literal-pathspecs", "ls-tree", "-z", base, "--", file], options)) {
      return execFileSync("git", ["show", `${base}:${file}`], options);
    }
  };
}

function ambientAssetTarget(specifier, relativeTarget, root, options, ambientPatterns) {
  if (
    !ambientPatterns.some((pattern) =>
      typeof pattern === "string" ? pattern === specifier : ts.isPatternMatch(pattern, specifier),
    )
  ) {
    return undefined;
  }
  let candidates = relativeTarget ? [path.resolve(root, relativeTarget)] : [];
  if (!relativeTarget && options.paths) {
    const pattern = ts.matchPatternOrExact(ts.tryParsePatterns(options.paths), specifier);
    if (pattern) {
      const key = typeof pattern === "string" ? pattern : `${pattern.prefix}*${pattern.suffix}`;
      const matched = typeof pattern === "string" ? "" : ts.matchedText(pattern, specifier);
      candidates = options.paths[key].map((target) =>
        path.resolve(
          ts.getPathsBasePath(options, ts.sys),
          target.replaceAll("*", () => matched),
        ),
      );
    }
  }
  return candidates.find((target) => !typeScriptPath.test(target) && ts.sys.fileExists(target));
}

function readGraph(root, fullPrograms, ownerOf) {
  const options = fullPrograms[0].options;
  const canonical = ts.sys.useCaseSensitiveFileNames ? (file) => file : (file) => file.toLowerCase();
  const cache = ts.createModuleResolutionCache(root, canonical, options);
  const forward = new Map();
  const reverse = new Map();
  const globalContextRoots = new Set();
  const ambientPatterns = [];
  const unresolved = [];
  const pending = new Set(fullPrograms.flatMap(({ roots }) => roots));
  const fullRoots = new Set(pending);
  function link(from, absoluteTarget) {
    const target = normalizeRelative(absoluteTarget, root);
    if (target.startsWith("../") || path.isAbsolute(target) || target.split("/").includes("node_modules")) return;
    forward.get(from).add(target);
    if (!reverse.has(target)) reverse.set(target, new Set());
    reverse.get(target).add(from);
    if (typeScriptPath.test(target)) pending.add(target);
  }
  for (const file of pending) {
    const absolute = path.resolve(root, file);
    const owner = ownerOf(file);
    forward.set(file, new Set());
    const content = readFileSync(absolute, "utf8");
    const preprocessed = ts.preProcessFile(content, true, true);
    // References can supply globals to other roots even when nothing imports the referring file.
    if (hasGlobalContext(file, content, preprocessed)) globalContextRoots.add(file);
    const { importedFiles, referencedFiles } = preprocessed;
    if (fullRoots.has(file) && declarationPath.test(file)) {
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest);
      if (!ts.isExternalModule(source)) {
        for (const statement of source.statements) {
          if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue;
          const pattern = ts.tryParsePattern(statement.name.text);
          if (pattern) ambientPatterns.push(pattern);
        }
      }
    }
    for (const specifier of new Set(importedFiles.map(({ fileName }) => fileName))) {
      const { resolvedModule } = ts.resolveModuleName(specifier, absolute, options, ts.sys, cache);
      if (resolvedModule) {
        link(file, resolvedModule.resolvedFileName);
        continue;
      }
      const relative = /^\.\.?\//.test(specifier);
      const target = relative ? normalizeRelative(path.resolve(path.dirname(absolute), specifier), root) : null;
      if (
        specifier.startsWith("@chase-sets/") ||
        (relative && (ownerOf(target) !== owner || target.split("/")[0] !== file.split("/")[0]))
      ) {
        unresolved.push({ file, specifier, target });
      }
    }
    for (const { fileName } of referencedFiles) {
      const target = path.resolve(path.dirname(absolute), fileName);
      if (existsSync(target)) link(file, target);
    }
  }
  const fallbacks = [];
  for (const { file, specifier, target } of unresolved) {
    // TypeScript can resolve an ambient asset module that has no filesystem type
    // entry. Keep the actual file edge, but don't let a wildcard hide a missing path.
    const asset = ambientAssetTarget(specifier, target, root, options, ambientPatterns);
    if (asset) link(file, asset);
    else fallbacks.push({ reason: "unresolved-workspace-import", path: file, specifier });
  }
  const workspaceFiles = new Map();
  for (const file of new Set([...forward.keys(), ...reverse.keys()])) {
    const owner = ownerOf(file);
    if (!owner) continue;
    if (!workspaceFiles.has(owner)) workspaceFiles.set(owner, []);
    workspaceFiles.get(owner).push(file);
  }
  return { forward, reverse, workspaceFiles, fullRoots, globalContextRoots, fallbacks };
}

function reverseConsumers(direct, { reverse, workspaceFiles }, ownerOf) {
  const affected = new Set(direct);
  const pending = new Set([...direct].flatMap((owner) => workspaceFiles.get(owner) ?? []));
  for (const file of pending) {
    for (const consumer of reverse.get(file) ?? []) {
      pending.add(consumer);
      const owner = ownerOf(consumer);
      if (owner && !affected.has(owner)) {
        affected.add(owner);
        for (const ownedFile of workspaceFiles.get(owner) ?? []) pending.add(ownedFile);
      }
    }
  }
  return affected;
}

export function createTypecheckScope({ root = repoRoot } = {}) {
  const workspaces = listWorkspacePackages({ repoRoot: root, assertRootCoverage: false });
  const names = new Set(workspaces.map(({ name }) => name));
  const prefixes = new Map(workspaces.map(({ dir, name }) => [normalizeRelative(dir, root), name]));
  function ownerOf(file) {
    for (let prefix = file; prefix !== "."; prefix = path.posix.dirname(prefix)) {
      const owner = prefixes.get(prefix);
      if (owner !== undefined) return owner;
      if (prefix === "/") break;
    }
    return undefined;
  }

  let fullPrograms;
  let graph;
  function loadGraph() {
    fullPrograms ??= readFullPrograms(root);
    graph ??= readGraph(root, fullPrograms, ownerOf);
    return graph;
  }

  function plan({ changedFiles = [], workspaceNames = [] } = {}) {
    const direct = new Set(workspaceNames);
    const fallbacks = [];
    const changedTypeScript = [];
    for (const name of direct) {
      if (!names.has(name)) {
        throw new TypecheckInputError("TYPECHECK_SCOPE_INVALID_SELECTOR", `unknown workspace: ${name}`);
      }
    }
    for (const file of new Set(changedFiles.map((value) => path.posix.normalize(normalizePath(value))))) {
      const owner = ownerOf(file);
      const [topLevel, workspaceDir, ...rest] = file.split("/");
      let reason;
      if (globalInputPath.test(file)) reason = "global-input";
      else if (declarationPath.test(file)) reason = "declaration-input";
      else if (
        typecheckRoots.has(topLevel) &&
        workspaceDir &&
        rest.length === 1 &&
        rest[0] === "package.json" &&
        !existsSync(path.join(root, file))
      )
        reason = "deleted-workspace";
      else if (owner && workspaceConfigPath.test(path.posix.basename(file))) reason = "workspace-config";
      else if (!owner && typecheckRoots.has(topLevel) && typeScriptPath.test(file)) reason = "unmapped-typescript";
      if (reason) fallbacks.push({ reason, path: file });
      else if (typeScriptPath.test(file)) changedTypeScript.push({ file, owner });
      if (owner) direct.add(owner);
    }
    if (fallbacks.length) return { mode: "full", fallbacks };

    if (changedTypeScript.length) {
      const { fullRoots, globalContextRoots } = loadGraph();
      const readBaseFile = mergeBaseFileReader(root);
      for (const { file, owner } of changedTypeScript) {
        // The current graph cannot see deleted files or removed declarations and references.
        const isCurrentGlobal = globalContextRoots.has(file);
        const baseContent = isCurrentGlobal ? undefined : readBaseFile(file);
        if (isCurrentGlobal || (baseContent !== undefined && hasGlobalContext(file, baseContent))) {
          fallbacks.push({ reason: "global-declaration", path: file });
        } else if (!owner && fullRoots.has(file)) {
          fallbacks.push({ reason: "unmapped-typescript", path: file });
        }
      }
      if (fallbacks.length) return { mode: "full", fallbacks };
    }
    if (!direct.size) return { mode: "none" };

    const currentGraph = loadGraph();
    if (currentGraph.fallbacks.length) return { mode: "full", fallbacks: currentGraph.fallbacks };
    const affected = workspaceNames.length ? direct : reverseConsumers(direct, currentGraph, ownerOf);
    return {
      mode: "scoped",
      workspaces: [...affected].sort(),
      programs: fullPrograms.flatMap(({ name, config, roots }) => {
        if (name === "strict" && !roots.some((file) => affected.has(ownerOf(file)))) return [];
        const selected = roots.filter((file) => {
          const owner = ownerOf(file);
          return (
            !owner || affected.has(owner) || declarationPath.test(file) || currentGraph.globalContextRoots.has(file)
          );
        });
        return selected.length ? [{ name, config, roots: selected }] : [];
      }),
    };
  }

  function summarize(selected) {
    const { forward } = loadGraph();
    function counts(roots) {
      const closure = new Set(roots);
      for (const file of closure) for (const dependency of forward.get(file) ?? []) closure.add(dependency);
      return { roots: roots.length, forwardClosure: closure.size };
    }
    return {
      mode: selected.mode,
      ...(selected.fallbacks && { fallbacks: selected.fallbacks }),
      ...(selected.workspaces && { workspaces: selected.workspaces }),
      closureCounts: "repository files, excluding node_modules and compiler libraries",
      programs: fullPrograms.map(({ name, roots }) => {
        const full = counts(roots);
        const scoped =
          selected.mode === "full"
            ? full
            : counts(selected.programs?.find((program) => program.name === name)?.roots ?? []);
        return { name, scoped, full, wholeGraph: scoped.forwardClosure === full.forwardClosure };
      }),
    };
  }
  return { plan, summarize };
}

export function printFallbacks(fallbacks, write) {
  for (const { reason, path: file } of fallbacks)
    write(`[TYPECHECK_SCOPE_FULL_FALLBACK] reason=${reason} path=${file}`);
}

export async function runScopedPrograms(root, programs, runCompiler) {
  for (const { config, roots } of programs) {
    mkdirSync(path.join(root, ".tmp"), { recursive: true });
    const tempRoot = mkdtempSync(path.join(root, ".tmp", "typecheck-scope-"));
    try {
      const configPath = path.join(tempRoot, "tsconfig.json");
      const extendsPath = normalizeRelative(path.join(root, config), tempRoot);
      writeFileSync(
        configPath,
        `${JSON.stringify({ extends: extendsPath, files: roots.map((file) => path.resolve(root, file)), include: [] }, null, 2)}\n`,
      );
      const status = await runCompiler(configPath);
      if (status) return status;
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [flag, ...args] = process.argv.slice(2);
    if (flag !== "--print-plan") {
      throw new TypecheckInputError(
        "TYPECHECK_SCOPE_USAGE",
        "Usage: node ./scripts/typecheck-scope.mjs --print-plan [workspace selectors]",
      );
    }
    const workspaceNames = parseWorkspaceSelectors(args);
    const scope = createTypecheckScope();
    const plan = scope.plan(workspaceNames.length ? { workspaceNames } : { changedFiles: deriveChangedFiles() });
    if (plan.fallbacks) printFallbacks(plan.fallbacks, console.error);
    console.log(JSON.stringify(scope.summarize(plan), null, 2));
  } catch (error) {
    console.error(`[${error.code ?? "TYPECHECK_SCOPE_FAILED"}] ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}
