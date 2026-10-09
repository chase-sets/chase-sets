import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ORDER_PULL_DEADLINE_MS,
  allocateOrderPullBudget,
  assertClaimedOrderPullOutcome,
  assertOrderPullAuthority,
  assertOrderPullOutcomeMatchesPayload,
  assertOrderPullPayload,
  orderPullFitsLease,
  orderPullUnknownReasons,
  resolveOrderPullBudget,
  type ClaimedOrderPullOutcome,
} from "../domain/order-pull";
import {
  advanceOrderPullTraversal,
  assertOrderPullChunk,
  assertOrderPullProgress,
  orderPullProgressKind,
  type OrderPullTraversal,
} from "../domain/order-pull-progress";
import {
  acceptedReadyToShipInputByteLimit,
  acceptedReadyToShipReferenceLimit,
} from "../../order-fulfillment-observations/domain/contracts";
import { assertClaimedSubjectOutcome, payloadDigest } from "../domain/validation";
import {
  syntheticAuthority as authority,
  syntheticPage,
  syntheticPayload,
  syntheticProgress,
} from "./order-pull-fixtures";

describe("order-pull-budget-preflight: actual L/I/F allocation", () => {
  it.each([
    [1, 8, 5, 590_000],
    [2, 7, 5, 570_000],
    [2, 0, 5, 290_000],
    [1, 1, 0, 110_000],
  ])("L=%i I=%i F=%i budgets %i independently of population", (listReads, intakeReads, followUpReads, budgetMs) => {
    const decision = resolveOrderPullBudget(authority, { listReads, intakeReads, followUpReads });
    expect(decision).toMatchObject({
      kind: "fits",
      providerCalls: 1 + listReads + intakeReads + followUpReads,
      bounds: { budgetMs, maxObservationPosts: (intakeReads + followUpReads) * 4 },
    });
    for (const pageSize of [1, 100, 1000])
      expect(
        resolveOrderPullBudget(
          { ...authority, selector: { ...authority.selector, pageSize } },
          { listReads, intakeReads, followUpReads },
        ),
      ).toMatchObject({ kind: "fits", bounds: { budgetMs } });
  });
  it("refuses the 610000 allocation, replans intake to seven, never refuses the account", () => {
    expect(resolveOrderPullBudget(authority, { listReads: 2, intakeReads: 8, followUpReads: 5 })).toEqual({
      kind: "refused",
      reason: "over-deadline",
    });
    expect(allocateOrderPullBudget(authority, 2, 5)).toMatchObject({
      kind: "fits",
      bounds: { budgetMs: 570_000, plan: { listReads: 2, intakeReads: 7, followUpReads: 5 } },
    });
  });
  it("freezes all other fields at the deadline and strict actual-lease boundaries", () => {
    const plan = { listReads: 1, intakeReads: 8, followUpReads: 5 };
    const exact = { ...authority, reportTimeoutMs: 20_000 };
    expect(resolveOrderPullBudget(exact, plan)).toMatchObject({
      kind: "fits",
      bounds: { budgetMs: ORDER_PULL_DEADLINE_MS },
    });
    expect(resolveOrderPullBudget({ ...exact, reportTimeoutMs: 20_001 }, plan)).toEqual({
      kind: "refused",
      reason: "over-deadline",
    });
    const at = "2026-10-09T00:00:00.000Z";
    expect(orderPullFitsLease({ budgetMs: 590_000, at, leaseExpiresAt: "2026-10-09T00:10:20.000Z" })).toBe(false);
    expect(orderPullFitsLease({ budgetMs: 590_000, at, leaseExpiresAt: "2026-10-09T00:10:20.001Z" })).toBe(true);
  });
  it("requires exactly I/L/F and six governed ceilings; every numeric clause rejects independently", () => {
    const fields = [
      "nIntakeReadMax",
      "nListReadMax",
      "fMax",
      "providerCadenceMs",
      "providerCallTimeoutMs",
      "mappingJournalMs",
      "maxPostsPerOrder",
      "postTimeoutMs",
      "reportTimeoutMs",
    ] as const;
    expect(
      Object.keys(authority)
        .filter((key) => !["revision", "lawVersion", "selector"].includes(key))
        .sort(),
    ).toEqual([...fields].sort());
    for (const field of [...fields, "revision"] as const) {
      const { [field]: _removed, ...missing } = authority;
      expect(() => assertOrderPullAuthority(missing), field).toThrow();
      for (const value of [undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => assertOrderPullAuthority({ ...authority, [field]: value }), `${field}=${value}`).toThrow();
      }
    }
    for (const invalid of [
      null,
      { ...authority, nRtsMax: 100 },
      { ...authority, lawVersion: "ready-to-ship-intake/v1" },
      { ...authority, selector: { ...authority.selector, traversal: "mutable-offset" } },
      { ...authority, selector: { ...authority.selector, pageSize: 1001 } },
    ]) {
      expect(resolveOrderPullBudget(invalid)).toEqual({ kind: "refused", reason: "authority-unknown" });
    }
    for (const plan of [
      { listReads: 3, intakeReads: 7, followUpReads: 5 },
      { listReads: 1, intakeReads: 9, followUpReads: 5 },
      { listReads: 1, intakeReads: 7, followUpReads: 6 },
      { listReads: 1, intakeReads: 7.5, followUpReads: 5 },
    ]) {
      expect(resolveOrderPullBudget(authority, plan)).toEqual({ kind: "refused", reason: "authority-unknown" });
    }
  });
});

