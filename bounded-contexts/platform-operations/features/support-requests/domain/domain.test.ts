import { describe, expect, it } from "vitest";
import {
  decideSupportRequest,
  evolveSupportRequest,
  initialSupportRequestState,
  type SupportRequestEvent,
  type SupportRequestState,
} from "./domain";

function fold(events: readonly SupportRequestEvent[]): SupportRequestState {
  return events.reduce(evolveSupportRequest, initialSupportRequestState);
}

const openedAt = "2026-05-09T12:00:00.000Z";

function openProductNotReceived() {
  return decideSupportRequest(initialSupportRequestState, {
    type: "OpenSupportRequest",
    supportRequestId: "sup_01" as never,
    orderId: "ord_01" as never,
    orderTotalAmount: "25.00",
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    flowType: "product-not-received",
    openedByAccountId: "acc_buyer" as never,
    openedByRole: "buyer",
    openedAt,
  });
}

function openProductNotAsDescribed() {
  return decideSupportRequest(initialSupportRequestState, {
    type: "OpenSupportRequest",
    supportRequestId: "sup_described" as never,
    orderId: "ord_01" as never,
    orderTotalAmount: "25.00",
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    flowType: "product-not-as-described",
    openedByAccountId: "acc_buyer" as never,
    openedByRole: "buyer",
    openedAt,
  });
}

function openReturnRequest(orderTotalAmount = "249.99") {
  return decideSupportRequest(initialSupportRequestState, {
    type: "OpenSupportRequest",
    supportRequestId: "sup_return" as never,
    orderId: "ord_01" as never,
    orderTotalAmount,
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    flowType: "return-request",
    openedByAccountId: "acc_buyer" as never,
    openedByRole: "buyer",
    openedAt,
    orderReturnContext: [
      {
        lineId: "line_1",
        listingId: "lst_1",
        itemTitle: "Charizard",
        productSummary: "Base Set",
        quantity: 1,
        gradedCard: {
          gradingCompany: "PSA",
          grade: "10",
          certificationNumber: "81234567",
        },
      },
    ],
  });
}

function submitReturnEvidence(state: SupportRequestState) {
  const reason = decideSupportRequest(state, {
    type: "SubmitSupportEvidence",
    evidenceId: "ev_reason",
    submittedByAccountId: "acc_buyer" as never,
    submittedByRole: "buyer",
    evidenceType: "return-reason",
    summary: "Changed mind within the return window.",
    submittedAt: "2026-05-09T13:00:00.000Z",
  });
  const afterReason = fold([...openReturnRequest(), ...reason]);
  const photo = decideSupportRequest(afterReason, {
    type: "SubmitSupportEvidence",
    evidenceId: "ev_photo",
    submittedByAccountId: "acc_buyer" as never,
    submittedByRole: "buyer",
    evidenceType: "photo",
    summary: "As-received front and back photos.",
    attachments: ["att_front", "att_back"],
    submittedAt: "2026-05-09T13:05:00.000Z",
  });
  const afterPhoto = fold([...openReturnRequest(), ...reason, ...photo]);
  const notes = decideSupportRequest(afterPhoto, {
    type: "SubmitSupportEvidence",
    evidenceId: "ev_notes",
    submittedByAccountId: "acc_buyer" as never,
    submittedByRole: "buyer",
    evidenceType: "condition-notes",
    summary: "Card appears unchanged from delivery.",
    submittedAt: "2026-05-09T13:10:00.000Z",
  });

  return [...reason, ...photo, ...notes];
}

function recordPartialRefundOffer(state: SupportRequestState, refundAmount = "12.50") {
  return decideSupportRequest(state, {
    type: "RecordSupportResponse",
    responseId: "rsp_offer",
    offerId: "sof_01",
    submittedByAccountId: "acc_seller" as never,
    submittedByRole: "seller",
    responseType: "offer-partial-refund",
    offerResolutionType: "partial-refund",
    refundAmount,
    summary: "Seller offers a partial refund to resolve the issue.",
    submittedAt: "2026-05-09T13:05:00.000Z",
  });
}

