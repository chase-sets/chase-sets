import { describe, expect, it } from "vitest";
import {
  decideAuthenticityCase,
  evolveAuthenticityCase,
  initialAuthenticityCaseState,
  type AuthenticityCaseState,
} from "./domain";

const orderSnapshot = {
  orderId: "ord_1" as never,
  listingId: "lst_1",
  catalogItemId: "cat_1",
  expectedConditionLabel: "Near Mint",
};

const authenticityPlan = {
  planId: "plan_1",
  feeAmount: "8.00",
  feeCurrency: "USD",
};

function applyAll(events: readonly { type: string }[], state: AuthenticityCaseState) {
  return events.reduce((next, event) => evolveAuthenticityCase(next, event as never), state);
}

function openCase() {
  const opened = decideAuthenticityCase(initialAuthenticityCaseState, {
    type: "OpenAuthenticityCase",
    caseId: "case_1" as never,
    orderId: " ord_1 ",
    sellerAccountId: "acc_seller" as never,
    buyerAccountId: "acc_buyer" as never,
    orderSnapshot,
    authenticityPlan,
    openedAt: "2026-07-09T00:00:00.000Z",
  });
  return applyAll(opened, initialAuthenticityCaseState);
}

function receivedCase() {
  const opened = openCase();
  const tracked = applyAll(
    decideAuthenticityCase(opened, {
      type: "RecordAuthenticityInboundTracking",
      inboundTrackingIdentifier: "1Z-999",
      recordedAt: "2026-07-09T01:00:00.000Z",
    }),
    opened,
  );
  return applyAll(
    decideAuthenticityCase(tracked, {
      type: "ReceiveAuthenticityCase",
      receivedAt: "2026-07-10T00:00:00.000Z",
    }),
    tracked,
  );
}

function inspectingCase() {
  const received = receivedCase();
  return applyAll(
    decideAuthenticityCase(received, {
      type: "BeginAuthenticityInspection",
      inspectorAccountId: "acc_inspector",
      startedAt: "2026-07-10T01:00:00.000Z",
    }),
    received,
  );
}

