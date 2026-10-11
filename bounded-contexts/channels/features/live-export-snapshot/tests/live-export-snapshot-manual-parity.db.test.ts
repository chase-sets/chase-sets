import { expect, it } from "vitest";
import { module as channelsModule } from "../../../index";
import { connectionId, describeDb, liveExportDatabase } from "./test-support";

describeDb("live-export-snapshot manual golden parity", () => {
  const h = liveExportDatabase("live_export_manual_parity");
  it.each(["operator-declared", "ingest"] as const)(
    "preserves the pre-split staged output and all persisted row fields for %s",
    async (capturedAtSource) => {
      const services = channelsModule.createServices(h.db, {
        channelSaleRecorder: async () => {
          throw new Error("unexpected-sale");
        },
      });
      const at = "2026-10-10T12:00:00.000Z";
      const header = ["TCGplayer Id", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"];
      const snapshot = {
        snapshotId: "synthetic-golden",
        snapshotGeneration: 1,
        connectionId,
        providerKey: "tcgplayer",
        surface: "staged",
        parsedRowCount: 1,
        completeness: "unverified",
        ingestedAt: at,
        capturedAt: at,
        capturedAtSource,
      };
      const result = await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
        snapshotId: snapshot.snapshotId,
        connectionId,
        surface: "staged",
        csv: `${header.join(",")}\n123,2,-1,1.00`,
        limits: { maxRecords: 1 },
        ingestedAt: at,
        capturedAt: at,
        capturedAtSource,
      });
      expect(result).toEqual({
        kind: "parsed",
        surface: "staged",
        header,
        conditionColumn: "absent",
        parsedRowCount: 1,
        completeness: "unverified",
        rows: [
          {
            externalKey: "product:123",
            conditionText: null,
            totalQuantity: 2,
            pendingQuantityDelta: -1,
            priceAmountText: "1.00",
            priceAmountMinor: 100,
            referenceColumns: { "TCGplayer Id": "123", "Total Quantity": "2" },
            rowNumber: 2,
          },
        ],
        snapshot,
      });
      expect((await h.db.query("SELECT * FROM channel_inventory_snapshots")).rows).toEqual([
        {
          snapshot_id: snapshot.snapshotId,
          snapshot_generation: "1",
          connection_id: connectionId,
          provider_key: "tcgplayer",
          surface: "staged",
          parsed_row_count: 1,
          completeness: "unverified",
          ingested_at: new Date(at),
          captured_at: new Date(at),
          captured_at_source: capturedAtSource,
        },
      ]);
      expect((await h.db.query("SELECT * FROM channel_inventory_snapshot_rows")).rows).toEqual([
        {
          snapshot_id: snapshot.snapshotId,
          snapshot_generation: "1",
          connection_id: connectionId,
          provider_key: "tcgplayer",
          surface: "staged",
          external_key: "product:123",
          condition_text: null,
          condition_identity: "",
          total_quantity: 2,
          pending_quantity_delta: -1,
          price_amount_text: "1.00",
          price_amount_minor: "100",
          currency: "USD",
          reference_columns: { "TCGplayer Id": "123", "Total Quantity": "2" },
          row_number: 2,
          ingested_at: new Date(at),
          captured_at: new Date(at),
          captured_at_source: capturedAtSource,
        },
      ]);
      expect((await h.db.query("SELECT * FROM channel_export_schema_pins")).rows).toEqual([
        {
          connection_id: connectionId,
          provider_key: "tcgplayer",
          surface: "staged",
          header,
          condition_column: "absent",
          pinned_from_snapshot_id: snapshot.snapshotId,
          pinned_at: new Date(at),
        },
      ]);
      await expect(
        services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
          snapshotId: "synthetic-invalid-manual",
          connectionId,
          surface: "live",
          csv: "unused",
          limits: { maxRecords: 1 },
          ingestedAt: at,
          capturedAt: at,
          // @ts-expect-error manual callers must not acquire connector capture authority.
          capturedAtSource: "connector-captured",
        }),
      ).rejects.toThrow("capturedAtSource is invalid");
    },
  );
});
