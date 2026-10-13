import { OutboundSyncError } from "./contracts";
import { assertRfc3339Instant } from "../../connections/domain/validation";
import {
  assertOrderPullCheckpoint,
  assertOrderPullChunk,
  assertOrderPullPredecessor,
  assertOrderPullProgress,
  assertOrderPullWork,
  assertOrderPullSelector as assertSelector,
  type OrderPullCheckpoint,
  type OrderPullPredecessor,
  type OrderPullProgress,
  type OrderPullWork,
} from "./order-pull-progress-codec";

/**
 * Channel Order Pull: one connection-subject Channel Outbound Operation that asks a capable connector to
 * advance a bounded traversal under the `ready-to-ship-intake/v2` completeness law.
 * The executor derives every wire value from the qualified capture; the payload carries identities,
 * versions and bounds only.
 */
export const orderPullOperationKind = "tcgplayer-order-pull" as const;
export const orderPullLawVersion = "ready-to-ship-intake/v2" as const;
export const orderPullProviderKey = "tcgplayer" as const;

/** The unchanged pull deadline and lease margin every worst-case budget must fit. */
export const ORDER_PULL_DEADLINE_MS = 600_000;
export const ORDER_PULL_LEASE_MARGIN_MS = 30_000;

const maxBoundValue = 10_000;

export const orderPullUnknownReasons = [
  "authority-unavailable",
  "completeness-unproven",
  "budget-exceeded",
  "session-lost",
  "admission-ambiguous",
  "recovery-content-changed",
] as const;
export type OrderPullUnknownReason = (typeof orderPullUnknownReasons)[number];

export const orderPullAbandonReasons = ["released", "claimant-cancelled"] as const;

export type OrderPullSelectorBinding = Readonly<{
  identity: string;
  version: number;
  pageSize: number;
  traversal: "snapshot-cursor" | "keyset-frontier";
}>;

/** Governed bound and qualified-selector authority. Absent or malformed authority denies scheduling. */
export type OrderPullAuthority = Readonly<{
  revision: number;
  lawVersion: typeof orderPullLawVersion;
  selector: OrderPullSelectorBinding;
  nIntakeReadMax: number;
  nListReadMax: number;
  fMax: number;
  providerCadenceMs: number;
  providerCallTimeoutMs: number;
  mappingJournalMs: number;
  maxPostsPerOrder: number;
  postTimeoutMs: number;
  reportTimeoutMs: number;
}>;

/** Governed envelope only; revision and captured selector authority are still required. */
export const tcgplayerOrderPullGovernedBounds = Object.freeze({
  lawVersion: "ready-to-ship-intake/v2",
  nIntakeReadMax: 8,
  nListReadMax: 2,
  fMax: 5,
  providerCadenceMs: 10_000,
  providerCallTimeoutMs: 10_000,
  mappingJournalMs: 20_000,
  maxPostsPerOrder: 4,
  postTimeoutMs: 5_000,
  reportTimeoutMs: 10_000,
} satisfies Omit<OrderPullAuthority, "revision" | "selector">);

export type OrderPullBounds = Readonly<{
  nIntakeReadMax: number;
  nListReadMax: number;
  fMax: number;
  plan: OrderPullPlan;
  providerCalls: number;
  providerCadenceMs: number;
  maxObservationPosts: number;
  budgetMs: number;
}>;
export type OrderPullPlan = Readonly<{ listReads: number; intakeReads: number; followUpReads: number }>;

export type OrderPullPayload = Readonly<{
  kind: "order-pull";
  version: 2;
  connectionId: string;
  pullId: string;
  policyRevision: number;
  lawVersion: typeof orderPullLawVersion;
  selector: OrderPullSelectorBinding;
  bounds: OrderPullBounds;
  followUpReferences: readonly string[];
  checkpoint: OrderPullCheckpoint;
  checkpointDigest: string;
  work: OrderPullWork;
  predecessor: OrderPullPredecessor | null;
  providerNotBefore: string;
}>;

export type OrderPullAdmissionCounts = Readonly<{
  readyToShipMembers: number;
  followUpReads: number;
  admitted: number;
}>;

export type ClaimedOrderPullOutcome = Readonly<{
  operationKind: typeof orderPullOperationKind;
  operationId: string;
  attemptId: string;
  claimGeneration: number;
  pullId: string;
  payloadDigest: string;
  outcome:
    | Readonly<{
        kind: "order-pull-complete" | "continuation-required" | "order-pull-pending" | "order-pull-gaps";
        lawVersion: typeof orderPullLawVersion;
        selector: OrderPullSelectorBinding;
        admissionCounts: OrderPullAdmissionCounts;
        progress: OrderPullProgress;
      }>
    | Readonly<{ kind: "order-pull-unknown"; reason: OrderPullUnknownReason }>
    | Readonly<{ kind: "abandoned"; reason: (typeof orderPullAbandonReasons)[number] }>;
}>;

