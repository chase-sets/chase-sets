#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const ADMIN_WORKFLOWS_QA_EVIDENCE_VERSION = "admin-workflows-qa-evidence/v1";

export const ADMIN_WORKFLOWS_QA_REDACTION_CATEGORIES = Object.freeze([
  "email",
  "cookie_or_session",
  "authorization_token",
  "raw_recovery_token",
  "raw_domain_id",
  "full_url",
]);

export const ADMIN_WORKFLOWS_QA_CROSS_CUTTING_REQUIRED_FIELDS = Object.freeze([
  { key: "environment", labels: ["Environment"], aliases: ["environment", "env"] },
  { key: "actorAlias", labels: ["Actor alias"], aliases: ["actorAlias", "actor"] },
  { key: "signInHost", labels: ["Sign-in host", "Sign in host"], aliases: ["signInHost", "signInPath"] },
  {
    key: "routeOrWorkflow",
    labels: ["Route or workflow", "Route/probe template", "Probe"],
    aliases: ["routeOrWorkflow", "routeTemplate", "route", "workflow", "probe", "path"],
  },
  { key: "expected", labels: ["Expected"], aliases: ["expected", "expectedBehavior", "assertions"] },
  { key: "observed", labels: ["Observed"], aliases: ["observed", "observedBehavior", "status", "result"] },
  {
    key: "evidenceArtifact",
    labels: ["Evidence artifact", "Artifact"],
    aliases: ["evidenceArtifact", "artifact", "artifactPath", "artifactFolder", "evidenceFiles"],
  },
  { key: "redactionReview", labels: ["Redaction review"], aliases: ["redactionReview", "redaction"] },
  {
    key: "securityPiiReview",
    labels: ["Security/PII review", "Security and PII review"],
    aliases: ["securityPiiReview", "securityReview", "piiReview"],
  },
  {
    key: "responsiveCoverage",
    labels: ["Responsive coverage", "Responsive/mobile coverage"],
    aliases: ["responsiveCoverage", "viewportCoverage", "viewports"],
  },
  {
    key: "stateCoverage",
    labels: ["State coverage", "Empty/error/loading state coverage"],
    aliases: ["stateCoverage", "stateChecks", "states"],
  },
]);

