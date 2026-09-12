import { toTransportEvent } from "@chase-sets/event-core/transport";
import { afterAll, beforeAll, describe } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { buildPolicyDocumentProjectionHandlers } from "@chase-sets/platform-policy/projection";
import { module as channelsModule } from "../../../index";
import type { ChannelsServices } from "../../../server";
import type { ChannelConnectionStatus } from "../../connections/domain/contracts";
import { deriveChannelHealthSourceWorkId, healthDigest } from "../domain/identity";
import { channelHealthPolicy } from "../domain/policy";
import {
  channelHealthReasons,
  type ChannelHealthObservation,
  type ChannelHealthPolicy,
  type ChannelHealthReason,
} from "../domain/contracts";

export const context: EventStoreContext = {
  tenantId: "tnt_health",
  audit: { performedByUserId: "usr_health", forAccountId: "acc_health" },
};
const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
export const describeDb = baseUrl ? describe : describe.skip;

export function healthDatabase(name: string) {
  let pools: Readonly<Record<"channels", PgTransactionalPool>>;
  let services: ChannelsServices;
  let sequence = 0;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["channels"], name);
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    services = channelsModule.createServices(pools.channels, {
      setupResolver: {
        resolve: async ({ providerKey, environment }) => ({
          providerKey,
          environment,
          requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
        }),
      },
      storageLocationAuthority: {
        resolve: async ({ accountId, storageLocationId }) => ({
          accountId,
          storageLocationId,
          revision: 1,
          status: "active",
        }),
      },
    });
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  const query = (connectionId: string) => ({ connectionId, accountId: context.audit.forAccountId });
  return {
    get db() {
      return pools.channels;
    },
    get services() {
      return services;
    },
    query,
    async connection(status: ChannelConnectionStatus = "active") {
      const connectionId = `connection_health_${name}_${++sequence}`;
      await services.connections.connectChannel(
        { ...query(connectionId), providerKey: "health-test-provider" },
        { deploymentEnvironment: "test" },
        context,
      );
      if (status !== "pending-setup")
        await services.connections.activateChannelConnection(
          { ...query(connectionId), bindings: [{ storageLocationId: "location_health", revision: 1 }] },
          context,
        );
      if (status === "paused") await services.connections.pauseChannelConnection(query(connectionId), context);
      if (status === "disconnected")
        await services.connections.disconnectChannelConnection(query(connectionId), context);
      return connectionId;
    },
    async observation(
      connectionId: string,
      reasonCode: ChannelHealthReason = "polling",
      overrides: Partial<ChannelHealthObservation> = {},
    ): Promise<ChannelHealthObservation> {
      const health = (await services.connectionHealth.readConnectionHealth(query(connectionId))).health;
      const sourceKind = reasonCode === "drift" ? "channel-reconciliation" : reasonCode;
      return {
        schemaVersion: "ChannelHealthObservation/v1",
        connectionId,
        reasonCode,
        sourceKind,
        sourceWorkId: deriveChannelHealthSourceWorkId({
          sourceKind,
          connectionId,
          authorityIdentity: healthDigest("synthetic-authority"),
          operationMode: "scheduled",
          setupGeneration: 1,
          scheduleGeneration: 1,
          policyRevision: health.policyRevision,
        }),
        sourceAttempt: 1,
        resultOrdinal: 1,
        policyRevision: health.policyRevision,
        evaluationGeneration: health.evaluationGeneration,
        fingerprint: healthDigest([connectionId, reasonCode]),
        outcome: "failure",
        occurredAt: new Date().toISOString(),
        ...overrides,
      };
    },
    async healthy(connectionId: string) {
      for (const reason of channelHealthReasons) {
        await services.connectionHealth.submitObservation(
          await this.observation(connectionId, reason, { outcome: "success" }),
          context,
        );
      }
    },
    async policy(value: ChannelHealthPolicy, projectionDb?: PgQueryable) {
      const eventStore = createPostgresEventStore({ pool: pools.channels });
      const runtime = createPolicyRuntime({ eventStore, db: pools.channels });
      const existing = await pools.channels.query<{ document_id: string }>(
        "SELECT document_id FROM platform_policy_documents WHERE policy_key = $1",
        [channelHealthPolicy.policyKey],
      );
      const params = {
        status: "active" as const,
        value,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_health" as const,
      };
      const result = existing.rows[0]
        ? await runtime.revisePolicyDocument(channelHealthPolicy, existing.rows[0].document_id, params, context)
        : await runtime.createPolicyDocument(channelHealthPolicy, params, context);
      const events = await eventStore.readStream({
        streamId: `platform-policy.document-${result.documentId}`,
        fromVersion: result.version,
      });
      const event = events[0];
      const handlers = buildPolicyDocumentProjectionHandlers(projectionDb ?? pools.channels);
      await handlers[event.eventType](toTransportEvent(event));
    },
  };
}
