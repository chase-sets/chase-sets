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
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    flowType: "product-not-received",
    openedByAccountId: "acc_buyer" as never,
    openedByRole: "buyer",
    openedAt,
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

  it("keeps cancellation and seller fulfillment failures as explicit common flows", () => {
    const buyerCancel = decideSupportRequest(initialSupportRequestState, {
      type: "OpenSupportRequest",
      supportRequestId: "sup_cancel" as never,
      orderId: "ord_01" as never,
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
