import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { classifyChanges, StaticScopeDerivationError } from "./change-scope.mjs";
import { listWorkspacePackages, repoRoot as defaultRepoRoot } from "./lib/repo.mjs";
import { BRAND_FOIL_PROOF_ENTRY_PATHS, BRAND_FOIL_PROOF_INPUT_PATHS } from "./check-structure/brand-foil-proof.mjs";

function scriptKind(file) {
  if (/\.tsx?$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx?$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function resolveFile(root, candidate) {
  const normalized = candidate.replaceAll("\\", "/");
  const candidates = [
    normalized,
    ...[".mjs", ".js", ".ts", ".tsx", ".jsx", ".json"].map((ext) => `${normalized}${ext}`),
    ...["index.mjs", "index.js", "index.ts", "index.tsx"].map((name) => path.posix.join(normalized, name)),
  ];
  for (const relative of candidates) if (existsSync(path.join(root, relative))) return relative;
  throw new Error(`unresolved static import: ${normalized}`);
}

function staticModuleSpecifiers(sourceFile) {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
      specifiers.push(statement.moduleSpecifier.text);
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier))
      specifiers.push(statement.moduleSpecifier.text);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument))
        throw new Error(`non-literal dynamic import in ${sourceFile.fileName}`);
      specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function resolveSpecifier(root, fromRelative, specifier, packages) {
  if (specifier.startsWith("node:")) return [];
  const relativeSpecifier = specifier.startsWith("./") || specifier.startsWith("../");
  if (!relativeSpecifier && !specifier.startsWith("@chase-sets/")) return [];
  if (relativeSpecifier) {
    const absolute = path.resolve(root, path.dirname(fromRelative), specifier);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (relative.startsWith("../") || path.isAbsolute(relative))
      throw new Error(`static import escapes repository: ${specifier}`);
    return [resolveFile(root, relative)];
  }
  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@") ? `${parts.shift()}/${parts.shift()}` : parts.shift();
  const workspace = packages.get(packageName);
  if (!workspace) throw new Error(`unmapped workspace package import: ${specifier}`);
  const packageJsonRelative = path.relative(root, workspace.packageJsonPath).replaceAll("\\", "/");
  if (parts.length > 0)
    return [
      packageJsonRelative,
      resolveFile(root, path.relative(root, path.join(workspace.dir, parts.join("/"))).replaceAll("\\", "/")),
    ];
  const target =
    workspace.packageJson.exports?.["."]?.default ??
    workspace.packageJson.exports?.["."] ??
    workspace.packageJson.module ??
    workspace.packageJson.main ??
    "index.mjs";
  return [
    packageJsonRelative,
    resolveFile(
      root,
      path
        .relative(root, path.join(workspace.dir, typeof target === "string" ? target : "index.mjs"))
        .replaceAll("\\", "/"),
    ),
  ];
}

function collectBrandFoilProofStaticImportPaths(root = defaultRepoRoot) {
  const packages = new Map(listWorkspacePackages({ repoRoot: root }).map((workspace) => [workspace.name, workspace]));
  const pending = [...BRAND_FOIL_PROOF_ENTRY_PATHS];
  const discovered = new Set();
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (discovered.has(relativePath)) continue;
    discovered.add(relativePath);
    const sourceFile = ts.createSourceFile(
      relativePath,
      readFileSync(path.join(root, relativePath), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(relativePath),
    );
    for (const specifier of staticModuleSpecifiers(sourceFile)) {
      for (const resolved of resolveSpecifier(root, relativePath, specifier, packages))
        if (!discovered.has(resolved)) pending.push(resolved);
    }
  }
  return Object.freeze([...discovered].sort());
}

export const ALWAYS_RUN = "always-run";
export const MAY_NARROW = "may-narrow";

const exact = (...values) => values.map((value) => ({ kind: "exact", value }));
const prefix = (...values) => values.map((value) => ({ kind: "prefix", value }));
const regex = (...values) => values.map((value) => ({ kind: "regex", value }));
const brandFoilProofInputSurface = Object.freeze(
  BRAND_FOIL_PROOF_INPUT_PATHS.map((value) => ({
    kind: "exact",
    value,
  })),
);

const brandFoilProofSurfaceCache = new Map();

