import { describe, expect, it, vi } from "vitest";
import { buildSupportRequestProjectionHandlers } from "./projection";

const pendingOffer = {
  offerId: "sof_01",
  responseId: "rsp_offer",
  offeredByAccountId: "acc_seller",
  offeredByRole: "seller",
  pendingWithRole: "buyer",
  responseType: "offer-partial-refund",
  resolutionType: "partial-refund",
  refundAmount: "12.50",
  summary: "Seller offers a partial refund.",
  offeredAt: "2026-05-09T13:05:00.000Z",
  status: "pending",
  decidedByAccountId: null,
  decidedByRole: null,
  decidedAt: null,
  decisionSummary: null,
} as const;

describe("support request projection", () => {
  it("projects the affected line-item amount contract after the additive case event", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildSupportRequestProjectionHandlers(db);

    await handlers["support.support-request.affected-line-items-recorded"]?.({
      type: "support.support-request.affected-line-items-recorded",
      data: {
        supportRequestId: "sup_01",
        affectedLineItems: [{ lineId: "line_1", amount: "10.00", currencyCode: "usd" }],
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("affected_line_items = $2::jsonb"), [
      "sup_01",
      JSON.stringify([{ lineId: "line_1", amount: "10.00", currencyCode: "usd" }]),
    ]);
  });

  it("stores pending offer fields when an offer-bearing response is recorded", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildSupportRequestProjectionHandlers(db);

    await handlers["support.support-request.response-recorded"]?.({
      type: "support.support-request.response-recorded",
      data: {
        supportRequestId: "sup_01",
        response: {
          responseId: "rsp_offer",
          responseType: "offer-partial-refund",
          submittedByAccountId: "acc_seller",
          submittedByRole: "seller",
          summary: "Seller offers a partial refund.",
          submittedAt: "2026-05-09T13:05:00.000Z",
          offerId: "sof_01",
        },
        offer: pendingOffer,
        status: "waiting-on-buyer",
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("pending_offer = $5::jsonb"),
      expect.arrayContaining(["sup_01", "waiting-on-buyer", "2026-05-09T13:05:00.000Z", JSON.stringify(pendingOffer)]),
    );
  });

  it("clears pending offer and preserves accepted offer history before resolution projection runs", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildSupportRequestProjectionHandlers(db);
    const acceptedOffer = {
      ...pendingOffer,
      status: "accepted",
      decidedByAccountId: "acc_buyer",
      decidedByRole: "buyer",
      decidedAt: "2026-05-09T14:00:00.000Z",
      decisionSummary: "Offer accepted by the counterparty.",
    };

    await handlers["support.support-request.offer-accepted"]?.({
      type: "support.support-request.offer-accepted",
      data: {
        supportRequestId: "sup_01",
        offer: acceptedOffer,
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("pending_offer = NULL"), [
      "sup_01",
      "sof_01",
      "2026-05-09T14:00:00.000Z",
      JSON.stringify(acceptedOffer),
    ]);
  });

  it("records the escalator and reason when a support request is escalated", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildSupportRequestProjectionHandlers(db);

    await handlers["support.support-request.escalated"]?.({
      type: "support.support-request.escalated",
      data: {
        supportRequestId: "sup_01",
        escalatedAt: "2026-05-09T14:00:00.000Z",
        reason: "I still believe the item was misrepresented.",
        escalatedByAccountId: "acc_buyer",
        escalatedByRole: "buyer",
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("escalation_reason = $5"), [
      "sup_01",
      "2026-05-09T14:00:00.000Z",
      "acc_buyer",
      "buyer",
      "I still believe the item was misrepresented.",
    ]);
  });

  it("opens the return-refund gate on a return-for-refund resolution and leaves it null otherwise", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildSupportRequestProjectionHandlers(db);

    await handlers["support.support-request.resolved"]?.({
      type: "support.support-request.resolved",
      data: {
        supportRequestId: "sup_01",
        resolution: {
          resolutionType: "return-for-refund",
          summary: "Seller accepted the return.",
          refundAmount: null,
          resolvedByAccountId: "acc_seller",
          resolvedByRole: "seller",
          resolvedAt: "2026-05-09T14:00:00.000Z",
        },
        autoCloseDueAt: "2026-05-16T14:00:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("return_refund_gate_status = $5"), [
      "sup_01",
      "2026-05-09T14:00:00.000Z",
      expect.stringContaining("return-for-refund"),
      "2026-05-16T14:00:00.000Z",
      "awaiting-return-delivery",
    ]);

    await handlers["support.support-request.resolved"]?.({
      type: "support.support-request.resolved",
      data: {
        supportRequestId: "sup_02",
        resolution: {
          resolutionType: "full-refund",
          summary: "Delivery could not be proven.",
          refundAmount: null,
          resolvedByAccountId: null,
          resolvedByRole: null,
          resolvedAt: "2026-05-09T14:00:00.000Z",
        },
        autoCloseDueAt: "2026-05-16T14:00:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("return_refund_gate_status = $5"), [
      "sup_02",
      "2026-05-09T14:00:00.000Z",
      expect.stringContaining("full-refund"),
      "2026-05-16T14:00:00.000Z",
      null,
    ]);
  });

  it("records return delivery, condition disputes, and refund release on the read model", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildSupportRequestProjectionHandlers(db);

    await handlers["support.support-request.return-delivered"]?.({
      type: "support.support-request.return-delivered",
      data: {
        supportRequestId: "sup_01",
        deliveredAt: "2026-06-01T00:00:00.000Z",
        returnRefundReleaseDueAt: "2026-06-06T00:00:00.000Z",
      },
    } as never);
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("awaiting-return-inspection"), [
      "sup_01",
      "2026-06-01T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
    ]);

    await handlers["support.support-request.return-condition-disputed"]?.({
      type: "support.support-request.return-condition-disputed",
      data: {
        supportRequestId: "sup_01",
        disputedAt: "2026-06-02T00:00:00.000Z",
      },
    } as never);
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("return-condition-disputed"), [
      "sup_01",
      "2026-06-02T00:00:00.000Z",
    ]);

    await handlers["support.support-request.return-refund-released"]?.({
      type: "support.support-request.return-refund-released",
      data: {
        supportRequestId: "sup_01",
      },
    } as never);
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("return-refund-released"), ["sup_01"]);
  });
});
