import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildAuthenticityCaseProjectionHandlers } from "./projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "authenticity.case-case_1",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_seller" },
    timing: { occurredAt: "2026-07-09T00:00:00.000Z", recordedAt: "2026-07-09T00:00:00.000Z" },
  });
}

describe("authenticity case projection", () => {
  it("inserts an opened case with the awaiting-inbound status", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildAuthenticityCaseProjectionHandlers(db);

    await handlers["authenticity.case.opened"]!(
      event("authenticity.case.opened", {
        caseId: "case_1",
        orderId: "ord_1",
        sellerAccountId: "acc_seller",
        buyerAccountId: "acc_buyer",
        orderSnapshot: { orderId: "ord_1", listingId: "lst_1", catalogItemId: "cat_1", expectedConditionLabel: "NM" },
        authenticityPlan: { planId: "plan_1", feeAmount: "8.00", feeCurrency: "USD" },
        openedAt: "2026-07-09T00:00:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO authenticity_cases"),
      expect.arrayContaining(["case_1", "ord_1", "acc_seller", "acc_buyer"]),
    );
  });

  it("records inbound tracking without changing status", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildAuthenticityCaseProjectionHandlers(db);

    await handlers["authenticity.case.inbound-tracking-recorded"]!(
      event(
        "authenticity.case.inbound-tracking-recorded",
        { caseId: "case_1", inboundTrackingIdentifier: "1Z-999", recordedAt: "2026-07-09T01:00:00.000Z" },
        2,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("inbound_tracking_identifier = $2"), [
      "case_1",
      "1Z-999",
      "2026-07-09T00:00:00.000Z",
      2,
    ]);
  });

  it("moves a case to received", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildAuthenticityCaseProjectionHandlers(db);

    await handlers["authenticity.case.received"]!(
      event("authenticity.case.received", { caseId: "case_1", receivedAt: "2026-07-10T00:00:00.000Z" }, 3),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'received'"), [
      "case_1",
      "2026-07-10T00:00:00.000Z",
      "2026-07-09T00:00:00.000Z",
      3,
    ]);
  });

  it("records a passed verdict with evidence and checklist results", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildAuthenticityCaseProjectionHandlers(db);

    await handlers["authenticity.case.verdict-recorded"]!(
      event(
        "authenticity.case.verdict-recorded",
        {
          caseId: "case_1",
          verdict: "passed",
          reasonCodes: [],
          checklistResults: [{ checkName: "cert-match", result: "pass", notes: null }],
          evidencePhotoRefs: ["obj://evidence/1.jpg"],
          lineNotes: [],
          inspectorAccountId: "acc_inspector",
          decidedAt: "2026-07-10T02:00:00.000Z",
        },
        5,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = $2"),
      expect.arrayContaining(["case_1", "passed", JSON.stringify([]), expect.any(String)]),
    );
  });

  it("forwards a case with an outbound tracking identifier", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildAuthenticityCaseProjectionHandlers(db);

    await handlers["authenticity.case.forwarded"]!(
      event(
        "authenticity.case.forwarded",
        { caseId: "case_1", forwardedAt: "2026-07-10T03:00:00.000Z", outboundTrackingIdentifier: "1Z-888" },
        6,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'forwarded'"), [
      "case_1",
      "2026-07-10T03:00:00.000Z",
      "1Z-888",
      "2026-07-09T00:00:00.000Z",
      6,
    ]);
  });

  it("returns a failed case with the recorded reason", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildAuthenticityCaseProjectionHandlers(db);

    await handlers["authenticity.case.returned"]!(
      event(
        "authenticity.case.returned",
        { caseId: "case_1", returnedAt: "2026-07-10T04:00:00.000Z", returnReason: "authenticity-check-failed" },
        6,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'returned'"), [
      "case_1",
      "2026-07-10T04:00:00.000Z",
      "authenticity-check-failed",
      "2026-07-09T00:00:00.000Z",
      6,
    ]);
  });
});
