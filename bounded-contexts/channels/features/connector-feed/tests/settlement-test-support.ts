import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { module as channelsModule } from "../../../index";
import type { ConnectorReport } from "../domain/transport";
import { channelListingEventCodec } from "../../listing-composition/domain/codecs";
import { buildChannelListingStateProjectionHandlers } from "../../listing-composition/read-model/state-projection";
import { buildChannelConnectionProjectionHandlers } from "../../connections/read-model/projection";
import { buildChannelConnectionFactsProjectionHandlers } from "../../listing-composition/read-model/facts-projection";
import { buildChannelOutboundOperationReactionHandlers } from "../../outbound-sync/integrations/listing-composition";
import { deriveClaimedOperationOutcomes } from "../../tcgplayer-csv/domain/lifecycle";
import { channelHealthReasons } from "../../connection-health/domain/contracts";
import { healthDigest } from "../../connection-health/domain/identity";

export async function prepareConnectorBoundSettlement(
  db: PgTransactionalPool,
  services: ReturnType<typeof channelsModule.createServices>,
  input: Readonly<{ connectionId: string; pairingId: string; context: EventStoreContext }>,
): Promise<ConnectorReport> {
  const { connectionId, pairingId, context } = input;
  const accountId = context.audit.forAccountId;
  const store = createPostgresEventStore({ pool: db });
  const connectionEvents = await store.readStream({ streamId: `channels.connection-${connectionId}` });
  for (const handlers of [
    buildChannelConnectionProjectionHandlers(db),
    buildChannelConnectionFactsProjectionHandlers(db),
  ]) {
    for (const event of connectionEvents) await handlers[event.eventType]?.(toTransportEvent(event));
  }
  for (const reasonCode of channelHealthReasons) {
    const health = (await services.connectionHealth.readConnectionHealth({ accountId, connectionId })).health;
    await services.connectionHealth.submitObservation(
      {
        schemaVersion: "ChannelHealthObservation/v1",
        connectionId,
        reasonCode,
        sourceKind: reasonCode === "drift" ? "channel-reconciliation" : reasonCode,
        sourceWorkId: healthDigest(["synthetic-context-free-settlement", connectionId, reasonCode]),
        sourceAttempt: 1,
        resultOrdinal: 1,
        policyRevision: health.policyRevision,
        evaluationGeneration: health.evaluationGeneration,
        fingerprint: healthDigest(reasonCode),
        outcome: "success",
        occurredAt: new Date().toISOString(),
      },
      context,
    );
  }
  for (const index of [1, 2]) {
    const listingId = `settlement_${index}`;
    const channelListingId = `channel_${listingId}`;
    await db.query(
      `INSERT INTO channels_listing_publication_facts
      (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
       selected_options,selected_option_key,listing_status,updated_at,listing_stream_version)
      VALUES ($1,$2,$3,$4,'1.00','USD',10,'[]','','active',now(),7)`,
      [listingId, accountId, `item_${index}`, `catalog_${index}`],
    );
    await db.query(
      `INSERT INTO channels_external_product_reference_facts
      VALUES ('tcgplayer',$1,$2,'[]','','linked',now(),1)`,
      [`sku:${2000 + index}`, `catalog_${index}`],
    );
    await db.query(
      `INSERT INTO channels_external_catalog_item_reference_facts
      VALUES ('tcgplayer',$1,$2,'linked',now(),1)`,
      [`product:${1000 + index}`, `catalog_${index}`],
    );
    const placeholder = "chase-sets:snapshot-preserved:tcgplayer";
    const stored = await store.appendToStream({
      streamId: `channels.channel-listing-${channelListingId}`,
      expectedVersion: "no_stream",
      context,
      events: [
        channelListingEventCodec.encode({
          type: "channels.channel-listing.desired-state-changed",
          data: {
            connectionId,
            channelListingId,
            listingId,
            listingRevision: 7,
            desiredStateSequence: 1,
            desiredStateHash: "a".repeat(64),
            intent: "publish",
            draft: {
              channelListingId,
              listingRevision: 7,
              title: placeholder,
              description: placeholder,
              categoryKey: placeholder,
              conditionKey: placeholder,
              price: { amountMinor: 100, currency: "USD" },
              quantity: 2,
              attributes: [],
            },
          },
        }),
      ],
    });
    const event = stored[0]!;
    await buildChannelListingStateProjectionHandlers(db)[event.eventType]!(toTransportEvent(event));
    await buildChannelOutboundOperationReactionHandlers(services.outboundSync)[event.eventType]!(
      toTransportEvent(event),
    );
  }
  const at = new Date().toISOString();
  const snapshot = await services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
    snapshotId: "snapshot_context_free",
    connectionId,
    surface: "staged",
    csv: "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price\n1001,0,0,1.00\n1002,0,0,1.00",
    limits: { maxRecords: 2 },
    ingestedAt: at,
    capturedAt: at,
    capturedAtSource: "operator-declared",
  });
  if (snapshot.kind !== "parsed") throw new Error("synthetic-settlement-snapshot-refused");
  const composed = await services.tcgplayerCsv.composeTcgplayerSyncRun(
    {
      runId: "run_context_free",
      connectionId,
      claimant: { claimantKind: "connector", claimantId: pairingId },
      leaseMs: 1_800_000,
      manualClaimLeasePolicySnapshot: null,
      resolvedPolicy: { maxRowsPerBatch: 100 },
      composedAt: at,
    },
    context,
  );
  if (!composed || composed.run.members.length !== 2 || composed.run.members.some((m) => m.memberKind !== "composed")) {
    throw new Error("synthetic-settlement-run-incomplete");
  }
  const run = composed.run;
  return {
    reservationId: run.reservationId,
    outcomes: deriveClaimedOperationOutcomes({ ...run, state: "abandoned" }),
    runSettlement: {
      runId: run.runId,
      expectedRunRevision: run.revision,
      fromState: "composed",
      toState: "abandoned",
      verificationSnapshotId: null,
      verificationSnapshotGeneration: null,
      uploadAttemptedAt: null,
      uploadFileName: null,
      importSummary: null,
    },
  };
}

export async function connectorSettlementEffects(db: PgTransactionalPool) {
  const tables = [
    "channel_outbound_operations",
    "channel_outbound_lanes",
    "channel_outbound_reservation_settlements",
    "channel_sync_runs",
    "channel_sync_run_rows",
    "channels_channel_listing_links",
    "channels_channel_publication_operations",
    "event_store_events",
  ];
  const e1 = Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await db.query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows,
      ]),
    ),
  );
  return { e1, e2: (await db.query("SELECT * FROM channel_connector_liveness_authority ORDER BY connection_id")).rows };
}

export async function failConnectorSettlementAt(
  db: PgTransactionalPool,
  phase: "run-append" | "projection" | "receipt" | "audit",
) {
  const table = {
    "run-append": "event_store_events",
    projection: "channel_sync_runs",
    receipt: "channel_outbound_reservation_settlements",
    audit: "channel_connector_audit",
  }[phase];
  const condition = phase === "run-append" ? "NEW.event_type = 'channels.tcgplayer-sync-run.transitioned'" : "true";
  await db.query(`CREATE FUNCTION fail_connector_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic-settlement-failure'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER fail_connector_settlement BEFORE INSERT OR UPDATE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION fail_connector_settlement()`);
  return async () => {
    await db.query(`DROP TRIGGER fail_connector_settlement ON ${table}`);
    await db.query("DROP FUNCTION fail_connector_settlement()");
  };
}
