import { describe, expect, it, vi } from "vitest";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { managedOfferEvaluations, readManagedOfferWorkDiagnostics } from "../e2e/support/managed-offer-diagnostics";

const workId = "a".repeat(64);
const product = { catalogItemId: "cat_fixture", productId: "cat_fixture::" };
const occurredAt = "2026-11-15T21:01:55.000Z" as StoredEvent["occurredAt"];
const held = {
  eventType: "marketplace.offer.managed-evaluated",
  streamVersion: 3,
  occurredAt,
  payload: {
    status: "held",
    reason: "market-price-stale",
    policyVersion: 4,
    operationId: `${workId}_off_fixture`,
    evidence: {
      evaluatedAt: occurredAt,
      marketPrice: { ...product, estimateVersion: "8347002", amount: "135.00", freshUntil: occurredAt },
    },
  },
};
const work = {
  stream_id: `marketplace.offer-work-${workId}`,
  stream_version: "3",
  event_type: "marketplace.offer.work-progressed",
  occurred_at: new Date(occurredAt),
  payload: {
    ...product,
    workId,
    kind: "reaction",
    status: "completed",
    availableAt: occurredAt,
    afterOfferId: "off_fixture",
    page: { claimVersion: 2, afterOfferId: "", offerIds: ["off_fixture"] },
  },
};

describe("managed Offer convergence diagnostics", () => {
  it("retains held reasons and exact Pricing evidence independently of an applied price pair", () => {
    expect(managedOfferEvaluations([held])).toEqual([{ streamVersion: 3, occurredAt, ...held.payload }]);
    const applied = {
      ...held,
      streamVersion: 5,
      payload: { ...held.payload, status: "applied", reason: "market-price-target" },
    };
    expect(
      managedOfferEvaluations([held, { ...held, eventType: "marketplace.offer.price-updated" }, applied]),
    ).toHaveLength(2);
    expect(
      managedOfferEvaluations([{ ...held, payload: { ...held.payload, evidence: { marketPrice: null } } }])[0]!
        .evidence,
    ).toEqual({ marketPrice: null, evaluatedAt: null });
  });

  it("reads authoritative Product work and operation-linked claims with the actual page selection", async () => {
    const claim = {
      ...work,
      stream_version: "2",
      event_type: "marketplace.offer.work-claimed",
      payload: { ...work.payload, status: "claimed", page: undefined },
    };
    const db = { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [work, claim] })) };
    const diagnostics = await readManagedOfferWorkDiagnostics(db, product, [held]);
    expect(db.query.mock.calls[0]).toEqual([
      expect.stringContaining("event_type = 'marketplace.offer.work-requested'"),
      [product.catalogItemId, product.productId, [work.stream_id]],
    ]);
    const sql = db.query.mock.calls[0]![0];
    expect(sql).toContain("payload->>'catalogItemId' = $1 AND payload->>'productId' = $2");
    expect(sql).toContain("OR stream_id = ANY($3::text[])");
    expect(diagnostics.events).toMatchObject([
      { streamId: work.stream_id, eventType: work.event_type, page: work.payload.page },
      { streamId: work.stream_id, eventType: claim.event_type, status: "claimed", page: null },
    ]);
    expect(diagnostics.truncated).toBe(false);
  });

  it("bounds work event retention explicitly and does not hide a failed diagnostics read", async () => {
    const db = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
        rows: Array.from({ length: 501 }, () => work),
      })),
    };
    const diagnostics = await readManagedOfferWorkDiagnostics(db, product, []);
    expect(diagnostics.events).toHaveLength(500);
    expect(diagnostics.truncated).toBe(true);
    expect(db.query.mock.calls[0]![1]).toEqual([product.catalogItemId, product.productId, []]);
    db.query.mockRejectedValueOnce(new Error("read failed"));
    await expect(readManagedOfferWorkDiagnostics(db, product, [])).rejects.toThrow("read failed");
  });
});
