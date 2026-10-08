import { describe, expect, it } from "vitest";
import {
  ORDER_PULL_DEADLINE_MS,
  ORDER_PULL_LEASE_MARGIN_MS,
  assertClaimedOrderPullOutcome,
  assertOrderPullOutcomeMatchesPayload,
  assertOrderPullPayload,
  decideOrderPullSearchPage,
  deriveOrderPullId,
  orderPullFitsLease,
  orderPullUnknownReasons,
  resolveOrderPullBudget,
  type ClaimedOrderPullOutcome,
  type OrderPullAuthority,
  type OrderPullPayload,
} from "../domain/order-pull";
import { assertClaimedSubjectOutcome, payloadDigest } from "../domain/validation";
import { OutboundSyncError } from "../domain/contracts";

// Synthetic authority: #8804 has not fixed N_rts_max/F_max and #8838 has not qualified a page size.
// These values exercise the equation only and are never production authority.
const syntheticAuthority: OrderPullAuthority = {
  revision: 3,
  lawVersion: "ready-to-ship-intake/v1",
  selector: { identity: "synthetic-ready-to-ship-selector", version: 1, pageSize: 500 },
  nRtsMax: 60,
  fMax: 20,
  providerCadenceMs: 1_000,
  providerCallTimeoutMs: 3_000,
  mappingJournalMs: 10_000,
  maxPostsPerOrder: 3,
  postTimeoutMs: 1_000,
  reportTimeoutMs: 5_000,
};

function payload(overrides: Partial<OrderPullPayload> = {}): OrderPullPayload {
  return {
    kind: "order-pull",
    version: 1,
    connectionId: "connection_synthetic",
    pullId: deriveOrderPullId("connection_synthetic", 1),
    policyRevision: 3,
    lawVersion: "ready-to-ship-intake/v1",
    selector: syntheticAuthority.selector,
    bounds: { nRtsMax: 60, fMax: 2, maxObservationPosts: 240, budgetMs: 583_000 },
    followUpReferences: [],
    ...overrides,
  };
}

function invalid(run: () => void): void {
  expect(run).toThrowError(OutboundSyncError);
}

