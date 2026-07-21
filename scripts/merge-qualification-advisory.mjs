#!/usr/bin/env node
// Advisory merge-group qualification behind a default-off enablement policy.
//
// This module owns four fixture-proven contracts:
//
//   1. The checked-in enablement policy (`merge-qualification-policy/v1`),
//      validated fail-closed: an absent, disabled, expired, or malformed
//      policy behaves as disabled — a visible advisory summary note, no
//      provider mutation, no qualification records, no advisory assertion.
//   2. The terminal advisory state machine: when the policy is enabled, every
//      merge-group candidate resolves to exactly ONE of the six terminal
//      states (passed, failed, not_applicable, persistent_required,
//      cancelled_evicted, infrastructure_error). Missing classifier output,
//      a missing candidate image, or an uninvoked gate lands as
//      infrastructure_error — never a silent skip.
//   3. The advisory qualification event (`merge-qualification-event/v1`) fed
//      to the canonical delivery-health readers, and the post-merge
//      staging comparison join (`merge-qualification-staging-comparison/v1`)
//      that maps a merge-group candidate to the merged main release by tree
//      SHA — never branch-name heuristics.
//   4. The delivery-health summarizer over those events: terminal-state
//      counts, p50/p90/p95 durations, staging catch count, orphan count, and
//      provider headroom.
//
// Provider posture: this module is provider-inert. It reads git metadata and
// JSON files only and threads NO provider credential; the only provider-
// touching surface in the advisory chain is the reused merge-gate workflow
// (.github/workflows/platform-merge-gate-verification.yml), whose own
// fail-before-mutation credential matrix governs that boundary. Enablement,
// operator secrets, live drills, and the soak evidence belong to the
// enablement issue; this module ships with the policy disabled.

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const MERGE_QUALIFICATION_POLICY_SCHEMA_VERSION = "merge-qualification-policy/v1";
export const MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION = "merge-qualification-event/v1";
export const MERGE_QUALIFICATION_COMPARISON_SCHEMA_VERSION = "merge-qualification-staging-comparison/v1";
export const MERGE_QUALIFICATION_SUMMARY_SCHEMA_VERSION = "merge-qualification-summary/v1";
export const MERGE_QUALIFICATION_POLICY_PATH = "scripts/merge-qualification-policy.json";
// Ratified on the advisory-qualification cost wager: an enablement window may
// never exceed 30 days, and the expiry clock starts at enablement
// (enabledAt), not at merge.
export const MERGE_QUALIFICATION_MAX_ENABLEMENT_DAYS = 30;

// The six terminal advisory states. Every enabled merge-group candidate
// resolves to exactly one; a disabled policy asserts none.
export const MERGE_QUALIFICATION_TERMINAL_STATES = Object.freeze([
  "passed",
  "failed",
  "not_applicable",
  "persistent_required",
  "cancelled_evicted",
  "infrastructure_error",
]);

// Terminal states that may have provisioned a gate namespace. not_applicable,
// persistent_required, and infrastructure_error must never provision.
const PROVISIONING_TERMINAL_STATES = new Set(["passed", "failed", "cancelled_evicted"]);

const POLICY_DISABLED_REASONS = Object.freeze([
  "policy_absent",
  "policy_malformed",
  "policy_schema_unsupported",
  "policy_disabled",
  "policy_expired",
  "policy_expiry_horizon_exceeded",
]);