export function deriveBrandFoilProofStepSurface(
  root = defaultRepoRoot,
  collect = collectBrandFoilProofStaticImportPaths,
) {
  if (collect === collectBrandFoilProofStaticImportPaths && brandFoilProofSurfaceCache.has(root))
    return brandFoilProofSurfaceCache.get(root);
  const surface = Object.freeze([
    { kind: "prefix", value: "scripts/check-structure" },
    { kind: "exact", value: "pnpm-lock.yaml" },
    ...[...new Set([...BRAND_FOIL_PROOF_INPUT_PATHS, ...collect(root)])].map((value) => ({
      kind: "exact",
      value,
    })),
  ]);
  if (collect === collectBrandFoilProofStaticImportPaths) brandFoilProofSurfaceCache.set(root, surface);
  return surface;
}
const brandFoilProofStepSurface = Object.freeze([
  ...brandFoilProofInputSurface,
  { kind: "prefix", value: "scripts/check-structure" },
  { kind: "exact", value: "pnpm-lock.yaml" },
]);

// The complete scripts battery remains part of the authoritative hosted
// verify:static chain, but it is intentionally outside the focused local
// command plan. Script-tooling authors run the named tests for their change.
export const VERIFY_STATIC_SCOPED_EXCLUSIONS = Object.freeze({
  "test:scripts": "complete scripts battery is a hosted-CI gate; run named focused script tests locally",
});

export function parseVerifyStaticChain(packageJson) {
  const chain = packageJson?.scripts?.["verify:static"];
  if (typeof chain !== "string" || chain.trim() === "") {
    throw new Error("package.json scripts.verify:static must be a non-empty command chain");
  }
  return chain.split(/\s*&&\s*/).map((command) => {
    const match = /^pnpm run ([^\s]+)(?:\s+(.*))?$/.exec(command.trim());
    if (!match) throw new Error(`Unsupported verify:static link: ${command}`);
    const link = { name: match[1], command: command.trim(), forwarded: match[2] ?? "" };
    Object.defineProperty(link, "script", { value: packageJson.scripts[match[1]], enumerable: false });
    return link;
  });
}

export function verifyStaticSurfaceMapCompleteness(chain, surfaces = VERIFY_STATIC_SURFACES) {
  const chainNames = new Set(chain.map((link) => link.name));
  return {
    missing: [...chainNames].filter((name) => !Object.hasOwn(surfaces, name)),
    extra: Object.keys(surfaces).filter((name) => !chainNames.has(name)),
    invalidMayNarrow: [...chainNames].filter((name) => {
      const entry = surfaces[name];
      return entry?.classification === MAY_NARROW && (!Array.isArray(entry.include) || entry.include.length === 0);
    }),
  };
}

export function verifyStaticGuardTestMapCompleteness({
  repoRoot = defaultRepoRoot,
  surfaces = VERIFY_STATIC_GUARD_TEST_SURFACES,
  testFileExists = (file) => existsSync(path.join(repoRoot, file)),
} = {}) {
  const entries = Object.entries(surfaces);
  return {
    missingTestFiles: entries.filter(([file]) => !testFileExists(file)).map(([file]) => file),
    invalidTargets: entries.filter(([file]) => !/^scripts\/.+\.test\.mjs$/.test(file)).map(([file]) => file),
    invalidInclude: entries
      .filter(([, entry]) => !Array.isArray(entry?.include) || entry.include.length === 0)
      .map(([file]) => file),
    invalidEvidence: entries
      .filter(
        ([, entry]) =>
          typeof entry?.rule !== "string" ||
          entry.rule.trim() === "" ||
          !Array.isArray(entry.evidence) ||
          entry.evidence.length === 0 ||
          entry.evidence.some((citation) => !/^[^:]+:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(citation)),
      )
      .map(([file]) => file),
  };
}

