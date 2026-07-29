#!/usr/bin/env node
// release-qualification-scope/v1 — fail-closed release qualification lane classifier.
//
// Classifies the complete production-marker-to-candidate diff into exactly one
// of three environment lanes:
//
//   - not_applicable      the diff has no deployable/runtime/infrastructure/
//                         provider consequence (docs, tests, repo tooling).
//   - isolated            application/image changes provable with disposable
//                         in-cluster Postgres and test-mode external providers.
//   - persistent_required migration/schema, seed/bootstrap/import/
//                         reconciliation, Terraform, Helm/DOKS/ingress/DNS/
//                         Spaces, deployment/release workflows, live-provider
//                         contracts, money-movement contracts, destructive
//                         data, or anything unknown/ambiguous.
//
// Classification is driven by code/dependency semantics and the registries
// below — never by path-name vocabulary alone. Registered surfaces catch the
// historical paths; content-semantic detectors catch renamed copies; a
// path-name lookalike with no registered surface and no semantic content never
// forces a class by its name.
//
// Fail-closed polarity: missing base, unreadable metadata, unreadable file
// content, unknown categories, unknown registrations, classifier errors, and
// future policy versions all classify persistent_required. This is the
// deliberate opposite framing of scripts/release-deployment-scope.mjs, which
// treats a missing base as deploy-required (fail-open-to-deploy): both fail
// toward the safer action for their consumer, and production reconciliation
// must preserve both behaviors.
//
// This module is advisory-only today: it renders a merge-group summary and
// changes no required checks. Cost wager: repository-local compute only — it
// may not provision provider resources, and it records Actions minutes per
// classified candidate in its own output.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyChanges } from "./change-scope.mjs";
import { isCommitSha, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { listWorkspacePackages, normalizePath, repoRoot } from "./lib/repo.mjs";

export const RELEASE_QUALIFICATION_SCOPE_SCHEMA_VERSION = "release-qualification-scope/v1";
export const RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION = "release-qualification-scope/v1";
export const RELEASE_QUALIFICATION_SCOPE_CLASSES = Object.freeze(["not_applicable", "isolated", "persistent_required"]);

const CLASS_RANK = { not_applicable: 0, isolated: 1, persistent_required: 2 };

// ---------------------------------------------------------------------------
// Registry — the semantic owners the classifier consults. The registration
// contract lives in docs/runbooks/release-qualification-evidence.md: every new
// deployable, migration mechanism, provider, and workflow must register here,
// and anything unregistered fails closed to persistent_required.
// ---------------------------------------------------------------------------

export const DEPLOYABLE_ROLES = Object.freeze(["runtime", "seed-machinery"]);
export const INFRASTRUCTURE_RULINGS = Object.freeze([
  "terraform",
  "helm",
  "live-provider",
  "test-mode-provider",
  "event-store-persistence",
  "runtime-library",
  "repo-tooling",
]);
export const WORKFLOW_CATEGORIES = Object.freeze(["release", "ci"]);
export const CONTRACT_RULINGS = Object.freeze([
  "money-movement-contract",
  "live-provider",
  "event-store-persistence",
  "seed-machinery",
  "runtime-library",
]);

export const releaseQualificationScopeRegistry = Object.freeze({
  policyVersion: RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION,

  // Deployables by directory name under deployables/. A directory that is not
  // registered here (for example a renamed deployable) fails closed.
  deployables: Object.freeze({
    "admin-web": "runtime",
    marketplace: "runtime",
    "marketplace-seed-testing": "seed-machinery",
    "platform-api": "runtime",
    "platform-worker": "runtime",
    "public-web": "runtime",
  }),

  // Infrastructure workspaces/roots by directory name under infrastructure/.
  // An unregistered infrastructure directory fails closed.
  infrastructure: Object.freeze({
    "bounded-context-runtime": "runtime-library",
    digitalocean: "terraform",
    "easypost-postage": "live-provider",
    "event-core-postgres": "event-store-persistence",
    helm: "helm",
    "local-email-capture": "test-mode-provider",
    "notification-outbox": "live-provider",
    "object-storage": "live-provider",
    observability: "runtime-library",
    "platform-policy": "runtime-library",
    "platform-runtime": "runtime-library",
    "playwright-evidence": "repo-tooling",
    "provider-webhook-inbox": "live-provider",
    "remote-dev": "repo-tooling",
    "ses-email": "live-provider",
    "stripe-config": "live-provider",
    "stripe-connect": "live-provider",
    "stripe-payments": "live-provider",
    "twilio-messaging": "live-provider",
    "web-notifications": "runtime-library",
  }),

  // Money-movement contexts: domain/api/integrations surfaces and runtime
  // barrels in these bounded contexts carry money-movement contracts.
  moneyMovementContexts: Object.freeze(["checkout", "ordering", "payments", "settlement"]),

  // Shared contract workspaces by directory name under contracts/. Money and
  // provider contracts are categorically persistent (ratified decisions);
  // event-core carries stored-event compatibility semantics. An unregistered
  // contracts directory fails closed.
  contracts: Object.freeze({
    "auth-context": "runtime-library",
    "bounded-context-module": "runtime-library",
    "catalog-seed": "seed-machinery",
    "checkout-order-source": "money-movement-contract",
    "event-core": "event-store-persistence",
    http: "runtime-library",
    localization: "runtime-library",
    "market-estimate-display": "runtime-library",
    "money-movement": "money-movement-contract",
    "outbound-messaging": "live-provider",
    "payment-processing": "live-provider",
    "postage-labels": "live-provider",
    primitives: "runtime-library",
    "product-measures": "runtime-library",
    "product-selection": "runtime-library",
    "public-docs": "runtime-library",
    realtime: "runtime-library",
    "review-eligibility": "runtime-library",
    "seller-attention-queue": "runtime-library",
    "seller-desk": "runtime-library",
  }),

  // Migration mechanisms (historical paths). Renamed copies are caught by the
  // SQL-DDL and BcSchemaMigration content detectors; DDL outside a registered
  // mechanism classifies as an unrecognized migration mechanism (fail closed).
  migrationSurfacePatterns: Object.freeze([
    /^bounded-contexts\/[^/]+\/support\/runtime-support\/schema\.ts$/,
    /^bounded-contexts\/[^/]+\/support\/runtime-support\/unlogged-projection-migrations\.ts$/,
    /^infrastructure\/bounded-context-runtime\/schema\.ts$/,
    /^infrastructure\/platform-runtime\/projection-push-migration\.ts$/,
  ]),

  // Homes of the registered boot-schema DDL mechanism: DDL content inside
  // these roots belongs to the known bounded-context boot/replay mechanism
  // (still persistent_required as migration_schema); DDL anywhere else is an
  // unrecognized migration mechanism and fails closed with its own code.
  migrationMechanismRootPatterns: Object.freeze([
    /^bounded-contexts\//,
    /^infrastructure\/(?:event-core-postgres|bounded-context-runtime|platform-runtime)\//,
  ]),

  // Seed/bootstrap/import/reconciliation entry points — the caller inventory.
  // Every entry point discovered by the repository sweep in
  // release-qualification-scope.test.mjs must be covered here or by a
  // reviewedNonPersistentSurfaces ruling.
  seedBootstrapImportReconciliationPatterns: Object.freeze([
    // Per-context seed modules and deterministic seed identifier registries.
    /^bounded-contexts\/[^/]+\/support\/runtime-support\/seed\.ts$/,
    /^bounded-contexts\/[^/]+\/support\/runtime-support\/(?:production-bootstrap|bootstrap-context)\.ts$/,
    /^bounded-contexts\/[^/]+\/support\/seed-support\//,
    /^bounded-contexts\/catalog\/support\/authoring-support\/seed\.ts$/,
    /^bounded-contexts\/[^/]+\/features\/[^/]+\/api\/seed\.ts$/,
    /^contracts\/catalog-seed\//,
    // Seed runner and boot entry points.
    /^infrastructure\/bounded-context-runtime\/seeding\.ts$/,
    /^infrastructure\/bounded-context-runtime\/seed-aggregate-state\.ts$/,
    /^deployables\/(?:platform-api|platform-worker)\/src\/(?:bootstrap(?:-storage)?|main)\.ts$/,
    /^deployables\/platform-api\/src\/(?:representative-commerce-state|admin-qa-actor-fixtures|preview-postgres)\.ts$/,
    /^deployables\/platform-api\/scripts\/check-bootstrap-db-enrollment\.(?:mjs|d\.mts)$/,
    /^deployables\/marketplace-seed-testing\//,
    // Catalog import/promotion machinery.
    /^bounded-contexts\/catalog\/features\/source-observations\/api\//,
    /^bounded-contexts\/catalog\/features\/scope-sync-batches\//,
    /^bounded-contexts\/catalog\/features\/provider-scope-discovery\//,
    /^bounded-contexts\/catalog\/features\/completion-report\//,
    /^bounded-contexts\/catalog\/features\/catalog-items\/read-model\/display-identity-recompute\.ts$/,
    // Reconciliation processes over long-lived money and operations state.
    /^bounded-contexts\/settlement\/features\/liability-reconciliation\//,
    /^bounded-contexts\/settlement\/features\/wallets\/read-model\/wallet-adjustment-reconciliation\.ts$/,
    /^bounded-contexts\/settlement\/features\/liability-allocation\/read-model\/reconciliation-signals\.ts$/,
    /^bounded-contexts\/platform-operations\/features\/insights-dashboards\/read-model\/reconciliation-policy\.ts$/,
  ]),

  // Operational scripts that mutate persistent environments even when invoked
  // outside a workflow. Scripts referenced by registered release workflows are
  // additionally detected dynamically at classification time.
  operationalScriptPaths: Object.freeze([
    "scripts/apply-digitalocean-database-grant.mjs",
    "scripts/catalog-integration-reset.ts",
    "scripts/catalog-production-completion-report.ts",
    "scripts/discovery-search-embedding-backfill.mjs",
    "scripts/production-readiness-gate.mjs",
    "scripts/production-recovery-mode.mjs",
    "scripts/promoted-release.mjs",
    "scripts/release-deployment-scope.mjs",
    "scripts/release-qualification-record.mjs",
    "scripts/release-qualification-scope.mjs",
    "scripts/run-catalog-integration-reset.mjs",
    "scripts/staging-bootstrap-hook-drill.mjs",
    "scripts/staging-projection-operations.mjs",
    "scripts/staging-refresh-preflight-config.mjs",
    "scripts/staging-refresh-preflight.mjs",
    "scripts/staging-wake-drills.mjs",
  ]),

  // Every workflow file under .github/workflows must be registered as either
  // release (deploys/promotes/mutates persistent environments or provider
  // state, or gates release qualification) or ci (advisory/reporting only).
  // Unknown workflows fail closed.
  workflows: Object.freeze({
    "backlog-roadmap-status.yml": "ci",
    "catalog-integration-staging-reset.yml": "release",
    "catalog-provider-refresh-watch.yml": "release",
    "catalog-staging-provider-uat.yml": "release",
    "checkout-order-readiness-trace.yml": "ci",
    "issue-form-labels.yml": "ci",
    "issue-readiness.yml": "ci",
    "marketplace-easypost-refund-event-replay.yml": "release",
    "marketplace-provider-proof-status.yml": "ci",
    "platform-catalog-assets-apply.yml": "release",
    "platform-catalog-assets-state-repair.yml": "release",
    "platform-seed-packs-apply.yml": "release",
    "platform-ci-flake-digest.yml": "ci",
    "platform-compose-boot-smoke.yml": "release",
    "platform-coverage.yml": "ci",
    "platform-database-restore-drill.yml": "release",
    "platform-delivery-health.yml": "ci",
    "platform-digitalocean-drift-digest.yml": "ci",
    "platform-digitalocean-token-rotation-reminder.yml": "ci",
    "platform-doks-foundation.yml": "release",
    "platform-emergency-recovery.yml": "release",
    "platform-ephemeral-verification.yml": "release",
    "platform-merge-gate-verification.yml": "release",
    "platform-merge-group-failure-signatures.yml": "ci",
    "platform-merge-queue-posture.yml": "ci",
    "platform-observability-state-migration.yml": "release",
    "platform-postgres-growth-evidence.yml": "ci",
    "platform-postgres-slow-query-digest.yml": "ci",
    "platform-pr-scope.yml": "ci",
    "platform-pr.yml": "release",
    "platform-preview-cleanup.yml": "release",
    "platform-production-restore-point-cleanup.yml": "release",
    "platform-production-stripe-webhook-endpoint-create.yml": "release",
    "platform-production-stripe-webhook-endpoint-verify.yml": "release",
    "platform-production.yml": "release",
    "platform-registry-cleanup.yml": "release",
    "representative-catalog-snapshot.yml": "release",
    "platform-release-candidate.yml": "release",
    "platform-risk-review.yml": "ci",
    "platform-rollback-readiness.yml": "release",
    "platform-staging-admin-qa-actor-fixtures.yml": "release",
    "platform-staging-admin-smoke.yml": "release",
    "platform-staging-advisory-evidence.yml": "release",
    "platform-staging-bootstrap-hook-drill.yml": "release",
    "platform-staging-helm-recovery.yml": "release",
    "platform-staging-mixed-version-wake-drills.yml": "release",
    "platform-staging-projection-operations.yml": "release",
    "platform-staging-representative-commerce-state.yml": "release",
    "platform-staging-reset.yml": "release",
    "platform-staging-rollback-drill.yml": "release",
    "platform-staging-route-matrix-evidence.yml": "release",
    "platform-staging-wake-drills.yml": "release",
    "platform-terraform-state-snapshot.yml": "release",
    "project-status-sync.yml": "ci",
    "public-docs-stale-review.yml": "ci",
    "review-cadence-digest.yml": "ci",
  }),

  // Composite actions under .github/actions by directory name.
  actions: Object.freeze({
    "export-managed-postgres-authority": "release",
    "report-scheduled-workflow-alert": "ci",
    "setup-pnpm-workspace": "release",
  }),

  // Reviewed non-persistent rulings for surfaces the caller-inventory sweep
  // discovers but that genuinely carry no persistent-environment consequence.
  // Each entry needs a rationale; anything discovered and not ruled here must
  // classify persistent_required.
  reviewedNonPersistentSurfaces: Object.freeze([
    Object.freeze({
      pattern: /^deployables\/[^/]+\/e2e\//,
      expectedClass: "not_applicable",
      rationale:
        "End-to-end test seed contracts run only inside disposable e2e environments; they never touch persistent staging or production.",
    }),
    Object.freeze({
      pattern: /^bounded-contexts\/(?!checkout\/|ordering\/|payments\/|settlement\/)[^/]+\/index\.ts$/,
      expectedClass: "isolated",
      rationale:
        "Context module barrels import the seed module to compose the context contract; the seed processes themselves are the registered surfaces, and barrels are ordinary application composition. Money-context barrels stay persistent via the money-movement registry.",
    }),
    Object.freeze({
      pattern: /^bounded-contexts\/catalog\/features\/source-observations\/ui\//,
      expectedClass: "isolated",
      rationale:
        "Import-to-promotion admin UI renders the import workflow; the import mutations live under the registered source-observations api surface.",
    }),
  ]),
});

// ---------------------------------------------------------------------------
// Registry boundary validation — malformed registry metadata fails closed.
// ---------------------------------------------------------------------------

export function validateReleaseQualificationScopeRegistry(registry) {
  const errors = [];
  if (typeof registry !== "object" || registry === null) {
    return ["registry must be an object."];
  }
  if (registry.policyVersion !== RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION) {
    errors.push(
      `registry policyVersion must be ${RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION} (got ${JSON.stringify(registry.policyVersion ?? null)}).`,
    );
  }
  validateRecordOfEnums(errors, registry.deployables, DEPLOYABLE_ROLES, "deployables");
  validateRecordOfEnums(errors, registry.infrastructure, INFRASTRUCTURE_RULINGS, "infrastructure");
  validateRecordOfEnums(errors, registry.workflows, WORKFLOW_CATEGORIES, "workflows");
  validateRecordOfEnums(errors, registry.actions, WORKFLOW_CATEGORIES, "actions");
  validateRecordOfEnums(errors, registry.contracts, CONTRACT_RULINGS, "contracts");
  validatePatternList(errors, registry.migrationSurfacePatterns, "migrationSurfacePatterns");
  validatePatternList(errors, registry.migrationMechanismRootPatterns, "migrationMechanismRootPatterns");
  validatePatternList(
    errors,
    registry.seedBootstrapImportReconciliationPatterns,
    "seedBootstrapImportReconciliationPatterns",
  );
  if (
    !Array.isArray(registry.moneyMovementContexts) ||
    registry.moneyMovementContexts.some((name) => typeof name !== "string" || !name)
  ) {
    errors.push("moneyMovementContexts must be an array of context directory names.");
  }
  if (
    !Array.isArray(registry.operationalScriptPaths) ||
    registry.operationalScriptPaths.some((entry) => typeof entry !== "string" || !entry.startsWith("scripts/"))
  ) {
    errors.push("operationalScriptPaths must be an array of scripts/ paths.");
  }
  if (
    !Array.isArray(registry.reviewedNonPersistentSurfaces) ||
    registry.reviewedNonPersistentSurfaces.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        !(entry.pattern instanceof RegExp) ||
        !RELEASE_QUALIFICATION_SCOPE_CLASSES.includes(entry.expectedClass) ||
        typeof entry.rationale !== "string" ||
        entry.rationale.length === 0,
    )
  ) {
    errors.push("reviewedNonPersistentSurfaces must be an array of { pattern, expectedClass, rationale } rulings.");
  }
  return errors;
}

