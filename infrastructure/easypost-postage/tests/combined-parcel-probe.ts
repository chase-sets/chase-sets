import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostageLabelProviderError, type PurchaseUspsLabelRequest } from "@chase-sets/postage-labels";
import { createEasyPostPostageLabelProvider } from "../index";
import { easyPostTestMemberParcel, easyPostTestRecipient, easyPostTestSender } from "./easypost-test-fixtures";

export const confirmation = "execute combined-parcel probe 6461";
export const workflowPath = ".github/workflows/platform-staging-representative-commerce-state.yml";
export const bodyHash = "3b0a95ff6988d9e8c6f6267f9290fe40a08b242ec37befc3bc64de51b8f767d3";
export const focusedCommand =
  "pnpm --filter @chase-sets/easypost-postage run test -- tests/combined-parcel-probe.test.ts";
export const phases = ["pre-a", "case-a-pre-b", "case-b"] as const;
export const checkpoints = ["pre-a", "post-a", "pre-b", "final"] as const;
export const caseIds = ["combined-parcel-uninsured", "combined-parcel-insured"] as const;
export const privateFilename = "combined-parcel-probe-private-state.json";
export const publicFilename = "combined-parcel-probe-evidence.json";
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const capabilities = [
  "usps-rate",
  "usps-service-level",
  "signature-delivery-confirmation",
  "label-document",
  "tracking",
] as const;
const cleanupStates = ["voided", "not-purchased", "void-failed", "reconciliation-required"] as const;
const refundStatuses = ["submitted", "refunded", "rejected", "not_applicable"] as const;
type CaseId = (typeof caseIds)[number];
type Checkpoint = (typeof checkpoints)[number];
type Phase = (typeof phases)[number];
type Cleanup = (typeof cleanupStates)[number];
type Mode = "test" | "production" | null;
type CasePhase = "unattempted" | "attempt-locked" | "purchase-ambiguous" | "purchase-confirmed" | Cleanup;
type Environment = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;