describe("authenticity case state machine", () => {
  it("opens a case in the awaiting-inbound state from an order fact", () => {
    const state = openCase();

    expect(state).toMatchObject({
      id: "case_1",
      orderId: "ord_1",
      status: "awaiting-inbound",
      sellerAccountId: "acc_seller",
      buyerAccountId: "acc_buyer",
      orderSnapshot,
      authenticityPlan,
    });
  });

  it("walks the full happy path: open, receive, inspect, pass, forward", () => {
    const inspecting = inspectingCase();
    const verdictEvents = decideAuthenticityCase(inspecting, {
      type: "RecordAuthenticityVerdict",
      verdict: "passed",
      reasonCodes: [],
      checklistResults: [{ checkName: "cert-match", result: "pass", notes: null }],
      evidencePhotoRefs: ["obj://evidence/1.jpg"],
      inspectorAccountId: "acc_inspector",
      decidedAt: "2026-07-10T02:00:00.000Z",
    });
    const passed = applyAll(verdictEvents, inspecting);
    expect(passed.status).toBe("passed");
    expect(passed.verdict).toBe("passed");

    const forwardEvents = decideAuthenticityCase(passed, {
      type: "ForwardAuthenticityCase",
      forwardedAt: "2026-07-10T03:00:00.000Z",
      outboundTrackingIdentifier: "1Z-888",
    });
    const forwarded = applyAll(forwardEvents, passed);

    expect(forwarded).toMatchObject({
      status: "forwarded",
      outboundTrackingIdentifier: "1Z-888",
    });
  });

  it("walks the fail path: open, receive, inspect, fail, return", () => {
    const inspecting = inspectingCase();
    const verdictEvents = decideAuthenticityCase(inspecting, {
      type: "RecordAuthenticityVerdict",
      verdict: "failed",
      reasonCodes: ["counterfeit"],
      checklistResults: [{ checkName: "cert-match", result: "fail", notes: "Hologram mismatch" }],
      evidencePhotoRefs: ["obj://evidence/1.jpg", "obj://evidence/2.jpg"],
      lineNotes: [{ orderLineId: "line_1", note: "Card back print misaligned" }],
      inspectorAccountId: "acc_inspector",
      decidedAt: "2026-07-10T02:00:00.000Z",
    });
    const failed = applyAll(verdictEvents, inspecting);
    expect(failed).toMatchObject({
      status: "failed",
      verdict: "failed",
      verdictReasonCodes: ["counterfeit"],
    });

    const returnEvents = decideAuthenticityCase(failed, {
      type: "ReturnAuthenticityCase",
      returnedAt: "2026-07-10T04:00:00.000Z",
    });
    const returned = applyAll(returnEvents, failed);

    expect(returned).toMatchObject({
      status: "returned",
      returnReason: "authenticity-check-failed",
    });
  });

  it("returns an inconclusive case back to the seller with a default reason", () => {
    const inspecting = inspectingCase();
    const verdictEvents = decideAuthenticityCase(inspecting, {
      type: "RecordAuthenticityVerdict",
      verdict: "inconclusive",
      reasonCodes: ["inconclusive"],
      checklistResults: [],
      evidencePhotoRefs: ["obj://evidence/1.jpg"],
      inspectorAccountId: "acc_inspector",
      decidedAt: "2026-07-10T02:00:00.000Z",
    });
    const inconclusive = applyAll(verdictEvents, inspecting);

    const returnEvents = decideAuthenticityCase(inconclusive, {
      type: "ReturnAuthenticityCase",
      returnedAt: "2026-07-10T04:00:00.000Z",
      returnReason: null,
    });
    const returned = applyAll(returnEvents, inconclusive);

    expect(returned.returnReason).toBe("authenticity-check-inconclusive");
  });

  it("rejects opening a case twice", () => {
    const opened = openCase();
    expect(() =>
      decideAuthenticityCase(opened, {
        type: "OpenAuthenticityCase",
        caseId: "case_2" as never,
        orderId: "ord_2",
        sellerAccountId: "acc_seller" as never,
        buyerAccountId: "acc_buyer" as never,
        orderSnapshot,
        authenticityPlan,
        openedAt: "2026-07-09T00:00:00.000Z",
      }),
    ).toThrow("Authenticity case has already been opened.");
  });

  it("rejects commands before the case is opened", () => {
    expect(() =>
      decideAuthenticityCase(initialAuthenticityCaseState, {
        type: "ReceiveAuthenticityCase",
        receivedAt: "2026-07-10T00:00:00.000Z",
      }),
    ).toThrow("Authenticity case must be opened first.");
  });

  it("rejects receiving a case that is not awaiting inbound delivery", () => {
    const received = receivedCase();
    expect(() =>
      decideAuthenticityCase(received, {
        type: "ReceiveAuthenticityCase",
        receivedAt: "2026-07-10T00:30:00.000Z",
      }),
    ).toThrow("Only a case awaiting inbound delivery can be received.");
  });

  it("rejects beginning inspection before the case is received", () => {
    const opened = openCase();
    expect(() =>
      decideAuthenticityCase(opened, {
        type: "BeginAuthenticityInspection",
        inspectorAccountId: "acc_inspector",
        startedAt: "2026-07-10T01:00:00.000Z",
      }),
    ).toThrow("Inspection can only begin once the case has been received.");
  });

  it("rejects recording a verdict outside the inspecting state", () => {
    const received = receivedCase();
    expect(() =>
      decideAuthenticityCase(received, {
        type: "RecordAuthenticityVerdict",
        verdict: "passed",
        reasonCodes: [],
        checklistResults: [],
        evidencePhotoRefs: ["obj://evidence/1.jpg"],
        inspectorAccountId: "acc_inspector",
        decidedAt: "2026-07-10T02:00:00.000Z",
      }),
    ).toThrow("A verdict can only be recorded while the case is being inspected.");
  });

  it("rejects a passed verdict that carries reason codes", () => {
    const inspecting = inspectingCase();
    expect(() =>
      decideAuthenticityCase(inspecting, {
        type: "RecordAuthenticityVerdict",
        verdict: "passed",
        reasonCodes: ["counterfeit"],
        checklistResults: [],
        evidencePhotoRefs: ["obj://evidence/1.jpg"],
        inspectorAccountId: "acc_inspector",
        decidedAt: "2026-07-10T02:00:00.000Z",
      }),
    ).toThrow("A passed verdict must not carry reason codes.");
  });

  it("rejects a failed verdict with no reason codes", () => {
    const inspecting = inspectingCase();
    expect(() =>
      decideAuthenticityCase(inspecting, {
        type: "RecordAuthenticityVerdict",
        verdict: "failed",
        reasonCodes: [],
        checklistResults: [],
        evidencePhotoRefs: ["obj://evidence/1.jpg"],
        inspectorAccountId: "acc_inspector",
        decidedAt: "2026-07-10T02:00:00.000Z",
      }),
    ).toThrow("A failed or inconclusive verdict requires at least one reason code.");
  });

  it("rejects an unsupported verdict reason code", () => {
    const inspecting = inspectingCase();
    expect(() =>
      decideAuthenticityCase(inspecting, {
        type: "RecordAuthenticityVerdict",
        verdict: "failed",
        reasonCodes: ["not-a-real-code" as never],
        checklistResults: [],
        evidencePhotoRefs: ["obj://evidence/1.jpg"],
        inspectorAccountId: "acc_inspector",
        decidedAt: "2026-07-10T02:00:00.000Z",
      }),
    ).toThrow("Unsupported authenticity verdict reason code: not-a-real-code.");
  });

  it("rejects a verdict recorded without evidence photo references", () => {
    const inspecting = inspectingCase();
    expect(() =>
      decideAuthenticityCase(inspecting, {
        type: "RecordAuthenticityVerdict",
        verdict: "passed",
        reasonCodes: [],
        checklistResults: [],
        evidencePhotoRefs: [],
        inspectorAccountId: "acc_inspector",
        decidedAt: "2026-07-10T02:00:00.000Z",
      }),
    ).toThrow("A verdict requires at least one evidence photo reference.");
  });

  it("rejects forwarding a case that has not passed", () => {
    const inspecting = inspectingCase();
    expect(() =>
      decideAuthenticityCase(inspecting, {
        type: "ForwardAuthenticityCase",
        forwardedAt: "2026-07-10T03:00:00.000Z",
      }),
    ).toThrow("Only a case with a passed verdict can be forwarded to the buyer.");
  });

  it("rejects returning a case that has not failed or been inconclusive", () => {
    const inspecting = inspectingCase();
    expect(() =>
      decideAuthenticityCase(inspecting, {
        type: "ReturnAuthenticityCase",
        returnedAt: "2026-07-10T04:00:00.000Z",
      }),
    ).toThrow("Only a failed or inconclusive case can be returned to the seller.");
  });

  it("rejects recording inbound tracking after the case is received", () => {
    const received = receivedCase();
    expect(() =>
      decideAuthenticityCase(received, {
        type: "RecordAuthenticityInboundTracking",
        inboundTrackingIdentifier: "1Z-000",
        recordedAt: "2026-07-10T00:30:00.000Z",
      }),
    ).toThrow("Inbound tracking can only be recorded before the case is received at the facility.");
  });
});
