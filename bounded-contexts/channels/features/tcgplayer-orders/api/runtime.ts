import { randomUUID } from "node:crypto";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ChannelReconciliationRuntimeDependencies } from "../../reconciliation/domain/contracts";
type RecordExternalChannelSale = ChannelReconciliationRuntimeDependencies["channelSaleRecorder"];
import type { ConnectorTransportServices } from "../../connector-feed/api/transport";
import { hashChannelDesiredState } from "../../listing-composition/domain/canonical";
import { resolveTcgplayerOrderSaleTarget } from "../../reconciliation/read-model/sale-target";
import {
  channelSaleFingerprint,
  recordMappedChannelSale,
  rememberRecordedSale,
} from "../../reconciliation/api/sale-recorder";
import { reconcileOrderAttention } from "../../connection-attention/read-model/order-contributions";
import type { ChannelOrderAttentionReason } from "../../connection-attention/domain/order-contribution";
import {
  ambiguousLineIndexes,
  assertTcgplayerOrderRecord,
  composeTcgplayerOrderInbound,
  pullSummaryGap,
  tcgplayerSaleKey,
  type TcgplayerOrderObservation,
  type TcgplayerOrderRecord,
  type TcgplayerPullSummary,
} from "../domain/contracts";

type Dependencies = Readonly<{
  db: PgTransactionalPool;
  readAdmittedConnectorInboundEvents: ConnectorTransportServices["readAdmittedConnectorInboundEvents"];
  channelSaleRecorder: RecordExternalChannelSale;
  backdatingAttentionAfterMs: () => Promise<number>;
}>;
type Observation = {
  provider_event_id: string;
  account_id: string;
  record: TcgplayerOrderRecord | null;
  state: string;
  revision: string;
  received_at: Date | string;
};
type LineOutcome = Readonly<{
  identity: string;
  state: "sale" | "gap";
  reason: ChannelOrderAttentionReason | null;
  detail: string | null;
}>;
export type TcgplayerOrderServices = ReturnType<typeof createTcgplayerOrderRuntime>;

