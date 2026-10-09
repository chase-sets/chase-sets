import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeAll, beforeEach, afterAll, afterEach, describe, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  createMultiContextTestPools,
  resetMultiContextTestSchemas,
  closeMultiContextTestPools,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool, type PgQueryable } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as authModule } from "@chase-sets/auth";
import { createConnectorOAuthService } from "@chase-sets/auth/server";
import { CHANNEL_CONNECTOR_SCOPE_FAMILY } from "@chase-sets/auth-context";
import { module as channelsModule } from "@chase-sets/channels";
import type { ChannelHealthObservation } from "@chase-sets/channels/server";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for worker liveness DB proofs.");
export const describeDb = baseUrl ? describe : describe.skip;
export const transportContext: EventStoreContext = {
  tenantId: "tnt_liveness",
  audit: { performedByUserId: "usr_liveness", forAccountId: "acc_liveness" },
};
export const seller = {
  userId: transportContext.audit.performedByUserId,
  accountId: transportContext.audit.forAccountId,
  permissions: ["channels.manage", "channels.view"],
};
export const target = { accountId: seller.accountId, connectionId: "connection_worker_liveness" };
const baselineReasons = [
  "credential",
  "seller-setup",
  "subscription",
  "polling",
  "drift",
  "provider-rate",
  "provider-availability",
  "sale-follow-up",
] as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function transportDatabase(suffix: string) {
  let pools: Readonly<Record<"channels" | "auth", PgTransactionalPool>>;
  let oauth: ReturnType<typeof createConnectorOAuthService>;
  let services: ReturnType<typeof channelsModule.createServices>;
  let token: string;
  let pairingId: string;
  const ports = {
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
      resolve: async (input: { accountId: string; storageLocationId: string }) => ({
        ...input,
        revision: 1,
        status: "active" as const,
      }),
    },
    channelSaleRecorder: async (): Promise<never> => {
      throw new Error("liveness-proof-must-not-record-sale");
    },
  };
  function restart(omitHealthConsultation = false, omitSellerAdmission = false) {
    // Negative control only: omit the health dependency at real service composition.
    // The candidate never supplies this port, and always consults landed health.
    let pool = pools.channels;
    if (omitSellerAdmission) {
      const wrap =
        (db: PgQueryable): PgQueryable["query"] =>
        async <Row>(sql: string, values?: readonly unknown[]) => {
          const admitted = sql.replace(
            "AND connection.status = 'active' AND lane.blocked_operation_id IS NULL",
            "AND connection.status IN ('active','paused') AND lane.blocked_operation_id IS NULL",
          );
          const result = await db.query<Row>(admitted, values);
          return {
            ...result,
            rows: result.rows.map((row) =>
              typeof row === "object" && row !== null && "connection_status" in row
                ? { ...row, connection_status: "active" }
                : row,
            ),
          };
        };
      pool = {
        query: wrap(pools.channels),
        connect: async () => {
          const client = await pools.channels.connect();
          return { query: wrap(client), release: client.release.bind(client) };
        },
      };
    }
    services = channelsModule.createServices(pool, {
      ...ports,
      connectorOAuth: oauth,
      ...(omitHealthConsultation ? { readChannelHealthHold: async () => false } : {}),
    });
    return services;
  }
  async function projectConnection(connectionId = target.connectionId) {
    const handlers = services.projectors.find(
      (entry) => entry.projectionName === "channel-connection-projection",
    )!.handlers;
    for (const event of await createPostgresEventStore({ pool: pools.channels }).readStream({
      streamId: `channels.connection-${connectionId}`,
    })) {
      await handlers[event.eventType]?.(toTransportEvent(event));
    }
  }
  async function connection(connectionId = target.connectionId) {
    const query = { ...target, connectionId };
    await services.connections.connectChannel(
      { ...query, providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      transportContext,
    );
    await services.connections.activateChannelConnection(
      { ...query, bindings: [{ storageLocationId: "synthetic_location", revision: 1 }] },
      transportContext,
    );
    await projectConnection(connectionId);
  }
  async function observation(
    connectionId: string,
    reasonCode: ChannelHealthObservation["reasonCode"],
    outcome: "success" | "failure",
    attempt = 1,
  ) {
    const health = (await services.connectionHealth.readConnectionHealth({ ...target, connectionId })).health;
    return services.connectionHealth.submitObservation(
      {
        schemaVersion: "ChannelHealthObservation/v1",
        connectionId,
        reasonCode,
        sourceKind: reasonCode === "drift" ? "channel-reconciliation" : reasonCode,
        sourceWorkId: digest(["synthetic-worker-liveness", connectionId, reasonCode, outcome, attempt]),
        sourceAttempt: attempt,
        resultOrdinal: 1,
        policyRevision: health.policyRevision,
        evaluationGeneration: health.evaluationGeneration,
        fingerprint: digest(reasonCode),
        outcome,
        occurredAt: new Date().toISOString(),
      },
      transportContext,
    );
  }
  async function healthy(connectionId = target.connectionId) {
    for (const reason of baselineReasons) await observation(connectionId, reason, "success");
  }
  async function pair(connectionId = target.connectionId) {
    const registration = await oauth.register({
      redirect_uri: "https://connector.example/callback",
      token_endpoint_auth_method: "none",
      scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
    });
    const paired = await services.connectorFeed.createPairingCode({ ...target, connectionId }, seller);
    const verifier = "synthetic-worker-liveness-" + "v".repeat(50);
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
    return { token: exchanged.access_token, pairingId: paired.pairingId };
  }
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["channels", "auth"], suffix);
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    const auth = authModule.createServices(pools.auth, {});
    oauth = createConnectorOAuthService(() => auth, { connectorRedirectUris: ["https://connector.example/callback"] });
    restart();
    await pools.auth.query(
      "INSERT INTO auth_identity_accounts (account_id,name,display_name,account_type,status,updated_at) VALUES ($1,'','Synthetic liveness','personal','active',now())",
      [seller.accountId],
    );
    await pools.auth.query(
      `INSERT INTO auth_identity_user_memberships (membership_id,user_id,account_id,role_key,role_permissions,status)
      VALUES ('synthetic_liveness_membership',$1,$2,'seller','["channels.manage","channels.view"]','active')`,
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
    get services() {
      return services;
    },
    get pairingId() {
      return pairingId;
    },
    restart,
    connection,
    healthy,
    observation,
    pair,
    projectConnection,
    async request(
      operation: "claim" | "report" | "ingest",
      value: unknown = {},
      options: { connectionId?: string; token?: string } = {},
    ) {
      const api = channelsModule.buildApis!(services).find((entry) => entry.mountPath === "/channel-connector/oauth")!;
      if (!(api.router instanceof Hono)) throw new Error("missing-connector-router");
      return api.router.request(`/connections/${options.connectionId ?? target.connectionId}/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token ?? token}`, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    },
    async enqueue(listingId: string) {
      const channelListingId = `channel_${listingId}`;
      const store = createPostgresEventStore({ pool: pools.channels });
      const streamId = `channels.channel-listing-${channelListingId}`;
      const data = {
        connectionId: target.connectionId,
        channelListingId,
        listingId,
        listingRevision: 7,
        desiredStateSequence: 1,
        desiredStateHash: "a".repeat(64),
        intent: "publish" as const,
        draft: {
          channelListingId,
          listingRevision: 7,
          title: "Synthetic",
          description: "Synthetic liveness proof",
          categoryKey: "synthetic",
          conditionKey: "synthetic",
          price: { amountMinor: 100, currency: "USD" },
          quantity: 1,
          attributes: [],
        },
      };
      await pools.channels.query(
        `INSERT INTO channels_listing_publication_facts
        (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,selected_options,selected_option_key,listing_status,updated_at,listing_stream_version)
        VALUES ($1,$2,$3,$4,'1.00','USD',10,'[]','','active',now(),7)`,
        [listingId, target.accountId, `item_${listingId}`, `catalog_${listingId}`],
      );
      const [event] = await store.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context: transportContext,
        events: [{ eventType: "channels.channel-listing.desired-state-changed", payload: data }],
      });
      if (!event) throw new Error("missing-desired-state-event");
      for (const projector of services.projectors) await projector.handlers[event.eventType]?.(toTransportEvent(event));
      await services.outboundSync.enqueueDesiredState({
        ...data,
        operationKind: "publish",
        payload: { kind: "draft", draft: data.draft },
        envelope: {
          sourceEventId: String(event.eventId),
          sourceStreamId: streamId,
          sourceStreamVersion: event.streamVersion,
          sourceGlobalPosition: event.globalPosition,
          sourceOccurredAt: event.occurredAt,
        },
      });
    },
  };
}
