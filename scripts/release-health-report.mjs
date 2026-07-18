#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";

export const RELEASE_HEALTH_REPORT_VERSION = "release-health-report/v1";
const RELEASE_HEALTH_RECORD_VERSION = "release-health/v1";
const BUY_NOW_FRESHNESS_PROBE_PREFIX = "guest-buy-now-freshness-probe/";
const WAKE_DRILL_VERSION = "staging-wake-drills/v1";
const ACCOUNT_CART_PROBE_VERSION = "account-cart-consistency-probe/v1";
const NON_BUY_NOW_UAT_VERSION = "non-buy-now-post-write-freshness-uat/v1";
const ROUTE_MATRIX_EVIDENCE_VERSION = "read-consistency-route-matrix-evidence/v1";
const PUSH_WAKE_CAPACITY_EVIDENCE_VERSION = "push-wake-capacity-evidence/v1";
const EPHEMERAL_VERIFICATION_VERSION = "ephemeral-verification/v1";
const MERGE_GROUP_FAILURE_SIGNATURES_VERSION = "merge-group-failure-signatures/v1";
const DELIVERY_FAILURE_SIGNATURE_VERSION = "delivery-failure-signature/v1";
const FAILURE_SIGNATURE_VERSIONS = new Set([
  MERGE_GROUP_FAILURE_SIGNATURES_VERSION,
  DELIVERY_FAILURE_SIGNATURE_VERSION,
]);
const FRESHNESS_SUSTAINED_WINDOW_TARGET_DAYS = 30;
const CAPACITY_REVIEW_MIN_DEPLOYABLE_ATTEMPTS = 10;
const CAPACITY_REVIEW_STAGING_DURATION_WARN_SECONDS = 20 * 60;
const CAPACITY_REVIEW_PRODUCTION_DURATION_WARN_SECONDS = 20 * 60;
const CAPACITY_REVIEW_IMAGE_SPLIT_REPEAT_COUNT = 3;
const FRESHNESS_EVIDENCE_SCHEMA_VERSIONS = new Set([
  WAKE_DRILL_VERSION,
  ACCOUNT_CART_PROBE_VERSION,
  NON_BUY_NOW_UAT_VERSION,
  ROUTE_MATRIX_EVIDENCE_VERSION,
]);
const SUPPORT_SAFE_EVIDENCE_PATTERNS = [
  { label: "email", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { label: "full-url", pattern: /https?:\/\/[^\s"]+/gi },
  { label: "account-id", pattern: /\b(?:account|acct|usr|user)_[0-9A-Za-z_:-]+\b/g },
  { label: "cart-id", pattern: /\b(?:cart|crt)_[0-9A-Za-z_:-]+\b/g },
  { label: "checkout-session-id", pattern: /\bchk_[0-9A-Za-z_:-]+\b/g },
  { label: "payment-id", pattern: /\bpay_[0-9A-Za-z_:-]+\b/g },
  { label: "payout-id", pattern: /\bpo_[0-9A-Za-z_:-]+\b/g },
  { label: "event-id", pattern: /\bevt_[0-9A-Za-z_:-]+\b/g },
  { label: "token-or-cookie", pattern: /\bBearer\s+[A-Za-z0-9._-]+|chase_sets_[A-Za-z0-9_=-]+/gi },
  { label: "after-write", pattern: /afterWrite=[^&\s")]+|Chase-Sets-Read-After-Write["':=\s]+[^"',\s)]+/gi },
];
const REQUIRED_NON_BUY_NOW_UAT_FLOWS = [
  "account-cart",
  "sell-list-accept-to-checkout",
  "payout-ready-return",
  "listing-freshness",
];
const REQUIRED_NON_BUY_NOW_UAT_TELEMETRY = [
  "account-cart-post-write-consistency",
  "sell-rail-accept-checkout-handoff",
  "payout-ready-handoff",
  "marketplace-listing-freshness-slo",
  "settlement-payout-errors",
  "projection-lag-poison-events",
];
const REQUIRED_ROUTE_MATRIX_ROUTES = [
  { label: "checkout", routeTemplate: "/checkout/buy/session/:sessionid" },
  { label: "cart", routeTemplate: "/account/cart" },
  { label: "sell-list", routeTemplate: "/account/sell-list" },
  { label: "payout", routeTemplate: "/account/payouts/:payoutid" },
  { label: "payment", routeTemplate: "/account/payments/:paymentid" },
  { label: "listing", routeTemplate: "/account/listings/:listingid" },
];

export function parseReleaseHealthReportArgs(argv, env = process.env) {
  return {
    files: readRepeatedOptions(argv, "--file"),
    dir: readOption(argv, "--dir") ?? readEnv("RELEASE_HEALTH_DIR", env) ?? "",
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_REPORT_OUT", env) ?? "",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    // Segment-level projection lag SLO regression gate: the report is
    // read-only by default so operators can inspect posture without failing a
    // build. Pass --gate (or RELEASE_HEALTH_REPORT_GATE=true) from a CI step
    // to turn a failing freshness posture into a non-zero exit code.
    gate: argv.includes("--gate") || readEnv("RELEASE_HEALTH_REPORT_GATE", env) === "true",
  };
}

/**
 * Segment-level projection lag SLO regression gate. Evaluates the
 * already-computed Projection Freshness Evidence posture — Buy Now, wake
 * drills, account-cart, non-Buy-Now UAT, and the checkout/cart/sell-list/
 * payout/payment/listing route-matrix segments — and reports whether a CI
 * caller should fail closed. Coverage gaps (`blocked`/`skipped` routes) are
 * never a regression signal on their own; only actual breaches (missing
 * receipts, timeouts, error rates, SLO threshold misses, or a support-safe
 * redaction failure) block the gate. Kept separate from `buildReleaseHealthReport`
 * so callers that only want the report (no gating) are unaffected.
 */
export function evaluateSegmentSloRegressionGate(report) {
  const freshness = report.summary.freshness;
  const blocked = freshness.posture === "fail";
  const reasons = blocked
    ? [
        freshness.redactionFailureCount > 0
          ? `${freshness.redactionFailureCount} support-safe redaction failure(s)`
          : null,
        freshness.buyNowAbortCount > 0 ? `${freshness.buyNowAbortCount} Buy Now freshness abort(s)` : null,
        freshness.wakeDrillFailureCount > 0 ? `${freshness.wakeDrillFailureCount} wake-drill failure(s)` : null,
        freshness.accountCartFailureCount > 0
          ? `${freshness.accountCartFailureCount} account-cart probe failure(s)`
          : null,
        freshness.nonBuyNowUatFailureCount > 0
          ? `${freshness.nonBuyNowUatFailureCount} non-Buy-Now UAT failure(s)`
          : null,
        freshness.routeMatrixFailureCount > 0
          ? `${freshness.routeMatrixFailureCount} route-matrix segment SLO breach(es)`
          : null,
      ].filter(Boolean)
    : [];

  return {
    blocked,
    posture: freshness.posture,
    reasons: reasons.length > 0 ? reasons : blocked ? [freshness.reason] : [],
  };
}

export async function runReleaseHealthReport(options) {
  const files = [...options.files, ...(options.dir ? await findJsonFiles(options.dir) : [])];
  const artifacts = await Promise.all(
    files.map(async (file) => ({
      file,
      record: JSON.parse(await readFile(file, "utf8")),
    })),
  );
  const classified = classifyReleaseHealthArtifacts(artifacts);
  const report = buildReleaseHealthReport({
    ...options,
    records: classified.releaseRecords,
    evidenceArtifacts: classified.evidenceArtifacts,
    capacityArtifacts: classified.capacityArtifacts,
    verificationArtifacts: classified.verificationArtifacts,
    mergeGroupFailureArtifacts: classified.mergeGroupFailureArtifacts,
    ignoredArtifactCount: classified.ignoredArtifacts.length,
  });

  if (options.outPath) {
    await writeFile(options.outPath, report.markdown);
  }

  return report;
}

export function buildReleaseHealthReport(input) {
  const records = [...input.records].sort(compareReleaseRecords);
  const timing = summarizeTimings(records);
  const slo = evaluateReleaseSloPosture(records, timing);
  const deployableRecords = records.filter((record) => record.deploymentRequired !== false);
  const ci = summarizeCiPosture(records);
  const freshness = summarizeFreshnessEvidence(input.evidenceArtifacts ?? []);
  const gates = summarizeGatePosture(records);
  const capacityEvidence = summarizeCapacityEvidence(input.capacityArtifacts ?? []);
  const stagingElimination = summarizeStagingElimination(records, input.verificationArtifacts ?? []);
  const mergeGroupFailures = summarizeMergeGroupFailureArtifacts(input.mergeGroupFailureArtifacts ?? []);
  const capacityReview = evaluateCapacityAndImageReview({
    records,
    deployableRecords,
    timing,
    slo,
    freshness,
    gates,
    capacityEvidence,
  });
  const summary = {
    releaseCount: records.length,
    deployableReleaseCount: deployableRecords.length,
    successCount: records.filter((record) => record.production?.result === "success").length,
    failureCount: records.filter((record) => ["failure", "cancelled"].includes(record.production?.result)).length,
    stagingAbortCount: deployableRecords.filter(isStagingAbort).length,
    staleSkipCount: deployableRecords.filter(isStaleStagingSkip).length,
    emergencyCount: records.filter((record) => record.releaseMode === "emergency").length,
    lockedCount: records.filter((record) => record.releaseLock?.locked).length,
    rollbackCount: records.filter((record) => ["rollback", "fix-forward"].includes(record.recovery?.mode)).length,
    canaryAbortCount: records.filter((record) => record.canary?.result === "failure").length,
    ci,
    gates,
    timing,
    slo,
    freshness,
    capacityEvidence,
    mergeGroupFailures,
    capacityReview,
    stagingElimination,
  };

  const lines = [
    "# Release Health Report",
    "",
    `Schema: \`${RELEASE_HEALTH_REPORT_VERSION}\``,
    `Checked at: \`${input.checkedAt}\``,
    "",
    "## Summary",
    "",
    `- Releases: ${summary.releaseCount}`,
    `- Deployable release attempts: ${summary.deployableReleaseCount}`,
    `- Production successes: ${summary.successCount}`,
    `- Production failures/cancellations: ${summary.failureCount}`,
    `- Staging aborts: ${summary.stagingAbortCount}`,
    `- Persistent staging-only catch rate: ${summary.stagingElimination.persistentStagingCatchRate === null ? "unknown" : formatPercent(summary.stagingElimination.persistentStagingCatchRate)}`,
    `- Ephemeral verification releases: ${summary.stagingElimination.verificationCount}`,
    `- Staging retirement decision: ${summary.stagingElimination.decision}`,
    `- Stale staging skips: ${summary.staleSkipCount}`,
    `- Emergency releases: ${summary.emergencyCount}`,
    `- Releases with lock active: ${summary.lockedCount}`,
    `- Rollback/fix-forward releases: ${summary.rollbackCount}`,
    `- Canary aborts: ${summary.canaryAbortCount}`,
    `- Blocking gate failures: ${summary.gates.blockingFailures}`,
    `- Advisory gate warnings: ${summary.gates.advisoryWarnings}`,
    `- Deferred-proof gates: ${summary.gates.deferredProof}`,
    `- Merge-group failure signatures: ${summary.mergeGroupFailures.trackedSignatures}`,
    `- Merge-group suspect-flaky findings: ${summary.mergeGroupFailures.suspectFlaky}`,
    `- Merge-group composition attributions: ${summary.mergeGroupFailures.attributed}`,
    `- Average queue wait: ${formatOptionalSeconds(summary.timing.averageQueueWaitSeconds)}`,
    `- Average merge to staging start: ${formatOptionalSeconds(summary.timing.averageMergeToStagingSeconds)}`,
    `- Batch-size posture: ${summary.slo.batchSizeRecommendation}`,
    `- Batch-size reason: ${summary.slo.batchSizeReason}`,
    `- Projection freshness evidence posture: ${summary.freshness.posture}`,
    `- Projection freshness evidence reason: ${summary.freshness.reason}`,
    `- Projection freshness sustained window: ${summary.freshness.sustainedWindow.status}`,
    `- Projection freshness sustained span: ${formatEvidenceWindow(summary.freshness.sustainedWindow)}`,
    `- Projection freshness ready p95: ${formatOptionalMs(summary.freshness.sustainedWindow.readyLatencyP95Ms)}`,
    `- Projection freshness durable convergence p95: ${formatOptionalMs(summary.freshness.sustainedWindow.durableConvergenceP95Ms)}`,
    `- Capacity review posture: ${summary.capacityReview.stagingCapacityDecision}`,
    `- Image group review posture: ${summary.capacityReview.imageGroupDecision}`,
    "",
    "## CI Flake Posture",
    "",
    `- Releases with CI telemetry: ${summary.ci.releaseCountWithTelemetry}`,
    `- Releases affected by CI retries or flakes: ${summary.ci.affectedReleaseCount}`,
    `- Total CI retries: ${summary.ci.retryCount}`,
    `- Total flaky CI failures: ${summary.ci.flakyFailureCount}`,
    "",
    "| Job | Retries | Flaky failures |",
    "| --- | --- | --- |",
    ...formatCiRows(summary.ci),
    "",
    "## Merge-Group Failure Signatures",
    "",
    `- Posture: ${summary.mergeGroupFailures.posture}`,
    `- Latest report window: ${summary.mergeGroupFailures.window}`,
    `- Tracked signatures: ${summary.mergeGroupFailures.trackedSignatures}`,
    `- Suspect-flaky findings: ${summary.mergeGroupFailures.suspectFlaky}`,
    `- Composition-attributed findings: ${summary.mergeGroupFailures.attributed}`,
    `- Deterministic repeats requiring a new commit: ${summary.mergeGroupFailures.deterministicRepeats}`,
    "",
    "| Classification | Signature | Occurrences | PR attribution |",
    "| --- | --- | ---: | --- |",
    ...formatMergeGroupFailureRows(summary.mergeGroupFailures),
    "",
    "## Production Gate Posture",
    "",
    "| Gate | Blocking failures | Advisory warnings | Deferred proof |",
    "| --- | --- | --- | --- |",
    ...formatGateRows(summary.gates),
    "",
    "## Projection Freshness Evidence",
    "",
    `- Evidence artifacts: ${summary.freshness.artifactCount}`,
    `- Support-safe redaction failures: ${summary.freshness.redactionFailureCount}`,
    `- Buy Now probe aborts: ${summary.freshness.buyNowAbortCount}`,
    `- Wake-before-wait drill failures: ${summary.freshness.wakeDrillFailureCount}`,
    `- Account cart probe failures: ${summary.freshness.accountCartFailureCount}`,
    `- Non-Buy-Now UAT failures: ${summary.freshness.nonBuyNowUatFailureCount}`,
    `- Route matrix failures: ${summary.freshness.routeMatrixFailureCount}`,
    `- Sustained-window target: ${FRESHNESS_SUSTAINED_WINDOW_TARGET_DAYS}d`,
    `- Sustained-window status: ${summary.freshness.sustainedWindow.status}`,
    `- Sustained-window artifact span: ${formatEvidenceWindow(summary.freshness.sustainedWindow)}`,
    `- Ready-latency p95 across included freshness artifacts: ${formatOptionalMs(summary.freshness.sustainedWindow.readyLatencyP95Ms)}`,
    `- Durable-convergence p95 across included wake drills: ${formatOptionalMs(summary.freshness.sustainedWindow.durableConvergenceP95Ms)}`,
    "",
    "| Surface | Environment | Flow or route | Decision | Segment evidence | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...formatFreshnessEvidenceRows(summary.freshness),
    "",
    "## Release Process Review Checklist",
    "",
    "- Review staging aborts and stale skips before tuning merge queue rules.",
    "- Increase merge queue batch size only when the SLO posture recommends `increase-to-2`.",
    "- Keep batch size unchanged when sample size, queue timing, or CI flake data is missing or inconclusive.",
    "- Record any developer or operator friction that is not visible in release-health artifacts.",
    "- Open follow-up issues for recurring abort reasons, canary gaps, or rollback-readiness gaps.",
    "",
    "## Capacity and Image Review",
    "",
    `- Review cadence: ${summary.capacityReview.reviewCadence}`,
    `- Evidence source: ${summary.capacityReview.evidenceSource}`,
    `- Staging capacity decision: ${summary.capacityReview.stagingCapacityDecision}`,
    `- Staging capacity reason: ${summary.capacityReview.stagingCapacityReason}`,
    `- Image group decision: ${summary.capacityReview.imageGroupDecision}`,
    `- Image group reason: ${summary.capacityReview.imageGroupReason}`,
    `- Connection budget check: ${summary.capacityReview.connectionBudgetCheck}`,
    `- Production proof check: ${summary.capacityReview.productionProofCheck}`,
    `- Capacity evidence artifacts: ${summary.capacityEvidence.artifactCount}`,
    `- Capacity evidence posture: ${summary.capacityEvidence.posture}`,
    `- Production rolling-overlap headroom: ${formatOptionalCount(summary.capacityEvidence.productionDeployOverlapHeadroom)}`,
    `- Staging backend headroom: ${formatOptionalCount(summary.capacityEvidence.stagingHeadroom)}`,
    `- Staging duration p95: ${formatOptionalSeconds(summary.capacityReview.signals.stagingDurationP95Seconds)}`,
    `- Production duration p95: ${formatOptionalSeconds(summary.capacityReview.signals.productionDurationP95Seconds)}`,
    `- Average staging duration: ${formatOptionalSeconds(summary.timing.averageStagingDurationSeconds)}`,
    `- Average production duration: ${formatOptionalSeconds(summary.timing.averageProductionDurationSeconds)}`,
    "- Staging capacity changes require passing production proof, passing projection freshness, and current connection-budget evidence before Terraform variables are changed.",
    "- Split deployable image groups only when release-health evidence shows repeated wait, build, or rollback cost concentrated in one deployable boundary.",
    "- Keep the shared image when the expected operator cost of another image, dashboard, rollback path, and release gate is higher than the measured release delay.",
    "",
    "| Follow-up issue | Trigger |",
    "| --- | --- |",
    ...formatCapacityFollowUpRows(summary.capacityReview),
    "",
    "## Releases",
    "",
    "| Commit | Category | Mode | Staging | Canary | Production | Drift | Queue wait | Merge to staging | Recovery | Lock |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...records.map(formatReleaseRow),
    "",
    "## SLO Posture",
    "",
    "| Signal | Threshold | Current | Status |",
    "| --- | --- | --- | --- |",
    ...formatSloRows(summary.slo),
    "",
  ];

  return {
    schemaVersion: RELEASE_HEALTH_REPORT_VERSION,
    checkedAt: input.checkedAt,
    summary,
    markdown: `${lines.join("\n")}\n`,
  };
}

function summarizeGatePosture(records) {
  const gates = new Map();
  let blockingFailures = 0;
  let advisoryWarnings = 0;
  let deferredProof = 0;

  for (const record of records) {
    for (const gate of Array.isArray(record.gates) ? record.gates : []) {
      const id = typeof gate.id === "string" && gate.id.trim() ? gate.id.trim() : "unknown";
      const previous = gates.get(id) ?? { id, blockingFailures: 0, advisoryWarnings: 0, deferredProof: 0 };
      if (gate.severity === "blocking" && gate.status === "fail") {
        previous.blockingFailures += 1;
        blockingFailures += 1;
      }
      if (gate.severity === "advisory" && gate.status === "warn") {
        previous.advisoryWarnings += 1;
        advisoryWarnings += 1;
      }
      if (gate.severity === "deferred-proof") {
        previous.deferredProof += 1;
        deferredProof += 1;
      }
      gates.set(id, previous);
    }
  }

  return {
    blockingFailures,
    advisoryWarnings,
    deferredProof,
    gates: [...gates.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function classifyReleaseHealthArtifacts(artifacts) {
  const releaseRecords = [];
  const evidenceArtifacts = [];
  const capacityArtifacts = [];
  const verificationArtifacts = [];
  const mergeGroupFailureArtifacts = [];
  const ignoredArtifacts = [];

  for (const artifact of artifacts) {
    const record = artifact.record;
    const schemaVersion = typeof record?.schemaVersion === "string" ? record.schemaVersion : "";
    if (schemaVersion === RELEASE_HEALTH_RECORD_VERSION) {
      releaseRecords.push(record);
    } else if (isFreshnessEvidenceRecord(record)) {
      evidenceArtifacts.push({ ...artifact, record });
    } else if (schemaVersion === PUSH_WAKE_CAPACITY_EVIDENCE_VERSION) {
      capacityArtifacts.push({ ...artifact, record });
    } else if (schemaVersion === EPHEMERAL_VERIFICATION_VERSION) {
      verificationArtifacts.push({ ...artifact, record });
    } else if (FAILURE_SIGNATURE_VERSIONS.has(schemaVersion)) {
      mergeGroupFailureArtifacts.push({ ...artifact, record });
    } else {
      ignoredArtifacts.push(artifact);
    }
  }

  return {
    releaseRecords,
    evidenceArtifacts,
    capacityArtifacts,
    verificationArtifacts,
    mergeGroupFailureArtifacts,
    ignoredArtifacts,
  };
}

function summarizeStagingElimination(records, artifacts) {
  const measured = records.filter((record) => ["success", "failure", "cancelled"].includes(record.staging?.result));
  const catches = measured.filter((record) => ["failure", "cancelled"].includes(record.staging?.result));
  const verificationRecords = artifacts.map((artifact) => artifact.record ?? artifact);
  const verificationSuccessCount = verificationRecords.filter((record) => record.result === "success").length;
  const verificationFailureCount = verificationRecords.filter((record) => record.result === "failure").length;
  const persistentStagingCatchRate = measured.length === 0 ? null : catches.length / measured.length;
  const eligible =
    measured.length >= 10 && catches.length === 0 && verificationSuccessCount > 0 && verificationFailureCount === 0;
  return {
    measuredReleaseCount: measured.length,
    persistentStagingCatchCount: catches.length,
    persistentStagingCatchRate,
    verificationCount: verificationRecords.length,
    verificationSuccessCount,
    verificationFailureCount,
    decision: eligible ? "eligible-for-explicit-retirement-review" : "retain-persistent-staging",
  };
}

function summarizeMergeGroupFailureArtifacts(artifacts) {
  const latest = artifacts
    .map((artifact) => artifact.record ?? artifact)
    .filter((record) => FAILURE_SIGNATURE_VERSIONS.has(record?.schemaVersion))
    .sort((left, right) => Date.parse(right.checkedAt ?? "") - Date.parse(left.checkedAt ?? ""))[0];
  if (!latest) {
    return {
      posture: "not-provided",
      window: "unknown",
      trackedSignatures: 0,
      suspectFlaky: 0,
      attributed: 0,
      deterministicRepeats: 0,
      failures: [],
    };
  }
  if (latest.schemaVersion === DELIVERY_FAILURE_SIGNATURE_VERSION) {
    const circuits = Array.isArray(latest.circuits) ? latest.circuits : [];
    const active = circuits.filter((circuit) => ["observed", "holding", "repairing"].includes(circuit.state));
    return {
      posture: latest.counts?.holding > 0 ? "holding" : active.length > 0 ? "warning" : "success",
      window: `${latest.mode ?? "unknown"} at ${latest.checkedAt ?? "unknown"}`,
      trackedSignatures: latest.counts?.activeSignatures ?? active.length,
      suspectFlaky: latest.counts?.flakeEvidence ?? latest.flakeEvidence?.length ?? 0,
      attributed: 0,
      deterministicRepeats: latest.counts?.holding ?? active.filter((circuit) => circuit.state === "holding").length,
      failures: active.map((circuit) => ({
        classification: circuit.state,
        testFile: circuit.testIdentity?.file ?? circuit.job,
        testName: circuit.testIdentity?.title ?? circuit.step,
        occurrenceCount: circuit.occurrenceCount,
        attributedPr: null,
      })),
    };
  }
  return {
    posture: latest.failures?.length ? "warning" : "success",
    window: latest.window ? `${latest.window.start} to ${latest.window.end}` : "unknown",
    trackedSignatures: latest.counts?.trackedSignatures ?? latest.failures?.length ?? 0,
    suspectFlaky:
      latest.counts?.suspectFlaky ??
      latest.failures?.filter((failure) => failure.classification === "suspect-flaky").length ??
      0,
    attributed:
      latest.counts?.attributed ??
      latest.failures?.filter((failure) => failure.classification === "attributed-to-pr").length ??
      0,
    deterministicRepeats:
      latest.counts?.deterministicRepeats ??
      latest.failures?.filter((failure) => failure.classification === "new-commit-required").length ??
      0,
    failures: Array.isArray(latest.failures) ? latest.failures : [],
  };
}

function formatMergeGroupFailureRows(summary) {
  if (summary.failures.length === 0) {
    return ["| none | no failed merge-group signature in the latest report | 0 | none |"];
  }
  return summary.failures.map((failure) => {
    const signature = `${failure.testFile ?? "unknown"} > ${failure.testName ?? "unknown"}`;
    return `| ${escapeMarkdownCell(failure.classification ?? "observed")} | ${escapeMarkdownCell(signature)} | ${failure.occurrenceCount ?? 0} | ${failure.attributedPr ? `PR #${failure.attributedPr}` : "none"} |`;
  });
}

function formatReleaseRow(record) {
  return [
    shortCommit(record.releaseCommit),
    record.releaseCategory?.primary ?? "unknown",
    record.releaseMode ?? "unknown",
    record.staging?.result ?? "unknown",
    record.canary?.result ?? "unknown",
    record.production?.result ?? "unknown",
    formatDrift(record.mainToProductionDrift),
    formatDuration(record.queue?.queuedAt, record.queue?.mergedAt),
    formatDuration(record.queue?.mergedAt, record.staging?.startedAt),
    formatRecovery(record.recovery),
    formatLock(record.releaseLock),
  ]
    .map(escapeMarkdownCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

export function evaluateReleaseSloPosture(records, timing = summarizeTimings(records)) {
  const releaseCount = records.length;
  const deployedRecords = records.filter((record) => record.deploymentRequired !== false);
  const ci = summarizeCiPosture(records);
  const productionFailureRate = rate(
    deployedRecords.filter((record) => ["failure", "cancelled"].includes(record.production?.result)).length,
    deployedRecords.length,
  );
  const stagingFailureRate = rate(deployedRecords.filter(isStagingAbort).length, deployedRecords.length);
  const recoveryRate = rate(
    records.filter((record) => ["rollback", "fix-forward"].includes(record.recovery?.mode)).length,
    releaseCount,
  );
  const canaryAbortRate = rate(records.filter((record) => record.canary?.result === "failure").length, releaseCount);
  const maxDriftCommits = Math.max(0, ...records.map((record) => record.mainToProductionDrift?.commits ?? 0));
  const p95QueueWaitSeconds = percentile(timing.queueWaitSeconds, 0.95);
  const ciAffectedRate =
    ci.releaseCountWithTelemetry === 0 ? null : rate(ci.affectedReleaseCount, ci.releaseCountWithTelemetry);

  const signals = {
    deployableSampleSize: {
      threshold: ">= 10 deployable attempts",
      current: String(deployedRecords.length),
      passes: deployedRecords.length >= 10,
    },
    stagingFailureRate: {
      threshold: "<= 5%",
      current: formatPercent(stagingFailureRate),
      passes: stagingFailureRate <= 0.05,
    },
    productionFailureRate: {
      threshold: "<= 2%",
      current: formatPercent(productionFailureRate),
      passes: productionFailureRate <= 0.02,
    },
    recoveryRate: {
      threshold: "<= 2%",
      current: formatPercent(recoveryRate),
      passes: recoveryRate <= 0.02,
    },
    maxDriftCommits: {
      threshold: "<= 3 commits",
      current: String(maxDriftCommits),
      passes: maxDriftCommits <= 3,
    },
    p95QueueWait: {
      threshold: "<= 30m",
      current: formatOptionalSeconds(p95QueueWaitSeconds),
      passes: p95QueueWaitSeconds !== null && p95QueueWaitSeconds <= 1800,
    },
    canaryAbortRate: {
      threshold: "<= 5%",
      current: formatPercent(canaryAbortRate),
      passes: canaryAbortRate <= 0.05,
    },
    ciRetryOrFlakeRate: {
      threshold: "<= 5% when telemetry is present",
      current: ciAffectedRate === null ? "unknown" : formatPercent(ciAffectedRate),
      passes: ciAffectedRate === null || ciAffectedRate <= 0.05,
    },
  };
  const hardFailure = [
    signals.stagingFailureRate,
    signals.productionFailureRate,
    signals.recoveryRate,
    signals.maxDriftCommits,
    signals.canaryAbortRate,
    signals.ciRetryOrFlakeRate,
  ].some((signal) => !signal.passes);
  const missingTuningData = !signals.deployableSampleSize.passes || !signals.p95QueueWait.passes;
  const passes = Object.values(signals).every((signal) => signal.passes);

  return {
    signals,
    batchSizeRecommendation: hardFailure ? "decrease-or-hold" : missingTuningData ? "hold" : "increase-to-2",
    batchSizeReason: hardFailure
      ? "One or more release-health signals exceeds the release process SLO threshold."
      : missingTuningData
        ? "At least 10 deployable attempts and known p95 queue wait are required before increasing batch size."
        : passes
          ? "Release-health evidence supports testing a merge queue batch size of 2."
          : "Hold batch size until release-health evidence is complete.",
  };
}

function summarizeCapacityEvidence(artifacts) {
  const records = artifacts.map((artifact) => artifact.record ?? artifact);
  const latest = records
    .filter((record) => record?.schemaVersion === PUSH_WAKE_CAPACITY_EVIDENCE_VERSION)
    .sort((a, b) => Date.parse(b.checkedAt ?? "") - Date.parse(a.checkedAt ?? ""))[0];

  if (!latest) {
    return {
      artifactCount: records.length,
      posture: "not-provided",
      reason: "No push-wake capacity evidence artifact was included in the release-health report input.",
      latestCheckedAt: null,
      stagingHeadroom: null,
      productionDeployOverlapHeadroom: null,
      listenerExpansionPosture: "unknown",
    };
  }

  const stagingHeadroom = numericHeadroom(latest.environments?.staging?.deployOverlap?.headroom);
  const productionDeployOverlapHeadroom = numericHeadroom(latest.environments?.production?.deployOverlap?.headroom);
  const hasBudgetHeadroom =
    stagingHeadroom !== null &&
    stagingHeadroom >= 0 &&
    productionDeployOverlapHeadroom !== null &&
    productionDeployOverlapHeadroom >= 0;

  return {
    artifactCount: records.length,
    posture: hasBudgetHeadroom ? "pass" : "fail",
    reason: hasBudgetHeadroom
      ? "Latest push-wake capacity evidence keeps staging and production rolling-overlap connection budgets within the checked-in limits."
      : "Latest push-wake capacity evidence is missing headroom or exceeds a checked-in connection budget.",
    latestCheckedAt: latest.checkedAt ?? null,
    stagingHeadroom,
    productionDeployOverlapHeadroom,
    listenerExpansionPosture: latest.expansionDecision?.posture ?? "unknown",
  };
}

function evaluateCapacityAndImageReview({
  records,
  deployableRecords,
  timing,
  slo,
  freshness,
  gates,
  capacityEvidence,
}) {
  const stagingAbortCount = deployableRecords.filter(isStagingAbort).length;
  const staleSkipCount = deployableRecords.filter(isStaleStagingSkip).length;
  const productionFailureCount = deployableRecords.filter((record) =>
    ["failure", "cancelled"].includes(record.production?.result),
  ).length;
  const canaryAbortCount = records.filter((record) => record.canary?.result === "failure").length;
  const rollbackCount = records.filter((record) => ["rollback", "fix-forward"].includes(record.recovery?.mode)).length;
  const productionSuccessCount = deployableRecords.filter((record) => record.production?.result === "success").length;
  const stagingDurationP95Seconds = percentile(timing.stagingDurationSeconds, 0.95);
  const productionDurationP95Seconds = percentile(timing.productionDurationSeconds, 0.95);
  const queueWaitP95Seconds = percentile(timing.queueWaitSeconds, 0.95);
  const deployableSampleReady = deployableRecords.length >= CAPACITY_REVIEW_MIN_DEPLOYABLE_ATTEMPTS;
  const connectionBudgetPass = capacityEvidence.posture === "pass";
  const productionProofPass =
    productionSuccessCount > 0 &&
    productionFailureCount === 0 &&
    canaryAbortCount === 0 &&
    gates.blockingFailures === 0;
  const freshnessPass = freshness.posture === "pass";
  const highStagingDuration =
    stagingDurationP95Seconds !== null && stagingDurationP95Seconds > CAPACITY_REVIEW_STAGING_DURATION_WARN_SECONDS;
  const highProductionDuration =
    productionDurationP95Seconds !== null &&
    productionDurationP95Seconds > CAPACITY_REVIEW_PRODUCTION_DURATION_WARN_SECONDS;

  let stagingCapacityDecision = "hold-current-capacity";
  let stagingCapacityReason =
    "Capacity changes require enough release samples, passing production proof, passing freshness evidence, and current connection-budget evidence.";

  if (!connectionBudgetPass) {
    stagingCapacityReason =
      "Hold current capacity until a passing push-wake capacity evidence artifact proves staging and production connection budgets.";
  } else if (!productionProofPass) {
    stagingCapacityReason =
      "Hold current capacity until production proof has a successful release with no production failure or canary abort in the reviewed sample.";
  } else if (!freshnessPass) {
    stagingCapacityReason = "Hold current capacity until projection freshness evidence is passing.";
  } else if (!deployableSampleReady) {
    stagingCapacityReason = `Hold current capacity until at least ${CAPACITY_REVIEW_MIN_DEPLOYABLE_ATTEMPTS} deployable release attempts are included.`;
  } else if (stagingAbortCount > 0 || staleSkipCount > 0 || productionFailureCount > 0 || rollbackCount > 0) {
    stagingCapacityReason =
      "Hold current capacity while release aborts, stale skips, production failures, or recovery events are reviewed.";
  } else if (highStagingDuration || highProductionDuration) {
    stagingCapacityDecision = "open-capacity-review-issue";
    stagingCapacityReason =
      "Open a capacity review issue because release duration p95 exceeds the review threshold while proof and connection budgets are otherwise passing.";
  } else {
    stagingCapacityDecision = "eligible-for-staging-capacity-downsize-review";
    stagingCapacityReason =
      "Evidence is healthy enough to review a cautious staging downsize window, but Terraform capacity variables still require an explicit PR.";
  }

  const imagePressureSignals = [
    queueWaitP95Seconds !== null && queueWaitP95Seconds > 1800,
    highStagingDuration,
    highProductionDuration,
    rollbackCount > 0,
    stagingAbortCount > 0,
    staleSkipCount > 0,
  ].filter(Boolean).length;
  const imageGroupDecision =
    imagePressureSignals >= CAPACITY_REVIEW_IMAGE_SPLIT_REPEAT_COUNT
      ? "open-image-group-split-investigation-issue"
      : "deferred-shared-image";
  const imageGroupReason =
    imageGroupDecision === "open-image-group-split-investigation-issue"
      ? "Repeated release-health pressure signals crossed the investigation threshold; require boundary-specific ownership, dashboard, rollback, and gate evidence before splitting."
      : "Keep the shared platform image until repeated release-health pressure signals show an image boundary is the dominant release cost.";

  return {
    reviewCadence: "weekly during milestone review and after each production deploy batch",
    evidenceSource: "release-health/v1 records plus push-wake-capacity-evidence/v1 and projection freshness artifacts",
    stagingCapacityDecision,
    stagingCapacityReason,
    imageGroupDecision,
    imageGroupReason,
    connectionBudgetCheck: connectionBudgetPass ? "pass" : capacityEvidence.posture,
    productionProofCheck: productionProofPass ? "pass" : "hold",
    followUpIssues: capacityFollowUpIssues({
      connectionBudgetPass,
      productionProofPass,
      freshnessPass,
      deployableSampleReady,
      highStagingDuration,
      highProductionDuration,
      imageGroupDecision,
      stagingAbortCount,
      staleSkipCount,
    }),
    signals: {
      deployableAttemptCount: deployableRecords.length,
      stagingAbortCount,
      staleSkipCount,
      productionFailureCount,
      canaryAbortCount,
      rollbackCount,
      blockingGateFailures: gates.blockingFailures,
      queueWaitP95Seconds,
      stagingDurationP95Seconds,
      productionDurationP95Seconds,
      connectionBudgetPosture: capacityEvidence.posture,
      capacityListenerExpansionPosture: capacityEvidence.listenerExpansionPosture,
      batchSizeRecommendation: slo.batchSizeRecommendation,
    },
  };
}

function capacityFollowUpIssues(input) {
  const issues = [];
  if (!input.connectionBudgetPass) {
    issues.push({
      title: "Refresh or fix push-wake capacity evidence",
      trigger: "Connection-budget evidence is missing or failing.",
    });
  }
  if (!input.productionProofPass) {
    issues.push({
      title: "Restore production proof before capacity tuning",
      trigger: "Production proof is missing, failed, or canary aborted.",
    });
  }
  if (!input.freshnessPass) {
    issues.push({
      title: "Resolve projection freshness before capacity tuning",
      trigger: "Projection freshness evidence is not passing.",
    });
  }
  if (!input.deployableSampleReady) {
    issues.push({
      title: "Collect enough release-health samples for capacity review",
      trigger: `Fewer than ${CAPACITY_REVIEW_MIN_DEPLOYABLE_ATTEMPTS} deployable attempts are included.`,
    });
  }
  if (input.highStagingDuration || input.highProductionDuration) {
    issues.push({
      title: "Review staging capacity from release duration evidence",
      trigger: "Staging or production duration p95 exceeded the capacity review threshold.",
    });
  }
  if (input.stagingAbortCount > 0 || input.staleSkipCount > 0) {
    issues.push({
      title: "Review staging abort and stale-skip causes",
      trigger: "Release-health records include staging aborts or stale staging skips.",
    });
  }
  if (input.imageGroupDecision === "open-image-group-split-investigation-issue") {
    issues.push({
      title: "Investigate platform image group split",
      trigger: "Repeated release-health pressure signals crossed the image split investigation threshold.",
    });
  }

  return issues;
}

function summarizeFreshnessEvidence(artifacts) {
  const rows = [];

  for (const [artifactIndex, artifact] of artifacts.entries()) {
    const record = artifact.record ?? artifact;
    const redactionFailures = findSupportSafeEvidenceFailures(record);
    const artifactRows = toArray(summarizeFreshnessArtifact(record));
    const evidenceKey = artifact.file ?? `artifact-${artifactIndex}`;
    for (const row of artifactRows) {
      rows.push({
        ...row,
        evidenceKey,
        redactionFailures,
        status: redactionFailures.length > 0 ? "fail" : row.status,
        decision: redactionFailures.length > 0 ? "redaction-failed" : row.decision,
      });
    }
  }

  const redactionFailureCount = new Set(
    rows.filter((row) => row.redactionFailures.length > 0).map((row) => row.evidenceKey),
  ).size;
  const buyNowAbortCount = rows.filter((row) => row.kind === "buy-now" && row.status === "fail").length;
  const wakeDrillFailureCount = rows.filter((row) => row.kind === "wake-drill" && row.status === "fail").length;
  const accountCartFailureCount = rows.filter((row) => row.kind === "account-cart" && row.status === "fail").length;
  const nonBuyNowUatFailureCount = rows.filter((row) => row.kind === "non-buy-now-uat" && row.status === "fail").length;
  const routeMatrixFailureCount = rows.filter((row) => row.kind === "route-matrix" && row.status === "fail").length;
  const artifactCount = artifacts.length;
  const sustainedWindow = summarizeFreshnessSustainedWindow(rows);
  const failureCount =
    redactionFailureCount +
    buyNowAbortCount +
    wakeDrillFailureCount +
    accountCartFailureCount +
    nonBuyNowUatFailureCount +
    routeMatrixFailureCount;

  return {
    artifactCount,
    rows,
    redactionFailureCount,
    buyNowAbortCount,
    wakeDrillFailureCount,
    accountCartFailureCount,
    nonBuyNowUatFailureCount,
    routeMatrixFailureCount,
    sustainedWindow,
    posture: artifactCount === 0 ? "not-provided" : failureCount === 0 ? "pass" : "fail",
    reason:
      artifactCount === 0
        ? "No projection freshness evidence artifacts were included in the report input."
        : failureCount === 0
          ? "Included projection freshness evidence artifacts are passing and support-safe."
          : "One or more projection freshness evidence artifacts failed or were not support-safe.",
  };
}

function summarizeFreshnessArtifact(record) {
  if (isBuyNowFreshnessProbe(record)) {
    return {
      kind: "buy-now",
      surface: "buy-now-checkout",
      environment: normalizeEvidenceLabel(record.environment),
      flowOrRoute: normalizeEvidenceLabel(record.flow),
      decision: normalizeEvidenceLabel(record.promotionDecision),
      segmentEvidence: formatBuyNowSegmentEvidence(record),
      timestampMs: freshnessEvidenceTimestampMs(record),
      readyLatencyMs: nonNegativeIntegerOrNull(record.readyLatencyMs),
      status: record.promotionDecision === "promote" || record.promotionDecision === "warn" ? "pass" : "fail",
    };
  }
  if (record.schemaVersion === WAKE_DRILL_VERSION) {
    const segmentSlo = record.segmentSlo ?? {};
    const singleWriteReadyP95Ms = nonNegativeIntegerOrNull(segmentSlo.browser?.singleWrite?.readyLatencyMs?.p95);
    const loadReadyP95Ms = nonNegativeIntegerOrNull(segmentSlo.browser?.load?.readyLatencyMs?.p95);
    return {
      kind: "wake-drill",
      surface: "wake-before-wait",
      environment: normalizeEvidenceLabel(record.environment),
      flowOrRoute: normalizeEvidenceLabel(record.drillKind),
      decision: normalizeEvidenceLabel(record.verdict),
      segmentEvidence: [
        `single-write ${segmentSlo.browser?.singleWrite?.sloStatus ?? "unknown"}`,
        `load ${segmentSlo.browser?.load?.sloStatus ?? "unknown"}`,
        `durable ${segmentSlo.durableConvergence?.status ?? "unknown"}`,
      ].join("; "),
      timestampMs: freshnessEvidenceTimestampMs(record),
      readyLatencyMs: loadReadyP95Ms ?? singleWriteReadyP95Ms,
      durableConvergenceMs: nonNegativeIntegerOrNull(segmentSlo.durableConvergence?.convergedAfterMs),
      status: record.verdict === "pass" ? "pass" : "fail",
    };
  }
  if (record.schemaVersion === ACCOUNT_CART_PROBE_VERSION) {
    return {
      kind: "account-cart",
      surface: "account-cart",
      environment: normalizeEvidenceLabel(record.environment),
      flowOrRoute: normalizeEvidenceLabel(record.routeTemplate),
      decision: normalizeEvidenceLabel(record.promotionDecision),
      segmentEvidence: `${record.observedOutcomes?.length ?? 0} outcomes; ${record.blockers?.length ?? 0} blockers`,
      timestampMs: freshnessEvidenceTimestampMs(record),
      status: record.promotionDecision === "promote" ? "pass" : "fail",
    };
  }
  if (record.schemaVersion === NON_BUY_NOW_UAT_VERSION) {
    const evaluation = evaluateNonBuyNowUatEvidence(record);
    return {
      kind: "non-buy-now-uat",
      surface: "chrome-uat",
      environment: normalizeEvidenceLabel(record.environment),
      flowOrRoute: "account-cart/sell-list/payout/listing",
      decision: evaluation.failures.length === 0 ? "complete" : "incomplete",
      segmentEvidence: `${evaluation.coveredFlows}/${REQUIRED_NON_BUY_NOW_UAT_FLOWS.length} flows; ${evaluation.coveredTelemetry}/${REQUIRED_NON_BUY_NOW_UAT_TELEMETRY.length} telemetry`,
      timestampMs: freshnessEvidenceTimestampMs(record),
      status: evaluation.failures.length === 0 ? "pass" : "fail",
    };
  }
  if (record.schemaVersion === ROUTE_MATRIX_EVIDENCE_VERSION) {
    return summarizeRouteMatrixEvidence(record);
  }

  return {
    kind: "unknown",
    surface: "unknown",
    environment: "unknown",
    flowOrRoute: "unknown",
    decision: "ignored",
    segmentEvidence: "unknown schema",
    timestampMs: freshnessEvidenceTimestampMs(record),
    status: "fail",
  };
}

function summarizeFreshnessSustainedWindow(rows) {
  const evidenceTimeByKey = new Map();
  for (const row of rows) {
    if (Number.isInteger(row.timestampMs) && !evidenceTimeByKey.has(row.evidenceKey)) {
      evidenceTimeByKey.set(row.evidenceKey, row.timestampMs);
    }
  }
  const evidenceTimes = [...evidenceTimeByKey.values()];
  const readyLatencySamples = rows.map((row) => row.readyLatencyMs).filter((value) => Number.isInteger(value));
  const durableConvergenceSamples = rows
    .map((row) => row.durableConvergenceMs)
    .filter((value) => Number.isInteger(value));
  if (evidenceTimes.length === 0) {
    return {
      targetDays: FRESHNESS_SUSTAINED_WINDOW_TARGET_DAYS,
      artifactCountWithTimestamps: 0,
      firstEvidenceAt: null,
      latestEvidenceAt: null,
      spanDays: null,
      status: "not-measured",
      readyLatencyP95Ms: percentile(readyLatencySamples, 0.95),
      durableConvergenceP95Ms: percentile(durableConvergenceSamples, 0.95),
    };
  }

  const firstEvidenceMs = Math.min(...evidenceTimes);
  const latestEvidenceMs = Math.max(...evidenceTimes);
  const spanDays = Math.floor((latestEvidenceMs - firstEvidenceMs) / (24 * 60 * 60 * 1000));
  return {
    targetDays: FRESHNESS_SUSTAINED_WINDOW_TARGET_DAYS,
    artifactCountWithTimestamps: evidenceTimes.length,
    firstEvidenceAt: new Date(firstEvidenceMs).toISOString(),
    latestEvidenceAt: new Date(latestEvidenceMs).toISOString(),
    spanDays,
    status: spanDays >= FRESHNESS_SUSTAINED_WINDOW_TARGET_DAYS ? "meets-window" : "short-window",
    readyLatencyP95Ms: percentile(readyLatencySamples, 0.95),
    durableConvergenceP95Ms: percentile(durableConvergenceSamples, 0.95),
  };
}

function evaluateNonBuyNowUatEvidence(record) {
  const flowOutcomes = new Map(
    (Array.isArray(record.flows) ? record.flows : []).map((flow) => [flow.name, normalizeEvidenceLabel(flow.outcome)]),
  );
  const telemetry = record.telemetry && typeof record.telemetry === "object" ? record.telemetry : {};
  const failures = [];
  let coveredFlows = 0;
  let coveredTelemetry = 0;

  for (const flowName of REQUIRED_NON_BUY_NOW_UAT_FLOWS) {
    const outcome = flowOutcomes.get(flowName);
    if (!outcome) {
      failures.push(`missing-flow:${flowName}`);
    } else if (["fallback-failure", "freshness-timeout", "permanent-not-found", "5xx"].includes(outcome)) {
      failures.push(`failed-flow:${flowName}`);
    } else {
      coveredFlows += 1;
    }
  }

  for (const telemetryName of REQUIRED_NON_BUY_NOW_UAT_TELEMETRY) {
    const value = normalizeEvidenceLabel(telemetry[telemetryName]);
    if (value === "zero" || value === "within-slo") {
      coveredTelemetry += 1;
    } else {
      failures.push(`failed-telemetry:${telemetryName}`);
    }
  }

  return { coveredFlows, coveredTelemetry, failures };
}

function summarizeRouteMatrixEvidence(record) {
  const routeMeasurements = Array.isArray(record.routes)
    ? record.routes
    : Array.isArray(record.routeMatrix)
      ? record.routeMatrix
      : [];
  const rows = routeMeasurements.map((route) => summarizeRouteMatrixRoute(record, route));
  const routeTemplates = new Set(rows.map((row) => row.normalizedRouteTemplate));
  const missingRoutes = REQUIRED_ROUTE_MATRIX_ROUTES.filter((route) => !routeTemplates.has(route.routeTemplate));

  return [
    ...rows.map(({ normalizedRouteTemplate: _normalizedRouteTemplate, ...row }) => row),
    {
      kind: "route-matrix",
      surface: "wake-route-matrix",
      environment: normalizeEvidenceLabel(record.environment),
      flowOrRoute: "coverage",
      decision: missingRoutes.length === 0 ? "complete" : "incomplete",
      segmentEvidence:
        missingRoutes.length === 0
          ? `${REQUIRED_ROUTE_MATRIX_ROUTES.length}/${REQUIRED_ROUTE_MATRIX_ROUTES.length} required routes`
          : `${REQUIRED_ROUTE_MATRIX_ROUTES.length - missingRoutes.length}/${REQUIRED_ROUTE_MATRIX_ROUTES.length} required routes; missing ${missingRoutes.map((route) => route.label).join(",")}`,
      timestampMs: freshnessEvidenceTimestampMs(record),
      status: missingRoutes.length === 0 ? "pass" : "fail",
    },
  ];
}

function summarizeRouteMatrixRoute(record, route) {
  const wake = route.wakeBeforeWait ?? route.wake ?? {};
  const routeStatus = normalizeEvidenceLabel(wake.status ?? route.status ?? route.decision ?? route.verdict);
  const p95Ms = nonNegativeIntegerOrNull(wake.p95Ms ?? wake.readyLatencyP95Ms ?? wake.readyLatencyMs?.p95);
  const p99Ms = nonNegativeIntegerOrNull(wake.p99Ms ?? wake.readyLatencyP99Ms ?? wake.readyLatencyMs?.p99);
  const sampleCount = nonNegativeInteger(
    wake.sampleCount ?? wake.observationCount ?? wake.count ?? route.sampleCount ?? route.observationCount,
  );
  const timeoutRate = nonNegativeRateOrNull(wake.timeoutRate);
  const errorRate = nonNegativeRateOrNull(wake.workSignalErrorRate ?? wake.errorRate);
  const missingReceiptCount = nonNegativeInteger(wake.missingReceiptCount);
  const diagnosticMissingReceiptCount = nonNegativeInteger(wake.diagnosticMissingReceiptCount);
  const missingTargetContextCount = nonNegativeInteger(wake.missingTargetContextCount);
  const exactDependencyFallbackCount = nonNegativeInteger(wake.exactDependencyFallbackCount);
  const targetContext = normalizeEvidenceLabel(wake.targetContext ?? route.targetContext);
  const projection = normalizeEvidenceLabel(
    route.projectionName ?? route.projection ?? route.readModel ?? wake.projectionName ?? wake.projection,
  );
  // A route the sampler could not drive by design (`blocked`, e.g. a
  // not-yet-available payout/listing persona) or that was skipped for an
  // in-flight deploy window is a documented coverage gap, never an SLO
  // regression — matches the same distinction `routeMatrixRouteEvidence` in
  // read-consistency-route-matrix-evidence.mjs already makes for its own exit
  // code. Keep the row's real status instead of collapsing it into "fail" so
  // the segment-level regression gate does not go permanently red on a
  // known, out-of-scope coverage gap.
  const status = isRouteMatrixCoverageGapStatus(routeStatus)
    ? routeStatus
    : isPassingRouteMatrixStatus(routeStatus) &&
        p95Ms !== null &&
        p99Ms !== null &&
        sampleCount > 0 &&
        (timeoutRate ?? 0) === 0 &&
        (errorRate ?? 0) === 0 &&
        missingReceiptCount === 0 &&
        missingTargetContextCount === 0 &&
        exactDependencyFallbackCount === 0 &&
        targetContext !== "unknown" &&
        projection !== "unknown"
      ? "pass"
      : "fail";

  return {
    kind: "route-matrix",
    surface: "wake-route-matrix",
    environment: normalizeEvidenceLabel(record.environment),
    flowOrRoute: normalizeEvidenceLabel(route.routeTemplate),
    normalizedRouteTemplate: normalizeEvidenceLabel(route.routeTemplate),
    decision: routeStatus,
    segmentEvidence: [
      `wake ${routeStatus}`,
      `samples ${sampleCount}`,
      `p95 ${formatOptionalMs(p95Ms)}`,
      `p99 ${formatOptionalMs(p99Ms)}`,
      `timeout ${formatOptionalRate(timeoutRate)}`,
      `errors ${formatOptionalRate(errorRate)}`,
      `missing-receipt ${missingReceiptCount}`,
      `plain-read-missing-receipt ${diagnosticMissingReceiptCount}`,
      `missing-target ${missingTargetContextCount}`,
      `fallback ${exactDependencyFallbackCount}`,
      `target ${targetContext}`,
      `projection ${projection}`,
    ].join("; "),
    timestampMs: freshnessEvidenceTimestampMs(record),
    readyLatencyMs: p95Ms,
    status,
  };
}

function isPassingRouteMatrixStatus(status) {
  return ["fresh", "green", "ok", "pass", "promote", "within-slo"].includes(status);
}

function isRouteMatrixCoverageGapStatus(status) {
  return ["blocked", "skipped"].includes(status);
}

function formatFreshnessEvidenceRows(freshness) {
  if (freshness.rows.length === 0) {
    return ["| none | unknown | unknown | not-provided | no evidence artifacts included | warn |"];
  }

  return freshness.rows.map((row) =>
    [row.surface, row.environment, row.flowOrRoute, row.decision, row.segmentEvidence, row.status]
      .map(escapeMarkdownCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  );
}

function formatBuyNowSegmentEvidence(record) {
  const segments = record.segments ?? {};
  return [
    `ready ${formatOptionalMs(record.readyLatencyMs)}`,
    `write-ready ${formatOptionalMs(segments.writeToCheckoutReadyMs)}`,
    `doc-ready ${formatOptionalMs(segments.documentToReadyMs)}`,
    `failure ${normalizeEvidenceLabel(record.failureReason)}`,
  ].join("; ");
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function isFreshnessEvidenceRecord(record) {
  if (isBuyNowFreshnessProbe(record)) {
    return true;
  }
  return FRESHNESS_EVIDENCE_SCHEMA_VERSIONS.has(record?.schemaVersion);
}

function isBuyNowFreshnessProbe(record) {
  return typeof record?.schemaVersion === "string" && record.schemaVersion.startsWith(BUY_NOW_FRESHNESS_PROBE_PREFIX);
}

function summarizeTimings(records) {
  const queueWaitSeconds = records
    .map((record) => durationSeconds(record.queue?.queuedAt, record.queue?.mergedAt))
    .filter((seconds) => seconds !== null);
  const mergeToStagingSeconds = records
    .map((record) => durationSeconds(record.queue?.mergedAt, record.staging?.startedAt))
    .filter((seconds) => seconds !== null);
  const stagingDurationSeconds = records
    .map((record) => durationSeconds(record.staging?.startedAt, record.staging?.completedAt))
    .filter((seconds) => seconds !== null);
  const productionDurationSeconds = records
    .map((record) => durationSeconds(record.production?.startedAt, record.production?.completedAt))
    .filter((seconds) => seconds !== null);

  return {
    queueWaitSeconds,
    mergeToStagingSeconds,
    stagingDurationSeconds,
    productionDurationSeconds,
    averageQueueWaitSeconds: average(queueWaitSeconds),
    averageMergeToStagingSeconds: average(mergeToStagingSeconds),
    averageStagingDurationSeconds: average(stagingDurationSeconds),
    averageProductionDurationSeconds: average(productionDurationSeconds),
  };
}

async function findJsonFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(entry.parentPath ?? dir, entry.name));
}

function compareReleaseRecords(a, b) {
  const aTime = Date.parse(a.production?.completedAt ?? a.checkedAt ?? a.queue?.mergedAt ?? "");
  const bTime = Date.parse(b.production?.completedAt ?? b.checkedAt ?? b.queue?.mergedAt ?? "");
  return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
}

function shortCommit(value) {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : "unknown";
}

function formatDrift(value) {
  const commits = Number.isInteger(value?.commits) ? value.commits : 0;
  const seconds = Number.isInteger(value?.seconds) ? value.seconds : 0;
  return `${commits} commits / ${formatSeconds(seconds)}`;
}

function formatDuration(start, end) {
  const seconds = durationSeconds(start, end);
  return seconds === null ? "unknown" : formatSeconds(seconds);
}

function durationSeconds(start, end) {
  const startTime = Date.parse(start ?? "");
  const endTime = Date.parse(end ?? "");
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime) {
    return null;
  }
  return Math.round((endTime - startTime) / 1000);
}

function formatSeconds(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatLock(lock) {
  if (!lock?.locked) {
    return "clear";
  }
  return lock.bypassed ? `bypassed ${lock.emergencyReference ?? ""}`.trim() : `locked ${lock.reference ?? ""}`.trim();
}

function formatRecovery(recovery) {
  if (!recovery || recovery.mode === "none") {
    return "none";
  }
  return `${recovery.mode} ${recovery.reference ?? ""}`.trim();
}

function formatSloRows(slo) {
  return Object.entries(slo.signals).map(([name, signal]) =>
    [name, signal.threshold, signal.current, signal.passes ? "pass" : "fail"]
      .map(escapeMarkdownCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  );
}

function summarizeCiPosture(records) {
  const ciRecords = records.filter((record) => record.ci && typeof record.ci === "object");
  const jobs = new Map();
  let retryCount = 0;
  let flakyFailureCount = 0;
  let affectedReleaseCount = 0;

  for (const record of ciRecords) {
    const ci = record.ci ?? {};
    const recordRetryCount = nonNegativeInteger(ci.retryCount);
    const recordFlakyFailureCount = nonNegativeInteger(ci.flakyFailureCount);
    retryCount += recordRetryCount;
    flakyFailureCount += recordFlakyFailureCount;
    if (recordRetryCount > 0 || recordFlakyFailureCount > 0) {
      affectedReleaseCount += 1;
    }

    for (const job of Array.isArray(ci.topFlakyJobs) ? ci.topFlakyJobs : []) {
      const name = typeof job.name === "string" && job.name.trim() ? job.name.trim() : "unknown";
      const previous = jobs.get(name) ?? { name, retryCount: 0, flakyFailureCount: 0 };
      previous.retryCount += nonNegativeInteger(job.retryCount);
      previous.flakyFailureCount += nonNegativeInteger(job.flakyFailureCount);
      jobs.set(name, previous);
    }
  }

  const topFlakyJobs = [...jobs.values()]
    .sort((a, b) => b.retryCount + b.flakyFailureCount - (a.retryCount + a.flakyFailureCount))
    .slice(0, 5);

  return {
    releaseCountWithTelemetry: ciRecords.length,
    affectedReleaseCount,
    retryCount,
    flakyFailureCount,
    topFlakyJobs,
  };
}

function formatCiRows(ci) {
  if (ci.topFlakyJobs.length === 0) {
    return ["| none | 0 | 0 |"];
  }
  return ci.topFlakyJobs.map((job) =>
    [job.name, String(job.retryCount), String(job.flakyFailureCount)]
      .map(escapeMarkdownCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  );
}

function formatGateRows(gates) {
  if (gates.gates.length === 0) {
    return ["| none | 0 | 0 | 0 |"];
  }
  return gates.gates.map((gate) =>
    [gate.id, String(gate.blockingFailures), String(gate.advisoryWarnings), String(gate.deferredProof)]
      .map(escapeMarkdownCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  );
}

function formatCapacityFollowUpRows(capacityReview) {
  if (capacityReview.followUpIssues.length === 0) {
    return ["| none | no follow-up issue trigger in current evidence |"];
  }

  return capacityReview.followUpIssues.map((issue) =>
    [issue.title, issue.trigger].map(escapeMarkdownCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"),
  );
}

function isStagingAbort(record) {
  return (
    ["failure", "cancelled"].includes(record.staging?.result) ||
    (record.attempt?.phase === "staging" && ["failure", "cancelled"].includes(record.attempt?.result))
  );
}

function isStaleStagingSkip(record) {
  return (
    record.attempt?.phase === "staging" &&
    record.staging?.result === "skipped" &&
    ["stale-release", "staging-not-deployed", "staging-not-applied"].includes(record.attempt?.reason)
  );
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function numericHeadroom(value) {
  return Number.isFinite(value) ? value : null;
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatOptionalSeconds(seconds) {
  return seconds === null ? "unknown" : formatSeconds(seconds);
}

function formatOptionalCount(value) {
  return value === null ? "unknown" : String(value);
}

function formatOptionalMs(value) {
  const normalized = nonNegativeInteger(value);
  return normalized === 0 && value !== 0 ? "unknown" : `${normalized}ms`;
}

function formatEvidenceWindow(window) {
  if (!Number.isInteger(window.spanDays) || !window.firstEvidenceAt || !window.latestEvidenceAt) {
    return "unknown";
  }
  return `${window.spanDays}d (${window.artifactCountWithTimestamps} timestamped artifacts; ${window.firstEvidenceAt} to ${window.latestEvidenceAt})`;
}

function freshnessEvidenceTimestampMs(record) {
  for (const value of [record.completedAt, record.checkedAt, record.startedAt, record.createdAt]) {
    const timestamp = Date.parse(value ?? "");
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }
  return null;
}

function nonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function nonNegativeRateOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const parsed = Number.parseFloat(trimmed.replace(/%$/, ""));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return trimmed.endsWith("%") ? parsed / 100 : parsed;
    }
  }
  return null;
}

function formatOptionalRate(value) {
  return value === null ? "unknown" : formatPercent(value);
}

function normalizeEvidenceLabel(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

function findSupportSafeEvidenceFailures(record) {
  const serialized = JSON.stringify(record);
  const failures = [];
  for (const { label, pattern } of SUPPORT_SAFE_EVIDENCE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(serialized)) {
      failures.push(label);
    }
  }
  return [...new Set(failures)].sort();
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
}

async function main(argv, env = process.env) {
  const options = parseReleaseHealthReportArgs(argv, env);
  if (options.files.length === 0 && !options.dir) {
    console.error("Pass at least one --file or a RELEASE_HEALTH_DIR/--dir.");
    return 2;
  }

  const report = await runReleaseHealthReport(options);
  console.log(report.markdown);

  if (!options.gate) {
    return 0;
  }

  const gate = evaluateSegmentSloRegressionGate(report);
  if (gate.blocked) {
    console.error(`Segment-level projection lag SLO regression gate failed (posture: ${gate.posture}).`);
    for (const reason of gate.reasons) {
      console.error(`- ${reason}`);
    }
    return 1;
  }
  console.log(`Segment-level projection lag SLO regression gate passed (posture: ${gate.posture}).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