export function requireProbe(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`combined-parcel-probe: ${reason}`);
}
function object(value: unknown): JsonObject {
  requireProbe(value !== null && typeof value === "object" && !Array.isArray(value), "object-required");
  return value as JsonObject;
}
function closed(value: unknown, keys: readonly string[]): JsonObject {
  const record = object(value);
  requireProbe(
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)),
    "closed-schema",
  );
  return record;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function instant(value: unknown): value is string {
  if (!matches(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)) return false;
  const date = Date.parse(value);
  return (
    Number.isFinite(date) &&
    value.slice(0, 10) === new Date(date + offsetMinutes(value) * 60_000).toISOString().slice(0, 10)
  );
}
function offsetMinutes(value: string) {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(value);
  return match ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const parcel = { ...easyPostTestMemberParcel, heightInches: 2, weightOunces: 8 };
const reference = (id: CaseId) =>
  `CHASE-SETS-PROBE-6461-${id === caseIds[0] ? "UNINSURED" : "INSURED"}-SYNTHETIC-SHIPMENT`;

export function caseRequest(id: CaseId): PurchaseUspsLabelRequest {
  return {
    subjectKind: "shipment",
    subjectId: reference(id),
    idempotencyKey: reference(id),
    serviceLevel: "GroundAdvantage",
    sender: easyPostTestSender,
    recipient: easyPostTestRecipient,
    package: parcel,
    ...(id === caseIds[1] ? { insuranceAmount: "600.00" } : {}),
  };
}

export type PublicRecord = {
  schemaVersion: "combined-parcel-probe-evidence/v1";
  probeIssue: 6461;
  caseId: CaseId;
  capturedAt: string;
  outcome: "accepted" | "rejected" | "transport-error" | "inconclusive";
  providerName: string;
  providerModeEchoed: Mode;
  requestedServiceLevel: "GroundAdvantage";
  syntheticReference: string;
  memberCount: 2;
  parcel: typeof parcel;
  declaredInsuranceAmount: "600.00" | null;
  ratesReturnedCount: number;
  uspsRatesReturnedCount: number;
  serviceLevelMatched: boolean;
  selectedRateAmountCents: number | null;
  selectedRateCurrency: string | null;
  httpStatus: number | null;
  errorKind: "validation" | "capability" | "provider" | null;
  errorCapability: (typeof capabilities)[number] | null;
  errorReasonCategory: null;
  errorReasonCategoryAssignedBy: null;
  purchaseAttemptCount: 1;
  cleanupState: Cleanup;
  refundStatusEchoed: string | null;
  addressFixture: "synthetic-carrier-test-fixture";
  privateCorrelationReference: string;
  redactionControlPassed: true;
};
const publicKeys = [
  "schemaVersion",
  "probeIssue",
  "caseId",
  "capturedAt",
  "outcome",
  "providerName",
  "providerModeEchoed",
  "requestedServiceLevel",
  "syntheticReference",
  "memberCount",
  "parcel",
  "declaredInsuranceAmount",
  "ratesReturnedCount",
  "uspsRatesReturnedCount",
  "serviceLevelMatched",
  "selectedRateAmountCents",
  "selectedRateCurrency",
  "httpStatus",
  "errorKind",
  "errorCapability",
  "errorReasonCategory",
  "errorReasonCategoryAssignedBy",
  "purchaseAttemptCount",
  "cleanupState",
  "refundStatusEchoed",
  "addressFixture",
  "privateCorrelationReference",
  "redactionControlPassed",
];

export function validatePublicRecord(value: unknown): asserts value is PublicRecord {
  const r = closed(value, publicKeys);
  requireProbe(
    r.schemaVersion === "combined-parcel-probe-evidence/v1" && r.probeIssue === 6461 && oneOf(r.caseId, caseIds),
    "public-identity",
  );
  requireProbe(
    instant(r.capturedAt) && oneOf(r.outcome, ["accepted", "rejected", "transport-error", "inconclusive"]),
    "public-outcome",
  );
  requireProbe(
    r.providerName === "easypost" &&
      (r.providerModeEchoed === null || oneOf(r.providerModeEchoed, ["test", "production"])),
    "public-mode",
  );
  requireProbe(
    !oneOf(r.outcome, ["accepted", "rejected"]) || r.providerModeEchoed === "test",
    "external-test-echo-required",
  );
  requireProbe(
    r.requestedServiceLevel === "GroundAdvantage" &&
      r.syntheticReference === reference(r.caseId) &&
      r.memberCount === 2,
    "public-request",
  );
  const p = closed(r.parcel, Object.keys(parcel));
  requireProbe(
    Object.entries(parcel).every(([key, number]) => p[key] === number),
    "public-parcel",
  );
  requireProbe(r.declaredInsuranceAmount === (r.caseId === caseIds[0] ? null : "600.00"), "public-insurance");
  requireProbe(
    integer(r.ratesReturnedCount, 0, 500) &&
      integer(r.uspsRatesReturnedCount, 0, Number(r.ratesReturnedCount)) &&
      typeof r.serviceLevelMatched === "boolean",
    "public-rates",
  );
  requireProbe(!r.serviceLevelMatched || Number(r.uspsRatesReturnedCount) > 0, "public-service");
  requireProbe(r.selectedRateAmountCents === null || integer(r.selectedRateAmountCents, 0, 1_000_000), "public-amount");
  requireProbe(r.selectedRateCurrency === null || matches(r.selectedRateCurrency, /^[A-Z]{3}$/), "public-currency");
  requireProbe(r.httpStatus === null || integer(r.httpStatus, 100, 599), "public-status");
  requireProbe(r.errorKind === null || oneOf(r.errorKind, ["validation", "capability", "provider"]), "public-error");
  requireProbe(r.errorCapability === null || oneOf(r.errorCapability, capabilities), "public-capability");
  requireProbe(r.errorCapability === null || r.errorKind === "capability", "public-capability-kind");
  requireProbe(
    r.errorReasonCategory === null && r.errorReasonCategoryAssignedBy === null,
    "no-operator-category-channel",
  );
  requireProbe(r.purchaseAttemptCount === 1 && oneOf(r.cleanupState, cleanupStates), "public-cleanup");
  requireProbe(
    r.outcome !== "accepted" || (r.serviceLevelMatched && r.cleanupState !== "not-purchased" && r.errorKind === null),
    "public-accepted",
  );
  requireProbe(r.outcome !== "rejected" || r.cleanupState === "not-purchased", "public-rejected");
  requireProbe(r.refundStatusEchoed === null || oneOf(r.refundStatusEchoed, refundStatuses), "public-refund");
  requireProbe(
    r.addressFixture === "synthetic-carrier-test-fixture" &&
      matches(r.privateCorrelationReference, /^[A-Z0-9-]{8,64}$/) &&
      r.redactionControlPassed === true,
    "public-redaction",
  );
}
export function validatePublicEvidence(value: unknown): asserts value is [PublicRecord, PublicRecord] {
  requireProbe(Array.isArray(value) && value.length === 2, "two-records-required");
  value.forEach((r, i) => {
    validatePublicRecord(r);
    requireProbe(
      r.caseId === caseIds[i] && oneOf(r.cleanupState, ["voided", "not-purchased"]),
      "ordered-clean-records-required",
    );
  });
}

type Observation = { status: number | null; mode: Mode; valid: boolean; purchase: "yes" | "no" | "unknown" };
type CaseState = {
  phase: CasePhase;
  purchaseAttemptCount: number;
  createCount: number;
  buyCount: number;
  recoveryCount: number;
  voidCount: number;
  sequence: number;
  lockedRunId: string | null;
  lockedRunAttempt: string | null;
  providerShipmentId: string | null;
  providerLabelId: string | null;
  providerRateId: string | null;
  providerRefundId: string | null;
  trackingIdentifier: string | null;
  publicHandle: string;
  authorityContradiction: boolean;
  observations: Record<"create" | "buy" | "recovery" | "void", Observation>;
  ratesReturnedCount: number;
  uspsRatesReturnedCount: number;
  serviceLevelMatched: boolean;
  selectedRateAmountCents: number | null;
  selectedRateCurrency: string | null;
  refundStatusEchoed: string | null;
  errorKind: PublicRecord["errorKind"];
  errorCapability: PublicRecord["errorCapability"];
  publicRecord: PublicRecord | null;
};
export type Receipt = {
  runId: string;
  runAttempt: string;
  checkpoint: Checkpoint;
  artifactId: string;
  artifactDigest: string;
  payloadDigest: string;
};
export type PrivateState = {
  schemaVersion: "combined-parcel-probe-private-state/v1";
  probeIssue: 6461;
  bodyHash: string;
  repository: string;
  workflowPath: string;
  sourceSha: string;
  runId: string;
  runAttempt: string;
  credentialBindingDigest: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  checkpoint: Checkpoint;
  sequence: number;
  cases: Record<CaseId, CaseState>;
  receipts: Record<Checkpoint, Receipt | null>;
};
export type Identity = { repository: string; sourceSha: string; runId: string; runAttempt: string };
const blankObservation = (): Observation => ({ status: null, mode: null, valid: false, purchase: "unknown" });
function blankCase(): CaseState {
  return {
    phase: "unattempted",
    purchaseAttemptCount: 0,
    createCount: 0,
    buyCount: 0,
    recoveryCount: 0,
    voidCount: 0,
    sequence: 0,
    lockedRunId: null,
    lockedRunAttempt: null,
    providerShipmentId: null,
    providerLabelId: null,
    providerRateId: null,
    providerRefundId: null,
    trackingIdentifier: null,
    publicHandle: `CP-${randomUUID().toUpperCase()}`,
    authorityContradiction: false,
    observations: {
      create: blankObservation(),
      buy: blankObservation(),
      recovery: blankObservation(),
      void: blankObservation(),
    },
    ratesReturnedCount: 0,
    uspsRatesReturnedCount: 0,
    serviceLevelMatched: false,
    selectedRateAmountCents: null,
    selectedRateCurrency: null,
    refundStatusEchoed: null,
    errorKind: null,
    errorCapability: null,
    publicRecord: null,
  };
}
export function freshState(identity: Identity, key: string, now: string): PrivateState {
  return {
    schemaVersion: "combined-parcel-probe-private-state/v1",
    probeIssue: 6461,
    bodyHash,
    ...identity,
    workflowPath,
    credentialBindingDigest: digest(key),
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + retentionMs).toISOString(),
    checkpoint: "pre-a",
    sequence: 0,
    cases: { [caseIds[0]]: blankCase(), [caseIds[1]]: blankCase() } as Record<CaseId, CaseState>,
    receipts: { "pre-a": null, "post-a": null, "pre-b": null, final: null },
  };
}
const transitions: Record<CasePhase, readonly CasePhase[]> = {
  unattempted: ["attempt-locked"],
  "attempt-locked": ["not-purchased", "purchase-ambiguous", "purchase-confirmed"],
  "purchase-ambiguous": ["not-purchased", "purchase-confirmed", "reconciliation-required"],
  "purchase-confirmed": ["voided", "void-failed", "reconciliation-required"],
  "not-purchased": [],
  voided: [],
  "void-failed": [],
  "reconciliation-required": [],
};
export function transition(c: CaseState, next: CasePhase) {
  requireProbe(transitions[c.phase].includes(next), "illegal-transition");
  c.phase = next;
  c.sequence += 1;
  if (next === "attempt-locked") c.purchaseAttemptCount = 1;
}
function isClean(c: CaseState) {
  return c.phase === "voided" || c.phase === "not-purchased";
}
function validateCase(value: unknown) {
  const c = closed(value, Object.keys(blankCase()));
  requireProbe(oneOf(c.phase, Object.keys(transitions)), "case-phase");
  for (const field of ["purchaseAttemptCount", "createCount", "buyCount", "recoveryCount", "voidCount"])
    requireProbe(integer(c[field], 0, 1), "mutation-count");
  requireProbe(c.purchaseAttemptCount === (c.phase === "unattempted" ? 0 : 1), "attempt-count");
  const phaseSequences: Record<string, readonly number[]> = {
    unattempted: [0],
    "attempt-locked": [1],
    "purchase-ambiguous": [2],
    "purchase-confirmed": [2, 3],
    "not-purchased": [2, 3],
    voided: [3, 4],
    "void-failed": [3, 4],
    "reconciliation-required": [3, 4],
  };
  requireProbe(
    integer(c.sequence, 0, 4) && phaseSequences[String(c.phase)].includes(Number(c.sequence)),
    "case-sequence",
  );
  for (const field of ["lockedRunId", "lockedRunAttempt"])
    requireProbe(c.phase === "unattempted" ? c[field] === null : matches(c[field], /^[1-9]\d*$/), "lock-owner");
  for (const field of [
    "providerShipmentId",
    "providerLabelId",
    "providerRateId",
    "providerRefundId",
    "trackingIdentifier",
  ])
    requireProbe(c[field] === null || matches(c[field], /^[A-Za-z0-9_-]{1,128}$/), "private-correlation");
  requireProbe(matches(c.publicHandle, /^CP-[A-F0-9-]{36}$/), "public-handle");
  requireProbe(typeof c.authorityContradiction === "boolean", "authority-contradiction");
  requireProbe(
    Number(c.buyCount) <= Number(c.createCount) && (c.buyCount === 0 || c.providerShipmentId !== null),
    "buy-without-create",
  );
  requireProbe(
    c.voidCount === 0 || (c.providerShipmentId !== null && (c.buyCount === 1 || c.recoveryCount === 1)),
    "void-without-purchase",
  );
  requireProbe(c.phase !== "voided" || c.voidCount === 1, "void-count");
  requireProbe(
    c.phase !== "unattempted" || [c.createCount, c.buyCount, c.recoveryCount, c.voidCount].every((n) => n === 0),
    "unattempted-mutations",
  );
  const observations = closed(c.observations, ["create", "buy", "recovery", "void"]);
  for (const [operation, raw] of Object.entries(observations)) {
    const o = closed(raw, ["status", "mode", "valid", "purchase"]);
    requireProbe(o.status === null || integer(o.status, 100, 599), "observed-status");
    requireProbe(o.mode === null || oneOf(o.mode, ["test", "production"]), "observed-mode");
    requireProbe(typeof o.valid === "boolean" && oneOf(o.purchase, ["yes", "no", "unknown"]), "observed-facts");
    requireProbe(!o.valid || (integer(o.status, 200, 299) && c.providerShipmentId !== null), "valid-response-proof");
    requireProbe(o.purchase === "unknown" || o.valid === true, "purchase-observation-proof");
    requireProbe(
      c[`${operation}Count`] !== 0 || JSON.stringify(raw) === JSON.stringify(blankObservation()),
      "unobserved-facts",
    );
  }
  const facts = (value as CaseState).observations;
  requireProbe(
    c.phase !== "attempt-locked" || [c.createCount, c.buyCount, c.recoveryCount, c.voidCount].every((n) => n === 0),
    "lock-mutations",
  );
  requireProbe(
    c.phase !== "not-purchased" || (c.voidCount === 0 && (c.buyCount === 0 || facts.recovery.purchase === "no")),
    "no-purchase-proof",
  );
  requireProbe(
    c.phase !== "voided" ||
      (facts.void.valid &&
        oneOf(c.refundStatusEchoed, ["submitted", "refunded"]) &&
        (facts.buy.purchase === "yes" || facts.recovery.purchase === "yes")),
    "void-proof",
  );
  requireProbe(
    integer(c.ratesReturnedCount, 0, 500) &&
      integer(c.uspsRatesReturnedCount, 0, Number(c.ratesReturnedCount)) &&
      typeof c.serviceLevelMatched === "boolean",
    "private-rates",
  );
  requireProbe(
    c.selectedRateAmountCents === null || integer(c.selectedRateAmountCents, 0, 1_000_000),
    "private-amount",
  );
  requireProbe(c.selectedRateCurrency === null || matches(c.selectedRateCurrency, /^[A-Z]{3}$/), "private-currency");
  requireProbe(c.refundStatusEchoed === null || oneOf(c.refundStatusEchoed, refundStatuses), "private-refund");
  requireProbe(c.errorKind === null || oneOf(c.errorKind, ["validation", "capability", "provider"]), "private-error");
  requireProbe(c.errorCapability === null || oneOf(c.errorCapability, capabilities), "private-capability");
  if (c.publicRecord !== null) {
    validatePublicRecord(c.publicRecord);
    requireProbe(
      c.publicRecord.cleanupState === c.phase && c.publicRecord.privateCorrelationReference === c.publicHandle,
      "record-state",
    );
    requireProbe(
      JSON.stringify(c.publicRecord) ===
        JSON.stringify(recordFor(c.publicRecord.caseId, value as CaseState, c.publicRecord.capturedAt)),
      "record-observation-mismatch",
    );
  }
}
export function validateState(
  value: unknown,
  expected: Identity,
  now: string,
  key?: string,
  previous?: PrivateState,
): asserts value is PrivateState {
  const s = closed(value, [
    "schemaVersion",
    "probeIssue",
    "bodyHash",
    "repository",
    "workflowPath",
    "sourceSha",
    "runId",
    "runAttempt",
    "credentialBindingDigest",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "checkpoint",
    "sequence",
    "cases",
    "receipts",
  ]);
  requireProbe(
    s.schemaVersion === "combined-parcel-probe-private-state/v1" &&
      s.probeIssue === 6461 &&
      s.bodyHash === bodyHash &&
      s.workflowPath === workflowPath,
    "private-identity",
  );
  requireProbe(
    s.repository === "chase-sets/chase-sets" &&
      matches(s.sourceSha, /^[a-f0-9]{40}$/) &&
      matches(s.runId, /^[1-9]\d*$/) &&
      matches(s.runAttempt, /^[1-9]\d*$/),
    "private-provenance",
  );
  requireProbe(
    Object.entries(expected).every(([field, v]) => s[field] === v),
    "provenance-mismatch",
  );
  requireProbe(
    matches(s.credentialBindingDigest, /^[a-f0-9]{64}$/) &&
      (key === undefined || s.credentialBindingDigest === digest(key)),
    "credential-continuity",
  );
  requireProbe(
    instant(s.createdAt) && instant(s.updatedAt) && instant(s.expiresAt) && instant(now),
    "private-instants",
  );
  requireProbe(
    Date.parse(s.expiresAt) - Date.parse(s.createdAt) === retentionMs &&
      Date.parse(s.updatedAt) >= Date.parse(s.createdAt) &&
      Date.parse(s.updatedAt) <= Date.parse(now) &&
      Date.parse(now) < Date.parse(s.expiresAt),
    "private-freshness",
  );
  requireProbe(oneOf(s.checkpoint, checkpoints) && integer(s.sequence, 0, 1_000_000), "checkpoint");
  const cases = closed(s.cases, caseIds);
  caseIds.forEach((id) => validateCase(cases[id]));
  const state = value as PrivateState;
  const a = state.cases[caseIds[0]],
    b = state.cases[caseIds[1]];
  requireProbe(state.sequence > 0 && a.phase !== "unattempted", "checkpoint-lock-required");
  if (state.checkpoint === "post-a")
    requireProbe(oneOf(a.phase, cleanupStates) && a.publicRecord !== null, "post-a-completeness");
  if (state.checkpoint === "pre-b" || state.checkpoint === "final")
    requireProbe(isClean(a) && a.publicRecord !== null && b.phase !== "unattempted", "pre-b-completeness");
  if (state.checkpoint === "final")
    requireProbe(oneOf(b.phase, cleanupStates) && b.publicRecord !== null, "final-completeness");
  requireProbe(b.phase === "unattempted" || (isClean(a) && a.publicRecord !== null), "case-a-must-close-first");
  for (const id of caseIds)
    if (state.cases[id].publicRecord) requireProbe(state.cases[id].publicRecord?.caseId === id, "case-record-identity");
  const receipts = closed(s.receipts, checkpoints);
  for (const raw of Object.values(receipts)) {
    if (raw === null) continue;
    const r = closed(raw, ["runId", "runAttempt", "checkpoint", "artifactId", "artifactDigest", "payloadDigest"]);
    requireProbe(
      matches(r.runId, /^[1-9]\d*$/) &&
        matches(r.runAttempt, /^[1-9]\d*$/) &&
        matches(r.artifactId, /^[1-9]\d*$/) &&
        oneOf(r.checkpoint, checkpoints) &&
        matches(r.artifactDigest, /^sha256:[a-f0-9]{64}$/) &&
        matches(r.payloadDigest, /^[a-f0-9]{64}$/),
      "artifact-receipt",
    );
  }
  if (previous) {
    requireProbe(
      state.sequence >= previous.sequence &&
        Date.parse(state.updatedAt) >= Date.parse(previous.updatedAt) &&
        state.createdAt === previous.createdAt &&
        state.expiresAt === previous.expiresAt,
      "checkpoint-rollback",
    );
    for (const id of caseIds) {
      const before = previous.cases[id],
        after = state.cases[id];
      requireProbe(
        after.sequence >= before.sequence && after.purchaseAttemptCount >= before.purchaseAttemptCount,
        "case-rollback",
      );
      requireProbe(after.phase === before.phase || after.sequence > before.sequence, "phase-rollback");
      requireProbe(
        before.phase === "unattempted" ||
          (after.lockedRunId === before.lockedRunId && after.lockedRunAttempt === before.lockedRunAttempt),
        "lock-owner-rollback",
      );
      for (const count of ["createCount", "buyCount", "recoveryCount", "voidCount"] as const)
        requireProbe(after[count] >= before[count], "count-rollback");
      requireProbe(
        !oneOf(before.phase, cleanupStates) || JSON.stringify(before) === JSON.stringify(after),
        "steady-state-mutation",
      );
    }
  }
}

