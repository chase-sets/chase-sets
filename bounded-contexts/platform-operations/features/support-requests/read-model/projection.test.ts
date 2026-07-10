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
});
