import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ORDER_PULL_DEADLINE_MS,
  allocateOrderPullBudget,
  assertClaimedOrderPullOutcome,
  assertOrderPullAuthority,
  assertOrderPullOutcomeMatchesPayload,
  assertOrderPullPayload,
  deriveOrderPullId,
  orderPullFitsLease,
  orderPullUnknownReasons,
  resolveOrderPullBudget,
  tcgplayerOrderPullGovernedBounds,
  type ClaimedOrderPullOutcome,
} from "../domain/order-pull";
import {
  advanceOrderPullTraversal,
  assertOrderPullChunk,
  assertOrderPullProgress,
  orderPullCheckpointDigest,
  orderPullProgressKind,
  type OrderPullTraversal,
} from "../domain/order-pull-progress";
import {
  acceptedReadyToShipInputByteLimit,
  acceptedReadyToShipReferenceLimit,
  assertAcceptedReadyToShipQuery,
} from "../../order-fulfillment-observations/domain/contracts";
import { assertClaimedSubjectOutcome, payloadDigest } from "../domain/validation";
import {
  syntheticAuthority as authority,
  syntheticPage,
  syntheticPayload,
  syntheticProgress,
} from "./order-pull-fixtures";

describe("governed order-pull bounds, synthetic selector only", () => {
  // The envelope is governed; the revision and cursor selector remain synthetic, not provider qualification.
  const governedAuthority = {
    ...tcgplayerOrderPullGovernedBounds,
    revision: authority.revision,
    selector: authority.selector,
  };
  const plan = { listReads: 1, intakeReads: 8, followUpReads: 5 };

  it("pins every governed field and freezes the binding without revision or selector", () => {
    expect(tcgplayerOrderPullGovernedBounds).toEqual({
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
    });
    expect(Object.isFrozen(tcgplayerOrderPullGovernedBounds)).toBe(true);
    expect(() => assertOrderPullAuthority(governedAuthority)).not.toThrow();
    expect(() => assertOrderPullAuthority(tcgplayerOrderPullGovernedBounds)).toThrow();
  });

  it("governed deadline control: only L1 to L2 changes 590000 fit to 610000 refusal", () => {
    expect(resolveOrderPullBudget(governedAuthority, plan)).toMatchObject({
      kind: "fits",
      bounds: { budgetMs: 590_000 },
    });
    expect(resolveOrderPullBudget(governedAuthority, { ...plan, listReads: 2 })).toEqual({
      kind: "refused",
      reason: "over-deadline",
    });
  });

  it("governed reallocation control: only I8 to I7 changes 610000 refusal to 570000 fit", () => {
    const twoLists = { ...plan, listReads: 2 };
    expect(resolveOrderPullBudget(governedAuthority, twoLists)).toEqual({
      kind: "refused",
      reason: "over-deadline",
    });
    expect(resolveOrderPullBudget(governedAuthority, { ...twoLists, intakeReads: 7 })).toMatchObject({
      kind: "fits",
      bounds: { budgetMs: 570_000 },
    });
  });

  it.each([
    [1, 8, 590_000],
    [2, 7, 570_000],
  ])("governed L%i I%i retains strict lease margin for %i ms", (listReads, intakeReads, budgetMs) => {
    const decision = resolveOrderPullBudget(governedAuthority, { ...plan, listReads, intakeReads });
    expect(decision.kind).toBe("fits");
    if (decision.kind !== "fits") throw new Error("Expected governed plan to fit.");
    expect(decision.bounds.budgetMs).toBe(budgetMs);
    const at = "2026-10-09T00:00:00.000Z";
    const fitsLease = (remainingMs: number) =>
      orderPullFitsLease({
        budgetMs: decision.bounds.budgetMs,
        at,
        leaseExpiresAt: new Date(Date.parse(at) + remainingMs).toISOString(),
      });
    expect(fitsLease(1_800_000)).toBe(true);
    expect(fitsLease(budgetMs + 30_000)).toBe(false);
    expect(fitsLease(budgetMs + 30_001)).toBe(true);
  });

  it.each([
    ["pageSize", "missing", undefined],
    ["pageSize", "invalid", 0],
    ["pageSize", "over codec cap", 1001],
    ["traversal", "missing", undefined],
    ["traversal", "invalid", "mutable-offset"],
  ] as const)("governed selector control: %s %s refuses independently of budget", (field, _label, value) => {
    expect(resolveOrderPullBudget(governedAuthority, plan)).toMatchObject({
      kind: "fits",
      bounds: { budgetMs: 590_000 },
    });
    const selector: Record<string, unknown> = { ...governedAuthority.selector };
    if (value === undefined) delete selector[field];
    else selector[field] = value;
    const invalidAuthority = { ...governedAuthority, selector };
    expect(() => assertOrderPullAuthority(invalidAuthority)).toThrow();
    expect(resolveOrderPullBudget(invalidAuthority, plan)).toEqual({ kind: "refused", reason: "authority-unknown" });
  });

  it("governed page size is a chunk, not an intake or population bound", () => {
    for (const pageSize of [1, 8, 100, 1000]) {
      const chunkAuthority = { ...governedAuthority, selector: { ...governedAuthority.selector, pageSize } };
      expect(() => assertOrderPullAuthority(chunkAuthority)).not.toThrow();
      expect(resolveOrderPullBudget(chunkAuthority, plan)).toMatchObject({
        kind: "fits",
        bounds: { budgetMs: 590_000 },
      });
    }
  });

  it("governed bounds never replace absent authority", () => {
    expect(resolveOrderPullBudget(null, plan)).toEqual({ kind: "refused", reason: "authority-unknown" });
    expect(resolveOrderPullBudget(tcgplayerOrderPullGovernedBounds, plan)).toEqual({
      kind: "refused",
      reason: "authority-unknown",
    });
  });
});

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
  it.each(["report", "traversal", "posted references"] as const)(
    "admits a one-scalar connection's exact 262144-byte owner request through %s",
    (boundary) => {
      const { payload, references, page, report } = syntheticExactCapReport();
      expect(
        Buffer.byteLength(JSON.stringify({ connectionId: payload.connectionId, orderReferences: references })),
      ).toBe(262144);
      expect(() =>
        assertAcceptedReadyToShipQuery({ connectionId: payload.connectionId, orderReferences: references }),
      ).not.toThrow();
      expect(() => assertOrderPullPayload(payload)).not.toThrow();
      expect(() => assertOrderPullOutcomeMatchesPayload(report, payload)).not.toThrow();
      if (boundary === "report") expect(() => assertClaimedOrderPullOutcome(report)).not.toThrow();
      if (boundary === "traversal")
        expect(advanceOrderPullTraversal(payload.selector, null, page)).toMatchObject({
          discovered: 1000,
          pages: 1,
          exhausted: false,
          nextCursor: "synthetic-next",
        });
      if (boundary === "posted references")
        expect(() =>
          assertOrderPullProgress(syntheticProgress(payload, { pages: [], postedReferences: references })),
        ).not.toThrow();
    },
  );
  it.each(["262145 bytes", "1001 references"] as const)("refuses a short-ID request with %s", (boundary) => {
    const { payload, references, page, report } = syntheticExactCapReport();
    if (boundary === "262145 bytes") {
      references[0] += "x";
      expect(
        Buffer.byteLength(JSON.stringify({ connectionId: payload.connectionId, orderReferences: references })),
      ).toBe(262145);
    } else {
      references.splice(0, references.length, ...Array.from({ length: 1001 }, (_, i) => `SYNTHETIC-${i}`));
    }
    expect(() => assertOrderPullChunk(payload.connectionId, references)).toThrow();
    expect(() => assertOrderPullOutcomeMatchesPayload(report, payload)).toThrow();
    expect(() => assertClaimedOrderPullOutcome(report)).toThrow();
    expect(() => advanceOrderPullTraversal(payload.selector, null, page)).toThrow();
    expect(() =>
      assertOrderPullProgress(syntheticProgress(payload, { pages: [], postedReferences: references })),
    ).toThrow();
  });
  it("retains the real connection overhead when matching an otherwise valid exact-cap report", () => {
    const { payload, report } = syntheticExactCapReport();
    expect(() => assertClaimedOrderPullOutcome(report)).not.toThrow();
    expect(() => assertOrderPullOutcomeMatchesPayload(report, { ...payload, connectionId: "SS" })).toThrow();
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

function syntheticExactCapReport() {
  const connectionId = "S"; // Synthetic minimum-overhead identity, not provider authority.
  const references = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, "0")}${"\u4e00".repeat(86)}`);
  const bytes = () => Buffer.byteLength(JSON.stringify({ connectionId, orderReferences: references }), "utf8");
  while (bytes() > acceptedReadyToShipInputByteLimit) {
    const index = references.findIndex((reference) => reference.endsWith("\u4e00"));
    references[index] = references[index]!.slice(0, -1);
  }
  references[0] += "x".repeat(acceptedReadyToShipInputByteLimit - bytes());
  const pullId = deriveOrderPullId(connectionId, 1);
  const selector = { ...authority.selector, pageSize: 1000 };
  const checkpoint = { ...syntheticPayload().checkpoint, burstId: pullId, selector };
  const payload = syntheticPayload({
    connectionId,
    pullId,
    selector,
    checkpoint,
    checkpointDigest: orderPullCheckpointDigest(checkpoint),
  });
  const page = syntheticPage(references, { totalOrders: 1001, nextCursor: "synthetic-next" });
  const report: ClaimedOrderPullOutcome = {
    operationKind: "tcgplayer-order-pull",
    operationId: "synthetic-operation",
    attemptId: "synthetic-attempt",
    claimGeneration: 1,
    pullId,
    payloadDigest: payloadDigest(payload),
    outcome: {
      kind: "continuation-required",
      lawVersion: payload.lawVersion,
      selector,
      admissionCounts: { readyToShipMembers: 0, followUpReads: 0, admitted: 0 },
      progress: syntheticProgress(payload, { pages: [page] }),
    },
  };
  return { payload, references, page, report };
}