export const ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX = Object.freeze([
  { actorAlias: "admin-qa-platform-admin", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-owner", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-manager", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-fulfillment", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-viewer", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-security-manage", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-memberships-view", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-postage-policies-view", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-public-presence-view", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-platform-feedback-view", signInHost: "/access/sign-in" },
  { actorAlias: "admin-qa-catalog-admin", signInHost: "/catalog/sign-in" },
]);

export const ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE = Object.freeze([
  { key: "primitive:dimensions", description: "Dimension primitive lifecycle coverage" },
  { key: "primitive:fields", description: "Field primitive lifecycle coverage" },
  { key: "primitive:components", description: "Component primitive lifecycle coverage" },
  { key: "primitive:blueprints", description: "Blueprint primitive lifecycle coverage" },
  { key: "primitive:categories", description: "Category primitive lifecycle coverage" },
  { key: "primitive:catalog-items", description: "Catalog Item primitive lifecycle coverage" },
  { key: "primitive:display-templates", description: "Display Template primitive lifecycle coverage" },
  { key: "primitive:reference-types", description: "Reference Type primitive lifecycle coverage" },
  { key: "primitive:reference-records", description: "Reference Record primitive lifecycle coverage" },
  { key: "lifecycle:create-draft", description: "Create draft lifecycle action" },
  { key: "lifecycle:edit-structure", description: "Edit structure lifecycle action" },
  { key: "lifecycle:publish-or-activate", description: "Publish or activate lifecycle action" },
  { key: "lifecycle:deprecate", description: "Deprecate lifecycle action" },
  { key: "lifecycle:archive", description: "Archive lifecycle action" },
  { key: "lifecycle:structure-lock", description: "Published structure lock evidence" },
  { key: "lifecycle:archive-terminal", description: "Terminal archive evidence" },
  { key: "dimension-options:add", description: "Dimension option add action" },
  { key: "dimension-options:revise", description: "Dimension option revise action" },
  { key: "dimension-options:reorder", description: "Dimension option reorder action" },
  { key: "dimension-options:deprecate", description: "Dimension option deprecate action" },
  { key: "dimension-options:reactivate", description: "Dimension option reactivate action" },
  {
    key: "rules:draft-only-attach-detach",
    description: "Component and blueprint rule attach/detach is draft-only",
  },
  { key: "catalog-item:field-values", description: "Catalog Item field values coverage" },
  { key: "catalog-item:image-fallback", description: "Catalog Item image fallback coverage" },
  { key: "catalog-item:external-references", description: "Catalog Item external references coverage" },
  { key: "catalog-item:delete-draft", description: "Catalog Item delete draft coverage" },
  { key: "bulk-authoring:bulk-lifecycle-preview", description: "Bulk lifecycle preview correctness" },
  { key: "bulk-authoring:bulk-lifecycle-confirm", description: "Bulk lifecycle confirmation" },
  { key: "bulk-authoring:bulk-lifecycle-counts", description: "Bulk lifecycle success/failure counts" },
  {
    key: "bulk-authoring:bulk-lifecycle-projection-refresh",
    description: "Bulk lifecycle projection refresh",
  },
  { key: "bulk-authoring:bulk-edit-preview", description: "Bulk edit preview correctness" },
  { key: "bulk-authoring:bulk-edit-confirm", description: "Bulk edit confirmation" },
  { key: "bulk-authoring:bulk-edit-counts", description: "Bulk edit success/failure counts" },
  { key: "bulk-authoring:bulk-edit-projection-refresh", description: "Bulk edit projection refresh" },
  { key: "bulk-authoring:bulk-publish-preview", description: "Bulk publish preview correctness" },
  { key: "bulk-authoring:bulk-publish-confirm", description: "Bulk publish confirmation" },
  { key: "bulk-authoring:bulk-publish-counts", description: "Bulk publish success/failure counts" },
  {
    key: "bulk-authoring:bulk-publish-projection-refresh",
    description: "Bulk publish projection refresh",
  },
  { key: "realtime:sse-list-detail", description: "SSE projection revalidation on list and detail" },
  { key: "realtime:pending-change-reload-bar", description: "Catalog Item pending-change reload bar" },
  { key: "seed-tripwire:catalog-admin", description: "Catalog-admin seed tripwire respected" },
]);

const CATALOG_MODELING_COVERAGE_LABELS = Object.freeze([
  "Catalog modeling coverage",
  "Modeling coverage",
  "Checklist coverage",
]);

const CATALOG_MODELING_COVERAGE_ALIASES = Object.freeze([
  "catalogModelingCoverage",
  "modelingCoverage",
  "checklistCoverage",
  "coverage",
  "coverageKey",
  "check",
]);

export const ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE = Object.freeze([
  { key: "projection-ops:status-stats", description: "Status and stats render" },
  { key: "projection-ops:tab-overview", description: "Overview tab navigation" },
  { key: "projection-ops:tab-attention", description: "Attention tab navigation" },
  { key: "projection-ops:tab-operations", description: "Operations tab navigation" },
  { key: "projection-ops:tab-projection-groups", description: "Projection groups tab navigation" },
  { key: "projection-ops:tab-subscriptions", description: "Subscriptions tab navigation" },
  { key: "projection-ops:tab-blocked-streams", description: "Blocked streams tab navigation" },
  { key: "projection-ops:tab-workers", description: "Workers tab navigation" },
  { key: "projection-ops:tab-wake-pipeline", description: "Wake pipeline tab navigation" },
  { key: "projection-ops:tab-diagnostics", description: "Diagnostics tab navigation" },
  { key: "projection-ops:refresh-status", description: "Refresh status action" },
  { key: "projection-ops:retry-blocked-stream", description: "Retry blocked stream action" },
  { key: "projection-ops:cancel-operation", description: "Cancel queued or running operation action" },
  {
    key: "projection-ops:rebuild-projection-group-disposable",
    description: "Confirm-gated rebuild projection group against a disposable projection",
  },
  {
    key: "projection-ops:rebuild-context-disposable",
    description: "Confirm-gated rebuild context against a disposable projection",
  },
  { key: "projection-ops:completion", description: "Destructive operation completion evidence" },
  { key: "projection-ops:attention-clearance", description: "Attention item clearance evidence" },
  { key: "projection-ops:no-data-loss", description: "No data loss evidence for disposable destructive checks" },
  {
    key: "projection-ops:actor-attribution-or-3011",
    description: "Actor attribution evidence or explicit #3011 dependency",
  },
  {
    key: "projection-ops:wake-pipeline-unavailable-controlled",
    description: "Wake pipeline unavailable state degrades gracefully",
  },
  { key: "projection-ops:runbook-cross-reference", description: "Projection operations runbook cross-reference" },
  { key: "projection-ops:disposable-projection-recorded", description: "Disposable projection recorded" },
]);

const PROJECTION_OPERATIONS_COVERAGE_LABELS = Object.freeze([
  "Projection operations coverage",
  "Projection ops coverage",
  "Platform projection coverage",
]);

const PROJECTION_OPERATIONS_COVERAGE_ALIASES = Object.freeze([
  "projectionOperationsCoverage",
  "projectionOpsCoverage",
  "platformProjectionCoverage",
  "coverage",
  "coverageKey",
  "check",
]);

export const ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE = Object.freeze([
  {
    key: "access:accounts-suspend",
    description: "Account suspend action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:accounts-reactivate",
    description: "Account reactivate action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:accounts-close-terminal",
    description: "Account close terminal state",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:accounts-badge-founding-add-remove",
    description: "Founding Account badge add/remove",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:accounts-badge-trusted-seller-add-remove",
    description: "Trusted Seller badge add/remove",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:accounts-badge-manual-payout-review-add-remove",
    description: "Manual Payout Review badge add/remove",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:users-profile-edit",
    description: "User profile edit action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  { key: "access:users-suspend", description: "User suspend action", suggestedActorAlias: "admin-qa-platform-admin" },
  {
    key: "access:users-reactivate",
    description: "User reactivate action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:memberships-role-owner",
    description: "Membership role change to owner",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:memberships-role-manager",
    description: "Membership role change to manager",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:memberships-role-fulfillment",
    description: "Membership role change to fulfillment",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:memberships-role-viewer",
    description: "Membership role change to viewer",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:memberships-revoke",
    description: "Membership revoke action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:memberships-reinstate",
    description: "Membership reinstate action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:memberships-account-scoped-filtering",
    description: "Account-scoped filtering for non-platform-admin actors",
    suggestedActorAlias: "admin-qa-manager",
  },
  {
    key: "access:invitations-create",
    description: "Invitation create action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:invitations-resend",
    description: "Invitation resend action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:invitations-cancel",
    description: "Invitation cancel action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:invitations-decline",
    description: "Invitation decline path",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:invitations-expire",
    description: "Invitation expire path",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:api-keys-create",
    description: "API key create action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:api-keys-rotate",
    description: "API key rotate action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:api-keys-revoke",
    description: "API key revoke action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:sessions-switch-active-account",
    description: "Session switch active account action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:sessions-revoke",
    description: "Session revoke action",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:pagination-over-50-accounts",
    description: "Accounts list over-50 pagination behavior",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:pagination-over-50-users",
    description: "Users list over-50 pagination behavior",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:pagination-over-50-memberships",
    description: "Memberships list over-50 pagination behavior",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:pagination-over-50-invitations",
    description: "Invitations list over-50 pagination behavior",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:pagination-over-50-api-keys",
    description: "API Keys list over-50 pagination behavior",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:pagination-over-50-sessions",
    description: "Sessions list over-50 pagination behavior",
    suggestedActorAlias: "admin-qa-platform-admin",
  },
  {
    key: "access:actor-security-manage",
    description: "security.manage actor evidence",
    suggestedActorAlias: "admin-qa-security-manage",
  },
  {
    key: "access:actor-memberships-view",
    description: "memberships.view actor evidence",
    suggestedActorAlias: "admin-qa-memberships-view",
  },
  {
    key: "access:least-privilege-denied-writes",
    description: "Least-privilege denied-write behavior",
    suggestedActorAlias: "admin-qa-viewer",
  },
]);

/**
 * Renders a fill-in-the-blanks Markdown evidence scaffold for the Access
 * section checklist: one evidence block per required coverage key,
 * pre-filled with the support-safe suggested actor alias and the
 * `Access coverage:` label the completeness gate scans for. Operators
 * replace the `Route or workflow`, `Observed`, `Evidence artifact`, and
 * `Redaction review` placeholders with real deployed staging QA results;
 * everything else stays as generated. Cuts the manual packet-authoring
 * step down to filling in per-row observations instead of retyping the
 * checklist shape and every coverage key by hand.
 */
export function buildAdminWorkflowsQaAccessEvidenceScaffold() {
  const lines = [
    "<!-- Generated by `pnpm run ops admin-workflows:qa-evidence -- --scaffold-access`. -->",
    "<!-- Replace every <TODO: ...> placeholder with real deployed staging QA evidence before posting. -->",
    "<!-- Keep account/user/membership/invitation/API-key/session ids, emails, cookies, and full URLs out of this file. -->",
    "",
  ];
  for (const coverage of ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE) {
    lines.push(
      `### ${coverage.key} — ${coverage.description}`,
      "",
      "Environment: staging admin-web",
      `Actor alias: ${coverage.suggestedActorAlias}`,
      "Sign-in host: /access/sign-in",
      "Route or workflow: <TODO: route template>",
      `Expected: ${coverage.description} succeeds for an authorized actor and is denied for an unauthorized one.`,
      "Observed: <TODO: fill from staging>",
      `Evidence artifact: artifacts/admin-qa/3020/${coverage.key.slice("access:".length)}`,
      "Redaction review: <TODO: passed / controlled-unavailable>",
      `Access coverage: ${coverage.key}`,
      "",
    );
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

const ACCESS_COVERAGE_LABELS = Object.freeze(["Access coverage", "Access checklist coverage"]);

const ACCESS_COVERAGE_ALIASES = Object.freeze([
  "accessCoverage",
  "accessChecklistCoverage",
  "coverage",
  "coverageKey",
  "check",
]);

export const ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE = Object.freeze([
  { key: "catalog-integrations:provider-tcgplayer-import", description: "TCGplayer import start evidence" },
  { key: "catalog-integrations:provider-scrydex-import", description: "Scrydex import start evidence" },
  { key: "catalog-integrations:provider-tcgdex-import", description: "TCGdex import start evidence" },
  { key: "catalog-integrations:live-sse-job-progress", description: "Live SSE job progress evidence" },
  { key: "catalog-integrations:review-observations", description: "Source Observation review evidence" },
  { key: "catalog-integrations:single-promote", description: "Single promote action evidence" },
  { key: "catalog-integrations:bulk-promote", description: "Bulk promote action evidence" },
  { key: "catalog-integrations:bulk-reject", description: "Bulk reject action evidence" },
  { key: "catalog-integrations:bulk-defer", description: "Bulk defer action evidence" },
  { key: "catalog-integrations:stale-preview-reconfirm", description: "Stale preview re-confirmation guard" },
  { key: "catalog-integrations:job-retry", description: "Integration job retry evidence" },
  { key: "catalog-integrations:job-resume", description: "Integration job resume evidence" },
  { key: "catalog-integrations:job-cancel", description: "Integration job cancel evidence" },
  { key: "catalog-integrations:job-reapply", description: "Review reapply evidence" },
  { key: "catalog-integrations:job-replay", description: "Recovery replay evidence" },
  { key: "catalog-integrations:alias-accept", description: "Alias accept evidence" },
  { key: "catalog-integrations:alias-reject", description: "Alias reject evidence" },
  { key: "catalog-integrations:alias-revoke", description: "Alias revoke evidence" },
  { key: "catalog-integrations:provider-profile-clone", description: "Provider profile clone evidence" },
  { key: "catalog-integrations:provider-profile-edit-section", description: "Provider profile section edit evidence" },
  { key: "catalog-integrations:provider-profile-dry-run", description: "Provider profile dry-run evidence" },
  { key: "catalog-integrations:provider-profile-activate", description: "Provider profile activate evidence" },
  { key: "catalog-integrations:provider-profile-rollback", description: "Provider profile rollback evidence" },
  { key: "catalog-integrations:provider-profile-deprecate", description: "Provider profile deprecate evidence" },
  { key: "catalog-integrations:provider-profile-retire", description: "Provider profile retire evidence" },
  { key: "catalog-integrations:readiness-blockers", description: "Readiness blocker evidence" },
  { key: "catalog-integrations:activation-blockers", description: "Activation blocker evidence" },
  { key: "catalog-integrations:governance-conflict-review", description: "Governance conflict review evidence" },
  { key: "catalog-integrations:governance-lifecycle-impact-preview", description: "Lifecycle-impact preview evidence" },
  { key: "catalog-integrations:governance-kill-switch-403", description: "Kill-switch 403 enforcement evidence" },
  { key: "catalog-integrations:magic-imports-disabled", description: "Magic provider imports disabled evidence" },
  { key: "catalog-integrations:health-semantic", description: "Semantic health evidence" },
  { key: "catalog-integrations:health-transport", description: "Provider transport health evidence" },
  { key: "catalog-integrations:health-freshness", description: "Freshness health evidence" },
  { key: "catalog-integrations:health-audit-timeline", description: "Audit timeline evidence" },
  { key: "catalog-integrations:sse-integration-job-stream", description: "Integration-job stream probe evidence" },
  { key: "catalog-integrations:sse-bulk-job-stream", description: "Bulk-job stream probe evidence" },
  { key: "catalog-integrations:sse-reconnect", description: "SSE reconnection evidence" },
  { key: "catalog-integrations:sync-required-snapshot-fallback", description: "sync.required snapshot fallback" },
  { key: "catalog-integrations:actor-catalog-admin", description: "Catalog admin actor evidence" },
  { key: "catalog-integrations:control-plane-permissions", description: "Control-plane permissions evidence" },
]);

const CATALOG_INTEGRATIONS_COVERAGE_LABELS = Object.freeze([
  "Catalog integrations coverage",
  "Catalog integration coverage",
  "Source observation coverage",
]);

const CATALOG_INTEGRATIONS_COVERAGE_ALIASES = Object.freeze([
  "catalogIntegrationsCoverage",
  "catalogIntegrationCoverage",
  "sourceObservationCoverage",
  "coverage",
  "coverageKey",
  "check",
]);

const CATEGORY_PATTERNS = Object.freeze({
  email: [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  cookie_or_session: [
    /\b(?:cookie|set-cookie)\s*[:=]\s*\S+/gi,
    /\bchase_sets_[A-Za-z0-9_-]+\s*=\s*[^;\s]+/gi,
    /\b(?:session|csrf|xsrf)[-_]?(?:token|cookie|id)?\s*[:=]\s*[A-Za-z0-9._~+/-]{8,}/gi,
  ],
  authorization_token: [
    /\bauthorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+/-]{8,}/gi,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  ],
  raw_recovery_token: [
    /\b(?:afterWrite|postWriteToken|readAfterWrite|read_after_write)=\S+/gi,
    /\bChase-Sets-Read-After-Write\s*[:=]\s*\S+/gi,
  ],
  raw_domain_id: [
    /\b(?:account|acct|user|usr|membership|member|mbr|invitation|invite|api_key|apikey|session|sess|checkout|chk|payment|pay|payout|order|ord|sale|shipment|ship|label|inventory|inv|listing|lst|offer|ofr|cart|crt|event|evt|job|bulk|provider|profile)_[0-9A-Za-z][0-9A-Za-z_:-]{3,}\b/g,
  ],
  full_url: [/\bhttps?:\/\/[^\s<>)"']+/gi],
});

export function parseAdminWorkflowsQaEvidenceArgs(argv, env = process.env) {
  const envEvidenceFiles = splitEvidenceFiles(readEnv("ADMIN_WORKFLOWS_QA_EVIDENCE_FILES", env));
  return {
    evidenceFiles: [...readEvidenceFileOptions(argv), ...envEvidenceFiles],
    outPath: readOption(argv, "--out") ?? readEnv("ADMIN_WORKFLOWS_QA_EVIDENCE_OUT", env),
    environment: readOption(argv, "--environment") ?? readEnv("ADMIN_WORKFLOWS_QA_ENVIRONMENT", env) ?? "staging",
    issue: readOption(argv, "--issue") ?? readEnv("ADMIN_WORKFLOWS_QA_ISSUE", env) ?? "3027",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    requireCrossCuttingCoverage:
      argv.includes("--require-cross-cutting-coverage") ||
      readEnv("ADMIN_WORKFLOWS_QA_REQUIRE_CROSS_CUTTING_COVERAGE", env) === "true",
    requireActorMatrixCoverage:
      argv.includes("--require-actor-matrix-coverage") ||
      readEnv("ADMIN_WORKFLOWS_QA_REQUIRE_ACTOR_MATRIX_COVERAGE", env) === "true",
    requireCatalogModelingCoverage:
      argv.includes("--require-catalog-modeling-coverage") ||
      readEnv("ADMIN_WORKFLOWS_QA_REQUIRE_CATALOG_MODELING_COVERAGE", env) === "true",
    requireProjectionOperationsCoverage:
      argv.includes("--require-projection-operations-coverage") ||
      readEnv("ADMIN_WORKFLOWS_QA_REQUIRE_PROJECTION_OPERATIONS_COVERAGE", env) === "true",
    requireAccessCoverage:
      argv.includes("--require-access-coverage") ||
      readEnv("ADMIN_WORKFLOWS_QA_REQUIRE_ACCESS_COVERAGE", env) === "true",
    requireCatalogIntegrationsCoverage:
      argv.includes("--require-catalog-integrations-coverage") ||
      readEnv("ADMIN_WORKFLOWS_QA_REQUIRE_CATALOG_INTEGRATIONS_COVERAGE", env) === "true",
    scaffoldAccess: argv.includes("--scaffold-access") || readEnv("ADMIN_WORKFLOWS_QA_SCAFFOLD_ACCESS", env) === "true",
  };
}

export async function runAdminWorkflowsQaEvidence(options) {
  const files = normalizeEvidenceFiles(options.evidenceFiles);
  if (files.length === 0) {
    throw new Error("At least one --evidence-file is required.");
  }

  const evidenceFiles = [];
  for (const filePath of files) {
    evidenceFiles.push({
      path: filePath,
      content: await readFile(filePath, "utf8"),
    });
  }

  const evidence = buildAdminWorkflowsQaEvidence({
    ...options,
    evidenceFiles,
  });

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }

  return evidence;
}

export function buildAdminWorkflowsQaEvidence(input) {
  const fileResults = input.evidenceFiles.map(({ path, content }) => {
    const findings = findAdminWorkflowsQaEvidenceFindings(content);
    return {
      path: supportSafePath(path),
      lineCount: content.split(/\r?\n/).length,
      status: findings.length === 0 ? "pass" : "fail",
      findings,
    };
  });
  const summary = summarizeFindings(fileResults);
  const totalFindings = Object.values(summary).reduce((total, count) => total + count, 0);
  const completeness = buildCrossCuttingCompleteness(input);
  const actorMatrix = buildActorMatrixCompleteness(input);
  const catalogModeling = buildCatalogModelingCompleteness(input);
  const projectionOperations = buildProjectionOperationsCompleteness(input);
  const access = buildAccessCompleteness(input);
  const catalogIntegrations = buildCatalogIntegrationsCompleteness(input);
  const completenessFindings = input.requireCrossCuttingCoverage ? completeness.missingFields.length : 0;
  const actorMatrixFindings = input.requireActorMatrixCoverage
    ? actorMatrix.missingActors.length + actorMatrix.hostMismatches.length
    : 0;
  const catalogModelingFindings = input.requireCatalogModelingCoverage ? catalogModeling.missingCoverage.length : 0;
  const projectionOperationsFindings = input.requireProjectionOperationsCoverage
    ? projectionOperations.missingCoverage.length
    : 0;
  const accessFindings = input.requireAccessCoverage ? access.missingCoverage.length : 0;
  const catalogIntegrationsFindings = input.requireCatalogIntegrationsCoverage
    ? catalogIntegrations.missingCoverage.length
    : 0;
  const totalBlockingFindings =
    totalFindings +
    completenessFindings +
    actorMatrixFindings +
    catalogModelingFindings +
    projectionOperationsFindings +
    accessFindings +
    catalogIntegrationsFindings;

  return {
    schemaVersion: ADMIN_WORKFLOWS_QA_EVIDENCE_VERSION,
    checkedAt: input.checkedAt,
    environment: normalizeString(input.environment) ?? "staging",
    issue: normalizeIssue(input.issue),
    verdict: totalBlockingFindings === 0 ? "pass" : "fail",
    summary,
    files: fileResults,
    completeness,
    actorMatrix,
    catalogModeling,
    projectionOperations,
    access,
    catalogIntegrations,
    guidance:
      totalBlockingFindings === 0
        ? buildPassingGuidance(input)
        : buildFailingGuidance(
            totalFindings,
            completenessFindings,
            actorMatrixFindings,
            catalogModelingFindings,
            projectionOperationsFindings,
            accessFindings,
            catalogIntegrationsFindings,
          ),
    redaction: {
      emails: "never-recorded",
      cookies: "never-recorded",
      sessionTokens: "never-recorded",
      authorizationHeaders: "never-recorded",
      rawIds: "never-recorded",
      afterWrite: "never-recorded",
      postWriteToken: "never-recorded",
      fullUrls: "never-recorded",
    },
  };
}

function buildCatalogModelingCompleteness(input) {
  const required = Boolean(input.requireCatalogModelingCoverage);
  const coveredCoverage = required
    ? collectChecklistCoverage(input.evidenceFiles, CATALOG_MODELING_COVERAGE_LABELS, CATALOG_MODELING_COVERAGE_ALIASES)
    : new Set();
  const missingCoverage = required
    ? ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE.filter(
        (coverage) => !coveredCoverage.has(coverage.key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      }))
    : [];

  return {
    mode: required ? "catalog-modeling-coverage" : "not-required",
    status: missingCoverage.length === 0 ? "pass" : "fail",
    requiredCoverage: required ? ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE : [],
    coveredCoverage: required ? [...coveredCoverage].sort() : [],
    missingCoverage,
  };
}

function buildProjectionOperationsCompleteness(input) {
  const required = Boolean(input.requireProjectionOperationsCoverage);
  const coveredCoverage = required
    ? collectChecklistCoverage(
        input.evidenceFiles,
        PROJECTION_OPERATIONS_COVERAGE_LABELS,
        PROJECTION_OPERATIONS_COVERAGE_ALIASES,
      )
    : new Set();
  const missingCoverage = required
    ? ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE.filter(
        (coverage) => !coveredCoverage.has(coverage.key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      }))
    : [];

  return {
    mode: required ? "projection-operations-coverage" : "not-required",
    status: missingCoverage.length === 0 ? "pass" : "fail",
    requiredCoverage: required ? ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE : [],
    coveredCoverage: required ? [...coveredCoverage].sort() : [],
    missingCoverage,
  };
}

function buildAccessCompleteness(input) {
  const required = Boolean(input.requireAccessCoverage);
  const coveredCoverage = required
    ? collectChecklistCoverage(input.evidenceFiles, ACCESS_COVERAGE_LABELS, ACCESS_COVERAGE_ALIASES)
    : new Set();
  const missingCoverage = required
    ? ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE.filter((coverage) => !coveredCoverage.has(coverage.key)).map(
        (coverage) => ({
          ...coverage,
          severity: "blocker",
        }),
      )
    : [];

  return {
    mode: required ? "access-coverage" : "not-required",
    status: missingCoverage.length === 0 ? "pass" : "fail",
    requiredCoverage: required ? ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE : [],
    coveredCoverage: required ? [...coveredCoverage].sort() : [],
    missingCoverage,
  };
}

function buildCatalogIntegrationsCompleteness(input) {
  const required = Boolean(input.requireCatalogIntegrationsCoverage);
  const coveredCoverage = required
    ? collectChecklistCoverage(
        input.evidenceFiles,
        CATALOG_INTEGRATIONS_COVERAGE_LABELS,
        CATALOG_INTEGRATIONS_COVERAGE_ALIASES,
      )
    : new Set();
  const missingCoverage = required
    ? ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE.filter(
        (coverage) => !coveredCoverage.has(coverage.key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      }))
    : [];

  return {
    mode: required ? "catalog-integrations-coverage" : "not-required",
    status: missingCoverage.length === 0 ? "pass" : "fail",
    requiredCoverage: required ? ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE : [],
    coveredCoverage: required ? [...coveredCoverage].sort() : [],
    missingCoverage,
  };
}

function collectChecklistCoverage(evidenceFiles, labels, aliases) {
  const covered = new Set();
  for (const { content } of evidenceFiles) {
    collectMarkdownChecklistCoverage(content, covered, labels);
    collectStructuredChecklistCoverage(content, covered, aliases);
  }
  return covered;
}

function collectMarkdownChecklistCoverage(content, covered, labels) {
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    for (const label of labels) {
      const value = readLabeledValue(line, [label]);
      if (value !== null) {
        addCoverageValues(covered, value);
      }
    }
  }
}

