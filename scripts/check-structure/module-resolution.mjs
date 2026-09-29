import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const supportedSourceExtensions = [".ts", ".mts"];

function freezeGuardEmission(value) {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) freezeGuardEmission(member);
    Object.freeze(value);
  }
  return value;
}

export const GUARD_IMPORT_EMISSION_TABLE = freezeGuardEmission([
  {
    form: "dot-prefixed-relative",
    rule: "dot-prefixed-relative-target",
    suffixes: ["", ".ts", ".tsx", ".mjs", "/index.ts"],
  },
  {
    form: "scoped-package-subpath",
    rule: "scoped-package-speculative-root",
    roots: ["bounded-contexts", "contracts", "infrastructure", "packages"],
    mappedSubpaths: ["subpath", "support/subpath"],
    suffixes: ["", ".ts", "/index.ts"],
  },
  { form: "no-emission" },
]);

function guardEmissionInventory(member) {
  return Object.freeze([...new Set(GUARD_IMPORT_EMISSION_TABLE.flatMap((branch) => branch[member] ?? []))]);
}

export const GUARD_IMPORT_SPECIFIER_FORMS = Object.freeze(["INDETERMINATE", ...guardEmissionInventory("form")]);
export const GUARD_IMPORT_DERIVATION_RULES = guardEmissionInventory("rule");
export const GUARD_IMPORT_CANDIDATE_SUFFIXES = guardEmissionInventory("suffixes");
export const GUARD_IMPORT_SPECULATIVE_ROOTS = guardEmissionInventory("roots");
export const GUARD_IMPORT_MAPPED_SUBPATH_FORMS = guardEmissionInventory("mappedSubpaths");

function validateGuardEmissionTable(table) {
  if (!Array.isArray(table)) throw new TypeError("Invalid guard import emission table");
  const seen = new Set();
  for (const branch of table) {
    const shipped = GUARD_IMPORT_EMISSION_TABLE.find((entry) => entry.form === branch?.form);
    if (!shipped || seen.has(branch.form)) throw new TypeError("Unknown or repeated guard import form");
    seen.add(branch.form);
    const keys = Reflect.ownKeys(branch);
    if (keys.length !== Object.keys(shipped).length || keys.some((key) => !Object.hasOwn(shipped, key))) {
      throw new TypeError("Invalid guard import branch keys");
    }
    for (const [key, allowed] of Object.entries(shipped)) {
      const value = branch[key];
      if (Array.isArray(allowed)) {
        if (!Array.isArray(value) || !value.length || value.some((member) => !allowed.includes(member))) {
          throw new TypeError(`Unknown guard import ${key}`);
        }
      } else if (value !== allowed) {
        throw new TypeError(`Unknown guard import ${key}`);
      }
    }
  }
}

/** Preserve raw strings and positions; canonical module resolution is a separate channel. */
export function buildGuardImportCandidates({ importerPath, specifierText, emissionTable }) {
  validateGuardEmissionTable(emissionTable);
  let specifierForm = "INDETERMINATE";
  const candidates = [];
  const append = (resolved, branch, speculativeRoot = null, mappedSubpath = null) => {
    for (const suffix of branch.suffixes) {
      const candidate = { path: `${resolved}${suffix}`, rule: branch.rule, suffix, speculativeRoot, mappedSubpath };
      if (
        !GUARD_IMPORT_DERIVATION_RULES.includes(candidate.rule) ||
        !GUARD_IMPORT_CANDIDATE_SUFFIXES.includes(candidate.suffix) ||
        (candidate.speculativeRoot !== null && !GUARD_IMPORT_SPECULATIVE_ROOTS.includes(candidate.speculativeRoot)) ||
        (candidate.mappedSubpath !== null && !GUARD_IMPORT_MAPPED_SUBPATH_FORMS.includes(candidate.mappedSubpath))
      ) {
        throw new TypeError("Unknown guard import candidate value");
      }
      candidates.push(Object.freeze(candidate));
    }
  };
  for (const branch of emissionTable) {
    if (branch.form === "dot-prefixed-relative") {
      if (!specifierText.startsWith(".")) continue;
      specifierForm = branch.form;
      append(path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifierText)), branch);
    } else if (branch.form === "scoped-package-subpath") {
      const match = specifierText.match(/^@chase-sets\/([a-z0-9-]+)\/(.+)$/);
      if (!match) continue;
      specifierForm = branch.form;
      const [, packageName, subpath] = match;
      for (const root of branch.roots) {
        for (const mappedSubpath of branch.mappedSubpaths) {
          const mapped = mappedSubpath === "subpath" ? subpath : `support/${subpath}`;
          append(`${root}/${packageName}/${mapped}`, branch, root, mappedSubpath);
        }
      }
    } else if (branch.form === "no-emission") {
      specifierForm = branch.form;
    }
    break;
  }
  if (!GUARD_IMPORT_SPECIFIER_FORMS.includes(specifierForm)) throw new TypeError("Unknown guard import form");
  return Object.freeze({ specifierForm, candidates: Object.freeze(candidates) });
}

export function enumerateGuardImportCandidates({ importerPath, specifierText }) {
  return buildGuardImportCandidates({ importerPath, specifierText, emissionTable: GUARD_IMPORT_EMISSION_TABLE });
}

