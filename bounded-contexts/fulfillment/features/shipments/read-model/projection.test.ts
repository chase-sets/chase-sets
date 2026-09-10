import { describe, expect, it, vi } from "vitest";
import { buildFulfillmentShipmentProjectionHandlers } from "./projection";

describe("Fulfillment postage subject tenant projection", () => {
  it("records Channel Fulfillment Record identity and quarantines a mismatched replay", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [], rowCount: 1 }));
    const db = { query };
    const handlers = buildFulfillmentShipmentProjectionHandlers(db as never);

    await handlers["fulfillment.channel-fulfillment-record.created"]!({
      type: "fulfillment.channel-fulfillment-record.created",
      tenantId: "tnt_1",
      data: {
        channelFulfillmentRecordId: "cfr_1",
        sellerAccountId: "acc_seller",
        createdAt: "2026-09-10T00:00:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("fulfillment_channel_fulfillment_record_tenant_resolutions"),
      ["cfr_1", "tnt_1", "acc_seller", "2026-09-10T00:00:00.000Z"],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("THEN 'resolved' ELSE 'quarantined' END");
    expect(sql).toContain("THEN 'authoritative-history' ELSE 'projection-identity-mismatch' END");
  });
});