function collectStructuredChecklistCoverage(content, covered, aliases) {
  const parsed = parseJsonEvidence(content);
  if (parsed === null) {
    return;
  }
  visitJsonRecords(parsed, (record) => {
    for (const alias of aliases) {
      addCoverageValues(covered, record[alias]);
    }
  });
}

function addCoverageValues(covered, value) {
  if (typeof value === "string") {
    for (const item of value.split(/[,\n;]/)) {
      addCoverageKey(covered, item);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      addCoverageValues(covered, item);
    }
  }
}

function addCoverageKey(covered, value) {
  const key = normalizeCoverageKey(value);
  if (key) {
    covered.add(key);
  }
}

function normalizeCoverageKey(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  return normalized
    .toLowerCase()
    .replace(/[ _]+/g, "-")
    .replace(/\s*:\s*/g, ":");
}

function buildActorMatrixCompleteness(input) {
  const required = Boolean(input.requireActorMatrixCoverage);
  const evidenceRecords = required ? collectActorEvidenceRecords(input.evidenceFiles) : [];
  const missingActors = [];
  const hostMismatches = [];
  const coveredActors = [];

  if (required) {
    for (const requiredActor of ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX) {
      const actorRecords = evidenceRecords.filter((record) => record.actorAlias === requiredActor.actorAlias);
      if (actorRecords.length === 0) {
        missingActors.push(requiredActor);
        continue;
      }
      if (actorRecords.some((record) => record.signInHost === requiredActor.signInHost)) {
        coveredActors.push(requiredActor);
        continue;
      }
      hostMismatches.push({
        actorAlias: requiredActor.actorAlias,
        expectedSignInHost: requiredActor.signInHost,
        observedSignInHosts: [...new Set(actorRecords.map((record) => record.signInHost).filter(Boolean))].sort(),
        severity: "blocker",
      });
    }
  }

  return {
    mode: required ? "actor-matrix-coverage" : "not-required",
    status: missingActors.length === 0 && hostMismatches.length === 0 ? "pass" : "fail",
    requiredActors: required ? ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX : [],
    coveredActors,
    missingActors: missingActors.map((actor) => ({ ...actor, severity: "blocker" })),
    hostMismatches,
  };
}