export function createTcgplayerOrderRuntime(deps: Dependencies) {
  async function interpretConnection(connectionId: string): Promise<number> {
    const connection = await deps.db.query<{ account_id: string }>(
      `SELECT account_id FROM channel_connections WHERE connection_id=$1 AND provider_key='tcgplayer'`,
      [connectionId],
    );
    const accountId = connection.rows[0]?.account_id;
    if (!accountId) return 0;
    // Scheduler progress is separate from observation, sale, receipt and attention effects.
    // Even an inert connection rotates out of the bounded due-connection window.
    await deps.db.query(
      `INSERT INTO channel_order_consumer (connection_id,last_scanned_at) VALUES ($1,clock_timestamp())
      ON CONFLICT (connection_id) DO UPDATE SET last_scanned_at=EXCLUDED.last_scanned_at`,
      [connectionId],
    );
    const progress = await deps.db.query<{ cursor: string | null }>(
      `SELECT cursor FROM channel_order_consumer WHERE connection_id=$1`,
      [connectionId],
    );
    const cursor = progress.rows[0]?.cursor ?? null;
    const page = await deps.readAdmittedConnectorInboundEvents({
      connectionId,
      inboundKind: "order",
      limit: 100,
      ...(cursor === null ? {} : { after: cursor }),
    });
    if (page.completeness.kind !== "complete") return 0;
    const work = await deps.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM channel_order_observations
      WHERE connection_id=$1 AND (state IN ('pending','processing','gap') OR provider_event_id=ANY($2::text[]))`,
      [connectionId, page.events.map((event) => event.providerEventId)],
    );
    const unfinished = await deps.db.query(
      `SELECT 1 FROM channel_order_observations WHERE connection_id=$1
      AND state IN ('pending','processing','gap') LIMIT 1`,
      [connectionId],
    );
    if (
      Number(work.rows[0]?.count) === page.events.length &&
      unfinished.rows.length === 0 &&
      page.nextCursor === cursor
    )
      return 0;
    const owner = randomUUID();
    const claim = await deps.db.query<{ revision: string; cursor: string | null }>(
      `INSERT INTO channel_order_consumer (connection_id,owner,lease_until,revision)
       VALUES ($1,$2,clock_timestamp()+interval '2 minutes',1)
       ON CONFLICT (connection_id) DO UPDATE SET owner=$2,lease_until=clock_timestamp()+interval '2 minutes',
         revision=channel_order_consumer.revision+1
       WHERE channel_order_consumer.lease_until IS NULL OR channel_order_consumer.lease_until<clock_timestamp()
       RETURNING revision::text,cursor`,
      [connectionId, owner],
    );
    const claimed = claim.rows[0];
    if (!claimed) return 0;
    const fenced = async <T>(run: (db: PgQueryable) => Promise<T>): Promise<T> =>
      withPgTransaction(deps.db, async (db) => {
        const lock = await db.query(
          `SELECT 1 FROM channel_order_consumer WHERE connection_id=$1 AND owner=$2
        AND revision=$3 AND lease_until>clock_timestamp() FOR UPDATE`,
          [connectionId, owner, claimed.revision],
        );
        if (lock.rows.length !== 1) throw new Error("tcgplayer-order-claim-lost");
        return run(db);
      });
    try {
      if (claimed.cursor !== cursor) return 0;
      await fenced(async (db) => {
        for (const event of page.events) {
          // Retained facts are authoritative for retries after payload expiry. Never replace them.
          const exists = await db.query(`SELECT 1 FROM channel_order_observations WHERE provider_event_id=$1`, [
            event.providerEventId,
          ]);
          if (exists.rows.length) continue;
          let record: TcgplayerOrderRecord | null = null;
          let state = event.content.state === "expired" ? "expired" : "invalid";
          if (event.content.state === "available") {
            try {
              const payload = event.content.payload;
              if (!("records" in payload) || payload.records.length !== 1) throw new Error("one-record-required");
              const candidate = payload.records[0];
              assertTcgplayerOrderRecord(candidate);
              if (composeTcgplayerOrderInbound(candidate).externalReference !== event.externalReference)
                throw new Error("reference-mismatch");
              record = candidate;
              state = "pending";
            } catch {
              /* Only a safe invalid marker is retained; no raw payload or exception text. */
            }
          }
          await db.query(
            `INSERT INTO channel_order_observations
            (provider_event_id,connection_id,account_id,sequence,pull_id,order_reference,record,state,gap_reason,received_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) ON CONFLICT DO NOTHING`,
            [
              event.providerEventId,
              connectionId,
              accountId,
              event.sequence,
              record?.pullId ?? null,
              record?.kind === "order" ? record.orderNumber : null,
              record ? JSON.stringify(record) : null,
              state,
              record ? null : state === "expired" ? "content-expired" : "invalid-record",
              event.receivedAt,
            ],
          );
        }
        await db.query(
          `UPDATE channel_order_consumer SET cursor=$4,last_scanned_at=clock_timestamp()
          WHERE connection_id=$1 AND owner=$2 AND revision=$3`,
          [connectionId, owner, claimed.revision, page.nextCursor],
        );
      });
      const pending = await deps.db.query<Observation>(
        `SELECT provider_event_id,account_id,record,state,revision::text,received_at
        FROM channel_order_observations WHERE connection_id=$1 AND state IN ('pending','processing','gap')
        ORDER BY attempted_at,sequence LIMIT 100`,
        [connectionId],
      );
      const threshold = await deps.backdatingAttentionAfterMs();
      for (const observation of pending.rows) {
        if (!observation.record) continue;
        await fenced(async (db) => {
          await db.query(
            `UPDATE channel_order_observations SET state='processing',revision=revision+1
            WHERE provider_event_id=$1 AND revision=$2`,
            [observation.provider_event_id, observation.revision],
          );
        });
        const now = new Date().toISOString();
        const outcomes =
          observation.record.kind === "order"
            ? await interpretOrder(deps, connectionId, accountId, observation.record, now, threshold, fenced)
            : [];
        await fenced(async (db) => {
          const record = observation.record!;
          await db.query(
            `UPDATE channel_order_observations SET state=$2,line_outcomes=$3::jsonb,
            attempted_at=$4,revision=revision+1 WHERE provider_event_id=$1 AND revision=$5`,
            [
              observation.provider_event_id,
              outcomes.some((line) => line.state === "gap") ? "gap" : "completed",
              JSON.stringify(outcomes),
              now,
              Number(observation.revision) + 1,
            ],
          );
          if (record.kind === "order")
            await reconcileOrderAttention(db, accountId, connectionId, record.orderNumber, now);
          await reconcilePull(db, connectionId, record.pullId);
        });
      }
      return pending.rows.length;
    } finally {
      await deps.db.query(
        `UPDATE channel_order_consumer SET owner=NULL,lease_until=NULL
        WHERE connection_id=$1 AND owner=$2 AND revision=$3`,
        [connectionId, owner, claimed.revision],
      );
    }
  }
  return {
    interpretConnection,
    async interpretDueConnections() {
      const connections = await deps.db.query<{ connection_id: string }>(`SELECT connection.connection_id
        FROM channel_connections AS connection LEFT JOIN channel_order_consumer AS consumer USING (connection_id)
        WHERE connection.provider_key='tcgplayer'
        ORDER BY consumer.last_scanned_at NULLS FIRST,connection.connection_id LIMIT 20`);
      let count = 0;
      for (const row of connections.rows) count += await interpretConnection(row.connection_id);
      return count;
    },
  };
}

async function interpretOrder(
  deps: Dependencies,
  connectionId: string,
  accountId: string,
  order: TcgplayerOrderObservation,
  now: string,
  threshold: number,
  fenced: <T>(run: (db: PgQueryable) => Promise<T>) => Promise<T>,
): Promise<readonly LineOutcome[]> {
  const outcomes: LineOutcome[] = [];
  const ambiguous = ambiguousLineIndexes(order);
  if (order.cancelled)
    outcomes.push({ identity: "order", state: "sale", reason: "tcgplayer-order-cancelled", detail: null });
  if (!order.lines.length && !order.cancelled)
    return [{ identity: "order", state: "gap", reason: "tcgplayer-order-identity-ambiguous", detail: null }];
  for (const [index, line] of order.lines.entries()) {
    const identity = JSON.stringify([line.productId, line.skuId]);
    if (ambiguous.has(index)) {
      outcomes.push({ identity, state: "gap", reason: "tcgplayer-order-identity-ambiguous", detail: null });
      continue;
    }
    const saleKey = tcgplayerSaleKey(accountId, connectionId, order.orderNumber, line);
    const fingerprint = channelSaleFingerprint(saleKey);
    const soldAt = new Date(order.soldAt).toISOString();
    const factsFingerprint = hashChannelDesiredState({ ...line, soldAt, currencyCode: "USD" });
    const prior = await deps.db.query<{
      facts_fingerprint: string;
      backdated: boolean;
    }>(
      `SELECT facts_fingerprint,backdated FROM channel_order_lines WHERE connection_id=$1 AND sale_key_fingerprint=$2`,
      [connectionId, fingerprint],
    );
    if (prior.rows.length) {
      outcomes.push(
        prior.rows[0]!.facts_fingerprint === factsFingerprint
          ? { identity, state: "sale", reason: prior.rows[0]!.backdated ? "backdated-sale" : null, detail: null }
          : { identity, state: "gap", reason: "tcgplayer-order-recording-refused", detail: null },
      );
      continue;
    }
    const target = await resolveTcgplayerOrderSaleTarget(deps.db, { accountId, connectionId, skuId: line.skuId! });
    if (target.kind === "unmappable") {
      outcomes.push({ identity, state: "gap", reason: "tcgplayer-order-unmapped", detail: target.reason });
      continue;
    }
    const result = await recordMappedChannelSale(deps.channelSaleRecorder, {
      accountId,
      inventoryItemId: target.inventoryItemId,
      storageLocationId: target.storageLocationId,
      saleKey,
      requestedQuantity: line.quantity,
      unitPriceAmount: line.unitPriceAmount,
      currencyCode: "USD",
      soldAt,
      connectionAuditReference: connectionId,
    });
    if (!("status" in result)) {
      outcomes.push({ identity, state: "gap", reason: "tcgplayer-order-recording-refused", detail: null });
      continue;
    }
    await fenced(async (db) => {
      await db.query(
        `INSERT INTO channel_order_lines (connection_id,sale_key_fingerprint,facts_fingerprint,committed_sale,backdated)
        VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,
        [
          connectionId,
          fingerprint,
          factsFingerprint,
          JSON.stringify(result.sale),
          Date.parse(now) - Date.parse(order.soldAt) >= threshold,
        ],
      );
      await rememberRecordedSale(db, connectionId, fingerprint, now);
    });
    outcomes.push({
      identity,
      state: "sale",
      reason: Date.parse(now) - Date.parse(order.soldAt) >= threshold ? "backdated-sale" : null,
      detail: null,
    });
  }
  return outcomes;
}

