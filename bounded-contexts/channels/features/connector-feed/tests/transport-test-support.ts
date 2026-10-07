import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as authModule } from "@chase-sets/auth";
import { createConnectorOAuthService } from "@chase-sets/auth/server";
import { CHANNEL_CONNECTOR_SCOPE_FAMILY } from "@chase-sets/auth-context";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { buildPolicyDocumentProjectionHandlers } from "@chase-sets/platform-policy/projection";
import { module as channelsModule } from "../../../index";
import { buildChannelConnectionProjectionHandlers } from "../../connections/read-model/projection";
import { buildChannelConnectionFactsProjectionHandlers } from "../../listing-composition/read-model/facts-projection";
import type { MarketplaceChannelInboundClampCapability } from "../../../support/request-support/marketplace-channel-inbound-clamp";
import { channelHealthPolicy } from "../../connection-health/domain/policy";
import {
  channelHealthReasons,
  type ChannelHealthPolicy,
  type ChannelHealthReason,
} from "../../connection-health/domain/contracts";
import { healthDigest } from "../../connection-health/domain/identity";
import type { EnqueueOutboundOperation } from "../../outbound-sync/domain/contracts";
import { channelListingEventCodec } from "../../listing-composition/domain/codecs";
import type { ChannelListingDesiredStateChangedData } from "../../listing-composition/domain/contracts";
import { buildChannelListingStateProjectionHandlers } from "../../listing-composition/read-model/state-projection";
import { buildChannelOutboundOperationReactionHandlers } from "../../outbound-sync/integrations/listing-composition";
import { createConnectorTransportRoutes } from "../api/transport-routes";
import type { ConnectorTransportServices } from "../api/transport";
import { connectorTransportPolicy, type ConnectorPolicy } from "../domain/policy";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for connector transport DB tests.");
export const describeDb = baseUrl ? describe : describe.skip;
export const transportContext: EventStoreContext = {
  tenantId: "tnt_transport",
  audit: { performedByUserId: "usr_transport", forAccountId: "acc_transport" },
};
export const seller = {
  userId: transportContext.audit.performedByUserId,
  accountId: transportContext.audit.forAccountId,
  permissions: ["channels.manage", "channels.view"],
};
export const target = { accountId: seller.accountId, connectionId: "connection_transport" };
export function transportDatabase(suffix: string) {
  let pools: Readonly<Record<"channels" | "auth", PgTransactionalPool>>;
  let auth: ReturnType<typeof authModule.createServices>;
  let oauth: ReturnType<typeof createConnectorOAuthService>;
  let services: ReturnType<typeof channelsModule.createServices>;
  let token: string;
  let pairingId: string;
  const marketplaceChannelInboundClamp: MarketplaceChannelInboundClampCapability = {
    kind: "available",
    port: {
      engage: async ({ listingIds }) => ({
        kind: "engaged",
        requestedListingCount: listingIds.length,
        affectedListingCount: listingIds.length,
        clampedListingCount: listingIds.length,
        recoveryListingCount: 0,
      }),
      recover: async ({ listingIds }) => ({
        kind: "released",
        examinedListingCount: listingIds.length,
        releasedListingCount: listingIds.length,
        retainedListingCount: 0,
        recoveryListingCount: 0,
      }),
    },
  };
  const ports = {
    marketplaceChannelInboundClamp,
    setupResolver: {
      resolve: async ({
        providerKey,
        environment,
      }: {
        providerKey: string;
        environment: "sandbox" | "production";
      }) => ({
        providerKey,
        environment,
        requirements: {
          credential: "not-required" as const,
          requiredPolicyKeys: [],
          binding: "one-or-more-current" as const,
        },
      }),
    },
    storageLocationAuthority: {
      resolve: async ({ accountId, storageLocationId }: { accountId: string; storageLocationId: string }) => ({
        accountId,
        storageLocationId,
        revision: 1,
        status: "active" as const,
      }),
    },
    channelSaleRecorder: async (): Promise<never> => {
      throw new Error("transport-must-not-record-sales");
    },
  };
  function restart() {
    services = channelsModule.createServices(pools.channels, { ...ports, connectorOAuth: oauth });
    return services;
  }
  async function projectConnection(connectionId = target.connectionId) {
    const store = createPostgresEventStore({ pool: pools.channels });
    const handlers = buildChannelConnectionProjectionHandlers(pools.channels);
    const facts = buildChannelConnectionFactsProjectionHandlers(pools.channels);
    const events = await store.readStream({ streamId: `channels.connection-${connectionId}` });
    for (const event of events) {
      const handler = handlers[event.eventType];
      if (handler) await handler(toTransportEvent(event));
      const fact = facts[event.eventType];
      if (fact) await fact(toTransportEvent(event));
    }
  }
  async function connection(connectionId = target.connectionId, accountId = target.accountId) {
    const query = { connectionId, accountId };
    await services.connections.connectChannel(
      { ...query, providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      transportContext,
    );
    await services.connections.activateChannelConnection(
      { ...query, bindings: [{ storageLocationId: "location_transport", revision: 1 }] },
      transportContext,
    );
    await projectConnection(connectionId);
    return query;
  }
  async function observation(
    connectionId: string,
    reasonCode: ChannelHealthReason,
    outcome: "success" | "failure",
    attempt = 1,
  ) {
    const query = { ...target, connectionId };
    const health = (await services.connectionHealth.readConnectionHealth(query)).health;
    return services.connectionHealth.submitObservation(
      {
        schemaVersion: "ChannelHealthObservation/v1",
        connectionId,
        reasonCode,
        sourceKind: reasonCode === "drift" ? "channel-reconciliation" : reasonCode,
        sourceWorkId: healthDigest(["transport-fixture", connectionId, reasonCode, outcome, attempt]),
        sourceAttempt: attempt,
        resultOrdinal: 1,
        policyRevision: health.policyRevision,
        evaluationGeneration: health.evaluationGeneration,
        fingerprint: healthDigest(reasonCode),
        outcome,
        occurredAt: new Date().toISOString(),
      },
      transportContext,
    );
  }
  async function healthy(connectionId = target.connectionId) {
    for (const reason of channelHealthReasons) await observation(connectionId, reason, "success");
  }
  async function pair(connectionId = target.connectionId) {
    const registration = await oauth.register({
      redirect_uri: "https://connector.example/callback",
      token_endpoint_auth_method: "none",
      scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
    });
    const pairing = await services.connectorFeed.createPairingCode({ ...target, connectionId }, seller);
    const verifier = "transport-secret-sentinel-" + "v".repeat(50);
    const authorized = await services.connectorFeed.authorizePairing(
      {
        client_id: registration.client_id,
        redirect_uri: registration.redirect_uri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      },
      seller,
    );
    const exchanged = await services.connectorFeed.exchange({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code: authorized.code,
      code_verifier: verifier,
    });
    return { token: exchanged.access_token, pairingId: pairing.pairingId };
  }
  beforeAll(async () => {
    if (!baseUrl) throw new Error("missing-test-database");
    const urls = createMultiContextTestDatabaseUrls(baseUrl, ["channels", "auth"], suffix);
    await ensureMultiContextTestDatabases(baseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    auth = authModule.createServices(pools.auth, {});
    oauth = createConnectorOAuthService(() => auth, { connectorRedirectUris: ["https://connector.example/callback"] });
    restart();
    await pools.auth.query(
      `INSERT INTO auth_identity_accounts (account_id,name,display_name,account_type,status,updated_at) VALUES ($1,'','Transport fixture','personal','active',now())`,
      [seller.accountId],
    );
    await pools.auth.query(
      `INSERT INTO auth_identity_user_memberships (membership_id,user_id,account_id,role_key,role_permissions,status)
      VALUES ('membership_transport',$1,$2,'seller','["channels.manage","channels.view"]','active')`,
      [seller.userId, seller.accountId],
    );
    await connection();
    await healthy();
    ({ token, pairingId } = await pair());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  return {
    get db() {
      return pools.channels;
    },
    get authDb() {
      return pools.auth;
    },
    get services() {
      return services;
    },
    get token() {
      return token;
    },
    get pairingId() {
      return pairingId;
    },
    restart,
    connection,
    pair,
    projectConnection,
    healthy,
    observation,
    async projectListing(listingId: string) {
      const store = createPostgresEventStore({ pool: pools.channels });
      const handlers = buildChannelListingStateProjectionHandlers(pools.channels);
      for (const event of await store.readStream({ streamId: `channels.channel-listing-channel_${listingId}` })) {
        const handler = handlers[event.eventType];
        if (handler) await handler(toTransportEvent(event));
      }
    },
    async request(
      operation: "claim" | "report" | "ingest",
      value: unknown = {},
      options: { token?: string; connectionId?: string; service?: ConnectorTransportServices } = {},
    ) {
      return createConnectorTransportRoutes(options.service ?? services.connectorFeed, pools.channels).request(
        `/connections/${options.connectionId ?? target.connectionId}/${operation}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${options.token ?? token}`, "content-type": "application/json" },
          body: JSON.stringify(value),
        },
      );
    },
    async membership(active: boolean) {
      await pools.auth.query(
        "UPDATE auth_identity_user_memberships SET status=$1 WHERE membership_id='membership_transport'",
        [active ? "active" : "revoked"],
      );
    },
    async revokeAuthGrant() {
      const grant = await oauth.resolveToken(token);
      if (!grant) throw new Error("missing-fixture-grant");
      await oauth.revoke(grant.grantId);
    },
    async pause() {
      await services.connections.pauseChannelConnection(target, transportContext);
      await projectConnection();
    },
    async effects() {
      const tables = [
        "channel_outbound_operations",
        "channel_outbound_lanes",
        "channel_provider_rate_state",
        "channel_outbound_reservation_settlements",
        "channel_sync_runs",
        "channel_sync_run_rows",
        "channel_connector_inbound_events",
        "channel_connector_inbound_payloads",
        "channels_channel_listing_links",
        "channels_channel_publication_operations",
        "channel_inventory_snapshots",
        "channel_inventory_snapshot_rows",
        "channel_export_schema_pins",
        "event_store_events",
      ];
      const e1 = Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [
            table,
            (await pools.channels.query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`))
              .rows,
          ]),
        ),
      );
      return {
        e1,
        e2: (
          await pools.channels.query(
            "SELECT pairing_id,revision,last_seen_at,served_poll_window_seconds FROM channel_connector_pairings ORDER BY pairing_id",
          )
        ).rows,
        e3: (await pools.channels.query("SELECT * FROM channel_connector_audit ORDER BY request_id")).rows,
      };
    },
    async policy(value: ChannelHealthPolicy) {
      const store = createPostgresEventStore({ pool: pools.channels });
      const runtime = createPolicyRuntime({ eventStore: store, db: pools.channels });
      const existing = await pools.channels.query<{ document_id: string }>(
        "SELECT document_id FROM platform_policy_documents WHERE policy_key=$1",
        [channelHealthPolicy.policyKey],
      );
      const params = {
        status: "active" as const,
        value,
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveUntil: null,
        actorUserId: seller.userId,
      };
      const result = existing.rows[0]
        ? await runtime.revisePolicyDocument(
            channelHealthPolicy,
            existing.rows[0].document_id,
            params,
            transportContext,
          )
        : await runtime.createPolicyDocument(channelHealthPolicy, params, transportContext);
      const events = await store.readStream({
        streamId: `platform-policy.document-${result.documentId}`,
        fromVersion: result.version,
      });
      const handlers = buildPolicyDocumentProjectionHandlers(pools.channels);
      for (const event of events) {
        const handler = handlers[event.eventType];
        if (handler) await handler(toTransportEvent(event));
      }
    },
    async connectorPolicy(value: ConnectorPolicy) {
      const store = createPostgresEventStore({ pool: pools.channels });
      const runtime = createPolicyRuntime({ eventStore: store, db: pools.channels });
      const result = await runtime.createPolicyDocument(
        connectorTransportPolicy,
        {
          status: "active",
          value,
          effectiveFrom: "2026-01-01T00:00:00Z",
          effectiveUntil: null,
          actorUserId: seller.userId,
        },
        transportContext,
      );
      const handlers = buildPolicyDocumentProjectionHandlers(pools.channels);
      for (const event of await store.readStream({ streamId: `platform-policy.document-${result.documentId}` })) {
        const handler = handlers[event.eventType];
        if (handler) await handler(toTransportEvent(event));
      }
      return result.documentId;
    },
    async enqueue(
      listingId: string,
      sequence = 1,
      operationKind: "publish" | "update" | "delist" = "publish",
    ): Promise<EnqueueOutboundOperation> {
      const channelListingId = `channel_${listingId}`;
      const common = {
        connectionId: target.connectionId,
        channelListingId,
        listingId,
        listingRevision: 7,
        desiredStateSequence: sequence,
        desiredStateHash: sequence.toString(16).padStart(64, "0"),
      };
      const data: ChannelListingDesiredStateChangedData =
        operationKind === "delist"
          ? {
              ...common,
              intent: "delist",
              delist: {
                channelListingId,
                listingRevision: 7,
                lastPublishedPrice: { amountMinor: 100, currency: "USD" },
                lastPublishedQuantity: 1,
                delistReasons: ["listing-not-active"],
              },
            }
          : {
              ...common,
              intent: operationKind,
              draft: {
                channelListingId,
                listingRevision: 7,
                title: listingId,
                description: "Synthetic",
                categoryKey: "cards",
                conditionKey: "near-mint",
                price: { amountMinor: 100, currency: "USD" },
                quantity: sequence,
                attributes: [],
              },
            };
      const store = createPostgresEventStore({ pool: pools.channels });
      const streamId = `channels.channel-listing-${channelListingId}`;
      const stored = await store.appendToStream({
        streamId,
        expectedVersion: sequence === 1 ? "no_stream" : sequence - 1,
        context: transportContext,
        events: [channelListingEventCodec.encode({ type: "channels.channel-listing.desired-state-changed", data })],
      });
      const event = stored[0];
      if (!event) throw new Error("missing-fixture-desired-state-event");
      const transport = toTransportEvent(event);
      const projection = buildChannelListingStateProjectionHandlers(pools.channels)[event.eventType];
      const reaction = buildChannelOutboundOperationReactionHandlers(services.outboundSync)[event.eventType];
      if (!projection || !reaction) throw new Error("missing-owned-handler");
      await projection(transport);
      await reaction(transport);
      const input: EnqueueOutboundOperation = {
        ...common,
        operationKind,
        payload:
          data.intent === "delist" ? { kind: "delist", delist: data.delist } : { kind: "draft", draft: data.draft },
        envelope: {
          sourceEventId: String(event.eventId),
          sourceStreamId: streamId,
          sourceStreamVersion: sequence,
          sourceGlobalPosition: event.globalPosition,
          sourceOccurredAt: event.occurredAt,
        },
      };
      return input;
    },
  };
}