function normalizeRepoPath(value) {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function fileCandidates(target) {
  if (supportedSourceExtensions.some((extension) => target.endsWith(extension))) return [target];
  return [`${target}.ts`, `${target}.mts`, `${target}/index.ts`, `${target}/index.mts`];
}

function firstExistingCandidate(target, existingPaths) {
  return fileCandidates(target).find((candidate) => existingPaths.has(candidate));
}

function parseWorkspaceSpecifier(specifierText, workspacePackages) {
  for (const packageName of workspacePackages.keys()) {
    if (specifierText === packageName) return { packageName, subpath: null };
    if (specifierText.startsWith(`${packageName}/`)) {
      return { packageName, subpath: specifierText.slice(packageName.length + 1) };
    }
  }
  return null;
}

function resolveWorkspaceExport(packageRecord, subpath) {
  const exportsMap = packageRecord.exports;
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return null;
  const key = subpath === null ? "." : `./${subpath}`;
  const exactTarget = exportsMap[key];
  if (typeof exactTarget === "string") return exactTarget;
  if (subpath === null) return null;
  const wildcardKeys = Object.keys(exportsMap).filter((candidate) => candidate === "./*");
  if (wildcardKeys.length !== 1 || typeof exportsMap["./*"] !== "string") return null;
  return exportsMap["./*"].replaceAll("*", subpath);
}

/**
 * Resolve a specifier from immutable repository metadata. The function performs
 * no I/O and returns the same result for the same inputs.
 */
export function resolveModule({ importerPath, specifierText, workspacePackages, existingPaths }) {
  const normalizedImporter = normalizeRepoPath(importerPath);
  if (specifierText.startsWith("./") || specifierText.startsWith("../")) {
    const target = normalizeRepoPath(path.posix.join(path.posix.dirname(normalizedImporter), specifierText));
    if (target === ".." || target.startsWith("../")) {
      return { kind: "unresolved", reason: "path-escapes-repository" };
    }
    const candidate = firstExistingCandidate(target, existingPaths);
    return candidate ? { kind: "repo", path: candidate } : { kind: "unresolved", reason: "missing-file" };
  }

  const workspaceSpecifier = parseWorkspaceSpecifier(specifierText, workspacePackages);
  if (workspaceSpecifier) {
    const packageRecord = workspacePackages.get(workspaceSpecifier.packageName);
    const exportedTarget = resolveWorkspaceExport(packageRecord, workspaceSpecifier.subpath);
    if (!exportedTarget) return { kind: "unresolved", reason: "workspace-export-not-found" };
    const target = normalizeRepoPath(path.posix.join(packageRecord.root, exportedTarget));
    if (target === ".." || target.startsWith("../")) {
      return { kind: "unresolved", reason: "path-escapes-repository" };
    }
    const candidate = firstExistingCandidate(target, existingPaths);
    return candidate ? { kind: "repo", path: candidate } : { kind: "unresolved", reason: "missing-file" };
  }

  return { kind: "external" };
}

function workspacePatterns(repoRoot) {
  const workspaceYaml = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  return [...workspaceYaml.matchAll(/^\s*-\s*["']([^"']+)["']\s*$/gm)].map((match) => match[1]);
}

function workspaceDirectories(repoRoot, pattern) {
  const normalizedPattern = normalizeRepoPath(pattern);
  const wildcardIndex = normalizedPattern.indexOf("*");
  if (wildcardIndex < 0) return [normalizedPattern];
  const prefix = normalizedPattern.slice(0, wildcardIndex).replace(/\/$/, "");
  const suffix = normalizedPattern.slice(wildcardIndex + 1).replace(/^\//, "");
  const absolutePrefix = path.join(repoRoot, ...prefix.split("/"));
  if (!existsSync(absolutePrefix)) return [];
  return readdirSync(absolutePrefix, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizeRepoPath(path.posix.join(prefix, entry.name, suffix)));
}

function collectExistingPaths(repoRoot, relativeDirectory = "") {
  const absoluteDirectory = path.join(repoRoot, ...relativeDirectory.split("/").filter(Boolean));
  if (!existsSync(absoluteDirectory)) return [];
  const ignored = new Set([".git", "node_modules", "artifacts", "coverage", "dist", "build"]);
  const paths = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const relativePath = normalizeRepoPath(path.posix.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) paths.push(...collectExistingPaths(repoRoot, relativePath));
    else if (entry.isFile()) paths.push(relativePath);
  }
  return paths;
}

export function loadModuleResolutionContext(repoRoot) {
  const workspacePackages = new Map();
  for (const pattern of workspacePatterns(repoRoot)) {
    for (const root of workspaceDirectories(repoRoot, pattern)) {
      const packageJsonPath = path.join(repoRoot, ...root.split("/"), "package.json");
      if (!existsSync(packageJsonPath)) continue;
      const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (typeof manifest.name !== "string") continue;
      workspacePackages.set(manifest.name, {
        root,
        exports: manifest.exports,
      });
    }
  }
  return {
    workspacePackages,
    existingPaths: new Set(collectExistingPaths(repoRoot)),
  };
}