function collectActorEvidenceRecords(evidenceFiles) {
  return evidenceFiles.flatMap(({ content }) => [
    ...collectStructuredActorEvidenceRecords(content),
    ...collectMarkdownActorEvidenceRecords(content),
  ]);
}

function collectStructuredActorEvidenceRecords(content) {
  const parsed = parseJsonEvidence(content);
  if (parsed === null) {
    return [];
  }
  const records = [];
  visitJsonRecords(parsed, (record) => {
    const actorAlias = normalizeString(record.actorAlias) ?? normalizeString(record.actor);
    const signInHost = normalizeString(record.signInHost) ?? normalizeString(record.signInPath);
    if (actorAlias || signInHost) {
      records.push({ actorAlias, signInHost });
    }
  });
  return records;
}

function collectMarkdownActorEvidenceRecords(content) {
  const records = [];
  let current = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      pushActorRecord(records, current);
      current = {};
      continue;
    }
    const actorAlias = readLabeledValue(line, ["Actor alias"]);
    if (actorAlias !== null) {
      if (current.actorAlias) {
        pushActorRecord(records, current);
        current = {};
      }
      current.actorAlias = actorAlias;
      continue;
    }
    const signInHost = readLabeledValue(line, ["Sign-in host", "Sign in host"]);
    if (signInHost !== null) {
      current.signInHost = signInHost;
    }
  }
  pushActorRecord(records, current);
  return records;
}