export type OrderPullBudgetDecision =
  | Readonly<{ kind: "fits"; authority: OrderPullAuthority; bounds: OrderPullBounds; providerCalls: number }>
  | Readonly<{ kind: "refused"; reason: "authority-unknown" | "over-deadline" }>;

/** Budget the allocated work, never the account population or sum of independent maxima. */
export function resolveOrderPullBudget(authority: unknown, plan?: OrderPullPlan): OrderPullBudgetDecision {
  try {
    assertOrderPullAuthority(authority);
    if (plan) assertPlan(plan, authority);
  } catch {
    return { kind: "refused", reason: "authority-unknown" };
  }
  const allocated = plan ?? { listReads: 1, intakeReads: authority.nIntakeReadMax, followUpReads: authority.fMax };
  const detailReads = allocated.intakeReads + allocated.followUpReads;
  const providerCalls = 1 + allocated.listReads + detailReads;
  const maxObservationPosts = detailReads * authority.maxPostsPerOrder;
  const budgetMs =
    providerCalls * (authority.providerCadenceMs + authority.providerCallTimeoutMs) +
    authority.mappingJournalMs +
    maxObservationPosts * authority.postTimeoutMs +
    authority.reportTimeoutMs;
  if (!Number.isSafeInteger(budgetMs) || budgetMs > ORDER_PULL_DEADLINE_MS) {
    return { kind: "refused", reason: "over-deadline" };
  }
  return {
    kind: "fits",
    authority,
    providerCalls,
    bounds: {
      nIntakeReadMax: authority.nIntakeReadMax,
      nListReadMax: authority.nListReadMax,
      fMax: authority.fMax,
      plan: allocated,
      providerCalls,
      providerCadenceMs: authority.providerCadenceMs,
      maxObservationPosts,
      budgetMs,
    },
  };
}

/** Keep the follow-up reservation while reducing intake until this allocation fits. */
export function allocateOrderPullBudget(
  authority: unknown,
  listReads: number,
  followUpReads: number,
): OrderPullBudgetDecision {
  try {
    assertOrderPullAuthority(authority);
  } catch {
    return { kind: "refused", reason: "authority-unknown" };
  }
  for (let intakeReads = authority.nIntakeReadMax; intakeReads >= 0; intakeReads--) {
    const decision = resolveOrderPullBudget(authority, { listReads, intakeReads, followUpReads });
    if (decision.kind === "fits" || decision.reason === "authority-unknown") return decision;
  }
  return { kind: "refused", reason: "over-deadline" };
}

/** `now + budget + 30 s < leaseExpiresAt`; a pull that cannot finish inside its lease is never dispatched. */
export function orderPullFitsLease(input: Readonly<{ budgetMs: number; at: string; leaseExpiresAt: string }>): boolean {
  const at = Date.parse(input.at);
  const expires = Date.parse(input.leaseExpiresAt);
  return (
    Number.isFinite(at) &&
    Number.isFinite(expires) &&
    Number.isSafeInteger(input.budgetMs) &&
    at + input.budgetMs + ORDER_PULL_LEASE_MARGIN_MS < expires
  );
}

export function assertOrderPullAuthority(value: unknown): asserts value is OrderPullAuthority {
  const authority = closed(
    value,
    [
      "revision",
      "lawVersion",
      "selector",
      "nIntakeReadMax",
      "nListReadMax",
      "fMax",
      "providerCadenceMs",
      "providerCallTimeoutMs",
      "mappingJournalMs",
      "maxPostsPerOrder",
      "postTimeoutMs",
      "reportTimeoutMs",
    ],
    "order-pull authority",
    true,
  );
  integer(authority.revision, 1, Number.MAX_SAFE_INTEGER, "revision");
  if (authority.lawVersion !== orderPullLawVersion) invalid("lawVersion is not the bound intake law.");
  assertSelector(authority.selector);
  integer(authority.nIntakeReadMax, 1, maxBoundValue, "nIntakeReadMax");
  integer(authority.nListReadMax, 1, 2, "nListReadMax");
  integer(authority.fMax, 0, maxBoundValue, "fMax");
  integer(authority.providerCadenceMs, 1, ORDER_PULL_DEADLINE_MS, "providerCadenceMs");
  integer(authority.providerCallTimeoutMs, 1, ORDER_PULL_DEADLINE_MS, "providerCallTimeoutMs");
  integer(authority.mappingJournalMs, 0, ORDER_PULL_DEADLINE_MS, "mappingJournalMs");
  integer(authority.maxPostsPerOrder, 1, 16, "maxPostsPerOrder");
  integer(authority.postTimeoutMs, 1, ORDER_PULL_DEADLINE_MS, "postTimeoutMs");
  integer(authority.reportTimeoutMs, 1, ORDER_PULL_DEADLINE_MS, "reportTimeoutMs");
}

