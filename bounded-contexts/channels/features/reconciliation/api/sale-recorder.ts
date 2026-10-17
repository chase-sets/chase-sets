import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelReconciliationRuntimeDependencies } from "../domain/contracts";
type RecordExternalChannelSale = ChannelReconciliationRuntimeDependencies["channelSaleRecorder"];
type RecordExternalChannelSaleCommand = Parameters<RecordExternalChannelSale>[0];

export function channelSaleFingerprint(saleKey: RecordExternalChannelSaleCommand["saleKey"]) {
  return createHash("sha256").update(JSON.stringify(saleKey), "utf8").digest("hex");
}

export async function recordMappedChannelSale(
  recorder: RecordExternalChannelSale,
  command: RecordExternalChannelSaleCommand,
) {
  const outcome = await recorder(command);
  if ("status" in outcome && outcome.status === "committed") {
    const { sale } = outcome;
    if (
      sale.saleKey.version !== command.saleKey.version ||
      sale.saleKey.providerKey !== command.saleKey.providerKey ||
      sale.saleKey.sellerEnvironmentLineage !== command.saleKey.sellerEnvironmentLineage ||
      sale.saleKey.orderLineIdentity !== command.saleKey.orderLineIdentity ||
      sale.accountId !== command.accountId ||
      sale.inventoryItemId !== command.inventoryItemId ||
      sale.storageLocationId !== command.storageLocationId
    ) {
      throw new Error("Inventory external sale result does not match the exact reconciliation target.");
    }
  }
  return outcome;
}

export async function rememberRecordedSale(
  db: PgQueryable,
  connectionId: string,
  fingerprint: string,
  recordedAt: string,
) {
  await db.query(
    `INSERT INTO channel_recorded_sale_receipts (connection_id,sale_key_fingerprint,recorded_at)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [connectionId, fingerprint, recordedAt],
  );
}