function readLabeledValue(line, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}\\s*:\\s*(.+)$`, "i").exec(line);
    if (match) {
      return normalizeString(match[1]) ?? "";
    }
  }
  return null;
}

function pushActorRecord(records, record) {
  if (record.actorAlias || record.signInHost) {
    records.push({
      actorAlias: normalizeString(record.actorAlias) ?? null,
      signInHost: normalizeString(record.signInHost) ?? null,
    });
  }
}

function buildCrossCuttingCompleteness(input) {
  const required = Boolean(input.requireCrossCuttingCoverage);
  const content = input.evidenceFiles.map(({ content }) => content).join("\n");
  const structuredFields = collectStructuredEvidenceFields(input.evidenceFiles);
  const missingFields = required
    ? ADMIN_WORKFLOWS_QA_CROSS_CUTTING_REQUIRED_FIELDS.filter(
        (field) => !hasEvidenceField(content, field.labels) && !structuredFields.has(field.key),
      ).map((field) => ({
        key: field.key,
        labels: field.labels,
        structuredAliases: field.aliases,
        severity: "blocker",
      }))
    : [];

  return {
    mode: required ? "cross-cutting-coverage" : "redaction-only",
    status: missingFields.length === 0 ? "pass" : "fail",
    requiredFields: required
      ? ADMIN_WORKFLOWS_QA_CROSS_CUTTING_REQUIRED_FIELDS.map((field) => ({
          key: field.key,
          labels: field.labels,
          structuredAliases: field.aliases,
        }))
      : [],
    coveredFields: required ? [...structuredFields].sort() : [],
    missingFields,
  };
}

function collectStructuredEvidenceFields(evidenceFiles) {
  const covered = new Set();
  for (const { content } of evidenceFiles) {
    const parsed = parseJsonEvidence(content);
    if (parsed === null) {
      continue;
    }
    collectStructuredEvidenceFieldsFromValue(parsed, covered);
  }
  return covered;
}

function collectStructuredEvidenceFieldsFromValue(value, covered) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredEvidenceFieldsFromValue(item, covered);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }

  for (const field of ADMIN_WORKFLOWS_QA_CROSS_CUTTING_REQUIRED_FIELDS) {
    if (field.aliases.some((alias) => hasNonEmptyStructuredValue(value[alias]))) {
      covered.add(field.key);
    }
  }

  for (const childKey of ["evidence", "records", "results", "rows", "checks", "artifacts"]) {
    collectStructuredEvidenceFieldsFromValue(value[childKey], covered);
  }
}

function visitJsonRecords(value, onRecord, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      visitJsonRecords(item, onRecord, seen, depth + 1);
    }
    return;
  }
  onRecord(value);
  for (const child of Object.values(value)) {
    visitJsonRecords(child, onRecord, seen, depth + 1);
  }
}

function parseJsonEvidence(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyStructuredValue(value) {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isPlainRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return value !== null && value !== undefined;
}

function hasEvidenceField(content, labels) {
  return labels.some((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\n)\\s*${escaped}\\s*:`, "i").test(content);
  });
}