export function guardProvider(env: Environment): { identity: Identity; key: string; phase: Phase } {
  requireProbe(
    env.COMBINED_PARCEL_PROBE_CONFIRM === confirmation && env.COMBINED_PARCEL_PROBE_WORKFLOW_CONFIRM === confirmation,
    "confirmation-required",
  );
  requireProbe(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_JOB === "combined-parcel-probe" &&
      env.COMBINED_PARCEL_PROBE_ENVIRONMENT === "staging",
    "dedicated-staging-job-required",
  );
  requireProbe(
    env.GITHUB_REPOSITORY === "chase-sets/chase-sets" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW_REF === `chase-sets/chase-sets/${workflowPath}@refs/heads/main`,
    "workflow-authority",
  );
  requireProbe(
    matches(env.COMBINED_PARCEL_PROBE_SOURCE_SHA, /^[a-f0-9]{40}$/) &&
      env.COMBINED_PARCEL_PROBE_CHECKED_OUT_SHA === env.COMBINED_PARCEL_PROBE_SOURCE_SHA &&
      env.GITHUB_SHA === env.COMBINED_PARCEL_PROBE_SOURCE_SHA,
    "immutable-source-required",
  );
  requireProbe(env.EASYPOST_MODE === "test" && env.EASYPOST_API_KEY?.startsWith("EZTK"), "test-key-required");
  requireProbe(oneOf(env.COMBINED_PARCEL_PROBE_PHASE, phases), "closed-phase-required");
  requireProbe(
    matches(env.GITHUB_RUN_ID, /^[1-9]\d*$/) && matches(env.GITHUB_RUN_ATTEMPT, /^[1-9]\d*$/),
    "run-identity-required",
  );
  return {
    identity: {
      repository: env.GITHUB_REPOSITORY,
      sourceSha: env.COMBINED_PARCEL_PROBE_SOURCE_SHA,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
    },
    key: env.EASYPOST_API_KEY!,
    phase: env.COMBINED_PARCEL_PROBE_PHASE,
  };
}
export function resumeInput(env: Environment) {
  const runId = env.COMBINED_PARCEL_PROBE_RESUME_RUN_ID ?? "",
    runAttempt = env.COMBINED_PARCEL_PROBE_RESUME_RUN_ATTEMPT ?? "",
    checkpoint = env.COMBINED_PARCEL_PROBE_RESUME_CHECKPOINT ?? "";
  if ([runId, runAttempt, checkpoint].every((v) => v === "")) return null;
  requireProbe(
    matches(runId, /^[1-9]\d*$/) && matches(runAttempt, /^[1-9]\d*$/) && oneOf(checkpoint, checkpoints),
    "explicit-resume-required",
  );
  return { runId, runAttempt, checkpoint };
}

