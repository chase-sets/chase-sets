import { describe, expect, it } from "vitest";
import { adjudicationRefundCap, adjudicationRefundPrefill } from "./case-adjudication-panel";
import type { SupportRequestDetail } from "./contracts";

function detail(overrides: Partial<SupportRequestDetail> = {}): SupportRequestDetail {
  return {
    affected_line_items: [],
    offers: [],
    pending_offer: null,
    ...(overrides as SupportRequestDetail),
  } as SupportRequestDetail;
}

describe("adjudication refund helpers", () => {
  it("caps the refund at the summed affected-line amounts", () => {
    expect(
      adjudicationRefundCap(
        detail({
          affected_line_items: [
            { lineId: "l1", amount: "40.00", currencyCode: "usd" },
            { lineId: "l2", amount: "10.50", currencyCode: "usd" },
          ],
        }),
      ),
    ).toBe("50.50");
  });

  it("returns no cap when there is no affected-line snapshot", () => {
    expect(adjudicationRefundCap(detail())).toBeNull();
    expect(adjudicationRefundPrefill(detail())).toBeNull();
  });

  it("prefills the most recent offer's refund when it is within the cap", () => {
    const prefill = adjudicationRefundPrefill(
      detail({
        affected_line_items: [{ lineId: "l1", amount: "40.00", currencyCode: "usd" }],
        offers: [
          {
            offerId: "o1",
            responseId: "r1",
            offeredByAccountId: null,
            offeredByRole: "seller",
            pendingWithRole: "buyer",
            responseType: "offer-partial-refund",
            resolutionType: "partial-refund",
            refundAmount: "10.00",
            summary: "early",
            offeredAt: "2026-06-01T01:00:00.000Z",
            status: "declined",
            decidedByAccountId: null,
            decidedByRole: "buyer",
            decidedAt: "2026-06-01T02:00:00.000Z",
            decisionSummary: null,
          },
          {
            offerId: "o2",
            responseId: "r2",
            offeredByAccountId: null,
            offeredByRole: "seller",
            pendingWithRole: "buyer",
            responseType: "offer-partial-refund",
            resolutionType: "partial-refund",
            refundAmount: "15.00",
            summary: "latest",
            offeredAt: "2026-06-01T03:00:00.000Z",
            status: "declined",
            decidedByAccountId: null,
            decidedByRole: "buyer",
            decidedAt: "2026-06-01T04:00:00.000Z",
            decisionSummary: null,
          },
        ],
      }),
    );
    expect(prefill).toBe("15.00");
  });

  it("clamps an offer that exceeds the cap back down to the cap", () => {
    const prefill = adjudicationRefundPrefill(
      detail({
        affected_line_items: [{ lineId: "l1", amount: "20.00", currencyCode: "usd" }],
        offers: [
          {
            offerId: "o1",
            responseId: "r1",
            offeredByAccountId: null,
            offeredByRole: "seller",
            pendingWithRole: "buyer",
            responseType: "offer-partial-refund",
            resolutionType: "partial-refund",
            refundAmount: "99.00",
            summary: "over cap",
            offeredAt: "2026-06-01T03:00:00.000Z",
            status: "declined",
            decidedByAccountId: null,
            decidedByRole: "buyer",
            decidedAt: "2026-06-01T04:00:00.000Z",
            decisionSummary: null,
          },
        ],
      }),
    );
    expect(prefill).toBe("20.00");
  });
});
