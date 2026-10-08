import { createHash } from "node:crypto";
import { OutboundSyncError } from "./contracts";

/**
 * Channel Order Pull: one connection-subject Channel Outbound Operation that asks a capable connector to
 * read the TCGplayer Ready to Ship set once under the `ready-to-ship-intake/v1` law (#8608 FINAL r4).
 * The executor derives every wire value from the qualified capture; the payload carries identities,
 * versions and bounds only.
 */
export const orderPullOperationKind = "tcgplayer-order-pull" as const;
export const orderPullLawVersion = "ready-to-ship-intake/v1" as const;
export const orderPullProviderKey = "tcgplayer" as const;

/** The unchanged pull deadline and lease margin every worst-case budget must fit (#8804). */
export const ORDER_PULL_DEADLINE_MS = 600_000;
export const ORDER_PULL_LEASE_MARGIN_MS = 30_000;

const maxBoundValue = 10_000;
const externalOrderReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

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

export type OrderPullSelectorBinding = Readonly<{ identity: string; version: number; pageSize: number }>;

/** Governed authority from #8804/#8838. Absent or malformed authority denies scheduling. */
export type OrderPullAuthority = Readonly<{
  revision: number;
  lawVersion: typeof orderPullLawVersion;
  selector: OrderPullSelectorBinding;
  nRtsMax: number;
  fMax: number;
  providerCadenceMs: number;
  providerCallTimeoutMs: number;
  mappingJournalMs: number;
  maxPostsPerOrder: number;
  postTimeoutMs: number;
  reportTimeoutMs: number;
}>;

export type OrderPullBounds = Readonly<{
  nRtsMax: number;
  fMax: number;
  maxObservationPosts: number;
  budgetMs: number;
}>;

export type OrderPullPayload = Readonly<{
  kind: "order-pull";
  version: 1;
  connectionId: string;
  pullId: string;
  policyRevision: number;
  lawVersion: typeof orderPullLawVersion;
  selector: OrderPullSelectorBinding;
  bounds: OrderPullBounds;
  followUpReferences: readonly string[];
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
        kind: "order-pull-complete";
        lawVersion: typeof orderPullLawVersion;
        selector: OrderPullSelectorBinding;
        admissionCounts: OrderPullAdmissionCounts;
      }>
    | Readonly<{ kind: "order-pull-unknown"; reason: OrderPullUnknownReason }>
    | Readonly<{ kind: "abandoned"; reason: (typeof orderPullAbandonReasons)[number] }>;
}>;

export type OrderPullBudgetDecision =
  | Readonly<{ kind: "fits"; authority: OrderPullAuthority; bounds: OrderPullBounds; providerCalls: number }>
  | Readonly<{ kind: "refused"; reason: "authority-unknown" | "over-deadline" }>;

/**
 * Worst case: 1 session lookup + 1 search + (N_rts_max + F_max) detail reads, each at the governing
 * inter-request cadence plus its per-call timeout ceiling, then mapping/journal, one post per
 * observation, and the report. Unknown or over-deadline authority refuses before any provider call.
 */
export function resolveOrderPullBudget(authority: unknown): OrderPullBudgetDecision {
  try {
    assertOrderPullAuthority(authority);
  } catch {
    return { kind: "refused", reason: "authority-unknown" };
  }
  const detailReads = authority.nRtsMax + authority.fMax;
  const providerCalls = 2 + detailReads;
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
    bounds: { nRtsMax: authority.nRtsMax, fMax: authority.fMax, maxObservationPosts, budgetMs },
  };
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

export type OrderPullSearchPage = Readonly<{
  totalOrders: unknown;
  orderNumbers: readonly unknown[];
  everyRowReadyToShip: boolean;
}>;

/**
 * The single closed search page decides the set. There is never a second page: a total above the
 * intake bound is `budget-exceeded`, and a missing total, length mismatch, total at or above the page
 * size, duplicate identity or non-Ready-to-Ship row is `completeness-unproven`. Both read zero details.
 */
export function decideOrderPullSearchPage(
  payload: OrderPullPayload,
  page: OrderPullSearchPage,
):
  | Readonly<{ kind: "read-details"; orderNumbers: readonly string[] }>
  | Readonly<{ kind: "unknown"; reason: "budget-exceeded" | "completeness-unproven"; detailReads: 0 }> {
  const unknown = (reason: "budget-exceeded" | "completeness-unproven") =>
    ({ kind: "unknown", reason, detailReads: 0 }) as const;
  const total = page.totalOrders;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return unknown("completeness-unproven");
  if (total > payload.bounds.nRtsMax) return unknown("budget-exceeded");
  if (
    !Array.isArray(page.orderNumbers) ||
    page.orderNumbers.length !== total ||
    total >= payload.selector.pageSize ||
    page.everyRowReadyToShip !== true ||
    page.orderNumbers.some((value) => typeof value !== "string" || !externalOrderReferencePattern.test(value)) ||
    new Set(page.orderNumbers).size !== page.orderNumbers.length
  ) {
    return unknown("completeness-unproven");
  }
  return { kind: "read-details", orderNumbers: page.orderNumbers as readonly string[] };
}