export function selectVerifyStaticGuardTests({
  changedFiles,
  repoRoot = defaultRepoRoot,
  surfaces = VERIFY_STATIC_GUARD_TEST_SURFACES,
  forceFull = false,
  testFileExists = (file) => existsSync(path.join(repoRoot, file)),
} = {}) {
  const completeness = verifyStaticGuardTestMapCompleteness({ repoRoot, surfaces, testFileExists });
  if (completeness.missingTestFiles.length > 0 || completeness.invalidTargets.length > 0) {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_GUARD_TEST_MAP_INVALID",
      `invalid or missing configured guard test: ${[...completeness.missingTestFiles, ...completeness.invalidTargets].join(", ")}`,
    );
  }
  const selectAll = forceFull || completeness.invalidInclude.length > 0 || completeness.invalidEvidence.length > 0;
  const selected = new Set();
  for (const [file, entry] of Object.entries(surfaces)) {
    if (selectAll || linkSurfaceMatches(entry, changedFiles)) selected.add(file);
  }
  for (const changedFile of changedFiles) {
    const file = changedFile.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!file.startsWith("scripts/") || !file.endsWith(".mjs")) continue;
    const testFile = file.endsWith(".test.mjs") ? file : file.replace(/\.mjs$/, ".test.mjs");
    if (testFileExists(testFile)) selected.add(testFile);
  }
  return [...selected].sort();
}

function allWorkspacesAffected(changedFiles, repoRoot, dependencies) {
  const workspaces = dependencies.listWorkspacePackages({ repoRoot });
  if (workspaces.length === 0) return false;
  const scope = dependencies.classifyChanges({ changedFiles, workspaces, baseDir: repoRoot });
  return scope.affectedWorkspaces.length === workspaces.length;
}

function validateScopedStepMap(chain, surfaces) {
  for (const link of chain) {
    const scopedSteps = surfaces[link.name]?.scopedSteps;
    if (scopedSteps === undefined) continue;
    if (link.name !== "check:structure" || !Array.isArray(scopedSteps) || scopedSteps.length === 0) {
      throw new StaticScopeDerivationError(
        "STATIC_SCOPE_STEPS_MAP_INVALID",
        `scopedSteps is only supported as a non-empty array on check:structure: ${link.name}`,
      );
    }
    for (const step of scopedSteps) {
      if (
        typeof step?.name !== "string" ||
        typeof step.command !== "string" ||
        ![ALWAYS_RUN, MAY_NARROW].includes(step.classification) ||
        (step.classification === MAY_NARROW &&
          (!Array.isArray(step.include) || step.include.length === 0 || typeof step.rule !== "string"))
      ) {
        throw new StaticScopeDerivationError("STATIC_SCOPE_STEPS_MAP_INVALID", `invalid scoped step in ${link.name}`);
      }
    }
  }
}

function withScopedDetails(link, details) {
  const enriched = { ...link };
  for (const [key, value] of Object.entries(details))
    Object.defineProperty(enriched, key, { value, enumerable: false, configurable: true });
  return enriched;
}

function selectScopedSteps(link, entry, changedFiles) {
  const expectedCommand = entry.scopedSteps.map((step) => step.command).join(" && ");
  if (expectedCommand !== (link.script ?? link.command))
    return { link: withScopedDetails(link, { scopedStepsStale: true }), skippedSteps: [] };
  const selectedSteps = [];
  const skippedSteps = [];
  for (const step of entry.scopedSteps) {
    if (step.classification === ALWAYS_RUN || linkSurfaceMatches(step, changedFiles)) selectedSteps.push(step);
    else skippedSteps.push(step);
  }
  return { link: withScopedDetails(link, { selectedSteps, skippedSteps }), skippedSteps };
}

