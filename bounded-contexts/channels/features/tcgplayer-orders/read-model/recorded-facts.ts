import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { assertTcgplayerOrderRecord, tcgplayerSaleKey } from "../domain/contracts";
import { channelSaleFingerprint } from "../../reconciliation/api/sale-recorder";
import { hashChannelDesiredState } from "../../listing-composition/domain/canonical";
import { assertRfc3339Instant, assertClosedRecord } from "../../connections/domain/validation";

export type RecordedTcgplayerSaleFacts =
  | Readonly<{ kind: "known"; quantities: readonly Readonly<{ skuId: string; quantity: number }>[] }>
  | Readonly<{ kind: "unknown" }>;

const RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;

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
    // Allow five minutes of provider/server clock skew. No upper receipt bound:
    // an in-interval sale can be observed and committed after the capture.
    const observations = await db.query<{ record: unknown; state: string; order_reference: string | null }>(
      `SELECT record,state,order_reference FROM channel_order_observations WHERE connection_id=$1
       AND (record->>'kind'='order' OR order_reference IS NOT NULL)
       AND received_at>$2::timestamptz ORDER BY received_at,sequence LIMIT $3`,
      [input.connectionId, new Date(Date.parse(input.from) - RECEIPT_CLOCK_SKEW_MS).toISOString(), input.maxLines + 1],
    );
    if (observations.rows.length > input.maxLines) return { kind: "unknown" };
    const found = new Map<string, { fingerprint: string; skuId: string; quantity: number }>();
    let scannedLines = 0;
    for (const observation of observations.rows) {
      try {
        assertTcgplayerOrderRecord(observation.record);
      } catch {
        if (observation.order_reference !== null) return { kind: "unknown" };
        continue;
      }
      const order = observation.record;
      if (order.kind !== "order") continue;
      const soldAt = new Date(order.soldAt).toISOString();
      if (Date.parse(soldAt) <= Date.parse(input.from) || Date.parse(soldAt) > Date.parse(input.to)) continue;
      if (observation.state === "expired" || observation.state === "invalid") return { kind: "unknown" };
      scannedLines += order.lines.length;
      if (scannedLines > input.maxLines) return { kind: "unknown" };
      for (const line of order.lines) {
        if (!line.skuId || !line.productId) continue;
        const key = channelSaleFingerprint(
          tcgplayerSaleKey(input.accountId, input.connectionId, order.orderNumber, line),
        );
        const fingerprint = hashChannelDesiredState({ ...line, soldAt, currencyCode: "USD" });
        if (found.has(key) && found.get(key)!.fingerprint !== fingerprint) return { kind: "unknown" };
        found.set(key, { fingerprint, skuId: line.skuId, quantity: line.quantity });
      }
    }
    if (found.size === 0) return { kind: "known", quantities: [] };
    const commits = await db.query<{ sale_key_fingerprint: string; facts_fingerprint: string }>(
      `SELECT sale_key_fingerprint,facts_fingerprint FROM channel_order_lines
       WHERE connection_id=$1 AND sale_key_fingerprint=ANY($2::text[])
       ORDER BY sale_key_fingerprint LIMIT $3`,
      [input.connectionId, [...found.keys()], input.maxLines + 1],
    );
    if (commits.rows.length > input.maxLines) return { kind: "unknown" };
    const committed = new Map(commits.rows.map((row) => [row.sale_key_fingerprint, row.facts_fingerprint]));
    if (committed.size !== commits.rows.length || [...committed.keys()].some((key) => !found.has(key)))
      return { kind: "unknown" };
    const quantities = new Map<string, number>();
    for (const [key, fact] of found) {
      if (!committed.has(key)) continue;
      if (committed.get(key) !== fact.fingerprint) return { kind: "unknown" };
      const quantity = (quantities.get(fact.skuId) ?? 0) + fact.quantity;
      if (!Number.isSafeInteger(quantity)) return { kind: "unknown" };
      quantities.set(fact.skuId, quantity);
    }
    return { kind: "known", quantities: [...quantities].map(([skuId, quantity]) => ({ skuId, quantity })) };
  } catch {
    return { kind: "unknown" };
  }
}