function buildPassingGuidance(input) {
  const guidance = [
    "Evidence is support-safe for public GitHub issue comments under the admin-workflows QA redaction policy.",
  ];
  if (input.requireCrossCuttingCoverage) {
    guidance.push(
      "Cross-cutting evidence names route/probe, expected and observed behavior, artifact, redaction review, security/PII review, responsive coverage, and state coverage.",
    );
  }
  if (input.requireActorMatrixCoverage) {
    guidance.push("Actor matrix evidence covers every required support-safe actor alias and intended sign-in host.");
  }
  if (input.requireCatalogModelingCoverage) {
    guidance.push(
      "Catalog modeling evidence covers primitive lifecycles, dimension options, draft-only rules, Catalog Item details, bulk authoring jobs, realtime refresh, and the seed tripwire.",
    );
  }
  if (input.requireProjectionOperationsCoverage) {
    guidance.push(
      "Projection operations evidence covers tab navigation, safe controls, disposable destructive checks, graceful wake-pipeline degradation, and runbook cross-reference.",
    );
  }
  if (input.requireAccessCoverage) {
    guidance.push(
      "Access evidence covers accounts, users, memberships, invitations, API keys, sessions, over-50 pagination, least-privilege actors, and denied-write behavior.",
    );
  }
  if (input.requireCatalogIntegrationsCoverage) {
    guidance.push(
      "Catalog integrations evidence covers provider import/review/promote, recovery, alias, provider-profile, governance, health, SSE/fallback, Magic-disabled, and control-plane permission checks.",
    );
  }
  return guidance;
}

