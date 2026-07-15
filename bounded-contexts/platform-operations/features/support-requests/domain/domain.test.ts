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

function operatorFinding(flowType: string, responsibility: string, reason: string) {
  return {
    responsibility,
    evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
    responsibilityReasonCode: `${flowType}.${reason}`,
  };
}

function sellerSilenceFact(flowType: string) {
  return {
    responsibility: "undetermined",
    evidenceBasis: { type: "deterministic-policy", reference: "support-policy.seller-response-deadline.v1" },
    responsibilityReasonCode: `${flowType}.seller-response-deadline-expired`,
  };
}

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

function openProductNotAsDescribedWithLines(
  affectedLineItems = [
    { lineId: "line_1", amount: "10.10", currencyCode: "usd" },
    { lineId: "line_2", amount: "5.05", currencyCode: "usd" },
  ],
) {
  return decideSupportRequest(initialSupportRequestState, {
    type: "OpenSupportRequest",
    supportRequestId: "sup_lines" as never,
    orderId: "ord_01" as never,
    orderTotalAmount: "25.00",
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    flowType: "product-not-as-described",
    openedByAccountId: "acc_buyer" as never,
    openedByRole: "buyer",
    openedAt,
    affectedLineItems: affectedLineItems as never,
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

function openWithAffectedLineItems(
  affectedLineItems: readonly { lineId: string; amount: string; currencyCode: string }[],
) {
  return decideSupportRequest(initialSupportRequestState, {
    type: "OpenSupportRequest",
    supportRequestId: "sup_lines" as never,
    orderId: "ord_01" as never,
    orderTotalAmount: "25.00",
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    flowType: "product-not-as-described",
    openedByAccountId: "acc_buyer" as never,
    openedByRole: "buyer",
    openedAt,
    affectedLineItems,
  });
}

describe("support request domain", () => {
  it("records affected line amounts in a separate additive event", () => {
    const events = openWithAffectedLineItems([{ lineId: "line_1", amount: "10.00", currencyCode: "usd" }]);

    expect(events.map((event) => event.type)).toEqual([
      "support.support-request.opened",
      "support.support-request.affected-line-items-recorded",
    ]);
    expect(fold(events).affectedLineItems).toEqual([{ lineId: "line_1", amount: "10.00", currencyCode: "usd" }]);
  });

  it("caps offers at the selected affected line totals", () => {
    const state = fold(
      openWithAffectedLineItems([
        { lineId: "line_1", amount: "10.00", currencyCode: "usd" },
        { lineId: "line_2", amount: "5.00", currencyCode: "usd" },
      ]),
    );

    expect(() =>
      decideSupportRequest(state, {
        type: "RecordSupportResponse",
        responseId: "rsp_over_cap",
        offerId: "sof_over_cap",
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        offerResolutionType: "partial-refund",
        refundAmount: "15.01",
        affectedLineIds: ["line_1", "line_2"],
        summary: "Over-cap offer.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      }),
    ).toThrow("Refund amount cannot exceed affected line totals.");
  });

  it("rejects mixed-currency and unrelated-line offers", () => {
    const mixedCurrencyState = fold(
      openWithAffectedLineItems([
        { lineId: "line_1", amount: "10.00", currencyCode: "usd" },
        { lineId: "line_2", amount: "5.00", currencyCode: "eur" },
      ]),
    );

    expect(() =>
      decideSupportRequest(mixedCurrencyState, {
        type: "RecordSupportResponse",
        responseId: "rsp_mixed",
        offerId: "sof_mixed",
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        offerResolutionType: "partial-refund",
        refundAmount: "10.00",
        affectedLineIds: ["line_1", "line_2"],
        summary: "Mixed currency offer.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      }),
    ).toThrow("Affected line items must use one currency.");

    const singleCurrencyState = fold(
      openWithAffectedLineItems([{ lineId: "line_1", amount: "10.00", currencyCode: "usd" }]),
    );
    expect(() =>
      decideSupportRequest(singleCurrencyState, {
        type: "RecordSupportResponse",
        responseId: "rsp_unrelated",
        offerId: "sof_unrelated",
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        offerResolutionType: "partial-refund",
        refundAmount: "1.00",
        affectedLineIds: ["line_other"],
        summary: "Unrelated line offer.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      }),
    ).toThrow("Offer references a line item outside the support request.");
  });

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

  it("stamps deadlines from a resolved policy override at open time instead of the flow catalog default", () => {
    const events = decideSupportRequest(initialSupportRequestState, {
      type: "OpenSupportRequest",
      supportRequestId: "sup_override" as never,
      orderId: "ord_01" as never,
      orderTotalAmount: "25.00",
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      flowType: "product-not-received",
      openedByAccountId: "acc_buyer" as never,
      openedByRole: "buyer",
      openedAt,
      sellerResponseHours: 72,
      supportReviewHours: 6,
    });

    expect(events[0]?.data).toMatchObject({
      // 72h and 6h from the resolved override, not the catalog's 48h/24h.
      sellerResponseDueAt: "2026-05-12T12:00:00.000Z",
      supportReviewDueAt: "2026-05-09T18:00:00.000Z",
    });
  });

  it("falls back to the flow catalog's compiled default when no override is provided (seeds, pre-policy call sites)", () => {
    const events = openProductNotReceived();

    expect(events[0]?.data).toMatchObject({
      sellerResponseDueAt: "2026-05-11T12:00:00.000Z",
      supportReviewDueAt: "2026-05-10T12:00:00.000Z",
    });
  });

  it("rejects an override that introduces a seller-response phase for a flow with none structurally", () => {
    expect(() =>
      decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: "sup_bad_override" as never,
        orderId: "ord_01" as never,
        orderTotalAmount: "25.00",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        // seller-cannot-fulfill has no seller-response phase (sellerResponseHours is null in the catalog).
        flowType: "seller-cannot-fulfill",
        openedByAccountId: "acc_seller" as never,
        openedByRole: "seller",
        openedAt,
        sellerResponseHours: 24,
      }),
    ).toThrow("This support flow has no seller-response phase; seller response hours must stay null.");
  });

  it("does not retroactively change an already-opened request's deadlines (fairness invariant)", () => {
    // A request opened under the compiled catalog default...
    const openedUnderDefault = fold(openProductNotReceived());
    expect(openedUnderDefault.sellerResponseDueAt).toBe("2026-05-11T12:00:00.000Z");

    // ...is untouched by a later policy revision: decideSupportRequest never
    // re-reads the policy for an existing aggregate. Only a brand-new
    // OpenSupportRequest command carrying the newly resolved override
    // produces different deadlines.
    const openedUnderRevisedPolicy = decideSupportRequest(initialSupportRequestState, {
      type: "OpenSupportRequest",
      supportRequestId: "sup_after_revision" as never,
      orderId: "ord_02" as never,
      orderTotalAmount: "25.00",
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      flowType: "product-not-received",
      openedByAccountId: "acc_buyer" as never,
      openedByRole: "buyer",
      openedAt,
      sellerResponseHours: 96,
      supportReviewHours: 24,
    });

    expect(openedUnderDefault.sellerResponseDueAt).toBe("2026-05-11T12:00:00.000Z");
    expect(openedUnderRevisedPolicy[0]?.data).toMatchObject({ sellerResponseDueAt: "2026-05-13T12:00:00.000Z" });
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
        ...operatorFinding("return-request", "buyer", "buyer-remorse"),
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
        ...operatorFinding("return-request", "buyer", "buyer-remorse"),
        resolutionType: "return-for-refund",
        summary: "Buyer and seller agreed.",
        resolvedByAccountId: "acc_seller" as never,
        resolvedByRole: "seller",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      }),
    ).toThrow("High-value return refunds require support review.");

    const events = decideSupportRequest(state, {
      type: "ResolveSupportRequest",
      ...operatorFinding("return-request", "buyer", "buyer-remorse"),
      resolutionType: "return-for-refund",
      summary: "Support reviewed the high-value return.",
      resolvedByAccountId: "acc_support" as never,
      resolvedByRole: "support",
      resolvedAt: "2026-05-09T14:00:00.000Z",
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "platform-operations.csat-outcome-fact.v1",
      data: { outcomeCode: "return.resolved" },
    });
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

  it("publishes and evolves the additive affected line-item amount fact", () => {
    const events = openProductNotAsDescribedWithLines();

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("support.support-request.opened");
    expect(events[1]).toMatchObject({
      type: "support.support-request.affected-line-items-recorded",
      data: {
        affectedLineItems: [
          { lineId: "line_1", amount: "10.10", currencyCode: "usd" },
          { lineId: "line_2", amount: "5.05", currencyCode: "usd" },
        ],
      },
    });
    expect(fold(events).affectedLineItems).toHaveLength(2);
  });

  it("caps partial refund offers at the selected line totals using integer cents", () => {
    const opened = openProductNotAsDescribedWithLines();
    const state = fold(opened);

    expect(() => recordPartialRefundOffer(state, "15.16")).toThrow("affected line totals");
    const offerEvents = recordPartialRefundOffer(state, "15.15");
    expect(offerEvents[0]).toMatchObject({ data: { offer: { refundAmount: "15.15" } } });
  });

  it("rejects unrelated and mixed-currency offer line selections", () => {
    const opened = openProductNotAsDescribedWithLines();
    const state = fold(opened);

    expect(() =>
      decideSupportRequest(state, {
        type: "RecordSupportResponse",
        responseId: "rsp_unrelated",
        offerId: "sof_unrelated",
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        offerResolutionType: "partial-refund",
        refundAmount: "1.00",
        affectedLineIds: ["line_missing"],
        summary: "Unrelated line.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      }),
    ).toThrow("outside the support request");

    const mixedState = fold(
      openProductNotAsDescribedWithLines([
        { lineId: "line_usd", amount: "10.00", currencyCode: "usd" },
        { lineId: "line_eur", amount: "10.00", currencyCode: "eur" },
      ]),
    );
    expect(() => recordPartialRefundOffer(mixedState, "1.00")).toThrow("one currency");
  });

  it("applies the same affected-line cap to support adjudication", () => {
    const state = fold(openProductNotAsDescribedWithLines());

    expect(() =>
      decideSupportRequest(state, {
        type: "ResolveSupportRequest",
        ...operatorFinding("product-not-as-described", "seller", "seller-misdescription"),
        resolutionType: "partial-refund",
        summary: "Adjudicated refund.",
        refundAmount: "15.16",
        resolvedByAccountId: "acc_support" as never,
        resolvedByRole: "support",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      }),
    ).toThrow("affected line totals");
  });

  it("emits a carrier-loss refund with carrier responsibility independently from the remedy", () => {
    const events = decideSupportRequest(fold(openProductNotReceived()), {
      type: "ResolveSupportRequest",
      ...operatorFinding("product-not-received", "carrier", "carrier-loss"),
      resolutionType: "full-refund",
      summary: "Carrier confirmed the shipment was lost.",
      resolvedByAccountId: "acc_support" as never,
      resolvedByRole: "support",
      resolvedAt: "2026-05-09T14:00:00.000Z",
    });

    expect(events[0]).toMatchObject({
      data: {
        resolution: {
          resolutionType: "full-refund",
          responsibility: "carrier",
          responsibilityReasonCode: "product-not-received.carrier-loss",
        },
      },
    });
  });

  it("emits a seller-misdescription refund with seller responsibility", () => {
    const events = decideSupportRequest(fold(openProductNotAsDescribed()), {
      type: "ResolveSupportRequest",
      ...operatorFinding("product-not-as-described", "seller", "seller-misdescription"),
      resolutionType: "partial-refund",
      refundAmount: "10.00",
      summary: "Listing materially misdescribed the product.",
      resolvedByAccountId: "acc_support" as never,
      resolvedByRole: "support",
      resolvedAt: "2026-05-09T14:00:00.000Z",
    });

    expect(events[0]).toMatchObject({
      data: { resolution: { refundAmount: "10.00", responsibility: "seller" } },
    });
  });

  it("emits a buyer-remorse return refund with buyer responsibility", () => {
    const opened = openReturnRequest();
    const evidence = submitReturnEvidence(fold(opened));
    const events = decideSupportRequest(fold([...opened, ...evidence]), {
      type: "ResolveSupportRequest",
      ...operatorFinding("return-request", "buyer", "buyer-remorse"),
      resolutionType: "return-for-refund",
      summary: "Buyer changed their mind.",
      resolvedByAccountId: "acc_support" as never,
      resolvedByRole: "support",
      resolvedAt: "2026-05-09T14:00:00.000Z",
    });

    expect(events[0]).toMatchObject({
      data: { resolution: { resolutionType: "return-for-refund", responsibility: "buyer" } },
    });
  });

  it("converges duplicate resolution delivery without changing the selected fact", () => {
    const opened = openProductNotReceived();
    const command = {
      type: "ResolveSupportRequest" as const,
      ...operatorFinding("product-not-received", "carrier", "carrier-loss"),
      resolutionType: "full-refund" as const,
      summary: "Carrier confirmed the shipment was lost.",
      resolvedByAccountId: "acc_support" as never,
      resolvedByRole: "support" as const,
      resolvedAt: "2026-05-09T14:00:00.000Z",
    };
    const resolved = decideSupportRequest(fold(opened), command);

    expect(decideSupportRequest(fold([...opened, ...resolved]), command)).toEqual([]);
    expect(fold([...opened, ...resolved]).resolution).toMatchObject({
      responsibility: "carrier",
      responsibilityReasonCode: "product-not-received.carrier-loss",
    });
    expect(() =>
      decideSupportRequest(fold([...opened, ...resolved]), {
        ...command,
        ...operatorFinding("product-not-received", "seller", "seller-did-not-ship"),
      }),
    ).toThrow("Support request already has a different resolution.");
  });

  it("reserves direct adjudication facts for support while party agreement resolves through offers", () => {
    expect(() =>
      decideSupportRequest(fold(openProductNotReceived()), {
        type: "ResolveSupportRequest",
        ...operatorFinding("product-not-received", "seller", "seller-did-not-ship"),
        resolutionType: "full-refund",
        summary: "Seller attempted a direct finding.",
        resolvedByAccountId: "acc_seller" as never,
        resolvedByRole: "seller",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      }),
    ).toThrow("Only support can adjudicate a support request directly.");
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
      "platform-operations.csat-outcome-fact.v1",
    ]);
    expect(accepted[1]).toMatchObject({
      data: {
        resolution: {
          resolutionType: "partial-refund",
          refundAmount: "12.50",
          resolvedByAccountId: "acc_buyer",
          resolvedAt: "2026-05-09T14:00:00.000Z",
          responsibility: "undetermined",
          evidenceBasis: { type: "party-accepted-resolution", reference: "support-offer.sof_01" },
          responsibilityReasonCode: "product-not-as-described.accepted-resolution-without-cause-finding",
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
      "platform-operations.csat-outcome-fact.v1",
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

  describe("contested-case flow", () => {
    function recordChallenge(state: SupportRequestState, responseId = "rsp_challenge") {
      return decideSupportRequest(state, {
        type: "RecordSupportResponse",
        responseId,
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "challenge-with-evidence",
        summary: "Photos show the item matches the listing.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      });
    }

    it("moves the case to waiting-on-buyer when the seller challenges with evidence", () => {
      const opened = openProductNotAsDescribed();
      const events = recordChallenge(fold(opened));

      expect(events[0]).toMatchObject({
        type: "support.support-request.response-recorded",
        data: { status: "waiting-on-buyer", offer: null },
      });
      expect(fold([...opened, ...events]).status).toBe("waiting-on-buyer");
    });

    it("rejects a second seller challenge on the same case", () => {
      const opened = openProductNotAsDescribed();
      const challenge = recordChallenge(fold(opened));
      const afterChallenge = fold([...opened, ...challenge]);

      expect(() => recordChallenge(afterChallenge, "rsp_challenge_2")).toThrow(
        "This support request already has a seller challenge; further disagreement must be escalated.",
      );
    });

    it("cancels the case and preserves the reason when the buyer withdraws after a challenge", () => {
      const opened = openProductNotAsDescribed();
      const challenge = recordChallenge(fold(opened));
      const afterChallenge = fold([...opened, ...challenge]);

      const withdrawn = decideSupportRequest(afterChallenge, {
        type: "CancelSupportRequest",
        cancelledAt: "2026-05-09T14:00:00.000Z",
        reason: "Buyer withdraws the dispute.",
      });

      expect(withdrawn[0]).toMatchObject({
        type: "support.support-request.cancelled",
        data: { reason: "Buyer withdraws the dispute." },
      });
      expect(fold([...opened, ...challenge, ...withdrawn]).status).toBe("cancelled");
    });

    it("escalates to support with the escalator and reason recorded when the buyer contests", () => {
      const opened = openProductNotAsDescribed();
      const challenge = recordChallenge(fold(opened));
      const afterChallenge = fold([...opened, ...challenge]);

      const escalated = decideSupportRequest(afterChallenge, {
        type: "EscalateSupportRequest",
        escalatedAt: "2026-05-09T14:00:00.000Z",
        reason: "I still believe the item was misrepresented.",
        escalatedByAccountId: "acc_buyer" as never,
        escalatedByRole: "buyer",
      });

      expect(escalated[0]).toMatchObject({
        type: "support.support-request.escalated",
        data: {
          reason: "I still believe the item was misrepresented.",
          escalatedByAccountId: "acc_buyer",
          escalatedByRole: "buyer",
        },
      });
      const afterEscalation = fold([...opened, ...challenge, ...escalated]);
      expect(afterEscalation).toMatchObject({
        status: "ready-for-support",
        escalatedByAccountId: "acc_buyer",
        escalatedByRole: "buyer",
        escalationReason: "I still believe the item was misrepresented.",
      });
    });

    it("lets either party escalate a non-terminal case directly, capturing the escalator", () => {
      const opened = openProductNotReceived();

      const escalated = decideSupportRequest(fold(opened), {
        type: "EscalateSupportRequest",
        escalatedAt: "2026-05-09T13:00:00.000Z",
        reason: "We can't agree on next steps.",
        escalatedByAccountId: "acc_seller" as never,
        escalatedByRole: "seller",
      });

      expect(escalated[0]).toMatchObject({
        data: { escalatedByAccountId: "acc_seller", escalatedByRole: "seller" },
      });
      expect(fold([...opened, ...escalated]).status).toBe("ready-for-support");
    });

    it("blocks the seller from responding further once the case is escalated, but not support", () => {
      const opened = openProductNotReceived();
      const escalated = decideSupportRequest(fold(opened), {
        type: "EscalateSupportRequest",
        escalatedAt: "2026-05-09T13:00:00.000Z",
        reason: "We can't agree on next steps.",
        escalatedByAccountId: "acc_buyer" as never,
        escalatedByRole: "buyer",
      });
      const afterEscalation = fold([...opened, ...escalated]);

      expect(() =>
        decideSupportRequest(afterEscalation, {
          type: "RecordSupportResponse",
          responseId: "rsp_after_escalation",
          submittedByAccountId: "acc_seller" as never,
          submittedByRole: "seller",
          responseType: "provide-tracking",
          summary: "Tracking shows delivery.",
          submittedAt: "2026-05-09T13:30:00.000Z",
        }),
      ).toThrow("This support request has been escalated; only support can act on it now.");

      expect(
        decideSupportRequest(afterEscalation, {
          type: "RecordSupportResponse",
          responseId: "rsp_support_note",
          submittedByAccountId: "acc_support" as never,
          submittedByRole: "support",
          responseType: "provide-tracking",
          summary: "Support reviewing the tracking evidence.",
          submittedAt: "2026-05-09T13:35:00.000Z",
        }),
      ).toHaveLength(1);
    });

    it("requires support to resolve an escalated case", () => {
      const opened = openProductNotReceived();
      const escalated = decideSupportRequest(fold(opened), {
        type: "EscalateSupportRequest",
        escalatedAt: "2026-05-09T13:00:00.000Z",
        reason: "We can't agree on next steps.",
        escalatedByAccountId: "acc_buyer" as never,
        escalatedByRole: "buyer",
      });
      const afterEscalation = fold([...opened, ...escalated]);

      expect(() =>
        decideSupportRequest(afterEscalation, {
          type: "ResolveSupportRequest",
          ...operatorFinding("product-not-received", "seller", "seller-did-not-ship"),
          resolutionType: "full-refund",
          summary: "Buyer and seller agreed outside the platform.",
          resolvedByAccountId: "acc_seller" as never,
          resolvedByRole: "seller",
          resolvedAt: "2026-05-09T14:00:00.000Z",
        }),
      ).toThrow("Escalated support requests can only be resolved by support.");

      const events = decideSupportRequest(afterEscalation, {
        type: "ResolveSupportRequest",
        ...operatorFinding("product-not-received", "seller", "seller-did-not-ship"),
        resolutionType: "full-refund",
        summary: "Support reviewed and issued a full refund.",
        resolvedByAccountId: "acc_support" as never,
        resolvedByRole: "support",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      });
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        type: "platform-operations.csat-outcome-fact.v1",
        data: { outcomeCode: "support.request-resolved" },
      });
    });
  });

  describe("deadline automation", () => {
    it("auto-resolves with a system actor and starts the 7-day auto-close clock", () => {
      const opened = openProductNotReceived();
      const state = fold(opened);

      const resolved = decideSupportRequest(state, {
        type: "ResolveSupportRequest",
        ...sellerSilenceFact("product-not-received"),
        resolutionType: "full-refund",
        summary: "Automatically resolved: the seller did not respond within the 48-hour support window.",
        refundAmount: null,
        resolvedByAccountId: null,
        resolvedByRole: null,
        resolvedAt: "2026-05-11T12:00:00.000Z",
      });

      expect(resolved[0]).toMatchObject({
        type: "support.support-request.resolved",
        data: {
          resolution: {
            resolutionType: "full-refund",
            resolvedByAccountId: null,
            resolvedByRole: null,
            responsibility: "undetermined",
            evidenceBasis: {
              type: "deterministic-policy",
              reference: "support-policy.seller-response-deadline.v1",
            },
            responsibilityReasonCode: "product-not-received.seller-response-deadline-expired",
          },
          autoCloseDueAt: "2026-05-18T12:00:00.000Z",
        },
      });
      expect(fold([...opened, ...resolved])).toMatchObject({
        status: "resolved",
        autoCloseDueAt: "2026-05-18T12:00:00.000Z",
      });
    });

    it("starts the auto-close clock on offer-driven and seller-confirmed resolutions too", () => {
      const cancelOpened = decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: "sup_cancel_close" as never,
        orderId: "ord_01" as never,
        orderTotalAmount: "25.00",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        flowType: "buyer-cancel-request",
        openedByAccountId: "acc_buyer" as never,
        openedByRole: "buyer",
        openedAt,
      });
      const confirmed = decideSupportRequest(fold(cancelOpened), {
        type: "RecordSupportResponse",
        responseId: "rsp_cancel_close",
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "confirm-cancellation",
        summary: "Seller confirms cancellation.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      });
      expect(confirmed[1]).toMatchObject({
        data: {
          autoCloseDueAt: "2026-05-16T13:05:00.000Z",
          resolution: {
            responsibility: "buyer",
            evidenceBasis: {
              type: "party-accepted-resolution",
              reference: "support-policy.confirmed-buyer-cancellation.v1",
            },
            responsibilityReasonCode: "buyer-cancel-request.buyer-requested-cancellation",
          },
        },
      });

      const offerOpened = openProductNotAsDescribed();
      const offered = recordPartialRefundOffer(fold(offerOpened));
      const offerState = fold([...offerOpened, ...offered]);
      const accepted = decideSupportRequest(offerState, {
        type: "AcceptSupportOffer",
        offerId: "sof_01",
        acceptedByAccountId: "acc_buyer" as never,
        acceptedByRole: "buyer",
        acceptedAt: "2026-05-09T14:00:00.000Z",
      });
      expect(accepted[1]).toMatchObject({
        data: { autoCloseDueAt: "2026-05-16T14:00:00.000Z" },
      });
    });

    it("emits a response reminder once while waiting on the seller, then rejects a duplicate", () => {
      const opened = openProductNotReceived();
      const state = fold(opened);

      const reminded = decideSupportRequest(state, {
        type: "EmitSupportResponseReminder",
        remindedAt: "2026-05-10T00:00:00.000Z",
      });

      expect(reminded[0]).toMatchObject({
        type: "support.support-request.response-reminder-emitted",
        data: {
          remindedAt: "2026-05-10T00:00:00.000Z",
          actingRole: "seller",
          dueAt: "2026-05-11T12:00:00.000Z",
          deadlineOutcome: {
            type: "automatic-resolution",
            resolutionType: "full-refund",
          },
        },
      });
      const afterReminder = fold([...opened, ...reminded]);
      expect(afterReminder.sellerResponseReminderSentAt).toBe("2026-05-10T00:00:00.000Z");

      expect(() =>
        decideSupportRequest(afterReminder, {
          type: "EmitSupportResponseReminder",
          remindedAt: "2026-05-10T06:00:00.000Z",
        }),
      ).toThrow("Support response reminder has already been emitted.");
    });

    it("rejects a response reminder once the case is no longer waiting on the seller", () => {
      const opened = openProductNotReceived();
      const state = fold(opened);
      const resolved = decideSupportRequest(state, {
        type: "ResolveSupportRequest",
        ...sellerSilenceFact("product-not-received"),
        resolutionType: "full-refund",
        summary: "Automatic resolution.",
        refundAmount: null,
        resolvedByAccountId: null,
        resolvedByRole: null,
        resolvedAt: "2026-05-11T12:00:00.000Z",
      });
      const afterResolution = fold([...opened, ...resolved]);

      expect(() =>
        decideSupportRequest(afterResolution, {
          type: "EmitSupportResponseReminder",
          remindedAt: "2026-05-11T13:00:00.000Z",
        }),
      ).toThrow("Support response reminders only apply while waiting on the seller.");
    });

    it("states support review as the reminder outcome when silence cannot safely auto-resolve", () => {
      const opened = decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: "sup_missing_products" as never,
        orderId: "ord_01" as never,
        orderTotalAmount: "25.00",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        flowType: "missing-products",
        openedByAccountId: "acc_buyer" as never,
        openedByRole: "buyer",
        openedAt,
      });

      const reminded = decideSupportRequest(fold(opened), {
        type: "EmitSupportResponseReminder",
        remindedAt: "2026-05-10T00:00:00.000Z",
      });

      expect(reminded[0]).toMatchObject({
        data: { deadlineOutcome: { type: "support-review" } },
      });
    });

    it("emits a support-review reminder once while ready for support, then rejects a duplicate", () => {
      const opened = decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: "sup_auth_review" as never,
        orderId: "ord_01" as never,
        orderTotalAmount: "25.00",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        flowType: "authenticity-concern",
        openedByAccountId: "acc_buyer" as never,
        openedByRole: "buyer",
        openedAt,
      });
      const state = fold(opened);
      expect(state.status).toBe("ready-for-support");

      const reminded = decideSupportRequest(state, {
        type: "EmitSupportReviewReminder",
        remindedAt: "2026-05-09T18:00:00.000Z",
      });

      expect(reminded[0]).toMatchObject({
        type: "support.support-request.review-reminder-emitted",
        data: {
          remindedAt: "2026-05-09T18:00:00.000Z",
          dueAt: "2026-05-10T00:00:00.000Z",
        },
      });
      const afterReminder = fold([...opened, ...reminded]);
      expect(afterReminder.supportReviewReminderSentAt).toBe("2026-05-09T18:00:00.000Z");

      expect(() =>
        decideSupportRequest(afterReminder, {
          type: "EmitSupportReviewReminder",
          remindedAt: "2026-05-09T19:00:00.000Z",
        }),
      ).toThrow("Support review reminder has already been emitted.");
    });

    it("rejects a support-review reminder once the case is no longer ready for support", () => {
      const opened = openProductNotReceived();
      const state = fold(opened);

      expect(() =>
        decideSupportRequest(state, {
          type: "EmitSupportReviewReminder",
          remindedAt: "2026-05-09T18:00:00.000Z",
        }),
      ).toThrow("Support review reminders only apply while a case is ready for support review.");
    });
  });

  describe("return-for-refund refund gate", () => {
    function resolveReturnForRefund() {
      const opened = openReturnRequest();
      const evidence = submitReturnEvidence(fold(opened));
      const state = fold([...opened, ...evidence]);
      const resolved = decideSupportRequest(state, {
        type: "ResolveSupportRequest",
        ...operatorFinding("return-request", "buyer", "buyer-remorse"),
        resolutionType: "return-for-refund",
        summary: "Support approved the return.",
        resolvedByAccountId: "acc_support" as never,
        resolvedByRole: "support",
        resolvedAt: "2026-05-09T14:00:00.000Z",
      });
      return [...opened, ...evidence, ...resolved];
    }

    it("opens the gate at awaiting-return-delivery when a return-for-refund resolution fires, without issuing a refund event", () => {
      const events = resolveReturnForRefund();
      const state = fold(events);

      expect(state.status).toBe("resolved");
      expect(state.returnRefundGateStatus).toBe("awaiting-return-delivery");
      expect(state.returnDeliveredAt).toBeNull();
      expect(state.returnRefundReleaseDueAt).toBeNull();
    });

    it("leaves the return-refund gate null for full-refund, partial-refund, and cancel-order resolutions", () => {
      const fullOpened = openProductNotReceived();
      const fullResolved = decideSupportRequest(fold(fullOpened), {
        type: "ResolveSupportRequest",
        ...sellerSilenceFact("product-not-received"),
        resolutionType: "full-refund",
        summary: "Delivery could not be proven.",
        resolvedByAccountId: null,
        resolvedByRole: null,
        resolvedAt: "2026-05-11T12:00:00.000Z",
      });
      expect(fold([...fullOpened, ...fullResolved]).returnRefundGateStatus).toBeNull();

      const offerOpened = openProductNotAsDescribed();
      const offered = recordPartialRefundOffer(fold(offerOpened));
      const accepted = decideSupportRequest(fold([...offerOpened, ...offered]), {
        type: "AcceptSupportOffer",
        offerId: "sof_01",
        acceptedByAccountId: "acc_buyer" as never,
        acceptedByRole: "buyer",
        acceptedAt: "2026-05-09T14:00:00.000Z",
      });
      expect(fold([...offerOpened, ...offered, ...accepted]).returnRefundGateStatus).toBeNull();

      const cancelOpened = decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: "sup_cancel_gate" as never,
        orderId: "ord_01" as never,
        orderTotalAmount: "25.00",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        flowType: "buyer-cancel-request",
        openedByAccountId: "acc_buyer" as never,
        openedByRole: "buyer",
        openedAt,
      });
      const confirmed = decideSupportRequest(fold(cancelOpened), {
        type: "RecordSupportResponse",
        responseId: "rsp_cancel_gate",
        submittedByAccountId: "acc_seller" as never,
        submittedByRole: "seller",
        responseType: "confirm-cancellation",
        summary: "Seller confirms cancellation.",
        submittedAt: "2026-05-09T13:05:00.000Z",
      });
      expect(fold([...cancelOpened, ...confirmed]).returnRefundGateStatus).toBeNull();
    });

    it("records return delivery and starts the 5-day inspection window", () => {
      const events = resolveReturnForRefund();
      const delivered = decideSupportRequest(fold(events), {
        type: "RecordReturnDelivery",
        deliveredAt: "2026-05-20T00:00:00.000Z",
        recordedByAccountId: "acc_seller" as never,
        recordedByRole: "seller",
      });

      expect(delivered[0]).toMatchObject({
        type: "support.support-request.return-delivered",
        data: {
          deliveredAt: "2026-05-20T00:00:00.000Z",
          returnRefundReleaseDueAt: "2026-05-25T00:00:00.000Z",
          recordedByRole: "seller",
        },
      });
      const state = fold([...events, ...delivered]);
      expect(state.returnRefundGateStatus).toBe("awaiting-return-inspection");
      expect(state.returnDeliveredAt).toBe("2026-05-20T00:00:00.000Z");
      expect(state.returnRefundReleaseDueAt).toBe("2026-05-25T00:00:00.000Z");
    });

    it("rejects recording return delivery outside the awaiting-return-delivery gate", () => {
      const opened = openProductNotReceived();
      const state = fold(opened);

      expect(() =>
        decideSupportRequest(state, {
          type: "RecordReturnDelivery",
          deliveredAt: "2026-05-20T00:00:00.000Z",
          recordedByRole: "seller",
        }),
      ).toThrow("This case has no return-for-refund refund awaiting return delivery.");
    });

    it("rejects a duplicate return delivery recording", () => {
      const events = resolveReturnForRefund();
      const delivered = decideSupportRequest(fold(events), {
        type: "RecordReturnDelivery",
        deliveredAt: "2026-05-20T00:00:00.000Z",
        recordedByRole: "seller",
      });
      const state = fold([...events, ...delivered]);

      expect(() =>
        decideSupportRequest(state, {
          type: "RecordReturnDelivery",
          deliveredAt: "2026-05-21T00:00:00.000Z",
          recordedByRole: "seller",
        }),
      ).toThrow("This case has no return-for-refund refund awaiting return delivery.");
    });

    it("lets the seller dispute the returned item's condition within the inspection window", () => {
      const events = resolveReturnForRefund();
      const delivered = decideSupportRequest(fold(events), {
        type: "RecordReturnDelivery",
        deliveredAt: "2026-05-20T00:00:00.000Z",
        recordedByRole: "seller",
      });
      const afterDelivery = fold([...events, ...delivered]);
      const disputed = decideSupportRequest(afterDelivery, {
        type: "DisputeReturnCondition",
        disputedAt: "2026-05-21T00:00:00.000Z",
        reason: "The card came back with a bent corner that was not present at delivery.",
        disputedByAccountId: "acc_seller" as never,
      });

      expect(disputed[0]).toMatchObject({
        type: "support.support-request.return-condition-disputed",
        data: { disputedAt: "2026-05-21T00:00:00.000Z" },
      });
      const state = fold([...events, ...delivered, ...disputed]);
      expect(state.returnRefundGateStatus).toBe("return-condition-disputed");
      expect(state.returnConditionDisputedAt).toBe("2026-05-21T00:00:00.000Z");
    });

    it("rejects a condition dispute before the return has been recorded as delivered", () => {
      const events = resolveReturnForRefund();
      const state = fold(events);

      expect(() =>
        decideSupportRequest(state, {
          type: "DisputeReturnCondition",
          disputedAt: "2026-05-21T00:00:00.000Z",
          reason: "Too early.",
        }),
      ).toThrow("This case has no return awaiting inspection to dispute.");
    });

    it("auto-releases the return refund once the inspection window elapses with no dispute", () => {
      const events = resolveReturnForRefund();
      const delivered = decideSupportRequest(fold(events), {
        type: "RecordReturnDelivery",
        deliveredAt: "2026-05-20T00:00:00.000Z",
        recordedByRole: "seller",
      });
      const afterDelivery = fold([...events, ...delivered]);

      expect(() =>
        decideSupportRequest(afterDelivery, {
          type: "ReleaseReturnRefund",
          releasedAt: "2026-05-24T23:59:59.000Z",
          releasedByRole: null,
        }),
      ).toThrow("The return refund inspection window has not elapsed yet.");

      const released = decideSupportRequest(afterDelivery, {
        type: "ReleaseReturnRefund",
        releasedAt: "2026-05-25T00:00:00.000Z",
        releasedByRole: null,
      });
      expect(released[0]).toMatchObject({
        type: "support.support-request.return-refund-released",
        data: { releasedByRole: null, releasedByAccountId: null },
      });
      expect(fold([...events, ...delivered, ...released]).returnRefundGateStatus).toBe("return-refund-released");
    });

    it("rejects automatic release once the seller has disputed the return's condition", () => {
      const events = resolveReturnForRefund();
      const delivered = decideSupportRequest(fold(events), {
        type: "RecordReturnDelivery",
        deliveredAt: "2026-05-20T00:00:00.000Z",
        recordedByRole: "seller",
      });
      const disputed = decideSupportRequest(fold([...events, ...delivered]), {
        type: "DisputeReturnCondition",
        disputedAt: "2026-05-21T00:00:00.000Z",
        reason: "Item condition changed.",
      });
      const state = fold([...events, ...delivered, ...disputed]);

      expect(() =>
        decideSupportRequest(state, {
          type: "ReleaseReturnRefund",
          releasedAt: "2026-05-25T00:00:00.000Z",
          releasedByRole: null,
        }),
      ).toThrow("This case has no return refund awaiting automatic release.");
    });

    it("lets support manually release a disputed return refund without waiting for a deadline", () => {
      const events = resolveReturnForRefund();
      const delivered = decideSupportRequest(fold(events), {
        type: "RecordReturnDelivery",
        deliveredAt: "2026-05-20T00:00:00.000Z",
        recordedByRole: "seller",
      });
      const disputed = decideSupportRequest(fold([...events, ...delivered]), {
        type: "DisputeReturnCondition",
        disputedAt: "2026-05-21T00:00:00.000Z",
        reason: "Item condition changed.",
      });
      const state = fold([...events, ...delivered, ...disputed]);

      const released = decideSupportRequest(state, {
        type: "ReleaseReturnRefund",
        releasedAt: "2026-05-21T12:00:00.000Z",
        releasedByAccountId: "acc_support" as never,
        releasedByRole: "support",
      });
      expect(released[0]).toMatchObject({
        type: "support.support-request.return-refund-released",
        data: { releasedByRole: "support", releasedByAccountId: "acc_support" },
      });
      expect(fold([...events, ...delivered, ...disputed, ...released]).returnRefundGateStatus).toBe(
        "return-refund-released",
      );
    });

    it("lets support release early from awaiting-return-inspection without waiting for the deadline", () => {
      const events = resolveReturnForRefund();
      const delivered = decideSupportRequest(fold(events), {
        type: "RecordReturnDelivery",
        deliveredAt: "2026-05-20T00:00:00.000Z",
        recordedByRole: "seller",
      });
      const state = fold([...events, ...delivered]);

      const released = decideSupportRequest(state, {
        type: "ReleaseReturnRefund",
        releasedAt: "2026-05-20T01:00:00.000Z",
        releasedByAccountId: "acc_support" as never,
        releasedByRole: "support",
      });
      expect(released).toHaveLength(1);
    });
  });
});