export function assertOrderPullPayloadStructure(value: unknown): asserts value is OrderPullPayload {
  const payload = closed(
    value,
    [
      "kind",
      "version",
      "connectionId",
      "pullId",
      "policyRevision",
      "lawVersion",
      "selector",
      "bounds",
      "followUpReferences",
      "checkpoint",
      "checkpointDigest",
      "work",
      "predecessor",
      "providerNotBefore",
    ],
    "order-pull payload",
    true,
  );
  if (payload.kind !== "order-pull" || payload.version !== 2) invalid("order-pull payload kind/version is invalid.");
  opaque(payload.connectionId, "connectionId");
  pullId(payload.pullId);
  integer(payload.policyRevision, 1, Number.MAX_SAFE_INTEGER, "policyRevision");
  if (payload.lawVersion !== orderPullLawVersion) invalid("lawVersion is not the bound intake law.");
  assertSelector(payload.selector);
  const bounds = closed(
    payload.bounds,
    [
      "nIntakeReadMax",
      "nListReadMax",
      "fMax",
      "plan",
      "providerCalls",
      "providerCadenceMs",
      "maxObservationPosts",
      "budgetMs",
    ],
    "bounds",
    true,
  );
  integer(bounds.nIntakeReadMax, 1, maxBoundValue, "nIntakeReadMax");
  integer(bounds.nListReadMax, 1, 2, "nListReadMax");
  integer(bounds.fMax, 0, maxBoundValue, "fMax");
  assertPlan(bounds.plan, bounds as OrderPullBounds);
  integer(bounds.providerCalls, 1, 2 * maxBoundValue + 3, "providerCalls");
  integer(bounds.providerCadenceMs, 1, ORDER_PULL_DEADLINE_MS, "providerCadenceMs");
  if (bounds.providerCalls !== 1 + bounds.plan.listReads + bounds.plan.intakeReads + bounds.plan.followUpReads)
    invalid("Provider count does not match allocation.");
  integer(bounds.maxObservationPosts, 0, 16 * 2 * maxBoundValue, "maxObservationPosts");
  integer(bounds.budgetMs, 1, ORDER_PULL_DEADLINE_MS, "budgetMs");
  const references = payload.followUpReferences;
  if (!Array.isArray(references) || references.length > Number(bounds.fMax)) {
    invalid("followUpReferences must hold 0..F_max references.");
  }
  assertOrderPullChunk(payload.connectionId, references);
  if (references.length > bounds.plan.followUpReads) invalid("Follow-ups exceed the allocated reservation.");
  assertOrderPullCheckpoint(payload.checkpoint);
  assertSelector(payload.checkpoint.selector);
  if (
    payload.checkpoint.policyRevision !== payload.policyRevision ||
    !sameSelector(payload.checkpoint.selector, payload.selector) ||
    typeof payload.checkpointDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.checkpointDigest) ||
    payload.checkpoint.drained
  )
    invalid("Checkpoint binding mismatch.");
  assertOrderPullWork(payload.work, payload.connectionId);
  assertOrderPullPredecessor(payload.predecessor);
  assertRfc3339Instant(payload.providerNotBefore);
  if (payload.predecessor && payload.predecessor.checkpointDigest !== payload.checkpointDigest)
    invalid("Predecessor checkpoint mismatch.");
}

export function assertClaimedOrderPullOutcome(value: unknown): asserts value is ClaimedOrderPullOutcome {
  const report = closed(
    value,
    ["operationKind", "operationId", "attemptId", "claimGeneration", "pullId", "payloadDigest", "outcome"],
    "order-pull outcome",
    true,
  );
  if (report.operationKind !== orderPullOperationKind) invalid("operationKind is invalid.");
  opaque(report.operationId, "operationId");
  opaque(report.attemptId, "attemptId");
  integer(report.claimGeneration, 1, Number.MAX_SAFE_INTEGER, "claimGeneration");
  pullId(report.pullId);
  if (typeof report.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(report.payloadDigest)) {
    invalid("payloadDigest must be a lowercase SHA-256 digest.");
  }
  assertOrderPullOutcomeBody(report.outcome);
}