describe("qualified synthetic traversal, never provider authority", () => {
  it.each([0, 101, 300, 301, 500, 800])("enumerates %i including the decisive member beyond page one", (total) => {
    let traversal: OrderPullTraversal | null = null;
    const found: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const refs = Array.from({ length: Math.min(100, total - offset) }, (_, i) => `ORDER-${offset + i}`);
      const nextCursor = refs.length === 100 ? `cursor-${offset + 100}` : null;
      traversal = advanceOrderPullTraversal(
        authority.selector,
        traversal,
        syntheticPage(refs, {
          cursor: offset ? `cursor-${offset}` : null,
          nextCursor,
          totalOrders: total,
        }),
      );
      found.push(...refs);
      if (nextCursor === null) break;
      expect(traversal.exhausted).toBe(false);
    }
    expect(traversal).toMatchObject({ exhausted: true, discovered: total });
    expect(new Set(found).size).toBe(total);
    if (total > 100) expect(found).toContain(`ORDER-${total - 1}`);
  });
  it("full, missing, mismatched, mutable and endless pages cannot certify empty or complete", () => {
    const first = syntheticPage(
      Array.from({ length: 100 }, (_, i) => `ORDER-${i}`),
      { totalOrders: 101, nextCursor: "next" },
    );
    const state = advanceOrderPullTraversal(authority.selector, null, first);
    for (const page of [
      { ...first, nextCursor: null },
      { ...first, totalOrders: undefined },
      { ...first, totalOrders: 99 },
      { ...first, orderReferences: ["same", "same"] },
      { ...first, everyRowReadyToShip: false },
      { ...first, extra: true },
    ])
      expect(() => advanceOrderPullTraversal(authority.selector, null, page as never)).toThrow();
    const tail = syntheticPage(["TAIL"], { cursor: "next", totalOrders: 101 });
    for (const page of [
      { ...tail, cursor: "wrong" },
      { ...tail, sessionDigest: "b".repeat(64) },
      { ...tail, frontier: "changed" },
      { ...tail, totalOrders: 102 },
      { ...tail, nextCursor: "next" },
      { ...tail, orderReferences: [], nextCursor: "endless" },
    ])
      expect(() => advanceOrderPullTraversal(authority.selector, state, page)).toThrow();
    expect(() => advanceOrderPullTraversal(authority.selector, state, tail)).not.toThrow();
    expect(advanceOrderPullTraversal(authority.selector, null, syntheticPage())).toMatchObject({
      exhausted: true,
      discovered: 0,
    });
  });
  it("never completes with unread or unaccepted work and never spins on posted-only pending work", () => {
    const base = { exhausted: true, unread: false, pending: false, followUpTail: false, gapCount: 0 };
    expect(orderPullProgressKind(base)).toBe("order-pull-complete");
    expect(orderPullProgressKind({ ...base, pending: true })).toBe("order-pull-pending");
    expect(orderPullProgressKind({ ...base, unread: true, pending: true })).toBe("continuation-required");
    expect(orderPullProgressKind({ ...base, exhausted: false })).toBe("continuation-required");
    expect(orderPullProgressKind({ ...base, followUpTail: true })).toBe("continuation-required");
    expect(orderPullProgressKind({ ...base, gapCount: 1 })).toBe("order-pull-gaps");
  });
});

