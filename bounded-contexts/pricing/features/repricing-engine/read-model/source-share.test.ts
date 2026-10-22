import { describe, expect, it, vi } from "vitest";
import { buildRepricingSourceShareProjectionHandlers, listRepricingSourceShareWeeks } from "./source-share";

describe("repricing source-share projection", () => {
  it("declares event-id dedupe and maps an absent source to unattributed", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const handler = buildRepricingSourceShareProjectionHandlers(db as never)["marketplace.listing.price-updated"]!;
    await handler(
      {
        id: "evt_1",
        streamId: "marketplace.listing-lst_1",
        data: { priceAmount: "10.00" },
        audit: { forAccountId: "acc_1" },
        timing: { occurredAt: "2026-10-07T12:00:00.000Z" },
        globalPosition: "4",
      } as never,
    );
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (event_id) DO NOTHING"), [
      "evt_1",
      "2026-10-04",
      "acc_1",
      "lst_1",
      "unattributed",
      "2026-10-07T12:00:00.000Z",
      "4",
    ]);
  });

  it("partitions totals, dedupes rows by event id, and marks late checkpoints incomplete", async () => {
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT week_start::text")) {
          return {
            rows: [
              { week_start: "2026-10-04", seller_account_id: "acc_1", listing_id: "lst_1", source: "bulk-reprice", global_position: "1" },
              { week_start: "2026-10-04", seller_account_id: "acc_1", listing_id: "lst_2", source: "repricing-engine", global_position: "2" },
              { week_start: "2026-10-04", seller_account_id: "acc_1", listing_id: "lst_3", source: "seller", global_position: "3" },
              { week_start: "2026-10-04", seller_account_id: "acc_2", listing_id: "lst_4", source: "unattributed", global_position: "4" },
            ],
          };
        }
        return { rows: [{ last_global_position: "3", updated_at: new Date("2026-10-05T00:00:00.000Z") }] };
      }),
    };
    const [result] = await listRepricingSourceShareWeeks(db as never, { from: "2026-10-04", to: "2026-10-04" });
    expect(result).toMatchObject({
      eventCount: 4,
      status: "incomplete",
      reason: "unattributed-event",
      counts: { bulk: 1, policy: 1, manual: 1, unattributed: 1 },
      shares: { bulk: 0.25, policy: 0.25, manual: 0.25 },
    });
    expect(result?.topSellers[0]).toMatchObject({ accountId: "acc_1", bulkListingCount: 1, bulkShare: 1 / 3 });
  });
});
