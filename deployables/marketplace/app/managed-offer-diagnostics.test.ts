import { describe, expect, it, vi } from "vitest";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  managedOfferEvaluations,
  managedOfferFulfillmentSnapshot,
  readManagedOfferFulfillmentAuthority,
  readManagedOfferWorkDiagnostics,
} from "../e2e/support/managed-offer-diagnostics";

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
  it("retains both held branches and their revisions without unrelated policy or Pricing evidence", async () => {
    const evidence = {
      policyRevision: 2,
      evaluatedAt: occurredAt,
      marketPrice: {
        ...product,
        estimateVersion: "8347002",
        amount: "135.00",
        currencyCode: "USD",
        estimatedAt: occurredAt,
        freshUntil: occurredAt,
      },
    };
    const row = {
      policy_status: "active",
      policy_revision: 2,
      policy_projection_version: 6,
      policy_stream_version: 6,
      audit_status: "applied",
      audit_reason: "market-price-target",
      audit_stream_version: 4,
      audit_evidence: { ...evidence, policyRevision: 1, privateTerms: "not exported" },
      consent_result: { status: "held", reason: "market-price-stale", evidence },
    };
    const db = { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [row] })) };
    expect(await readManagedOfferFulfillmentAuthority(db, "off_fixture", "bop_fixture")).toEqual({
      policy: { status: "active", revision: 2, projectionVersion: 6, streamVersion: 6 },
      audit: { ...evidence, policyRevision: 1, status: "applied", reason: "market-price-target", streamVersion: 4 },
      consent: { ...evidence, status: "held", reason: "market-price-stale", amount: null },
    });
    expect(db.query.mock.calls[0]![1]).toEqual(["off_fixture", "bop_fixture"]);
    const sql = db.query.mock.calls[0]![0];
    expect(sql).toContain("authorized.payload->>'revision' = policy.state->>'revision'");
    expect(sql).toContain("selected.value->>'offerId' = target.offer_id");
    expect(sql).toContain("ORDER BY authorized.stream_version DESC LIMIT 1");
    row.audit_evidence.marketPrice = {
      ...evidence.marketPrice,
      privateTerms: "not exported",
    } as typeof evidence.marketPrice;
    expect(JSON.stringify(await readManagedOfferFulfillmentAuthority(db, "off_fixture", "bop_fixture"))).not.toContain(
      "privateTerms",
    );
  });

  it("keeps absent authority operands explicit and propagates a failed diagnostic read", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            policy_status: null,
            policy_revision: null,
            policy_projection_version: null,
            policy_stream_version: null,
            audit_status: null,
            audit_reason: null,
            audit_stream_version: null,
            audit_evidence: null,
            consent_result: null,
          },
        ],
      })),
    };
    const result = await readManagedOfferFulfillmentAuthority(db, "off_fixture", "bop_fixture");
    for (const part of Object.values(result)) expect(Object.values(part).every((value) => value === null)).toBe(true);
    db.query.mockRejectedValueOnce(new Error("read failed"));
    await expect(readManagedOfferFulfillmentAuthority(db, "off_fixture", "bop_fixture")).rejects.toThrow("read failed");
  });
  it.each([
    { managed_status: "held" },
    { managed_status: "refresh_required" },
    { managed_status: "unavailable" },
    { seller_listing_availability_status: "unavailable" },
    { status: "paused" },
    { seller_available_quantity: 0 },
  ])("retains every fulfillment operand from the exact failed Match response: %j", (blocked) => {
    const match = {
      can_fulfill: false,
      managed_status: null,
      seller_listing_availability_status: "available",
      status: "submitted",
      seller_available_quantity: 2,
      quantity_requested: 2,
      price_amount: "135.00",
      listing_id: "lst_fixture",
      last_stream_version: 4,
      listing_stream_version: 2,
      listing_quantity_cap: 2,
      listing_visible_quantity: 2,
      ...blocked,
    };
    expect(
      managedOfferFulfillmentSnapshot({ ...match, shipping_destination_snapshot: { name: "Not retained" } }),
    ).toEqual(match);
  });

  it("makes missing fulfillment inputs explicit without inventing readiness", () => {
    const snapshot = managedOfferFulfillmentSnapshot({});
    expect(Object.keys(snapshot)).toHaveLength(12);
    expect(Object.values(snapshot)).toEqual(Array(12).fill(null));
  });

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