function buildFailingGuidance(
  totalFindings,
  completenessFindings,
  actorMatrixFindings,
  catalogModelingFindings,
  projectionOperationsFindings,
  accessFindings,
  catalogIntegrationsFindings,
) {
  const guidance = [];
  if (totalFindings > 0) {
    guidance.push(
      "Replace raw values with actor aliases, route templates, support-safe artifact references, and issue/PR numbers before posting publicly.",
    );
  }
  if (completenessFindings > 0) {
    guidance.push("Add the missing cross-cutting evidence fields before using this packet to close #3027.");
  }
  if (actorMatrixFindings > 0) {
    guidance.push("Add the missing support-safe actor aliases and intended sign-in hosts before closing #3016.");
  }
  if (catalogModelingFindings > 0) {
    guidance.push("Add the missing catalog modeling coverage keys before using this packet to close #3021.");
  }
  if (projectionOperationsFindings > 0) {
    guidance.push("Add the missing projection operations coverage keys before using this packet to close #3026.");
  }
  if (accessFindings > 0) {
    guidance.push("Add the missing Access coverage keys before using this packet to close #3020.");
  }
  if (catalogIntegrationsFindings > 0) {
    guidance.push("Add the missing catalog integrations coverage keys before using this packet to close #3022.");
  }
  return guidance;
}