// Staging root-cause routing for the comparison join (codes from
// scripts/platform-deploy-incident.mjs). Terraform/provider-topology and
// migration-mechanism failures are classifier-routing evidence — the
// candidate should have been routed persistent_required — never isolated
// false negatives. Application/contract failures on a candidate whose merge
// qualification passed are the "staging caught something" signal. An unknown
// root cause fails closed INTO the caught set so the disagreement surfaces
// for the soak review instead of vanishing.
export const CLASSIFIER_ROUTING_ROOT_CAUSE_CODES = Object.freeze([
  "terraform-provider-or-state",
  "staging-dns",
  "doks-bootstrap-or-migration",
]);
export const APPLICATION_ROOT_CAUSE_CODES = Object.freeze([
  "blocking-staging-verification",
  "staging-advisory-seed-or-e2e",
  "production-verification",
  "unknown",
]);

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
// Recursively closed ceiling schema: exactly these two ratified fields.
const KNOWN_CEILING_FIELDS = new Set(["dollarCeilingUsd", "maxQualificationsPerDay"]);
// Timezone-bearing ISO-8601 instants only. Permissive Date.parse accepts
// date-only values and zone-less local datetimes; both are ambiguous for an
// enablement window, so the offset (Z or ±hh:mm) is mandatory.
const TIMEZONE_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseTimezoneInstantMs(value) {
  if (typeof value !== "string" || !TIMEZONE_INSTANT_PATTERN.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Enablement policy — fail-closed validation.
// ---------------------------------------------------------------------------

// Evaluates raw policy file content (string or null) to an enablement
// decision. Every failure path lands on `enabled: false` with a deterministic
// reason code; this function never throws.
export function evaluateMergeQualificationPolicy(content, { now = () => new Date() } = {}) {
  if (content === null || content === undefined) {
    return disabledDecision("policy_absent", [
      "the enablement policy file is absent; advisory qualification stays disabled.",
    ]);
  }
  let policy;
  try {
    policy = JSON.parse(content);
  } catch {
    return disabledDecision("policy_malformed", [
      "the enablement policy is not valid JSON; failing closed to disabled.",
    ]);
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return disabledDecision("policy_malformed", [
      "the enablement policy must be a JSON object; failing closed to disabled.",
    ]);
  }
  if (policy.schemaVersion !== MERGE_QUALIFICATION_POLICY_SCHEMA_VERSION) {
    return disabledDecision("policy_schema_unsupported", [
      `policy schemaVersion must be ${MERGE_QUALIFICATION_POLICY_SCHEMA_VERSION} (got ${JSON.stringify(policy.schemaVersion ?? null)}); unknown or future versions fail closed to disabled.`,
    ]);
  }

  const knownFields = new Set(["schemaVersion", "enabled", "owner", "ceiling", "enabledAt", "expiresAt", "notes"]);
  const unknownFields = Object.keys(policy).filter((field) => !knownFields.has(field));
  if (unknownFields.length > 0) {
    return disabledDecision("policy_malformed", [
      `unknown policy fields ${unknownFields.join(", ")} are not part of ${MERGE_QUALIFICATION_POLICY_SCHEMA_VERSION}; failing closed to disabled.`,
    ]);
  }

  if (policy.enabled === false) {
    return disabledDecision("policy_disabled", ["the enablement policy is present and explicitly disabled."]);
  }
  if (policy.enabled !== true) {
    return disabledDecision("policy_malformed", ["policy enabled must be a boolean; failing closed to disabled."]);
  }

  // enabled === true: owner, ceiling, enabledAt, and expiresAt become
  // mandatory, and the expiry clock is anchored at enablement. The window
  // contract is explicit: enabledAt < expiresAt <= enabledAt + 30 days.
  const errors = [];
  if (typeof policy.owner !== "string" || !policy.owner.trim()) {
    errors.push("an enabled policy must name a non-empty owner.");
  }
  if (typeof policy.ceiling !== "object" || policy.ceiling === null || Array.isArray(policy.ceiling)) {
    errors.push("an enabled policy must declare a ceiling object.");
  } else {
    const unknownCeilingFields = Object.keys(policy.ceiling).filter((field) => !KNOWN_CEILING_FIELDS.has(field));
    if (unknownCeilingFields.length > 0) {
      errors.push(
        `unknown ceiling fields ${unknownCeilingFields.join(", ")} are not part of ${MERGE_QUALIFICATION_POLICY_SCHEMA_VERSION}; failing closed to disabled.`,
      );
    }
    if (!(Number.isFinite(policy.ceiling.dollarCeilingUsd) && policy.ceiling.dollarCeilingUsd > 0)) {
      errors.push("an enabled policy must declare ceiling.dollarCeilingUsd > 0.");
    }
    if (!(Number.isInteger(policy.ceiling.maxQualificationsPerDay) && policy.ceiling.maxQualificationsPerDay > 0)) {
      errors.push("an enabled policy must declare integer ceiling.maxQualificationsPerDay > 0.");
    }
  }
  const enabledAtMs = parseTimezoneInstantMs(policy.enabledAt);
  const expiresAtMs = parseTimezoneInstantMs(policy.expiresAt);
  const nowMs = now().getTime();
  if (enabledAtMs === null) {
    errors.push(
      "an enabled policy must record enabledAt as an ISO-8601 instant with an explicit timezone offset (date-only or zone-less values fail closed).",
    );
  }
  if (expiresAtMs === null) {
    errors.push(
      "an enabled policy must record expiresAt as an ISO-8601 instant with an explicit timezone offset (date-only or zone-less values fail closed).",
    );
  }
  if (enabledAtMs !== null && enabledAtMs > nowMs) {
    errors.push("policy enabledAt is in the future; failing closed to disabled.");
  }
  if (enabledAtMs !== null && expiresAtMs !== null && !(enabledAtMs < expiresAtMs)) {
    errors.push("policy expiresAt must be strictly after enabledAt; failing closed to disabled.");
  }
  if (errors.length > 0) {
    return disabledDecision("policy_malformed", errors);
  }
  if (expiresAtMs - enabledAtMs > MERGE_QUALIFICATION_MAX_ENABLEMENT_DAYS * 24 * 60 * 60 * 1000) {
    return disabledDecision("policy_expiry_horizon_exceeded", [
      `policy expiresAt is more than ${MERGE_QUALIFICATION_MAX_ENABLEMENT_DAYS} days after enabledAt; the enablement wager caps the window, failing closed to disabled.`,
    ]);
  }
  if (expiresAtMs <= nowMs) {
    return disabledDecision("policy_expired", [
      "policy expiresAt has passed; advisory automation stops automatically at expiry unless the measured report is accepted (#5881).",
    ]);
  }

  return {
    enabled: true,
    state: "enabled",
    reasonCode: null,
    errors: [],
    policy: {
      owner: policy.owner.trim(),
      ceiling: {
        dollarCeilingUsd: policy.ceiling.dollarCeilingUsd,
        maxQualificationsPerDay: policy.ceiling.maxQualificationsPerDay,
      },
      enabledAt: new Date(enabledAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
}

function disabledDecision(reasonCode, errors) {
  if (!POLICY_DISABLED_REASONS.includes(reasonCode)) {
    throw new Error(`unknown policy disabled reason ${reasonCode}`);
  }
  return { enabled: false, state: "disabled", reasonCode, errors, policy: null };
}

export function readMergeQualificationPolicyContent(policyPath, { readFile = defaultReadFile } = {}) {
  return readFile(policyPath);
}

function defaultReadFile(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Terminal advisory state machine.
// ---------------------------------------------------------------------------

// Resolves the single terminal advisory outcome for one merge-group
// candidate. Inputs are the policy decision, the classifier record (or null
// when planning failed), and the observed workflow-graph results. Never
// throws; every unknown or missing input fails closed to infrastructure_error
// (enabled) or to the no-assertion disabled note (disabled).
export function resolveMergeQualificationOutcome(input = {}) {
  const policyEnabled = input.policyEnabled === true;
  if (!policyEnabled) {
    return {
      terminalState: null,
      reasonCodes: [input.policyReasonCode ?? "policy_disabled"],
      recordRequired: false,
      assertsAdvisoryCheck: false,
      provisionsAllowed: false,
      summary:
        "Advisory merge qualification is disabled by policy: no provider mutation, no qualification records, no advisory assertion.",
    };
  }

  const terminal = (state, reasonCodes) => ({
    terminalState: state,
    reasonCodes,
    recordRequired: true,
    assertsAdvisoryCheck: true,
    provisionsAllowed: PROVISIONING_TERMINAL_STATES.has(state),
    summary: null,
  });

  if (input.planResult === "cancelled") {
    // Whole-run cancellation/eviction reaches the plan job too: report it as
    // cancellation, never as an infrastructure failure.
    return terminal("cancelled_evicted", ["plan_cancelled"]);
  }
  if (input.planResult !== "success") {
    return terminal("infrastructure_error", ["plan_failed"]);
  }
  const classifierClass = input.classifierClass ?? null;
  if (!classifierClass) {
    return terminal("infrastructure_error", ["classifier_output_missing"]);
  }
  const classifierReasonCodes = normalizeReasonCodes(input.classifierReasonCodes);
  if (classifierClass === "not_applicable") {
    return terminal(
      "not_applicable",
      classifierReasonCodes.length > 0 ? classifierReasonCodes : ["classifier_not_applicable"],
    );
  }
  if (classifierClass === "persistent_required") {
    return terminal(
      "persistent_required",
      classifierReasonCodes.length > 0 ? classifierReasonCodes : ["classifier_persistent_required"],
    );
  }
  if (classifierClass !== "isolated") {
    return terminal("infrastructure_error", ["classifier_class_unknown"]);
  }

  // isolated: the gate had to run against the exact digest this run built.
  const gateResult = input.gateResult ?? "";
  if (gateResult === "cancelled") {
    // Queue cancellation/eviction is reported separately from qualification
    // failure; the gate workflow's always() finalizers own cleanup.
    return terminal("cancelled_evicted", ["gate_cancelled"]);
  }
  if (gateResult === "success") {
    const identityErrors = gateIdentityErrors(input);
    if (identityErrors.length > 0) {
      // A successful gate that qualified a different SHA, tree, or digest —
      // or one that cannot prove an immutable digest at all — must never
      // become a passed record.
      return terminal("infrastructure_error", identityErrors);
    }
    return terminal("passed", ["gate_passed"]);
  }
  if (gateResult === "failure") {
    return terminal("failed", ["gate_failed"]);
  }
  if (input.imageResult === "cancelled") {
    // The Docker image job was cancelled mid-run, so the gate never started:
    // this is queue cancellation/eviction, not an infrastructure failure.
    return terminal("cancelled_evicted", ["image_cancelled"]);
  }
  if (input.imageAvailable !== true) {
    // Platform PR never pushed (or never built) the candidate tree image, so
    // the gate was not invoked: a missing image is never a silent skip.
    return terminal("infrastructure_error", ["candidate_image_unavailable"]);
  }
  return terminal("infrastructure_error", ["gate_not_invoked"]);
}

// End-to-end identity comparison for a successful gate. The gate must report
// a valid immutable digest (a passed result may never rest on a mutable
// tree-tag resolution), that digest must equal the one this run's Docker job
// pushed when the caller supplies it, and the gate's resolved candidate SHA
// and tree must echo the plan's when supplied.
function gateIdentityErrors(input) {
  const errors = [];
  const gateDigest = lowerTrim(input.gateImageDigest);
  const builtDigest = lowerTrim(input.builtImageDigest);
  if (!IMAGE_DIGEST_PATTERN.test(gateDigest)) {
    errors.push("gate_digest_missing");
  } else if (IMAGE_DIGEST_PATTERN.test(builtDigest) && builtDigest !== gateDigest) {
    errors.push("image_digest_mismatch");
  }
  if (bothPresentAndDiffer(input.candidateSha, input.gateCandidateSha)) {
    errors.push("candidate_sha_mismatch");
  }
  if (bothPresentAndDiffer(input.candidateTreeSha, input.gateCandidateTreeSha)) {
    errors.push("candidate_tree_mismatch");
  }
  return errors;
}

function lowerTrim(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function bothPresentAndDiffer(left, right) {
  const normalizedLeft = lowerTrim(left);
  const normalizedRight = lowerTrim(right);
  return normalizedLeft !== "" && normalizedRight !== "" && normalizedLeft !== normalizedRight;
}

// ---------------------------------------------------------------------------
// Independent idempotent run terminalization (cancellation/eviction backstop).
//
// The primary publisher runs `if: always()`, but GitHub only re-evaluates
// cancellation conditions for jobs that are already queued or running, and
// force cancellation bypasses `always()` entirely — so a merge-group run can
// end with NO terminal advisory result. The workflow_run observer
// (.github/workflows/platform-merge-qualification-terminalizer.yml) calls
// this resolver after the primary run completes and emits the missing
// terminal event exactly once:
//   - idempotent: a run that already carries a merge-qualification-events
//     artifact is never terminalized again, and the emitted event is built
//     from run-derived data only, so a re-run observer rebuilds a
//     byte-identical event that dedupes instead of conflicting.
//   - stage-aware: cancelled plan, Docker image, gate, and publisher jobs
//     each carry a distinct reason code; a force-cancelled run with no
//     per-job cancellation lands as run_force_cancelled.
//   - fail-closed: a disabled policy never terminalizes (no records while
//     disabled), and a definitively-disabled run (publisher skipped) is
//     recognized from the run's own job data.
// ---------------------------------------------------------------------------

export function resolveRunTerminalization({
  policyEnabled = false,
  policyReasonCode = null,
  runEvent = "",
  runConclusion = "",
  jobs = [],
  artifactNames = [],
} = {}) {
  if (runEvent !== "merge_group") {
    return { action: "skip", reason: "not_merge_group" };
  }
  if (policyEnabled !== true) {
    return { action: "skip", reason: policyReasonCode ?? "policy_disabled" };
  }
  const jobNamed = (pattern) => jobs.find((job) => pattern.test(String(job?.name ?? "")));
  const publisher = jobNamed(/^Merge Qualification \(advisory\)$/);
  if (publisher?.conclusion === "skipped") {
    // The publisher only skips on a definitive disabled decision from the
    // plan job, so the run asserted nothing by design.
    return { action: "skip", reason: "publisher_skipped_disabled" };
  }
  if (artifactNames.some((name) => /^merge-qualification-events-/.test(String(name ?? "")))) {
    return { action: "skip", reason: "already_terminalized" };
  }
  // Called-workflow jobs surface in the caller run as "Merge Qualification
  // Gate / <job>"; a skipped call surfaces as one "Merge Qualification Gate"
  // entry.
  const gateJobs = jobs.filter((job) => /^Merge Qualification Gate/.test(String(job?.name ?? "")));
  const gateCancelled = gateJobs.some((job) => job?.conclusion === "cancelled");
  const gateStarted = gateJobs.some((job) => job?.conclusion && job.conclusion !== "skipped");
  if (runConclusion === "cancelled") {
    // Attribute the cancellation to the EARLIEST cancelled stage — that is
    // where the pipeline actually died; later jobs are collateral.
    const reason =
      jobNamed(/^Merge Qualification Plan$/)?.conclusion === "cancelled"
        ? "plan_cancelled"
        : jobNamed(/^Docker Image Build$/)?.conclusion === "cancelled"
          ? "image_cancelled"
          : gateCancelled
            ? "gate_cancelled"
            : publisher?.conclusion === "cancelled"
              ? "publisher_cancelled"
              : "run_force_cancelled";
    return {
      action: "terminalize",
      terminalState: "cancelled_evicted",
      reasonCodes: [reason],
      // The gate may have provisioned before cancellation; its always()
      // finalizers plus the scheduled gate sweep own the cleanup either way.
      provisioned: gateStarted,
    };
  }
  // The run completed without cancellation, the policy is enabled, and no
  // terminal event exists: the publisher never executed (startup failure,
  // runner loss) or could not write a valid record. Never silent.
  return {
    action: "terminalize",
    terminalState: "infrastructure_error",
    reasonCodes: ["advisory_result_missing"],
    provisioned: false,
  };
}

function normalizeReasonCodes(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((code) => code.trim());
  return [...new Set(raw.filter((code) => REASON_CODE_PATTERN.test(code)))].sort();
}

// ---------------------------------------------------------------------------
// Advisory qualification event (merge-qualification-event/v1).
// ---------------------------------------------------------------------------

export function buildMergeQualificationEvent(input) {
  const event = {
    schemaVersion: MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION,
    repository: normalize(input.repository),
    candidateSha: normalize(input.candidateSha).toLowerCase(),
    candidateTreeSha: normalize(input.candidateTreeSha).toLowerCase(),
    imageDigest: input.imageDigest ? normalize(input.imageDigest).toLowerCase() : null,
    classifierClass: input.classifierClass ?? null,
    terminalState: normalize(input.terminalState),
    reasonCodes: Array.isArray(input.reasonCodes) ? input.reasonCodes : [],
    provisioned: input.provisioned === true,
    startedAt: normalize(input.startedAt),
    completedAt: normalize(input.completedAt),
    runId: normalize(input.runId),
    runAttempt: normalize(input.runAttempt),
    evidenceLinks: Array.isArray(input.evidenceLinks) ? input.evidenceLinks.map(normalize) : input.evidenceLinks,
    providerHeadroom: input.providerHeadroom ?? null,
  };
  return { event, errors: validateMergeQualificationEvent(event) };
}

export function validateMergeQualificationEvent(event) {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return ["event must be a JSON object."];
  }
  const errors = [];
  if (event.schemaVersion !== MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION) {
    return [
      `schemaVersion must be ${MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION}; readers fail closed on any other version (got ${JSON.stringify(event.schemaVersion ?? null)}).`,
    ];
  }
  const knownFields = new Set([
    "schemaVersion",
    "repository",
    "candidateSha",
    "candidateTreeSha",
    "imageDigest",
    "classifierClass",
    "terminalState",
    "reasonCodes",
    "provisioned",
    "startedAt",
    "completedAt",
    "runId",
    "runAttempt",
    "evidenceLinks",
    "providerHeadroom",
  ]);
  for (const field of Object.keys(event)) {
    if (!knownFields.has(field)) {
      errors.push(`unknown field ${field} is not part of ${MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION}.`);
    }
  }
  if (!REPOSITORY_PATTERN.test(event.repository ?? "")) {
    errors.push("repository must be an owner/name GitHub repository slug.");
  }
  if (!isCommitSha(event.candidateSha)) {
    errors.push("candidateSha must be the 40-character merge-group candidate commit SHA.");
  }
  if (!isCommitSha(event.candidateTreeSha)) {
    errors.push("candidateTreeSha must be the 40-character candidate git tree SHA.");
  }
  if (event.imageDigest !== null && !IMAGE_DIGEST_PATTERN.test(event.imageDigest ?? "")) {
    errors.push("imageDigest must be null or an immutable sha256 image digest.");
  }
  if (!MERGE_QUALIFICATION_TERMINAL_STATES.includes(event.terminalState)) {
    errors.push(`terminalState must be exactly one of ${MERGE_QUALIFICATION_TERMINAL_STATES.join(", ")}.`);
  }
  if (event.terminalState === "passed" && !IMAGE_DIGEST_PATTERN.test(event.imageDigest ?? "")) {
    // A passed record without the exact qualified digest proves nothing.
    errors.push("a passed event must pin the exact immutable sha256 digest the gate qualified.");
  }
  if (event.providerHeadroom !== null) {
    const headroom = event.providerHeadroom;
    if (
      typeof headroom !== "object" ||
      headroom === null ||
      Array.isArray(headroom) ||
      Object.keys(headroom).some((field) => field !== "headroomRuns") ||
      !(Number.isFinite(headroom.headroomRuns) && headroom.headroomRuns >= 0)
    ) {
      errors.push("providerHeadroom must be null or { headroomRuns: <non-negative finite number> }.");
    }
  }
  if (
    !Array.isArray(event.reasonCodes) ||
    event.reasonCodes.length === 0 ||
    event.reasonCodes.some((code) => !REASON_CODE_PATTERN.test(code))
  ) {
    errors.push("reasonCodes must be a non-empty array of deterministic lowercase reason codes.");
  }
  if (event.provisioned === true && !PROVISIONING_TERMINAL_STATES.has(event.terminalState)) {
    errors.push(
      `terminalState ${event.terminalState} must not provision a namespace; provisioned records are only valid for ${[...PROVISIONING_TERMINAL_STATES].join(", ")}.`,
    );
  }
  if (!isIsoInstant(event.startedAt)) {
    errors.push("startedAt must be an ISO-8601 UTC instant.");
  }
  if (!isIsoInstant(event.completedAt)) {
    errors.push("completedAt must be an ISO-8601 UTC instant.");
  } else if (isIsoInstant(event.startedAt) && Date.parse(event.completedAt) < Date.parse(event.startedAt)) {
    errors.push("completedAt must not precede startedAt.");
  }
  if (!isPositiveInteger(event.runId) || !isPositiveInteger(event.runAttempt)) {
    errors.push("runId and runAttempt must be positive integer strings.");
  }
  if (!Array.isArray(event.evidenceLinks) || event.evidenceLinks.length === 0) {
    errors.push("evidenceLinks must be a non-empty array of https evidence URLs.");
  } else {
    for (const link of event.evidenceLinks) {
      if (typeof link !== "string" || !/^https:\/\/\S+$/.test(link)) {
        errors.push(`evidenceLinks entry ${JSON.stringify(link)} must be an https URL.`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Post-merge staging comparison join.
// ---------------------------------------------------------------------------

// Joins eligible isolated advisory outcomes to the subsequent merged main
// release and its persistent staging result. The join key is the candidate
// git TREE SHA — a merge-group candidate and the merged main commit differ in
// commit SHA but share a tree — and the join is temporally and identity safe:
//
//   - the release must have completed AFTER the candidate's qualification
//     completed (an older same-tree release, e.g. a revert-reland, can never
//     absorb this candidate's outcome);
//   - when both sides pin an image digest they must agree exactly; a
//     same-tree post-qualification release with a different digest is an
//     explicit identity_mismatch orphan, never a staging catch;
//   - multiple qualifying releases select deterministically: exact digest
//     matches first, then earliest completedAt, then lowest mainSha.
//
// Branch names never participate. A candidate whose tree never became a main
// release is superseded; one whose only same-tree releases predate its
// qualification is an explicit no_subsequent_release orphan.
export function joinMergeQualificationToStaging({ events = [], releases = [] } = {}) {
  const usableReleases = releases.filter((release) => isUsableStagingRelease(release));
  const eligible = events.filter(
    (event) => event.classifierClass === "isolated" && ["passed", "failed"].includes(event.terminalState),
  );
  return eligible.map((event) => {
    const qualifiedAtMs = Date.parse(event.completedAt ?? "");
    if (!Number.isFinite(qualifiedAtMs)) {
      return comparison(event, null, "invalid_event");
    }
    const sameTree = usableReleases.filter((release) => release.treeSha === event.candidateTreeSha);
    if (sameTree.length === 0) {
      return comparison(event, null, "superseded");
    }
    const subsequent = sameTree.filter((release) => Date.parse(release.completedAt) > qualifiedAtMs);
    if (subsequent.length === 0) {
      return comparison(event, null, "no_subsequent_release");
    }
    const agreeing = subsequent.filter(
      (release) => !(release.imageDigest && event.imageDigest && release.imageDigest !== event.imageDigest),
    );
    if (agreeing.length === 0) {
      return comparison(event, null, "identity_mismatch");
    }
    const release = [...agreeing].sort(deterministicReleaseOrder(event))[0];
    return comparison(event, release, "joined");
  });
}

// Releases must carry a full identity before they may join; anything less is
// excluded here and reported by the collector as a completeness failure.
export function isUsableStagingRelease(release) {
  return (
    typeof release === "object" &&
    release !== null &&
    isCommitSha(release.mainSha) &&
    isCommitSha(release.treeSha) &&
    Number.isFinite(Date.parse(release.completedAt ?? "")) &&
    typeof release.staging?.result === "string" &&
    release.staging.result.length > 0 &&
    (release.imageDigest === null ||
      release.imageDigest === undefined ||
      IMAGE_DIGEST_PATTERN.test(release.imageDigest))
  );
}

function deterministicReleaseOrder(event) {
  const exactDigestRank = (release) => (event.imageDigest && release.imageDigest === event.imageDigest ? 0 : 1);
  return (left, right) => {
    const rankDelta = exactDigestRank(left) - exactDigestRank(right);
    if (rankDelta !== 0) return rankDelta;
    const timeDelta = Date.parse(left.completedAt) - Date.parse(right.completedAt);
    if (timeDelta !== 0) return timeDelta;
    return String(left.mainSha).localeCompare(String(right.mainSha));
  };
}

function comparison(event, release, joinStatus) {
  const joined = joinStatus === "joined" && release !== null;
  const failureKind = joined ? stagingFailureKind(release) : null;
  const stagingFailed = joined && release.staging?.result === "failure";
  return {
    schemaVersion: MERGE_QUALIFICATION_COMPARISON_SCHEMA_VERSION,
    candidateSha: event.candidateSha,
    candidateTreeSha: event.candidateTreeSha,
    terminalState: event.terminalState,
    qualificationCompletedAt: event.completedAt ?? null,
    joinStatus,
    mainSha: joined ? release.mainSha : null,
    mapping: joined
      ? release.mainSha === event.candidateSha
        ? "same-commit"
        : "same-tree-different-commit"
      : joinStatus === "superseded"
        ? "superseded"
        : null,
    releaseCompletedAt: joined ? release.completedAt : null,
    // false ONLY for the explicit identity_mismatch orphan; true when both
    // sides pinned the same digest; null when either side carries none.
    digestMatched:
      joinStatus === "identity_mismatch" ? false : joined && release.imageDigest && event.imageDigest ? true : null,
    stagingResult: joined ? (release.staging?.result ?? null) : null,
    stagingRootCauseCode: joined ? (release.staging?.rootCauseCode ?? null) : null,
    stagingFailureKind: stagingFailed ? failureKind : null,
    // Persistent staging "caught something": merge qualification passed but
    // the same candidate's staging lane later failed for an application/
    // contract condition the isolated lane claimed to cover. Only a joined
    // release can ever count — identity mismatches and temporal orphans are
    // surfaced explicitly instead.
    caught: joined && event.terminalState === "passed" && stagingFailed && failureKind === "application",
    // Terraform/provider-topology (and migration-mechanism) staging failures
    // are classifier-routing evidence, not isolated false negatives.
    classifierRoutingEvidence: stagingFailed && failureKind === "classifier-routing",
  };
}

function stagingFailureKind(release) {
  const code = release?.staging?.rootCauseCode ?? "unknown";
  if (CLASSIFIER_ROUTING_ROOT_CAUSE_CODES.includes(code)) {
    return "classifier-routing";
  }
  // Application/contract codes AND unrecognized codes both land here: an
  // unknown staging root cause must surface as a potential catch for the
  // soak review, never disappear into an unclassified bucket.
  return "application";
}

// ---------------------------------------------------------------------------
// Delivery-health summarizer, consumed by the canonical reader in
// scripts/release-health-delivery-health.mjs.
// ---------------------------------------------------------------------------

// Validates and deduplicates raw qualification events into exactly one
// authoritative event per candidate:
//
//   - every event must validate against merge-qualification-event/v1;
//     malformed events never reach any denominator and degrade completeness;
//   - attempt identity is (candidateSha, runId, runAttempt): byte-identical
//     re-uploads of one attempt collapse as duplicates, while two DIFFERENT
//     payloads for the same attempt are undecidable conflicts — the whole
//     candidate leaves the denominators and degrades completeness;
//   - across attempts, the latest attempt (highest runId, then runAttempt —
//     a re-run or requeue supersedes its predecessor) is authoritative;
//     superseded attempts are exposed, never counted.
export function dedupeMergeQualificationEvents(events = []) {
  const invalidEvents = [];
  const byAttempt = new Map();
  let duplicateEventCount = 0;
  const conflictedCandidates = new Set();
  for (const event of events) {
    const errors = validateMergeQualificationEvent(event);
    if (errors.length > 0) {
      invalidEvents.push({ candidateSha: event?.candidateSha ?? null, errors });
      continue;
    }
    const key = `${event.candidateSha}|${event.runId}|${event.runAttempt}`;
    const existing = byAttempt.get(key);
    if (!existing) {
      byAttempt.set(key, event);
    } else if (canonicalJson(existing) === canonicalJson(event)) {
      duplicateEventCount += 1;
    } else {
      conflictedCandidates.add(event.candidateSha);
    }
  }
  const byCandidate = new Map();
  let supersededAttemptCount = 0;
  for (const event of byAttempt.values()) {
    if (conflictedCandidates.has(event.candidateSha)) continue;
    const current = byCandidate.get(event.candidateSha);
    if (!current) {
      byCandidate.set(event.candidateSha, event);
      continue;
    }
    supersededAttemptCount += 1;
    if (compareAttemptIdentity(event, current) > 0) {
      byCandidate.set(event.candidateSha, event);
    }
  }
  return {
    authoritative: [...byCandidate.values()],
    invalidEvents,
    duplicateEventCount,
    supersededAttemptCount,
    conflictedCandidates: [...conflictedCandidates].sort(),
  };
}

function compareAttemptIdentity(left, right) {
  const runDelta = Number(left.runId) - Number(right.runId);
  if (runDelta !== 0) return runDelta;
  return Number(left.runAttempt) - Number(right.runAttempt);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const COMPARISON_JOIN_STATUSES = new Set([
  "joined",
  "superseded",
  "no_subsequent_release",
  "identity_mismatch",
  "invalid_event",
]);

export function summarizeMergeQualification({ events = [], comparisons = [], candidates = null } = {}) {
  const dedupe = dedupeMergeQualificationEvents(events);
  const authoritative = dedupe.authoritative;
  const terminalStates = Object.fromEntries(MERGE_QUALIFICATION_TERMINAL_STATES.map((state) => [state, 0]));
  for (const event of authoritative) {
    terminalStates[event.terminalState] += 1;
  }
  const conflicted = new Set(dedupe.conflictedCandidates);
  const observedCandidates = new Set(authoritative.map((event) => event.candidateSha));
  // Orphans: inventory candidates that never reached a valid terminal
  // advisory state (run-level eviction before any publisher/terminalizer
  // event, or only malformed evidence). Conflicted candidates are exposed in
  // the evidence block instead — they have terminal claims, just undecidable
  // ones.
  const unresolvedCandidates = Array.isArray(candidates)
    ? candidates.filter((candidateSha) => !observedCandidates.has(candidateSha) && !conflicted.has(candidateSha)).length
    : 0;
  const validComparisons = [];
  let invalidComparisonCount = 0;
  for (const entry of comparisons) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      entry.schemaVersion === MERGE_QUALIFICATION_COMPARISON_SCHEMA_VERSION &&
      COMPARISON_JOIN_STATUSES.has(entry.joinStatus)
    ) {
      validComparisons.push(entry);
    } else {
      invalidComparisonCount += 1;
    }
  }
  const durations = authoritative
    .filter((event) => ["passed", "failed"].includes(event.terminalState))
    .map((event) => durationSeconds(event.startedAt, event.completedAt))
    .filter((value) => value !== null);
  const headroomSamples = authoritative
    .map((event) => ({ at: event.completedAt, runs: event.providerHeadroom?.headroomRuns }))
    .filter((sample) => Number.isFinite(sample.runs))
    .sort((left, right) => Date.parse(left.at ?? 0) - Date.parse(right.at ?? 0));
  return {
    schemaVersion: MERGE_QUALIFICATION_SUMMARY_SCHEMA_VERSION,
    // Exactly one authoritative terminal result per candidate: retries and
    // duplicates never inflate the sample.
    sampleCount: authoritative.length,
    candidateCount: Array.isArray(candidates) ? candidates.length : null,
    terminalStates,
    counts: {
      success: terminalStates.passed,
      applicationFailure: terminalStates.failed,
      cancellation: terminalStates.cancelled_evicted,
      infrastructure: terminalStates.infrastructure_error,
      notApplicable: terminalStates.not_applicable,
      persistentRequired: terminalStates.persistent_required,
    },
    durationSeconds: percentileSummary3(durations),
    stagingCatchCount: validComparisons.filter((entry) => entry.caught === true).length,
    classifierRoutingCount: validComparisons.filter((entry) => entry.classifierRoutingEvidence === true).length,
    supersededCount: validComparisons.filter((entry) => entry.joinStatus === "superseded").length,
    identityMismatchCount: validComparisons.filter((entry) => entry.joinStatus === "identity_mismatch").length,
    temporalOrphanCount: validComparisons.filter((entry) => entry.joinStatus === "no_subsequent_release").length,
    orphanCount: unresolvedCandidates,
    providerHeadroom: {
      sampleCount: headroomSamples.length,
      minHeadroomRuns: headroomSamples.length > 0 ? Math.min(...headroomSamples.map((sample) => sample.runs)) : null,
      latestHeadroomRuns: headroomSamples.at(-1)?.runs ?? null,
    },
    // Evidence hygiene: malformed, duplicated, superseded, and conflicting
    // records are exposed here and NEVER reach the denominators above; any
    // invalid or conflicting evidence marks the summary incomplete.
    evidence: {
      eventCount: events.length,
      invalidEventCount: dedupe.invalidEvents.length,
      duplicateEventCount: dedupe.duplicateEventCount,
      supersededAttemptCount: dedupe.supersededAttemptCount,
      conflictCount: dedupe.conflictedCandidates.length,
      conflictingCandidates: dedupe.conflictedCandidates,
      invalidComparisonCount,
      complete:
        dedupe.invalidEvents.length === 0 && dedupe.conflictedCandidates.length === 0 && invalidComparisonCount === 0,
    },
  };
}

function percentileSummary3(values) {
  const numbers = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  const nearestRank = (percentile) =>
    numbers.length === 0 ? null : numbers[Math.min(numbers.length - 1, Math.ceil(numbers.length * percentile) - 1)];
  return { sampleCount: numbers.length, p50: nearestRank(0.5), p90: nearestRank(0.9), p95: nearestRank(0.95) };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

export function renderMergeQualificationSummary({ decision, outcome, event }) {
  const lines = ["## Merge Qualification (advisory)", ""];
  if (decision.enabled !== true) {
    lines.push(
      `- Policy: **disabled** (\`${decision.reasonCode}\`) — ${decision.errors[0] ?? "advisory qualification is off."}`,
      "- No provider mutation, no qualification records, and no advisory assertion were made for this candidate.",
      "- Enablement (owner, ceiling, expiry) is recorded by #5881; the policy lives at `scripts/merge-qualification-policy.json`.",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`- Terminal state: \`${outcome.terminalState}\` (exactly one per merge-group candidate)`);
  lines.push(`- Reason codes: ${outcome.reasonCodes.map((code) => `\`${code}\``).join(", ")}`);
  if (event) {
    lines.push(
      `- Candidate: \`${event.candidateSha}\` (tree \`${event.candidateTreeSha}\`)${event.imageDigest ? ` @ \`${event.imageDigest}\`` : ""}`,
    );
  }
  lines.push(
    "- Advisory only: this check is never required, never changes `PR Required`, and never skips post-merge persistent staging.",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function appendSummary(summaryPath, text) {
  if (summaryPath) {
    appendFileSync(summaryPath, `${text}\n`, "utf8");
  }
}

function appendOutputs(outputPath, entries) {
  if (outputPath) {
    appendFileSync(outputPath, `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`, "utf8");
  }
}

async function main(argv, env = process.env) {
  const [command] = argv;
  const nowIso = readOption(argv, "--now");
  const now = nowIso ? () => new Date(nowIso) : () => new Date();

  if (command === "policy") {
    const policyPath = readOption(argv, "--policy") ?? MERGE_QUALIFICATION_POLICY_PATH;
    const decision = evaluateMergeQualificationPolicy(readMergeQualificationPolicyContent(policyPath), { now });
    appendOutputs(readOption(argv, "--github-output"), [
      ["enabled", decision.enabled ? "true" : "false"],
      ["reason_code", decision.reasonCode ?? ""],
    ]);
    if (!decision.enabled) {
      appendSummary(
        readOption(argv, "--github-summary"),
        renderMergeQualificationSummary({ decision, outcome: null, event: null }),
      );
    }
    console.log(JSON.stringify(decision, null, 2));
    // Advisory: a disabled or malformed policy is a decision, not an error.
    return 0;
  }

  if (command === "route") {
    const recordPath = readOption(argv, "--classifier-record");
    let record = null;
    try {
      record = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      record = null;
    }
    const classifierClass = record?.class ?? "";
    const reasonCodes = Array.isArray(record?.reasonCodes) ? record.reasonCodes.join(",") : "";
    appendOutputs(readOption(argv, "--github-output"), [
      ["route", classifierClass === "isolated" ? "isolated" : classifierClass ? "record-only" : "unavailable"],
      ["classifier_class", classifierClass],
      ["classifier_reason_codes", reasonCodes],
    ]);
    console.log(
      JSON.stringify({ classifierClass: classifierClass || null, reasonCodes: reasonCodes || null }, null, 2),
    );
    return 0;
  }

  if (command === "publish") {
    const policyPath = readOption(argv, "--policy") ?? MERGE_QUALIFICATION_POLICY_PATH;
    const decision = evaluateMergeQualificationPolicy(readMergeQualificationPolicyContent(policyPath), { now });
    const gateResult = readOption(argv, "--gate-result") ?? "";
    const gateImageDigest = readOption(argv, "--gate-image-digest") ?? readOption(argv, "--image-digest") ?? "";
    const outcome = resolveMergeQualificationOutcome({
      policyEnabled: decision.enabled,
      policyReasonCode: decision.reasonCode,
      planResult: readOption(argv, "--plan-result") ?? "",
      classifierClass: readOption(argv, "--classifier-class") || null,
      classifierReasonCodes: readOption(argv, "--classifier-reason-codes") ?? "",
      gateResult,
      imageResult: readOption(argv, "--image-result") ?? "",
      imageAvailable: readOption(argv, "--image-available") === "true",
      candidateSha: readOption(argv, "--candidate-sha") ?? "",
      candidateTreeSha: readOption(argv, "--candidate-tree") ?? "",
      builtImageDigest: readOption(argv, "--built-image-digest") ?? "",
      gateImageDigest,
      gateCandidateSha: readOption(argv, "--gate-candidate-sha") ?? "",
      gateCandidateTreeSha: readOption(argv, "--gate-candidate-tree") ?? "",
    });
    let event = null;
    const errors = [];
    if (outcome.recordRequired) {
      const completedAt = now().toISOString();
      const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? readOption(argv, "--repository") ?? ""}/actions/runs/${env.GITHUB_RUN_ID ?? readOption(argv, "--run-id") ?? ""}/attempts/${env.GITHUB_RUN_ATTEMPT ?? readOption(argv, "--run-attempt") ?? ""}`;
      const headroomRuns = Number(readOption(argv, "--provider-headroom-runs") ?? "");
      const built = buildMergeQualificationEvent({
        repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
        candidateSha: readOption(argv, "--candidate-sha"),
        candidateTreeSha: readOption(argv, "--candidate-tree"),
        imageDigest: gateImageDigest || null,
        classifierClass: readOption(argv, "--classifier-class") || null,
        terminalState: outcome.terminalState,
        reasonCodes: outcome.reasonCodes,
        // The gate may only have provisioned when it actually ran; a
        // cancellation before the gate (plan/image) provisioned nothing, and
        // states whose schema forbids provisioning (an identity-mismatch
        // infrastructure_error after a successful gate) record false — the
        // gate's always() finalizers and the scheduled sweep own cleanup.
        provisioned: outcome.provisionsAllowed && ["success", "failure", "cancelled"].includes(gateResult),
        startedAt: readOption(argv, "--started-at") ?? completedAt,
        completedAt,
        runId: readOption(argv, "--run-id") ?? env.GITHUB_RUN_ID,
        runAttempt: readOption(argv, "--run-attempt") ?? env.GITHUB_RUN_ATTEMPT,
        evidenceLinks: [runUrl],
        providerHeadroom: Number.isFinite(headroomRuns) && headroomRuns >= 0 ? { headroomRuns } : null,
      });
      event = built.event;
      errors.push(...built.errors);
      const outPath = readOption(argv, "--out");
      if (outPath && errors.length === 0) {
        await writeJsonRecord(outPath, event);
      }
    }
    appendSummary(readOption(argv, "--github-summary"), renderMergeQualificationSummary({ decision, outcome, event }));
    appendOutputs(readOption(argv, "--github-output"), [
      ["terminal_state", outcome.terminalState ?? ""],
      ["record_written", outcome.recordRequired && errors.length === 0 ? "true" : "false"],
    ]);
    console.log(JSON.stringify({ decision: decision.state, outcome, errors }, null, 2));
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      return 1;
    }
    // Advisory: terminal failures are recorded and summarized, never used to
    // turn the merge-group run red from this job.
    return 0;
  }

  if (command === "terminalize") {
    const policyPath = readOption(argv, "--policy") ?? MERGE_QUALIFICATION_POLICY_PATH;
    const decision = evaluateMergeQualificationPolicy(readMergeQualificationPolicyContent(policyPath), { now });
    const run = readJsonFileOrNull(readOption(argv, "--run"));
    const jobsPayload = readJsonFileOrNull(readOption(argv, "--jobs"));
    const artifactsPayload = readJsonFileOrNull(readOption(argv, "--run-artifacts"));
    const resolution = resolveRunTerminalization({
      policyEnabled: decision.enabled,
      policyReasonCode: decision.reasonCode,
      runEvent: run?.event ?? "",
      runConclusion: run?.conclusion ?? "",
      jobs: jobsPayload?.jobs ?? [],
      artifactNames: (artifactsPayload?.artifacts ?? []).map((artifact) => artifact?.name),
    });
    let event = null;
    const errors = [];
    if (resolution.action === "terminalize") {
      // Deterministic, run-derived timestamps and links: a re-delivered or
      // re-run observer rebuilds a byte-identical event, so duplicate
      // terminalization dedupes instead of conflicting.
      const startedAt = run?.run_started_at ?? run?.created_at ?? "";
      const completedAt =
        Date.parse(run?.updated_at ?? "") >= Date.parse(startedAt || "") ? (run?.updated_at ?? "") : startedAt;
      const repository = readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY;
      const built = buildMergeQualificationEvent({
        repository,
        candidateSha: run?.head_sha,
        candidateTreeSha: readOption(argv, "--candidate-tree"),
        imageDigest: null,
        classifierClass: null,
        terminalState: resolution.terminalState,
        reasonCodes: resolution.reasonCodes,
        provisioned: resolution.provisioned === true,
        startedAt,
        completedAt,
        runId: run?.id === undefined || run?.id === null ? "" : String(run.id),
        runAttempt: run?.run_attempt === undefined || run?.run_attempt === null ? "" : String(run.run_attempt),
        evidenceLinks: [
          `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository ?? ""}/actions/runs/${run?.id ?? ""}/attempts/${run?.run_attempt ?? ""}`,
        ],
        providerHeadroom: null,
      });
      event = built.event;
      errors.push(...built.errors);
      const outPath = readOption(argv, "--out");
      if (outPath && errors.length === 0) {
        await writeJsonRecord(outPath, event);
      }
    }
    appendSummary(
      readOption(argv, "--github-summary"),
      [
        "## Merge Qualification Terminalizer",
        "",
        resolution.action === "terminalize"
          ? `- Emitted missing terminal advisory result \`${resolution.terminalState}\` (${resolution.reasonCodes.join(", ")}) for run ${run?.id ?? "unknown"} attempt ${run?.run_attempt ?? "unknown"}.`
          : `- No terminalization needed: \`${resolution.reason}\`.`,
        "",
      ].join("\n"),
    );
    appendOutputs(readOption(argv, "--github-output"), [
      ["action", resolution.action],
      ["skip_reason", resolution.action === "skip" ? resolution.reason : ""],
      ["terminal_state", resolution.action === "terminalize" ? resolution.terminalState : ""],
      ["event_written", resolution.action === "terminalize" && errors.length === 0 ? "true" : "false"],
    ]);
    console.log(JSON.stringify({ decision: decision.state, resolution, event, errors }, null, 2));
    if (errors.length > 0) {
      // A terminalization that cannot produce a valid event must fail loudly:
      // the candidate stays visible as an orphan in delivery health.
      console.error(errors.join("\n"));
      return 1;
    }
    return 0;
  }

  if (command === "join") {
    const events = JSON.parse(readFileSync(readOption(argv, "--events"), "utf8"));
    const releases = JSON.parse(readFileSync(readOption(argv, "--releases"), "utf8"));
    const comparisons = joinMergeQualificationToStaging({ events, releases });
    const outPath = readOption(argv, "--out");
    if (outPath) {
      await writeJsonRecord(outPath, comparisons);
    }
    console.log(JSON.stringify(comparisons, null, 2));
    return 0;
  }

  console.error("usage: merge-qualification-advisory.mjs <policy|route|publish|terminalize|join> [options]");
  return 1;
}

function readJsonFileOrNull(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : value;
}

function isPositiveInteger(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isIsoInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function durationSeconds(start, end) {
  const startMs = Date.parse(start ?? "");
  const endMs = Date.parse(end ?? "");
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? Math.round((endMs - startMs) / 1000)
    : null;
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
