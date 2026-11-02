#!/usr/bin/env node
// Advisory merge-group qualification behind a default-off enablement policy.
//
// This module owns three fixture-proven contracts:
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
//      to the canonical delivery-health readers.
//
// Provider posture: this module reads git metadata, JSON evidence and the
// GitHub queue with a read-only token. It threads NO commerce-provider credential; the only provider-
// touching surface in the advisory chain is the reused merge-gate workflow
// (.github/workflows/platform-merge-gate-verification.yml), whose own
// fail-before-mutation credential matrix governs that boundary. Enablement,
// operator secrets, live drills, and the soak evidence belong to the
// enablement issue; this module ships with the policy disabled.

import { appendFileSync, readFileSync, mkdtempSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import {
  buildMergeGateProvisioningObservation,
  validateMergeGateProvisioningObservation,
} from "./merge-gate-verification.mjs";
import { GIT_LISTING_MAX_BUFFER } from "./lib/git-listing.mjs";
import { RELEASE_QUALIFICATION_REASON_CODES_BY_CLASS } from "./release-qualification-scope.mjs";
import { buildReleaseQualificationRecord } from "./release-qualification-record.mjs";

export const MERGE_QUALIFICATION_POLICY_SCHEMA_VERSION = "merge-qualification-policy/v1";
export const MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION = "merge-qualification-event/v1";
export const MERGE_QUALIFICATION_CANDIDATE_SCHEMA_VERSION = "merge-qualification-candidate/v2";
export const MERGE_QUALIFICATION_DECISION_SCHEMA_VERSION = "merge-qualification-decision/v1";
export const RELEASE_CANDIDATE_LINKAGE_SCHEMA_VERSION = "release-candidate-linkage/v1";
export const MERGE_QUALIFICATION_POLICY_PATH = "scripts/merge-qualification-policy.json";
const PLATFORM_PR_WORKFLOW_PATH = ".github/workflows/platform-pr.yml";
// Ratified on the advisory-qualification cost wager: an enablement window may
// never exceed 30 days, and the expiry clock starts at enablement
// (enabledAt), not at merge.
export const MERGE_QUALIFICATION_MAX_ENABLEMENT_DAYS = 30;

// The scheduled observer revisits only attempts created inside this window:
// long enough for next-day replay to still clean, well inside the 30-day
// retention of the evidence it reads. An attempt that ages out without a
// terminal stays an explicit unknown instead of a permanent inventory refusal.
export const MERGE_QUALIFICATION_INVENTORY_HORIZON_HOURS = 48;
// GitHub returns at most 1,000 runs for a created-filtered runs query.
const RUN_SEARCH_RESULT_CEILING = 1_000;
// The enabled Platform PR producer dispatch is the only route that starts an
// advisory attempt, so each producer attempt has at most one advisory run.
const ADVISORY_RUN_TITLE = /^Merge Qualification producer ([1-9][0-9]{0,15})-([1-9][0-9]{0,15})$/;

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

// A durable namespace-created observation may precede pass, fail,
// cancellation, or a later infrastructure failure. Routing-only outcomes can
// never carry that observation.
const PROVISIONING_TERMINAL_STATES = new Set(["passed", "failed", "cancelled_evicted", "infrastructure_error"]);

const POLICY_DISABLED_REASONS = Object.freeze([
  "policy_absent",
  "policy_malformed",
  "policy_schema_unsupported",
  "policy_disabled",
  "policy_expired",
  "policy_expiry_horizon_exceeded",
]);
const TERMINAL_REASON_CODES = Object.freeze({
  passed: new Set(["gate_passed"]),
  failed: new Set(["gate_failed"]),
  not_applicable: new Set([...RELEASE_QUALIFICATION_REASON_CODES_BY_CLASS.not_applicable, "classifier_not_applicable"]),
  persistent_required: new Set([
    ...RELEASE_QUALIFICATION_REASON_CODES_BY_CLASS.persistent_required,
    "classifier_persistent_required",
  ]),
  cancelled_evicted: new Set([
    "gate_cancelled",
    "image_cancelled",
    "plan_cancelled",
    "publisher_cancelled",
    "run_force_cancelled",
    "candidate_evicted",
  ]),
  infrastructure_error: new Set([
    "advisory_result_missing",
    "built_digest_missing",
    "candidate_image_unavailable",
    "candidate_sha_mismatch",
    "candidate_sha_missing",
    "candidate_tree_mismatch",
    "candidate_tree_missing",
    "classifier_class_unknown",
    "classifier_output_missing",
    "gate_candidate_sha_missing",
    "gate_candidate_tree_missing",
    "gate_digest_missing",
    "gate_not_invoked",
    "image_digest_mismatch",
    "immutable_identity_unavailable",
    "plan_failed",
    "policy_decision_evidence_missing",
    "publisher_skipped_enabled",
    "queue_disposition_unknown",
  ]),
});

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_IDENTITY_LENGTH = 256;
const MAX_REASON_CODES = 16;
const MAX_EVIDENCE_LINKS = 16;
const MAX_EVIDENCE_LINK_LENGTH = 2_048;
const MAX_HEADROOM_RUNS = 10_000;
const MAX_QUALIFICATIONS_PER_DAY = 1_000;
const MAX_DOLLAR_CEILING_USD = 10_000;
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
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zone === "Z" ? 0 : Number(offsetHourText);
  const offsetMinute = zone === "Z" ? 0 : Number(offsetMinuteText);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
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
    const disabledShapeErrors = [];
    if (
      policy.owner !== undefined &&
      policy.owner !== null &&
      (typeof policy.owner !== "string" || !policy.owner.trim() || policy.owner.trim().length > 128)
    ) {
      disabledShapeErrors.push("disabled policy owner must be null or a bounded non-empty string.");
    }
    if (policy.ceiling !== undefined && policy.ceiling !== null) {
      if (!isClosedObject(policy.ceiling, [...KNOWN_CEILING_FIELDS])) {
        disabledShapeErrors.push("disabled policy ceiling must be null or the exact closed ceiling object.");
      } else if (
        !Number.isFinite(policy.ceiling.dollarCeilingUsd) ||
        policy.ceiling.dollarCeilingUsd <= 0 ||
        policy.ceiling.dollarCeilingUsd > MAX_DOLLAR_CEILING_USD ||
        !Number.isSafeInteger(policy.ceiling.maxQualificationsPerDay) ||
        policy.ceiling.maxQualificationsPerDay <= 0 ||
        policy.ceiling.maxQualificationsPerDay > MAX_QUALIFICATIONS_PER_DAY
      ) {
        disabledShapeErrors.push("disabled policy ceiling values are outside the bounded contract.");
      }
    }
    const disabledEnabledAtMs = parseTimezoneInstantMs(policy.enabledAt);
    const disabledExpiresAtMs = parseTimezoneInstantMs(policy.expiresAt);
    for (const field of ["enabledAt", "expiresAt"]) {
      if (policy[field] !== undefined && policy[field] !== null && parseTimezoneInstantMs(policy[field]) === null) {
        disabledShapeErrors.push(`disabled policy ${field} must be null or a calendar-valid timezone instant.`);
      }
    }
    const disabledHasOwner = typeof policy.owner === "string" && policy.owner.trim().length > 0;
    const disabledHasCeiling = policy.ceiling !== undefined && policy.ceiling !== null;
    const disabledHasEnabledAt = disabledEnabledAtMs !== null;
    const disabledHasExpiresAt = disabledExpiresAtMs !== null;
    if (new Set([disabledHasOwner, disabledHasCeiling, disabledHasEnabledAt, disabledHasExpiresAt]).size > 1) {
      disabledShapeErrors.push(
        "disabled policy owner, ceiling, enabledAt, and expiresAt must be either all null/absent or one coherent retained window.",
      );
    }
    if (disabledHasEnabledAt && !(disabledEnabledAtMs < disabledExpiresAtMs)) {
      disabledShapeErrors.push("disabled policy expiresAt must be strictly after enabledAt.");
    }
    if (
      disabledHasEnabledAt &&
      disabledExpiresAtMs - disabledEnabledAtMs > MERGE_QUALIFICATION_MAX_ENABLEMENT_DAYS * 24 * 60 * 60 * 1000
    ) {
      disabledShapeErrors.push(
        `disabled policy retained advisory window must not exceed ${MERGE_QUALIFICATION_MAX_ENABLEMENT_DAYS} days.`,
      );
    }
    if (policy.notes !== undefined && (typeof policy.notes !== "string" || policy.notes.length > 2_048)) {
      disabledShapeErrors.push("disabled policy notes must be a bounded string.");
    }
    if (disabledShapeErrors.length > 0) return disabledDecision("policy_malformed", disabledShapeErrors);
    return disabledDecision("policy_disabled", ["the enablement policy is present and explicitly disabled."]);
  }
  if (policy.enabled !== true) {
    return disabledDecision("policy_malformed", ["policy enabled must be a boolean; failing closed to disabled."]);
  }

  // enabled === true: owner, ceiling, enabledAt, and expiresAt become
  // mandatory, and the expiry clock is anchored at enablement. The window
  // contract is explicit: enabledAt < expiresAt <= enabledAt + 30 days.
  const errors = [];
  if (policy.notes !== undefined && (typeof policy.notes !== "string" || policy.notes.length > 2_048)) {
    errors.push("policy notes must be a bounded string when present.");
  }
  if (typeof policy.owner !== "string" || !policy.owner.trim() || policy.owner.trim().length > 128) {
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
    if (
      !(
        Number.isFinite(policy.ceiling.dollarCeilingUsd) &&
        policy.ceiling.dollarCeilingUsd > 0 &&
        policy.ceiling.dollarCeilingUsd <= MAX_DOLLAR_CEILING_USD
      )
    ) {
      errors.push(`an enabled policy must declare 0 < ceiling.dollarCeilingUsd <= ${MAX_DOLLAR_CEILING_USD}.`);
    }
    if (
      !(
        Number.isSafeInteger(policy.ceiling.maxQualificationsPerDay) &&
        policy.ceiling.maxQualificationsPerDay > 0 &&
        policy.ceiling.maxQualificationsPerDay <= MAX_QUALIFICATIONS_PER_DAY
      )
    ) {
      errors.push(
        `an enabled policy must declare safe integer 0 < ceiling.maxQualificationsPerDay <= ${MAX_QUALIFICATIONS_PER_DAY}.`,
      );
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

export function buildMergeQualificationCandidate(input) {
  const pullRequests = Array.isArray(input.pullRequests)
    ? input.pullRequests
        .map((pull) => ({ number: pull?.number, headSha: lowerTrim(pull?.headSha) }))
        .sort((left, right) => Number(left.number) - Number(right.number))
    : [];
  const record = {
    schemaVersion: MERGE_QUALIFICATION_CANDIDATE_SCHEMA_VERSION,
    repository: normalize(input.repository),
    workflowId: normalize(input.workflowId),
    workflowPath: normalize(input.workflowPath),
    runId: normalize(input.runId),
    runAttempt: normalize(input.runAttempt),
    queueBaseSha: lowerTrim(input.queueBaseSha),
    pullRequests,
    candidateSha: input.candidateSha ? lowerTrim(input.candidateSha) : null,
    candidateTreeSha: input.candidateTreeSha ? lowerTrim(input.candidateTreeSha) : null,
    builtImageDigest: lowerTrim(input.builtImageDigest),
    policyRevision: lowerTrim(input.policyRevision),
    capturedAt: normalize(input.capturedAt),
  };
  return { record, errors: validateMergeQualificationCandidate(record) };
}

// Merge-queue entry states GitHub reports while a candidate is still queued.
// UNMERGEABLE is excluded: an unmergeable entry can never become this run's
// merged candidate, so it must not source candidate identity.
export const PRE_MERGE_QUEUE_ENTRY_STATES = Object.freeze(["QUEUED", "AWAITING_CHECKS", "MERGEABLE", "LOCKED"]);

// GitHub's Actions run representation does not populate `pull_requests` for
// real merge_group runs, and `commits/<merge-group SHA>/pulls` stays empty
// until AFTER the pull request merges (live merge-group run 29888165410
// demonstrated the post-merge timing), so neither can identify the candidate
// at producer time. The only association GitHub exposes while the candidate
// is still queued is the merge queue itself: the GraphQL mergeQueue entry
// whose immutable headCommit.oid IS this run's merge-group SHA names the
// exact pull request being merged. The producing merge_group run captures
// that snapshot while its own candidate is still queued, and this boundary
// derives (rather than accepts) workflow/run/SHA/tree/PR identity from it.
// The temporal guard is structural: GitHub removes the entry at merge or
// dequeue, so a snapshot taken after merge has no entry for this SHA and the
// build refuses; the run metadata must also still be in flight.
export function buildMergeQualificationCandidateFromMergeQueueSnapshot(input) {
  const run = input?.run;
  const repository = normalize(input?.repository);
  const queueBaseSha = lowerTrim(input?.queueBaseSha);
  const candidateSha = lowerTrim(run?.head_sha);
  const candidateTreeSha = lowerTrim(run?.head_commit?.tree_id);
  const snapshot = input?.mergeQueueSnapshot;
  const metadataErrors = [];

  if (
    typeof run !== "object" ||
    run === null ||
    Array.isArray(run) ||
    run.event !== "merge_group" ||
    run.path !== PLATFORM_PR_WORKFLOW_PATH ||
    !isBoundedSafeIntegerString(String(run.workflow_id ?? "")) ||
    !isBoundedSafeIntegerString(String(run.id ?? "")) ||
    !isBoundedSafeIntegerString(String(run.run_attempt ?? "")) ||
    !["queued", "in_progress"].includes(run.status)
  ) {
    metadataErrors.push("candidate Actions run metadata is not an in-flight Platform PR merge_group attempt.");
  }
  if (run?.repository?.full_name !== repository) {
    metadataErrors.push("candidate Actions run repository does not match the requested repository.");
  }
  if (
    !isCommitSha(candidateSha) ||
    !isCommitSha(candidateTreeSha) ||
    lowerTrim(run?.head_commit?.id) !== candidateSha
  ) {
    metadataErrors.push("candidate Actions run does not carry an exact head SHA/tree identity.");
  }
  if (!isCommitSha(queueBaseSha)) metadataErrors.push("candidate merge_group base SHA is invalid.");

  const entriesConnection =
    isClosedObject(snapshot, ["data"]) &&
    isClosedObject(snapshot.data, ["repository"]) &&
    isClosedObject(snapshot.data.repository, ["mergeQueue"]) &&
    isClosedObject(snapshot.data.repository.mergeQueue, ["entries"]) &&
    isClosedObject(snapshot.data.repository.mergeQueue.entries, ["totalCount", "nodes"])
      ? snapshot.data.repository.mergeQueue.entries
      : null;
  const nodes = Array.isArray(entriesConnection?.nodes) ? entriesConnection.nodes : null;
  if (
    entriesConnection === null ||
    nodes === null ||
    !Number.isSafeInteger(entriesConnection.totalCount) ||
    entriesConnection.totalCount < 1 ||
    entriesConnection.totalCount > 100 ||
    entriesConnection.totalCount !== nodes.length ||
    nodes.some((node) => typeof node !== "object" || node === null || Array.isArray(node))
  ) {
    metadataErrors.push("candidate merge-queue snapshot is not a complete closed queue observation.");
  }

  const matches = (nodes ?? []).filter((node) => lowerTrim(node?.headCommit?.oid) === candidateSha);
  const pullRequests = [];
  if (matches.length !== 1) {
    metadataErrors.push(
      "candidate merge-queue snapshot holds no still-queued entry for this merge-group SHA; the queue association is only observable before merge.",
    );
  } else {
    const entry = matches[0];
    const number = entry?.pullRequest?.number;
    const headSha = lowerTrim(entry?.pullRequest?.headRefOid);
    if (
      !isClosedObject(entry, ["position", "state", "solo", "enqueuedAt", "headCommit", "baseCommit", "pullRequest"]) ||
      !isClosedObject(entry.headCommit, ["oid"]) ||
      !isClosedObject(entry.baseCommit, ["oid"]) ||
      !isClosedObject(entry.pullRequest, ["number", "headRefOid"]) ||
      !Number.isSafeInteger(entry.position) ||
      entry.position < 0 ||
      typeof entry.solo !== "boolean" ||
      parseTimezoneInstantMs(entry.enqueuedAt) === null ||
      !PRE_MERGE_QUEUE_ENTRY_STATES.includes(entry.state) ||
      lowerTrim(entry.baseCommit.oid) !== queueBaseSha ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      !isCommitSha(headSha)
    ) {
      metadataErrors.push("candidate merge-queue entry is not an exact queued PR/head/base identity.");
    } else {
      pullRequests.push({ number, headSha });
    }
  }

  const built = buildMergeQualificationCandidate({
    repository,
    workflowId: String(run?.workflow_id ?? ""),
    workflowPath: run?.path,
    runId: String(run?.id ?? ""),
    runAttempt: String(run?.run_attempt ?? ""),
    queueBaseSha,
    pullRequests,
    candidateSha,
    candidateTreeSha,
    builtImageDigest: input?.builtImageDigest,
    policyRevision: input?.policyRevision,
    capturedAt: input?.capturedAt,
  });
  return { record: built.record, errors: [...new Set([...metadataErrors, ...built.errors])] };
}

// Post-merge verification rebuild for release discovery ONLY: after the
// candidate merges, GET /commits/<merge-group SHA>/pulls returns the PRs
// whose merge_commit_sha is that immutable queue candidate, so the scheduled
// collector re-derives the same closed record from durable post-merge state
// and requires byte-equivalence with the producer's queue-snapshot record.
// That association is empty while the candidate is still queued, so it can
// never source producer-time identity (see
// buildMergeQualificationCandidateFromMergeQueueSnapshot).
export function buildMergeQualificationCandidateFromMergedCommitAssociation(input) {
  const run = input?.run;
  const repository = normalize(input?.repository);
  const queueBaseSha = lowerTrim(input?.queueBaseSha);
  const candidateSha = lowerTrim(run?.head_sha);
  const candidateTreeSha = lowerTrim(run?.head_commit?.tree_id);
  const pages = input?.associatedPullRequestPages;
  const metadataErrors = [];

  if (
    typeof run !== "object" ||
    run === null ||
    Array.isArray(run) ||
    run.event !== "merge_group" ||
    run.path !== PLATFORM_PR_WORKFLOW_PATH ||
    !isBoundedSafeIntegerString(String(run.workflow_id ?? "")) ||
    !isBoundedSafeIntegerString(String(run.id ?? "")) ||
    !isBoundedSafeIntegerString(String(run.run_attempt ?? "")) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    metadataErrors.push("candidate Actions run metadata is not an exact Platform PR merge_group attempt.");
  }
  if (run?.repository?.full_name !== repository) {
    metadataErrors.push("candidate Actions run repository does not match the requested repository.");
  }
  if (
    !isCommitSha(candidateSha) ||
    !isCommitSha(candidateTreeSha) ||
    lowerTrim(run?.head_commit?.id) !== candidateSha
  ) {
    metadataErrors.push("candidate Actions run does not carry an exact head SHA/tree identity.");
  }
  if (!isCommitSha(queueBaseSha)) metadataErrors.push("candidate merge_group base SHA is invalid.");
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
    metadataErrors.push("candidate commit-associated pull request pages are invalid.");
  }

  const associatedPulls = Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : [];
  const seenNumbers = new Set();
  const pullRequests = [];
  if (associatedPulls.length === 0 || associatedPulls.length > 100) {
    metadataErrors.push("candidate commit association must resolve one to 100 pull requests.");
  }
  for (const pull of associatedPulls) {
    const number = pull?.number;
    const headSha = lowerTrim(pull?.head?.sha);
    const mergeCommitSha = lowerTrim(pull?.merge_commit_sha);
    const baseSha = lowerTrim(pull?.base?.sha);
    if (
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      seenNumbers.has(number) ||
      !isCommitSha(headSha) ||
      mergeCommitSha !== candidateSha ||
      baseSha !== queueBaseSha
    ) {
      metadataErrors.push(
        "candidate commit association is mismatched or ambiguous for its exact PR/head/base/merge identity.",
      );
      continue;
    }
    seenNumbers.add(number);
    pullRequests.push({ number, headSha });
  }

  const built = buildMergeQualificationCandidate({
    repository,
    workflowId: String(run?.workflow_id ?? ""),
    workflowPath: run?.path,
    runId: String(run?.id ?? ""),
    runAttempt: String(run?.run_attempt ?? ""),
    queueBaseSha,
    pullRequests,
    candidateSha,
    candidateTreeSha,
    builtImageDigest: input?.builtImageDigest,
    policyRevision: input?.policyRevision,
    capturedAt: input?.capturedAt,
  });
  return { record: built.record, errors: [...new Set([...metadataErrors, ...built.errors])] };
}

export function validateMergeQualificationCandidate(record) {
  if (
    !isClosedObject(record, [
      "schemaVersion",
      "repository",
      "workflowId",
      "workflowPath",
      "runId",
      "runAttempt",
      "queueBaseSha",
      "pullRequests",
      "candidateSha",
      "candidateTreeSha",
      "builtImageDigest",
      "policyRevision",
      "capturedAt",
    ])
  ) {
    return ["candidate evidence must be a closed object."];
  }
  const errors = [];
  if (record.schemaVersion !== MERGE_QUALIFICATION_CANDIDATE_SCHEMA_VERSION)
    errors.push("unsupported candidate schema.");
  if (!isRepositoryIdentity(record.repository)) errors.push("candidate repository is invalid.");
  if (!isBoundedSafeIntegerString(record.workflowId) || !isWorkflowPath(record.workflowPath)) {
    errors.push("candidate workflow identity is invalid.");
  }
  if (!isBoundedSafeIntegerString(record.runId) || !isBoundedSafeIntegerString(record.runAttempt)) {
    errors.push("candidate run identity is invalid.");
  }
  if (!isCommitSha(record.queueBaseSha)) errors.push("candidate queueBaseSha is invalid.");
  if (
    !Array.isArray(record.pullRequests) ||
    record.pullRequests.length === 0 ||
    record.pullRequests.length > 100 ||
    new Set(record.pullRequests.map((pull) => pull?.number)).size !== record.pullRequests.length ||
    record.pullRequests.some(
      (pull) =>
        !isClosedObject(pull, ["number", "headSha"]) ||
        !Number.isSafeInteger(pull.number) ||
        pull.number <= 0 ||
        !isCommitSha(pull.headSha),
    )
  ) {
    errors.push("candidate pullRequests must be a non-empty unique list of exact PR/head identities.");
  }
  if (!isCommitSha(record.candidateSha) || !isCommitSha(record.candidateTreeSha))
    errors.push("candidate git identity is invalid.");
  if (!IMAGE_DIGEST_PATTERN.test(record.builtImageDigest ?? "")) errors.push("candidate builtImageDigest is invalid.");
  if (!isCommitSha(record.policyRevision)) errors.push("candidate policyRevision is invalid.");
  if (parseTimezoneInstantMs(record.capturedAt) === null) errors.push("candidate capturedAt is invalid.");
  return errors;
}

export function buildMergeQualificationDecision(input) {
  const decision = {
    schemaVersion: MERGE_QUALIFICATION_DECISION_SCHEMA_VERSION,
    repository: normalize(input.repository),
    workflowId: normalize(input.workflowId),
    workflowPath: normalize(input.workflowPath),
    runId: normalize(input.runId),
    runAttempt: normalize(input.runAttempt),
    parentWorkflowId: normalize(input.parentWorkflowId),
    parentWorkflowPath: normalize(input.parentWorkflowPath),
    parentRunId: normalize(input.parentRunId),
    parentRunAttempt: normalize(input.parentRunAttempt),
    candidateSha: input.candidateSha == null ? null : lowerTrim(input.candidateSha),
    candidateTreeSha: input.candidateTreeSha == null ? null : lowerTrim(input.candidateTreeSha),
    builtImageDigest: input.builtImageDigest ? lowerTrim(input.builtImageDigest) : null,
    policyRevision: lowerTrim(input.policyRevision),
    policyEnabled: input.policyEnabled === true,
    policyReasonCode: input.policyReasonCode || null,
    classifierClass: input.classifierClass || null,
    classifierReasonCodes: normalizeReasonCodes(input.classifierReasonCodes),
    observedAt: normalize(input.observedAt),
  };
  return { decision, errors: validateMergeQualificationDecision(decision) };
}

export function validateMergeQualificationDecision(decision) {
  const fields = [
    "schemaVersion",
    "repository",
    "workflowId",
    "workflowPath",
    "runId",
    "runAttempt",
    "parentWorkflowId",
    "parentWorkflowPath",
    "parentRunId",
    "parentRunAttempt",
    "candidateSha",
    "candidateTreeSha",
    "builtImageDigest",
    "policyRevision",
    "policyEnabled",
    "policyReasonCode",
    "classifierClass",
    "classifierReasonCodes",
    "observedAt",
  ];
  if (!isClosedObject(decision, fields)) return ["decision evidence must be a closed object."];
  const errors = [];
  if (decision.schemaVersion !== MERGE_QUALIFICATION_DECISION_SCHEMA_VERSION)
    errors.push("unsupported decision schema.");
  if (!isRepositoryIdentity(decision.repository)) errors.push("decision repository is invalid.");
  for (const [id, workflowPath] of [
    [decision.workflowId, decision.workflowPath],
    [decision.parentWorkflowId, decision.parentWorkflowPath],
  ]) {
    if (!isBoundedSafeIntegerString(id) || !isWorkflowPath(workflowPath)) {
      errors.push("decision workflow binding is invalid.");
    }
  }
  if (
    !isBoundedSafeIntegerString(decision.runId) ||
    !isBoundedSafeIntegerString(decision.runAttempt) ||
    !isBoundedSafeIntegerString(decision.parentRunId) ||
    !isBoundedSafeIntegerString(decision.parentRunAttempt)
  ) {
    errors.push("decision run binding is invalid.");
  }
  const candidateIdentityPresent = decision.candidateSha !== null || decision.candidateTreeSha !== null;
  if (candidateIdentityPresent && (!isCommitSha(decision.candidateSha) || !isCommitSha(decision.candidateTreeSha))) {
    errors.push("decision candidate identity must be null or a complete SHA/tree pair.");
  }
  if (decision.builtImageDigest !== null && !IMAGE_DIGEST_PATTERN.test(decision.builtImageDigest ?? "")) {
    errors.push("decision builtImageDigest is invalid.");
  }
  if (typeof decision.policyEnabled !== "boolean") errors.push("decision policyEnabled must be boolean.");
  if (!isCommitSha(decision.policyRevision)) errors.push("decision policyRevision must be an exact commit SHA.");
  if (
    decision.policyReasonCode !== null &&
    (typeof decision.policyReasonCode !== "string" ||
      decision.policyReasonCode.length > 64 ||
      !REASON_CODE_PATTERN.test(decision.policyReasonCode))
  ) {
    errors.push("decision policyReasonCode is invalid.");
  }
  if (
    decision.policyEnabled &&
    decision.classifierClass !== null &&
    !["isolated", "not_applicable", "persistent_required"].includes(decision.classifierClass)
  ) {
    errors.push("enabled decision requires an exact classifierClass.");
  }
  if (decision.policyEnabled && decision.policyReasonCode !== null) {
    errors.push("enabled decision cannot carry a disabled-policy reason code.");
  }
  if (
    decision.classifierClass !== null &&
    (!isCommitSha(decision.candidateSha) || !isCommitSha(decision.candidateTreeSha))
  ) {
    errors.push("enabled decision requires independently observed candidate SHA/tree evidence.");
  }
  if (!decision.policyEnabled) {
    if (!POLICY_DISABLED_REASONS.includes(decision.policyReasonCode)) {
      errors.push("disabled decision requires a closed disabled-policy reason code.");
    }
    if (decision.classifierClass !== null) errors.push("disabled decision cannot classify a candidate.");
  }
  if (
    !Array.isArray(decision.classifierReasonCodes) ||
    decision.classifierReasonCodes.length > MAX_REASON_CODES ||
    new Set(decision.classifierReasonCodes).size !== decision.classifierReasonCodes.length ||
    decision.classifierReasonCodes.some(
      (code) => typeof code !== "string" || code.length > 64 || !REASON_CODE_PATTERN.test(code),
    )
  ) {
    errors.push("decision classifierReasonCodes is invalid.");
  } else if (decision.policyEnabled && decision.classifierClass !== null) {
    const allowed = RELEASE_QUALIFICATION_REASON_CODES_BY_CLASS[decision.classifierClass];
    if (
      decision.classifierReasonCodes.length === 0 ||
      !allowed ||
      decision.classifierReasonCodes.some((code) => !allowed.includes(code))
    ) {
      errors.push("enabled decision classifier reasons must belong to its exact classifier state.");
    }
  } else if (decision.classifierReasonCodes.length !== 0) {
    errors.push("disabled or unclassified decision cannot carry classifier reason codes.");
  }
  if (parseTimezoneInstantMs(decision.observedAt) === null) errors.push("decision observedAt is invalid.");
  return errors;
}

export function recoverMergeQualificationDecision({
  run,
  parentRun,
  candidate = null,
  policyRevision,
  policyContent,
  classifierRecord = null,
} = {}) {
  const title = ADVISORY_RUN_TITLE.exec(run?.display_title ?? "");
  const recordedPolicyRevision = policyRevision;
  if (
    !isCommitSha(recordedPolicyRevision) ||
    !isCommitSha(run?.head_sha) ||
    recordedPolicyRevision !== run.head_sha ||
    parseTimezoneInstantMs(run?.run_started_at) === null ||
    run?.event !== "workflow_dispatch" ||
    run?.path !== ".github/workflows/platform-merge-qualification.yml" ||
    parentRun?.path !== PLATFORM_PR_WORKFLOW_PATH ||
    parentRun?.event !== "merge_group" ||
    parentRun?.repository?.full_name !== run?.repository?.full_name ||
    title?.[1] !== String(parentRun?.id) ||
    title?.[2] !== String(parentRun?.run_attempt)
  ) {
    return { decision: null, errors: ["original policy revision or run-attempt binding is unavailable."] };
  }
  const policy = evaluateMergeQualificationPolicy(policyContent, { now: () => new Date(run.run_started_at) });
  if (
    policy.enabled &&
    candidate !== null &&
    (validateMergeQualificationCandidate(candidate).length > 0 ||
      candidate.repository !== parentRun.repository.full_name ||
      candidate.runId !== String(parentRun.id) ||
      candidate.runAttempt !== String(parentRun.run_attempt) ||
      candidate.workflowId !== String(parentRun.workflow_id) ||
      candidate.candidateSha !== parentRun.head_sha)
  ) {
    return { decision: null, errors: ["original enabled decision requires exact producer candidate evidence."] };
  }
  if (
    policy.enabled &&
    classifierRecord !== null &&
    (!candidate ||
      classifierRecord.schemaVersion !== "release-qualification-scope/v1" ||
      classifierRecord.candidate?.sha !== candidate.candidateSha ||
      classifierRecord.candidate?.treeSha !== candidate.candidateTreeSha)
  ) {
    return { decision: null, errors: ["original classifier observation does not bind the candidate SHA/tree."] };
  }
  return buildMergeQualificationDecision({
    repository: run.repository.full_name,
    workflowId: String(run.workflow_id),
    workflowPath: run.path,
    runId: String(run.id),
    runAttempt: String(run.run_attempt),
    parentWorkflowId: String(parentRun.workflow_id),
    parentWorkflowPath: parentRun.path,
    parentRunId: String(parentRun.id),
    parentRunAttempt: String(parentRun.run_attempt),
    policyRevision: recordedPolicyRevision,
    policyEnabled: policy.enabled,
    policyReasonCode: policy.reasonCode,
    candidateSha: policy.enabled ? candidate?.candidateSha : null,
    candidateTreeSha: policy.enabled ? candidate?.candidateTreeSha : null,
    builtImageDigest: policy.enabled ? candidate?.builtImageDigest : null,
    classifierClass: policy.enabled ? classifierRecord?.class : null,
    classifierReasonCodes: policy.enabled ? classifierRecord?.reasonCodes : [],
    observedAt: run.run_started_at,
  });
}

export function buildCancelledMergeQualificationRecord({ decision, ownership, run } = {}) {
  if (
    validateMergeQualificationDecision(decision).length > 0 ||
    !decision.policyEnabled ||
    decision.classifierClass !== "isolated" ||
    validateMergeGateProvisioningObservation(ownership, {
      repository: decision.repository,
      workflowId: decision.workflowId,
      workflowPath: decision.workflowPath,
      runId: decision.runId,
      runAttempt: decision.runAttempt,
    }).length > 0 ||
    run?.conclusion !== "cancelled" ||
    run?.repository?.full_name !== decision.repository ||
    String(run?.workflow_id) !== decision.workflowId ||
    run?.path !== decision.workflowPath ||
    String(run?.id) !== decision.runId ||
    String(run?.run_attempt) !== decision.runAttempt ||
    run?.head_sha !== decision.policyRevision ||
    parseTimezoneInstantMs(run?.run_started_at) !== parseTimezoneInstantMs(decision.observedAt) ||
    parseTimezoneInstantMs(run?.updated_at) === null ||
    ownership.candidateSha !== decision.candidateSha ||
    ownership.candidateTreeSha !== decision.candidateTreeSha ||
    ownership.imageDigest !== decision.builtImageDigest
  )
    return { record: null, errors: ["cancelled_record_binding_invalid"] };
  return buildReleaseQualificationRecord({
    repository: ownership.repository,
    candidateSha: ownership.candidateSha,
    candidateTreeSha: ownership.candidateTreeSha,
    imageRepository: "registry.digitalocean.com/chase-sets/chase-sets-platform",
    imageDigest: ownership.imageDigest,
    qualificationLane: "merge-gate",
    classifierPolicyVersion: "release-qualification-scope/v1",
    runId: ownership.runId,
    runAttempt: ownership.runAttempt,
    startedAt: new Date(decision.observedAt).toISOString(),
    completedAt: new Date(run.updated_at).toISOString(),
    result: "fail",
    evidenceLinks: [`https://github.com/${decision.repository}/actions/runs/${decision.runId}`],
  });
}

export function resolveMergeQualificationQueueDisposition({ candidate, snapshot } = {}) {
  if (validateMergeQualificationCandidate(candidate).length > 0 || snapshot?.errors?.length) return "unknown";
  const repository = snapshot?.data?.repository;
  const entries = repository?.mergeQueue?.entries;
  if (
    repository?.nameWithOwner !== candidate.repository ||
    !Array.isArray(entries?.nodes) ||
    !Number.isSafeInteger(entries.totalCount) ||
    entries.totalCount < 0 ||
    entries.totalCount > 100 ||
    entries.totalCount !== entries.nodes.length ||
    entries.nodes.some(
      (node) =>
        !isCommitSha(node?.headCommit?.oid) ||
        !isCommitSha(node?.baseCommit?.oid) ||
        !Number.isSafeInteger(node?.pullRequest?.number) ||
        !isCommitSha(node?.pullRequest?.headRefOid),
    )
  )
    return "unknown";
  const pulls = candidate.pullRequests.map(({ number }) => repository[`pr${number}`]);
  if (
    pulls.some(
      (pull, i) =>
        pull?.number !== candidate.pullRequests[i].number ||
        !isCommitSha(pull?.headRefOid) ||
        typeof pull?.merged !== "boolean" ||
        !["OPEN", "CLOSED", "MERGED"].includes(pull?.state),
    )
  )
    return "unknown";
  const matches = entries.nodes.filter((node) => node.headCommit.oid === candidate.candidateSha);
  if (matches.length > 0) {
    return matches.length === candidate.pullRequests.length &&
      new Set(matches.map((node) => node.pullRequest.number)).size === matches.length &&
      matches.every(
        (node) =>
          PRE_MERGE_QUEUE_ENTRY_STATES.includes(node.state) &&
          node.baseCommit.oid === candidate.queueBaseSha &&
          candidate.pullRequests.some(
            (pull) => pull.number === node.pullRequest.number && pull.headSha === node.pullRequest.headRefOid,
          ),
      ) &&
      pulls.every(
        (pull, i) => pull.state === "OPEN" && !pull.merged && pull.headRefOid === candidate.pullRequests[i].headSha,
      )
      ? "queued"
      : "unknown";
  }
  if (
    pulls.every(
      (pull, i) =>
        pull.merged &&
        pull.state === "MERGED" &&
        pull.mergeCommit?.oid === candidate.candidateSha &&
        pull.headRefOid === candidate.pullRequests[i].headSha,
    )
  )
    return "merged";
  if (
    pulls.some(
      (pull, i) => !pull.merged && (pull.state === "CLOSED" || pull.headRefOid !== candidate.pullRequests[i].headSha),
    )
  )
    return "evicted";
  return "unknown";
}

export async function observeMergeQualificationQueueDisposition(
  candidate,
  { token, fetchImpl = fetch, branch = "main" } = {},
) {
  if (validateMergeQualificationCandidate(candidate).length > 0 || !token) return "unknown";
  const [owner, name] = candidate.repository.split("/");
  const query = `query($owner:String!,$name:String!,$branch:String!) { repository(owner:$owner,name:$name) {
    nameWithOwner mergeQueue(branch:$branch) { entries(first:100) { totalCount nodes {
      state headCommit { oid } baseCommit { oid } pullRequest { number headRefOid }
    } } } ${candidate.pullRequests
      .map(
        ({ number }) => `pr${number}:pullRequest(number:${number}) {
      number headRefOid state merged mergeCommit { oid }
    }`,
      )
      .join(" ")} } }`;
  try {
    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { owner, name, branch } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return "unknown";
    return resolveMergeQualificationQueueDisposition({ candidate, snapshot: await response.json() });
  } catch {
    return "unknown";
  }
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
    provisionsAllowed: ["passed", "failed", "cancelled_evicted"].includes(state),
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
    const identityErrors = gateIdentityErrors(input);
    if (identityErrors.length > 0) {
      return terminal("infrastructure_error", ["immutable_identity_unavailable", ...identityErrors]);
    }
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
  if (!IMAGE_DIGEST_PATTERN.test(builtDigest)) {
    errors.push("built_digest_missing");
  }
  if (!IMAGE_DIGEST_PATTERN.test(gateDigest)) {
    errors.push("gate_digest_missing");
  } else if (IMAGE_DIGEST_PATTERN.test(builtDigest) && builtDigest !== gateDigest) {
    errors.push("image_digest_mismatch");
  }
  if (!isCommitSha(lowerTrim(input.candidateSha))) {
    errors.push("candidate_sha_missing");
  } else if (!isCommitSha(lowerTrim(input.gateCandidateSha))) {
    errors.push("gate_candidate_sha_missing");
  } else if (bothPresentAndDiffer(input.candidateSha, input.gateCandidateSha)) {
    errors.push("candidate_sha_mismatch");
  }
  if (!isCommitSha(lowerTrim(input.candidateTreeSha))) {
    errors.push("candidate_tree_missing");
  } else if (!isCommitSha(lowerTrim(input.gateCandidateTreeSha))) {
    errors.push("gate_candidate_tree_missing");
  } else if (bothPresentAndDiffer(input.candidateTreeSha, input.gateCandidateTreeSha)) {
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

// The observer resolves the attempt only after owned-resource cleanup.
// Artifact names are not terminal authority. Missing original eligibility
// stays unknown; cancellation and proven eviction override child success.

export function resolveMergeQualificationTerminalReplay({ decision, records } = {}) {
  const unknown = (code) => ({ action: "unknown", event: null, errors: [code] });
  if (validateMergeQualificationDecision(decision).length || !Array.isArray(records) || records.length > 10_000) {
    return unknown("terminal_inventory_invalid");
  }
  let event = null;
  let original = null;
  for (const bytes of records) {
    if (typeof bytes !== "string" || Buffer.byteLength(bytes) > 65_536) return unknown("terminal_payload_invalid");
    let record;
    try {
      record = JSON.parse(bytes);
    } catch {
      return unknown("terminal_payload_invalid");
    }
    if (
      !decision.policyEnabled ||
      validateMergeQualificationEvent(record).length ||
      [
        "repository",
        "workflowId",
        "workflowPath",
        "runId",
        "runAttempt",
        "parentWorkflowId",
        "parentWorkflowPath",
        "parentRunId",
        "parentRunAttempt",
        "candidateSha",
        "candidateTreeSha",
        "classifierClass",
      ].some((key) => record[key] !== decision[key]) ||
      parseTimezoneInstantMs(record.startedAt) !== parseTimezoneInstantMs(decision.observedAt) ||
      (["passed", "failed"].includes(record.terminalState) && record.builtImageDigest !== decision.builtImageDigest)
    )
      return unknown("terminal_payload_binding_invalid");
    if (original !== null && original !== bytes) return unknown("terminal_payload_conflict");
    original = bytes;
    event = record;
  }
  return { action: event ? "replay" : "missing", event, errors: [] };
}

// One complete, created-filtered listing of advisory runs inside the 48-hour
// window. The observer reads it once per delivery and shares it with the
// producer join, so inventory pages are not paid twice.
export async function listMergeQualificationAdvisoryRuns({ repository, requestJson, now = () => new Date() } = {}) {
  const refused = (code) => ({ runs: null, errors: [code] });
  if (!isRepositoryIdentity(repository)) return refused("attempt_repository_invalid");
  const windowStartMs = inventoryWindowStartMs(now);
  if (!Number.isFinite(windowStartMs)) return refused("attempt_window_invalid");
  const windowStart = new Date(windowStartMs).toISOString().replace(/\.000Z$/, "Z");
  const lastPage = RUN_SEARCH_RESULT_CEILING / 100;
  const runs = [];
  let total;
  try {
    for (let page = 1; page <= lastPage; page += 1) {
      const payload = await requestJson(
        `repos/${repository}/actions/workflows/platform-merge-qualification.yml/runs?created=%3E%3D${windowStart}&per_page=100&page=${page}`,
      );
      if (
        !Number.isSafeInteger(payload?.total_count) ||
        payload.total_count < 0 ||
        payload.total_count >= RUN_SEARCH_RESULT_CEILING ||
        (total !== undefined && total !== payload.total_count) ||
        !Array.isArray(payload.workflow_runs) ||
        payload.workflow_runs.length > 100
      )
        return refused("attempt_inventory_incomplete");
      total = payload.total_count;
      runs.push(...payload.workflow_runs);
      if (runs.length === total) break;
      if (runs.length > total || payload.workflow_runs.length !== 100 || page === lastPage) {
        return refused("attempt_inventory_incomplete");
      }
    }
    return { runs, errors: [] };
  } catch {
    return refused("attempt_authority_unavailable");
  }
}

export async function inventoryMergeQualificationAttempts({
  repository,
  requestJson,
  readPolicyContent,
  advisoryRuns = null,
  settledIndex = null,
  now = () => new Date(),
} = {}) {
  const refused = (code) => ({ attempts: [], settled: 0, errors: [code] });
  if (!isRepositoryIdentity(repository)) return refused("attempt_repository_invalid");
  const windowStartMs = inventoryWindowStartMs(now);
  if (!Number.isFinite(windowStartMs)) return refused("attempt_window_invalid");
  const listing =
    advisoryRuns === null
      ? await listMergeQualificationAdvisoryRuns({ repository, requestJson, now })
      : Array.isArray(advisoryRuns) && advisoryRuns.length < RUN_SEARCH_RESULT_CEILING
        ? { runs: advisoryRuns, errors: [] }
        : { runs: null, errors: ["attempt_inventory_incomplete"] };
  if (listing.errors.length) return refused(listing.errors[0]);
  // An absent or invalid index settles nothing: every attempt stays pending.
  const settledAttempts = settledLookup(settledIndex, repository);
  try {
    const latest = new Map();
    const identities = new Set();
    for (const run of listing.runs) {
      const id = String(run?.id ?? "");
      const attempt = String(run?.run_attempt ?? "");
      if (
        run?.repository?.full_name !== repository ||
        run?.path !== ".github/workflows/platform-merge-qualification.yml" ||
        !isBoundedSafeIntegerString(id) ||
        !isBoundedSafeIntegerString(attempt) ||
        !isBoundedSafeIntegerString(String(run?.workflow_id ?? "")) ||
        !isCommitSha(run?.head_sha) ||
        parseTimezoneInstantMs(run?.run_started_at) === null ||
        identities.has(`${id}/${attempt}`)
      ) {
        return refused("attempt_identity_invalid");
      }
      // A run outside the requested window means the filter was not honored.
      const createdMs = parseTimezoneInstantMs(run.created_at);
      if (createdMs === null || createdMs < windowStartMs) return refused("attempt_window_invalid");
      identities.add(`${id}/${attempt}`);
      if (!latest.has(id) || BigInt(attempt) > BigInt(latest.get(id).run_attempt)) latest.set(id, run);
    }
    const attempts = [];
    const policies = new Map();
    let settled = 0;
    for (const run of latest.values()) {
      const producer = ADVISORY_RUN_TITLE.exec(run.display_title ?? "");
      if (run.status !== "completed" || run.event !== "workflow_dispatch" || !producer) continue;
      const join = { runId: producer[1], runAttempt: producer[2] };
      if (isSettledAttempt(settledAttempts, "advisory", String(run.id), String(run.run_attempt), join)) {
        settled += 1;
        continue;
      }
      if (!policies.has(run.head_sha)) policies.set(run.head_sha, await readPolicyContent(run.head_sha));
      const policy = evaluateMergeQualificationPolicy(policies.get(run.head_sha), {
        now: () => new Date(run.run_started_at),
      });
      if (!policy.enabled) continue;
      if (typeof run.conclusion !== "string" || !/^[a-z_]{1,64}$/.test(run.conclusion))
        return refused("attempt_conclusion_invalid");
      attempts.push({
        run_id: String(run.id),
        run_attempt: String(run.run_attempt),
        workflow_id: String(run.workflow_id),
        conclusion: run.conclusion,
      });
    }
    // GitHub matrices cap at 256 pending legs. Never silently drop a tail to
    // fit the worker; an over-capacity window clears as the window advances.
    if (attempts.length > 256) return refused("attempt_worker_capacity_exceeded");
    return { attempts, settled, errors: [] };
  } catch {
    return refused("attempt_authority_unavailable");
  }
}

// Producer-dispatch loss is reconciled from two complete, bounded workflow
// inventories. The join is deliberately name/identity based so no per-run
// reads happen until a completed producer has no matching advisory dispatch.
export const MERGE_QUALIFICATION_PRODUCER_TICK_MS = 15 * 60 * 1000;
export const MERGE_QUALIFICATION_PRODUCER_TERMINAL_SCHEMA_VERSION = "merge-qualification-terminal/v1";
const PRODUCER_TERMINAL_STATES = Object.freeze(["infrastructure_error", "conflict"]);
const PRODUCER_TERMINAL_REASONS = Object.freeze({
  infrastructure_error: new Set(["advisory_dispatch_missing"]),
  conflict: new Set(["advisory_dispatch_race"]),
});

function producerIdentity(run) {
  return `${String(run?.id ?? "")}/${String(run?.run_attempt ?? "")}`;
}

function validateProducerRun(run, repository) {
  if (
    run?.repository?.full_name !== repository ||
    run?.path !== PLATFORM_PR_WORKFLOW_PATH ||
    typeof run?.event !== "string" ||
    !isBoundedSafeIntegerString(String(run?.id ?? "")) ||
    !isBoundedSafeIntegerString(String(run?.run_attempt ?? "")) ||
    !isBoundedSafeIntegerString(String(run?.workflow_id ?? "")) ||
    !isCommitSha(run?.head_sha) ||
    parseTimezoneInstantMs(run?.run_started_at) === null ||
    parseTimezoneInstantMs(run?.created_at) === null ||
    parseTimezoneInstantMs(run?.updated_at) === null
  ) {
    return "producer_identity_invalid";
  }
  return null;
}

export async function readHistoricalProducerPolicy({
  run,
  repository,
  defaultBranch = "main",
  execFile = execFileSync,
  readPolicy = readOriginalQualificationPolicy,
  readLandingEvidence,
} = {}) {
  if (!run || typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]{1,256}$/.test(defaultBranch)) {
    throw new Error("producer_policy_authority_invalid");
  }
  const at = run.run_started_at;
  const startMs = parseTimezoneInstantMs(at);
  if (startMs === null) throw new Error("producer_policy_time_invalid");
  const ref = defaultBranch.startsWith("origin/")
    ? defaultBranch
    : `origin/${defaultBranch.replace(/^refs\/heads\//u, "")}`;
  const history = execFile("git", ["log", "--format=%H%x09%cI", ref, "--", MERGE_QUALIFICATION_POLICY_PATH], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 65_536,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const candidates = history
    .split(/\r?\n/u)
    .map((line) => {
      const [revision, committedAt] = line.split("\t");
      return { revision, committedMs: parseTimezoneInstantMs(committedAt) };
    })
    .filter(({ revision, committedMs }) => isCommitSha(revision) && committedMs !== null && committedMs <= startMs);
  if (!candidates.length) throw new Error("producer_policy_revision_unavailable");
  if (typeof readLandingEvidence !== "function") throw new Error("producer_policy_landing_evidence_unavailable");
  for (const { revision } of candidates) {
    const landing = await readLandingEvidence({ repository, revision, defaultBranch });
    const landed = Array.isArray(landing)
      ? landing.filter(
          (pull) =>
            pull?.base?.ref === defaultBranch.replace(/^refs\/heads\//u, "") &&
            typeof pull?.merged_at === "string" &&
            pull?.merge_commit_sha === revision,
        )
      : [];
    if (landed.length > 1) throw new Error("producer_policy_landing_evidence_ambiguous");
    if (landed.length === 0) throw new Error("producer_policy_landing_evidence_unavailable");
    const landedMs = parseTimezoneInstantMs(landed[0].merged_at);
    if (landedMs === null || landedMs > startMs) continue;
    if (revision === lowerTrim(run.head_sha)) throw new Error("producer_policy_authority_unavailable");
    const content = await readPolicy(revision);
    return { revision, content, decision: evaluateMergeQualificationPolicy(content, { now: () => new Date(at) }) };
  }
  throw new Error("producer_policy_landing_evidence_unavailable");
}

async function inventoryWorkflowRuns({ repository, workflowPath, requestJson, windowStart, kind, event }) {
  const runs = [];
  let total;
  for (let page = 1; page <= RUN_SEARCH_RESULT_CEILING / 100; page += 1) {
    const payload = await requestJson(
      `repos/${repository}/actions/workflows/${workflowPath}/runs?created=%3E%3D${windowStart}${event ? `&event=${event}` : ""}&per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(payload?.total_count) ||
      payload.total_count < 0 ||
      payload.total_count >= RUN_SEARCH_RESULT_CEILING ||
      (total !== undefined && total !== payload.total_count) ||
      !Array.isArray(payload.workflow_runs) ||
      payload.workflow_runs.length > 100
    )
      throw new Error(`${kind}_inventory_incomplete`);
    total = payload.total_count;
    runs.push(...payload.workflow_runs);
    if (runs.length === total) break;
    if (runs.length > total || payload.workflow_runs.length !== 100 || page === RUN_SEARCH_RESULT_CEILING / 100) {
      throw new Error(`${kind}_inventory_incomplete`);
    }
  }
  return runs;
}

// Image eligibility is proven only by the one job and one successful push step;
// a job that merely ran is not evidence that an image was published.
export async function readMergeQualificationProducerImageEligibility({ repository, run, requestJson } = {}) {
  if (!isRepositoryIdentity(repository) || validateProducerRun(run, repository))
    throw new Error("producer_image_eligibility_invalid");
  const jobs = await readMergeQualificationRunCollection({
    repository,
    runId: String(run.id),
    runAttempt: String(run.run_attempt),
    collection: "jobs",
    requestJson,
  });
  const imageJobs = jobs.jobs.filter((job) => job?.name === "Docker Image Build");
  if (imageJobs.length !== 1) throw new Error("producer_image_eligibility_invalid");
  if (imageJobs[0].conclusion === "skipped") return false;
  const pushSteps = Array.isArray(imageJobs[0].steps)
    ? imageJobs[0].steps.filter((step) => step?.name === "Push boot-smoked merge-group image")
    : [];
  if (pushSteps.length !== 1) throw new Error("producer_image_eligibility_invalid");
  return pushSteps[0].conclusion === "success";
}

export async function inventoryMergeQualificationProducerAttempts({
  repository,
  requestJson,
  defaultBranch = "main",
  readHistoricalPolicyContent,
  readProducerImageEligibility,
  execFile = execFileSync,
  readPolicy = readOriginalQualificationPolicy,
  advisoryRuns: sharedAdvisoryRuns = null,
  settledIndex = null,
  now = () => new Date(),
} = {}) {
  const refused = (code) => ({ attempts: [], settled: 0, errors: [code] });
  if (!isRepositoryIdentity(repository)) return refused("producer_repository_invalid");
  const windowStartMs = inventoryWindowStartMs(now);
  if (!Number.isFinite(windowStartMs)) return refused("producer_window_invalid");
  const windowStart = new Date(windowStartMs).toISOString().replace(/\.000Z$/, "Z");
  if (
    sharedAdvisoryRuns !== null &&
    (!Array.isArray(sharedAdvisoryRuns) || sharedAdvisoryRuns.length >= RUN_SEARCH_RESULT_CEILING)
  )
    return refused("advisory_inventory_incomplete");
  // An absent or invalid index settles nothing: every producer stays pending.
  const settledAttempts = settledLookup(settledIndex, repository);
  const landingCache = new Map();
  try {
    const [producerRuns, advisoryRuns] = await Promise.all([
      inventoryWorkflowRuns({
        repository,
        workflowPath: "platform-pr.yml",
        requestJson,
        windowStart,
        kind: "producer",
        event: "merge_group",
      }),
      sharedAdvisoryRuns ??
        inventoryWorkflowRuns({
          repository,
          workflowPath: "platform-merge-qualification.yml",
          requestJson,
          windowStart,
          kind: "advisory",
        }),
    ]);
    const seen = new Set();
    const producers = [];
    for (const run of producerRuns) {
      const identityError = validateProducerRun(run, repository);
      if (identityError) return refused(identityError);
      if (parseTimezoneInstantMs(run.created_at) < windowStartMs) return refused("producer_window_invalid");
      const identity = producerIdentity(run);
      if (seen.has(identity)) return refused("producer_identity_invalid");
      seen.add(identity);
      if (run.event === "merge_group" && run.status === "completed") producers.push(run);
    }
    if (producers.length > 256) return refused("producer_worker_capacity_exceeded");
    const advisoryByProducer = new Map();
    for (const run of advisoryRuns) {
      const title = ADVISORY_RUN_TITLE.exec(String(run?.display_title ?? ""));
      if (!title) continue;
      const identity = `${title[1]}/${title[2]}`;
      if (advisoryByProducer.has(identity)) return refused("advisory_identity_invalid");
      advisoryByProducer.set(identity, run);
    }
    const attempts = [];
    let settled = 0;
    const nowMs = now().getTime();
    for (const run of producers) {
      const identity = producerIdentity(run);
      const advisoryRun = advisoryByProducer.get(identity) ?? null;
      const completedMs = parseTimezoneInstantMs(run.updated_at);
      if (
        advisoryRun &&
        parseTimezoneInstantMs(advisoryRun.created_at) < completedMs + MERGE_QUALIFICATION_PRODUCER_TICK_MS
      )
        continue;
      // A settled loss is suppressed before any candidate, policy or image read,
      // but only while its recorded advisory join still matches this listing.
      const advisoryJoin = advisoryRun
        ? { runId: String(advisoryRun.id ?? ""), runAttempt: String(advisoryRun.run_attempt ?? "") }
        : null;
      if (isSettledAttempt(settledAttempts, "producer_loss", String(run.id), String(run.run_attempt), advisoryJoin)) {
        settled += 1;
        continue;
      }
      const eligibleAfterTick = nowMs - parseTimezoneInstantMs(run.updated_at) >= MERGE_QUALIFICATION_PRODUCER_TICK_MS;
      if (!eligibleAfterTick) continue;
      let historical;
      try {
        historical = readHistoricalPolicyContent
          ? await readHistoricalPolicyContent({ run, repository, defaultBranch })
          : await readHistoricalProducerPolicy({
              run,
              repository,
              defaultBranch,
              execFile,
              readPolicy,
              readLandingEvidence: async ({ revision }) => {
                if (!landingCache.has(revision))
                  landingCache.set(revision, await requestJson(`repos/${repository}/commits/${revision}/pulls`));
                return landingCache.get(revision);
              },
            });
      } catch (error) {
        attempts.push({
          run_id: String(run.id),
          run_attempt: String(run.run_attempt),
          workflow_id: String(run.workflow_id),
          conclusion: run.conclusion,
          historicalPolicyRevision: null,
          historicalPolicyState: "unknown",
          historicalPolicyReason: error instanceof Error ? error.message : "producer_policy_authority_unavailable",
          advisoryRunPresent: Boolean(advisoryRun),
          imageEligible: null,
          eligibleAfterTick,
        });
        continue;
      }
      const policyDecision =
        historical?.decision ??
        evaluateMergeQualificationPolicy(historical?.content, {
          now: () => new Date(run.run_started_at),
        });
      // Every canonical evaluator failure is disabled for this producer's
      // historical instant. Only an unreadable revision/content throws and
      // refuses the inventory; malformed or expired policy must stay inert.
      if (!policyDecision || policyDecision.enabled !== true) continue;
      let imageEligible;
      try {
        imageEligible = readProducerImageEligibility ? await readProducerImageEligibility({ run, repository }) : true;
      } catch (error) {
        attempts.push({
          run_id: String(run.id),
          run_attempt: String(run.run_attempt),
          workflow_id: String(run.workflow_id),
          conclusion: run.conclusion,
          historicalPolicyRevision: historical?.revision ?? null,
          historicalPolicyState: "unknown",
          historicalPolicyReason: error instanceof Error ? error.message : "producer_image_eligibility_unavailable",
          advisoryRunPresent: Boolean(advisoryRun),
          imageEligible: null,
          eligibleAfterTick,
        });
        continue;
      }
      if (imageEligible === false) continue;
      if (imageEligible !== true) throw new Error("producer_image_eligibility_unavailable");
      attempts.push({
        run_id: String(run.id),
        run_attempt: String(run.run_attempt),
        workflow_id: String(run.workflow_id),
        conclusion: run.conclusion,
        historicalPolicyRevision: historical?.revision ?? null,
        historicalPolicyState: policyDecision.enabled === true ? "enabled" : "unknown",
        historicalPolicyReason:
          policyDecision.enabled === true ? null : (policyDecision.reasonCode ?? "policy_disabled"),
        advisoryRunPresent: Boolean(advisoryRun),
        imageEligible: true,
        eligibleAfterTick,
      });
    }
    return { attempts, settled, errors: [] };
  } catch (error) {
    return refused(error instanceof Error ? error.message : "producer_authority_unavailable");
  }
}

function producerTerminalFields(input, terminalState, reasonCodes, advisoryRun = null) {
  const run = input.producer;
  return {
    schemaVersion: MERGE_QUALIFICATION_PRODUCER_TERMINAL_SCHEMA_VERSION,
    idempotencyKey: `merge-qualification-producer:${input.repository}:${run.id}:${run.run_attempt}`,
    repository: input.repository,
    producerWorkflowId: String(run.workflow_id),
    producerWorkflowPath: run.path,
    producerRunId: String(run.id),
    producerRunAttempt: String(run.run_attempt),
    producerHeadSha: lowerTrim(run.head_sha),
    policyRevision: lowerTrim(input.candidate?.policyRevision),
    advisoryRunId: advisoryRun ? String(advisoryRun.id ?? "") : null,
    advisoryRunAttempt: advisoryRun ? String(advisoryRun.run_attempt ?? "") : null,
    terminalState,
    reasonCodes,
    startedAt: run.run_started_at,
    completedAt: new Date(input.now).toISOString(),
    cleanupLegs: 0,
  };
}

export function validateMergeQualificationProducerTerminal(record) {
  const fields = [
    "schemaVersion",
    "idempotencyKey",
    "repository",
    "producerWorkflowId",
    "producerWorkflowPath",
    "producerRunId",
    "producerRunAttempt",
    "producerHeadSha",
    "policyRevision",
    "advisoryRunId",
    "advisoryRunAttempt",
    "terminalState",
    "reasonCodes",
    "startedAt",
    "completedAt",
    "cleanupLegs",
  ];
  if (!isClosedObject(record, fields)) return ["producer terminal must be a closed object."];
  const errors = [];
  if (record.schemaVersion !== MERGE_QUALIFICATION_PRODUCER_TERMINAL_SCHEMA_VERSION)
    errors.push("unsupported producer terminal schema.");
  if (!isRepositoryIdentity(record.repository)) errors.push("producer terminal repository is invalid.");
  for (const value of [record.producerWorkflowId, record.producerRunId, record.producerRunAttempt]) {
    if (!isBoundedSafeIntegerString(value)) errors.push("producer terminal identity is invalid.");
  }
  if (record.producerWorkflowPath !== PLATFORM_PR_WORKFLOW_PATH) errors.push("producer terminal workflow is invalid.");
  if (!isCommitSha(record.producerHeadSha) || !isCommitSha(record.policyRevision))
    errors.push("producer terminal immutable revision is invalid.");
  if (
    record.idempotencyKey !==
    `merge-qualification-producer:${record.repository}:${record.producerRunId}:${record.producerRunAttempt}`
  )
    errors.push("producer terminal idempotency key is invalid.");
  if (record.advisoryRunId !== null && !isBoundedSafeIntegerString(record.advisoryRunId))
    errors.push("producer terminal advisory identity is invalid.");
  if (record.advisoryRunAttempt !== null && !isBoundedSafeIntegerString(record.advisoryRunAttempt))
    errors.push("producer terminal advisory attempt is invalid.");
  if (!PRODUCER_TERMINAL_STATES.includes(record.terminalState)) errors.push("producer terminal state is invalid.");
  const allowed = PRODUCER_TERMINAL_REASONS[record.terminalState];
  if (!Array.isArray(record.reasonCodes) || record.reasonCodes.length !== 1 || !allowed?.has(record.reasonCodes[0]))
    errors.push("producer terminal reason is invalid.");
  if (parseTimezoneInstantMs(record.startedAt) === null || parseTimezoneInstantMs(record.completedAt) === null)
    errors.push("producer terminal timestamps are invalid.");
  if (record.cleanupLegs !== 0) errors.push("producer terminal cannot create cleanup legs.");
  return errors;
}

async function readNamedProducerArtifact({
  repository,
  name,
  fileName = "event.json",
  defaultBranch,
  requestJson,
  downloadArtifact,
}) {
  const base = `repos/${repository}/actions`;
  const artifacts = [];
  const ids = new Set();
  let total;
  for (let page = 1; page <= 100; page += 1) {
    const payload = await requestJson(`${base}/artifacts?name=${name}&per_page=100&page=${page}`);
    if (
      !Number.isSafeInteger(payload?.total_count) ||
      payload.total_count < 0 ||
      payload.total_count > 10_000 ||
      (total !== undefined && total !== payload.total_count) ||
      !Array.isArray(payload.artifacts) ||
      payload.artifacts.length > 100
    )
      throw new Error("producer_marker_inventory_incomplete");
    total = payload.total_count;
    for (const artifact of payload.artifacts) {
      const id = String(artifact?.id ?? "");
      if (
        !isBoundedSafeIntegerString(id) ||
        ids.has(id) ||
        artifact?.name !== name ||
        artifact?.expired !== false ||
        !isBoundedSafeIntegerString(String(artifact?.workflow_run?.id ?? ""))
      )
        throw new Error("producer_marker_artifact_invalid");
      ids.add(id);
      artifacts.push(artifact);
    }
    if (artifacts.length === total) break;
    if (artifacts.length > total || payload.artifacts.length !== 100 || page === 100)
      throw new Error("producer_marker_inventory_incomplete");
  }
  if (artifacts.length === 0) return false;
  if (artifacts.length !== 1) throw new Error("producer_marker_artifact_invalid");
  const writerId = String(artifacts[0].workflow_run.id);
  const owner = await requestJson(`${base}/runs/${writerId}`);
  if (
    String(owner?.id) !== writerId ||
    owner?.repository?.full_name !== repository ||
    owner?.head_repository?.full_name !== repository ||
    owner?.head_branch !== defaultBranch.replace(/^refs\/heads\//u, "") ||
    owner?.path !== ".github/workflows/platform-merge-qualification-observer.yml" ||
    !["schedule", "workflow_run"].includes(owner?.event)
  )
    throw new Error("producer_marker_writer_invalid");
  const bytes = await downloadArtifact({ runId: writerId, name, fileName });
  if (typeof bytes !== "string" || Buffer.byteLength(bytes) > 65_536)
    throw new Error("producer_marker_payload_invalid");
  return bytes;
}

export async function readMergeQualificationAdvisoryCleanupMarkers({
  repository,
  advisoryRun,
  defaultBranch,
  requestJson,
  downloadArtifact,
} = {}) {
  if (
    !isRepositoryIdentity(repository) ||
    !isBoundedSafeIntegerString(String(advisoryRun?.id ?? "")) ||
    !isBoundedSafeIntegerString(String(advisoryRun?.run_attempt ?? "")) ||
    advisoryRun?.repository?.full_name !== repository ||
    advisoryRun?.path !== ".github/workflows/platform-merge-qualification.yml" ||
    advisoryRun?.event !== "workflow_dispatch"
  )
    return { complete: false, errors: ["producer_advisory_identity_invalid"] };
  if (typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]{1,256}$/.test(defaultBranch))
    return { complete: false, errors: ["terminal_default_branch_invalid"] };
  try {
    const suffix = `${advisoryRun.id}-${advisoryRun.run_attempt}`;
    const names = [`merge-qualification-cleanup-complete-${suffix}`, `merge-qualification-terminal-${suffix}`];
    for (const name of names) {
      const bytes = await readNamedProducerArtifact({
        repository,
        name,
        fileName: name.startsWith("merge-qualification-cleanup-complete-") ? "cleanup-complete.json" : "event.json",
        defaultBranch,
        requestJson,
        downloadArtifact,
      });
      if (bytes === false) continue;
      if (name.startsWith("merge-qualification-cleanup-complete-")) {
        let marker;
        try {
          marker = JSON.parse(bytes);
        } catch {
          return { complete: false, errors: ["producer_marker_payload_invalid"] };
        }
        if (
          marker?.runId !== String(advisoryRun.id) ||
          marker?.runAttempt !== String(advisoryRun.run_attempt) ||
          marker?.cleanup !== "complete" ||
          Object.keys(marker).length !== 3
        )
          return { complete: false, errors: ["producer_marker_payload_invalid"] };
      } else {
        let terminal;
        try {
          terminal = JSON.parse(bytes);
        } catch {
          return { complete: false, errors: ["producer_marker_payload_invalid"] };
        }
        if (
          validateMergeQualificationEvent(terminal).length > 0 ||
          terminal.runId !== String(advisoryRun.id) ||
          terminal.runAttempt !== String(advisoryRun.run_attempt)
        )
          return { complete: false, errors: ["producer_marker_payload_invalid"] };
      }
      return { complete: true, errors: [] };
    }
    return { complete: false, errors: [] };
  } catch (error) {
    return {
      complete: false,
      errors: [error instanceof Error ? error.message : "producer_marker_authority_unavailable"],
    };
  }
}

export async function readMergeQualificationProducerTerminalRecords({
  repository,
  producer,
  advisoryRun = null,
  defaultBranch,
  requestJson,
  downloadArtifact,
  readAdvisoryCleanupMarkers = readMergeQualificationAdvisoryCleanupMarkers,
} = {}) {
  const refused = (code) => ({ records: null, state: "unknown", advisoryCleanupComplete: false, errors: [code] });
  if (!isRepositoryIdentity(repository) || validateProducerRun(producer, repository))
    return refused("producer_identity_invalid");
  if (typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]{1,256}$/.test(defaultBranch))
    return refused("terminal_default_branch_invalid");
  const name = `merge-qualification-producer-terminal-${producer.id}-${producer.run_attempt}`;
  const base = `repos/${repository}/actions`;
  const artifacts = [];
  const ids = new Set();
  let total;
  try {
    for (let page = 1; page <= 100; page += 1) {
      const payload = await requestJson(`${base}/artifacts?name=${name}&per_page=100&page=${page}`);
      if (
        !Number.isSafeInteger(payload?.total_count) ||
        payload.total_count < 0 ||
        payload.total_count > 10_000 ||
        (total !== undefined && total !== payload.total_count) ||
        !Array.isArray(payload.artifacts) ||
        payload.artifacts.length > 100
      )
        return refused("terminal_inventory_incomplete");
      total = payload.total_count;
      for (const artifact of payload.artifacts) {
        const id = String(artifact?.id ?? "");
        if (
          !isBoundedSafeIntegerString(id) ||
          ids.has(id) ||
          artifact?.name !== name ||
          artifact?.expired !== false ||
          !isBoundedSafeIntegerString(String(artifact?.workflow_run?.id ?? ""))
        )
          return refused("terminal_artifact_invalid");
        ids.add(id);
        artifacts.push(artifact);
      }
      if (artifacts.length === total) break;
      if (artifacts.length > total || payload.artifacts.length !== 100 || page === 100)
        return refused("terminal_inventory_incomplete");
    }
    const records = [];
    const parsed = [];
    for (const artifact of artifacts) {
      const writerId = String(artifact.workflow_run.id);
      const owner = await requestJson(`${base}/runs/${writerId}`);
      if (
        String(owner?.id) !== writerId ||
        owner?.repository?.full_name !== repository ||
        owner?.head_repository?.full_name !== repository ||
        owner?.head_branch !== defaultBranch.replace(/^refs\/heads\//u, "") ||
        owner?.path !== ".github/workflows/platform-merge-qualification-observer.yml" ||
        !["schedule", "workflow_run"].includes(owner?.event)
      )
        return refused("terminal_writer_invalid");
      const bytes = await downloadArtifact({ runId: writerId, name });
      if (typeof bytes !== "string" || Buffer.byteLength(bytes) > 65_536) return refused("terminal_payload_invalid");
      let record;
      try {
        record = JSON.parse(bytes);
      } catch {
        return refused("terminal_payload_invalid");
      }
      if (
        validateMergeQualificationProducerTerminal(record).length > 0 ||
        record.repository !== repository ||
        record.producerWorkflowPath !== producer.path ||
        record.producerWorkflowId !== String(producer.workflow_id) ||
        record.producerRunId !== String(producer.id) ||
        record.producerRunAttempt !== String(producer.run_attempt) ||
        record.producerHeadSha !== lowerTrim(producer.head_sha)
      )
        return refused("terminal_payload_binding_invalid");
      records.push(bytes);
      parsed.push(record);
    }
    const unique = new Map(parsed.map((record, index) => [records[index], record]));
    const values = [...unique.values()];
    const losses = values.filter((record) => record.terminalState === "infrastructure_error");
    const conflicts = values.filter((record) => record.terminalState === "conflict");
    if (
      losses.length > 1 ||
      conflicts.length > 1 ||
      values.length > 2 ||
      (losses.length && conflicts.length && values.length !== 2)
    )
      return refused("terminal_payload_conflict");
    if (losses.length && conflicts.length)
      return { records, state: "conflict_settled", advisoryCleanupComplete: true, errors: [] };
    if (losses.length && advisoryRun) {
      const marker = await readAdvisoryCleanupMarkers({
        repository,
        advisoryRun,
        defaultBranch,
        requestJson,
        downloadArtifact,
      });
      if (marker.errors.length) return refused(marker.errors[0]);
      if (!marker.complete)
        return { records, state: "awaiting_advisory_cleanup", advisoryCleanupComplete: false, errors: [] };
      return { records, state: "advisory_cleanup_complete", advisoryCleanupComplete: true, errors: [] };
    }
    return {
      records,
      state: conflicts.length
        ? "conflict"
        : losses.length
          ? "dispatch_loss"
          : advisoryRun
            ? "advisory_present"
            : "missing",
      advisoryCleanupComplete: false,
      errors: [],
    };
  } catch {
    return refused("terminal_authority_unavailable");
  }
}

export function reconcileMergeQualificationProducerAttempt({
  producer,
  advisoryRun = null,
  candidate = null,
  policy = null,
  policyContent = null,
  policyAuthorityError = null,
  existingTerminal = null,
  existingTerminals = null,
  advisoryCleanupComplete = false,
  now = new Date(),
} = {}) {
  const repository = producer?.repository?.full_name;
  if (
    !isRepositoryIdentity(repository) ||
    producer?.event !== "merge_group" ||
    validateProducerRun(producer, repository)
  )
    return { state: "unknown", reason: "producer_invalid", event: null };
  if (policyAuthorityError) return { state: "unknown", reason: policyAuthorityError, event: null };
  const candidateErrors = candidate ? validateMergeQualificationCandidate(candidate) : ["candidate_missing"];
  const boundCandidate =
    candidateErrors.length === 0 &&
    candidate.repository === repository &&
    candidate.workflowId === String(producer.workflow_id) &&
    candidate.workflowPath === producer.path &&
    candidate.runId === String(producer.id) &&
    candidate.runAttempt === String(producer.run_attempt) &&
    candidate.candidateSha === lowerTrim(producer.head_sha) &&
    candidate.policyRevision !== lowerTrim(producer.head_sha);
  const evaluatedPolicy =
    typeof policyContent === "string"
      ? evaluateMergeQualificationPolicy(policyContent, { now: () => new Date(producer.run_started_at) })
      : policy;
  if (!evaluatedPolicy || evaluatedPolicy.enabled !== true || !boundCandidate) {
    return {
      state:
        evaluatedPolicy?.enabled === false || evaluatedPolicy?.reasonCode === "policy_disabled"
          ? "ineligible"
          : "unknown",
      reason:
        evaluatedPolicy?.enabled === false || evaluatedPolicy?.reasonCode === "policy_disabled"
          ? "policy_disabled"
          : "candidate_invalid",
      event: null,
    };
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const startedMs = parseTimezoneInstantMs(producer.updated_at);
  const terminals = Array.isArray(existingTerminals) ? existingTerminals : existingTerminal ? [existingTerminal] : [];
  if (!Number.isFinite(nowMs) || startedMs === null)
    return { state: "unknown", reason: "producer_time_invalid", event: null };
  if (advisoryRun && terminals.length === 0)
    return { state: "advisory_present", reason: "owned_by_advisory", event: null };
  if (!advisoryRun && nowMs - startedMs < MERGE_QUALIFICATION_PRODUCER_TICK_MS) {
    return { state: "awaiting_tick", reason: "awaiting_advisory_dispatch_tick", event: null };
  }
  const terminalBound = terminals.every((terminal) => {
    const terminalErrors = validateMergeQualificationProducerTerminal(terminal);
    return (
      terminalErrors.length === 0 &&
      terminal.repository === repository &&
      terminal.producerRunId === String(producer.id) &&
      terminal.producerRunAttempt === String(producer.run_attempt) &&
      terminal.producerHeadSha === lowerTrim(producer.head_sha) &&
      terminal.policyRevision === lowerTrim(candidate?.policyRevision)
    );
  });
  if (!terminalBound) return { state: "unknown", reason: "terminal_identity_invalid", event: null };
  const hasLoss = terminals.some((terminal) => terminal.terminalState === "infrastructure_error");
  const hasConflict = terminals.some((terminal) => terminal.terminalState === "conflict");
  if (hasLoss && hasConflict)
    return { state: "conflict_settled", reason: "dispatch_loss_conflict_already_settled", event: null };
  if (hasLoss && advisoryRun && !advisoryCleanupComplete)
    return { state: "awaiting_advisory_cleanup", reason: "advisory_cleanup_incomplete", event: null };
  if (hasLoss && !advisoryRun) return { state: "idempotent", reason: "dispatch_loss_already_settled", event: null };
  if (hasConflict) return { state: "idempotent", reason: "dispatch_loss_conflict_already_settled", event: null };
  const event = producerTerminalFields(
    { repository, producer, candidate, now: nowMs },
    advisoryRun ? "conflict" : "infrastructure_error",
    [advisoryRun ? "advisory_dispatch_race" : "advisory_dispatch_missing"],
    advisoryRun,
  );
  return { state: advisoryRun ? "conflict" : "dispatch_loss", reason: event.reasonCodes[0], event };
}

function readOriginalQualificationPolicy(revision) {
  if (!isCommitSha(revision)) throw new Error("original_policy_revision_invalid");
  const git = (args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 65_536,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["cat-file", "-e", `${revision}^{commit}`]);
  const exists = execFileSync("git", ["ls-tree", "--name-only", revision, "--", MERGE_QUALIFICATION_POLICY_PATH], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: GIT_LISTING_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return exists ? git(["show", `${revision}:${MERGE_QUALIFICATION_POLICY_PATH}`]) : null;
}

export async function readMergeQualificationRunCollection({
  repository,
  runId,
  runAttempt,
  collection,
  requestJson,
} = {}) {
  if (
    !isRepositoryIdentity(repository) ||
    !isBoundedSafeIntegerString(runId) ||
    !isBoundedSafeIntegerString(runAttempt) ||
    !["jobs", "artifacts"].includes(collection)
  )
    throw new Error("run_collection_identity_invalid");
  const endpoint =
    collection === "jobs"
      ? `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`
      : `repos/${repository}/actions/runs/${runId}/artifacts`;
  const items = [];
  const ids = new Set();
  let total;
  for (let page = 1; page <= 100; page += 1) {
    const payload = await requestJson(`${endpoint}?per_page=100&page=${page}`);
    if (
      !Number.isSafeInteger(payload?.total_count) ||
      payload.total_count < 0 ||
      payload.total_count > 10_000 ||
      (total !== undefined && total !== payload.total_count) ||
      !Array.isArray(payload[collection]) ||
      payload[collection].length > 100
    ) {
      throw new Error("run_collection_incomplete");
    }
    total = payload.total_count;
    for (const item of payload[collection]) {
      const id = String(item?.id ?? "");
      if (!isBoundedSafeIntegerString(id) || ids.has(id)) throw new Error("run_collection_identity_invalid");
      ids.add(id);
      items.push(item);
    }
    if (items.length === total) return { total_count: total, [collection]: items };
    if (items.length > total || payload[collection].length !== 100) throw new Error("run_collection_incomplete");
  }
  throw new Error("run_collection_incomplete");
}

// Read all matching artifacts before trusting any payload. Only this serialized
// default-ref observer may own terminal evidence; diagnostic/name-only matches
// and expired or incomplete inventories cannot authorize a second publication.
export async function readMergeQualificationTerminalRecords({
  decision,
  defaultBranch,
  requestJson,
  downloadArtifact,
} = {}) {
  const refused = (code) => ({ records: null, errors: [code] });
  if (validateMergeQualificationDecision(decision).length) return refused("terminal_decision_invalid");
  if (!decision.policyEnabled) return { records: [], errors: [] };
  if (typeof defaultBranch !== "string" || !defaultBranch || defaultBranch.length > 256) {
    return refused("terminal_default_branch_invalid");
  }
  const name = `merge-qualification-terminal-${decision.runId}-${decision.runAttempt}`;
  const base = `repos/${decision.repository}/actions`;
  const artifacts = [];
  const ids = new Set();
  let total;
  try {
    for (let page = 1; page <= 100; page += 1) {
      const payload = await requestJson(`${base}/artifacts?name=${name}&per_page=100&page=${page}`);
      if (
        !Number.isSafeInteger(payload?.total_count) ||
        payload.total_count < 0 ||
        payload.total_count > 10_000 ||
        (total !== undefined && total !== payload.total_count) ||
        !Array.isArray(payload.artifacts) ||
        payload.artifacts.length > 100
      )
        return refused("terminal_inventory_incomplete");
      total = payload.total_count;
      for (const artifact of payload.artifacts) {
        const id = String(artifact?.id ?? "");
        if (
          !isBoundedSafeIntegerString(id) ||
          ids.has(id) ||
          artifact?.name !== name ||
          artifact?.expired !== false ||
          !isBoundedSafeIntegerString(String(artifact?.workflow_run?.id ?? ""))
        ) {
          return refused("terminal_artifact_invalid");
        }
        ids.add(id);
        artifacts.push(artifact);
      }
      if (artifacts.length === total) break;
      if (artifacts.length > total || payload.artifacts.length !== 100 || page === 100) {
        return refused("terminal_inventory_incomplete");
      }
    }
    const records = [];
    for (const artifact of artifacts) {
      const runId = String(artifact.workflow_run.id);
      const owner = await requestJson(`${base}/runs/${runId}`);
      if (
        String(owner?.id) !== runId ||
        owner?.repository?.full_name !== decision.repository ||
        owner?.head_repository?.full_name !== decision.repository ||
        owner?.head_branch !== defaultBranch ||
        owner?.path !== ".github/workflows/platform-merge-qualification-observer.yml" ||
        !["schedule", "workflow_run"].includes(owner?.event)
      )
        return refused("terminal_writer_invalid");
      records.push(await downloadArtifact({ runId, name }));
    }
    const replay = resolveMergeQualificationTerminalReplay({ decision, records });
    return replay.errors.length ? refused(replay.errors[0]) : { records, errors: [] };
  } catch {
    return refused("terminal_authority_unavailable");
  }
}

// The settled-attempt index is a closed, versioned observer projection that
// only suppresses matrix legs for attempts whose durable evidence already
// settled; it is never authority for a missing terminal. An advisory attempt
// settles with its terminal and exact cleanup marker. A producer-loss attempt
// settles on its terminal alone: no advisory run provisioned resources for it,
// and a late-run conflict record likewise needs no marker.
export const MERGE_QUALIFICATION_SETTLED_INDEX_SCHEMA_VERSION = "observer-settled-index/v1";
export const MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT = "merge-qualification-settled-index";
export const MERGE_QUALIFICATION_SETTLED_ENTRY_ARTIFACT_PREFIX = "merge-qualification-settled-entry-";
export const MERGE_QUALIFICATION_SETTLED_VARIANTS = Object.freeze(["advisory", "producer_loss"]);
const OBSERVER_WORKFLOW_PATH = ".github/workflows/platform-merge-qualification-observer.yml";
const ADVISORY_WORKFLOW_PATH = ".github/workflows/platform-merge-qualification.yml";
const SETTLED_INDEX_FILE = "settled-index.json";
// One entry per inventoried advisory or producer attempt; each inventory
// refuses at the 1,000-result search ceiling.
const SETTLED_INDEX_MAX_ENTRIES = 2 * RUN_SEARCH_RESULT_CEILING;
const SETTLED_INDEX_MAX_BYTES = 2_000_000;
// One delivery admits at most one advisory and one producer leg per matrix slot.
const SETTLED_ENTRIES_PER_DELIVERY = 2 * 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function inventoryWindowStartMs(now) {
  // Whole seconds: the created filter and run timestamps carry no fractions.
  return Math.floor((now().getTime() - MERGE_QUALIFICATION_INVENTORY_HORIZON_HOURS * 3_600_000) / 1_000) * 1_000;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function settledKey(variant, runId, runAttempt) {
  return `${variant}/${runId}/${runAttempt}`;
}

function isAttemptReference(value) {
  return (
    isClosedObject(value, ["runId", "runAttempt"]) &&
    isBoundedSafeIntegerString(value.runId) &&
    isBoundedSafeIntegerString(value.runAttempt)
  );
}

function sameJoin(left, right) {
  if (left === null || right === null) return left === right;
  return left.runId === right.runId && left.runAttempt === right.runAttempt;
}

function canonicalSettledEntry(entry) {
  return {
    variant: entry.variant,
    runId: entry.runId,
    runAttempt: entry.runAttempt,
    join: entry.join === null ? null : { runId: entry.join.runId, runAttempt: entry.join.runAttempt },
    terminals: entry.terminals.map(({ terminalState, sha256 }) => ({ terminalState, sha256 })),
    cleanupMarkerSha256: entry.cleanupMarkerSha256,
    startedAt: entry.startedAt,
  };
}

function compareSettledEntries(left, right) {
  if (left.variant !== right.variant) return left.variant < right.variant ? -1 : 1;
  for (const field of ["runId", "runAttempt"]) {
    const difference = BigInt(left[field]) - BigInt(right[field]);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

export function validateMergeQualificationSettledEntry(entry) {
  const fields = ["variant", "runId", "runAttempt", "join", "terminals", "cleanupMarkerSha256", "startedAt"];
  if (!isClosedObject(entry, fields)) return ["settled entry must be a closed object."];
  const errors = [];
  if (!MERGE_QUALIFICATION_SETTLED_VARIANTS.includes(entry.variant)) errors.push("settled entry variant is invalid.");
  if (!isBoundedSafeIntegerString(entry.runId) || !isBoundedSafeIntegerString(entry.runAttempt))
    errors.push("settled entry identity is invalid.");
  if (entry.join !== null && !isAttemptReference(entry.join)) errors.push("settled entry join is invalid.");
  if (!isIsoInstant(entry.startedAt)) errors.push("settled entry start is invalid.");
  const terminals = Array.isArray(entry.terminals) ? entry.terminals : [];
  if (
    terminals.length < 1 ||
    terminals.length > 2 ||
    terminals.some(
      (terminal) => !isClosedObject(terminal, ["terminalState", "sha256"]) || !SHA256_PATTERN.test(terminal.sha256),
    )
  )
    errors.push("settled entry terminals are invalid.");
  const states = terminals.map((terminal) => terminal?.terminalState);
  if (entry.variant === "advisory") {
    if (states.length !== 1 || !MERGE_QUALIFICATION_TERMINAL_STATES.includes(states[0]))
      errors.push("advisory settlement needs exactly one advisory terminal.");
    if (entry.join === null) errors.push("advisory settlement must retain its producer join.");
    if (typeof entry.cleanupMarkerSha256 !== "string" || !SHA256_PATTERN.test(entry.cleanupMarkerSha256))
      errors.push("advisory settlement requires its exact cleanup marker.");
  } else if (entry.variant === "producer_loss") {
    if (entry.cleanupMarkerSha256 !== null) errors.push("producer-loss settlement never carries a cleanup marker.");
    const ordered = [...new Set(states)].sort();
    if (
      ordered.length !== states.length ||
      ordered.join("\n") !== states.join("\n") ||
      states.some((state) => !PRODUCER_TERMINAL_STATES.includes(state))
    )
      errors.push("producer-loss settlement terminals are invalid.");
    // A loss alone settles only while no advisory run joins it; a late run
    // reopens the attempt until its conflict record names that run.
    if (states.includes("conflict") ? entry.join === null : entry.join !== null)
      errors.push("producer-loss settlement join does not match its terminals.");
  }
  return errors;
}

export function validateMergeQualificationSettledIndex(index, { repository } = {}) {
  const fields = ["schemaVersion", "repository", "writerRunId", "writerRunAttempt", "windowStart", "entries"];
  if (!isClosedObject(index, fields)) return ["settled index must be a closed object."];
  if (index.schemaVersion !== MERGE_QUALIFICATION_SETTLED_INDEX_SCHEMA_VERSION)
    return ["unsupported settled index schema."];
  const errors = [];
  if (!isRepositoryIdentity(index.repository) || (repository !== undefined && index.repository !== repository))
    errors.push("settled index repository is invalid.");
  if (!isBoundedSafeIntegerString(index.writerRunId) || !isBoundedSafeIntegerString(index.writerRunAttempt))
    errors.push("settled index writer is invalid.");
  const windowStartMs = parseTimezoneInstantMs(index.windowStart);
  if (windowStartMs === null) errors.push("settled index window is invalid.");
  if (!Array.isArray(index.entries) || index.entries.length > SETTLED_INDEX_MAX_ENTRIES)
    return [...errors, "settled index entries are invalid."];
  let previous = null;
  for (const entry of index.entries) {
    if (validateMergeQualificationSettledEntry(entry).length) return [...errors, "settled index entry is invalid."];
    // Canonical order makes the projection content-derived and its keys unique.
    if (previous && compareSettledEntries(previous, entry) >= 0) return [...errors, "settled index keys repeat."];
    if (windowStartMs !== null && parseTimezoneInstantMs(entry.startedAt) < windowStartMs)
      return [...errors, "settled index retains an aged entry."];
    previous = entry;
  }
  return errors;
}

function settledLookup(index, repository) {
  if (!index || validateMergeQualificationSettledIndex(index, { repository }).length) return null;
  return new Map(index.entries.map((entry) => [settledKey(entry.variant, entry.runId, entry.runAttempt), entry]));
}

// Settlement suppresses a leg only for the exact variant/run/attempt key with
// the same producer join; anything else stays pending work.
function isSettledAttempt(lookup, variant, runId, runAttempt, join) {
  const entry = lookup?.get(settledKey(variant, runId, runAttempt));
  return Boolean(entry) && sameJoin(entry.join, join);
}

function distinctTerminalPayloads(payloads) {
  if (
    !Array.isArray(payloads) ||
    payloads.length > 16 ||
    payloads.some((bytes) => typeof bytes !== "string" || Buffer.byteLength(bytes) > 65_536)
  )
    return null;
  return [...new Set(payloads)];
}

function parseJsonOrNull(bytes) {
  try {
    return JSON.parse(bytes);
  } catch {
    return null;
  }
}

// Derives one entry from durable terminal and marker bytes, never from
// artifact names or presence. `settled: false` without errors is ordinary
// unsettled work; errors are evidence that must fail the writing leg.
export function deriveMergeQualificationSettledEntry({
  variant,
  repository,
  terminals,
  cleanupMarker = null,
  advisoryJoin = null,
} = {}) {
  const invalid = (code) => ({ settled: false, entry: null, errors: [code] });
  const unsettled = { settled: false, entry: null, errors: [] };
  if (!MERGE_QUALIFICATION_SETTLED_VARIANTS.includes(variant)) return invalid("settlement_variant_invalid");
  if (!isRepositoryIdentity(repository)) return invalid("settlement_repository_invalid");
  if (advisoryJoin !== null && !isAttemptReference(advisoryJoin)) return invalid("settlement_join_invalid");
  const payloads = distinctTerminalPayloads(terminals);
  if (payloads === null) return invalid("settlement_terminal_invalid");
  if (payloads.length === 0) return unsettled;
  const settled = (entry) => {
    const errors = validateMergeQualificationSettledEntry(entry);
    return errors.length ? invalid("settlement_entry_invalid") : { settled: true, entry, errors: [] };
  };

  if (variant === "advisory") {
    if (payloads.length !== 1) return invalid("settlement_terminal_conflict");
    const event = parseJsonOrNull(payloads[0]);
    if (
      validateMergeQualificationEvent(event).length ||
      event.repository !== repository ||
      event.workflowPath !== ADVISORY_WORKFLOW_PATH ||
      !isBoundedSafeIntegerString(event.runId) ||
      !isBoundedSafeIntegerString(event.runAttempt) ||
      !isBoundedSafeIntegerString(event.parentRunId) ||
      !isBoundedSafeIntegerString(event.parentRunAttempt)
    )
      return invalid("settlement_terminal_invalid");
    // A terminal without its exact cleanup marker remains unsettled.
    if (cleanupMarker === null) return unsettled;
    const marker = typeof cleanupMarker === "string" ? parseJsonOrNull(cleanupMarker) : null;
    if (
      !isClosedObject(marker, ["runId", "runAttempt", "cleanup"]) ||
      marker.runId !== event.runId ||
      marker.runAttempt !== event.runAttempt ||
      marker.cleanup !== "complete"
    )
      return invalid("settlement_marker_invalid");
    return settled({
      variant,
      runId: event.runId,
      runAttempt: event.runAttempt,
      join: { runId: event.parentRunId, runAttempt: event.parentRunAttempt },
      terminals: [{ terminalState: event.terminalState, sha256: sha256Hex(payloads[0]) }],
      cleanupMarkerSha256: sha256Hex(cleanupMarker),
      startedAt: event.startedAt,
    });
  }

  const records = payloads.map((bytes) => ({ bytes, record: parseJsonOrNull(bytes) }));
  const [first] = records;
  if (
    records.some(
      ({ record }) =>
        validateMergeQualificationProducerTerminal(record).length > 0 ||
        record.repository !== repository ||
        [
          "producerWorkflowId",
          "producerRunId",
          "producerRunAttempt",
          "producerHeadSha",
          "policyRevision",
          "startedAt",
        ].some((field) => record[field] !== first.record?.[field]),
    )
  )
    return invalid("settlement_terminal_invalid");
  const states = records.map(({ record }) => record.terminalState);
  if (new Set(states).size !== states.length) return invalid("settlement_terminal_conflict");
  const conflict = records.find(({ record }) => record.terminalState === "conflict")?.record ?? null;
  let join = null;
  if (conflict) {
    join =
      conflict.advisoryRunId === null || conflict.advisoryRunAttempt === null
        ? null
        : { runId: conflict.advisoryRunId, runAttempt: conflict.advisoryRunAttempt };
    if (join === null || !sameJoin(join, advisoryJoin)) return invalid("settlement_join_conflict");
  } else if (advisoryJoin !== null) {
    // A loss whose advisory run arrived late awaits cleanup and its conflict record.
    return unsettled;
  }
  return settled({
    variant,
    runId: first.record.producerRunId,
    runAttempt: first.record.producerRunAttempt,
    join,
    terminals: records
      .map(({ bytes, record }) => ({ terminalState: record.terminalState, sha256: sha256Hex(bytes) }))
      .sort((left, right) => (left.terminalState < right.terminalState ? -1 : 1)),
    cleanupMarkerSha256: null,
    startedAt: first.record.startedAt,
  });
}

// The only permitted change to a retained entry: a settled producer loss whose
// late advisory run is now named by a conflict record that keeps the loss bytes.
function refinesProducerLoss(existing, next) {
  return (
    existing.variant === "producer_loss" &&
    next.variant === "producer_loss" &&
    existing.join === null &&
    next.join !== null &&
    existing.startedAt === next.startedAt &&
    existing.terminals.length === 1 &&
    next.terminals.some(
      (terminal) =>
        terminal.terminalState === existing.terminals[0].terminalState &&
        terminal.sha256 === existing.terminals[0].sha256,
    )
  );
}

// Monotonic: every prior entry inside the 48-hour window is retained unchanged
// (or refined as above); entries that age out leave their attempt an explicit
// unknown, never settled.
export function writeMergeQualificationSettledIndex({
  repository,
  prior = null,
  entries = [],
  writerRunId,
  writerRunAttempt,
  now = () => new Date(),
} = {}) {
  const refused = (code) => ({ index: null, aged: 0, added: 0, errors: [code] });
  if (!isRepositoryIdentity(repository)) return refused("settled_index_repository_invalid");
  if (!isBoundedSafeIntegerString(writerRunId) || !isBoundedSafeIntegerString(writerRunAttempt))
    return refused("settled_index_writer_invalid");
  if (prior !== null && validateMergeQualificationSettledIndex(prior, { repository }).length)
    return refused("settled_index_prior_invalid");
  if (!Array.isArray(entries) || entries.length > SETTLED_ENTRIES_PER_DELIVERY)
    return refused("settled_index_entries_invalid");
  const windowStartMs = inventoryWindowStartMs(now);
  if (!Number.isFinite(windowStartMs)) return refused("settled_index_window_invalid");
  const merged = new Map();
  let aged = 0;
  for (const entry of prior?.entries ?? []) {
    if (parseTimezoneInstantMs(entry.startedAt) < windowStartMs) {
      aged += 1;
      continue;
    }
    merged.set(settledKey(entry.variant, entry.runId, entry.runAttempt), canonicalSettledEntry(entry));
  }
  let added = 0;
  for (const candidate of entries) {
    if (validateMergeQualificationSettledEntry(candidate).length) return refused("settled_index_entry_invalid");
    if (parseTimezoneInstantMs(candidate.startedAt) < windowStartMs) continue;
    const entry = canonicalSettledEntry(candidate);
    const key = settledKey(entry.variant, entry.runId, entry.runAttempt);
    const existing = merged.get(key);
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) continue;
    if (existing && !refinesProducerLoss(existing, entry)) return refused("settled_index_not_monotonic");
    merged.set(key, entry);
    added += 1;
  }
  const index = {
    schemaVersion: MERGE_QUALIFICATION_SETTLED_INDEX_SCHEMA_VERSION,
    repository,
    writerRunId,
    writerRunAttempt,
    windowStart: new Date(windowStartMs).toISOString().replace(/\.000Z$/, "Z"),
    entries: [...merged.values()].sort(compareSettledEntries),
  };
  if (validateMergeQualificationSettledIndex(index, { repository }).length)
    return refused("settled_index_capacity_exceeded");
  return { index, aged, added, errors: [] };
}

// Exactly three REST calls per delivery: the latest successful default-branch
// observer run, its named index artifact, and that artifact's download. A
// stale index is safe because settlement is monotonic; missing, invalid or
// incomplete evidence is an explicit unknown that leaves every attempt pending.
export async function readMergeQualificationSettledIndex({
  repository,
  defaultBranch,
  requestJson,
  downloadArtifact,
} = {}) {
  const unknown = (code) => ({ state: "unknown", index: null, writer: null, errors: [code] });
  if (!isRepositoryIdentity(repository)) return unknown("settled_index_repository_invalid");
  if (typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]{1,256}$/.test(defaultBranch))
    return unknown("settled_index_branch_invalid");
  const branch = defaultBranch.replace(/^refs\/heads\//u, "");
  try {
    const latest = await requestJson(
      `repos/${repository}/actions/workflows/platform-merge-qualification-observer.yml/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=1`,
    );
    if (
      !Number.isSafeInteger(latest?.total_count) ||
      latest.total_count < 0 ||
      !Array.isArray(latest.workflow_runs) ||
      latest.workflow_runs.length !== Math.min(1, latest.total_count)
    )
      return unknown("settled_index_lookup_incomplete");
    if (latest.total_count === 0) return unknown("settled_index_missing");
    const run = latest.workflow_runs[0];
    const runId = String(run?.id ?? "");
    const runAttempt = String(run?.run_attempt ?? "");
    if (
      !isBoundedSafeIntegerString(runId) ||
      !isBoundedSafeIntegerString(runAttempt) ||
      run?.repository?.full_name !== repository ||
      run?.head_repository?.full_name !== repository ||
      run?.head_branch !== branch ||
      run?.path !== OBSERVER_WORKFLOW_PATH ||
      !["schedule", "workflow_run"].includes(run?.event) ||
      run?.status !== "completed" ||
      run?.conclusion !== "success"
    )
      return unknown("settled_index_writer_invalid");
    const listing = await requestJson(
      `repos/${repository}/actions/runs/${runId}/artifacts?name=${MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT}`,
    );
    if (
      !Number.isSafeInteger(listing?.total_count) ||
      !Array.isArray(listing.artifacts) ||
      listing.artifacts.length !== listing.total_count
    )
      return unknown("settled_index_lookup_incomplete");
    if (listing.total_count === 0) return unknown("settled_index_missing");
    const [artifact] = listing.artifacts;
    const artifactId = String(artifact?.id ?? "");
    if (
      listing.total_count !== 1 ||
      !isBoundedSafeIntegerString(artifactId) ||
      artifact?.name !== MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT ||
      artifact?.expired !== false ||
      String(artifact?.workflow_run?.id ?? "") !== runId
    )
      return unknown("settled_index_artifact_invalid");
    const bytes = await downloadArtifact({ artifactId });
    if (typeof bytes !== "string" || Buffer.byteLength(bytes) > SETTLED_INDEX_MAX_BYTES)
      return unknown("settled_index_payload_invalid");
    const index = parseJsonOrNull(bytes);
    if (validateMergeQualificationSettledIndex(index, { repository }).length)
      return unknown("settled_index_payload_invalid");
    if (index.writerRunId !== runId || index.writerRunAttempt !== runAttempt)
      return unknown("settled_index_writer_invalid");
    return { state: "valid", index, writer: { runId, runAttempt }, errors: [] };
  } catch {
    return unknown("settled_index_authority_unavailable");
  }
}

export function resolveRunTerminalization({
  runEvent = "",
  runConclusion = "",
  runDisplayTitle = "",
  jobs = [],
  decision = null,
  provisioningObserved = false,
  queueDisposition = "unknown",
  observation = null,
} = {}) {
  if (runEvent !== "workflow_dispatch") return { action: "skip", reason: "not_advisory_workflow_run" };
  if (runDisplayTitle && !ADVISORY_RUN_TITLE.test(runDisplayTitle)) {
    return { action: "skip", reason: "not_merge_group_advisory" };
  }
  const jobNamed = (pattern) => jobs.find((job) => pattern.test(String(job?.name ?? "")));
  const publisher = jobNamed(/^Merge Qualification \(advisory\)$/);
  // Called-workflow jobs surface in the caller run as "Merge Qualification
  // Gate / <job>"; a skipped call surfaces as one "Merge Qualification Gate"
  // entry.
  const gateJobs = jobs.filter((job) => /^Merge Qualification Gate/.test(String(job?.name ?? "")));
  const gateCancelled = gateJobs.some((job) => job?.conclusion === "cancelled");
  if (validateMergeQualificationDecision(decision).length > 0) {
    return { action: "unknown", reason: "policy_decision_evidence_missing" };
  }
  if (!decision.policyEnabled) {
    return { action: "skip", reason: decision.policyReasonCode };
  }
  if (
    ![
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ].includes(runConclusion)
  ) {
    return { action: "unknown", reason: "run_conclusion_unknown" };
  }
  if (queueDisposition === "evicted") {
    return {
      action: "terminalize",
      terminalState: "cancelled_evicted",
      reasonCodes: ["candidate_evicted"],
      provisioned: provisioningObserved === true,
    };
  }
  if (runConclusion === "cancelled") {
    // Attribute the cancellation to the EARLIEST cancelled stage — that is
    // where the pipeline actually died; later jobs are collateral.
    const reason =
      jobNamed(/^Merge Qualification Plan$/)?.conclusion === "cancelled"
        ? "plan_cancelled"
        : gateCancelled
          ? "gate_cancelled"
          : publisher?.conclusion === "cancelled"
            ? "publisher_cancelled"
            : "run_force_cancelled";
    return {
      action: "terminalize",
      terminalState: "cancelled_evicted",
      reasonCodes: [reason],
      provisioned: provisioningObserved === true,
    };
  }
  if (!["queued", "merged"].includes(queueDisposition)) {
    return {
      action: "terminalize",
      terminalState: "infrastructure_error",
      reasonCodes: ["queue_disposition_unknown"],
      provisioned: provisioningObserved === true,
    };
  }
  if (decision.classifierClass === null) {
    return {
      action: "terminalize",
      terminalState: "infrastructure_error",
      reasonCodes: ["classifier_output_missing"],
      provisioned: provisioningObserved === true,
    };
  }
  if (observation && validateMergeQualificationEvent(observation).length === 0) {
    return {
      action: "terminalize",
      terminalState: observation.terminalState,
      reasonCodes: observation.reasonCodes,
      provisioned: provisioningObserved === true,
    };
  }
  if (["not_applicable", "persistent_required"].includes(decision.classifierClass)) {
    return {
      action: "terminalize",
      terminalState: decision.classifierClass,
      reasonCodes: decision.classifierReasonCodes,
      provisioned: false,
    };
  }
  if (publisher?.conclusion === "skipped") {
    return {
      action: "terminalize",
      terminalState: "infrastructure_error",
      reasonCodes: ["publisher_skipped_enabled"],
      provisioned: provisioningObserved === true,
    };
  }
  // The run completed without cancellation, the policy is enabled, and no
  // terminal event exists: the publisher never executed (startup failure,
  // runner loss) or could not write a valid record. Never silent.
  return {
    action: "terminalize",
    terminalState: "infrastructure_error",
    reasonCodes: ["advisory_result_missing"],
    provisioned: provisioningObserved === true,
  };
}

export function recoverMergeGateProvisioningObservation({ jobs = [], decision = null, run = null } = {}) {
  const createSteps = jobs
    .filter((job) => /^Merge Qualification Gate \/ Verify Merge Candidate$/.test(String(job?.name ?? "")))
    .flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .filter((step) => step?.name === "Create gate namespace" && step?.conclusion === "success");
  if (createSteps.length === 0) return { observation: null, errors: [] };
  if (createSteps.length !== 1) {
    return { observation: null, errors: ["namespace creation step evidence is ambiguous."] };
  }
  if (validateMergeQualificationDecision(decision).length > 0 || decision?.classifierClass !== "isolated") {
    return { observation: null, errors: ["successful namespace creation lacks its exact isolated decision."] };
  }
  if (
    decision.repository !== run?.repository?.full_name ||
    decision.workflowId !== String(run?.workflow_id ?? "") ||
    decision.workflowPath !== run?.path ||
    decision.runId !== String(run?.id ?? "") ||
    decision.runAttempt !== String(run?.run_attempt ?? "")
  ) {
    return { observation: null, errors: ["successful namespace creation decision does not bind the advisory run."] };
  }
  const completedAt = new Date(createSteps[0].completed_at ?? "");
  if (!Number.isFinite(completedAt.getTime())) {
    return { observation: null, errors: ["successful namespace creation step has no durable completion instant."] };
  }
  try {
    return {
      observation: buildMergeGateProvisioningObservation({
        repository: decision.repository,
        workflowId: decision.workflowId,
        workflowPath: decision.workflowPath,
        runId: decision.runId,
        runAttempt: decision.runAttempt,
        namespace: `chase-sets-gate-${decision.runId}-${decision.runAttempt}`,
        candidateSha: decision.candidateSha,
        candidateTreeSha: decision.candidateTreeSha,
        imageDigest: decision.builtImageDigest,
        observedAt: completedAt.toISOString(),
      }),
      errors: [],
    };
  } catch (error) {
    return { observation: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
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
  const runId = normalize(input.runId);
  const runAttempt = normalize(input.runAttempt);
  const repository = normalize(input.repository);
  const workflowId = normalize(input.workflowId ?? "1");
  const workflowPath = normalize(input.workflowPath ?? ".github/workflows/platform-merge-qualification.yml");
  const imageDigest = input.imageDigest ? normalize(input.imageDigest).toLowerCase() : null;
  const builtImageDigest = input.builtImageDigest ? normalize(input.builtImageDigest).toLowerCase() : null;
  const candidateSha = input.candidateSha ? normalize(input.candidateSha).toLowerCase() : null;
  const candidateTreeSha = input.candidateTreeSha ? normalize(input.candidateTreeSha).toLowerCase() : null;
  const gateCandidateSha = input.gateCandidateSha ? normalize(input.gateCandidateSha).toLowerCase() : null;
  const gateCandidateTreeSha = input.gateCandidateTreeSha ? normalize(input.gateCandidateTreeSha).toLowerCase() : null;
  // Immutable proof is observed independently at four owning boundaries:
  // upstream candidate capture, image push, gate image resolution, and gate
  // candidate resolution. Expected inputs never fill a missing observation.
  const identityAvailable =
    isCommitSha(candidateSha) &&
    isCommitSha(candidateTreeSha) &&
    IMAGE_DIGEST_PATTERN.test(imageDigest ?? "") &&
    IMAGE_DIGEST_PATTERN.test(builtImageDigest ?? "") &&
    imageDigest === builtImageDigest &&
    gateCandidateSha === candidateSha &&
    gateCandidateTreeSha === candidateTreeSha;
  const event = {
    schemaVersion: MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION,
    idempotencyKey:
      normalize(input.idempotencyKey) || `merge-qualification:${repository}:${workflowId}:${runId}:${runAttempt}`,
    repository,
    workflowId,
    workflowPath,
    parentWorkflowId: normalize(input.parentWorkflowId),
    parentWorkflowPath: normalize(input.parentWorkflowPath),
    parentRunId: normalize(input.parentRunId),
    parentRunAttempt: normalize(input.parentRunAttempt),
    candidateSha,
    candidateTreeSha,
    identityAvailable,
    imageDigest,
    builtImageDigest,
    gateCandidateSha,
    gateCandidateTreeSha,
    classifierClass: input.classifierClass ?? null,
    terminalState: normalize(input.terminalState),
    reasonCodes: Array.isArray(input.reasonCodes) ? input.reasonCodes : [],
    provisioned: input.provisioned === true,
    startedAt: normalize(input.startedAt),
    completedAt: normalize(input.completedAt),
    runId,
    runAttempt,
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
    "idempotencyKey",
    "repository",
    "workflowId",
    "workflowPath",
    "parentWorkflowId",
    "parentWorkflowPath",
    "parentRunId",
    "parentRunAttempt",
    "candidateSha",
    "candidateTreeSha",
    "identityAvailable",
    "imageDigest",
    "builtImageDigest",
    "gateCandidateSha",
    "gateCandidateTreeSha",
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
  if (!isRepositoryIdentity(event.repository)) {
    errors.push("repository must be an owner/name GitHub repository slug.");
  }
  if (!isBoundedSafeIntegerString(event.workflowId) || !isWorkflowPath(event.workflowPath)) {
    errors.push(
      "workflowId must be a bounded safe integer string and workflowPath must be an exact workflow YAML path.",
    );
  }
  if (!isBoundedSafeIntegerString(event.parentWorkflowId) || !isWorkflowPath(event.parentWorkflowPath)) {
    errors.push("parent workflow identity must bind the exact triggering workflow.");
  }
  if (!isBoundedSafeIntegerString(event.parentRunId) || !isBoundedSafeIntegerString(event.parentRunAttempt)) {
    errors.push("parent run identity must bind the exact triggering run attempt.");
  }
  const expectedKey = `merge-qualification:${event.repository}:${event.workflowId}:${event.runId}:${event.runAttempt}`;
  if (event.idempotencyKey !== expectedKey || event.idempotencyKey.length > MAX_IDENTITY_LENGTH) {
    errors.push("idempotencyKey must deterministically bind repository, workflow, run, and attempt.");
  }
  const candidateFieldsPresent = event.candidateSha !== null || event.candidateTreeSha !== null;
  if (candidateFieldsPresent && (!isCommitSha(event.candidateSha) || !isCommitSha(event.candidateTreeSha))) {
    errors.push("candidate identity must be null or a complete independently observed SHA/tree pair.");
  }
  if (typeof event.identityAvailable !== "boolean") {
    errors.push("identityAvailable must be a boolean.");
  }
  if (event.imageDigest !== null && !IMAGE_DIGEST_PATTERN.test(event.imageDigest ?? "")) {
    errors.push("imageDigest must be null or an immutable sha256 image digest.");
  }
  if (!MERGE_QUALIFICATION_TERMINAL_STATES.includes(event.terminalState)) {
    errors.push(`terminalState must be exactly one of ${MERGE_QUALIFICATION_TERMINAL_STATES.join(", ")}.`);
  }
  const classifierClasses = new Set(["isolated", "not_applicable", "persistent_required"]);
  if (event.classifierClass !== null && !classifierClasses.has(event.classifierClass)) {
    errors.push("classifierClass must be isolated, not_applicable, persistent_required, or null.");
  }
  if (["passed", "failed"].includes(event.terminalState) && event.classifierClass !== "isolated") {
    errors.push("passed/failed events require classifierClass isolated.");
  }
  if (event.terminalState === "not_applicable" && event.classifierClass !== "not_applicable") {
    errors.push("not_applicable events require classifierClass not_applicable.");
  }
  if (event.terminalState === "persistent_required" && event.classifierClass !== "persistent_required") {
    errors.push("persistent_required events require classifierClass persistent_required.");
  }
  if (
    ["cancelled_evicted", "infrastructure_error"].includes(event.terminalState) &&
    ![null, "isolated"].includes(event.classifierClass)
  ) {
    errors.push("cancellation/infrastructure events may only carry isolated or no classifier state.");
  }
  for (const [field, value] of [
    ["builtImageDigest", event.builtImageDigest],
    ["gateCandidateSha", event.gateCandidateSha],
    ["gateCandidateTreeSha", event.gateCandidateTreeSha],
  ]) {
    if (value !== null && typeof value !== "string") errors.push(`${field} must be a string or null.`);
  }
  if (event.builtImageDigest !== null && !IMAGE_DIGEST_PATTERN.test(event.builtImageDigest ?? "")) {
    errors.push("builtImageDigest must be null or an immutable sha256 image digest.");
  }
  if (event.gateCandidateSha !== null && !isCommitSha(event.gateCandidateSha)) {
    errors.push("gateCandidateSha must be null or an exact commit SHA.");
  }
  if (event.gateCandidateTreeSha !== null && !isCommitSha(event.gateCandidateTreeSha)) {
    errors.push("gateCandidateTreeSha must be null or an exact tree SHA.");
  }
  const exactIdentityAvailable =
    isCommitSha(event.candidateSha) &&
    isCommitSha(event.candidateTreeSha) &&
    IMAGE_DIGEST_PATTERN.test(event.imageDigest ?? "") &&
    IMAGE_DIGEST_PATTERN.test(event.builtImageDigest ?? "") &&
    event.imageDigest === event.builtImageDigest &&
    event.gateCandidateSha === event.candidateSha &&
    event.gateCandidateTreeSha === event.candidateTreeSha;
  if (event.identityAvailable !== exactIdentityAvailable) {
    errors.push("identityAvailable must be derived from every independently observed immutable proof field.");
  }
  if (["passed", "failed"].includes(event.terminalState)) {
    if (
      event.identityAvailable !== true ||
      !IMAGE_DIGEST_PATTERN.test(event.imageDigest ?? "") ||
      !IMAGE_DIGEST_PATTERN.test(event.builtImageDigest ?? "") ||
      event.imageDigest !== event.builtImageDigest ||
      event.gateCandidateSha !== event.candidateSha ||
      event.gateCandidateTreeSha !== event.candidateTreeSha
    ) {
      errors.push(
        "passed/failed candidate evidence requires exact built and gate sha256 digests plus candidate SHA/tree echoes.",
      );
    }
  } else {
    if (event.identityAvailable !== false) {
      errors.push("non-candidate terminal states must explicitly record immutable identity as unavailable.");
    }
    if (
      event.imageDigest !== null ||
      event.builtImageDigest !== null ||
      event.gateCandidateSha !== null ||
      event.gateCandidateTreeSha !== null
    ) {
      errors.push("non-candidate terminal states cannot carry gate/image proof fields.");
    }
  }
  if (event.providerHeadroom !== null) {
    const headroom = event.providerHeadroom;
    if (
      typeof headroom !== "object" ||
      headroom === null ||
      Array.isArray(headroom) ||
      Object.keys(headroom).some((field) => field !== "headroomRuns") ||
      !(
        Number.isSafeInteger(headroom.headroomRuns) &&
        headroom.headroomRuns >= 0 &&
        headroom.headroomRuns <= MAX_HEADROOM_RUNS
      )
    ) {
      errors.push("providerHeadroom must be null or { headroomRuns: <non-negative finite number> }.");
    }
  }
  if (
    !Array.isArray(event.reasonCodes) ||
    event.reasonCodes.length === 0 ||
    event.reasonCodes.length > MAX_REASON_CODES ||
    new Set(event.reasonCodes).size !== event.reasonCodes.length ||
    event.reasonCodes.some((code) => typeof code !== "string" || code.length > 64 || !REASON_CODE_PATTERN.test(code))
  ) {
    errors.push("reasonCodes must be a non-empty array of deterministic lowercase reason codes.");
  } else {
    const allowedReasons = TERMINAL_REASON_CODES[event.terminalState];
    if (!allowedReasons || event.reasonCodes.some((code) => !allowedReasons.has(code))) {
      errors.push("reasonCodes contain a value that contradicts or is unknown for the terminal state.");
    }
  }
  if (typeof event.provisioned !== "boolean") {
    errors.push("provisioned must be a boolean.");
  } else if (event.provisioned === true && !PROVISIONING_TERMINAL_STATES.has(event.terminalState)) {
    errors.push(
      `terminalState ${event.terminalState} must not provision a namespace; provisioned records are only valid for ${[...PROVISIONING_TERMINAL_STATES].join(", ")}.`,
    );
  } else if (event.provisioned === true && (!isCommitSha(event.candidateSha) || !isCommitSha(event.candidateTreeSha))) {
    errors.push("a provisioned event requires the exact candidate identity carried by namespace ownership evidence.");
  }
  if (!isIsoInstant(event.startedAt)) {
    errors.push("startedAt must be an ISO-8601 UTC instant.");
  }
  if (!isIsoInstant(event.completedAt)) {
    errors.push("completedAt must be an ISO-8601 UTC instant.");
  } else if (isIsoInstant(event.startedAt)) {
    const durationMs = parseTimezoneInstantMs(event.completedAt) - parseTimezoneInstantMs(event.startedAt);
    if (durationMs < 0) errors.push("completedAt must not precede startedAt.");
    if (durationMs > 7 * 24 * 60 * 60 * 1000) errors.push("event duration exceeds the bounded seven-day maximum.");
  }
  if (!isBoundedSafeIntegerString(event.runId) || !isBoundedSafeIntegerString(event.runAttempt)) {
    errors.push("runId and runAttempt must be bounded positive safe-integer strings.");
  }
  if (
    !Array.isArray(event.evidenceLinks) ||
    event.evidenceLinks.length === 0 ||
    event.evidenceLinks.length > MAX_EVIDENCE_LINKS ||
    new Set(event.evidenceLinks).size !== event.evidenceLinks.length
  ) {
    errors.push("evidenceLinks must be a non-empty array of https evidence URLs.");
  } else {
    for (const link of event.evidenceLinks) {
      if (typeof link !== "string" || link.length > MAX_EVIDENCE_LINK_LENGTH || !/^https:\/\/\S+$/.test(link)) {
        errors.push(`evidenceLinks entry ${JSON.stringify(link)} must be an https URL.`);
      }
    }
  }
  return errors;
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

async function writeQualificationEvidence(outPath, record) {
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 65_536) throw new Error("qualification_payload_too_large");
  await mkdir(path.dirname(outPath), { recursive: true });
  try {
    await writeFile(outPath, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST" || statSync(outPath).size > 65_536 || readFileSync(outPath, "utf8") !== bytes) {
      throw new Error("qualification_payload_conflict");
    }
  }
}

async function main(argv, env = process.env) {
  const [command] = argv;
  const nowIso = readOption(argv, "--now");
  const now = nowIso ? () => new Date(nowIso) : () => new Date();

  if (command === "run-collection") {
    try {
      const collection = await readMergeQualificationRunCollection({
        repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
        runId: readOption(argv, "--run-id"),
        runAttempt: readOption(argv, "--run-attempt"),
        collection: readOption(argv, "--collection"),
        requestJson: async (endpoint) =>
          JSON.parse(
            execFileSync("gh", ["api", endpoint], {
              encoding: "utf8",
              timeout: 30_000,
              maxBuffer: 8_000_000,
              stdio: ["ignore", "pipe", "pipe"],
            }),
          ),
      });
      await writeJsonRecord(readOption(argv, "--out"), collection);
      return 0;
    } catch {
      console.error("run_collection_authority_unavailable");
      return 1;
    }
  }

  if (command === "settled-index-read") {
    const repository = readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY;
    const gh = (args, encoding = "utf8") =>
      execFileSync("gh", args, {
        encoding,
        timeout: 30_000,
        maxBuffer: 8_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const result = await readMergeQualificationSettledIndex({
      repository,
      defaultBranch: readOption(argv, "--default-branch") ?? env.GITHUB_REF_NAME ?? "main",
      requestJson: async (endpoint) => JSON.parse(gh(["api", endpoint])),
      downloadArtifact: async ({ artifactId }) => {
        const directory = mkdtempSync(path.join(tmpdir(), "qualification-settled-index-"));
        try {
          const archive = path.join(directory, "settled-index.zip");
          // gh follows the authenticated redirect without forwarding the token to the artifact host.
          writeFileSync(archive, gh(["api", `repos/${repository}/actions/artifacts/${artifactId}/zip`], "buffer"));
          const unzip = (args) =>
            execFileSync("unzip", args, {
              encoding: "utf8",
              timeout: 30_000,
              maxBuffer: SETTLED_INDEX_MAX_BYTES + 1,
              stdio: ["ignore", "pipe", "pipe"],
            });
          if (unzip(["-Z1", archive]).trim() !== SETTLED_INDEX_FILE) throw new Error("settled_index_archive_invalid");
          return unzip(["-p", archive, SETTLED_INDEX_FILE]);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    });
    const out = readOption(argv, "--out");
    if (result.state === "valid" && out) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(result.index)}\n`);
    }
    appendOutputs(readOption(argv, "--github-output"), [
      ["state", result.state],
      ["reason", result.errors[0] ?? ""],
      ["entries", String(result.index?.entries.length ?? 0)],
    ]);
    appendSummary(
      readOption(argv, "--github-summary"),
      result.state === "valid"
        ? `Settled-attempt index from observer run ${result.writer.runId} attempt ${result.writer.runAttempt}: ${result.index.entries.length} settled attempts.`
        : `Settled-attempt index unknown (${result.errors[0]}); every inventoried attempt stays pending work.`,
    );
    return 0;
  }

  if (command === "inventory") {
    const repository = readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY;
    const requestJson = async (endpoint) =>
      JSON.parse(
        execFileSync("gh", ["api", endpoint], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 8_000_000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    const listing = await listMergeQualificationAdvisoryRuns({ repository, requestJson, now });
    const result = listing.errors.length
      ? { attempts: [], settled: 0, errors: listing.errors }
      : await inventoryMergeQualificationAttempts({
          repository,
          now,
          requestJson,
          advisoryRuns: listing.runs,
          settledIndex: readJsonFileOrNull(readOption(argv, "--settled-index")),
          readPolicyContent: async (revision) => readOriginalQualificationPolicy(revision),
        });
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      return 1;
    }
    const advisoryRunsOut = readOption(argv, "--advisory-runs-out");
    if (advisoryRunsOut) {
      await mkdir(path.dirname(advisoryRunsOut), { recursive: true });
      await writeFile(advisoryRunsOut, `${JSON.stringify(listing.runs)}\n`);
    }
    appendOutputs(readOption(argv, "--github-output"), [
      ["matrix", JSON.stringify({ include: result.attempts })],
      ["pending", result.attempts.length ? "true" : "false"],
      ["settled", String(result.settled)],
    ]);
    appendSummary(
      readOption(argv, "--github-summary"),
      result.attempts.length
        ? `${result.attempts.length} advisory attempts pending; ${result.settled} settled attempts scheduled no leg.`
        : `No enabled completed advisory attempts require reconciliation; ${result.settled} settled attempts scheduled no leg.`,
    );
    return 0;
  }

  if (command === "producer-inventory") {
    const requestJson = async (endpoint) =>
      JSON.parse(
        execFileSync("gh", ["api", endpoint], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 8_000_000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    const advisoryRunsPath = readOption(argv, "--advisory-runs");
    const advisoryRuns = advisoryRunsPath ? readJsonFileOrNull(advisoryRunsPath) : null;
    if (advisoryRunsPath && !Array.isArray(advisoryRuns)) {
      console.error("advisory_inventory_incomplete");
      return 1;
    }
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
      defaultBranch: readOption(argv, "--default-branch") ?? env.GITHUB_REF_NAME ?? "main",
      now,
      requestJson,
      advisoryRuns,
      settledIndex: readJsonFileOrNull(readOption(argv, "--settled-index")),
      readProducerImageEligibility: ({ run, repository }) =>
        readMergeQualificationProducerImageEligibility({ repository, run, requestJson }),
    });
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      return 1;
    }
    appendOutputs(readOption(argv, "--github-output"), [
      ["matrix", JSON.stringify({ include: result.attempts })],
      ["pending", result.attempts.length ? "true" : "false"],
      ["settled", String(result.settled)],
    ]);
    appendSummary(
      readOption(argv, "--github-summary"),
      result.attempts.length
        ? `${result.attempts.length} producer attempts pending; ${result.settled} settled producer losses scheduled no leg.`
        : `No completed producer attempts are missing advisory dispatch; ${result.settled} settled producer losses scheduled no leg.`,
    );
    return 0;
  }

  if (command === "settled-entry") {
    const repository = readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY;
    const readBytes = (file) => {
      try {
        return statSync(file).size > 65_536 ? null : readFileSync(file, "utf8");
      } catch {
        return null;
      }
    };
    const records = readJsonFileOrNull(readOption(argv, "--terminal-records"))?.records;
    const eventPath = readOption(argv, "--event");
    const markerPath = readOption(argv, "--cleanup-marker");
    const terminals = Array.isArray(records) ? [...records] : null;
    if (eventPath) terminals?.push(readBytes(eventPath));
    const cleanupMarker = markerPath ? readBytes(markerPath) : null;
    if (terminals === null || (markerPath && cleanupMarker === null)) {
      console.error("settlement_evidence_unreadable");
      return 1;
    }
    const advisoryRunPath = readOption(argv, "--advisory-run");
    const advisoryRun = advisoryRunPath ? readJsonFileOrNull(advisoryRunPath) : null;
    const result = deriveMergeQualificationSettledEntry({
      variant: readOption(argv, "--variant"),
      repository,
      terminals,
      cleanupMarker,
      advisoryJoin: advisoryRun
        ? { runId: String(advisoryRun.id ?? ""), runAttempt: String(advisoryRun.run_attempt ?? "") }
        : null,
    });
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      return 1;
    }
    if (result.settled) await writeJsonRecord(readOption(argv, "--out"), result.entry);
    appendOutputs(readOption(argv, "--github-output"), [["settled", result.settled ? "true" : "false"]]);
    return 0;
  }

  if (command === "settled-index-write") {
    const priorPath = readOption(argv, "--prior");
    const prior = priorPath ? readJsonFileOrNull(priorPath) : null;
    if (priorPath && prior === null) {
      console.error("settled_index_prior_invalid");
      return 1;
    }
    const loaded = readSettledEntryArtifacts(readOption(argv, "--entries-dir"));
    const result = loaded.errors.length
      ? { index: null, errors: loaded.errors }
      : writeMergeQualificationSettledIndex({
          repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
          prior,
          entries: loaded.entries,
          writerRunId: readOption(argv, "--writer-run-id") ?? env.GITHUB_RUN_ID,
          writerRunAttempt: readOption(argv, "--writer-run-attempt") ?? env.GITHUB_RUN_ATTEMPT,
          now,
        });
    const bytes = result.index ? `${JSON.stringify(result.index)}\n` : "";
    if (result.errors.length || Buffer.byteLength(bytes) > SETTLED_INDEX_MAX_BYTES) {
      console.error(result.errors[0] ?? "settled_index_capacity_exceeded");
      return 1;
    }
    const out = readOption(argv, "--out");
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, bytes);
    appendSummary(
      readOption(argv, "--github-summary"),
      `Settled-attempt index: ${result.index.entries.length} entries (${result.added} added; ${result.aged} aged out of the ${MERGE_QUALIFICATION_INVENTORY_HORIZON_HOURS}-hour window and left explicit unknown).`,
    );
    return 0;
  }

  if (command === "producer-reconcile") {
    const producer = readJsonFileOrNull(readOption(argv, "--producer"));
    const candidate = readJsonFileOrNull(readOption(argv, "--candidate"));
    const policy = readJsonFileOrNull(readOption(argv, "--policy"));
    const policyAuthorityError = readOption(argv, "--policy-authority-error");
    const policyPath = readOption(argv, "--policy");
    let policyContent = null;
    try {
      policyContent = policyPath ? readFileSync(policyPath, "utf8") : null;
    } catch {
      policyContent = null;
    }
    const advisoryRun = readJsonFileOrNull(readOption(argv, "--advisory-run"));
    const existingTerminal = readJsonFileOrNull(readOption(argv, "--existing-terminal"));
    const existingTerminals = readJsonFileOrNull(readOption(argv, "--existing-terminals"));
    const result = reconcileMergeQualificationProducerAttempt({
      producer,
      candidate,
      policy,
      policyContent,
      policyAuthorityError,
      advisoryRun,
      existingTerminal,
      existingTerminals,
      advisoryCleanupComplete: readOption(argv, "--advisory-cleanup-complete") === "true",
      now: now(),
    });
    const out = readOption(argv, "--out");
    if (out && result.event) await writeQualificationEvidence(out, result.event);
    appendOutputs(readOption(argv, "--github-output"), [
      ["state", result.state],
      ["event_written", result.event ? "true" : "false"],
    ]);
    console.log(JSON.stringify(result, null, 2));
    return result.state === "unknown" ? 1 : 0;
  }

  if (command === "producer-terminal-inventory") {
    const producer = readJsonFileOrNull(readOption(argv, "--producer"));
    const advisoryRun = readJsonFileOrNull(readOption(argv, "--advisory-run"));
    const repository = readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY;
    const defaultBranch = readOption(argv, "--default-branch") ?? env.GITHUB_REF_NAME ?? "main";
    const gh = (args) =>
      execFileSync("gh", args, {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const result = await readMergeQualificationProducerTerminalRecords({
      repository,
      producer,
      advisoryRun,
      defaultBranch,
      requestJson: async (endpoint) => JSON.parse(gh(["api", endpoint])),
      downloadArtifact: async ({ runId, name, fileName = "event.json" }) => {
        const directory = mkdtempSync(path.join(tmpdir(), "qualification-producer-terminal-"));
        try {
          gh(["run", "download", runId, "--repo", repository, "--name", name, "--dir", directory]);
          const entries = readdirSync(directory, { withFileTypes: true });
          if (entries.length !== 1 || !entries[0].isFile() || entries[0].name !== fileName)
            throw new Error("terminal_payload_extra_files");
          const file = path.join(directory, fileName);
          if (statSync(file).size > 65_536) throw new Error("terminal_payload_invalid");
          return readFileSync(file, "utf8");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    });
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      return 1;
    }
    await writeJsonRecord(readOption(argv, "--out"), {
      records: result.records ?? [],
      state: result.state ?? "unknown",
      advisoryCleanupComplete: result.advisoryCleanupComplete === true,
    });
    return 0;
  }

  if (command === "terminal-inventory") {
    const decision = readJsonFileOrNull(readOption(argv, "--decision"));
    const gh = (args) =>
      execFileSync("gh", args, {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const result = await readMergeQualificationTerminalRecords({
      decision,
      defaultBranch: readOption(argv, "--default-branch"),
      requestJson: async (endpoint) => JSON.parse(gh(["api", endpoint])),
      downloadArtifact: async ({ runId, name, fileName = "event.json" }) => {
        const directory = mkdtempSync(path.join(tmpdir(), "qualification-terminal-"));
        try {
          gh(["run", "download", runId, "--repo", decision.repository, "--name", name, "--dir", directory]);
          const entries = readdirSync(directory, { withFileTypes: true });
          if (entries.length !== 1 || !entries[0].isFile() || entries[0].name !== fileName)
            throw new Error("terminal_payload_extra_files");
          const file = path.join(directory, fileName);
          if (statSync(file).size > 65_536) throw new Error("terminal_payload_invalid");
          return readFileSync(file, "utf8");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    });
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      return 1;
    }
    await writeJsonRecord(readOption(argv, "--out"), { records: result.records });
    return 0;
  }

  if (command === "cancelled-record") {
    const built = buildCancelledMergeQualificationRecord({
      decision: readJsonFileOrNull(readOption(argv, "--decision")),
      ownership: readJsonFileOrNull(readOption(argv, "--ownership")),
      run: readJsonFileOrNull(readOption(argv, "--run")),
    });
    if (built.errors.length) {
      console.error(built.errors.join("\n"));
      return 1;
    }
    await writeJsonRecord(readOption(argv, "--out"), built.record);
    return 0;
  }

  if (command === "queue-disposition") {
    const candidate = readJsonFileOrNull(readOption(argv, "--candidate-record"));
    for (const [flag, field] of [
      ["--candidate-sha", "candidateSha"],
      ["--candidate-tree", "candidateTreeSha"],
      ["--built-image-digest", "builtImageDigest"],
      ["--repository", "repository"],
      ["--parent-run-id", "runId"],
      ["--parent-run-attempt", "runAttempt"],
    ]) {
      if (readOption(argv, flag) && readOption(argv, flag) !== candidate?.[field]) {
        console.error("queue candidate does not match the independently resolved gate identity.");
        return 1;
      }
    }
    const snapshotPath = readOption(argv, "--queue-snapshot");
    const disposition = snapshotPath
      ? resolveMergeQualificationQueueDisposition({ candidate, snapshot: readJsonFileOrNull(snapshotPath) })
      : await observeMergeQualificationQueueDisposition(candidate, {
          token: env.GH_TOKEN,
          branch: readOption(argv, "--branch") ?? "main",
        });
    appendOutputs(readOption(argv, "--github-output"), [["disposition", disposition]]);
    console.log(JSON.stringify({ disposition }));
    return disposition === "queued" ? 0 : 1;
  }

  if (command === "recover-decision") {
    const run = readJsonFileOrNull(readOption(argv, "--run"));
    const parentRun = readJsonFileOrNull(readOption(argv, "--parent-run"));
    const candidate = readJsonFileOrNull(readOption(argv, "--candidate-record"));
    const policyRevision = run?.head_sha;
    if (!isCommitSha(policyRevision) || parseTimezoneInstantMs(run?.run_started_at) === null) {
      console.error("original policy revision or attempt time is unavailable.");
      return 1;
    }
    let policyContent;
    try {
      policyContent = readOriginalQualificationPolicy(policyRevision);
    } catch {
      console.error("original policy revision is unavailable; current policy was not substituted.");
      return 1;
    }
    const policy = evaluateMergeQualificationPolicy(policyContent, { now: () => new Date(run.run_started_at) });
    const classifierRecord = policy.enabled ? readJsonFileOrNull(readOption(argv, "--classifier-record")) : null;
    const built = recoverMergeQualificationDecision({
      run,
      parentRun,
      candidate,
      policyContent,
      policyRevision,
      classifierRecord,
    });
    if (built.errors.length) {
      console.error(built.errors.join("\n"));
      return 1;
    }
    await writeJsonRecord(readOption(argv, "--out"), built.decision);
    return 0;
  }

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

  if (command === "candidate-evidence") {
    if (readOption(argv, "--associated-pull-pages")) {
      console.error(
        "candidate-evidence no longer accepts --associated-pull-pages: commits/<sha>/pulls is empty while the candidate is queued, so it can never provide producer-time identity. Pass --merge-queue-snapshot captured during the merge_group run instead.",
      );
      return 1;
    }
    const built = buildMergeQualificationCandidateFromMergeQueueSnapshot({
      repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
      run: readJsonFileOrNull(readOption(argv, "--run-metadata")),
      mergeQueueSnapshot: readJsonFileOrNull(readOption(argv, "--merge-queue-snapshot")),
      queueBaseSha: readOption(argv, "--queue-base-sha"),
      policyRevision: readOption(argv, "--policy-revision"),
      builtImageDigest: readOption(argv, "--built-image-digest"),
      capturedAt: readOption(argv, "--captured-at") ?? now().toISOString(),
    });
    if (built.errors.length > 0) {
      console.error(built.errors.join("\n"));
      return 1;
    }
    await writeQualificationEvidence(readOption(argv, "--out"), built.record);
    console.log(JSON.stringify(built.record, null, 2));
    return 0;
  }

  if (command === "decision") {
    const candidateRecordPath = readOption(argv, "--candidate-record");
    const candidateRecord = candidateRecordPath ? readJsonFileOrNull(candidateRecordPath) : null;
    if (candidateRecordPath) {
      const candidateErrors = validateMergeQualificationCandidate(candidateRecord);
      const bindingErrors =
        candidateErrors.length === 0 &&
        candidateRecord.repository === (readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY) &&
        candidateRecord.workflowId === readOption(argv, "--parent-workflow-id") &&
        candidateRecord.workflowPath === readOption(argv, "--parent-workflow-path") &&
        candidateRecord.runId === readOption(argv, "--parent-run-id") &&
        candidateRecord.runAttempt === readOption(argv, "--parent-run-attempt")
          ? []
          : ["candidate evidence does not bind the exact parent workflow/run/attempt and candidate identity."];
      if (candidateErrors.length > 0 || bindingErrors.length > 0) {
        console.error([...candidateErrors, ...bindingErrors].join("\n"));
        return 1;
      }
    }
    const built = buildMergeQualificationDecision({
      repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
      workflowId: readOption(argv, "--workflow-id"),
      workflowPath: readOption(argv, "--workflow-path"),
      runId: readOption(argv, "--run-id") ?? env.GITHUB_RUN_ID,
      runAttempt: readOption(argv, "--run-attempt") ?? env.GITHUB_RUN_ATTEMPT,
      parentWorkflowId: readOption(argv, "--parent-workflow-id"),
      parentWorkflowPath: readOption(argv, "--parent-workflow-path"),
      parentRunId: readOption(argv, "--parent-run-id"),
      parentRunAttempt: readOption(argv, "--parent-run-attempt"),
      candidateSha: candidateRecord?.candidateSha ?? readOption(argv, "--candidate-sha") ?? null,
      candidateTreeSha: candidateRecord?.candidateTreeSha ?? readOption(argv, "--candidate-tree") ?? null,
      builtImageDigest: candidateRecord?.builtImageDigest ?? readOption(argv, "--built-image-digest") ?? null,
      policyRevision: readOption(argv, "--policy-revision"),
      policyEnabled: readOption(argv, "--policy-enabled") === "true",
      policyReasonCode: readOption(argv, "--policy-reason-code") || null,
      classifierClass: readOption(argv, "--classifier-class") || null,
      classifierReasonCodes: readOption(argv, "--classifier-reason-codes") ?? "",
      observedAt: readOption(argv, "--observed-at") ?? now().toISOString(),
    });
    if (built.errors.length > 0) {
      console.error(built.errors.join("\n"));
      return 1;
    }
    await writeQualificationEvidence(readOption(argv, "--out"), built.decision);
    appendOutputs(readOption(argv, "--github-output"), [
      ["enabled", built.decision.policyEnabled ? "true" : "false"],
      [
        "route",
        built.decision.classifierClass === "isolated"
          ? "isolated"
          : built.decision.classifierClass
            ? "record-only"
            : "disabled",
      ],
      ["candidate_sha", built.decision.candidateSha],
      ["candidate_tree", built.decision.candidateTreeSha],
      ["built_image_digest", built.decision.builtImageDigest ?? ""],
      ["classifier_class", built.decision.classifierClass ?? ""],
      ["classifier_reason_codes", built.decision.classifierReasonCodes.join(",")],
      ["started_at", built.decision.observedAt],
      ["workflow_id", built.decision.workflowId],
      ["workflow_path", built.decision.workflowPath],
    ]);
    console.log(JSON.stringify(built.decision, null, 2));
    return 0;
  }

  if (command === "observe") {
    const decisionRecordPath = readOption(argv, "--decision");
    const decisionRecord = decisionRecordPath ? readJsonFileOrNull(decisionRecordPath) : null;
    if (decisionRecordPath && validateMergeQualificationDecision(decisionRecord).length > 0) {
      console.error(validateMergeQualificationDecision(decisionRecord).join("\n"));
      return 1;
    }
    const policyPath = readOption(argv, "--policy") ?? MERGE_QUALIFICATION_POLICY_PATH;
    const provisioningPath = readOption(argv, "--provisioning-observation");
    const provisioningObservation = provisioningPath ? readJsonFileOrNull(provisioningPath) : null;
    const provisioningErrors = provisioningPath
      ? validateMergeGateProvisioningObservation(provisioningObservation, {
          repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
          workflowId: readOption(argv, "--workflow-id") ?? env.GITHUB_WORKFLOW_ID,
          workflowPath:
            readOption(argv, "--workflow-path") ??
            env.GITHUB_WORKFLOW_PATH ??
            ".github/workflows/platform-merge-qualification.yml",
          runId: readOption(argv, "--run-id") ?? env.GITHUB_RUN_ID,
          runAttempt: readOption(argv, "--run-attempt") ?? env.GITHUB_RUN_ATTEMPT,
        })
      : [];
    if (
      provisioningObservation &&
      decisionRecord &&
      (provisioningObservation.candidateSha !== decisionRecord.candidateSha ||
        provisioningObservation.candidateTreeSha !== decisionRecord.candidateTreeSha ||
        provisioningObservation.imageDigest !== decisionRecord.builtImageDigest)
    ) {
      provisioningErrors.push("provisioning observation does not match the exact upstream decision identity.");
    }
    const decision = decisionRecord
      ? {
          enabled: decisionRecord.policyEnabled,
          state: decisionRecord.policyEnabled ? "enabled" : "disabled",
          reasonCode: decisionRecord.policyReasonCode,
          errors: decisionRecord.policyEnabled ? [] : ["the original run-attempt policy decision was disabled."],
        }
      : evaluateMergeQualificationPolicy(readMergeQualificationPolicyContent(policyPath), { now });
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
    errors.push(...provisioningErrors);
    if (outcome.recordRequired) {
      const completedAt = now().toISOString();
      const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? readOption(argv, "--repository") ?? ""}/actions/runs/${env.GITHUB_RUN_ID ?? readOption(argv, "--run-id") ?? ""}/attempts/${env.GITHUB_RUN_ATTEMPT ?? readOption(argv, "--run-attempt") ?? ""}`;
      const headroomRuns = Number(readOption(argv, "--provider-headroom-runs") ?? "");
      const built = buildMergeQualificationEvent({
        repository: readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY,
        workflowId: readOption(argv, "--workflow-id") ?? env.GITHUB_WORKFLOW_ID ?? "1",
        workflowPath:
          readOption(argv, "--workflow-path") ??
          env.GITHUB_WORKFLOW_PATH ??
          ".github/workflows/platform-merge-qualification.yml",
        parentWorkflowId: decisionRecord?.parentWorkflowId,
        parentWorkflowPath: decisionRecord?.parentWorkflowPath,
        parentRunId: decisionRecord?.parentRunId,
        parentRunAttempt: decisionRecord?.parentRunAttempt,
        candidateSha: decisionRecord?.candidateSha,
        candidateTreeSha: decisionRecord?.candidateTreeSha,
        imageDigest: ["passed", "failed"].includes(outcome.terminalState) ? gateImageDigest : null,
        builtImageDigest: ["passed", "failed"].includes(outcome.terminalState)
          ? readOption(argv, "--built-image-digest")
          : null,
        gateCandidateSha: ["passed", "failed"].includes(outcome.terminalState)
          ? readOption(argv, "--gate-candidate-sha")
          : null,
        gateCandidateTreeSha: ["passed", "failed"].includes(outcome.terminalState)
          ? readOption(argv, "--gate-candidate-tree")
          : null,
        classifierClass: readOption(argv, "--classifier-class") || null,
        terminalState: outcome.terminalState,
        reasonCodes: outcome.reasonCodes,
        // This is set only after the exact namespace-created observation was
        // durably uploaded. Gate/job outcomes and configured names are not
        // provisioning evidence.
        provisioned: provisioningObservation !== null && provisioningErrors.length === 0,
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
        await writeQualificationEvidence(outPath, { ...event, schemaVersion: "merge-qualification-observation/v1" });
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

  if (command === "terminalize" || command === "prepare-cleanup") {
    const run = readJsonFileOrNull(readOption(argv, "--run"));
    const parentRun = readJsonFileOrNull(readOption(argv, "--parent-run"));
    const jobsPayload = readJsonFileOrNull(readOption(argv, "--jobs"));
    const artifactsPayload = readJsonFileOrNull(readOption(argv, "--run-artifacts"));
    const decision = readJsonFileOrNull(readOption(argv, "--decision"));
    const provisioningPath = readOption(argv, "--provisioning-observation");
    const provisioningObservation = provisioningPath ? readJsonFileOrNull(provisioningPath) : null;
    const repository = readOption(argv, "--repository") ?? env.GITHUB_REPOSITORY;
    const collectionErrors = [];
    if (!run || normalize(run.repository?.full_name) !== repository)
      collectionErrors.push("run repository binding failed.");
    if (run?.path !== ".github/workflows/platform-merge-qualification.yml") {
      collectionErrors.push("run workflow path binding failed.");
    }
    if (typeof run?.display_title !== "string" || run.display_title.length > MAX_IDENTITY_LENGTH) {
      collectionErrors.push("run display title binding failed.");
    }
    if (!isBoundedSafeIntegerString(String(run?.workflow_id ?? "")))
      collectionErrors.push("run workflow ID is invalid.");
    const provisioningErrors = provisioningPath
      ? validateMergeGateProvisioningObservation(provisioningObservation, {
          repository,
          workflowId: String(run?.workflow_id ?? ""),
          workflowPath: run?.path,
          runId: String(run?.id ?? ""),
          runAttempt: String(run?.run_attempt ?? ""),
        })
      : [];
    collectionErrors.push(...provisioningErrors);
    const titleParent = String(run?.display_title ?? "").match(ADVISORY_RUN_TITLE);
    if (
      !titleParent ||
      normalize(parentRun?.repository?.full_name) !== repository ||
      parentRun?.path !== ".github/workflows/platform-pr.yml" ||
      parentRun?.event !== "merge_group" ||
      String(parentRun?.id ?? "") !== titleParent?.[1] ||
      String(parentRun?.run_attempt ?? "") !== titleParent?.[2] ||
      !isBoundedSafeIntegerString(String(parentRun?.workflow_id ?? ""))
    ) {
      collectionErrors.push("parent run causal binding failed.");
    }
    for (const [payload, field, label] of [
      [jobsPayload, "jobs", "jobs"],
      [artifactsPayload, "artifacts", "artifacts"],
    ]) {
      if (
        !payload ||
        !Number.isSafeInteger(payload.total_count) ||
        payload.total_count < 0 ||
        !Array.isArray(payload[field]) ||
        payload[field].length !== payload.total_count
      ) {
        collectionErrors.push(`${label} pagination did not match the API total.`);
      }
    }
    if (collectionErrors.length > 0) {
      console.error(collectionErrors.join("\n"));
      return 1;
    }
    const decisionBound =
      validateMergeQualificationDecision(decision).length === 0 &&
      decision.repository === repository &&
      decision.workflowId === String(run?.workflow_id ?? "") &&
      decision.workflowPath === run?.path &&
      decision.runId === String(run?.id ?? "") &&
      decision.runAttempt === String(run?.run_attempt ?? "") &&
      decision.parentWorkflowId === String(parentRun?.workflow_id ?? "") &&
      decision.parentWorkflowPath === parentRun?.path &&
      decision.parentRunId === String(parentRun?.id ?? "") &&
      decision.parentRunAttempt === String(parentRun?.run_attempt ?? "") &&
      decision.policyRevision === run?.head_sha
        ? decision
        : null;
    if (
      provisioningObservation &&
      (!decisionBound ||
        provisioningObservation.candidateSha !== decisionBound.candidateSha ||
        provisioningObservation.candidateTreeSha !== decisionBound.candidateTreeSha ||
        provisioningObservation.imageDigest !== decisionBound.builtImageDigest)
    ) {
      console.error("provisioning observation does not match the exact run-attempt decision identity.");
      return 1;
    }
    const recoveredProvisioning = provisioningObservation
      ? { observation: provisioningObservation, errors: [] }
      : recoverMergeGateProvisioningObservation({ jobs: jobsPayload?.jobs ?? [], decision: decisionBound, run });
    if (recoveredProvisioning.errors.length > 0) {
      console.error(recoveredProvisioning.errors.join("\n"));
      return 1;
    }
    const ownershipObservation = recoveredProvisioning.observation;
    const ownershipOut = readOption(argv, "--cleanup-ownership-out");
    if (ownershipOut && ownershipObservation) await writeJsonRecord(ownershipOut, ownershipObservation);
    if (command === "prepare-cleanup") {
      appendOutputs(readOption(argv, "--github-output"), [
        ["provisioned", ownershipObservation !== null ? "true" : "false"],
      ]);
      return 0;
    }
    const terminalRecordsPath = readOption(argv, "--terminal-records");
    if (terminalRecordsPath) {
      const replay = resolveMergeQualificationTerminalReplay({
        decision: decisionBound,
        records: readJsonFileOrNull(terminalRecordsPath)?.records,
      });
      if (replay.errors.length) {
        console.error(replay.errors.join("\n"));
        return 1;
      }
      if (replay.action === "replay") {
        if (replay.event.provisioned !== (ownershipObservation !== null)) {
          console.error("terminal_ownership_conflict");
          return 1;
        }
        appendOutputs(readOption(argv, "--github-output"), [
          ["action", "replay"],
          ["event_written", "false"],
        ]);
        return 0;
      }
    }
    const candidate = readJsonFileOrNull(readOption(argv, "--candidate-record"));
    const boundCandidate =
      candidate?.candidateSha === decisionBound?.candidateSha &&
      candidate?.candidateTreeSha === decisionBound?.candidateTreeSha &&
      candidate?.repository === decisionBound?.repository &&
      candidate?.workflowId === decisionBound?.parentWorkflowId &&
      candidate?.workflowPath === decisionBound?.parentWorkflowPath &&
      candidate?.runId === decisionBound?.parentRunId &&
      candidate?.runAttempt === decisionBound?.parentRunAttempt
        ? candidate
        : null;
    const queueSnapshotPath = readOption(argv, "--queue-snapshot");
    const queueDisposition = decisionBound?.policyEnabled
      ? queueSnapshotPath
        ? resolveMergeQualificationQueueDisposition({
            candidate: boundCandidate,
            snapshot: readJsonFileOrNull(queueSnapshotPath),
          })
        : await observeMergeQualificationQueueDisposition(boundCandidate, { token: env.GH_TOKEN })
      : "unknown";
    const observationPayload = readJsonFileOrNull(readOption(argv, "--observation"));
    const observation =
      observationPayload?.schemaVersion === "merge-qualification-observation/v1"
        ? { ...observationPayload, schemaVersion: MERGE_QUALIFICATION_EVENT_SCHEMA_VERSION }
        : null;
    if (
      observationPayload &&
      (validateMergeQualificationEvent(observation).length > 0 ||
        !decisionBound ||
        [
          "repository",
          "workflowId",
          "workflowPath",
          "runId",
          "runAttempt",
          "parentRunId",
          "parentRunAttempt",
          "parentWorkflowId",
          "parentWorkflowPath",
          "candidateSha",
          "candidateTreeSha",
        ].some((key) => observation[key] !== decisionBound[key]) ||
        observation.classifierClass !== decisionBound.classifierClass ||
        (["passed", "failed"].includes(observation.terminalState) &&
          observation.builtImageDigest !== decisionBound.builtImageDigest) ||
        observation.provisioned !== (ownershipObservation !== null))
    ) {
      console.error("advisory observation does not bind the exact decision and observed resource ownership.");
      return 1;
    }
    const resolution = resolveRunTerminalization({
      runEvent: run?.event ?? "",
      runConclusion: run?.conclusion ?? "",
      runDisplayTitle: run?.display_title ?? "",
      jobs: jobsPayload?.jobs ?? [],
      decision: decisionBound,
      provisioningObserved: ownershipObservation !== null,
      queueDisposition,
      observation,
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
      const built = buildMergeQualificationEvent({
        repository,
        workflowId: run?.workflow_id === undefined || run?.workflow_id === null ? "" : String(run.workflow_id),
        workflowPath: run?.path ?? ".github/workflows/platform-merge-qualification.yml",
        parentWorkflowId: String(parentRun?.workflow_id ?? ""),
        parentWorkflowPath: parentRun?.path ?? "",
        parentRunId: String(parentRun?.id ?? ""),
        parentRunAttempt: String(parentRun?.run_attempt ?? ""),
        // Decision-less cancellation is real evidence about an exact causal
        // attempt, but it has no candidate identity. Never substitute the
        // advisory run's default-branch head SHA.
        candidateSha: decisionBound?.candidateSha ?? ownershipObservation?.candidateSha ?? null,
        candidateTreeSha: decisionBound?.candidateTreeSha ?? ownershipObservation?.candidateTreeSha ?? null,
        imageDigest: null,
        classifierClass: decisionBound?.classifierClass ?? null,
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
      event =
        observation &&
        resolution.terminalState === observation.terminalState &&
        JSON.stringify(resolution.reasonCodes) === JSON.stringify(observation.reasonCodes)
          ? observation
          : built.event;
      errors.push(...validateMergeQualificationEvent(event));
      const outPath = readOption(argv, "--out");
      if (outPath && errors.length === 0) {
        await writeQualificationEvidence(outPath, event);
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
      ["provisioned", ownershipObservation !== null ? "true" : "false"],
    ]);
    console.log(JSON.stringify({ decision, resolution, event, errors }, null, 2));
    if (resolution.action === "unknown") {
      console.error(resolution.reason);
      return 1;
    }
    if (errors.length > 0) {
      // A terminalization that cannot produce a valid event must fail loudly:
      // the candidate stays visible as an orphan in delivery health.
      console.error(errors.join("\n"));
      return 1;
    }
    return 0;
  }

  console.error(
    "usage: merge-qualification.mjs <policy|route|candidate-evidence|decision|recover-decision|cancelled-record|queue-disposition|observe|settled-index-read|inventory|producer-inventory|producer-reconcile|prepare-cleanup|terminal-inventory|terminalize|settled-entry|settled-index-write> [options]",
  );
  return 1;
}

// Each settlement entry arrives as one artifact holding one file, both named
// for its exact variant/run/attempt key, downloaded with merge-multiple so the
// layout is the same for zero, one or many artifacts. The file name must agree
// with the content it carries.
function readSettledEntryArtifacts(directory) {
  const invalid = (code) => ({ entries: [], errors: [code] });
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true });
  } catch {
    return invalid("settled_entries_unreadable");
  }
  if (files.length > SETTLED_ENTRIES_PER_DELIVERY) return invalid("settled_entry_artifact_invalid");
  const entries = [];
  for (const candidate of files) {
    const key = candidate.isFile()
      ? new RegExp(
          `^${MERGE_QUALIFICATION_SETTLED_ENTRY_ARTIFACT_PREFIX}(advisory|producer_loss)-([1-9][0-9]{0,15})-([1-9][0-9]{0,15})\\.json$`,
          "u",
        ).exec(candidate.name)
      : null;
    if (!key) return invalid("settled_entry_artifact_invalid");
    const file = path.join(directory, candidate.name);
    const entry = statSync(file).size > 65_536 ? null : parseJsonOrNull(readFileSync(file, "utf8"));
    if (
      validateMergeQualificationSettledEntry(entry).length ||
      entry.variant !== key[1] ||
      entry.runId !== key[2] ||
      entry.runAttempt !== key[3]
    )
      return invalid("settled_entry_artifact_invalid");
    entries.push(entry);
  }
  return { entries, errors: [] };
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

function isClosedObject(value, fields) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((field) => fields.includes(field)) &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isBoundedSafeIntegerString(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_SAFE_INTEGER_BIGINT;
  } catch {
    return false;
  }
}

function isRepositoryIdentity(value) {
  return typeof value === "string" && value.length <= MAX_IDENTITY_LENGTH && REPOSITORY_PATTERN.test(value);
}

function isWorkflowPath(value) {
  return typeof value === "string" && value.length <= MAX_IDENTITY_LENGTH && WORKFLOW_PATH_PATTERN.test(value);
}

function isIsoInstant(value) {
  return parseTimezoneInstantMs(value) !== null;
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
    () => {
      console.error("merge_qualification_command_failed");
      process.exitCode = 1;
    },
  );
}

export { main };