function safeId(value: unknown): string | null {
  return matches(value, /^[A-Za-z0-9_-]{1,128}$/) ? value : null;
}
function projection(c: CaseState, operation: keyof CaseState["observations"], status: number, raw: unknown) {
  const o = c.observations[operation];
  o.status = status;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const body = object(raw);
  o.mode = oneOf(body.mode, ["test", "production"]) ? body.mode : null;
  o.valid = status >= 200 && status < 300 && safeId(body.id) !== null;
  if (!o.valid) return;
  const id = safeId(body.id)!;
  if (c.providerShipmentId !== null && c.providerShipmentId !== id) {
    c.authorityContradiction = true;
    requireProbe(false, "shipment-correlation-mismatch");
  }
  c.providerShipmentId = id;
  const label = body.postage_label && typeof body.postage_label === "object" ? object(body.postage_label) : null;
  o.purchase =
    label && safeId(body.tracking_code) ? "yes" : !body.postage_label && !body.tracking_code ? "no" : "unknown";
  if (label) c.providerLabelId = safeId(label.id);
  if (safeId(body.tracking_code)) c.trackingIdentifier = safeId(body.tracking_code);
  if (operation === "create") {
    requireProbe(Array.isArray(body.rates) && body.rates.length <= 500, "bounded-rates-required");
    const rates = body.rates.map(object);
    const usps = rates.filter((r) => typeof r.carrier === "string" && r.carrier.toLowerCase() === "usps");
    const selected = usps.find((r) => typeof r.service === "string" && r.service.toLowerCase() === "groundadvantage");
    c.ratesReturnedCount = rates.length;
    c.uspsRatesReturnedCount = usps.length;
    c.serviceLevelMatched = !!selected;
    if (selected) {
      c.providerRateId = safeId(selected.id);
      const amount =
        typeof selected.rate === "string" && /^\d+(?:\.\d{1,2})?$/.test(selected.rate)
          ? Math.round(Number(selected.rate) * 100)
          : null;
      c.selectedRateAmountCents = integer(amount, 0, 1_000_000) ? amount : null;
      c.selectedRateCurrency = matches(selected.currency, /^[A-Z]{3}$/) ? selected.currency : null;
    }
  }
  if (operation === "void") {
    c.providerRefundId = id;
    c.refundStatusEchoed = oneOf(body.refund_status, refundStatuses) ? body.refund_status : null;
  }
}
export function observedFetch(c: CaseState, fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requireProbe(url.origin === "https://api.easypost.com" && !url.search && !url.hash, "exact-provider-origin");
    const method = init?.method ?? "GET";
    const shipmentPath = c.providerShipmentId ? `/v2/shipments/${encodeURIComponent(c.providerShipmentId)}` : null;
    const operation =
      method === "POST" && url.pathname === "/v2/shipments"
        ? "create"
        : shipmentPath && url.pathname === `${shipmentPath}/buy` && method === "POST"
          ? "buy"
          : shipmentPath && url.pathname === shipmentPath && method === "GET"
            ? "recovery"
            : shipmentPath && url.pathname === `${shipmentPath}/refund` && method === "POST"
              ? "void"
              : null;
    requireProbe(operation !== null, "exact-operation-required");
    const field = `${operation}Count` as const;
    requireProbe(c[field] === 0 && c.purchaseAttemptCount === 1, "at-most-once-operation");
    if (operation === "buy")
      requireProbe(
        c.observations.create.mode !== "production" && !c.authorityContradiction,
        "contradictory-create-authority",
      );
    c[field] = 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(input, { ...init, signal: controller.signal });
          requireProbe(!controller.signal.aborted, "provider-deadline");
          c.observations[operation].status = response.status;
          const text = await response.text();
          requireProbe(!controller.signal.aborted, "provider-deadline");
          let raw: unknown = null;
          try {
            raw = JSON.parse(text);
          } catch {
            /* Unparseable authority is a non-answer. */
          }
          projection(c, operation, response.status, raw);
          return new Response(text, { status: response.status });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("provider-deadline"));
          }, 30_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
