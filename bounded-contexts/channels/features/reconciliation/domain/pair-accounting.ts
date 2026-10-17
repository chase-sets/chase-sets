import type { ChannelInventorySnapshotRow } from "../../tcgplayer-csv/domain/contracts";
import { tcgplayerExternalListingId } from "../../tcgplayer-csv/domain/composition";
import type { RecordedTcgplayerSaleFacts } from "../../tcgplayer-orders/read-model/recorded-facts";

export function accountSnapshotPair(
  previous: readonly ChannelInventorySnapshotRow[],
  current: readonly ChannelInventorySnapshotRow[],
  sales: RecordedTcgplayerSaleFacts,
):
  | Readonly<{ kind: "known"; drops: readonly Readonly<{ identity: string; quantity: number }>[] }>
  | Readonly<{ kind: "unknown" }> {
  if (sales.kind === "unknown") return sales;
  const identities = new Map<string, Set<string>>();
  const prior = new Map<string, ChannelInventorySnapshotRow>();
  for (const row of [...previous, ...current]) {
    if (
      row.providerKey !== "tcgplayer" ||
      row.surface !== "live" ||
      row.currency !== "USD" ||
      !Number.isSafeInteger(row.totalQuantity) ||
      row.totalQuantity < 0
    )
      return { kind: "unknown" };
    const identity = tcgplayerExternalListingId(row.externalKey, row.conditionText);
    const skuId = row.externalKey.startsWith("product:") ? row.externalKey.slice(8) : row.externalKey;
    const set = identities.get(skuId) ?? new Set<string>();
    set.add(identity);
    identities.set(skuId, set);
  }
  for (const row of previous) {
    const identity = tcgplayerExternalListingId(row.externalKey, row.conditionText);
    if (prior.has(identity)) return { kind: "unknown" };
    prior.set(identity, row);
  }
  const quantities = new Map<string, number>();
  for (const sale of sales.quantities) {
    if (identities.has(sale.skuId) && identities.get(sale.skuId)!.size !== 1) return { kind: "unknown" };
    quantities.set(sale.skuId, sale.quantity);
  }
  const drops: Array<{ identity: string; quantity: number }> = [];
  const seen = new Set<string>();
  for (const row of current) {
    const identity = tcgplayerExternalListingId(row.externalKey, row.conditionText);
    if (seen.has(identity)) return { kind: "unknown" };
    seen.add(identity);
    const previousRow = prior.get(identity);
    if (!previousRow) continue;
    const skuId = row.externalKey.startsWith("product:") ? row.externalKey.slice(8) : row.externalKey;
    const remainder = previousRow.totalQuantity - row.totalQuantity - (quantities.get(skuId) ?? 0);
    if (remainder > 0) drops.push({ identity, quantity: remainder });
  }
  return { kind: "known", drops };
}