/** The closed outcome body; persisted terminal outcomes are re-validated with the same codec on read. */
export function assertOrderPullOutcomeBody(value: unknown): asserts value is ClaimedOrderPullOutcome["outcome"] {
  const outcome = closed(
    value,
    ["kind", "lawVersion", "selector", "admissionCounts", "progress", "reason"],
    "order-pull outcome.outcome",
  );
  switch (outcome.kind) {
    case "continuation-required":
    case "order-pull-pending":
    case "order-pull-gaps":
    case "order-pull-complete": {
      closed(
        outcome,
        ["kind", "lawVersion", "selector", "admissionCounts", "progress"],
        "order-pull outcome.outcome",
        true,
      );
      if (outcome.lawVersion !== orderPullLawVersion) invalid("complete lawVersion is invalid.");
      assertSelector(outcome.selector);
      const counts = closed(
        outcome.admissionCounts,
        ["readyToShipMembers", "followUpReads", "admitted"],
        "admissionCounts",
        true,
      );
      integer(counts.readyToShipMembers, 0, maxBoundValue, "readyToShipMembers");
      integer(counts.followUpReads, 0, maxBoundValue, "followUpReads");
      integer(counts.admitted, 0, 16 * 2 * maxBoundValue, "admitted");
      assertOrderPullProgress(outcome.progress);
      return;
    }
    case "order-pull-unknown":
      closed(outcome, ["kind", "reason"], "order-pull outcome.outcome", true);
      if (!orderPullUnknownReasons.includes(outcome.reason as never)) invalid("unknown reason is invalid.");
      return;
    case "abandoned":
      closed(outcome, ["kind", "reason"], "order-pull outcome.outcome", true);
      if (!orderPullAbandonReasons.includes(outcome.reason as never)) invalid("abandonment reason is invalid.");
      return;
    default:
      invalid("order-pull outcome kind is invalid.");
  }
}

/** Binds a closed outcome to the exact payload the claimant received. */
export function assertOrderPullOutcomeMatchesPayload(
  outcome: ClaimedOrderPullOutcome,
  payload: OrderPullPayload,
): void {
  if (outcome.pullId !== payload.pullId) throw new OutboundSyncError("reservation-membership-mismatch");
  if (outcome.outcome.kind === "order-pull-unknown" || outcome.outcome.kind === "abandoned") return;
  const complete = outcome.outcome;
  if (
    complete.lawVersion !== payload.lawVersion ||
    !sameSelector(complete.selector, payload.selector) ||
    complete.admissionCounts.readyToShipMembers > payload.bounds.plan.intakeReads ||
    complete.admissionCounts.followUpReads !== payload.followUpReferences.length ||
    complete.admissionCounts.admitted > payload.bounds.maxObservationPosts ||
    complete.progress.previousDigest !== payload.checkpointDigest ||
    complete.progress.pages.length > payload.bounds.plan.listReads ||
    complete.progress.postedReferences.length + complete.progress.gaps.length >
      payload.bounds.plan.intakeReads + payload.bounds.plan.followUpReads
  ) {
    throw new OutboundSyncError("invalid-input", "order-pull-complete does not match the claimed pull authority.");
  }
  for (const page of complete.progress.pages) assertOrderPullChunk(payload.connectionId, page.orderReferences);
}

export function isClaimedOrderPullOutcome(value: object): value is ClaimedOrderPullOutcome {
  return "operationKind" in value && value.operationKind === orderPullOperationKind;
}

export function sameSelector(left: OrderPullSelectorBinding, right: OrderPullSelectorBinding): boolean {
  return (
    left.identity === right.identity &&
    left.version === right.version &&
    left.pageSize === right.pageSize &&
    left.traversal === right.traversal
  );
}

/** Claiming is due-now; provider execution must still respect the cross-job idle gap. */
export function orderPullProviderReady(payload: OrderPullPayload, at: string): boolean {
  return Date.parse(at) >= Date.parse(payload.providerNotBefore);
}

function assertPlan(
  value: unknown,
  bounds: Pick<OrderPullAuthority, "nIntakeReadMax" | "nListReadMax" | "fMax">,
): asserts value is OrderPullPlan {
  const plan = closed(value, ["listReads", "intakeReads", "followUpReads"], "plan", true);
  integer(plan.listReads, 0, bounds.nListReadMax, "listReads");
  integer(plan.intakeReads, 0, bounds.nIntakeReadMax, "intakeReads");
  integer(plan.followUpReads, 0, bounds.fMax, "followUpReads");
}

function closed(value: unknown, keys: readonly string[], label: string, exact = false): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) invalid(`${label}.${key} is unknown.`);
  if (exact) for (const key of keys) if (!Object.hasOwn(record, key)) invalid(`${label}.${key} is required.`);
  return record;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function opaque(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000\ud800-\udfff]/u.test(value)) {
    invalid(`${label} is invalid.`);
  }
}

function pullId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^copl_[a-f0-9]{40}$/.test(value)) invalid("pullId is invalid.");
}

function invalid(message: string): never {
  throw new OutboundSyncError("invalid-input", message);
}
