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

const canonicalBranches = Object.freeze({
  INDETERMINATE: Object.freeze({ rules: Object.freeze([]) }),
  "relative-inside-repository": Object.freeze({
    rules: Object.freeze(["relative-target"]),
    matches: ({ relative, escaped }) => relative && !escaped,
  }),
  "workspace-export-resolved": Object.freeze({
    rules: Object.freeze(["workspace-export-exact", "workspace-export-wildcard"]),
    matches: ({ relative, exported, escaped }) => !relative && Boolean(exported?.target) && !escaped,
  }),
  "workspace-export-not-found": Object.freeze({
    rules: Object.freeze([]),
    matches: ({ workspaceSpecifier, exported }) => Boolean(workspaceSpecifier) && !exported?.target,
  }),
  "path-escapes-repository": Object.freeze({
    rules: Object.freeze([]),
    matches: ({ escaped }) => escaped,
  }),
  external: Object.freeze({
    rules: Object.freeze([]),
    matches: ({ relative, workspaceSpecifier }) => !relative && !workspaceSpecifier,
  }),
});

export const MODULE_RESOLUTION_CANONICAL_STATES = Object.freeze(Object.keys(canonicalBranches));
export const MODULE_RESOLUTION_DERIVATION_RULES = Object.freeze([
  ...new Set(Object.values(canonicalBranches).flatMap(({ rules }) => rules)),
]);
export const MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY = Object.freeze(
  [
    { targetForm: "supported-explicit-extension", suffix: "", canonicalSelection: true },
    { targetForm: "other", suffix: "", canonicalSelection: false },
    { targetForm: "other", suffix: ".ts", canonicalSelection: true },
    { targetForm: "other", suffix: ".mts", canonicalSelection: true },
    { targetForm: "other", suffix: "/index.ts", canonicalSelection: true },
    { targetForm: "other", suffix: "/index.mts", canonicalSelection: true },
  ].map(Object.freeze),
);
export const MODULE_RESOLUTION_CANDIDATE_SUFFIXES = Object.freeze([
  ...new Set(MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY.map(({ suffix }) => suffix)),
]);

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
  const [exactRule, wildcardRule] = canonicalBranches["workspace-export-resolved"].rules;
  if (typeof exactTarget === "string") return { target: exactTarget, rule: exactRule };
  if (subpath === null) return null;
  const wildcardKeys = Object.keys(exportsMap).filter((candidate) => candidate === "./*");
  if (wildcardKeys.length !== 1 || typeof exportsMap["./*"] !== "string") return null;
  return { target: exportsMap["./*"].replaceAll("*", subpath), rule: wildcardRule };
}

/**
 * Normalize only at the shipped importer/target boundaries. Suffix-expanded
 * paths are exact lookup strings, including root and trailing-slash targets.
 */
export function enumerateCanonicalModuleCandidates({ importerPath, specifierText, workspacePackages }) {
  const normalizedImporter = normalizeRepoPath(importerPath);
  const relative = specifierText.startsWith("./") || specifierText.startsWith("../");
  const workspaceSpecifier = relative ? null : parseWorkspaceSpecifier(specifierText, workspacePackages);
  let exported = null;
  let target = null;
  let rule = null;
  if (relative) {
    target = normalizeRepoPath(path.posix.join(path.posix.dirname(normalizedImporter), specifierText));
    [rule] = canonicalBranches["relative-inside-repository"].rules;
  } else if (workspaceSpecifier) {
    const packageRecord = workspacePackages.get(workspaceSpecifier.packageName);
    exported = resolveWorkspaceExport(packageRecord, workspaceSpecifier.subpath);
    if (exported?.target) {
      target = normalizeRepoPath(path.posix.join(packageRecord.root, exported.target));
      rule = exported.rule;
    }
  }
  const escaped = target === ".." || target?.startsWith("../") === true;
  let canonicalState = "INDETERMINATE";
  let canonicalTarget = null;
  for (const [state, branch] of Object.entries(canonicalBranches)) {
    if (branch.matches?.({ relative, workspaceSpecifier, exported, escaped })) {
      canonicalState = state;
      canonicalTarget = branch.rules.length ? target : null;
      break;
    }
  }
  if (!MODULE_RESOLUTION_CANONICAL_STATES.includes(canonicalState)) throw new TypeError("Unknown canonical state");
  const candidates = [];
  if (canonicalTarget !== null) {
    const targetForm = supportedSourceExtensions.some((extension) => canonicalTarget.endsWith(extension))
      ? "supported-explicit-extension"
      : "other";
    for (const entry of MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY) {
      if (entry.targetForm !== targetForm) continue;
      const candidate = {
        path: canonicalTarget + entry.suffix,
        rule,
        suffix: entry.suffix,
        canonicalSelection: entry.canonicalSelection,
      };
      if (
        !MODULE_RESOLUTION_DERIVATION_RULES.includes(candidate.rule) ||
        !MODULE_RESOLUTION_CANDIDATE_SUFFIXES.includes(candidate.suffix)
      )
        throw new TypeError("Unknown canonical candidate value");
      candidates.push(Object.freeze(candidate));
    }
  }
  Object.freeze(candidates);
  return Object.freeze({ canonicalState, canonicalTarget, candidates });
}

/** Select the first eligible exact-string hit without probing the filesystem. */
export function resolveModule({ importerPath, specifierText, workspacePackages, existingPaths }) {
  const record = enumerateCanonicalModuleCandidates({ importerPath, specifierText, workspacePackages });
  if (record.canonicalTarget !== null) {
    const selected = record.candidates.find(
      (candidate) => candidate.canonicalSelection && existingPaths.has(candidate.path),
    );
    return selected ? { kind: "repo", path: selected.path } : { kind: "unresolved", reason: "missing-file" };
  }
  if (record.canonicalState === "external") return { kind: "external" };
  return { kind: "unresolved", reason: record.canonicalState };
}

export function buildModuleResolutionContextFixture({ files, packages }) {
  return {
    workspacePackages: new Map(
      packages.map(([name, record]) => [
        name,
        Object.freeze({ root: normalizeRepoPath(record.root), exports: record.exports }),
      ]),
    ),
    existingPaths: new Set(files.map(normalizeRepoPath)),
  };
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
