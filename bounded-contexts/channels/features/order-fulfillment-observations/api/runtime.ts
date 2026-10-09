import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import type {
  ChannelOrderFulfillmentAcceptedPayload,
  CommittedExternalChannelSalePayload,
} from "@chase-sets/event-core/public-event-payloads";
import type { ConnectorTransportServices } from "../../connector-feed/api/transport";
import type { AdmittedConnectorInboundEvent } from "../../connector-feed/read-model/inbound";
import { resolveTcgplayerOrderSaleTarget } from "../../reconciliation/read-model/sale-target";
import { tcgplayerSaleKey } from "../../tcgplayer-orders/domain/contracts";
import { hashChannelDesiredState } from "../../listing-composition/domain/canonical";
import { reconcileOrderAttention } from "../../connection-attention/read-model/order-contributions";
import {
  assertFulfillmentObservation,
  assertAcceptedReadyToShipQuery,
  composeChannelOrderFulfillmentInbound,
  fulfillmentObservationDigest,
  fulfillmentObservationKind,
  translateOrderStatus,
  translateOrderShippingType,
  type ChannelOrderFulfillmentObservation,
  type AcceptedReadyToShipQuery,
} from "../domain/contracts";

type Dependencies = Readonly<{
  db: PgTransactionalPool;
  eventStore: PostgresEventStore;
  readAdmittedConnectorInboundEvents: ConnectorTransportServices["readAdmittedConnectorInboundEvents"];
}>;
type Order = {
  status: string;
  content_digest: string | null;
  last_sequence: string;
  accepted_at: Date | string | null;
  revision: string;
};
type State = "awaiting-sale" | "sale-absent" | "accepted" | "refused" | "expired";

export type FulfillmentObservationServices = ReturnType<typeof createFulfillmentObservationRuntime>;

export async function readAcceptedReadyToShipMembership(db: PgQueryable, input: AcceptedReadyToShipQuery) {
  assertAcceptedReadyToShipQuery(input);
  if (input.orderReferences.length === 0) return [];
  const result = await db.query<{ order_reference: string }>(
    `SELECT order_reference FROM channel_fulfillment_orders
    WHERE connection_id=$1 AND order_reference=ANY($2::text[]) AND accepted_at IS NOT NULL
      AND provider_order_status IN ('{"surface":"list","value":"Ready to Ship"}'::jsonb,
        '{"surface":"detail","value":"Ready to Ship"}'::jsonb)
    ORDER BY order_reference`,
    [input.connectionId, input.orderReferences],
  );
  return result.rows.map((row) => row.order_reference);
}

export function createFulfillmentObservationRuntime(deps: Dependencies) {
  let afterConnection = "";
  async function interpretConnection(connectionId: string) {
    const progress = await deps.db.query<{ cursor: string | null }>(
      `SELECT cursor FROM channel_fulfillment_consumer WHERE connection_id=$1`,
      [connectionId],
    );
    const cursor = progress.rows[0]?.cursor ?? null;
    const page = await deps.readAdmittedConnectorInboundEvents({
      connectionId,
      inboundKind: fulfillmentObservationKind,
      limit: 100,
      ...(cursor ? { after: cursor } : {}),
    });
    if (page.completeness.kind !== "complete") return 0;
    return withPgTransaction(deps.db, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`channels.fulfillment:${connectionId}`]);
      const current = await db.query<{ cursor: string | null }>(
        `SELECT cursor FROM channel_fulfillment_consumer WHERE connection_id=$1`,
        [connectionId],
      );
      if ((current.rows[0]?.cursor ?? null) !== cursor) return 0;
      const connection = await db.query<{ account_id: string; now: string }>(
        `SELECT account_id,clock_timestamp()::text AS now FROM channel_connections WHERE connection_id=$1 AND provider_key='tcgplayer'`,
        [connectionId],
      );
      const row = connection.rows[0];
      if (!row) return 0;
      const now = new Date(row.now).toISOString();
      let changed = 0;
      for (const event of page.events) changed += await interpret(db, deps.eventStore, row.account_id, event, now);
      if (page.nextCursor !== cursor)
        await db.query(
          `INSERT INTO channel_fulfillment_consumer (connection_id,cursor)
        VALUES ($1,$2) ON CONFLICT (connection_id) DO UPDATE SET cursor=$2
        WHERE channel_fulfillment_consumer.cursor IS DISTINCT FROM $2`,
          [connectionId, page.nextCursor],
        );
      return changed;
    });
  }
  return {
    readAcceptedReadyToShipMembership: (input: AcceptedReadyToShipQuery) =>
      readAcceptedReadyToShipMembership(deps.db, input),
    interpretConnection,
    async interpretDueConnections() {
      const due = await deps.db.query<{ connection_id: string }>(
        `SELECT connection_id FROM channel_connections
        WHERE provider_key='tcgplayer' AND connection_id>$1 ORDER BY connection_id LIMIT 20`,
        [afterConnection],
      );
      // A process-local round-robin needs no durable timestamp churn for unchanged orders.
      // Restarting begins the scan again; interpretation and page recovery remain durable.
      afterConnection = due.rows.length === 20 ? due.rows.at(-1)!.connection_id : "";
      let changed = 0;
      for (const row of due.rows) changed += await interpretConnection(row.connection_id);
      return changed;
    },
  };
}