export function findAdminWorkflowsQaEvidenceFindings(content) {
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const category of ADMIN_WORKFLOWS_QA_REDACTION_CATEGORIES) {
      const count = countCategoryMatches(line, category);
      if (count > 0) {
        findings.push({
          category,
          line: index + 1,
          count,
          severity: "blocker",
        });
      }
    }
  });
  return findings;
}

function countCategoryMatches(line, category) {
  for (const pattern of CATEGORY_PATTERNS[category] ?? []) {
    if (new RegExp(pattern.source, pattern.flags).test(line)) {
      return 1;
    }
  }
  return 0;
}

function summarizeFindings(fileResults) {
  const summary = Object.fromEntries(ADMIN_WORKFLOWS_QA_REDACTION_CATEGORIES.map((category) => [category, 0]));
  for (const fileResult of fileResults) {
    for (const finding of fileResult.findings) {
      summary[finding.category] += finding.count;
    }
  }
  return summary;
}

function normalizeEvidenceFiles(paths) {
  return [...new Set(paths.map((path) => normalizeString(path)).filter(Boolean))];
}

function splitEvidenceFiles(value) {
  if (!value) {
    return [];
  }
  return value
    .split(/[;,]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function supportSafePath(path) {
  if (isAbsolute(path)) {
    const relativePath = relative(process.cwd(), path).replaceAll("\\", "/");
    if (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.includes(":")) {
      return relativePath;
    }
    return basename(path);
  }
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/");
  if (!relativePath.startsWith("..") && !relativePath.startsWith("/") && relativePath !== "") {
    return relativePath;
  }
  return basename(path);
}

function readEvidenceFileOptions(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (
      (argv[index] === "--evidence-file" || argv[index] === "--file") &&
      argv[index + 1] &&
      !argv[index + 1].startsWith("--")
    ) {
      files.push(argv[index + 1]);
      index += 1;
    }
  }
  return files;
}

function normalizeIssue(value) {
  const issue = normalizeString(value) ?? "3027";
  return issue.startsWith("#") ? issue : `#${issue}`;
}

async function main(argv, env = process.env) {
  try {
    const options = parseAdminWorkflowsQaEvidenceArgs(argv, env);
    if (options.scaffoldAccess) {
      const scaffold = buildAdminWorkflowsQaAccessEvidenceScaffold();
      if (options.outPath) {
        await mkdir(dirname(options.outPath), { recursive: true });
        await writeFile(options.outPath, scaffold);
      }
      console.log(scaffold);
      return 0;
    }
    const evidence = await runAdminWorkflowsQaEvidence(options);
    console.log(JSON.stringify(evidence, null, 2));
    return evidence.verdict === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
