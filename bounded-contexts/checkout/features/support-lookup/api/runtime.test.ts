import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { lookupCheckoutSupportReference } from "./runtime";

function createDb(options: { buyRows?: readonly unknown[]; sellRows?: readonly unknown[] }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("checkout_session_pages")) {
      return { rows: [...(options.buyRows ?? [])] };
    }

    if (sql.includes("checkout_sell_list_confirmation_pages")) {
      return { rows: [...(options.sellRows ?? [])] };
    }

    return { rows: [] };
  });

  return {
    db: { query } as unknown as PgQueryable,
    query,
  };
}

describe("checkout support lookup runtime", () => {
  it("finds a buy checkout session by fulfillment-group support reference without exposing raw ids", async () => {
    const { db, query } = createDb({
      buyRows: [
        {
          source_type: "cart",
          optimization_goal: "lowest-total",
          split_group_handoff: {
            status: "ready",
            supportReference: "CS-READY",
            groups: [
              {
                groupId: "grp_private",
                lineIds: ["line_private"],
                listingIds: ["lst_private"],
                sellerAccountId: "acc_private_seller",
                sellerDisplayName: "Private Seller",
                itemCount: 1,
                packageCount: 1,
                deliveryPromise: "4-7 business days",
                supportReference: "CSG-CARDVAULT",
                downstreamReferenceStatus: "not-started",
              },
            ],
          },
          lines: [{ cartLineId: "line_private", itemTitle: "Acerola's Mischief" }],
          order_ids: ["ord_private"],
          payment_id: "pay_private",
          submitted_offer_id: null,
          created_at: "2026-06-13T00:00:00.000Z",
          updated_at: "2026-06-13T00:01:00.000Z",
        },
      ],
    });

    const result = await lookupCheckoutSupportReference(db, "CSG-CARDVAULT");

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("jsonb_build_object");
    expect(result).toMatchObject({
      type: "buy-checkout-session",
      supportReference: "CSG-CARDVAULT",
      matchedReference: "fulfillment-group",
      state: "committed",
      lineCount: 1,
      groupCount: 1,
      matchedGroup: {
        supportReference: "CSG-CARDVAULT",
        itemCount: 1,
        packageCount: 1,
        deliveryPromise: "4-7 business days",
      },
      ownerFacts: {
        orderCount: 1,
        paymentStarted: true,
        offerSubmitted: false,
      },
      sideEffects: {
        order: "handoff-recorded",
        payment: "handoff-recorded",
        label: "pending-downstream",
      },
    });

    const responseText = JSON.stringify(result);
    expect(responseText).not.toContain("ord_private");
    expect(responseText).not.toContain("pay_private");
    expect(responseText).not.toContain("lst_private");
    expect(responseText).not.toContain("acc_private_seller");
    expect(responseText).not.toContain("line_private");
    expect(responseText).not.toContain("grp_private");
  });

  it("falls through to sell-list confirmation references and redacts handoff internals", async () => {
    const { db, query } = createDb({
      sellRows: [
        {
          confirmation_id: "slc_session_safe",
          confirmed_at: "2026-06-13T00:02:00.000Z",
          handoff_summary: {
            acceptedOfferCount: 1,
            publishedListingCount: 1,
            skippedLineCount: 0,
            sideEffects: {
              sale: "handoff-recorded",
              label: "pending-downstream",
              payout: "pending-downstream",
              settlement: "pending-downstream",
              notification: "pending-downstream",
              accountHistory: "pending-downstream",
            },
            lineOutcomes: [
              {
                lineId: "line_private",
                itemTitle: "Acerola's Mischief",
                status: "completed",
                action: "mixed",
                quantity: 2,
                remainingQuantity: 0,
                detail: "Completed Acerola's Mischief",
                references: {
                  offerIds: ["off_private"],
                  listingId: "lst_private",
                },
              },
            ],
          },
        },
      ],
    });

    const result = await lookupCheckoutSupportReference(db, "slc_session_safe");

    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      type: "sell-list-confirmation",
      supportReference: "slc_session_safe",
      state: "committed",
      acceptedOfferCount: 1,
      publishedListingCount: 1,
      lineOutcomes: [
        {
          itemTitle: "Acerola's Mischief",
          status: "completed",
          action: "mixed",
          quantity: 2,
          remainingQuantity: 0,
        },
      ],
    });

    const responseText = JSON.stringify(result);
    expect(responseText).not.toContain("line_private");
    expect(responseText).not.toContain("off_private");
    expect(responseText).not.toContain("lst_private");
  });

  it("returns null when the support reference is unknown", async () => {
    const { db } = createDb({});

    await expect(lookupCheckoutSupportReference(db, "CS-UNKNOWN")).resolves.toBeNull();
  });
});