async function interpret(
  db: PgQueryable,
  store: PostgresEventStore,
  accountId: string,
  event: AdmittedConnectorInboundEvent,
  now: string,
) {
  const prior = await db.query<{ state: State }>(
    `SELECT state FROM channel_fulfillment_observations WHERE provider_event_id=$1`,
    [event.providerEventId],
  );
  if (prior.rows[0] && !["awaiting-sale", "sale-absent"].includes(prior.rows[0].state)) return 0;
  if (event.content.state === "expired" || Date.parse(now) - Date.parse(event.receivedAt) > 7776000000) {
    // Expired bytes cannot be reconstructed from the accepted event or another PII store.
    await db.query(
      `UPDATE channel_fulfillment_observations SET state='expired',reason='input-unavailable',
      changed_at=$2,revision=revision+1 WHERE provider_event_id=$1 AND state IN ('awaiting-sale','sale-absent')`,
      [event.providerEventId, now],
    );
    return 0;
  }
  let observation: ChannelOrderFulfillmentObservation;
  try {
    const payload = event.content.payload;
    if (!("records" in payload) || payload.records.length !== 1) return 0;
    const record = payload.records[0];
    assertFulfillmentObservation(record);
    if ((await composeChannelOrderFulfillmentInbound(record)).externalReference !== event.externalReference) return 0;
    observation = record;
  } catch {
    return 0;
  }
  const digest = await fulfillmentObservationDigest(observation);
  const identity = {
    accountId,
    connectionId: event.connectionId,
    providerKey: observation.providerKey,
    externalOrderReference: observation.externalOrderReference,
  };
  const status = translateOrderStatus(observation.providerOrderStatus);
  const result = await db.query<Order>(
    `SELECT status,content_digest,last_sequence::text,accepted_at,revision::text
    FROM channel_fulfillment_orders WHERE connection_id=$1 AND order_reference=$2`,
    [event.connectionId, observation.externalOrderReference],
  );
  const order = result.rows[0];
  const save = async (state: State, reason: string | null) => {
    const saved = await db.query(
      `INSERT INTO channel_fulfillment_observations
      (provider_event_id,connection_id,account_id,order_reference,digest,sequence,state,reason,received_at,changed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (provider_event_id) DO UPDATE
      SET state=$7,reason=$8,changed_at=$10,revision=channel_fulfillment_observations.revision+1
      WHERE (channel_fulfillment_observations.state,channel_fulfillment_observations.reason) IS DISTINCT FROM ($7::text,$8::text)
      RETURNING provider_event_id`,
      [
        event.providerEventId,
        event.connectionId,
        accountId,
        observation.externalOrderReference,
        digest,
        event.sequence,
        state,
        reason,
        event.receivedAt,
        now,
      ],
    );
    await reconcileOrderAttention(db, accountId, event.connectionId, observation.externalOrderReference, now);
    return saved.rows.length;
  };
  if (order && BigInt(event.sequence) <= BigInt(order.last_sequence)) return save("refused", "superseded");
  if (observation.variant === "status-only" && !order?.accepted_at)
    return save("refused", "accepted-reference-required");
  if (order?.accepted_at) {
    if (observation.variant === "full") {
      const contentDigest = await fullContentDigest(observation);
      if (contentDigest !== order.content_digest) return save("refused", "accepted-content-changed");
    }
    const updated = await db.query(
      `UPDATE channel_fulfillment_orders SET status=$3,last_sequence=$4,revision=revision+1,provider_order_status=$6::jsonb
      WHERE connection_id=$1 AND order_reference=$2 AND revision=$5 AND last_sequence<$4 AND accepted_at IS NOT NULL
      RETURNING order_reference`,
      [
        event.connectionId,
        observation.externalOrderReference,
        status,
        event.sequence,
        order.revision,
        JSON.stringify(observation.providerOrderStatus),
      ],
    );
    if (updated.rows.length !== 1) throw new Error("Fulfillment acceptance concurrency conflict");
    if (order.status !== status) {
      await publish("channels.order-fulfillment-observation.status-changed", { ...identity, status });
    }
    return save("accepted", null);
  }
  if (observation.variant !== "full") return 0;
  if (status === "cancelled") {
    await db.query(
      `INSERT INTO channel_fulfillment_orders (connection_id,order_reference,account_id,status,last_sequence)
      VALUES ($1,$2,$3,'cancelled',$4) ON CONFLICT (connection_id,order_reference) DO UPDATE
      SET status='cancelled',last_sequence=$4,revision=channel_fulfillment_orders.revision+1
      WHERE channel_fulfillment_orders.last_sequence<$4`,
      [event.connectionId, observation.externalOrderReference, accountId, event.sequence],
    );
    await db.query(
      `UPDATE channel_fulfillment_observations SET state='refused',reason='cancelled-before-acceptance',changed_at=$3,revision=revision+1
      WHERE connection_id=$1 AND order_reference=$2 AND state IN ('awaiting-sale','sale-absent')`,
      [event.connectionId, observation.externalOrderReference, now],
    );
    return save("refused", "cancelled-before-acceptance");
  }
  const resolved = await resolveLines(db, accountId, event.connectionId, observation);
  if (resolved.kind === "refused") return save("refused", resolved.reason);
  if (resolved.kind === "waiting")
    return save(
      Date.parse(now) - Date.parse(event.receivedAt) >= 86400000 ? "sale-absent" : "awaiting-sale",
      resolved.reason,
    );
  const payload: ChannelOrderFulfillmentAcceptedPayload = {
    ...identity,
    status,
    orderedAt: observation.orderedAt,
    acceptedAt: now,
    shippingOption: translateOrderShippingType(observation.providerShippingType),
    shipTo: observation.shipTo,
    lines: resolved.lines,
    productAmount: observation.productAmount,
    shippingAmount: observation.shippingAmount,
    currencyCode: observation.currency.code,
  };
  const accepted = await db.query(
    `INSERT INTO channel_fulfillment_orders
    (connection_id,order_reference,account_id,status,content_digest,last_sequence,accepted_at,provider_order_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (connection_id,order_reference) DO UPDATE
    SET status=$4,content_digest=$5,last_sequence=$6,accepted_at=$7,provider_order_status=$8::jsonb,
      revision=channel_fulfillment_orders.revision+1
    WHERE channel_fulfillment_orders.accepted_at IS NULL AND channel_fulfillment_orders.last_sequence<$6
      AND channel_fulfillment_orders.revision=$9
    RETURNING order_reference`,
    [
      event.connectionId,
      observation.externalOrderReference,
      accountId,
      status,
      await fullContentDigest(observation),
      event.sequence,
      now,
      JSON.stringify(observation.providerOrderStatus),
      order?.revision ?? null,
    ],
  );
  if (accepted.rows.length !== 1) throw new Error("Fulfillment acceptance concurrency conflict");
  await publish("channels.order-fulfillment-observation.accepted", payload);
  await db.query(
    `UPDATE channel_fulfillment_observations SET state='refused',reason='superseded',changed_at=$3,revision=revision+1
    WHERE connection_id=$1 AND order_reference=$2 AND state IN ('awaiting-sale','sale-absent') AND sequence<$4`,
    [event.connectionId, observation.externalOrderReference, now, event.sequence],
  );
  return save("accepted", null);

  async function publish(
    eventType: string,
    payload: ChannelOrderFulfillmentAcceptedPayload | (typeof identity & { status: typeof status }),
  ) {
    await store.appendToStreamInTransaction(db, {
      streamId: `channels.order-fulfillment-${hashChannelDesiredState(identity)}`,
      expectedVersion: "any",
      wakeSourceContextName: "channels",
      events: [{ eventType, payload }],
      context: {
        tenantId: "tnt_channels_worker",
        audit: { performedByUserId: "usr_channels_worker", forAccountId: accountId as never },
      },
    });
  }
}