async function reconcilePull(db: PgQueryable, connectionId: string, pullId: string) {
  const existing = await db.query(
    `SELECT 1 FROM channel_order_pulls WHERE connection_id=$1 AND pull_id=$2 AND state='complete'`,
    [connectionId, pullId],
  );
  if (existing.rows.length) return;
  const summaries = await db.query<{ record: TcgplayerPullSummary }>(
    `SELECT record FROM channel_order_observations WHERE connection_id=$1 AND pull_id=$2 AND record->>'kind'='summary' ORDER BY sequence LIMIT 2`,
    [connectionId, pullId],
  );
  const totals = await db.query<{
    orders: string;
    unique_orders: string;
    lines: string;
    sales: string;
    gaps: string;
    pending: boolean;
  }>(
    `SELECT count(*)::text AS orders,count(DISTINCT order_reference)::text AS unique_orders,
      COALESCE(sum(jsonb_array_length(record->'lines')),0)::text AS lines,
      COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(line_outcomes) AS line WHERE line->>'state'='sale' AND line->>'identity'<>'order')),0)::text AS sales,
      COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(line_outcomes) AS line WHERE line->>'state'='gap')),0)::text AS gaps,
      COALESCE(bool_or(state<>'completed'),false) AS pending
     FROM channel_order_observations WHERE connection_id=$1 AND pull_id=$2 AND record->>'kind'='order'`,
    [connectionId, pullId],
  );
  const total = totals.rows[0]!;
  const summary = summaries.rows[0]?.record;
  const orderCount = Number(total.unique_orders);
  const lines = Number(total.lines),
    sales = Number(total.sales),
    gaps = Number(total.gaps);
  const reason = !summary
    ? "summary-missing"
    : summaries.rows.length !== 1
      ? "summary-conflict"
      : (pullSummaryGap(summary) ??
        (orderCount !== Number(total.orders)
          ? "order-repeated"
          : orderCount !== summary.totalOrders
            ? "detail-missing"
            : total.pending
              ? "interpretation-pending"
              : gaps
                ? "line-gaps"
                : null));
  const state = reason === null ? "complete" : "unknown";
  await db.query(
    `INSERT INTO channel_order_pulls (connection_id,pull_id,state,gap_reason,order_count,line_count,sale_count,gap_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (connection_id,pull_id) DO UPDATE SET state=$3,gap_reason=$4,
      order_count=$5,line_count=$6,sale_count=$7,gap_count=$8,revision=channel_order_pulls.revision+1
    WHERE (channel_order_pulls.state,channel_order_pulls.gap_reason,channel_order_pulls.order_count,
      channel_order_pulls.line_count,channel_order_pulls.sale_count,channel_order_pulls.gap_count)
      IS DISTINCT FROM ($3::text,$4::text,$5::int,$6::int,$7::int,$8::int)`,
    [connectionId, pullId, state, reason, orderCount, lines, sales, gaps],
  );
}