function recordFor(id: CaseId, c: CaseState, now: string): PublicRecord {
  requireProbe(oneOf(c.phase, cleanupStates), "cleanup-required");
  const observations = [
    c.observations.create,
    ...(c.buyCount ? [c.observations.buy] : []),
    ...(c.recoveryCount ? [c.observations.recovery] : []),
  ];
  const authoritative = c.recoveryCount
    ? c.observations.recovery
    : c.buyCount
      ? c.observations.buy
      : c.observations.create;
  const modes = observations.filter((o) => o.status !== null).map((o) => o.mode);
  const mode: Mode =
    modes.includes("production") || c.observations.void.mode === "production"
      ? "production"
      : authoritative.mode === "test" && !modes.includes(null)
        ? "test"
        : null;
  const purchased = c.observations.buy.purchase === "yes" || c.observations.recovery.purchase === "yes";
  const answered = mode === "test" && !c.authorityContradiction;
  const refused =
    (c.errorKind === "provider" && authoritative.status !== null && authoritative.status >= 400) ||
    (c.errorKind === "capability" &&
      oneOf(c.errorCapability, ["usps-rate", "usps-service-level"]) &&
      c.observations.create.valid);
  const outcome =
    answered && purchased && !c.errorKind
      ? "accepted"
      : answered && c.phase === "not-purchased" && refused
        ? "rejected"
        : authoritative.status === null
          ? "transport-error"
          : "inconclusive";
  const record: PublicRecord = {
    schemaVersion: "combined-parcel-probe-evidence/v1",
    probeIssue: 6461,
    caseId: id,
    capturedAt: now,
    outcome,
    providerName: "easypost",
    providerModeEchoed: mode,
    requestedServiceLevel: "GroundAdvantage",
    syntheticReference: reference(id),
    memberCount: 2,
    parcel: { ...parcel },
    declaredInsuranceAmount: id === caseIds[1] ? "600.00" : null,
    ratesReturnedCount: c.ratesReturnedCount,
    uspsRatesReturnedCount: c.uspsRatesReturnedCount,
    serviceLevelMatched: c.serviceLevelMatched,
    selectedRateAmountCents: c.selectedRateAmountCents,
    selectedRateCurrency: c.selectedRateCurrency,
    httpStatus: authoritative.status,
    errorKind: c.errorKind,
    errorCapability: c.errorCapability,
    errorReasonCategory: null,
    errorReasonCategoryAssignedBy: null,
    purchaseAttemptCount: 1,
    cleanupState: c.phase,
    refundStatusEchoed: c.refundStatusEchoed,
    addressFixture: "synthetic-carrier-test-fixture",
    privateCorrelationReference: c.publicHandle,
    redactionControlPassed: true,
  };
  validatePublicRecord(record);
  return record;
}
function retainError(c: CaseState, error: unknown) {
  c.errorKind = error instanceof PostageLabelProviderError ? error.kind : "provider";
  c.errorCapability = error instanceof PostageLabelProviderError ? error.capability : null;
}
export async function runCase(
  state: PrivateState,
  id: CaseId,
  identity: Identity,
  key: string,
  fetchImpl: typeof fetch,
  now: string,
) {
  validateState(state, identity, now, key);
  const c = state.cases[id];
  if (oneOf(c.phase, cleanupStates)) return;
  requireProbe(c.phase !== "unattempted", "durable-lock-required");
  const isNewLock =
    c.phase === "attempt-locked" &&
    c.lockedRunId === identity.runId &&
    c.lockedRunAttempt === identity.runAttempt &&
    c.createCount === 0;
  const provider = createEasyPostPostageLabelProvider({
    apiKey: key,
    mode: "test",
    fetch: observedFetch(c, fetchImpl),
  });
  if (isNewLock) {
    try {
      await provider.purchaseUspsLabel(caseRequest(id));
      transition(c, "purchase-confirmed");
    } catch (error) {
      retainError(c, error);
      transition(c, c.buyCount === 0 ? "not-purchased" : "purchase-ambiguous");
    }
  } else if (c.phase === "attempt-locked") transition(c, "purchase-ambiguous");
  if (c.phase === "purchase-ambiguous") {
    if (!c.providerShipmentId || c.recoveryCount !== 0 || c.authorityContradiction)
      transition(c, "reconciliation-required");
    else {
      try {
        const recovered = await provider.recoverPurchasedUspsLabel!({ idempotencyKey: c.providerShipmentId });
        if (recovered && c.observations.recovery.purchase === "yes") {
          c.errorKind = null;
          c.errorCapability = null;
          transition(c, "purchase-confirmed");
        } else
          transition(
            c,
            c.observations.recovery.valid &&
              c.observations.recovery.purchase === "no" &&
              c.observations.buy.purchase !== "yes"
              ? "not-purchased"
              : "reconciliation-required",
          );
      } catch {
        transition(c, "reconciliation-required");
      }
    }
  }
  if (c.phase === "purchase-confirmed") {
    if (!c.providerShipmentId || c.voidCount !== 0) transition(c, "reconciliation-required");
    else {
      try {
        await provider.voidLabel({
          providerShipmentId: c.providerShipmentId,
          providerLabelId: c.providerLabelId ?? c.providerShipmentId,
          trackingIdentifier: c.trackingIdentifier ?? "",
        });
        transition(
          c,
          c.observations.void.valid && oneOf(c.refundStatusEchoed, ["submitted", "refunded"])
            ? "voided"
            : "void-failed",
        );
      } catch {
        transition(c, "void-failed");
      }
    }
  }
  c.publicRecord = recordFor(id, c, now);
}
function lockCase(state: PrivateState, id: CaseId, identity: Identity) {
  const c = state.cases[id];
  if (c.phase !== "unattempted") return;
  if (id === caseIds[1])
    requireProbe(isClean(state.cases[caseIds[0]]) && state.cases[caseIds[0]].publicRecord, "case-a-cleanup-required");
  transition(c, "attempt-locked");
  c.lockedRunId = identity.runId;
  c.lockedRunAttempt = identity.runAttempt;
}

