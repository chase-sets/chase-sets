import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";
import { estimatedE2eSuiteDurationSeconds } from "./e2e-suites.mjs";
import { listWorkspacePackages, repoRoot } from "./lib/repo.mjs";
import { classifyIntegrationRisk, classifyRisk } from "./lib/risk-policy-v1.mjs";

const priorProductionIntegrationRules = [
  {
    reason: "Bounded-context metadata, including event subscriptions, changed",
    patterns: [/^bounded-contexts\/[^/]+\/context\.json$/],
  },
  {
    reason: "Cross-context subscription or runtime composition changed",
    patterns: [
      /^infrastructure\/(?:bounded-context-runtime|platform-runtime)\//,
      /^deployables\/(?:platform-api|platform-worker)\/src\/generated\/.*context-registry\.ts$/,
      /^deployables\/(?:admin-web|marketplace|public-web)\/app\/generated\/web-context-registry\.ts$/,
    ],
  },
  {
    reason: "Shared application shell or router changed",
    patterns: [
      /^deployables\/admin-web\/app\/(?:admin-root-shell|host|routes)\.[cm]?[tj]sx?$/,
      /^deployables\/admin-web\/app\/routes\/[^/]+-layout\.[cm]?[tj]sx?$/,
      /^deployables\/marketplace\/app\/(?:root|routes)\.[cm]?[tj]sx?$/,
      /^deployables\/marketplace\/app\/routes\/layout\.[cm]?[tj]sx?$/,
    ],
  },
  {
    reason: "Design-system navigation changed",
    patterns: [
      /^packages\/design-system\/src\/components\/actions\/(?:navigation|navigation-menu|navigation-header|section-navigation)\.[cm]?[jt]sx?$/,
      /^packages\/design-system\/src\/patterns\/app-shells\/shells\.[cm]?[jt]sx?$/,
      /^packages\/design-system\/src\/theme\/(?:link-adapter|provider)\.[cm]?[jt]sx?$/,
    ],
  },
];

function priorProductionIntegrationReasons(filename) {
  return priorProductionIntegrationRules
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(filename)))
    .map((rule) => rule.reason);
}

const lockedIntegrationParityCorpus = [
  ["modified", "contracts/primitives/typed-ids.ts"],
  ["added", "contracts/http/client.ts"],
  ["removed", "infrastructure/platform-runtime/runtime.ts"],
  ["modified", "infrastructure/platform-runtime/runtime.test.ts"],
  ["added", "infrastructure/platform-runtime/README.md"],
  ["removed", "infrastructure/bounded-context-runtime/compose.test.ts"],
  ["modified", "infrastructure/bounded-context-runtime/docs/composition.md"],
  ["added", "bounded-contexts/pricing/context.json"],
  ["modified", "deployables/platform-worker/src/generated/worker-context-registry.ts"],
  ["modified", "deployables/marketplace/app/generated/web-context-registry.ts"],
  ["modified", "deployables/admin-web/app/admin-root-shell.tsx"],
  ["modified", "packages/design-system/src/components/actions/navigation-menu.tsx"],
  ["modified", "docs/runbooks/integration-risk.md"],
  ["renamed", "infrastructure/platform-runtime/renamed-runtime.ts", "archive/renamed-runtime.ts"],
  ["renamed", "archive/legacy-runtime.ts", "infrastructure/platform-runtime/legacy-runtime.ts"],
];

const schedulerOwnedArtifacts = [
  "scripts/run-workspaces.mjs",
  "scripts/run-workspaces.test.mjs",
  "scripts/workspace-test-duration-hints-v1.json",
  "scripts/fixtures/workspace-unit-duration-replay-v1.json",
];

// Paths that carry the scheduler's filename vocabulary without being members of
// the frozen set above. They are planted, not real repository files: the point
// is that selection is exact-path set membership, so a near-miss name must
// classify exactly like any other unrelated script.
const schedulerVocabularyLookalikePaths = [
  "scripts/run-workspaces-report.mjs",
  "scripts/lib/run-workspaces-support.mjs",
  "scripts/fixtures/run-workspaces-legacy-v1.json",
  "scripts/workspace-test-duration-hints-v2.json",
  "scripts/fixtures/workspace-unit-duration-replay-v2.json",
];

// Captured offline at the base commit refs/remotes/origin/main
// f78143573af96c636d97696b987a82990df23904 by importing the unmodified
// classifier and calling the exported classifyChanges and toOutputMap directly.
// A scheduler-owned change fans every workspace into the affected set, so this
// is that fan-out's exact membership and order at the base commit. It is
// asserted against the live workspace inventory as well, so adding a workspace
// fails here loudly and this pin is refreshed with it.
const baseCapturedSchedulerFanoutWorkspaces = [
  "@chase-sets/app-admin-web",
  "@chase-sets/app-marketplace-web",
  "@chase-sets/app-platform-api",
  "@chase-sets/app-platform-worker",
  "@chase-sets/app-public-web",
  "@chase-sets/auth",
  "@chase-sets/auth-context",
  "@chase-sets/authenticity",
  "@chase-sets/bounded-context-module",
  "@chase-sets/bounded-context-runtime",
  "@chase-sets/catalog",
  "@chase-sets/catalog-seed",
  "@chase-sets/channels",
  "@chase-sets/checkout",
  "@chase-sets/checkout-order-source",
  "@chase-sets/collections",
  "@chase-sets/commercial-terms",
  "@chase-sets/customer-feedback",
  "@chase-sets/design-system",
  "@chase-sets/discovery",
  "@chase-sets/easypost-postage",
  "@chase-sets/event-core",
  "@chase-sets/event-core-postgres",
  "@chase-sets/fulfillment",
  "@chase-sets/http",
  "@chase-sets/identity",
  "@chase-sets/identity-seed",
  "@chase-sets/inventory",
  "@chase-sets/local-email-capture",
  "@chase-sets/localization",
  "@chase-sets/market-estimate-display",
  "@chase-sets/marketplace",
  "@chase-sets/marketplace-seed-testing",
  "@chase-sets/money-movement",
  "@chase-sets/notification-outbox",
  "@chase-sets/notifications",
  "@chase-sets/object-storage",
  "@chase-sets/observability",
  "@chase-sets/ordering",
  "@chase-sets/outbound-messaging",
  "@chase-sets/payment-processing",
  "@chase-sets/payments",
  "@chase-sets/platform-operations",
  "@chase-sets/platform-policy",
  "@chase-sets/platform-runtime",
  "@chase-sets/playwright-evidence",
  "@chase-sets/postage-labels",
  "@chase-sets/pricing",
  "@chase-sets/primitives",
  "@chase-sets/product-measures",
  "@chase-sets/product-selection",
  "@chase-sets/provider-webhook-inbox",
  "@chase-sets/public-docs",
  "@chase-sets/public-presence",
  "@chase-sets/realtime",
  "@chase-sets/review-eligibility",
  "@chase-sets/seller-attention-queue",
  "@chase-sets/seller-desk",
  "@chase-sets/ses-email",
  "@chase-sets/settlement",
  "@chase-sets/stripe-config",
  "@chase-sets/stripe-connect",
  "@chase-sets/stripe-payments",
  "@chase-sets/twilio-messaging",
  "@chase-sets/typescript-compiler-api",
  "@chase-sets/web-notifications",
];

const baseCapturedAllWorkspacesCsv = baseCapturedSchedulerFanoutWorkspaces.join(",");
const baseCapturedAllWorkspacesJson = JSON.stringify(baseCapturedSchedulerFanoutWorkspaces);

// The exact key order `toOutputMap` emits at the base commit. Asserting it per
// corpus case closes the output schema, so a silently added or reordered output
// cannot hide behind a value-only comparison.
const baseCapturedOutputMapKeyOrder = [
  "changed_files_json",
  "affected_workspaces",
  "affected_workspaces_json",
  "directly_affected_workspaces_json",
  "docs_only",
  "local_checks",
  "unit_tests",
  "db_tests",
  "e2e_tests",
  "e2e_suites",
  "e2e_suites_json",
  "e2e_suite_batches_json",
  "integration_risk_required",
  "integration_risk_reason",
  "build",
  "docker_image",
  "terraform",
  "workflow_lint",
  "deploy",
  "cluster_preview",
  "compose_smoke",
  "exposure_posture_changed",
  "exposure_posture_categories",
  "exposure_posture_categories_json",
];

const baseCapturedQuietGateOutputs = {
  e2e_tests: "false",
  e2e_suites: "",
  e2e_suites_json: "[]",
  e2e_suite_batches_json: "[]",
  integration_risk_required: "false",
  integration_risk_reason: "No integration-risk change detected",
  build: "false",
  docker_image: "false",
  terraform: "false",
  workflow_lint: "false",
  deploy: "false",
  cluster_preview: "false",
  compose_smoke: "false",
  exposure_posture_changed: "false",
  exposure_posture_categories: "",
  exposure_posture_categories_json: "[]",
};

