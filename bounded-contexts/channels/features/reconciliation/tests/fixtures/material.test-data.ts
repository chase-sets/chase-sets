import { parseTcgplayerFullExport, serializeCsv } from "../../../tcgplayer-csv/domain/csv";
import { tcgplayerExportSchemaDescriptors } from "../../../tcgplayer-csv/domain/profile";
import type { ChannelInventorySnapshotRow } from "../../../tcgplayer-csv/domain/contracts";
import type { ClaimedChannelStateRead } from "../../domain/contracts";

// SYNTHETIC engineering evidence, not provider census or production authority.
export function syntheticLiveRow(price = "10.00", quantity = 2): ChannelInventorySnapshotRow {
  const header = tcgplayerExportSchemaDescriptors.find((descriptor) => descriptor.surface === "live")!.fixedHeader!;
  const columns = Object.fromEntries(header.map((column) => [column, "SYNTHETIC"]));
  Object.assign(columns, {
    "TCGplayer Id": "90000001",
    Condition: "Near Mint",
    "Total Quantity": String(quantity),
    "Add to Quantity": "0",
    "TCG Marketplace Price": price,
  });
  const parsed = parseTcgplayerFullExport(
    { surface: "live", csv: serializeCsv(header, [columns]) },
    { maxRecords: 10 },
  );
  if (parsed.kind !== "parsed") throw new Error(`SYNTHETIC Live fixture refused: ${parsed.reason}`);
  return {
    ...parsed.rows[0]!,
    snapshotId: "SYNTHETIC-live",
    snapshotGeneration: 1,
    connectionId: "connection-1",
    providerKey: "tcgplayer",
    surface: "live",
    currency: "USD",
    ingestedAt: "2026-09-12T05:00:00.000Z",
    capturedAt: "2026-09-12T04:00:00.000Z",
    capturedAtSource: "operator-declared",
  };
}

export function syntheticClaimedSource(row = syntheticLiveRow()): ClaimedChannelStateRead {
  return {
    sourceAuthority: { kind: "complete", collectedCount: 1, authorityTotal: 1 },
    freshness: "current",
    snapshotId: row.snapshotId,
    rows: [row],
    appliedChannelListingIds: ["channel-foreign"],
  };
}
