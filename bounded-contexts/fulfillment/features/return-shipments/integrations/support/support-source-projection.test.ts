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

  it("authorizes and issues a seller return label from a return resolution, then voids it on cancellation", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const onResolved = vi.fn(async () => undefined);
    const onCancelled = vi.fn(async () => undefined);
    const handlers = buildFulfillmentSupportReturnSourceProjectionHandlers(db as never, { onResolved, onCancelled });
    const envelope = {
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_system", forAccountId: "acc_buyer" },
      trace: { correlationId: "cor_1", causationId: "evt_1" },
      timing: { recordedAt: "2026-07-15T00:02:00.000Z" },
    };

    await handlers["support.support-request.resolved"]!({
      ...envelope,
      type: "support.support-request.resolved",
      data: {
        supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        flowType: "product-damaged",
        resolution: { resolutionType: "return-for-refund", resolvedAt: "2026-07-15T00:02:00.000Z" },
      },
    } as never);
    await handlers["support.support-request.cancelled"]!({
      ...envelope,
      type: "support.support-request.cancelled",
      data: {
        supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        cancellationReason: "withdrawn",
        cancelledAt: "2026-07-16T00:02:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("'return-to-seller'"), [
      "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      "2026-07-15T00:02:00.000Z",
    ]);
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ flowType: "product-damaged" }), {
      tenantId: "tnt_test",
      audit: envelope.audit,
      trace: envelope.trace,
    });
    expect(onCancelled).toHaveBeenCalledWith(
      { supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9", reason: "withdrawn" },
      { tenantId: "tnt_test", audit: envelope.audit, trace: envelope.trace },
    );
  });
});