export function deriveOrderPullId(connectionId: string, scheduleGeneration: number): string {
  return `copl_${sha256(`order-pull\0${connectionId}\0${scheduleGeneration}`).slice(0, 40)}`;
}

export function deriveOrderPullOperationId(connectionId: string, pullId: string): string {
  return `cop_${sha256(`${orderPullOperationKind}\0${connectionId}\0${pullId}`).slice(0, 40)}`;
}

export function assertOrderPullAuthority(value: unknown): asserts value is OrderPullAuthority {
  const authority = closed(
    value,
    [
      "revision",
      "lawVersion",
      "selector",
      "nRtsMax",
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
  const selector = authority.selector;
  integer(authority.nRtsMax, 1, selector.pageSize - 1, "nRtsMax");
  integer(authority.fMax, 0, maxBoundValue, "fMax");
  integer(authority.providerCadenceMs, 1, ORDER_PULL_DEADLINE_MS, "providerCadenceMs");
  integer(authority.providerCallTimeoutMs, 1, ORDER_PULL_DEADLINE_MS, "providerCallTimeoutMs");
  integer(authority.mappingJournalMs, 0, ORDER_PULL_DEADLINE_MS, "mappingJournalMs");
  integer(authority.maxPostsPerOrder, 1, 16, "maxPostsPerOrder");
  integer(authority.postTimeoutMs, 1, ORDER_PULL_DEADLINE_MS, "postTimeoutMs");
  integer(authority.reportTimeoutMs, 1, ORDER_PULL_DEADLINE_MS, "reportTimeoutMs");
}

export function assertOrderPullPayload(value: unknown): asserts value is OrderPullPayload {
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
    ],
    "order-pull payload",
    true,
  );
  if (payload.kind !== "order-pull" || payload.version !== 1) invalid("order-pull payload kind/version is invalid.");
  opaque(payload.connectionId, "connectionId");
  pullId(payload.pullId);
  integer(payload.policyRevision, 1, Number.MAX_SAFE_INTEGER, "policyRevision");
  if (payload.lawVersion !== orderPullLawVersion) invalid("lawVersion is not the bound intake law.");
  assertSelector(payload.selector);
  const selector = payload.selector;
  const bounds = closed(payload.bounds, ["nRtsMax", "fMax", "maxObservationPosts", "budgetMs"], "bounds", true);
  integer(bounds.nRtsMax, 1, selector.pageSize - 1, "nRtsMax");
  integer(bounds.fMax, 0, maxBoundValue, "fMax");
  integer(bounds.maxObservationPosts, 0, 16 * 2 * maxBoundValue, "maxObservationPosts");
  integer(bounds.budgetMs, 1, ORDER_PULL_DEADLINE_MS, "budgetMs");
  const references = payload.followUpReferences;
  if (!Array.isArray(references) || references.length > Number(bounds.fMax)) {
    invalid("followUpReferences must hold 0..F_max references.");
  }
  for (const reference of references) {
    if (typeof reference !== "string" || !externalOrderReferencePattern.test(reference)) {
      invalid("followUpReferences holds an invalid External Order Reference.");
    }
  }
  if (new Set(references).size !== references.length) invalid("followUpReferences must be distinct.");
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
    ["kind", "lawVersion", "selector", "admissionCounts", "reason"],
    "order-pull outcome.outcome",
  );
  switch (outcome.kind) {
    case "order-pull-complete": {
      closed(outcome, ["kind", "lawVersion", "selector", "admissionCounts"], "order-pull outcome.outcome", true);
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
  if (outcome.outcome.kind !== "order-pull-complete") return;
  const complete = outcome.outcome;
  if (
    complete.lawVersion !== payload.lawVersion ||
    complete.selector.identity !== payload.selector.identity ||
    complete.selector.version !== payload.selector.version ||
    complete.selector.pageSize !== payload.selector.pageSize ||
    complete.admissionCounts.readyToShipMembers > payload.bounds.nRtsMax ||
    complete.admissionCounts.followUpReads !== payload.followUpReferences.length ||
    complete.admissionCounts.admitted > payload.bounds.maxObservationPosts
  ) {
    throw new OutboundSyncError("invalid-input", "order-pull-complete does not match the claimed pull authority.");
  }
}

export function isClaimedOrderPullOutcome(value: object): value is ClaimedOrderPullOutcome {
  return Object.hasOwn(value, "operationKind");
}

function assertSelector(value: unknown): asserts value is OrderPullSelectorBinding {
  const selector = closed(value, ["identity", "version", "pageSize"], "selector", true);
  if (typeof selector.identity !== "string" || !/^[a-z0-9][a-z0-9./-]{0,127}$/.test(selector.identity)) {
    invalid("selector identity is invalid.");
  }
  integer(selector.version, 1, Number.MAX_SAFE_INTEGER, "selector version");
  integer(selector.pageSize, 2, maxBoundValue, "selector pageSize");
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string): never {
  throw new OutboundSyncError("invalid-input", message);
}