async function fullContentDigest(observation: Extract<ChannelOrderFulfillmentObservation, { variant: "full" }>) {
  return hashChannelDesiredState({ ...observation, providerOrderStatus: null });
}
async function resolveLines(
  db: PgQueryable,
  accountId: string,
  connectionId: string,
  observation: Extract<ChannelOrderFulfillmentObservation, { variant: "full" }>,
) {
  const lines: ChannelOrderFulfillmentAcceptedPayload["lines"][number][] = [];
  for (const line of observation.lines) {
    const expectedIdentity = tcgplayerSaleKey(
      accountId,
      connectionId,
      observation.externalOrderReference,
      line,
    ).orderLineIdentity;
    if (expectedIdentity !== line.providerOrderLineIdentity)
      return { kind: "waiting", reason: "sale-not-found" } as const;
    const target = await resolveTcgplayerOrderSaleTarget(db, { accountId, connectionId, skuId: line.skuId });
    if (target.kind === "unmappable") return { kind: "waiting", reason: "unmapped" } as const;
    const candidates = await db.query<{
      committed_sale: CommittedExternalChannelSalePayload;
      facts_fingerprint: string;
    }>(
      `SELECT committed_sale,facts_fingerprint FROM channel_order_lines WHERE connection_id=$1
        AND committed_sale->'saleKey'->>'providerKey'=$2 AND committed_sale->'saleKey'->>'orderLineIdentity'=$3 LIMIT 2`,
      [connectionId, observation.providerKey, line.providerOrderLineIdentity],
    );
    if (candidates.rows.length > 1) return { kind: "refused", reason: "ambiguous-sale" } as const;
    const candidate = candidates.rows[0];
    if (!candidate) return { kind: "waiting", reason: "sale-not-found" } as const;
    const sale = candidate.committed_sale;
    const fingerprint = hashChannelDesiredState({
      productId: line.productId,
      skuId: line.skuId,
      quantity: line.quantity,
      unitPriceAmount: line.unitPriceAmount,
      soldAt: new Date(observation.orderedAt).toISOString(),
      currencyCode: observation.currency.code,
    });
    if (
      sale.accountId !== accountId ||
      sale.inventoryItemId !== target.inventoryItemId ||
      sale.requestedQuantity !== line.quantity ||
      candidate.facts_fingerprint !== fingerprint
    )
      return { kind: "refused", reason: "sale-facts-mismatch" } as const;
    const listing = await db.query<{ catalog_item_id: string; product_id: string; item_title: string | null }>(
      `SELECT listing.catalog_item_id,item.product_id,listing.item_title FROM channels_listing_publication_facts listing
        JOIN channel_fulfillment_item_facts item ON item.item_id=listing.inventory_item_id AND item.account_id=listing.account_id
        WHERE listing_id=$1 AND listing.account_id=$2`,
      [target.listingId, accountId],
    );
    const fact = listing.rows[0];
    if (!fact?.item_title) return { kind: "waiting", reason: "unmapped" } as const;
    lines.push({
      saleKey: sale.saleKey,
      inventoryItemId: sale.inventoryItemId,
      storageLocationId: sale.storageLocationId,
      catalogItemId: fact.catalog_item_id,
      productId: fact.product_id,
      itemTitle: fact.item_title,
      quantity: line.quantity,
      unitPriceAmount: line.unitPriceAmount,
    });
  }
  return { kind: "resolved", lines } as const;
}
