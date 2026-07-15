import { describe, expect, it, vi } from "vitest";
import { buildFulfillmentSupportReturnSourceProjectionHandlers } from "./support-source-projection";

describe("Fulfillment Support return source projection", () => {
  it("projects the case order, affected lines, and authorized remedy independently", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildFulfillmentSupportReturnSourceProjectionHandlers(db as never);

    await handlers["support.support-request.opened"]!({
      type: "support.support-request.opened",
      data: { supportRequestId: "sup_1", orderId: "ord_1", openedAt: "2026-07-15T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-15T00:00:00.000Z" },
    } as never);
    await handlers["support.support-request.affected-line-items-recorded"]!({
      type: "support.support-request.affected-line-items-recorded",
      data: {
        supportRequestId: "sup_1",
        affectedLineItems: [
          { lineId: "oli_2", amount: "5.00", currencyCode: "usd" },
          { lineId: "oli_1", amount: "10.00", currencyCode: "usd" },
        ],
      },
      timing: { recordedAt: "2026-07-15T00:01:00.000Z" },
    } as never);
    await handlers["support.support-request.remedy-authorized.v1"]!({
      type: "support.support-request.remedy-authorized.v1",
      data: {
        supportRequestId: "sup_1",
        remedyId: "rmd_1",
        returnDirective: "return-to-platform",
        occurredAt: "2026-07-15T00:02:00.000Z",
      },
      timing: { recordedAt: "2026-07-15T00:02:00.000Z" },
    } as never);

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("INTO fulfillment_support_return_sources"), [
      "sup_1",
      "ord_1",
      "2026-07-15T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("affected_order_line_ids"), [
      "sup_1",
      JSON.stringify(["oli_2", "oli_1"]),
      "2026-07-15T00:01:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INTO fulfillment_support_return_remedy_sources"),
      ["rmd_1", "sup_1", "return-to-platform", "2026-07-15T00:02:00.000Z"],
    );
  });
});