function baseCapturedSchedulerFanoutOutputMap(changedFiles) {
  return {
    changed_files_json: JSON.stringify(changedFiles),
    affected_workspaces: baseCapturedAllWorkspacesCsv,
    affected_workspaces_json: baseCapturedAllWorkspacesJson,
    directly_affected_workspaces_json: "[]",
    docs_only: "false",
    local_checks: "true",
    unit_tests: "true",
    db_tests: "false",
    ...baseCapturedQuietGateOutputs,
  };
}

function baseCapturedNoWorkspaceOutputMap(changedFiles, overrides = {}) {
  return {
    changed_files_json: JSON.stringify(changedFiles),
    affected_workspaces: "",
    affected_workspaces_json: "[]",
    directly_affected_workspaces_json: "[]",
    docs_only: "false",
    local_checks: "true",
    unit_tests: "false",
    db_tests: "false",
    ...baseCapturedQuietGateOutputs,
    ...overrides,
  };
}

// The old-versus-new corpus. `baseDbTests` and `baseOutputMap` are the values
// the unmodified classifier produced at the base commit; `expectedDbTests` is
// what the extended predicate must produce. Recording both is what makes the
// set of changed classifications an asserted fact rather than a claim.
const dbTestsOldVersusNewCorpus = [
  {
    name: "scheduler-owned artifact scripts/run-workspaces.mjs",
    changedFiles: ["scripts/run-workspaces.mjs"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/run-workspaces.mjs"]),
  },
  {
    name: "scheduler-owned artifact scripts/run-workspaces.test.mjs",
    changedFiles: ["scripts/run-workspaces.test.mjs"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/run-workspaces.test.mjs"]),
  },
  {
    name: "scheduler-owned artifact scripts/workspace-test-duration-hints-v1.json",
    changedFiles: ["scripts/workspace-test-duration-hints-v1.json"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/workspace-test-duration-hints-v1.json"]),
  },
  {
    name: "scheduler-owned artifact scripts/fixtures/workspace-unit-duration-replay-v1.json",
    changedFiles: ["scripts/fixtures/workspace-unit-duration-replay-v1.json"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/fixtures/workspace-unit-duration-replay-v1.json"]),
  },
  {
    name: "documentation-only change",
    changedFiles: ["docs/runbooks/release-process-evolution.md"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["docs/runbooks/release-process-evolution.md"], {
      docs_only: "true",
      exposure_posture_changed: "true",
      exposure_posture_categories: "rollout-policy",
      exposure_posture_categories_json: '["rollout-policy"]',
    }),
  },
  {
    name: "workflow-only change",
    changedFiles: [".github/workflows/platform-pr.yml"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap([".github/workflows/platform-pr.yml"], {
      workflow_lint: "true",
      cluster_preview: "true",
    }),
  },
  {
    name: "change-scope classifier-only change",
    changedFiles: ["scripts/change-scope.mjs"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["scripts/change-scope.mjs"]),
  },
  {
    name: "this slice's own footprint",
    changedFiles: ["scripts/change-scope.mjs", "scripts/change-scope.test.mjs"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["scripts/change-scope.mjs", "scripts/change-scope.test.mjs"]),
  },
  {
    name: "db-test-preflight-only change",
    changedFiles: ["scripts/db-test-preflight.mjs"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["scripts/db-test-preflight.mjs"]),
  },
  {
    name: "unrelated bounded-context change",
    changedFiles: ["bounded-contexts/ordering/features/tax-quotes/domain/tax-quote.ts"],
    baseDbTests: "true",
    expectedDbTests: "true",
    changesDbTests: false,
    baseOutputMap: {
      changed_files_json: '["bounded-contexts/ordering/features/tax-quotes/domain/tax-quote.ts"]',
      affected_workspaces:
        "@chase-sets/app-admin-web,@chase-sets/app-marketplace-web,@chase-sets/app-platform-api,@chase-sets/app-platform-worker,@chase-sets/checkout,@chase-sets/discovery,@chase-sets/marketplace-seed-testing,@chase-sets/ordering,@chase-sets/payments,@chase-sets/settlement",
      affected_workspaces_json:
        '["@chase-sets/app-admin-web","@chase-sets/app-marketplace-web","@chase-sets/app-platform-api","@chase-sets/app-platform-worker","@chase-sets/checkout","@chase-sets/discovery","@chase-sets/marketplace-seed-testing","@chase-sets/ordering","@chase-sets/payments","@chase-sets/settlement"]',
      directly_affected_workspaces_json: '["@chase-sets/ordering"]',
      docs_only: "false",
      local_checks: "true",
      unit_tests: "true",
      db_tests: "true",
      ...baseCapturedQuietGateOutputs,
      build: "true",
      docker_image: "true",
      deploy: "true",
      compose_smoke: "true",
      exposure_posture_changed: "true",
      exposure_posture_categories: "live-money-provider,tax-posture",
      exposure_posture_categories_json: '["live-money-provider","tax-posture"]',
    },
  },
  {
    name: "root shared vitest config change",
    changedFiles: ["vitest.shared.mjs"],
    baseDbTests: "true",
    expectedDbTests: "true",
    changesDbTests: false,
    baseOutputMap: {
      ...baseCapturedSchedulerFanoutOutputMap(["vitest.shared.mjs"]),
      directly_affected_workspaces_json: baseCapturedAllWorkspacesJson,
      db_tests: "true",
    },
  },
  {
    name: "DB-capable deployable script change",
    changedFiles: ["deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs"],
    baseDbTests: "true",
    expectedDbTests: "true",
    changesDbTests: false,
    baseOutputMap: {
      changed_files_json: '["deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs"]',
      affected_workspaces: "@chase-sets/app-platform-api",
      affected_workspaces_json: '["@chase-sets/app-platform-api"]',
      directly_affected_workspaces_json: '["@chase-sets/app-platform-api"]',
      docs_only: "false",
      local_checks: "true",
      unit_tests: "true",
      db_tests: "true",
      ...baseCapturedQuietGateOutputs,
      e2e_tests: "true",
      e2e_suites:
        "marketplace_browse,marketplace_account,marketplace_checkout,marketplace_seller,catalog_admin_integrations,catalog_admin_modeling,admin_growth,admin_commerce,admin_support,admin_platform,admin_auth,admin_access",
      e2e_suites_json:
        '["marketplace_browse","marketplace_account","marketplace_checkout","marketplace_seller","catalog_admin_integrations","catalog_admin_modeling","admin_growth","admin_commerce","admin_support","admin_platform","admin_auth","admin_access"]',
      e2e_suite_batches_json:
        '["catalog_admin_integrations,admin_auth","catalog_admin_modeling,admin_platform","marketplace_checkout,admin_support","marketplace_browse,marketplace_account","admin_commerce,admin_access","marketplace_seller,admin_growth"]',
      build: "true",
      docker_image: "true",
      deploy: "true",
      compose_smoke: "true",
    },
  },
  {
    name: "empty changed-file list",
    changedFiles: [],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap([], { local_checks: "false" }),
  },
];

const dbTestsOldVersusNewCorpusCaseNames = [
  "scheduler-owned artifact scripts/run-workspaces.mjs",
  "scheduler-owned artifact scripts/run-workspaces.test.mjs",
  "scheduler-owned artifact scripts/workspace-test-duration-hints-v1.json",
  "scheduler-owned artifact scripts/fixtures/workspace-unit-duration-replay-v1.json",
  "documentation-only change",
  "workflow-only change",
  "change-scope classifier-only change",
  "this slice's own footprint",
  "db-test-preflight-only change",
  "unrelated bounded-context change",
  "root shared vitest config change",
  "DB-capable deployable script change",
  "empty changed-file list",
];

const dbTestsCorpusCaseKeys = [
  "name",
  "changedFiles",
  "baseDbTests",
  "expectedDbTests",
  "changesDbTests",
  "baseOutputMap",
];

// The changed-file set the dependent slice is predicted to touch, with the
// output map the unmodified classifier produced for it at the base commit.
const dependentSliceBaseCapture = {
  changedFiles: [
    "scripts/run-workspaces.mjs",
    "scripts/run-workspaces.test.mjs",
    "scripts/db-test-preflight.mjs",
    "scripts/db-test-preflight.test.mjs",
    ".github/workflows/platform-pr.yml",
  ],
  baseDbTests: "false",
  expectedDbTests: "true",
  baseOutputMap: {
    ...baseCapturedSchedulerFanoutOutputMap([
      ".github/workflows/platform-pr.yml",
      "scripts/db-test-preflight.mjs",
      "scripts/db-test-preflight.test.mjs",
      "scripts/run-workspaces.mjs",
      "scripts/run-workspaces.test.mjs",
    ]),
    workflow_lint: "true",
    cluster_preview: "true",
  },
};

const hostedDbAdmissionStatusForms = ["added", "modified", "removed", "renamed"];

const hostedDbAdmissionCorpusSeeds = [
  {
    name: "DB-only scheduler path",
    changedFiles: ["scripts/run-workspaces.mjs"],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: baseCapturedSchedulerFanoutWorkspaces,
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "non-DB issue-readiness path",
    changedFiles: ["scripts/issue-readiness.mjs"],
    eventName: "pull_request",
    expected: { db: false, e2e: false, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: [],
    deltaReason: null,
  },
  {
    name: "integration-risk context metadata path",
    changedFiles: ["bounded-contexts/pricing/context.json"],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: true, clusterPreview: false },
    expectedAffectedWorkspaces: [
      "@chase-sets/app-admin-web",
      "@chase-sets/app-marketplace-web",
      "@chase-sets/app-platform-api",
      "@chase-sets/app-platform-worker",
      "@chase-sets/app-public-web",
      "@chase-sets/discovery",
      "@chase-sets/marketplace-seed-testing",
      "@chase-sets/platform-runtime",
      "@chase-sets/pricing",
    ],
    deltaReason: null,
  },
  {
    name: "merge-group full-battery control",
    changedFiles: ["scripts/issue-readiness.mjs"],
    eventName: "merge_group",
    expected: { db: false, e2e: false, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: [],
    deltaReason: null,
  },
  {
    name: "DB-and-E2E overlap",
    changedFiles: ["bounded-contexts/catalog/routes/admin/integrations.tsx"],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: [
      "@chase-sets/app-admin-web",
      "@chase-sets/app-platform-api",
      "@chase-sets/app-platform-worker",
      "@chase-sets/catalog",
      "@chase-sets/discovery",
      "@chase-sets/inventory",
      "@chase-sets/marketplace-seed-testing",
    ],
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "DB-and-preview overlap",
    changedFiles: ["scripts/run-workspaces.mjs", "infrastructure/helm/platform/values.yaml"],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: false, clusterPreview: true },
    expectedAffectedWorkspaces: baseCapturedSchedulerFanoutWorkspaces,
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling seeding entry surface",
    siblingKind: "seeding",
    changedFiles: ["bounded-contexts/catalog/features/source-observations/api/seed.ts"],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling bootstrap entry surface",
    siblingKind: "bootstrap",
    changedFiles: ["deployables/platform-api/src/bootstrap.ts"],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling import entry surface",
    siblingKind: "import",
    changedFiles: [
      "bounded-contexts/catalog/features/source-observations/api/source-observation-provider-import-runtime.ts",
    ],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling reconciliation entry surface",
    siblingKind: "reconciliation",
    changedFiles: [
      "bounded-contexts/settlement/features/liability-reconciliation/read-model/liability-reconciliation.ts",
    ],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
];

const hostedDbAdmissionCorpus = hostedDbAdmissionCorpusSeeds.flatMap((seed) =>
  hostedDbAdmissionStatusForms.map((status) => ({ ...seed, status })),
);

const hostedDbConsumerInventory = [
  { name: "platform-pr/db-tests condition", changesAdmission: true },
  { name: "platform-pr/e2e-tests condition", changesAdmission: false },
  { name: "platform-pr/PR Required DB aggregation", changesAdmission: true },
  { name: "platform-pr/PR Required E2E aggregation", changesAdmission: false },
  { name: "platform-pr/preview-deploy-smoke admission", changesAdmission: true },
  { name: "scripts/release-deployment-scope.mjs", changesAdmission: false },
  { name: "scripts/release-qualification-scope.mjs", changesAdmission: false },
  { name: "scripts/verify-static-scoped.mjs", changesAdmission: false },
  { name: "scripts/verify-static-scoped.test.mjs", changesAdmission: false },
  { name: "scripts/public-web-route-smoke-workflows.test.mjs", changesAdmission: false },
  { name: "scripts/change-scope.test.mjs", changesAdmission: false },
  { name: "scripts/lib/risk-policy-v1.test.mjs", changesAdmission: false },
  { name: "scripts/digitalocean-platform-config.test.mjs", changesAdmission: false },
];

function hostedLaneFor({ eventName, integrationRiskRequired }) {
  const fullBatteryRequired = eventName === "merge_group";
  return {
    fullBatteryRequired,
    targetedHeavyRequired: fullBatteryRequired || integrationRiskRequired,
  };
}

function statusAwareRiskFiles({ changedFiles, status }) {
  return changedFiles.map((filename) =>
    status === "renamed" ? { filename, previousFilename: filename, status } : { filename, status },
  );
}

function priorHostedAdmission(scope, lane) {
  return {
    dbJobExecutes: lane.targetedHeavyRequired && scope.dbTestsRequired,
    dbRequiredByName: lane.targetedHeavyRequired && scope.dbTestsRequired,
    e2eJobExecutes: lane.targetedHeavyRequired && scope.e2eTestsRequired,
    e2eRequiredByName: lane.targetedHeavyRequired && scope.e2eTestsRequired,
    affectedWorkspaces: scope.affectedWorkspaces,
  };
}

function isolatedHostedDbAdmission(scope, lane) {
  return {
    dbJobExecutes: scope.dbTestsRequired,
    dbRequiredByName: scope.dbTestsRequired,
    e2eJobExecutes: lane.targetedHeavyRequired && scope.e2eTestsRequired,
    e2eRequiredByName: lane.targetedHeavyRequired && scope.e2eTestsRequired,
    affectedWorkspaces: scope.affectedWorkspaces,
  };
}

function workspaceWithScripts(baseDir, root, dirName, name, scripts) {
  return {
    name,
    dir: path.join(baseDir, root, dirName),
    dirName,
    root,
    packageJson: { name, dependencies: {}, scripts },
  };
}

function workspace(baseDir, root, dirName, name, dependencies = {}, chaseSets) {
  return {
    name,
    dir: path.join(baseDir, root, dirName),
    dirName,
    root,
    packageJson: {
      name,
      dependencies,
      chaseSets,
    },
  };
}

function batchDurationSeconds(batch) {
  return batch
    .split(",")
    .filter(Boolean)
    .reduce((total, suiteId) => total + estimatedE2eSuiteDurationSeconds(suiteId), 0);
}

describe("change-scope", () => {
  it("diffs changed files from the merge-base instead of the moving base branch tip", () => {
    const calls = [];
    const changedFiles = listChangedFiles("origin/main", "HEAD", {
      cwd: "/repo",
      execFileSync: (_command, args, options) => {
        calls.push({ args, cwd: options.cwd });
        if (args[0] === "merge-base") {
          return "abc123\n";
        }
        if (args[0] === "diff") {
          return "bounded-contexts/catalog/domain.ts\n";
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      },
    });

    expect(changedFiles).toEqual(["bounded-contexts/catalog/domain.ts"]);
    expect(calls).toEqual([
      { args: ["merge-base", "origin/main", "HEAD"], cwd: "/repo" },
      { args: ["diff", "--no-renames", "--name-only", "abc123...HEAD"], cwd: "/repo" },
    ]);
  });

  it("treats documentation-only changes as non-deployable", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["docs/runbooks/digitalocean-platform-deployment.md", "README.md"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.docsOnly).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.exposurePostureChanged).toBe(false);
    expect(scope.affectedWorkspaces).toEqual([]);
  });

  it("maps marketplace OpenAPI docs to platform-api parity coverage", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["docs/api/marketplace.openapi.json"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api"),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            scripts: { test: "vitest run" },
          },
        },
      ],
    });

    expect(scope.docsOnly).toBe(false);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
  });

  it("maps context metadata route changes to platform-runtime and OpenAPI parity coverage", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/inventory/context.json"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
        workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
          "@test/inventory": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/inventory", "@test/platform-runtime", "@test/app-platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
  });

  it("classifies every source-context wake registry shard exactly like the pre-split single file", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspaces = [
      workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
      workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
        "@test/platform-runtime": "workspace:*",
      }),
    ];
    // `changedFiles` is the echoed input, not a classification; every other
    // key must be identical for a shard and for the pre-split single file.
    const classify = (changedFile) => {
      const { changedFiles, ...classification } = classifyChanges({
        baseDir,
        changedFiles: [changedFile],
        workspaces,
      });
      return classification;
    };
    const aggregate = classify("infrastructure/platform-runtime/source-context-wake-registry.ts");

    // The pre-split baseline: the registry feeds platform-api contract
    // coverage, so it lands in both the directly affected and the test-only
    // sets. A shard that only matched the workspace directory would drop
    // @test/app-platform-api from both and silently stop running those tests.
    expect(aggregate.directlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
    expect(aggregate.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);

    for (const familyPath of [
      "infrastructure/platform-runtime/source-context-wake-registry/catalog.ts",
      "infrastructure/platform-runtime/source-context-wake-registry/commercial-terms.ts",
      "infrastructure/platform-runtime/source-context-wake-registry-entry.ts",
    ]) {
      expect(classify(familyPath), familyPath).toEqual(aggregate);
    }
  });

  it("classifies renamed and deleted wake registry shard paths as context metadata routes", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspaces = [
      workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
      workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
        "@test/platform-runtime": "workspace:*",
      }),
    ];

    // `listChangedFiles` reports renames and deletions as plain paths, so a
    // shard that is removed or moved must still route the platform-api
    // coverage its membership change invalidates.
    const renamed = classifyChanges({
      baseDir,
      workspaces,
      changedFiles: [
        "infrastructure/platform-runtime/source-context-wake-registry/catalog.ts",
        "infrastructure/platform-runtime/source-context-wake-registry/catalog-authoring.ts",
      ],
    });
    const deleted = classifyChanges({
      baseDir,
      workspaces,
      changedFiles: ["infrastructure/platform-runtime/source-context-wake-registry/notifications.ts"],
    });

    for (const scope of [renamed, deleted]) {
      expect(scope.directlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
      expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
    }
  });

  it("escalates pricing event-subscription metadata to targeted DB admission", () => {
    const scope = classifyChanges({
      changedFiles: ["bounded-contexts/pricing/context.json"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Bounded-context metadata, including event subscriptions, changed");
    expect(scope.dbTestsRequired).toBe(true);
    expect(toOutputMap(scope).integration_risk_required).toBe("true");
    expect(toOutputMap(scope).integration_risk_reason).toBe(scope.integrationRiskReason);
  });

  it("escalates cross-context runtime composition to targeted DB admission", () => {
    const scope = classifyChanges({
      changedFiles: ["infrastructure/bounded-context-runtime/subscriptions.ts"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Cross-context subscription or runtime composition changed");
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("escalates shared admin shell and router changes to affected admin E2E", () => {
    const scope = classifyChanges({
      changedFiles: ["deployables/admin-web/app/admin-root-shell.tsx"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Shared application shell or router changed");
    expect(scope.e2eSuiteIds).toEqual([
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("escalates design-system navigation changes to affected browser E2E", () => {
    const scope = classifyChanges({
      changedFiles: ["packages/design-system/src/components/actions/section-navigation.tsx"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Design-system navigation changed");
    expect(scope.e2eSuiteIds).toEqual([
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("keeps docs and ordinary single-slice changes on the fast lane", () => {
    const docsScope = classifyChanges({
      changedFiles: ["docs/runbooks/integration-risk.md"],
    });
    const sliceScope = classifyChanges({
      changedFiles: ["bounded-contexts/pricing/features/recommendations/domain/recommendation.ts"],
    });

    expect(docsScope.integrationRiskRequired).toBe(false);
    expect(docsScope.integrationRiskReason).toBe("No integration-risk change detected");
    expect(sliceScope.integrationRiskRequired).toBe(false);
    expect(sliceScope.integrationRiskReason).toBe("No integration-risk change detected");
  });

  it.each(lockedIntegrationParityCorpus)(
    "locks the pre-PR integration battery for %s %s",
    (status, filename, previousFilename) => {
      const priorReasons = priorProductionIntegrationReasons(filename);
      const change = {
        filename,
        status,
        ...(status === "renamed" ? { previousFilename } : {}),
      };
      const projected = classifyIntegrationRisk({ changedFiles: [change] });
      const scope = classifyChanges({ changedFiles: [filename] });

      expect(projected.reasons).toEqual(priorReasons);
      expect(projected.required).toBe(priorReasons.length > 0);
      expect(scope.integrationRiskRequired).toBe(priorReasons.length > 0);
      expect(scope.integrationRiskReason).toBe(
        priorReasons.length > 0 ? priorReasons.join("; ") : "No integration-risk change detected",
      );
    },
  );

  it("keeps the rename-out advisory delta explicit without widening the required battery", () => {
    const change = {
      filename: "archive/legacy-runtime.ts",
      previousFilename: "infrastructure/platform-runtime/legacy-runtime.ts",
      status: "renamed",
    };

    expect(classifyIntegrationRisk({ changedFiles: [change] })).toEqual({ required: false, reasons: [] });
    expect(classifyRisk({ changedFiles: [change] })).toMatchObject({
      classification: "high",
      categories: expect.arrayContaining(["cross-context-contract"]),
    });
  });

  it("keeps unrelated bounded-context changes from pulling platform-runtime into scope", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/inventory/features/import-batches/domain/import-batch.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
        workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
          "@test/inventory": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/inventory", "@test/app-platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual([]);
    expect(scope.affectedWorkspaces).not.toContain("@test/platform-runtime");
  });

  it("expands affected workspaces through workspace dependents", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["contracts/primitives/typed-ids.ts"],
      workspaces: [
        workspace(baseDir, "contracts", "primitives", "@test/primitives"),
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {
          "@test/primitives": "workspace:*",
        }),
        workspace(baseDir, "deployables", "public-web", "@test/public-web", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/primitives", "@test/catalog", "@test/public-web"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
    expect(scope.exposurePostureCategories).toEqual([]);
    // #4864: a pure app-code change (no Helm/Terraform/deploy-script/deploy-
    // workflow surface touched) still needs a docker image, but must not get
    // a chase-sets-pr-<n> cluster preview -- it gets the CI compose
    // boot+smoke job instead.
    expect(scope.dockerImageRequired).toBe(true);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(true);
  });

  it("reruns tests for dev-dependents of runtime changes without fanning out to their dependents", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/domain/catalog-item.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
        {
          ...workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
          packageJson: {
            name: "@test/inventory",
            dependencies: {},
            devDependencies: { "@test/catalog": "workspace:*" },
            scripts: { "test:db": "test:db" },
          },
        },
        workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace", {
          "@test/inventory": "workspace:*",
        }),
        workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog", "@test/inventory", "@test/platform-api"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual(["@test/catalog", "@test/platform-api"]);
    expect(scope.devDependencyTestAffectedWorkspaces).toEqual(["@test/inventory"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
  });

  it("keeps a catalog-internal domain edit inside the catalog runtime boundary", () => {
    const scope = classifyChanges({
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/domain/catalog-item.ts"],
    });

    expect(scope.affectedWorkspaces.length).toBeLessThanOrEqual(10);
    expect(scope.affectedWorkspaces).toContain("@chase-sets/catalog");
    for (const workspaceName of [
      "@chase-sets/checkout",
      "@chase-sets/payments",
      "@chase-sets/settlement",
      "@chase-sets/pricing",
      "@chase-sets/marketplace",
      "@chase-sets/ordering",
    ]) {
      expect(scope.affectedWorkspaces).not.toContain(workspaceName);
    }
    // Acceptance tests in inventory and discovery mount the catalog module, so
    // their tests rerun without dragging their own dependents along.
    expect(scope.devDependencyTestAffectedWorkspaces).toEqual(["@chase-sets/discovery", "@chase-sets/inventory"]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("fans a catalog-seed fixture edit out to every seed consumer", () => {
    const scope = classifyChanges({
      changedFiles: ["contracts/catalog-seed/ids.ts"],
    });

    for (const workspaceName of [
      "@chase-sets/catalog",
      "@chase-sets/catalog-seed",
      "@chase-sets/checkout",
      "@chase-sets/inventory",
      "@chase-sets/marketplace",
      "@chase-sets/marketplace-seed-testing",
      "@chase-sets/ordering",
    ]) {
      expect(scope.affectedWorkspaces).toContain(workspaceName);
    }
  });

  it("detects DB tests only when an affected workspace publishes a DB test script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const fastScope = classifyChanges({
      baseDir,
      changedFiles: ["packages/design-system/button.tsx"],
      workspaces: [
        workspace(baseDir, "packages", "design-system", "@test/design-system"),
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(fastScope.dbTestsRequired).toBe(false);

    const dbScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/src/main.ts"],
      workspaces: [
        workspace(baseDir, "packages", "design-system", "@test/design-system"),
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(dbScope.dbTestsRequired).toBe(true);
  });

  it("keeps DB-backed context test-only changes scoped to the owning workspace", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/tests/catalog-authoring/acceptance/admin-page-projections.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/catalog",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit": "test:unit",
              "test:db": "vitest run tests/catalog-authoring/acceptance/admin-page-projections.test.ts",
            },
          },
        },
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("routes a test-only change enrolled only in a non-default DB partition", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/__tests__/partition-two.db.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit":
                "vitest run --exclude __tests__/partition-one.db.test.ts --exclude __tests__/partition-two.db.test.ts",
              "test:db:1": "vitest run __tests__/partition-one.db.test.ts",
              "test:db:2": "vitest run __tests__/partition-two.db.test.ts",
            },
          },
        },
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("requires DB tests only for affected workspaces that publish a DB test script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/__tests__/config.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { test: "test", "test:unit": "test:unit" },
          },
        },
      ],
    });

    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(false);
  });

  it("narrows E2E requirements to marketplace-facing user journey surfaces", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const domainScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/ordering/features/orders/domain/domain.ts"],
      workspaces: [workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering")],
    });

    expect(domainScope.unitTestsRequired).toBe(true);
    expect(domainScope.e2eTestsRequired).toBe(false);
    expect(domainScope.e2eSuiteIds).toEqual([]);

    const routeScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/marketplace/routes/account-listing.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace")],
    });

    expect(routeScope.e2eTestsRequired).toBe(true);
    expect(routeScope.e2eSuiteIds).toEqual(["marketplace_account", "marketplace_seller"]);

    const deployableTestScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/account-listing.test.tsx"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableTestScope.e2eTestsRequired).toBe(false);
    expect(deployableTestScope.e2eSuiteIds).toEqual([]);

    const deployableTestSupportScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/test-support/http.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web"),
          packageJson: {
            name: "@test/marketplace-web",
            dependencies: {},
            scripts: { test: "vitest run" },
          },
        },
      ],
    });

    expect(deployableTestSupportScope.affectedWorkspaces).toEqual(["@test/marketplace-web"]);
    expect(deployableTestSupportScope.runtimeAffectedWorkspaces).toEqual([]);
    expect(deployableTestSupportScope.unitTestsRequired).toBe(true);
    expect(deployableTestSupportScope.buildRequired).toBe(false);
    expect(deployableTestSupportScope.dockerImageRequired).toBe(false);
    expect(deployableTestSupportScope.e2eTestsRequired).toBe(false);
    expect(deployableTestSupportScope.e2eSuiteIds).toEqual([]);

    const deployableRouteScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/account-listing.tsx"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableRouteScope.e2eTestsRequired).toBe(true);
    expect(deployableRouteScope.e2eSuiteIds).toEqual(["marketplace_seller"]);

    const deployableUtilityScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/manifest.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableUtilityScope.e2eTestsRequired).toBe(false);
    expect(deployableUtilityScope.e2eSuiteIds).toEqual([]);

    const deployableSpecScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/e2e/item-detail.spec.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableSpecScope.runtimeAffectedWorkspaces).toEqual([]);
    expect(deployableSpecScope.unitTestsRequired).toBe(true);
    expect(deployableSpecScope.buildRequired).toBe(false);
    expect(deployableSpecScope.e2eTestsRequired).toBe(true);
    expect(deployableSpecScope.e2eSuiteIds).toEqual(["marketplace_browse"]);
  });

  it("routes root browser runtime changes to browser E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["package.json", "pnpm-lock.yaml"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("keeps test typecheck configuration changes out of runtime fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["tsconfig.tests.json", "test-env.d.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(false);
    expect(scope.buildRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("re-runs every workspace's tests for root vitest configuration changes without runtime fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["vitest.shared.mjs"],
      workspaces: [
        workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web"),
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
      ],
    });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(["@test/marketplace-web", "@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.buildRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it.each(schedulerOwnedArtifacts)(
    "re-runs every workspace's unit tests for scheduler artifact %s without unrelated gate fanout",
    (schedulerOwnedArtifact) => {
      const currentWorkspaceNames = listWorkspacePackages({ repoRoot }).map((entry) => entry.name);
      const scope = classifyChanges({ changedFiles: [schedulerOwnedArtifact] });

      expect(scope.affectedWorkspaces).toEqual(currentWorkspaceNames);
      expect(scope.unitTestsRequired).toBe(true);
      expect(scope).toMatchObject({
        runtimeAffectedWorkspaces: [],
        devDependencyTestAffectedWorkspaces: [],
        directlyAffectedWorkspaces: [],
        directlyRuntimeAffectedWorkspaces: [],
        directlyTestOnlyAffectedWorkspaces: [],
        dbTestsRequired: true,
        e2eSuiteIds: [],
        e2eTestsRequired: false,
        integrationRiskRequired: false,
        buildRequired: false,
        dockerImageRequired: false,
        terraformRequired: false,
        workflowLintRequired: false,
        deployRequired: false,
        clusterPreviewRequired: false,
        composeSmokeRequired: false,
        exposurePostureChanged: false,
        exposurePostureCategories: [],
      });
    },
  );

  it.each(schedulerOwnedArtifacts)(
    "requires DB profile tests for scheduler-owned artifact %s and preserves its base fan-out",
    (schedulerOwnedArtifact) => {
      const scope = classifyChanges({ changedFiles: [schedulerOwnedArtifact] });
      const outputs = toOutputMap(scope);

      expect(scope.dbTestsRequired).toBe(true);
      expect(outputs.db_tests).toBe("true");

      // The fan-out is the reason the DB job has work to do, so it is asserted
      // for membership and order against the base capture, not merely for
      // length or for containing the DB-capable deployable.
      expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
      expect(scope.affectedWorkspaces).toEqual(listWorkspacePackages({ repoRoot }).map((entry) => entry.name));
      expect(scope.affectedWorkspaces).toHaveLength(baseCapturedSchedulerFanoutWorkspaces.length);
      expect(scope.affectedWorkspaces).toContain("@chase-sets/app-platform-api");
      expect(outputs.affected_workspaces).toBe(baseCapturedAllWorkspacesCsv);
      expect(outputs.affected_workspaces_json).toBe(baseCapturedAllWorkspacesJson);
    },
  );

  it("keeps the scheduler-owned artifact set at exactly its four frozen members", () => {
    expect(schedulerOwnedArtifacts).toEqual([
      "scripts/run-workspaces.mjs",
      "scripts/run-workspaces.test.mjs",
      "scripts/workspace-test-duration-hints-v1.json",
      "scripts/fixtures/workspace-unit-duration-replay-v1.json",
    ]);

    // Membership is proven behaviourally in both directions: every member fans
    // out to every workspace and requires DB tests, and no near-miss path does.
    for (const member of schedulerOwnedArtifacts) {
      const scope = classifyChanges({ changedFiles: [member] });
      expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
      expect(scope.dbTestsRequired).toBe(true);
    }

    for (const nonMember of [
      ...schedulerVocabularyLookalikePaths,
      "scripts/change-scope.mjs",
      "scripts/db-test-preflight.mjs",
    ]) {
      const scope = classifyChanges({ changedFiles: [nonMember] });
      expect(scope.affectedWorkspaces).toEqual([]);
      expect(scope.dbTestsRequired).toBe(false);
    }
  });

  it.each(schedulerVocabularyLookalikePaths)(
    "leaves scheduler-vocabulary lookalike %s classified as an ordinary script change",
    (lookalikePath) => {
      const scope = classifyChanges({ changedFiles: [lookalikePath] });
      const outputs = toOutputMap(scope);

      expect(scope.dbTestsRequired).toBe(false);
      expect(outputs.db_tests).toBe("false");
      expect(scope.affectedWorkspaces).toEqual([]);
      expect(outputs).toEqual(baseCapturedNoWorkspaceOutputMap([lookalikePath]));
    },
  );

  it("closes the old-versus-new db_tests corpus over its enumerated cases", () => {
    expect(dbTestsOldVersusNewCorpus.map((testCase) => testCase.name)).toEqual(dbTestsOldVersusNewCorpusCaseNames);
    expect(new Set(dbTestsOldVersusNewCorpusCaseNames).size).toBe(dbTestsOldVersusNewCorpusCaseNames.length);

    for (const testCase of dbTestsOldVersusNewCorpus) {
      expect(Object.keys(testCase).sort()).toEqual([...dbTestsCorpusCaseKeys].sort());
      expect(Array.isArray(testCase.changedFiles)).toBe(true);
      expect(["true", "false"]).toContain(testCase.baseDbTests);
      expect(["true", "false"]).toContain(testCase.expectedDbTests);
      expect(testCase.changesDbTests).toBe(testCase.baseDbTests !== testCase.expectedDbTests);
      expect(Object.keys(testCase.baseOutputMap)).toEqual(baseCapturedOutputMapKeyOrder);
      expect(testCase.baseOutputMap.db_tests).toBe(testCase.baseDbTests);
    }
  });

  it("changes db_tests for exactly the scheduler-owned artifact cases across the whole corpus", () => {
    const observed = dbTestsOldVersusNewCorpus.map((testCase) => ({
      name: testCase.name,
      changedFiles: testCase.changedFiles,
      previous: testCase.baseDbTests,
      next: toOutputMap(classifyChanges({ changedFiles: testCase.changedFiles })).db_tests,
    }));

    for (const [index, entry] of observed.entries()) {
      expect(entry.next).toBe(dbTestsOldVersusNewCorpus[index].expectedDbTests);
    }

    const changedCaseFileSets = observed
      .filter((entry) => entry.previous !== entry.next)
      .map((entry) => entry.changedFiles);

    // Set equality, not containment: a predicate that also flipped an unrelated
    // case would pass a containment check and must fail here.
    expect(changedCaseFileSets).toEqual(schedulerOwnedArtifacts.map((artifact) => [artifact]));
  });

  it("keeps every output except db_tests byte-identical to the base commit for every corpus case", () => {
    for (const testCase of dbTestsOldVersusNewCorpus) {
      const scope = classifyChanges({ changedFiles: testCase.changedFiles });
      const outputs = toOutputMap(scope);

      expect(Object.keys(outputs)).toEqual(baseCapturedOutputMapKeyOrder);
      expect(outputs.db_tests).toBe(testCase.expectedDbTests);
      expect({ ...outputs, db_tests: testCase.baseDbTests }).toEqual(testCase.baseOutputMap);
      expect(String(scope.dbTestsRequired)).toBe(testCase.expectedDbTests);
    }
  });

  it("requires DB profile tests for the dependent slice's predicted changed-file set", () => {
    const scope = classifyChanges({ changedFiles: dependentSliceBaseCapture.changedFiles });
    const outputs = toOutputMap(scope);

    expect(dependentSliceBaseCapture.baseDbTests).toBe("false");
    expect(outputs.db_tests).toBe("true");
    expect(outputs.db_tests).toBe(dependentSliceBaseCapture.expectedDbTests);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
    expect({ ...outputs, db_tests: dependentSliceBaseCapture.baseDbTests }).toEqual(
      dependentSliceBaseCapture.baseOutputMap,
    );
  });

  it("still reports no DB tests for a scheduler-owned change when no workspace exposes a DB script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspacesWithoutDbScripts = [
      workspaceWithScripts(baseDir, "packages", "design-system", "@test/design-system", { test: "test" }),
      workspaceWithScripts(baseDir, "deployables", "platform-api", "@test/platform-api", {
        test: "test",
        "test:unit": "test:unit",
      }),
    ];

    for (const schedulerOwnedArtifact of schedulerOwnedArtifacts) {
      const scope = classifyChanges({
        baseDir,
        changedFiles: [schedulerOwnedArtifact],
        workspaces: workspacesWithoutDbScripts,
      });

      // The fan-out still names every workspace; only the DB requirement is
      // withheld, because there is no DB execution unit to run.
      expect(scope.affectedWorkspaces).toEqual(["@test/design-system", "@test/platform-api"]);
      expect(scope.unitTestsRequired).toBe(true);
      expect(scope.dbTestsRequired).toBe(false);
      expect(toOutputMap(scope).db_tests).toBe("false");
    }
  });

  it("requires DB tests for a scheduler-owned change as soon as one injected workspace exposes a DB script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspacesWithOneDbScript = [
      workspaceWithScripts(baseDir, "packages", "design-system", "@test/design-system", { test: "test" }),
      workspaceWithScripts(baseDir, "deployables", "platform-api", "@test/platform-api", {
        "test:unit": "test:unit",
        "test:db:1": "vitest run __tests__/partition-one.db.test.ts",
      }),
    ];

    for (const schedulerOwnedArtifact of schedulerOwnedArtifacts) {
      const scope = classifyChanges({
        baseDir,
        changedFiles: [schedulerOwnedArtifact],
        workspaces: workspacesWithOneDbScript,
      });

      expect(scope.affectedWorkspaces).toEqual(["@test/design-system", "@test/platform-api"]);
      expect(scope.dbTestsRequired).toBe(true);
      expect(toOutputMap(scope).db_tests).toBe("true");
    }
  });

  // A rename away from a frozen scheduler-owned path is the one Git status form
  // `git diff --name-only` does not report faithfully: rename detection collapses
  // the pair to its destination, so the frozen source path never reaches the
  // classifier and the DB profile job it owns is silently unselected. These cases
  // drive real Git objects through the production
  // `listChangedFiles -> classifyChanges -> toOutputMap` chain, and each carries
  // the rename-detected name list alongside as a control, so dropping
  // `--no-renames` from the production diff fails them.
  describe("scheduler-owned artifacts renamed away from their frozen paths", () => {
    const renameAwayCases = schedulerOwnedArtifacts.map((sourcePath, index) => ({
      index,
      sourcePath,
      destinationPath: `archive/${path.posix.basename(sourcePath)}`,
    }));
    let fixtureRoot;
    let fixtureCommits;

    // `diff.renames` is pinned on rather than inherited so the control below
    // observes Git's own default rename detection on any host.
    function fixtureGit(args) {
      return execFileSync(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "diff.renames=true",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: fixtureRoot, encoding: "utf8", windowsHide: true },
      );
    }

    beforeAll(() => {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), "change-scope-rename-away-"));
      fixtureGit(["init", "--quiet", "--initial-branch=main"]);
      for (const { sourcePath } of renameAwayCases) {
        const target = path.join(fixtureRoot, sourcePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `scheduler-owned fixture body for ${sourcePath}\n`, "utf8");
      }
      mkdirSync(path.join(fixtureRoot, "archive"), { recursive: true });
      fixtureGit(["add", "--all"]);
      fixtureGit(["commit", "--quiet", "-m", "seed scheduler-owned artifacts"]);

      // One commit per case, each renaming exactly one artifact away. Case i is
      // then the diff from commit i to commit i+1, so every case observes a
      // single rename with no checkout churn between them.
      for (const { sourcePath, destinationPath } of renameAwayCases) {
        fixtureGit(["mv", sourcePath, destinationPath]);
        fixtureGit(["commit", "--quiet", "-m", `rename ${sourcePath} away`]);
      }
      fixtureCommits = fixtureGit(["log", "--format=%H", "--reverse"]).trim().split(/\r?\n/);
    });

    afterAll(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it("covers every frozen scheduler-owned artifact with its own rename-away commit", () => {
      expect(renameAwayCases.map((entry) => entry.sourcePath)).toEqual(schedulerOwnedArtifacts);
      expect(fixtureCommits).toHaveLength(schedulerOwnedArtifacts.length + 1);
      expect(new Set(fixtureCommits).size).toBe(fixtureCommits.length);
    });

    it.each(renameAwayCases)(
      "requires DB tests when $sourcePath is renamed away to $destinationPath",
      ({ index, sourcePath, destinationPath }) => {
        const base = fixtureCommits[index];
        const head = fixtureCommits[index + 1];

        // Control: Git really does record this as a 100%-similarity rename, and
        // the rename-detected name list names only the destination. That list is
        // exactly what the production diff would return without `--no-renames`,
        // and it does not contain the frozen path.
        expect(fixtureGit(["diff", "--name-status", `${base}...${head}`]).trim()).toBe(
          `R100\t${sourcePath}\t${destinationPath}`,
        );
        expect(
          fixtureGit(["diff", "--name-only", `${base}...${head}`])
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ).toEqual([destinationPath]);

        // Production path: real Git objects through the exported `listChangedFiles`.
        const changedFiles = listChangedFiles(base, head, { cwd: fixtureRoot });
        expect([...changedFiles].sort()).toEqual([destinationPath, sourcePath].sort());

        const scope = classifyChanges({ changedFiles });
        const outputs = toOutputMap(scope);

        expect(scope.changedFiles).toEqual([destinationPath, sourcePath].sort());
        expect(scope.dbTestsRequired).toBe(true);
        expect(outputs.db_tests).toBe("true");

        // Nothing else moves: the same whole-repo fan-out a scheduler-owned
        // change already produced, and every other output key byte-identical to
        // the base-commit capture for that fan-out.
        expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
        expect(scope.affectedWorkspaces).toContain("@chase-sets/app-platform-api");
        expect(outputs).toEqual({
          ...baseCapturedSchedulerFanoutOutputMap(scope.changedFiles),
          db_tests: "true",
        });

        // Discriminator: the destination path alone carries none of this, so the
        // frozen source path recovered by `--no-renames` is what selects the job.
        const destinationOnly = classifyChanges({ changedFiles: [destinationPath] });
        expect(destinationOnly.dbTestsRequired).toBe(false);
        expect(toOutputMap(destinationOnly).db_tests).toBe("false");
        expect(destinationOnly.affectedWorkspaces).toEqual([]);
      },
    );
  });

  it("locks the hosted DB old-versus-new admission corpus over real paths and every status form", () => {
    expect(hostedDbAdmissionCorpus).toHaveLength(
      hostedDbAdmissionCorpusSeeds.length * hostedDbAdmissionStatusForms.length,
    );
    expect(new Set(hostedDbAdmissionCorpus.map(({ name, status }) => `${name}:${status}`)).size).toBe(
      hostedDbAdmissionCorpus.length,
    );

    for (const seed of hostedDbAdmissionCorpusSeeds) {
      expect(hostedDbAdmissionCorpus.filter((entry) => entry.name === seed.name).map((entry) => entry.status)).toEqual(
        hostedDbAdmissionStatusForms,
      );
      for (const filename of seed.changedFiles) {
        expect(
          existsSync(path.join(repoRoot, filename)),
          `${seed.name} must use the real repository path ${filename}`,
        ).toBe(true);
      }
    }

    for (const testCase of hostedDbAdmissionCorpus) {
      const scope = classifyChanges({ changedFiles: testCase.changedFiles });
      const statusAwareIntegrationRisk = classifyIntegrationRisk({
        changedFiles: statusAwareRiskFiles(testCase),
      });
      const lane = hostedLaneFor({
        eventName: testCase.eventName,
        integrationRiskRequired: statusAwareIntegrationRisk.required,
      });
      const prior = priorHostedAdmission(scope, lane);
      const next = isolatedHostedDbAdmission(scope, lane);
      const changesAdmission =
        prior.dbJobExecutes !== next.dbJobExecutes || prior.dbRequiredByName !== next.dbRequiredByName;

      expect(scope.dbTestsRequired, `${testCase.name}:${testCase.status} db_tests`).toBe(testCase.expected.db);
      expect(scope.e2eTestsRequired, `${testCase.name}:${testCase.status} e2e_tests`).toBe(testCase.expected.e2e);
      expect(scope.integrationRiskRequired, `${testCase.name}:${testCase.status} integration risk`).toBe(
        testCase.expected.integrationRisk,
      );
      expect(statusAwareIntegrationRisk.required, `${testCase.name}:${testCase.status} status-aware risk`).toBe(
        testCase.expected.integrationRisk,
      );
      expect(scope.clusterPreviewRequired, `${testCase.name}:${testCase.status} preview`).toBe(
        testCase.expected.clusterPreview,
      );
      expect(lane.fullBatteryRequired, `${testCase.name}:${testCase.status} full battery`).toBe(
        testCase.eventName === "merge_group",
      );
      expect(Boolean(testCase.deltaReason), `${testCase.name}:${testCase.status} named delta reason`).toBe(
        changesAdmission,
      );
      expect(next.e2eJobExecutes).toBe(prior.e2eJobExecutes);
      expect(next.e2eRequiredByName).toBe(prior.e2eRequiredByName);
      expect(next.affectedWorkspaces).toEqual(prior.affectedWorkspaces);
      if (testCase.expectedAffectedWorkspaces) {
        expect(next.affectedWorkspaces, `${testCase.name}:${testCase.status} affected_workspaces`).toEqual(
          testCase.expectedAffectedWorkspaces,
        );
      }

      if (testCase.name === "DB-and-E2E overlap") {
        expect(next).toMatchObject({
          dbJobExecutes: true,
          dbRequiredByName: true,
          e2eJobExecutes: false,
          e2eRequiredByName: false,
        });
      }
    }
  });

  it("makes every sibling seed-path and shared-targeted-lane mutant bite the locked corpus", () => {
    const siblingMutantTable = hostedDbAdmissionCorpusSeeds
      .filter((entry) => entry.siblingKind)
      .map((entry) => {
        const scope = classifyChanges({ changedFiles: entry.changedFiles });
        const lane = hostedLaneFor({
          eventName: entry.eventName,
          integrationRiskRequired: scope.integrationRiskRequired,
        });
        const baseline = isolatedHostedDbAdmission(scope, lane);
        const mutant = isolatedHostedDbAdmission({ ...scope, dbTestsRequired: false }, lane);
        return {
          mutant: `omit-${entry.siblingKind}-from-db-scope`,
          path: entry.changedFiles[0],
          baselineExecutes: baseline.dbJobExecutes,
          mutantExecutes: mutant.dbJobExecutes,
          killed: baseline.dbJobExecutes && !mutant.dbJobExecutes,
        };
      });

    expect(siblingMutantTable.length).toBeGreaterThan(0);
    expect(siblingMutantTable.map((entry) => entry.mutant)).toEqual([
      "omit-seeding-from-db-scope",
      "omit-bootstrap-from-db-scope",
      "omit-import-from-db-scope",
      "omit-reconciliation-from-db-scope",
    ]);
    expect(siblingMutantTable.every((entry) => entry.killed)).toBe(true);

    const overlap = hostedDbAdmissionCorpusSeeds.find((entry) => entry.name === "DB-and-E2E overlap");
    const overlapScope = classifyChanges({ changedFiles: overlap.changedFiles });
    const overlapLane = hostedLaneFor({
      eventName: overlap.eventName,
      integrationRiskRequired: overlapScope.integrationRiskRequired,
    });
    const isolated = isolatedHostedDbAdmission(overlapScope, overlapLane);
    const sharedPredicateMutant = priorHostedAdmission(overlapScope, {
      ...overlapLane,
      targetedHeavyRequired: true,
    });
    const sharedPredicateMutantRow = {
      mutant: "raise-shared-targeted-heavy-required",
      isolatedDbExecutes: isolated.dbJobExecutes,
      isolatedE2eExecutes: isolated.e2eJobExecutes,
      mutantDbExecutes: sharedPredicateMutant.dbJobExecutes,
      mutantE2eExecutes: sharedPredicateMutant.e2eJobExecutes,
      killed: isolated.dbJobExecutes && !isolated.e2eJobExecutes && sharedPredicateMutant.e2eJobExecutes,
    };

    expect(sharedPredicateMutantRow.killed).toBe(true);
    console.info("hosted-db sibling mutant table", siblingMutantTable);
    console.info("hosted-db shared-predicate mutant", sharedPredicateMutantRow);
  });

  it("enumerates all thirteen classifier and workflow consumers with exactly three moving admissions", () => {
    expect(hostedDbConsumerInventory.map((entry) => entry.name)).toEqual([
      "platform-pr/db-tests condition",
      "platform-pr/e2e-tests condition",
      "platform-pr/PR Required DB aggregation",
      "platform-pr/PR Required E2E aggregation",
      "platform-pr/preview-deploy-smoke admission",
      "scripts/release-deployment-scope.mjs",
      "scripts/release-qualification-scope.mjs",
      "scripts/verify-static-scoped.mjs",
      "scripts/verify-static-scoped.test.mjs",
      "scripts/public-web-route-smoke-workflows.test.mjs",
      "scripts/change-scope.test.mjs",
      "scripts/lib/risk-policy-v1.test.mjs",
      "scripts/digitalocean-platform-config.test.mjs",
    ]);
    expect(hostedDbConsumerInventory).toHaveLength(13);
    expect(hostedDbConsumerInventory.filter((entry) => entry.changesAdmission).map((entry) => entry.name)).toEqual([
      "platform-pr/db-tests condition",
      "platform-pr/PR Required DB aggregation",
      "platform-pr/preview-deploy-smoke admission",
    ]);

    const frozenSourceConsumers = [
      [
        "scripts/release-deployment-scope.mjs",
        'import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";',
      ],
      ["scripts/release-qualification-scope.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      ["scripts/verify-static-scoped.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      ["scripts/verify-static-scoped.test.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      ["scripts/public-web-route-smoke-workflows.test.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      [
        "scripts/change-scope.test.mjs",
        'import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";',
      ],
      ["scripts/lib/risk-policy-v1.test.mjs", "expect(changeScope).toContain('from \"./lib/risk-policy-v1.mjs\"');"],
      [
        "scripts/digitalocean-platform-config.test.mjs",
        'const platformPrWorkflow = readFileSync(resolve(".github/workflows/platform-pr.yml"), "utf8");',
      ],
    ];

    for (const [filename, frozenFragment] of frozenSourceConsumers) {
      expect(readFileSync(path.join(repoRoot, filename), "utf8"), filename).toContain(frozenFragment);
    }
  });

  it("keeps unrelated scripts-only changes out of workspace and gate fanout", () => {
    const scope = classifyChanges({ changedFiles: ["scripts/unrelated-maintenance.mjs"] });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(false);
    expect(scope.affectedWorkspaces).toEqual([]);
    expect(scope).toMatchObject({
      runtimeAffectedWorkspaces: [],
      devDependencyTestAffectedWorkspaces: [],
      directlyAffectedWorkspaces: [],
      directlyRuntimeAffectedWorkspaces: [],
      directlyTestOnlyAffectedWorkspaces: [],
      dbTestsRequired: false,
      e2eSuiteIds: [],
      e2eTestsRequired: false,
      integrationRiskRequired: false,
      buildRequired: false,
      dockerImageRequired: false,
      terraformRequired: false,
      workflowLintRequired: false,
      deployRequired: false,
      clusterPreviewRequired: false,
      composeSmokeRequired: false,
      exposurePostureChanged: false,
      exposurePostureCategories: [],
    });
  });

  it("requires deployment for the isolated Kubernetes deployment helper and test pair", () => {
    const scope = classifyChanges({
      changedFiles: ["scripts/platform-kubernetes-deployment.mjs", "scripts/platform-kubernetes-deployment.test.mjs"],
    });

    expect(scope).toMatchObject({
      deployRequired: true,
      clusterPreviewRequired: true,
      dockerImageRequired: false,
      buildRequired: false,
    });
  });

  it("requires deployment for the exact production stale Helm recovery workflow", () => {
    const scope = classifyChanges({
      changedFiles: [".github/workflows/platform-production-stale-helm-recovery.yml"],
    });

    expect(scope).toMatchObject({
      deployRequired: true,
      clusterPreviewRequired: true,
      dockerImageRequired: false,
      buildRequired: false,
    });
    expect(
      classifyChanges({ changedFiles: [".github/workflows/synthetic-unrelated-advisory.yml"] }).deployRequired,
    ).toBe(false);
  });

  it("does not require deployment for an unrelated scripts path", () => {
    expect(classifyChanges({ changedFiles: ["scripts/synthetic-unrelated-maintenance.mjs"] }).deployRequired).toBe(
      false,
    );
  });

  it("does not expand bounded-context unit test changes to runtime dependents or E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.test.tsx"],
      workspaces: [
        {
          ...workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/catalog",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit": "test:unit",
              "test:db": "vitest run tests/catalog-authoring/acceptance/admin-page-projections.test.ts",
            },
          },
        },
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(false);
    expect(scope.buildRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("emits duration-balanced suite batches for E2E matrix fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["package.json"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });
    const suiteBatches = JSON.parse(toOutputMap(scope).e2e_suite_batches_json);
    const oldStaticBatches = [
      "marketplace_browse,marketplace_account",
      "marketplace_checkout,marketplace_seller",
      "catalog_admin_integrations,catalog_admin_modeling",
      "admin_growth,admin_commerce",
      "admin_support,admin_platform",
      "admin_auth,admin_access",
    ];
    const batchMeanSeconds =
      suiteBatches.reduce((total, batch) => total + batchDurationSeconds(batch), 0) / suiteBatches.length;
    const longestBatchDistanceFromMean = (batches) => Math.max(...batches.map(batchDurationSeconds)) - batchMeanSeconds;

    expect(suiteBatches).toEqual([
      "catalog_admin_integrations,admin_auth",
      "catalog_admin_modeling,admin_platform",
      "marketplace_checkout,admin_support",
      "marketplace_browse,marketplace_account",
      "admin_commerce,admin_access",
      "marketplace_seller,admin_growth",
    ]);
    expect(suiteBatches.flatMap((batch) => batch.split(",")).sort()).toEqual([...scope.e2eSuiteIds].sort());
    expect(new Set(suiteBatches.flatMap((batch) => batch.split(","))).size).toBe(scope.e2eSuiteIds.length);
    expect(longestBatchDistanceFromMean(suiteBatches)).toBeLessThan(longestBatchDistanceFromMean(oldStaticBatches) / 2);
    expect(toOutputMap(scope)).not.toHaveProperty("coverage_fast");
    expect(toOutputMap(scope)).not.toHaveProperty("coverage_summary");
    expect(toOutputMap(scope).exposure_posture_changed).toBe("false");
  });

  it("routes context UI and API slices to owned E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/discovery/features/search/ui/search-page.tsx",
        "bounded-contexts/checkout/features/cart/api/cart-routes.ts",
        "bounded-contexts/inventory/features/inventory/ui/account-inventory.tsx",
        "bounded-contexts/ordering/features/postage-policies/ui/postage-policy-detail-drawer.tsx",
        "bounded-contexts/identity/features/invitations/ui/invitation-detail-page.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery"),
        workspace(baseDir, "bounded-contexts", "checkout", "@test/checkout"),
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering"),
        workspace(baseDir, "bounded-contexts", "identity", "@test/identity"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
      "marketplace_browse",
      "marketplace_checkout",
      "marketplace_seller",
      "admin_commerce",
      "admin_access",
    ]);
  });

  it("routes catalog admin integration routes to admin E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/catalog/routes/admin/integrations.tsx",
        "deployables/admin-web/app/routes/catalog-layout.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
        workspace(baseDir, "deployables", "admin-web", "@test/admin-web"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("routes catalog admin modeling routes to modeling E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/catalog/routes/admin/dimensions.tsx",
        "bounded-contexts/catalog/features/dimensions/ui/dimension-list-page.tsx",
      ],
      workspaces: [workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["catalog_admin_modeling"]);
  });

  it("routes support platform feedback admin routes to admin support E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/platform-operations/routes/admin/platform-feedback.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["admin_support"]);
  });

  it("routes platform projection operations admin routes to admin platform E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/platform-operations/routes/admin/projection-operations.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["admin_platform"]);
  });

  it("routes bounded-context marketplace and admin routes by owned journey", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const marketplaceAccountScope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/identity/routes/marketplace/account.tsx",
        "bounded-contexts/support/routes/marketplace/account-support.tsx",
        "bounded-contexts/marketplace/routes/marketplace/account-written-reviews.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "identity", "@test/identity"),
        workspace(baseDir, "bounded-contexts", "support", "@test/support"),
        workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace"),
      ],
    });

    expect(marketplaceAccountScope.e2eTestsRequired).toBe(true);
    expect(marketplaceAccountScope.e2eSuiteIds).toEqual(["marketplace_account"]);

    const adminScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/identity/routes/admin/users.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "identity", "@test/identity")],
    });

    expect(adminScope.e2eTestsRequired).toBe(true);
    expect(adminScope.e2eSuiteIds).toEqual(["admin_access"]);
  });

  it("routes milestone-25 decomposed routes to their owning E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/discovery/routes/item-detail.tsx",
        "bounded-contexts/checkout/routes/sell-checkout-session.tsx",
        "bounded-contexts/payments/routes/marketplace/account-payment.tsx",
        "bounded-contexts/payments/routes/marketplace/checkout-payment.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery"),
        workspace(baseDir, "bounded-contexts", "checkout", "@test/checkout"),
        workspace(baseDir, "bounded-contexts", "payments", "@test/payments"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["marketplace_browse", "marketplace_checkout"]);
  });

  it("routes context changes to the consolidated marketplace seed DB acceptance suite", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/ordering/features/orders/domain/order.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering"),
        {
          ...workspace(baseDir, "deployables", "marketplace-seed-testing", "@test/marketplace-seed-testing", {
            "@test/ordering": "workspace:*",
          }),
          packageJson: {
            name: "@test/marketplace-seed-testing",
            dependencies: {
              "@test/ordering": "workspace:*",
            },
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/ordering", "@test/marketplace-seed-testing"]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("keeps workflow-only changes out of deployment but scopes platform-*.yml to a cluster preview", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [".github/workflows/platform-pr.yml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    // #4864: a deploy-pipeline workflow file is a deploy surface even though
    // it never touches app code, so it still earns the real cluster preview
    // (this is also why this issue's own PR self-tests the new rule).
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("keeps non-platform workflow changes off the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [".github/workflows/review-cadence-digest.yml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("treats Terraform and deployment helper changes as deployable infrastructure needing a cluster preview", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/digitalocean/platform/main.tf", "scripts/render-platform-helm-values.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.terraformRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("keeps DOKS-only Terraform changes on the plan-only lane, off the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/digitalocean/doks/main.tf"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.terraformRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes Helm chart changes through ordinary staged deployment without a docker image", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/helm/platform/templates/deployment.yaml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.deployRequired).toBe(true);
    expect(scope.dockerImageRequired).toBe(false);
    // #4864: Helm changes are a deploy surface in their own right, even
    // without a docker image, because they alter what the cluster preview
    // (and staging/production) actually deploys.
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);

    const docsScope = classifyChanges({
      baseDir,
      changedFiles: ["docs/runbooks/digitalocean-platform-deployment.md"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });
    expect(docsScope.docsOnly).toBe(true);
    expect(docsScope.deployRequired).toBe(false);
  });

  it("routes the platform Kubernetes Secret helper through workflow lint and a cluster preview without deploying", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/platform-kubernetes-secret.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    // #4864: this script builds the runtime Secret every preview/staging/
    // production release applies, so a change here is env plumbing that
    // needs the real cluster preview, not just the dry-run in workflow lint.
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes the platform ingress wait helper through workflow lint and a cluster preview without deploying", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/platform-ingress-wait.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes DOKS and platform Kubernetes deploy script changes onto the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/doks-cluster-addons.mjs", "scripts/platform-kubernetes-deployment.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("classifies exposure-posture changes for targeted release gates", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "scripts/marketplace-tax-readiness-evidence.mjs",
        "scripts/marketplace-stripe-money-operations-evidence.mjs",
        "scripts/release-lock.mjs",
        "docs/adr/0002-adopt-ucp-for-agent-commerce.md",
      ],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.exposurePostureChanged).toBe(true);
    expect(scope.exposurePostureCategories).toEqual([
      "live-money-provider",
      "rollout-policy",
      "tax-posture",
      "ucp-signed-write",
    ]);
    expect(JSON.parse(toOutputMap(scope).exposure_posture_categories_json)).toEqual(scope.exposurePostureCategories);
  });
});