describe("order-pull-budget-preflight", () => {
  it("binds lookup + search + (N_rts_max + F_max) details, cadence plus timeout ceilings, mapping, posts and report", () => {
    // (2 + 80) * (1000 + 3000) + 10000 + (80 * 3) * 1000 + 5000
    expect(resolveOrderPullBudget(syntheticAuthority)).toEqual({
      kind: "fits",
      authority: syntheticAuthority,
      providerCalls: 82,
      bounds: { nRtsMax: 60, fMax: 20, maxObservationPosts: 240, budgetMs: 583_000 },
    });
  });

  it("accepts the largest valid budget at the unchanged deadline and refuses one millisecond more", () => {
    const largest = { ...syntheticAuthority, reportTimeoutMs: 22_000 };
    const decision = resolveOrderPullBudget(largest);
    expect(decision.kind === "fits" && decision.bounds.budgetMs).toBe(ORDER_PULL_DEADLINE_MS);
    expect(resolveOrderPullBudget({ ...largest, reportTimeoutMs: 22_001 })).toEqual({
      kind: "refused",
      reason: "over-deadline",
    });
  });

  it.each([
    ["absent authority", null],
    ["absent N_rts_max", { ...syntheticAuthority, nRtsMax: undefined }],
    ["absent F_max", (({ fMax: _fMax, ...rest }) => rest)(syntheticAuthority)],
    ["N_rts_max not below the page size", { ...syntheticAuthority, nRtsMax: 500 }],
    ["zero cadence", { ...syntheticAuthority, providerCadenceMs: 0 }],
    ["nested unknown selector key", { ...syntheticAuthority, selector: { ...syntheticAuthority.selector, page: 2 } }],
    ["another law", { ...syntheticAuthority, lawVersion: "ready-to-ship-intake/v2" }],
  ])("refuses %s before any provider call", (_label, authority) => {
    expect(resolveOrderPullBudget(authority)).toEqual({ kind: "refused", reason: "authority-unknown" });
  });

  it("requires now + budget + 30 s strictly before lease expiry", () => {
    const at = "2026-10-08T12:00:00.000Z";
    const boundary = new Date(Date.parse(at) + 583_000 + ORDER_PULL_LEASE_MARGIN_MS).toISOString();
    expect(orderPullFitsLease({ budgetMs: 583_000, at, leaseExpiresAt: boundary })).toBe(false);
    expect(
      orderPullFitsLease({
        budgetMs: 583_000,
        at,
        leaseExpiresAt: new Date(Date.parse(boundary) + 1).toISOString(),
      }),
    ).toBe(true);
    expect(orderPullFitsLease({ budgetMs: 583_000, at: "not-an-instant", leaseExpiresAt: boundary })).toBe(false);
  });

  it("accepts the largest valid follow-up list and refuses cap+1, duplicates and nested unknown keys", () => {
    expect(() => assertOrderPullPayload(payload({ followUpReferences: ["ORDER-1", "ORDER-2"] }))).not.toThrow();
    invalid(() => assertOrderPullPayload(payload({ followUpReferences: ["ORDER-1", "ORDER-2", "ORDER-3"] })));
    invalid(() => assertOrderPullPayload(payload({ followUpReferences: ["ORDER-1", "ORDER-1"] })));
    invalid(() => assertOrderPullPayload(payload({ followUpReferences: [" leading-space"] })));
    invalid(() => assertOrderPullPayload({ ...payload(), bounds: { ...payload().bounds, sellerKey: "x" } }));
    invalid(() => assertOrderPullPayload({ ...payload(), listingId: "fake" }));
    invalid(() => assertOrderPullPayload(payload({ bounds: { ...payload().bounds, budgetMs: 600_001 } })));
    invalid(() => assertOrderPullPayload(payload({ pullId: "pull_1" })));
    invalid(() => assertOrderPullPayload((({ followUpReferences: _references, ...rest }) => rest)(payload())));
  });

  it("closes pull outcomes recursively and binds complete to the claimed authority", () => {
    const pull = payload();
    const complete: ClaimedOrderPullOutcome = {
      operationKind: "tcgplayer-order-pull",
      operationId: `cop_${"a".repeat(40)}`,
      attemptId: "coa_1",
      claimGeneration: 1,
      pullId: pull.pullId,
      payloadDigest: payloadDigest(pull),
      outcome: {
        kind: "order-pull-complete",
        lawVersion: "ready-to-ship-intake/v1",
        selector: pull.selector,
        admissionCounts: { readyToShipMembers: 60, followUpReads: 0, admitted: 240 },
      },
    };
    expect(() => assertClaimedSubjectOutcome(complete)).not.toThrow();
    expect(() => assertOrderPullOutcomeMatchesPayload(complete, pull)).not.toThrow();
    for (const reason of orderPullUnknownReasons) {
      expect(() =>
        assertClaimedOrderPullOutcome({ ...complete, outcome: { kind: "order-pull-unknown", reason } }),
      ).not.toThrow();
    }
    invalid(() =>
      assertClaimedOrderPullOutcome({ ...complete, outcome: { kind: "order-pull-unknown", reason: "timeout" } }),
    );
    invalid(() =>
      assertClaimedOrderPullOutcome({ ...complete, outcome: { kind: "abandoned", reason: "superseded-basis" } }),
    );
    invalid(() =>
      assertClaimedOrderPullOutcome({
        ...complete,
        outcome: {
          ...complete.outcome,
          admissionCounts: { readyToShipMembers: 1, followUpReads: 0, admitted: 1, extra: 1 },
        },
      }),
    );
    invalid(() => assertClaimedOrderPullOutcome({ ...complete, outcome: { kind: "applied", result: {} } }));
    // Subject bypass: a pull member reported in the listing grammar is refused by the closed listing codec.
    invalid(() =>
      assertClaimedSubjectOutcome({
        operationId: complete.operationId,
        attemptId: complete.attemptId,
        claimGeneration: 1,
        desiredStateSequence: 1,
        pullId: complete.pullId,
        outcome: { kind: "outcome-unknown" },
      }),
    );
    if (complete.outcome.kind !== "order-pull-complete") throw new Error("fixture");
    const counts = complete.outcome.admissionCounts;
    for (const mutant of [
      { ...complete.outcome, selector: { ...pull.selector, version: 2 } },
      { ...complete.outcome, admissionCounts: { ...counts, readyToShipMembers: 61 } },
      { ...complete.outcome, admissionCounts: { ...counts, followUpReads: 1 } },
      { ...complete.outcome, admissionCounts: { ...counts, admitted: 241 } },
    ]) {
      invalid(() => assertOrderPullOutcomeMatchesPayload({ ...complete, outcome: mutant }, pull));
    }
  });
});

