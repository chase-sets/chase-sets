import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { assertTcgplayerOrderRecord, tcgplayerSaleKey } from "../domain/contracts";
import { channelSaleFingerprint } from "../../reconciliation/api/sale-recorder";
import { hashChannelDesiredState } from "../../listing-composition/domain/canonical";
import { assertRfc3339Instant, assertClosedRecord } from "../../connections/domain/validation";

export type RecordedTcgplayerSaleFacts =
  | Readonly<{ kind: "known"; quantities: readonly Readonly<{ skuId: string; quantity: number }>[] }>
  | Readonly<{ kind: "unknown" }>;

// Receipt time and committed_sale do not contain the immutable provider line facts.
export async function readRecordedTcgplayerSaleFacts(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; accountId: string; from: string; to: string; maxLines: number }>,
): Promise<RecordedTcgplayerSaleFacts> {
  try {
    assertClosedRecord(input, ["connectionId", "accountId", "from", "to", "maxLines"], "recorded sale facts input");
    assertRfc3339Instant(input.from);
    assertRfc3339Instant(input.to);
    if (
      Date.parse(input.from) >= Date.parse(input.to) ||
      !Number.isSafeInteger(input.maxLines) ||
      input.maxLines < 1 ||
      input.maxLines > 1_000_000 ||
      !input.connectionId ||
      !input.accountId
    )
      return { kind: "unknown" };
    const commits = await db.query<{ sale_key_fingerprint: string; facts_fingerprint: string }>(
      `SELECT sale_key_fingerprint,facts_fingerprint FROM channel_order_lines
       WHERE connection_id=$1 ORDER BY sale_key_fingerprint LIMIT $2`,
      [input.connectionId, input.maxLines + 1],
    );
    if (commits.rows.length > input.maxLines) return { kind: "unknown" };
    if (commits.rows.length === 0) return { kind: "known", quantities: [] };
    const observations = await db.query<{ record: unknown }>(
      `SELECT record FROM channel_order_observations WHERE connection_id=$1
       AND (record->>'kind'='order' OR order_reference IS NOT NULL)
       ORDER BY sequence LIMIT $2`,
      [input.connectionId, input.maxLines + 1],
    );
    if (observations.rows.length > input.maxLines) return { kind: "unknown" };
    const committed = new Map(commits.rows.map((row) => [row.sale_key_fingerprint, row.facts_fingerprint]));
    if (committed.size !== commits.rows.length) return { kind: "unknown" };
    const found = new Map<string, { fingerprint: string; skuId: string; quantity: number; soldAt: string }>();
    let scannedLines = 0;
    for (const observation of observations.rows) {
      if (!observation.record) continue;
      try {
        assertTcgplayerOrderRecord(observation.record);
      } catch {
        continue;
      }
      const order = observation.record;
      if (order.kind !== "order") continue;
      scannedLines += order.lines.length;
      if (scannedLines > input.maxLines) return { kind: "unknown" };
      for (const line of order.lines) {
        if (!line.skuId || !line.productId) continue;
        const key = channelSaleFingerprint(
          tcgplayerSaleKey(input.accountId, input.connectionId, order.orderNumber, line),
        );
        if (!committed.has(key)) continue;
        const soldAt = new Date(order.soldAt).toISOString();
        const fingerprint = hashChannelDesiredState({ ...line, soldAt, currencyCode: "USD" });
        if (committed.get(key) !== fingerprint || (found.has(key) && found.get(key)!.fingerprint !== fingerprint))
          return { kind: "unknown" };
        found.set(key, { fingerprint, skuId: line.skuId, quantity: line.quantity, soldAt });
      }
    }
    if (found.size !== committed.size) return { kind: "unknown" };
    const quantities = new Map<string, number>();
    for (const fact of found.values()) {
      if (Date.parse(fact.soldAt) <= Date.parse(input.from) || Date.parse(fact.soldAt) > Date.parse(input.to)) continue;
      const quantity = (quantities.get(fact.skuId) ?? 0) + fact.quantity;
      if (!Number.isSafeInteger(quantity)) return { kind: "unknown" };
      quantities.set(fact.skuId, quantity);
    }
    return { kind: "known", quantities: [...quantities].map(([skuId, quantity]) => ({ skuId, quantity })) };
  } catch {
    return { kind: "unknown" };
  }
}
