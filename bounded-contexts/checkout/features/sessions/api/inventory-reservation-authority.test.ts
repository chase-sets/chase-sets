import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCheckoutInventoryReservationAuthority } from "./inventory-reservation-authority";

const memory = vi.hoisted(() => ({ eventStore: null as unknown }));
vi.mock("@chase-sets/event-core-postgres", () => ({ createPostgresEventStore: () => memory.eventStore }));
const buyer: EventStoreContext = {
  tenantId: "tnt_synthetic",
  audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_buyer" },
};
const input = {
  checkoutSessionId: "chk_synthetic",
  lineKey: "line_synthetic",
  inventoryItemId: "inv_synthetic",
  quantity: 1,
  context: buyer,
};

describe("issue-7169-c1-boundary-recovery: trusted Checkout owner", () => {
  it("retains private seller authority after cancellation without permitting another create", async () => {
    const { eventStore } = createInMemoryEventStore();
    memory.eventStore = eventStore;
    await eventStore.appendToStream({
      streamId: "checkout.session-chk_synthetic",
      expectedVersion: "no_stream",
      context: buyer,
      events: [
        {
          eventType: "checkout.session.started",
          payload: {
            sessionId: "chk_synthetic",
            buyerAccountId: "acc_buyer",
            sourceType: "buy-now",
            optimizationGoal: "lowest-total",
            fulfillmentPreviewRevision: null,
            fulfillmentPreviewSnapshot: null,
            cartReadinessSnapshot: null,
            splitGroupHandoff: null,
            shippingOption: "standard",
            lines: [],
            createdAt: "2026-10-13T00:00:00Z",
          },
        },
        {
          eventType: "checkout.session.reservations-recorded",
          payload: {
            sessionId: "chk_synthetic",
            reservations: [
              {
                holdId: "hld_synthetic",
                lineKey: "line_synthetic",
                sellerAccountId: "acc_seller",
                inventoryItemId: "inv_synthetic",
                quantity: 1,
                expiresAt: "2026-10-13T00:15:00Z",
                extensionCount: 0,
                status: "active",
              },
            ],
            recordedAt: "2026-10-13T00:00:00Z",
          },
        },
        {
          eventType: "checkout.session.cancelled",
          payload: {
            sessionId: "chk_synthetic",
            cancelledAt: "2026-10-13T00:01:00Z",
            releasedReservationIds: ["hld_synthetic"],
          },
        },
      ],
    });
    const unexpected = async () => {
      throw new Error("Unexpected DB call");
    };
    const pool: PgTransactionalPool = { query: unexpected, connect: unexpected };
    const authority = createCheckoutInventoryReservationAuthority(pool);
    expect(await authority(input)).toEqual({ accountId: "acc_seller", canMutate: false });
    expect(await authority({ ...input, operation: "release" })).toEqual({ accountId: "acc_seller", canMutate: true });
    expect(await authority({ ...input, quantity: 2 })).toBeNull();
    expect(
      await authority({ ...input, context: { ...buyer, audit: { ...buyer.audit, forAccountId: "acc_foreign" } } }),
    ).toBeNull();
    expect(await authority({ ...input, context: { ...buyer, tenantId: "tnt_foreign" } })).toBeNull();
  });
});