export function selectVerifyStaticLinks({
  chain,
  changedFiles,
  repoRoot = defaultRepoRoot,
  surfaces = VERIFY_STATIC_SURFACES,
  scopedExclusions = VERIFY_STATIC_SCOPED_EXCLUSIONS,
  guardSurfaces = VERIFY_STATIC_GUARD_TEST_SURFACES,
  testFileExists,
  forceFull = false,
  dependencies = { classifyChanges, listWorkspacePackages },
} = {}) {
  validateScopedStepMap(chain, surfaces);
  const guardTests = selectVerifyStaticGuardTests({
    changedFiles,
    repoRoot,
    surfaces: guardSurfaces,
    forceFull,
    testFileExists,
  });
  const excluded = chain
    .filter((link) => Object.hasOwn(scopedExclusions, link.name))
    .map((link) => ({ link, rule: scopedExclusions[link.name] }));
  const scopedChain = chain.filter((link) => !Object.hasOwn(scopedExclusions, link.name));
  if (changedFiles.length === 0 && !forceFull)
    return {
      selected: [],
      skipped: scopedChain.map((link) => ({ link, rule: "empty derived diff" })),
      excluded,
      fullReason: null,
      guardTests,
      stepSkips: [],
    };
  const scriptsChanged = changedFiles.some((filePath) =>
    linkSurfaceMatches({ include: [{ kind: "prefix", value: "scripts" }] }, [filePath]),
  );
  const fullReason = forceFull
    ? "changed-file derivation failed closed"
    : scriptsChanged
      ? "scripts/** changed (guard and tooling changes require the full static chain)"
      : allWorkspacesAffected(changedFiles, repoRoot, dependencies)
        ? "classifyChanges affected every workspace (derived root-runtime fanout)"
        : null;
  let planningSurfaces = surfaces;
  if (!forceFull && scopedChain.some((link) => Array.isArray(surfaces[link.name]?.scopedSteps))) {
    try {
      const collect = dependencies.collectBrandFoilProofStaticImportPaths;
      const derivedSteps = deriveBrandFoilProofStepSurface(repoRoot, collect);
      planningSurfaces = {
        ...surfaces,
        "check:structure": {
          ...surfaces["check:structure"],
          scopedSteps: surfaces["check:structure"]?.scopedSteps?.map((step) =>
            step.name === "brand-foil-proof" ? { ...step, include: derivedSteps } : step,
          ),
        },
      };
    } catch (error) {
      if (error instanceof StaticScopeDerivationError) throw error;
      throw new StaticScopeDerivationError(
        "STATIC_SCOPE_BRAND_FOIL_DERIVATION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (fullReason) {
    const selected = scopedChain.map((link) => {
      const entry = planningSurfaces[link.name];
      if (forceFull || !Array.isArray(entry?.scopedSteps)) return link;
      return selectScopedSteps(link, entry, changedFiles).link;
    });
    const fullStepSkips = selected.flatMap((link) =>
      Array.isArray(link.skippedSteps) ? link.skippedSteps.map((step) => ({ link, step, rule: step.rule })) : [],
    );
    return { selected, skipped: [], excluded, fullReason, guardTests, stepSkips: fullStepSkips };
  }
  const selected = [];
  const skipped = [];
  const stepSkips = [];
  for (const link of scopedChain) {
    const entry = planningSurfaces[link.name];
    if (!entry) {
      selected.push(link);
      continue;
    }
    if (Array.isArray(entry.scopedSteps)) {
      const scoped = selectScopedSteps(link, entry, changedFiles);
      selected.push(scoped.link);
      for (const step of scoped.skippedSteps) stepSkips.push({ link, step, rule: step.rule });
      continue;
    }
    if (
      entry.classification === ALWAYS_RUN ||
      entry.classification !== MAY_NARROW ||
      !Array.isArray(entry.include) ||
      entry.include.length === 0 ||
      linkSurfaceMatches(entry, changedFiles)
    )
      selected.push(link);
    else skipped.push({ link, rule: entry.rule });
  }
  return { selected, skipped, excluded, fullReason: null, guardTests, stepSkips };
}

// Repository-wide reads cannot be narrowed to the paths in historical failures.
// These rules describe scan inputs, not the tests' static import graphs.
export const VERIFY_STATIC_GUARD_TEST_SURFACES = {
  "scripts/check-structure/lost-update-write-guard.test.mjs": {
    rule: "owner-local lost-update metadata and every source admitted by the unchanged guard discovery predicate",
    evidence: ["scripts/check-structure/lost-update-write-guard.mjs:1-40"],
    include: [
      ...exact(
        "scripts/check-structure/lost-update-write-guard.mjs",
        "scripts/check-structure/lost-update-write-guard.test.mjs",
        "scripts/verify-static-surfaces.mjs",
        "pnpm-lock.yaml",
      ),
      ...prefix("packages/typescript-compiler-api"),
      ...regex(
        "^bounded-contexts/.+\\.lost-update-exceptions\\.json$",
        "^bounded-contexts/.+/read-model/.+\\.(?:ts|tsx|js|jsx|mjs|cjs)$",
        "^bounded-contexts/.+(?:projection|queue)\\.(?:ts|tsx|js|jsx|mjs|cjs)$",
      ),
      ...exact("bounded-contexts/channels/features/credentials/api/runtime.ts"),
    ],
  },
  "scripts/check-structure/tcgplayer-host-credential-guard.test.mjs": {
    rule: "tracked platform source inventory for TCGplayer hosts and custody tokens",
    evidence: ["scripts/check-structure/tcgplayer-host-credential-guard.mjs:1-114"],
    include: [{ kind: "any" }],
  },
  "scripts/check-structure/sql-execution-surface.test.mjs": {
    rule: "repository-wide tracked TypeScript inventory and module-resolution file inventory",
    evidence: [
      "scripts/check-structure/sql-execution-surface.test.mjs:967-985,1038-1045",
      "scripts/check-structure/module-resolution.mjs:264-315",
    ],
    include: [{ kind: "any" }],
  },
  "scripts/check-structure/brand-mark-representations.test.mjs": {
    rule: "repository-wide tracked callers, including documentation, plus raster outputs and lockfile",
    evidence: ["scripts/check-structure/brand-mark-representations.test.mjs:236-265,277-300,560-574,695-733"],
    include: [{ kind: "any" }],
  },
  "scripts/check-structure/deployed-browser-e2e-profile.test.mjs": {
    rule: "deployed browser config, three web E2E roots, and the guard source",
    evidence: ["scripts/check-structure/deployed-browser-e2e-profile.test.mjs:1-9,64-73"],
    include: [
      ...exact("playwright.config.ts", "pnpm-lock.yaml"),
      ...prefix(
        "deployables/marketplace/e2e",
        "deployables/admin-web/e2e",
        "deployables/public-web/e2e",
        "scripts",
        "packages/typescript-compiler-api",
      ),
    ],
  },
  "scripts/ci-gate-plan.test.mjs": {
    rule: "repository-wide tracked path existence, workspace discovery, workflow and scripts selection contracts",
    evidence: ["scripts/ci-gate-plan.test.mjs:9-38,83-87,296-372"],
    include: [{ kind: "any" }],
  },
  "scripts/check-structure/consent-authorization-sites.test.mjs": {
    rule: "repository-wide tracked authorization evidence inventory, product corpus, and fixture evidence",
    evidence: ["scripts/check-structure/consent-authorization-sites.test.mjs:152-186,1238-1260,3266-3276"],
    include: [{ kind: "any" }],
  },
  "scripts/check-structure/json-import-attributes.test.mjs": {
    rule: "repository-wide tracked JSON-import census (tracked TypeScript inventory, git grep, workspace vite/vitest partition), script analyzers and registry-builder helpers, plus the live Channels context-root contract",
    evidence: [
      "scripts/check-structure/json-import-attributes.test.mjs:1-15,139-140,489-497,700-760,880-906,1020-1027",
      "scripts/check-structure/json-import-attributes.mjs:44-82,584-645",
    ],
    include: [{ kind: "any" }],
  },
  "scripts/check-structure/regenerate-lockfile-bound-artifacts.test.mjs": {
    rule: "root command and lockfile, compiler wrapper, and script-owned artifact provenance chain",
    evidence: [
      "scripts/check-structure/regenerate-lockfile-bound-artifacts.test.mjs:6-18,92-119,170-177",
      "scripts/check-structure/typescript-owner-context-derivation.mjs:155-177",
    ],
    include: [...exact("package.json", "pnpm-lock.yaml"), ...prefix("scripts", "packages/typescript-compiler-api")],
  },
  "scripts/check-structure/typescript-owner-context-derivation.test.mjs": {
    rule: "compiler wrapper and lockfile, script-owned artifact/schema/partition/fixtures and scripts config",
    evidence: [
      "scripts/check-structure/typescript-owner-context-derivation.test.mjs:20-31,600-614,700-706",
      "scripts/check-structure/typescript-owner-context-derivation.mjs:155-177",
    ],
    include: [
      ...exact("pnpm-lock.yaml", "vitest.scripts.config.mjs"),
      ...prefix("scripts", "packages/typescript-compiler-api"),
    ],
  },
  "scripts/check-structure/issue-reference-comments.test.mjs": {
    rule: "code comments under four source roots and the script-owned scanner/allowlist",
    evidence: [
      "scripts/check-structure/issue-reference-comments.mjs:1-6,26-38",
      "scripts/check-structure/issue-reference-comments.test.mjs:220-225",
    ],
    include: [
      ...exact("pnpm-lock.yaml"),
      ...prefix("bounded-contexts", "infrastructure", "deployables", "scripts", "packages/typescript-compiler-api"),
    ],
  },
};

// This is the auditable link -> input-surface contract for verify:static.
// ALWAYS_RUN links deliberately have no include rules: their input is not
// bounded by changed repository paths. MAY_NARROW rules are conservative
// supersets of the scan boundaries cited in evidence.
export const VERIFY_STATIC_SURFACES = {
  "format:check": {
    classification: MAY_NARROW,
    rule: "any changed path; format:check performs its own supported-file filtering",
    evidence: ["scripts/format-check.mjs:121-138,219-257"],
    include: [{ kind: "any" }],
  },
  "check:kb-reference-ratchet": {
    classification: ALWAYS_RUN,
    rule: "PR/issue body input can change with no repository path change",
    evidence: ["scripts/check-structure/kb-reference-ratchet.mjs:45-51"],
  },
  "check:postage-adapters": {
    classification: MAY_NARROW,
    rule: "bounded-contexts/fulfillment/**",
    evidence: ["scripts/check-postage-adapter-boundaries.mjs:8-15,86-91"],
    include: prefix("bounded-contexts/fulfillment"),
  },
  "check:github-actions-runtime": {
    classification: MAY_NARROW,
    rule: ".github/**",
    evidence: ["scripts/check-github-actions-runtime.mjs:6-7,24-36,406-413"],
    include: prefix(".github"),
  },
  "check:identity-creation-positions": {
    classification: ALWAYS_RUN,
    rule: "scans every git-tracked file for each command byte sequence derived from the Identity domain anchors",
    evidence: ["scripts/identity-creation-position-guard.mjs:79-120,301-363"],
  },
  "check:managed-postgres-authority": {
    classification: ALWAYS_RUN,
    rule: "workflow steps transitively resolve arbitrary executables and package scripts",
    evidence: ["scripts/managed-postgres-authority-guard.mjs:429-508"],
  },
  "check:managed-registry-authority": {
    classification: ALWAYS_RUN,
    rule: "fail-closed: link postdates the ratified 8/21 classification and has not been approved for narrowing",
    evidence: ["scripts/managed-registry-authority-guard.mjs:11-12,24-35,50-153"],
  },
  "check:environment-topology": {
    classification: ALWAYS_RUN,
    rule: "scans every git-tracked file for retired host tokens",
    evidence: ["scripts/environment-topology-guard.mjs:556-580,583-635"],
  },
  "check:workflow-canonical-artifacts": {
    classification: MAY_NARROW,
    rule: ".github/workflows/**, .github/actions/**, or the workflow artifact baseline",
    evidence: ["scripts/workflow-canonical-artifacts.mjs:10,205-206,258-307"],
    include: [
      ...prefix(".github/workflows", ".github/actions"),
      ...exact("scripts/workflow-canonical-artifacts-baseline.json"),
    ],
  },
  "check:no-legacy-forms": {
    classification: MAY_NARROW,
    rule: "bounded-contexts/**, deployables/**, or packages/**",
    evidence: ["scripts/check-no-legacy-forms.mjs:8-12,30-34,203-211"],
    include: prefix("bounded-contexts", "deployables", "packages"),
  },
  "check:design-system-hoc-budget": {
    classification: MAY_NARROW,
    rule: "design-system components/primitives or the HOC budget ledger",
    evidence: ["scripts/design-system-hoc-budget.mjs:31-42,77-90,185-225"],
    include: [
      ...prefix("packages/design-system/src/components", "packages/design-system/src/primitives"),
      ...exact("packages/design-system/DESIGN_SYSTEM_HOC_BUDGET.json"),
    ],
  },
  "check:responsive-safety": {
    classification: MAY_NARROW,
    rule: "production TSX under its three roots or the responsive-safety ledger",
    evidence: ["scripts/check-responsive-safety.mjs:19-24,55-84,279-282,359-390"],
    include: [
      ...regex("^bounded-contexts/.+\\.tsx$", "^deployables/.+\\.tsx$", "^packages/design-system/src/.+\\.tsx$"),
      ...exact("packages/design-system/RESPONSIVE_SAFETY.json"),
    ],
  },
  "check:design-system-raw-ui-budget": {
    classification: MAY_NARROW,
    rule: "bounded-contexts/**, deployables/**, or the raw-UI budget ledger",
    evidence: ["scripts/design-system-raw-ui-budget.mjs:28-35,128-145,265-323"],
    include: [
      ...prefix("bounded-contexts", "deployables"),
      ...exact("packages/design-system/DESIGN_SYSTEM_RAW_UI_BUDGET.json"),
    ],
  },
  "check:design-system-color-utilities": {
    classification: MAY_NARROW,
    rule: "packages/design-system/src/**",
    evidence: ["scripts/check-design-system-color-utilities.mjs:157-192"],
    include: prefix("packages/design-system/src"),
  },
  "check:readme-manifest-sections": {
    classification: MAY_NARROW,
    rule: "root README, context manifests/READMEs, or deployable package manifests",
    evidence: ["scripts/generate-readme-manifest-sections.mjs:7-10,80-113,188-218"],
    include: [
      ...exact("README.md"),
      ...regex("^bounded-contexts/[^/]+/(?:context\\.json|README\\.md)$", "^deployables/[^/]+/package\\.json$"),
    ],
  },
  "check:agent-connector-packaging": {
    classification: ALWAYS_RUN,
    rule: "runtime value-import graph reaches contracts and infrastructure beyond a finite declared surface",
    evidence: [
      "scripts/generate-agent-connector-packaging.mjs:34-38",
      "infrastructure/platform-runtime/agent-connector-packaging.ts:1-10",
      "infrastructure/platform-runtime/mcp.ts:24-50",
      "infrastructure/platform-runtime/agent-guardrails.ts:1",
    ],
  },
  "check:public-policies": {
    classification: ALWAYS_RUN,
    rule: "policy evidence citations resolve arbitrary repository paths and exact line ranges",
    evidence: ["bounded-contexts/public-presence/features/policies/domain/canonical-claim-guard.ts:79-90"],
  },
  "check:developer-articles": {
    classification: ALWAYS_RUN,
    rule: "compiler follows help, platform-runtime, and auth-context value-import graphs",
    evidence: [
      "bounded-contexts/public-presence/features/developer-portal/integrations/compile-developer-articles.mjs:5-7,16-30",
    ],
  },
  "check:docs-index": {
    classification: ALWAYS_RUN,
    rule: "any repository file can be the final basename mention keeping a context document indexed",
    evidence: ["scripts/check-docs-index.mjs:145-161"],
  },
  "check:docs-path-claims": {
    classification: ALWAYS_RUN,
    rule: "deleting or renaming any path can invalidate an unchanged Markdown path claim",
    evidence: ["scripts/check-docs-path-claims.mjs:20-38,227-238"],
  },
  "check:design-system-component-index": {
    classification: MAY_NARROW,
    rule: "design-system sources/index, TypeScript compiler API, or production consumers",
    evidence: [
      "scripts/generate-design-system-component-index.mjs:8,42-48,66-73",
      "scripts/check-design-system-dead-exports.mjs:5",
      "scripts/check-design-system-dead-exports.mjs:188-223",
    ],
    include: prefix("packages/design-system", "packages/typescript-compiler-api", "bounded-contexts", "deployables"),
  },
  "check:design-system-export-coverage": {
    classification: MAY_NARROW,
    rule: "design-system runtime graph, including contracts/primitives, or the export-coverage guard itself",
    evidence: [
      "scripts/check-design-system-export-coverage.mjs:423-448",
      "packages/design-system/src/components/forms/number-field.tsx:5-9",
    ],
    include: [
      ...prefix("packages/design-system", "contracts/primitives"),
      ...exact("scripts/check-design-system-export-coverage.mjs"),
    ],
  },
  "check:package-export-targets": {
    classification: MAY_NARROW,
    rule: "any of the five workspace roots",
    evidence: ["scripts/check-package-export-targets.mjs:51-89,99-113", "scripts/lib/repo.mjs:7"],
    include: prefix("bounded-contexts", "contracts", "infrastructure", "packages", "deployables"),
  },
  "check:env-examples": {
    classification: MAY_NARROW,
    rule: "the five enumerated config/example inputs",
    evidence: ["scripts/check-env-examples.mjs:50-70,128-145"],
    include: exact(
      "deployables/platform-api/src/config.ts",
      "infrastructure/platform-runtime/http.ts",
      "deployables/platform-api/.env.example",
      "deployables/platform-worker/src/config.ts",
      "deployables/platform-worker/.env.example",
    ),
  },
  "check:node-types-runtime": {
    classification: MAY_NARROW,
    rule: "any package.json the workspace definition can discover, or the guard itself; root workspace files fan out",
    evidence: ["scripts/check-node-types-runtime.mjs:24-102"],
    include: [...exact("scripts/check-node-types-runtime.mjs"), ...regex("(?:^|/)package\\.json$")],
  },
  "check:structure": {
    classification: ALWAYS_RUN,
    rule: "repo-wide structure scan plus diff-consuming SQL and boot-schema guards",
    evidence: ["scripts/check-structure/run.mjs:40-55,1261-1270,3238-3246"],
    scopedSteps: [
      {
        name: "aggregate",
        command: "node ./scripts/check-structure.mjs",
        classification: ALWAYS_RUN,
        rule: "aggregate structure scan always runs before the causal proof",
      },
      {
        name: "brand-foil-proof",
        command: "node ./scripts/check-structure/brand-foil-proof.mjs",
        classification: MAY_NARROW,
        rule: "brand-foil proof inputs, static import closure, check-structure modules, or pnpm-lock.yaml",
        include: brandFoilProofStepSurface,
      },
    ],
  },
  "check:localization": {
    classification: MAY_NARROW,
    rule: "English locale sources or any path admitted by the localization source predicate",
    evidence: ["scripts/check-localization.mjs:5-16,117-139"],
    include: [
      ...regex(
        "^contracts/localization/locales/en(?:\\.ts|/)",
        "/features/",
        "/routes/",
        "/support/(?:api-support|request-support|shell-support)/",
      ),
      ...prefix("deployables/marketplace/app", "deployables/admin-web/app"),
    ],
  },
  "check:buyer-seller-jargon": {
    classification: MAY_NARROW,
    rule: "English locales, bounded contexts, or marketplace app sources",
    evidence: ["scripts/check-buyer-seller-jargon.mjs:6-11,81-101"],
    include: [
      ...exact("contracts/localization/locales/en.ts"),
      ...prefix("contracts/localization/locales/en", "bounded-contexts", "deployables/marketplace/app"),
    ],
  },
  "check:operator-surface-pm": {
    classification: MAY_NARROW,
    rule: "bounded-context UI or catalog locale sources",
    evidence: ["scripts/check-operator-surface-pm-content.mjs:20-32,236-248"],
    include: [
      ...regex(
        "^bounded-contexts/[^/]+/(?:.+/)?ui/",
        "^contracts/localization/locales/.+/catalog/.*\\.ts$",
        "^contracts/localization/locales/.+/catalog\\.ts$",
      ),
    ],
  },
  "lint:async": {
    classification: ALWAYS_RUN,
    rule: "type-aware promise rules resolve types through imported files outside the changed set",
    evidence: ["package.json:69", ".oxlintrc.json:13-20"],
  },
  "test:scripts": {
    classification: ALWAYS_RUN,
    rule: "script tests read repository inputs dynamically outside their static import graph",
    evidence: [
      "vitest.scripts.config.mjs:3-10",
      "scripts/digitalocean-platform-config.test.mjs:8-18",
      "scripts/check-structure/skill-mirror.test.mjs:15-16",
    ],
  },
};

function normalizedPath(filePath) {
  return String(filePath).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function surfaceRuleMatches(filePath, surfaceRule) {
  const normalized = normalizedPath(filePath);
  if (surfaceRule.kind === "any") return normalized.length > 0;
  if (surfaceRule.kind === "exact") return normalized === surfaceRule.value;
  if (surfaceRule.kind === "prefix") {
    return normalized === surfaceRule.value || normalized.startsWith(`${surfaceRule.value}/`);
  }
  if (surfaceRule.kind === "regex") return new RegExp(surfaceRule.value).test(normalized);
  throw new Error(`Unknown verify:static surface-rule kind: ${surfaceRule.kind}`);
}

export function linkSurfaceMatches(entry, changedFiles) {
  return (entry.include ?? []).some((surfaceRule) =>
    changedFiles.some((filePath) => surfaceRuleMatches(filePath, surfaceRule)),
  );
}