function validateRecordOfEnums(errors, record, allowed, label) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    errors.push(`${label} must be a record of names to categories.`);
    return;
  }
  for (const [name, value] of Object.entries(record)) {
    if (!allowed.includes(value)) {
      errors.push(`${label}.${name} has unknown category ${JSON.stringify(value)}; readers fail closed.`);
    }
  }
}

function validatePatternList(errors, patterns, label) {
  if (!Array.isArray(patterns) || patterns.some((pattern) => !(pattern instanceof RegExp))) {
    errors.push(`${label} must be an array of regular expressions.`);
  }
}

// ---------------------------------------------------------------------------
// Content-semantic detectors — rename-proof. These look at what the code IS
// (Terraform blocks, Kubernetes manifests, SQL DDL, seed runner contracts,
// live-provider SDK usage), never at what the file is called.
// ---------------------------------------------------------------------------

const terraformExtensionPattern = /\.(?:tf|tfvars)$|\.terraform\.lock\.hcl$|(?:^|\/)backend\.hcl(?:\.example)?$/;
const terraformContentPattern =
  /(?:^|\n)\s*(?:resource|data|module|provider)\s+"[A-Za-z0-9_-]+"\s+(?:"[A-Za-z0-9_.-]+"\s+)?\{|(?:^|\n)\s*terraform\s*\{/;
const kubernetesManifestPattern = /(?:^|\n)apiVersion:\s*\S+[\s\S]*?(?:^|\n)kind:\s*[A-Za-z]/;
const helmTemplatePattern = /\{\{-?\s*(?:\.Values|\.Release|\.Chart|include\s)/;
const githubWorkflowContentPattern = /(?:^|\n)on:\s*[\s\S]*?(?:^|\n)jobs:\s*(?:\n|$)[\s\S]*?\bruns-on:/;
const sqlDdlPattern =
  /\b(?:CREATE|ALTER|DROP)\s+(?:UNLOGGED\s+|MATERIALIZED\s+|UNIQUE\s+)?(?:TABLE|INDEX|SCHEMA|TYPE|VIEW|SEQUENCE|TRIGGER|FUNCTION|CONSTRAINT|COLUMN)\b|\bTRUNCATE\s+TABLE\b/i;
const migrationContractPattern = /\bBcSchemaMigration\b|\bmigrationId\s*:/;
const destructiveDataPattern = /\bDELETE\s+FROM\b|\bTRUNCATE\s+TABLE\b|\bDROP\s+TABLE\b/i;
const seedContractPattern =
  /@chase-sets\/[a-z0-9-]+\/seed-support\/|\bBcSeedOptions\b|\bEnvironmentDataProfile\b|\bseedProfileEnabled\b|\bscenario-seed\b|bounded-context-runtime\/seeding/;
const liveProviderContentPattern =
  /from\s+["']stripe["']|require\(["']stripe["']\)|api\.stripe\.com|@easypost\/api|api\.easypost\.com|@aws-sdk\/client-ses|from\s+["']twilio["']|api\.twilio\.com|digitaloceanspaces\.com|api\.digitalocean\.com|\bdoctl\s|\bkubectl\s|\bhelm\s+(?:upgrade|install|uninstall|rollback)\b/;

const docsOrTestOnlyPatterns = [
  /\.(?:md|mdx)$/,
  /^docs\//,
  /^artifacts\//,
  /^\.codex\//,
  /^\.claude\//,
  /^\.agents\//,
  /^\.vscode\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)(?:__tests__|__fixtures__|tests|test-support|fixtures|e2e)\//,
  /^(?:vitest\.[^/]*\.mjs|vitest\.shared\.mjs|playwright\.config\.ts|tsconfig\.tests\.json|test-env\.d\.ts)$/,
];

// Root package.json is intentionally absent: it owns the pnpm-run aliases
// release workflows execute and classifies as release-workflow surface.
const rootApplicationImagePatterns = [
  /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig\.json|tsconfig\.base\.json|tailwind\.config\.ts|Dockerfile|\.dockerignore)$/,
];

const rootRepoToolingPatterns = [
  /^\.(?:prettierrc[^/]*|prettierignore|gitignore|gitattributes|editorconfig|nvmrc|node-version)$/,
  /^\.github\/(?!workflows\/|actions\/)/,
];

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

// ---------------------------------------------------------------------------
// Changed-file listing (with statuses, rename-aware).
// ---------------------------------------------------------------------------

export function listChangedFilesWithStatus(base, head, options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const cwd = options.cwd ?? repoRoot;
  const mergeBase = options.mergeBase ?? exec("git", ["merge-base", base, head], { cwd, encoding: "utf8" }).trim();
  const output = exec("git", ["diff", "--name-status", "-M", `${mergeBase}...${head}`], {
    cwd,
    encoding: "utf8",
  });
  const files = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [rawStatus, first, second] = line.split("\t");
    const statusLetter = (rawStatus ?? "").trim().charAt(0);
    if (statusLetter === "R" || statusLetter === "C") {
      files.push({
        path: normalizeFilePath(second ?? first ?? ""),
        status: statusLetter === "R" ? "renamed" : "added",
        previousPath: normalizeFilePath(first ?? ""),
      });
    } else if (statusLetter === "A") {
      files.push({ path: normalizeFilePath(first ?? ""), status: "added" });
    } else if (statusLetter === "D") {
      files.push({ path: normalizeFilePath(first ?? ""), status: "deleted" });
    } else if (statusLetter === "M" || statusLetter === "T") {
      files.push({ path: normalizeFilePath(first ?? ""), status: "modified" });
    } else {
      files.push({ path: normalizeFilePath(first ?? ""), status: `unknown:${rawStatus ?? ""}` });
    }
  }
  return files.filter((file) => file.path).sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function normalizeFilePath(filePath) {
  return normalizePath(filePath).replace(/^"|"$/g, "").replace(/^\.\//, "");
}

// Extracts scripts/ references from registered release workflows and actions
// so a changed script that a release workflow executes classifies as release
// machinery even when the workflow file itself did not change.
const scriptReferenceTokenPattern = /\bscripts\/[A-Za-z0-9._/-]*?\.(?:mjs|cjs|js|ts|sh)\b/g;
// Matches root pnpm-run alias invocations ("pnpm run smoke:platform"), the
// indirection release workflows actually use. Filtered runs ("pnpm --filter x
// run test") intentionally do not match: those resolve inside a workspace, not
// against the root scripts map.
const pnpmRunAliasPattern = /\bpnpm\s+(?:-[-\w=]+\s+)*run\s+([A-Za-z0-9:._-]+)/g;

function safeReadCandidate(readFileAt, filePath) {
  try {
    const content = readFileAt("candidate", filePath);
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

// Root package.json scripts as an alias graph: each alias maps to the
// scripts/ files it executes plus the further root aliases it chains into.
function readRootScriptAliasGraph(readFileAt) {
  const graph = new Map();
  const content = safeReadCandidate(readFileAt, "package.json");
  if (content === null) {
    return graph;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return graph;
  }
  for (const [alias, command] of Object.entries(parsed?.scripts ?? {})) {
    if (typeof command !== "string") {
      continue;
    }
    graph.set(alias, {
      scriptPaths: [...command.matchAll(scriptReferenceTokenPattern)].map((match) => match[0]),
      aliasReferences: [...command.matchAll(pnpmRunAliasPattern)].map((match) => match[1]),
    });
  }
  return graph;
}

export function collectReleaseWorkflowScriptReferences({ registry, readFileAt }) {
  const references = new Set();
  const aliasGraph = readRootScriptAliasGraph(readFileAt);
  const pendingAliases = [];
  const sources = [
    ...Object.entries(registry.workflows)
      .filter(([, category]) => category === "release")
      .map(([fileName]) => `.github/workflows/${fileName}`),
    ...Object.entries(registry.actions)
      .filter(([, category]) => category === "release")
      .map(([dirName]) => `.github/actions/${dirName}/action.yml`),
  ];
  for (const sourcePath of sources) {
    const content = safeReadCandidate(readFileAt, sourcePath);
    if (content === null) {
      continue;
    }
    for (const match of content.matchAll(scriptReferenceTokenPattern)) {
      references.add(match[0]);
    }
    for (const match of content.matchAll(pnpmRunAliasPattern)) {
      pendingAliases.push(match[1]);
    }
  }
  // Transitive alias resolution: release workflows reach gate scripts through
  // root pnpm-run aliases (and aliases that chain other aliases).
  const resolvedAliases = new Set();
  while (pendingAliases.length > 0) {
    const alias = pendingAliases.shift();
    if (resolvedAliases.has(alias)) {
      continue;
    }
    resolvedAliases.add(alias);
    const entry = aliasGraph.get(alias);
    if (!entry) {
      continue;
    }
    for (const scriptPath of entry.scriptPaths) {
      references.add(scriptPath);
    }
    pendingAliases.push(...entry.aliasReferences);
  }
  return references;
}

// ---------------------------------------------------------------------------
// Per-file classification.
// ---------------------------------------------------------------------------

function classifyFile(file, ctx) {
  const filePath = file.path;

  // Workflows and composite actions are always live release surface areas —
  // even test-named files under .github/workflows execute on their triggers.
  const workflowMatch = filePath.match(/^\.github\/workflows\/([^/]+)$/);
  if (workflowMatch) {
    const category = ctx.registry.workflows[workflowMatch[1]];
    if (category === "release") {
      return persistent(["deployment_release_workflow"]);
    }
    if (category === "ci") {
      return { class: "not_applicable", reasonCodes: ["ci_only_workflow"] };
    }
    return persistent(["unregistered_workflow"]);
  }
  const actionMatch = filePath.match(/^\.github\/actions\/([^/]+)\//);
  if (actionMatch) {
    const category = ctx.registry.actions[actionMatch[1]];
    if (category === "release") {
      return persistent(["deployment_release_workflow"]);
    }
    if (category === "ci") {
      return { class: "not_applicable", reasonCodes: ["ci_only_workflow"] };
    }
    return persistent(["unregistered_workflow"]);
  }

  // Registered persistent surfaces come BEFORE docs/test neutralization:
  // a registered surface inside a fixtures/tests-named path (Helm chart test
  // hooks, Terraform under a fixtures/ segment) is still that surface, and a
  // rename ORIGIN on a registered surface (schema.ts renamed into tests/) is
  // still a persistent change. Docs/test vocabulary only ever neutralizes
  // paths that no registry claims.
  const reasonCodes = new Set();
  for (const candidatePath of [filePath, file.previousPath].filter(Boolean)) {
    collectRegisteredSurfaceCodes(candidatePath, ctx, reasonCodes);
  }
  if (reasonCodes.size > 0) {
    return persistent([...reasonCodes]);
  }

  // Root package.json owns the pnpm-run aliases release workflows execute:
  // any change to it can rewire a release gate, so it is release-workflow
  // surface area, fail closed. (Workspace package.json files are unaffected.)
  if (filePath === "package.json") {
    return persistent(["deployment_release_workflow"]);
  }

  // Documentation and test-only files outside every registered surface carry
  // no release-path consequence; this also neutralizes path-name lookalikes
  // such as docs about Terraform.
  if (matchesAny(filePath, docsOrTestOnlyPatterns)) {
    return { class: "not_applicable", reasonCodes: ["docs_or_test_only"] };
  }
  if (matchesAny(filePath, rootRepoToolingPatterns)) {
    return { class: "not_applicable", reasonCodes: ["repo_tooling_only"] };
  }
  if (matchesAny(filePath, rootApplicationImagePatterns) || /^deployables\/[^/]+\/Dockerfile$/.test(filePath)) {
    return { class: "isolated", reasonCodes: ["application_image"] };
  }

  // Content-semantic detectors (rename-proof). Deleted files are read from the
  // base tree: removing a migration or provider surface is still that surface.
  const contentRef = file.status === "deleted" ? "base" : "candidate";
  let content = null;
  let contentUnreadable = false;
  try {
    content = ctx.readFileAt(contentRef, filePath);
  } catch {
    contentUnreadable = true;
  }
  if (typeof content !== "string") {
    contentUnreadable = true;
  }
  if (contentUnreadable) {
    reasonCodes.add("unreadable_file");
  } else {
    collectContentSemanticCodes(filePath, content, ctx, reasonCodes);
    collectResolvedImportCodes(filePath, content, ctx, reasonCodes);
  }

  if (reasonCodes.size > 0) {
    return persistent([...reasonCodes]);
  }

  // Scripts: release-workflow-referenced or registered operational scripts are
  // release machinery; the rest are repository tooling with no deploy path.
  if (filePath.startsWith("scripts/")) {
    if (ctx.registry.operationalScriptPaths.includes(filePath) || ctx.releaseWorkflowScriptReferences.has(filePath)) {
      return persistent(["deployment_release_workflow"]);
    }
    return { class: "not_applicable", reasonCodes: ["repo_tooling_only"] };
  }

  // Deployables: registered runtime deployables are application changes; an
  // unregistered (for example renamed) deployable fails closed.
  const deployableMatch = filePath.match(/^deployables\/([^/]+)\//);
  if (deployableMatch) {
    const role = ctx.registry.deployables[deployableMatch[1]];
    if (role === "runtime") {
      return { class: "isolated", reasonCodes: ["application_runtime"] };
    }
    if (role === "seed-machinery") {
      return persistent(["seed_bootstrap_import_reconciliation"]);
    }
    return persistent(["unregistered_deployable"]);
  }

  // Infrastructure: rulings that did not already classify above resolve here.
  const infrastructureMatch = filePath.match(/^infrastructure\/([^/]+)\//);
  if (infrastructureMatch) {
    const ruling = ctx.registry.infrastructure[infrastructureMatch[1]];
    if (ruling === "runtime-library" || ruling === "test-mode-provider") {
      return { class: "isolated", reasonCodes: ["application_runtime"] };
    }
    if (ruling === "repo-tooling") {
      return { class: "not_applicable", reasonCodes: ["repo_tooling_only"] };
    }
    return persistent(["unregistered_infrastructure"]);
  }

  // Shared contracts: persistent rulings were already collected above; the
  // remaining registered contracts are ordinary application libraries, and an
  // unregistered contracts directory fails closed.
  const contractMatch = filePath.match(/^contracts\/([^/]+)\//);
  if (contractMatch) {
    if (ctx.registry.contracts[contractMatch[1]] === "runtime-library") {
      return { class: "isolated", reasonCodes: ["application_runtime"] };
    }
    return persistent(["unregistered_contract"]);
  }

  // Application code in workspace roots is provable in isolation.
  if (/^(?:bounded-contexts|packages)\//.test(filePath)) {
    return { class: "isolated", reasonCodes: ["application_runtime"] };
  }

  // Anything else is an unknown surface: fail closed.
  return persistent(["unknown_surface"]);
}

// Rename-proof indirect-caller detection: an import whose RESOLVED repository
// path lands on a registered seed/bootstrap/import/reconciliation surface
// makes the importer part of that machinery, whether the specifier is
// relative or package-style.
function collectResolvedImportCodes(filePath, content, ctx, reasonCodes) {
  const fileDir = path.posix.dirname(filePath);
  for (const match of content.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    const candidates = [];
    if (specifier.startsWith(".")) {
      const resolved = path.posix.normalize(path.posix.join(fileDir, specifier));
      candidates.push(resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.mjs`, `${resolved}/index.ts`);
    } else {
      const packageMatch = specifier.match(/^@chase-sets\/([a-z0-9-]+)\/(.+)$/);
      if (packageMatch) {
        const [, packageName, subpath] = packageMatch;
        for (const root of ["bounded-contexts", "contracts", "infrastructure", "packages"]) {
          for (const mappedSubpath of [subpath, `support/${subpath}`]) {
            const resolved = `${root}/${packageName}/${mappedSubpath}`;
            candidates.push(resolved, `${resolved}.ts`, `${resolved}/index.ts`);
          }
        }
      }
    }
    if (candidates.some((candidate) => matchesAny(candidate, ctx.registry.seedBootstrapImportReconciliationPatterns))) {
      reasonCodes.add("seed_bootstrap_import_reconciliation");
      return;
    }
  }
}

function persistent(codes) {
  return { class: "persistent_required", reasonCodes: [...codes].sort() };
}

function collectRegisteredSurfaceCodes(filePath, ctx, reasonCodes) {
  const registry = ctx.registry;
  if (matchesAny(filePath, registry.migrationSurfacePatterns)) {
    reasonCodes.add("migration_schema");
  }
  if (matchesAny(filePath, registry.seedBootstrapImportReconciliationPatterns)) {
    reasonCodes.add("seed_bootstrap_import_reconciliation");
  }
  const moneyContextPattern = new RegExp(
    `^bounded-contexts/(?:${registry.moneyMovementContexts.join("|")})/(?:features/[^/]+/(?:domain|api|integrations)/|(?:index|client|server)\\.ts$)`,
  );
  if (moneyContextPattern.test(filePath)) {
    reasonCodes.add("money_movement_contract");
  }
  const infrastructureMatch = filePath.match(/^infrastructure\/([^/]+)\//);
  if (infrastructureMatch) {
    const ruling = registry.infrastructure[infrastructureMatch[1]];
    if (ruling === "terraform") {
      reasonCodes.add("terraform_infrastructure");
    } else if (ruling === "helm") {
      reasonCodes.add("helm_doks_ingress_dns_spaces");
    } else if (ruling === "live-provider") {
      reasonCodes.add("live_provider_contract");
    } else if (ruling === "event-store-persistence") {
      reasonCodes.add("migration_schema");
    }
  }
  const contractMatch = filePath.match(/^contracts\/([^/]+)\//);
  if (contractMatch) {
    const ruling = registry.contracts[contractMatch[1]];
    if (ruling === "money-movement-contract") {
      reasonCodes.add("money_movement_contract");
    } else if (ruling === "live-provider") {
      reasonCodes.add("live_provider_contract");
    } else if (ruling === "event-store-persistence") {
      reasonCodes.add("migration_schema");
    } else if (ruling === "seed-machinery") {
      reasonCodes.add("seed_bootstrap_import_reconciliation");
    }
  }
  if (
    filePath.startsWith("scripts/") &&
    (registry.operationalScriptPaths.includes(filePath) || ctx.releaseWorkflowScriptReferences.has(filePath))
  ) {
    reasonCodes.add("deployment_release_workflow");
  }
}

function collectContentSemanticCodes(filePath, content, ctx, reasonCodes) {
  if (terraformExtensionPattern.test(filePath) || terraformContentPattern.test(content)) {
    reasonCodes.add("terraform_infrastructure");
  }
  if (kubernetesManifestPattern.test(content) || helmTemplatePattern.test(content)) {
    reasonCodes.add("helm_doks_ingress_dns_spaces");
  }
  if (githubWorkflowContentPattern.test(content)) {
    // Workflow-shaped content outside .github/workflows is inert for GitHub,
    // but treating it as release machinery keeps renamed copies fail-closed.
    reasonCodes.add("unregistered_workflow_semantics");
  }
  if (sqlDdlPattern.test(content) || migrationContractPattern.test(content) || /\.sql$/.test(filePath)) {
    const ownedByRegisteredMechanism =
      matchesAny(filePath, ctx.registry.migrationSurfacePatterns) ||
      matchesAny(filePath, ctx.registry.migrationMechanismRootPatterns);
    reasonCodes.add(ownedByRegisteredMechanism ? "migration_schema" : "unrecognized_migration_mechanism");
  }
  if (destructiveDataPattern.test(content)) {
    reasonCodes.add("destructive_data");
  }
  if (seedContractPattern.test(content)) {
    reasonCodes.add("seed_bootstrap_import_reconciliation");
  }
  if (liveProviderContentPattern.test(content)) {
    const infrastructureMatch = filePath.match(/^infrastructure\/([^/]+)\//);
    const isRegisteredTestModeProvider =
      infrastructureMatch && ctx.registry.infrastructure[infrastructureMatch[1]] === "test-mode-provider";
    if (!isRegisteredTestModeProvider) {
      reasonCodes.add("live_provider_contract");
    }
  }
  // Provenance references to release machinery: content that embeds a script
  // release workflows execute (for example rendered Helm values carrying their
  // generatedBy marker) is deploy-surface material wherever it lives.
  for (const match of content.matchAll(scriptReferenceTokenPattern)) {
    if (ctx.releaseWorkflowScriptReferences.has(match[0]) || ctx.registry.operationalScriptPaths.includes(match[0])) {
      reasonCodes.add("deployment_release_workflow");
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-diff classification. Never throws: every failure path returns a
// persistent_required record with an explicit fail-closed trigger.
// ---------------------------------------------------------------------------

export function classifyReleaseQualificationScope(input) {
  const startedAtMs = (input.now ?? Date.now)();
  try {
    return classifyOrThrow(input, startedAtMs);
  } catch (error) {
    return failClosedRecord(input, startedAtMs, {
      trigger: "classifier_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function classifyOrThrow(input, startedAtMs) {
  const registry = input.registry ?? releaseQualificationScopeRegistry;
  const registryErrors = validateReleaseQualificationScopeRegistry(registry);
  if (registryErrors.length > 0) {
    return failClosedRecord(input, startedAtMs, {
      trigger: "unreadable_metadata",
      detail: `registry is invalid: ${registryErrors.join(" ")}`,
    });
  }

  if (
    input.requestedPolicyVersion !== undefined &&
    input.requestedPolicyVersion !== null &&
    input.requestedPolicyVersion !== RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION
  ) {
    return failClosedRecord(input, startedAtMs, {
      trigger: "unsupported_policy_version",
      detail: `requested policy version ${JSON.stringify(input.requestedPolicyVersion)} is not ${RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION}; future or unknown policy versions fail closed.`,
    });
  }

  if (!input.base || !isCommitSha(input.base.sha ?? "") || !isCommitSha(input.base.treeSha ?? "")) {
    return failClosedRecord(input, startedAtMs, {
      trigger: "missing_base",
      detail:
        "no production-marker base commit/tree was available; without a base the complete diff cannot be evaluated.",
    });
  }
  if (!input.candidate || !isCommitSha(input.candidate.sha ?? "") || !isCommitSha(input.candidate.treeSha ?? "")) {
    return failClosedRecord(input, startedAtMs, {
      trigger: "missing_candidate",
      detail: "no candidate commit/tree was available.",
    });
  }
  if (!Array.isArray(input.changedFiles)) {
    return failClosedRecord(input, startedAtMs, {
      trigger: "unreadable_metadata",
      detail: "changed-file listing was unavailable.",
    });
  }
  if (typeof input.readFileAt !== "function") {
    return failClosedRecord(input, startedAtMs, {
      trigger: "unreadable_metadata",
      detail: "no file reader was provided.",
    });
  }

  const ctx = {
    registry,
    readFileAt: input.readFileAt,
    releaseWorkflowScriptReferences:
      input.releaseWorkflowScriptReferences ??
      collectReleaseWorkflowScriptReferences({ registry, readFileAt: input.readFileAt }),
  };

  const changedFiles = [...input.changedFiles]
    .map((file) => ({ ...file, path: normalizeFilePath(file.path) }))
    .filter((file) => file.path)
    .sort((left, right) => left.path.localeCompare(right.path, "en"));

  const files = changedFiles.map((file) => {
    if (typeof file.status !== "string" || file.status.startsWith("unknown:")) {
      return { path: file.path, status: file.status ?? "unknown:", ...persistent(["unknown_change_status"]) };
    }
    const result = classifyFile(file, ctx);
    return { path: file.path, status: file.status, class: result.class, reasonCodes: result.reasonCodes };
  });

  const affectedDeployables = resolveAffectedDeployables(input, changedFiles, registry);

  let overallClass = "not_applicable";
  const reasonCodes = new Set();
  for (const file of files) {
    if (CLASS_RANK[file.class] > CLASS_RANK[overallClass]) {
      overallClass = file.class;
    }
  }
  for (const file of files) {
    if (file.class === overallClass) {
      for (const code of file.reasonCodes) {
        reasonCodes.add(code);
      }
    }
  }
  if (files.length === 0) {
    reasonCodes.add("empty_diff");
  }

  return finalizeRecord({
    input,
    startedAtMs,
    record: {
      class: overallClass,
      failClosed: null,
      reasonCodes: [...reasonCodes].sort(),
      reasons: summarizeReasons(files, [...reasonCodes].sort()),
      base: input.base,
      candidate: input.candidate,
      changedFileCount: files.length,
      evaluatedFileCount: files.length,
      files,
      affectedDeployables,
    },
  });
}

function resolveAffectedDeployables(input, changedFiles, registry) {
  if (!input.workspaces) {
    return null;
  }
  const scope = classifyChanges({
    changedFiles: changedFiles.map((file) => file.path),
    workspaces: input.workspaces,
    baseDir: input.baseDir ?? repoRoot,
  });
  const deployableWorkspaceNames = new Set(
    input.workspaces
      .filter((workspace) => workspace.root === "deployables" && registry.deployables[workspace.dirName])
      .map((workspace) => workspace.name),
  );
  return scope.runtimeAffectedWorkspaces.filter((name) => deployableWorkspaceNames.has(name)).sort();
}

function summarizeReasons(files, reasonCodes) {
  return reasonCodes.map((code) => {
    const matching = files.filter((file) => file.reasonCodes.includes(code));
    return {
      code,
      fileCount: matching.length,
      examples: matching.slice(0, 5).map((file) => file.path),
    };
  });
}

function failClosedRecord(input, startedAtMs, failClosed) {
  return finalizeRecord({
    input,
    startedAtMs,
    record: {
      class: "persistent_required",
      failClosed,
      reasonCodes: [failClosed.trigger],
      reasons: [{ code: failClosed.trigger, fileCount: 0, examples: [] }],
      base: input?.base && isCommitSha(input.base.sha ?? "") ? input.base : null,
      candidate: input?.candidate && isCommitSha(input.candidate.sha ?? "") ? input.candidate : null,
      changedFileCount: Array.isArray(input?.changedFiles) ? input.changedFiles.length : null,
      evaluatedFileCount: 0,
      files: [],
      affectedDeployables: null,
    },
  });
}

function finalizeRecord({ input, startedAtMs, record }) {
  const now = input?.now ?? Date.now;
  const finishedAtMs = now();
  const jobStartedAtMs = input?.jobStartedAt ? Date.parse(input.jobStartedAt) : Number.NaN;
  const elapsedSinceJobStartMs = Number.isFinite(jobStartedAtMs) ? Math.max(0, finishedAtMs - jobStartedAtMs) : null;
  return {
    schemaVersion: RELEASE_QUALIFICATION_SCOPE_SCHEMA_VERSION,
    policyVersion: RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION,
    ...record,
    generatedAt: new Date(finishedAtMs).toISOString(),
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    actionsMinutes:
      elapsedSinceJobStartMs === null
        ? null
        : {
            elapsedSeconds: Math.round(elapsedSinceJobStartMs / 1000),
            billedEstimate: Math.max(1, Math.ceil(elapsedSinceJobStartMs / 60000)),
          },
  };
}

// ---------------------------------------------------------------------------
// Advisory rendering — merge-group step summary. Advisory only: no required
// check consumes this output.
// ---------------------------------------------------------------------------

export function renderAdvisorySummary(record) {
  const lines = [];
  lines.push("## Release qualification scope (advisory)");
  lines.push("");
  lines.push(`- Class: \`${record.class}\``);
  lines.push(`- Policy: \`${record.policyVersion}\` (advisory only; does not change required checks)`);
  if (record.failClosed) {
    lines.push(`- Fail-closed trigger: \`${record.failClosed.trigger}\` — ${record.failClosed.detail}`);
  }
  lines.push(
    `- Base: ${record.base ? `\`${record.base.sha}\` (tree \`${record.base.treeSha}\`)` : "unavailable"} → Candidate: ${record.candidate ? `\`${record.candidate.sha}\` (tree \`${record.candidate.treeSha}\`)` : "unavailable"}`,
  );
  lines.push(
    `- Changed files evaluated: ${record.evaluatedFileCount} of ${record.changedFileCount ?? "unknown"} (untruncated)`,
  );
  if (record.affectedDeployables && record.affectedDeployables.length > 0) {
    lines.push(`- Runtime-affected deployables: ${record.affectedDeployables.join(", ")}`);
  }
  if (record.actionsMinutes) {
    lines.push(
      `- Actions minutes for this classification: ~${record.actionsMinutes.elapsedSeconds}s elapsed, billed estimate ${record.actionsMinutes.billedEstimate} minute(s)`,
    );
  }
  lines.push("");
  if (record.reasons.length > 0) {
    lines.push("| Reason code | Files | Examples |");
    lines.push("| --- | --- | --- |");
    for (const reason of record.reasons) {
      lines.push(`| \`${reason.code}\` | ${reason.fileCount} | ${reason.examples.join("<br>") || "—"} |`);
    }
    lines.push("");
  }
  lines.push(
    "_Fail-closed polarity: unknown or unreadable evidence classifies `persistent_required`. The sibling release-deployment-scope check deliberately fails open-to-deploy instead; both fail toward the safer action._",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function gitOutput(gitPath, args, cwd, { ignoreFailure = false } = {}) {
  try {
    return execFileSync(gitPath, args, { cwd, encoding: "utf8" });
  } catch (error) {
    if (ignoreFailure) {
      return null;
    }
    throw error;
  }
}

export function runClassifyCli(argv, { cwd = repoRoot, log = console.log } = {}) {
  const gitPath = readOption(argv, "--git") ?? "git";
  const candidateSha = readOption(argv, "--candidate");
  if (!candidateSha) {
    throw new Error("classify requires --candidate <sha>.");
  }
  const requestedPolicyVersion = readOption(argv, "--policy-version");
  const jobStartedAt = readOption(argv, "--job-started-at");

  gitOutput(gitPath, ["fetch", "origin", "production"], cwd, { ignoreFailure: true });

  const resolveTree = (sha) => gitOutput(gitPath, ["rev-parse", `${sha}^{tree}`], cwd, { ignoreFailure: true });
  const baseRef = readOption(argv, "--base") ?? "origin/production";
  const baseSha = gitOutput(gitPath, ["rev-parse", baseRef], cwd, { ignoreFailure: true });
  const candidateResolved = gitOutput(gitPath, ["rev-parse", candidateSha], cwd, { ignoreFailure: true });

  const base = baseSha ? { sha: baseSha.trim(), treeSha: (resolveTree(baseSha.trim()) ?? "").trim() } : null;
  const candidate = candidateResolved
    ? { sha: candidateResolved.trim(), treeSha: (resolveTree(candidateResolved.trim()) ?? "").trim() }
    : null;

  let changedFiles = null;
  if (base && candidate && isCommitSha(base.sha) && isCommitSha(candidate.sha)) {
    try {
      changedFiles = listChangedFilesWithStatus(base.sha, candidate.sha, { cwd });
    } catch {
      changedFiles = null;
    }
  }

  const record = classifyReleaseQualificationScope({
    base,
    candidate,
    changedFiles: changedFiles ?? (base && candidate ? undefined : []),
    readFileAt: (ref, filePath) => {
      const sha = ref === "base" ? base?.sha : candidate?.sha;
      if (!sha) {
        return null;
      }
      return gitOutput(gitPath, ["show", `${sha}:${filePath}`], cwd, { ignoreFailure: true });
    },
    workspaces: safeListWorkspaces(cwd),
    baseDir: cwd,
    requestedPolicyVersion,
    jobStartedAt,
  });

  log(JSON.stringify(record, null, 2));
  return record;
}

function safeListWorkspaces(cwd) {
  try {
    return listWorkspacePackages({ repoRoot: cwd });
  } catch {
    // classifyReleaseQualificationScope treats absent workspace metadata as
    // "no dependency evidence" (affectedDeployables: null); the class itself
    // never becomes more permissive because metadata was unreadable.
    return null;
  }
}

async function main(argv) {
  const [command] = argv;
  if (command !== "classify") {
    console.error("usage: release-qualification-scope.mjs classify --candidate <sha> [options]");
    return 1;
  }
  let record;
  try {
    record = runClassifyCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const outPath = readOption(argv, "--out");
  if (outPath) {
    await writeJsonRecord(outPath, record);
  }
  const summaryPath = readOption(argv, "--github-summary");
  if (summaryPath) {
    appendFileSync(summaryPath, `${renderAdvisorySummary(record)}\n`, "utf8");
  }
  // Advisory-only: classification outcomes (including fail-closed) exit 0 so
  // this step can never turn a merge-group run red.
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
