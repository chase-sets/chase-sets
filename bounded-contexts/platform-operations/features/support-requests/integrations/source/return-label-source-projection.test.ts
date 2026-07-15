import { describe, expect, it, vi } from "vitest";
import { buildSupportReturnLabelSourceProjectionHandlers } from "./return-label-source-projection";

describe("Support return-label source projection", () => {
  it("projects the label, tracking, actual cost allocation, and customer-safe purchase failure", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildSupportReturnLabelSourceProjectionHandlers(db as never);
    await handlers["fulfillment.return-shipment.requested.v2"]!({
      data: {
        supportRequestId: "sup_1",
        returnShipmentId: "rsh_1",
        costPayer: "buyer",
        shipByDeadlineAt: "2026-07-29T00:00:00.000Z",
        returnByDeadlineAt: "2026-08-14T00:00:00.000Z",
        requestedAt: "2026-07-15T00:00:00.000Z",
      },
    } as never);
    await handlers["fulfillment.return-shipment.label-purchase-failed.v1"]!({
      data: {
        returnShipmentId: "rsh_1",
        failureReason: "provider-unavailable",
        failedAt: "2026-07-15T00:01:00.000Z",
      },
    } as never);
    await handlers["fulfillment.return-shipment.label-ready.v1"]!({
      data: {
        returnShipmentId: "rsh_1",
        trackingIdentifier: "9400",
        labelDocumentUrl: "https://labels.test/1",
        postageAmountCents: 275,
        postageCurrency: "USD",
        readyAt: "2026-07-15T00:02:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("INTO support_return_label_sources"), [
      "sup_1",
      "rsh_1",
      "buyer",
      "2026-07-29T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("failure_reason = $2"), [
      "rsh_1",
      "provider-unavailable",
      "2026-07-15T00:01:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("postage_amount_cents = $4"), [
      "rsh_1",
      "9400",
      "https://labels.test/1",
      275,
      "USD",
      "2026-07-15T00:02:00.000Z",
    ]);
  });
});
