import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getCheckoutSession } from "./queries";

describe("checkout session read model", () => {
  it("normalizes PostgreSQL handoff expiry dates to ISO strings", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            session_id: "chk_0123456789abcdefghijklmnop",
            buyer_account_id: "acc_buyer",
            source_type: "buy-now",
            optimization_goal: "lowest-total",
            fulfillment_preview_revision: null,
            fulfillment_preview_snapshot: null,
            cart_readiness_snapshot: null,
            split_group_handoff: null,
            shipping_option: "standard",
            shipping_address_id: null,
            shipping_address: null,
            authenticity_check_opt_in: null,
            lines: [],
            order_ids: [],
            order_write_commit_positions: [],
            checkout_reservations: [],
            payment_id: null,
            submitted_offer_id: null,
            cancelled_at: null,
            handoff_expires_at: new Date("2026-10-16T06:00:00.000Z"),
            created_at: "2026-10-16T00:00:00.000Z",
            updated_at: "2026-10-16T00:00:00.000Z",
          },
        ],
      }),
    } as unknown as PgQueryable;

    await expect(getCheckoutSession(db, "chk_0123456789abcdefghijklmnop", "acc_buyer")).resolves.toMatchObject({
      handoff_expires_at: "2026-10-16T06:00:00.000Z",
    });
  });
});