describe("8608-decision-r4 ruling fixture: one closed Ready to Ship search page", () => {
  const pull = payload();
  const read = (orderNumbers: readonly string[]) => ({ kind: "read-details", orderNumbers });
  const unknown = (reason: string) => ({ kind: "unknown", reason, detailReads: 0 });
  const numbers = (count: number) => Array.from({ length: count }, (_, index) => `ORDER-${index + 1}`);
  it.each([
    ["certified empty set", { totalOrders: 0, orderNumbers: [], everyRowReadyToShip: true }, read([])],
    ["N_rts_max members", { totalOrders: 60, orderNumbers: numbers(60), everyRowReadyToShip: true }, read(numbers(60))],
    [
      "totalOrders above N_rts_max",
      { totalOrders: 61, orderNumbers: numbers(61), everyRowReadyToShip: true },
      unknown("budget-exceeded"),
    ],
    [
      "a full page (total >= page size)",
      { totalOrders: 500, orderNumbers: numbers(500), everyRowReadyToShip: true },
      unknown("budget-exceeded"),
    ],
    [
      "missing total",
      { totalOrders: undefined, orderNumbers: [], everyRowReadyToShip: true },
      unknown("completeness-unproven"),
    ],
    [
      "length mismatch",
      { totalOrders: 3, orderNumbers: numbers(2), everyRowReadyToShip: true },
      unknown("completeness-unproven"),
    ],
    [
      "duplicate order numbers",
      { totalOrders: 2, orderNumbers: ["ORDER-1", "ORDER-1"], everyRowReadyToShip: true },
      unknown("completeness-unproven"),
    ],
    [
      "a row outside Ready to Ship",
      { totalOrders: 2, orderNumbers: numbers(2), everyRowReadyToShip: false },
      unknown("completeness-unproven"),
    ],
  ])("%s", (_label, page, expected) => {
    expect(decideOrderPullSearchPage(pull, page)).toEqual(expected);
  });

  it("never treats a page at the page size as complete even when the bound would admit it", () => {
    const wide = payload({
      selector: { ...pull.selector, pageSize: 61 },
      bounds: { ...pull.bounds, nRtsMax: 60 },
    });
    expect(
      decideOrderPullSearchPage(wide, { totalOrders: 60, orderNumbers: numbers(60), everyRowReadyToShip: true }),
    ).toEqual(read(numbers(60)));
    expect(
      decideOrderPullSearchPage(
        payload({ selector: { ...pull.selector, pageSize: 60 }, bounds: { ...pull.bounds, nRtsMax: 60 } }),
        { totalOrders: 60, orderNumbers: numbers(60), everyRowReadyToShip: true },
      ),
    ).toEqual(unknown("completeness-unproven"));
  });
});
