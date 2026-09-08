import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryFunction } from "@chase-sets/event-core-postgres";
import { parseResolveEconomicsRequest } from "../domain/contracts";
import {
  createPostgresEconomicsEvidenceReader,
  economicsInventoryCheckpointKey,
  economicsSalesCheckpointKey,
} from "./evidence-queries";

const request = parseResolveEconomicsRequest({
  accountId: "synthetic-owner-account",
  connectionId: "synthetic-connection-1",
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00", currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T12:00:00Z",
});

function dbWithEvidence() {
  const calls: Array<Readonly<{ text: string; values: readonly unknown[] | undefined }>> = [];
  const query: PgQueryFunction = async <Row>(text: string, values?: readonly unknown[]) => {
    calls.push({ text, values });
    const rows: readonly Record<string, unknown>[] = text.includes("FROM pricing_inventory_acquisition_lots")
      ? [
          {
            account_id: request.accountId,
            inventory_item_id: request.inventoryItemId,
            event_stream_version: 1,
            quantity: 2,
            occurrence_kind: "occurred",
            acquired_at: "2026-09-01T10:00:00Z",
            occurrence_source: "seller-supplied",
            last_source_event_id: "evt_acquisition_known",
          },
          {
            account_id: request.accountId,
            inventory_item_id: "synthetic-legacy-item",
            event_stream_version: 1,
            quantity: 1,
            occurrence_kind: "unknown",
            acquired_at: null,
            occurrence_source: null,
            last_source_event_id: "evt_acquisition_legacy",
          },
        ]
      : text.includes("FROM pricing_market_trades")
        ? [
            {
              order_id: "synthetic-order",
              line_id: "synthetic-line",
              seller_account_id: request.accountId,
              inventory_item_id: request.inventoryItemId,
              quantity: 1,
              sold_at: "2026-09-05T10:00:00Z",
              excluded: false,
            },
          ]
        : text.includes("FROM pricing_inventory_item_inputs")
          ? [
              {
                item_id: request.inventoryItemId,
                seller_account_id: request.accountId,
                total_quantity: 2,
                acquisition_cost_amount: "71.70",
                updated_at: "2026-09-01T11:00:00Z",
                last_stream_version: 4,
              },
            ]
          : [
              {
                checkpoint_key: economicsInventoryCheckpointKey,
                last_global_position: "41",
                updated_at: "2026-09-07T11:58:00Z",
              },
              {
                checkpoint_key: economicsSalesCheckpointKey,
                last_global_position: "52",
                updated_at: "2026-09-07T11:59:00Z",
              },
            ];
    return { rows: rows.map((row) => row as unknown as Row) };
  };
  return { value: { query } satisfies PgQueryable, calls };
}

describe("Economics evidence queries", () => {
  it("reads account-qualified occurrence, sale, cost, and independent projection watermark evidence", async () => {
    const target = dbWithEvidence();
    const snapshot = await createPostgresEconomicsEvidenceReader(target.value).resolve(request);

    expect(snapshot.acquisitions).toEqual([
      {
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        lotId: "evt_acquisition_known",
        quantity: 2,
        occurrence: { kind: "occurred", occurredAt: "2026-09-01T10:00:00.000Z", source: "seller-supplied" },
      },
      {
        accountId: request.accountId,
        inventoryItemId: "synthetic-legacy-item",
        lotId: "evt_acquisition_legacy",
        quantity: 1,
        occurrence: { kind: "unknown" },
      },
    ]);
    expect(snapshot.sales).toEqual([
      {
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        saleId: "synthetic-order:synthetic-line",
        quantity: 1,
        soldAt: "2026-09-05T10:00:00.000Z",
        currency: "usd",
        excluded: false,
      },
    ]);
    expect(snapshot.costLots[0]).toMatchObject({
      accountId: request.accountId,
      inventoryItemId: request.inventoryItemId,
      lotId: `${request.inventoryItemId}:v4`,
      quantity: 2,
      acquisitionCostPerUnit: { amount: "71.70", currency: "usd" },
      observedAt: "2026-09-01T11:00:00.000Z",
    });
    expect(snapshot.inventoryWatermark).toBe(`${economicsInventoryCheckpointKey}@41`);
    expect(snapshot.pricingWatermark).toBe(`${economicsSalesCheckpointKey}@52`);
    expect(snapshot.inventoryObservedAt).toBe("2026-09-07T11:58:00.000Z");
    expect(snapshot.pricingObservedAt).toBe("2026-09-07T11:59:00.000Z");
  });

  it("qualifies every shared SQL column and applies the one evaluation instant to every authority", async () => {
    const target = dbWithEvidence();
    await createPostgresEconomicsEvidenceReader(target.value).resolve(request);

    expect(target.calls).toHaveLength(4);
    expect(target.calls[0]?.text).toContain("acquisition.account_id = $1");
    expect(target.calls[0]?.text).toContain("acquisition.last_source_event_recorded_at <= $2::timestamptz");
    expect(target.calls[0]?.values).toEqual([request.accountId, request.effectiveAt]);
    expect(target.calls[1]?.text).toContain("trade.inventory_item_id");
    expect(target.calls[1]?.text).toContain("trade.sold_at <= $2::timestamptz");
    expect(target.calls[1]?.values).toEqual([request.accountId, request.effectiveAt]);
    expect(target.calls[2]?.text).toContain("inventory_item.catalog_catalog_item_id = $3");
    expect(target.calls[2]?.values).toEqual([
      request.accountId,
      request.inventoryItemId,
      request.catalogItemId,
      request.effectiveAt,
    ]);
    expect(target.calls[3]?.text).toContain("checkpoint.updated_at <= $2::timestamptz");
    expect(target.calls[3]?.values).toEqual([
      [economicsInventoryCheckpointKey, economicsSalesCheckpointKey],
      request.effectiveAt,
    ]);
  });

  it("never substitutes source-recorded time for an unknown acquisition occurrence", async () => {
    const calls: string[] = [];
    const query: PgQueryFunction = async <Row>(text: string) => {
      calls.push(text);
      const rows = text.includes("FROM pricing_inventory_acquisition_lots")
        ? [
            {
              account_id: request.accountId,
              inventory_item_id: request.inventoryItemId,
              event_stream_version: 1,
              quantity: 1,
              occurrence_kind: "unknown",
              acquired_at: null,
              occurrence_source: null,
              last_source_event_id: "evt_recorded_much_later",
            },
          ]
        : [];
      return { rows: rows.map((row) => row as unknown as Row) };
    };
    const snapshot = await createPostgresEconomicsEvidenceReader({ query }).resolve(request);
    expect(calls[0]).toContain("last_source_event_recorded_at <= $2::timestamptz");
    expect(snapshot.acquisitions[0]?.occurrence).toEqual({ kind: "unknown" });
    expect(snapshot.inventoryObservedAt).toBe("1970-01-01T00:00:00Z");
    expect(snapshot.inventoryWatermark).toBe(`${economicsInventoryCheckpointKey}@0`);
  });
});