export const privateArtifactName = (runId: string, attempt: string, checkpoint: Checkpoint) =>
  `combined-parcel-probe-private-${runId}-${attempt}-${checkpoint}`;
export const publicArtifactName = (runId: string, attempt: string) =>
  `combined-parcel-probe-public-${runId}-${attempt}`;
export type UploadedRecord = { payload: string; receipt: Receipt };
export function validateUploadedRecord(
  uploaded: UploadedRecord,
  expected: Identity,
  checkpoint: Checkpoint,
  now: string,
  localPayload?: string,
): PrivateState {
  requireProbe(
    uploaded.receipt.runId === expected.runId &&
      uploaded.receipt.runAttempt === expected.runAttempt &&
      uploaded.receipt.checkpoint === checkpoint &&
      uploaded.receipt.payloadDigest === digest(uploaded.payload),
    "uploaded-record-binding",
  );
  requireProbe(localPayload === undefined || uploaded.payload === localPayload, "download-differs-from-upload");
  const state: unknown = JSON.parse(uploaded.payload);
  validateState(state, expected, now);
  requireProbe(state.checkpoint === checkpoint, "checkpoint-stage-mismatch");
  state.receipts[checkpoint] = uploaded.receipt;
  return state;
}
export async function executePhase(input: {
  env: Environment;
  now: string;
  fetch: typeof fetch;
  resume?: UploadedRecord;
  uploaded?: Partial<Record<Checkpoint, UploadedRecord>>;
  local?: Partial<Record<Checkpoint, string>>;
  write: (checkpoint: Checkpoint, payload: string) => Promise<void>;
  publish: (payload: string) => Promise<void>;
}) {
  const { identity, key, phase } = guardProvider(input.env);
  const resume = resumeInput(input.env);
  let state: PrivateState;
  if (phase === "pre-a") {
    if (resume) {
      requireProbe(input.resume, "resume-artifact-required");
      state = validateUploadedRecord(
        input.resume,
        { ...identity, runId: resume.runId, runAttempt: resume.runAttempt },
        resume.checkpoint,
        input.now,
      );
      requireProbe(state.credentialBindingDigest === digest(key), "credential-continuity");
      state.runId = identity.runId;
      state.runAttempt = identity.runAttempt;
    } else {
      requireProbe(!input.resume, "unsolicited-resume");
      state = freshState(identity, key, input.now);
    }
  } else {
    const stage = phase === "case-a-pre-b" ? "pre-a" : "pre-b";
    const uploaded = input.uploaded?.[stage];
    requireProbe(uploaded && input.local?.[stage], "uploaded-pre-lock-required");
    state = validateUploadedRecord(uploaded, identity, stage, input.now, input.local[stage]);
    validateState(state, identity, input.now, key);
    if (phase === "case-b") {
      const postA = input.uploaded?.["post-a"];
      requireProbe(postA && input.local?.["post-a"], "uploaded-post-a-required");
      const previous = validateUploadedRecord(postA, identity, "post-a", input.now, input.local["post-a"]);
      validateState(state, identity, input.now, key, previous);
      requireProbe(
        JSON.stringify(previous.cases[caseIds[0]]) === JSON.stringify(state.cases[caseIds[0]]),
        "post-a-carry-forward",
      );
      state.receipts["post-a"] = postA.receipt;
    }
  }
  const checkpoint = async (stage: Checkpoint) => {
    state.checkpoint = stage;
    state.sequence += 1;
    state.updatedAt = input.now;
    validateState(state, identity, input.now, key);
    await input.write(stage, json(state));
  };
  if (phase === "pre-a") {
    lockCase(state, caseIds[0], identity);
    await checkpoint("pre-a");
    return;
  }
  if (phase === "case-a-pre-b") {
    await runCase(state, caseIds[0], identity, key, input.fetch, input.now);
    await checkpoint("post-a");
    requireProbe(
      isClean(state.cases[caseIds[0]]) &&
        state.cases[caseIds[0]].publicRecord &&
        state.cases[caseIds[0]].publicRecord?.providerModeEchoed !== "production",
      "blocked-case-a",
    );
    lockCase(state, caseIds[1], identity);
    await checkpoint("pre-b");
    return;
  }
  await runCase(state, caseIds[1], identity, key, input.fetch, input.now);
  await checkpoint("final");
  const records = caseIds.map((id) => state.cases[id].publicRecord);
  validatePublicEvidence(records);
  await input.publish(json(records));
}