describe("closed bounded owner-compatible payload and report", () => {
  it("accepts empty/count cap, refuses count cap+1, duplicates and complete-JSON byte cap+1", () => {
    const connection = "connection_synthetic";
    const refs = Array.from({ length: acceptedReadyToShipReferenceLimit }, (_, i) => `ORDER-${i}`);
    expect(() => assertOrderPullChunk(connection, [])).not.toThrow();
    expect(() => assertOrderPullChunk(connection, refs)).not.toThrow();
    expect(() => assertOrderPullChunk(connection, [...refs, "EXTRA"])).toThrow();
    expect(() => assertOrderPullChunk(connection, ["same", "same"])).toThrow();
    expect(() => assertOrderPullChunk(connection, ["x".repeat(129)])).toThrow();
    const large = Array.from({ length: 1000 }, (_, i) => `${i.toString().padStart(4, "0")}${"\u4e00".repeat(86)}`);
    const size = () => Buffer.byteLength(JSON.stringify({ connectionId: connection, orderReferences: large }), "utf8");
    while (size() > acceptedReadyToShipInputByteLimit) {
      const index = large.findIndex((ref) => ref.endsWith("\u4e00"));
      large[index] = large[index]!.slice(0, -1);
    }
    large[0] += "x".repeat(acceptedReadyToShipInputByteLimit - size());
    expect(size()).toBe(acceptedReadyToShipInputByteLimit);
    expect(() => assertOrderPullChunk(connection, large)).not.toThrow();
    large[0] += "x";
    expect(size()).toBe(acceptedReadyToShipInputByteLimit + 1);
    expect(() => assertOrderPullChunk(connection, large)).toThrow();
  });
  it("round-trips progress outcomes and unknown reasons; binds checkpoint, selector, counts and membership", () => {
    const payload = syntheticPayload();
    expect(() => assertOrderPullPayload(payload)).not.toThrow();
    const report: ClaimedOrderPullOutcome = {
      operationKind: "tcgplayer-order-pull",
      operationId: "operation",
      attemptId: "attempt",
      claimGeneration: 1,
      pullId: payload.pullId,
      payloadDigest: payloadDigest(payload),
      outcome: {
        kind: "order-pull-complete",
        lawVersion: payload.lawVersion,
        selector: payload.selector,
        admissionCounts: { readyToShipMembers: 0, followUpReads: 0, admitted: 0 },
        progress: syntheticProgress(payload),
      },
    };
    for (const kind of [
      "order-pull-complete",
      "continuation-required",
      "order-pull-pending",
      "order-pull-gaps",
    ] as const) {
      expect(() =>
        assertClaimedSubjectOutcome(JSON.parse(JSON.stringify({ ...report, outcome: { ...report.outcome, kind } }))),
      ).not.toThrow();
    }
    expect(() => assertOrderPullOutcomeMatchesPayload(report, payload)).not.toThrow();
    for (const reason of orderPullUnknownReasons)
      expect(() =>
        assertClaimedOrderPullOutcome({ ...report, outcome: { kind: "order-pull-unknown", reason } }),
      ).not.toThrow();
    for (const mutant of [
      { ...payload, version: 1 },
      { ...payload, checkpointDigest: "0".repeat(64) },
      { ...payload, checkpoint: { ...payload.checkpoint, extra: 1 } },
      { ...payload, work: { ...payload.work, acceptedReferences: ["not-requested"] } },
      { ...payload, bounds: { ...payload.bounds, plan: { ...payload.bounds.plan, extra: 1 } } },
      { ...payload, bounds: { ...payload.bounds, providerCalls: 999 } },
    ])
      expect(() => assertOrderPullPayload(mutant)).toThrow();
    const progress = syntheticProgress(payload);
    expect(() =>
      assertOrderPullProgress({ ...progress, pages: [syntheticPage(), syntheticPage(), syntheticPage()] }),
    ).toThrow();
    for (const bad of [
      { ...progress, extra: true },
      { ...progress, pages: [{ ...syntheticPage(), sellerKey: "forbidden" }] },
      { ...progress, gaps: [{ reference: "ORDER", reason: "unqualified" }] },
    ])
      expect(() => assertOrderPullProgress(bad)).toThrow();
  });
  it("inventories removal of the coupled/single-page law and the direct owner seam", () => {
    const domain = readFileSync(new URL("../domain/order-pull.ts", import.meta.url), "utf8");
    expect(domain).not.toMatch(/nRtsMax|decideOrderPullSearchPage|intake-deferred/);
    const coordinator = readFileSync(new URL("../api/order-pull-progress.ts", import.meta.url), "utf8");
    expect(coordinator).toContain("readAcceptedReadyToShipMembership(db,");
    expect(coordinator).not.toMatch(/channel_fulfillment_orders|channel_connector_inbound|provider_order_status/);
  });
});
