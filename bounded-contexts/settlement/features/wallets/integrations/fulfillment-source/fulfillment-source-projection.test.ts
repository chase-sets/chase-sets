import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  buildSettlementFulfillmentSourceProjectionHandlers,
  decideMarketplaceLabelPostageDebit,
} from "./fulfillment-source-projection";
import { MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE } from "./label-postage-policy";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "fulfillment.shipment-shp_1",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_seller" },
    timing: { occurredAt: "2026-05-01T00:00:00.000Z", recordedAt: "2026-05-01T00:00:00.000Z" },
  });
}

describe("settlement fulfillment source projection", () => {
  it("projects shipment creation and delivery as payout release inputs", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementFulfillmentSourceProjectionHandlers(db as never, {
      wallets: {} as never,
      policies: {} as never,
    });

    await handlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        createdAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    await handlers["fulfillment.shipment.delivered"]!(
      event(
        "fulfillment.shipment.delivered",
        {
          shipmentId: "shp_1",
          trackingIdentifier: "trk_1",
          deliveredAt: "2026-05-04T00:00:00.000Z",
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO settlement_order_fulfillment_sources"),
      ["shp_1", "ord_1", "acc_buyer", "acc_seller", null, "2026-05-01T00:00:00.000Z", 1],
    );
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET status = 'delivered'"), [
      "shp_1",
      "trk_1",
      "2026-05-04T00:00:00.000Z",
      2,
    ]);
  });

  it("makes the cutover boundary, null skip, and currency refusal typed and deterministic", () => {
    const basis = {
      providerLabelId: "pl_1",
      postageAmountCents: 525,
      postageCurrency: "usd",
      walletCurrency: "usd",
      policy: MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE,
    } as const;

    expect(
      decideMarketplaceLabelPostageDebit({
        ...basis,
        factRecordedAt: "2026-09-10T15:46:51.999Z",
      }),
    ).toEqual({ kind: "skip", reason: "historical" });
    expect(
      decideMarketplaceLabelPostageDebit({
        ...basis,
        factRecordedAt: MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE.cutoverRecordedAt,
      }),
    ).toEqual({ kind: "post", amount: "5.25", currencyCode: "usd" });
    expect(
      decideMarketplaceLabelPostageDebit({
        ...basis,
        factRecordedAt: "2026-09-10T15:46:53.000Z",
        postageAmountCents: null,
      }),
    ).toEqual({ kind: "skip", reason: "null-amount" });
    expect(
      decideMarketplaceLabelPostageDebit({
        ...basis,
        factRecordedAt: "2026-09-10T15:46:53.000Z",
        postageCurrency: "cad",
      }),
    ).toEqual({ kind: "refuse", reason: "currency-mismatch" });
  });

  it("posts the fact amount through the owning wallet path with order linkage and negative balance allowed", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM settlement_order_fulfillment_sources")) {
          return { rows: [{ order_id: "ord_1", seller_account_id: "acc_seller" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO settlement_marketplace_label_postage")) {
          return { rows: [{ shipment_id: "shp_1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const wallets = {
      loadWalletState: vi.fn(async () => ({ currencyCode: null, entries: [] })),
      postEntry: vi.fn(async () => ({ accountId: "acc_seller", version: 2, entry: {} })),
    };
    const policies = {
      resolvePolicy: vi.fn(async () => ({
        value: { ...MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE, cutoverRecordedAt: "2026-05-01T00:00:00.000Z" },
      })),
    };
    const handlers = buildSettlementFulfillmentSourceProjectionHandlers(db as never, {
      wallets: wallets as never,
      policies: policies as never,
    });
    const attached = event(
      "fulfillment.shipment.label-attached",
      {
        shipmentId: "shp_1",
        postageProviderLabelId: "pl_1",
        postageAmountCents: 525,
        postageCurrency: "USD",
        attachedAt: "2026-09-10T15:48:00.000Z",
      },
      2,
    );

    await handlers["fulfillment.shipment.label-attached"]!(attached, { db: db as never });

    expect(wallets.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        kind: "platform-purchase",
        direction: "debit",
        amount: "5.25",
        currencyCode: "usd",
        fundsStatus: "available",
        orderId: "ord_1",
        description: "Marketplace label postage for shipment shp_1",
        allowNegativeBalance: true,
      }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
  });

  it("posts only refunded status as the linked opposite wallet entry", async () => {
    const linkedRow = {
      shipment_id: "shp_1",
      label_identity: "provider:pl_1",
      postage_provider_label_id: "pl_1",
      source_event_id: "evt_label",
      order_id: "ord_1",
      seller_account_id: "acc_seller",
      postage_amount_cents: 525,
      postage_currency: "usd",
      outcome: "debit-posted",
      debit_ledger_entry_id: "led_original",
      refund_ledger_entry_id: null,
      refund_reference: "rfnd_1",
      refund_status: "submitted",
      policy_version: "marketplace-label-postage-v1",
      source_recorded_at: "2026-09-10T15:48:00.000Z",
      label_attached_at: "2026-09-10T15:48:00.000Z",
      voided_at: "2026-09-10T15:49:00.000Z",
      refunded_at: null,
      last_stream_version: 3,
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT * FROM settlement_marketplace_label_postage")) {
          return { rows: [linkedRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const wallets = {
      loadWalletState: vi.fn(async () => ({ currencyCode: "usd", entries: [] })),
      postEntry: vi.fn(async () => ({ accountId: "acc_seller", version: 3, entry: {} })),
    };
    const handlers = buildSettlementFulfillmentSourceProjectionHandlers(db as never, {
      wallets: wallets as never,
      policies: {} as never,
    });

    await handlers["fulfillment.shipment.label-refund-status-recorded"]!(
      event(
        "fulfillment.shipment.label-refund-status-recorded",
        {
          shipmentId: "shp_1",
          refundStatus: "rejected",
          refundReference: "rfnd_1",
          resolvedAt: "2026-09-10T15:50:00.000Z",
        },
        4,
      ),
      { db: db as never },
    );
    expect(wallets.postEntry).not.toHaveBeenCalled();

    await handlers["fulfillment.shipment.label-refund-status-recorded"]!(
      event(
        "fulfillment.shipment.label-refund-status-recorded",
        {
          shipmentId: "shp_1",
          refundStatus: "refunded",
          refundReference: "rfnd_1",
          resolvedAt: "2026-09-10T15:51:00.000Z",
        },
        5,
      ),
      { db: db as never },
    );

    expect(wallets.postEntry).toHaveBeenCalledTimes(1);
    expect(wallets.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "platform-purchase",
        direction: "credit",
        amount: "5.25",
        orderId: "ord_1",
        description: expect.stringContaining("reverses led_original"),
      }),
      expect.anything(),
    );
  });
});