// The operator supplies these fields in #6461 after landing, never in #7160.
export const operatorHandoff = {
  schemaVersion: "combined-parcel-probe-handoff/v1",
  probeIssue: 6461,
  bodyHash,
  workflowPath,
  confirmation,
  jobId: "combined-parcel-probe",
  permissions: { contents: "read", actions: "read" },
  phases,
  focusedCommand,
  resumeInputs: [
    "combined_parcel_probe_resume_run_id",
    "combined_parcel_probe_resume_run_attempt",
    "combined_parcel_probe_resume_checkpoint",
  ],
  checkpoints,
  privateFilename,
  publicFilename,
  privateSchema: "combined-parcel-probe-private-state/v1",
  publicSchema: "combined-parcel-probe-evidence/v1",
  retentionDays: 30,
  privateArtifactPattern: "combined-parcel-probe-private-${runId}-${runAttempt}-${checkpoint}",
  publicArtifactPattern: "combined-parcel-probe-public-${runId}-${runAttempt}",
  provenanceFields: [
    "repository",
    "workflowPath",
    "sourceSha",
    "runId",
    "runAttempt",
    "bodyHash",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "credentialBindingDigest",
  ],
  operatorEvidenceFields: [
    "immutableSourceSha",
    "workflowPath",
    "approvalIdentity",
    "approvalUrl",
    "runId",
    "runAttempt",
    "runUrl",
    "jobId",
    "jobUrl",
    "jobConclusion",
    "executedSteps",
    "resumeInputs",
    "checkpoint",
    "privateArtifactId",
    "privateArtifactName",
    "privateArtifactDigest",
    "privatePayloadDigest",
    "privateProvenance",
    "privateExpiry",
    "downloadResult",
    "reconciliationResult",
    "credentialContinuityResult",
    "uninsuredCleanup",
    "insuredCleanup",
    "publicArtifactId",
    "publicArtifactName",
    "publicArtifactDigest",
    "finalRedactedEvidenceUrl",
    "redactedCommentUrl",
    "issue6462HandoffUrl",
  ],
  cleanupStates,
  reconciliationStates: ["purchase-ambiguous", "reconciliation-required", "void-failed"],
  liveValues: null,
} as const;

