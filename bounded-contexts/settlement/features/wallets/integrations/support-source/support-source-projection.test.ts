import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildSettlementSupportHoldProjectionHandlers } from "./support-source-projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return {
    id: `evt_${streamVersion}` as never,
    type,
    streamId: "support.support-request-sup_01ABC" as never,
    streamVersion: streamVersion as never,
    globalPosition: streamVersion as never,
    tenantId: "tnt_test" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_test" as never,
      forAccountId: "acc_buyer" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-31T14:00:00.000Z" as never,
      recordedAt: "2026-05-31T14:00:00.000Z" as never,
    },
  };
}

describe("settlement support source projection", () => {
  it("records a concrete support hold id for launch evidence", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementSupportHoldProjectionHandlers(db as never);

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_01ABC",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        flowType: "product-damaged",
        status: "waiting-on-seller",
        openedAt: "2026-05-31T14:00:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("hold_id"), [
      "sup_01ABC",
      "hold_01ABC",
      "ord_1",
      "acc_buyer",
      "acc_seller",
      "product-damaged",
      "waiting-on-seller",
      "2026-05-31T14:00:00.000Z",
      1,
    ]);
  });
});