describe("support request domain", () => {
  it("opens product-not-received with seller response deadline and required tracking checklist", () => {
    const events = openProductNotReceived();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("support.support-request.opened");
    expect(events[0]?.data).toMatchObject({
      flowType: "product-not-received",
      status: "waiting-on-seller",
      priority: "normal",
      sellerResponseDueAt: "2026-05-11T12:00:00.000Z",
      supportReviewDueAt: "2026-05-10T12:00:00.000Z",
    });
    expect(events[0]).toMatchObject({
      data: {
        checklist: [{ key: "buyer-attestation" }, { key: "delivery-evidence" }],
      },
    });
  });

  it("accepts tracking evidence and moves toward support-ready seller response", () => {
    const opened = openProductNotReceived();
    const state = fold(opened);
    const evidenceEvents = decideSupportRequest(state, {
      type: "SubmitSupportEvidence",
      evidenceId: "ev_tracking",
      submittedByAccountId: "acc_seller" as never,
      submittedByRole: "seller",
      evidenceType: "tracking-number",
      summary: "USPS 9400 tracking number added.",
      submittedAt: "2026-05-09T13:00:00.000Z",
    });
    const afterEvidence = fold([...opened, ...evidenceEvents]);
    const responseEvents = decideSupportRequest(afterEvidence, {
      type: "RecordSupportResponse",
      responseId: "rsp_tracking",
      submittedByAccountId: "acc_seller" as never,
      submittedByRole: "seller",
      responseType: "provide-tracking",
      summary: "Tracking proves shipment is still moving.",
      submittedAt: "2026-05-09T13:05:00.000Z",
    });

    expect(afterEvidence.evidence).toHaveLength(1);
    expect(afterEvidence.checklist.find((item) => item.key === "delivery-evidence")?.satisfiedAt).toBe(
      "2026-05-09T13:00:00.000Z",
    );
    expect(responseEvents[0]).toMatchObject({ data: { status: "ready-for-support" } });
  });

  it("routes authenticity concerns directly to urgent support review", () => {
    const events = decideSupportRequest(initialSupportRequestState, {
      type: "OpenSupportRequest",
      supportRequestId: "sup_auth" as never,
      orderId: "ord_01" as never,
      orderTotalAmount: "25.00",
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      flowType: "authenticity-concern",
      openedByAccountId: "acc_buyer" as never,
      openedByRole: "buyer",
      openedAt,
    });

    expect(events[0]?.data).toMatchObject({
      status: "ready-for-support",
      priority: "urgent",
      sellerResponseDueAt: "2026-05-10T12:00:00.000Z",
      supportReviewDueAt: "2026-05-10T00:00:00.000Z",
    });
  });

  it("requires return-request photo evidence with attachments before refund resolution", () => {
    const opened = openReturnRequest();
    const state = fold(opened);

    expect(opened[0]).toMatchObject({
      data: {
        flowType: "return-request",
        checklist: expect.arrayContaining([
          expect.objectContaining({ key: "return-reason", required: true }),
          expect.objectContaining({ key: "return-condition-evidence", required: true }),
        ]),
        orderReturnContext: [
          {
            gradedCard: {
              certificationNumber: "81234567",
            },
          },
        ],
      },
    });
    expect(() =>
      decideSupportRequest(state, {
        type: "SubmitSupportEvidence",
        evidenceId: "ev_photo",
        submittedByAccountId: "acc_buyer" as never,
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: "Photo evidence without an asset.",
        submittedAt: "2026-05-09T13:00:00.000Z",
      }),
    ).toThrow("Return photo evidence requires at least one attachment.");
    expect(() =>
      decideSupportRequest(state, {
        type: "ResolveSupportRequest",
        resolutionType: "return-for-refund",
        summary: "Refund approved.",
        resolvedByAccountId: "acc_support" as never,
        resolvedByRole: "support",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      }),
    ).toThrow("Return refund resolution requires completed return evidence.");
  });

  it("routes return requests at the high-value threshold to support review", () => {
    const below = openReturnRequest("249.99");
    const atThreshold = openReturnRequest("250.00");

    expect(below[0]).toMatchObject({ data: { status: "waiting-on-seller" } });
    expect(atThreshold[0]).toMatchObject({ data: { status: "ready-for-support" } });
  });

  it("requires support review before high-value return refund release", () => {
    const opened = openReturnRequest("250.00");
    const evidence = submitReturnEvidence(fold(opened));
    const state = fold([...opened, ...evidence]);

    expect(() =>
      decideSupportRequest(state, {
        type: "ResolveSupportRequest",
        resolutionType: "return-for-refund",
        summary: "Buyer and seller agreed.",
        resolvedByAccountId: "acc_seller" as never,
        resolvedByRole: "seller",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      }),
    ).toThrow("High-value return refunds require support review.");

    expect(
      decideSupportRequest(state, {
        type: "ResolveSupportRequest",
        resolutionType: "return-for-refund",
        summary: "Support reviewed the high-value return.",
        resolvedByAccountId: "acc_support" as never,
        resolvedByRole: "support",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      }),
    ).toHaveLength(1);
  });

  it("opens seller condition-attestation after return delivery and converts discrepancies to support review", () => {
    const opened = openReturnRequest();
    const evidence = submitReturnEvidence(fold(opened));
    const ready = fold([...opened, ...evidence]);
    const delivered = decideSupportRequest(ready, {
      type: "SubmitSupportEvidence",
      evidenceId: "ev_return_delivery",
      submittedByAccountId: "acc_support" as never,
      submittedByRole: "support",
      evidenceType: "return-delivery-confirmation",
      summary: "Return delivery scan confirmed.",
      submittedAt: "2026-05-12T12:00:00.000Z",
    });
    const awaitingSeller = fold([...opened, ...evidence, ...delivered]);

    expect(awaitingSeller.sellerConditionAttestationDueAt).toBe("2026-05-15T12:00:00.000Z");
    expect(awaitingSeller.checklist).toContainEqual(
      expect.objectContaining({
        key: "seller-return-condition-attestation",
        satisfiedAt: null,
      }),
    );

    const discrepancy = decideSupportRequest(awaitingSeller, {
      type: "SubmitSupportEvidence",
      evidenceId: "ev_discrepancy",
      submittedByAccountId: "acc_seller" as never,
      submittedByRole: "seller",
      evidenceType: "return-discrepancy-photo",
      summary: "Returned card has a different certification number.",
      attachments: ["att_discrepancy"],
      submittedAt: "2026-05-12T13:00:00.000Z",
    });
    const converted = fold([...opened, ...evidence, ...delivered, ...discrepancy]);

    expect(discrepancy[0]).toMatchObject({
      data: {
        status: "ready-for-support",
        priority: "urgent",
        returnInvestigation: { reason: "seller-condition-discrepancy" },
      },
    });
    expect(converted.status).toBe("ready-for-support");
    expect(converted.returnInvestigation).toMatchObject({ reason: "seller-condition-discrepancy" });
  });

  it("rejects flow evidence that would make the workflow ambiguous", () => {
    const state = fold(openProductNotReceived());

    expect(() =>
      decideSupportRequest(state, {
        type: "SubmitSupportEvidence",
        evidenceId: "ev_1",
        submittedByAccountId: "acc_buyer" as never,
        submittedByRole: "buyer",
        evidenceType: "payment-error",
        summary: "The charge failed.",
        submittedAt: "2026-05-09T13:00:00.000Z",
      }),
    ).toThrow("This evidence type is not accepted for the support flow.");
  });

  it("records a seller partial-refund offer and waits on the buyer", () => {
    const state = fold(openProductNotAsDescribed());
    const events = recordPartialRefundOffer(state);
    const afterOffer = fold([...openProductNotAsDescribed(), ...events]);

    expect(events[0]).toMatchObject({
      type: "support.support-request.response-recorded",
      data: {
        status: "waiting-on-buyer",
        offer: {
          offerId: "sof_01",
          responseId: "rsp_offer",
          pendingWithRole: "buyer",
          resolutionType: "partial-refund",
          refundAmount: "12.50",
          status: "pending",
        },
      },
    });
    expect(afterOffer.status).toBe("waiting-on-buyer");
    expect(afterOffer.pendingOffer?.offerId).toBe("sof_01");
    expect(afterOffer.offers).toHaveLength(1);
  });

  it("rejects partial refund offers above the support request order total", () => {
    const state = fold(openProductNotAsDescribed());

    expect(() => recordPartialRefundOffer(state, "25.01")).toThrow(
      "Offer refund amount cannot exceed the order total.",
    );
  });

  it("rejects offer resolution types that do not match the response or flow", () => {
    const state = fold(openProductNotAsDescribed());

    expect(() =>
      decideSupportRequest(state, {
        type: "RecordSupportResponse",
        responseId: "rsp_offer",
        offerId: "sof_01",
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        offerResolutionType: "replacement",
        summary: "Seller offers a replacement.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      }),
    ).toThrow("Offer resolution does not match the response type.");
  });

  it("accepts a pending offer and resolves through the existing support resolution event", () => {
    const opened = openProductNotAsDescribed();
    const offered = recordPartialRefundOffer(fold(opened));
    const state = fold([...opened, ...offered]);

    const accepted = decideSupportRequest(state, {
      type: "AcceptSupportOffer",
      offerId: "sof_01",
      acceptedByAccountId: "acc_buyer" as never,
      acceptedByRole: "buyer",
      acceptedAt: "2026-05-09T14:00:00.000Z",
    });

    expect(accepted.map((event) => event.type)).toEqual([
      "support.support-request.offer-accepted",
      "support.support-request.resolved",
    ]);
    expect(accepted[1]).toMatchObject({
      data: {
        resolution: {
          resolutionType: "partial-refund",
          refundAmount: "12.50",
          resolvedByAccountId: "acc_buyer",
          resolvedAt: "2026-05-09T14:00:00.000Z",
        },
      },
    });
    expect(fold([...opened, ...offered, ...accepted])).toMatchObject({
      status: "resolved",
      pendingOffer: null,
      resolution: { resolutionType: "partial-refund", refundAmount: "12.50" },
    });
  });

  it("declines a pending offer and routes the request to support with offer history intact", () => {
    const opened = openProductNotAsDescribed();
    const offered = recordPartialRefundOffer(fold(opened));
    const state = fold([...opened, ...offered]);

    const declined = decideSupportRequest(state, {
      type: "DeclineSupportOffer",
      offerId: "sof_01",
      declinedByAccountId: "acc_buyer" as never,
      declinedByRole: "buyer",
      declinedAt: "2026-05-09T14:00:00.000Z",
      summary: "I need support to review the case.",
    });
    const afterDecline = fold([...opened, ...offered, ...declined]);

    expect(declined[0]).toMatchObject({
      type: "support.support-request.offer-declined",
      data: { status: "ready-for-support", offer: { offerId: "sof_01", status: "declined" } },
    });
    expect(afterDecline.status).toBe("ready-for-support");
    expect(afterDecline.pendingOffer).toBeNull();
    expect(afterDecline.offers).toMatchObject([{ offerId: "sof_01", status: "declined" }]);
  });

  it("rejects accepting offers on terminal support requests", () => {
    const opened = openProductNotAsDescribed();
    const offered = recordPartialRefundOffer(fold(opened));
    const accepted = decideSupportRequest(fold([...opened, ...offered]), {
      type: "AcceptSupportOffer",
      offerId: "sof_01",
      acceptedByAccountId: "acc_buyer" as never,
      acceptedByRole: "buyer",
      acceptedAt: "2026-05-09T14:00:00.000Z",
    });
    const resolved = fold([...opened, ...offered, ...accepted]);

    expect(() =>
      decideSupportRequest(resolved, {
        type: "AcceptSupportOffer",
        offerId: "sof_01",
        acceptedByAccountId: "acc_buyer" as never,
        acceptedByRole: "buyer",
        acceptedAt: "2026-05-09T14:05:00.000Z",
      }),
    ).toThrow("Closed support requests cannot accept offers.");
  });

  it("resolves buyer cancellation when the seller confirms cancellation", () => {
    const opened = decideSupportRequest(initialSupportRequestState, {
      type: "OpenSupportRequest",
      supportRequestId: "sup_cancel" as never,
      orderId: "ord_01" as never,
      orderTotalAmount: "25.00",
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      flowType: "buyer-cancel-request",
      openedByAccountId: "acc_buyer" as never,
      openedByRole: "buyer",
      openedAt,
    });

    const events = decideSupportRequest(fold(opened), {
      type: "RecordSupportResponse",
      responseId: "rsp_cancel",
      submittedByAccountId: "acc_seller" as never,
      submittedByRole: "seller",
      responseType: "confirm-cancellation",
      summary: "Seller confirms cancellation.",
      submittedAt: "2026-05-09T13:05:00.000Z",
    });

    expect(events.map((event) => event.type)).toEqual([
      "support.support-request.response-recorded",
      "support.support-request.resolved",
    ]);
    expect(events[1]).toMatchObject({
      data: {
        resolution: {
          resolutionType: "cancel-order",
          refundAmount: null,
          resolvedByAccountId: "acc_seller",
        },
      },
    });
  });

  it("keeps cancellation and seller fulfillment failures as explicit common flows", () => {
    const buyerCancel = decideSupportRequest(initialSupportRequestState, {
      type: "OpenSupportRequest",
      supportRequestId: "sup_cancel" as never,
      orderId: "ord_01" as never,
      orderTotalAmount: "25.00",
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      flowType: "buyer-cancel-request",
      openedByAccountId: "acc_buyer" as never,
      openedByRole: "buyer",
      openedAt,
    });
    const sellerCannotFulfill = decideSupportRequest(initialSupportRequestState, {
      type: "OpenSupportRequest",
      supportRequestId: "sup_fulfill" as never,
      orderId: "ord_01" as never,
      orderTotalAmount: "25.00",
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      flowType: "seller-cannot-fulfill",
      openedByAccountId: "acc_seller" as never,
      openedByRole: "seller",
      openedAt,
    });

    expect(buyerCancel[0]).toMatchObject({ data: { status: "waiting-on-seller" } });
    expect(sellerCannotFulfill[0]).toMatchObject({ data: { status: "ready-for-support", priority: "urgent" } });
  });
});