async function readPayload(directory: string) {
  requireProbe(
    JSON.stringify((await readdir(directory)).sort()) === JSON.stringify([privateFilename]),
    "single-private-payload-required",
  );
  return readFile(join(directory, privateFilename), "utf8");
}
export async function validateArtifact(input: {
  identity: Identity;
  checkpoint: Checkpoint;
  directory: string;
  now: string;
  token: string;
  artifactId?: string;
  artifactDigest?: string;
  localPayload?: string;
  fetch: typeof fetch;
  archivePayload: (bytes: Uint8Array) => Promise<string>;
}): Promise<UploadedRecord> {
  const { identity } = input;
  requireProbe(
    identity.repository === "chase-sets/chase-sets" &&
      matches(identity.runId, /^[1-9]\d*$/) &&
      matches(identity.runAttempt, /^[1-9]\d*$/),
    "artifact-identity",
  );
  const base = `https://api.github.com/repos/${identity.repository}`;
  const get = async (path: string) => {
    const response = await input.fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    requireProbe(
      response.ok && !response.headers.get("link")?.includes('rel="next"'),
      "github-exact-authority-unavailable",
    );
    return object(await response.json());
  };
  const run = await get(`/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`);
  requireProbe(
    run.id === Number(identity.runId) &&
      run.run_attempt === Number(identity.runAttempt) &&
      run.path === workflowPath &&
      run.head_sha === identity.sourceSha &&
      object(run.repository).full_name === identity.repository &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main",
    "artifact-run-provenance",
  );
  const name = privateArtifactName(identity.runId, identity.runAttempt, input.checkpoint);
  if (!input.artifactId) {
    const current = await get(`/actions/runs/${identity.runId}`);
    requireProbe(
      run.status === "completed" && current.run_attempt === Number(identity.runAttempt),
      "resume-attempt-not-quiescent",
    );
    // Check only named successors; never discover or select a latest checkpoint.
    for (const successor of checkpoints.slice(checkpoints.indexOf(input.checkpoint) + 1)) {
      const successorName = privateArtifactName(identity.runId, identity.runAttempt, successor);
      const later = await get(
        `/actions/runs/${identity.runId}/artifacts?name=${encodeURIComponent(successorName)}&per_page=100`,
      );
      requireProbe(
        later.total_count === 0 && Array.isArray(later.artifacts) && later.artifacts.length === 0,
        "resume-checkpoint-rollback",
      );
    }
  }
  let artifact: JsonObject;
  if (input.artifactId) {
    requireProbe(matches(input.artifactId, /^[1-9]\d*$/), "artifact-id");
    requireProbe(matches(input.artifactDigest, /^(?:sha256:)?[a-f0-9]{64}$/), "upload-digest-required");
    artifact = await get(`/actions/artifacts/${input.artifactId}`);
  } else {
    const list = await get(`/actions/runs/${identity.runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
    requireProbe(
      list.total_count === 1 && Array.isArray(list.artifacts) && list.artifacts.length === 1,
      "one-exact-artifact-required",
    );
    artifact = object(list.artifacts[0]);
  }
  requireProbe(
    artifact.name === name &&
      integer(artifact.id, 1, Number.MAX_SAFE_INTEGER) &&
      (!input.artifactId || artifact.id === Number(input.artifactId)) &&
      artifact.expired === false &&
      object(artifact.workflow_run).id === Number(identity.runId),
    "artifact-provenance",
  );
  requireProbe(
    instant(artifact.expires_at) &&
      Date.parse(artifact.expires_at) > Date.parse(input.now) &&
      matches(artifact.digest, /^sha256:[a-f0-9]{64}$/),
    "artifact-expired-or-digest-missing",
  );
  requireProbe(
    !input.artifactDigest || artifact.digest === `sha256:${input.artifactDigest.replace(/^sha256:/, "")}`,
    "upload-digest-mismatch",
  );
  const archive = await input.fetch(`${base}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  requireProbe(archive.ok, "archive-unavailable");
  const bytes = new Uint8Array(await archive.arrayBuffer());
  requireProbe(`sha256:${digest(bytes)}` === artifact.digest, "archive-digest-mismatch");
  const payload = await readPayload(input.directory);
  requireProbe((await input.archivePayload(bytes)) === payload, "archive-payload-mismatch");
  const uploaded = {
    payload,
    receipt: {
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      checkpoint: input.checkpoint,
      artifactId: String(artifact.id),
      artifactDigest: artifact.digest,
      payloadDigest: digest(payload),
    },
  };
  validateUploadedRecord(uploaded, identity, input.checkpoint, input.now, input.localPayload);
  return uploaded;
}
const rootDirectory = (env: Environment) => {
  requireProbe(env.GITHUB_WORKSPACE, "workspace-required");
  return join(env.GITHUB_WORKSPACE, "artifacts", "combined-parcel-probe");
};
export async function runOperatorPhase(env: Environment) {
  const { phase } = guardProvider(env);
  const root = rootDirectory(env);
  const uploaded: Partial<Record<Checkpoint, UploadedRecord>> = {},
    local: Partial<Record<Checkpoint, string>> = {};
  const readReceipt = async (stage: string): Promise<UploadedRecord> => {
    const receipt = JSON.parse(await readFile(join(root, `${stage}-receipt.json`), "utf8")) as Receipt;
    const payload = await readPayload(join(root, `download-${stage}`));
    return { receipt, payload };
  };
  if (phase !== "pre-a")
    for (const stage of phase === "case-a-pre-b" ? (["pre-a"] as const) : (["post-a", "pre-b"] as const)) {
      uploaded[stage] = await readReceipt(stage);
      local[stage] = await readPayload(join(root, stage));
    }
  await executePhase({
    env,
    now: new Date().toISOString(),
    fetch: globalThis.fetch,
    ...(phase === "pre-a" && resumeInput(env) ? { resume: await readReceipt("resume") } : {}),
    uploaded,
    local,
    write: async (stage, payload) => {
      await mkdir(join(root, stage), { recursive: true });
      await writeFile(join(root, stage, privateFilename), payload, { mode: 0o600 });
    },
    publish: async (payload) => {
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, "public", publicFilename), payload);
    },
  });
}
async function validateOperatorArtifact(env: Environment, stage: string) {
  requireProbe(env.EASYPOST_API_KEY === "", "validation-must-shadow-key");
  const resume = stage === "resume" ? resumeInput(env) : null;
  const checkpoint = resume?.checkpoint ?? stage;
  requireProbe(oneOf(checkpoint, checkpoints), "validation-checkpoint");
  const root = rootDirectory(env);
  const identity = {
    repository: env.GITHUB_REPOSITORY ?? "",
    sourceSha: env.COMBINED_PARCEL_PROBE_SOURCE_SHA ?? "",
    runId: resume?.runId ?? env.GITHUB_RUN_ID ?? "",
    runAttempt: resume?.runAttempt ?? env.GITHUB_RUN_ATTEMPT ?? "",
  };
  const uploaded = await validateArtifact({
    identity,
    checkpoint,
    directory: join(root, `download-${stage}`),
    now: new Date().toISOString(),
    token: env.GH_TOKEN ?? "",
    fetch: globalThis.fetch,
    artifactId: env.COMBINED_PARCEL_PROBE_ARTIFACT_ID,
    artifactDigest: env.COMBINED_PARCEL_PROBE_ARTIFACT_DIGEST,
    localPayload: stage === "resume" ? undefined : await readPayload(join(root, stage)),
    archivePayload: async (bytes) => {
      const archive = join(root, `${stage}.zip`);
      await writeFile(archive, bytes, { mode: 0o600 });
      const names = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .trim()
        .split("\n");
      requireProbe(names.length === 1 && names[0] === privateFilename, "single-archive-payload-required");
      return execFileSync("unzip", ["-p", archive, privateFilename], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
  });
  await writeFile(join(root, `${stage}-receipt.json`), json(uploaded.receipt), { mode: 0o600 });
  if (stage === "final") {
    const state: unknown = JSON.parse(uploaded.payload);
    validateState(state, identity, new Date().toISOString());
    const records = caseIds.map((id) => state.cases[id].publicRecord);
    validatePublicEvidence(records);
    requireProbe(
      (await readFile(join(root, "public", publicFilename), "utf8")) === json(records),
      "canonical-public-payload",
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateOperatorArtifact(process.env, process.argv[2] ?? "").catch(() => {
    process.stderr.write("combined-parcel-probe: artifact-validation-blocked\n");
    process.exitCode = 1;
  });
}
