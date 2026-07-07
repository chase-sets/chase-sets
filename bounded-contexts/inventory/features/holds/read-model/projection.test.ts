import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildInventoryHoldProjectionHandlers } from "./projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return {
    id: `evt_${streamVersion}` as never,
    type,
    streamId: "inventory.hold-hld_1" as never,
    streamVersion: streamVersion as never,
    globalPosition: streamVersion as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_seller" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-07-06T00:00:00.000Z" as never,
      recordedAt: "2026-07-06T00:00:00.000Z" as never,
    },
  };
}

describe("inventory hold projection", () => {
  it("projects placed hold anatomy and structured release reasons", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildInventoryHoldProjectionHandlers(db);

    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", {
        holdId: "hld_order_reservation_rsv_1",
        accountId: "acc_seller",
        itemId: "inv_1",
        quantity: 1,
        reason: "Ordering commitment",
        notes: null,
        purpose: "order",
        sourceRef: {
          orderId: "ord_1",
          reservationRequestId: "rsv_1",
        },
        expiresAt: null,
      }),
    );
    await handlers["inventory.hold.released"]!(
      event(
        "inventory.hold.released",
        {
          holdId: "hld_order_reservation_rsv_1",
          releasedAt: "2026-07-06T01:00:00.000Z",
          releaseReason: "order-cancelled",
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("source_ref"), [
      "hld_order_reservation_rsv_1",
      "acc_seller",
      "inv_1",
      1,
      "Ordering commitment",
      null,
      "order",
      JSON.stringify({
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      }),
      null,
      "2026-07-06T00:00:00.000Z",
      1,
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("release_reason = $4"), [
      "hld_order_reservation_rsv_1",
      "2026-07-06T00:00:00.000Z",
      "2026-07-06T01:00:00.000Z",
      "order-cancelled",
      2,
    ]);
  });

  it("maps legacy free-text reasons into structured read-model fields", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildInventoryHoldProjectionHandlers(db);

    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", {
        holdId: "hld_manual_1",
        accountId: "acc_seller",
        itemId: "inv_1",
        quantity: 1,
        reason: "Trade show promise",
        notes: null,
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("inventory_holds"), [
      "hld_manual_1",
      "acc_seller",
      "inv_1",
      1,
      "Trade show promise",
      "Trade show promise",
      "manual",
      null,
      null,
      "2026-07-06T00:00:00.000Z",
      1,
    ]);
  });

  it("projects checkout hold conversion without terminal release fields", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildInventoryHoldProjectionHandlers(db);

    await handlers["inventory.hold.converted"]!(
      event(
        "inventory.hold.converted",
        {
          holdId: "hld_checkout_1",
          purpose: "order",
          sourceRef: {
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
          },
          expiresAt: null,
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("purpose = $2"), [
      "hld_checkout_1",
      "order",
      JSON.stringify({
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      }),
      null,
      "2026-07-06T00:00:00.000Z",
      2,
    ]);
  });

  it("projects checkout hold expiry as a distinct terminal state", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildInventoryHoldProjectionHandlers(db);

    await handlers["inventory.hold.expired"]!(
      event(
        "inventory.hold.expired",
        {
          holdId: "hld_checkout_1",
          expiredAt: "2026-07-06T00:15:00.000Z",
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'expired'"), [
      "hld_checkout_1",
      "2026-07-06T00:00:00.000Z",
      "2026-07-06T00:15:00.000Z",
      2,
    ]);
  });

  it("projects checkout hold extension counts and expiry", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildInventoryHoldProjectionHandlers(db);

    await handlers["inventory.hold.extended"]!(
      event(
        "inventory.hold.extended",
        {
          holdId: "hld_checkout_1",
          expiresAt: "2026-07-06T00:20:00.000Z",
          extensionCount: 1,
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("extension_count = $3"), [
      "hld_checkout_1",
      "2026-07-06T00:20:00.000Z",
      1,
      "2026-07-06T00:00:00.000Z",
      2,
    ]);
  });
});
