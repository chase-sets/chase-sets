import { beforeAll, beforeEach, vi } from "vitest";
import { createPostgresEventStore, eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { credentialDatabase } from "../../credentials/tests/db-support";
import { channelConnectionSchemaSql } from "../../connections/read-model/schema";
import { connectorFeedSchemaSql } from "../../connector-feed/read-model/schema";
import { outboundSyncSchemaSql } from "../../outbound-sync/read-model/schema";
import { createConnectorFeedRuntime } from "../../connector-feed/api/runtime";
import { createEbayConnectionRuntime } from "../api/runtime";
import type { EbayOAuthProvider } from "../api/provider";
import { parseEbayOAuthConfiguration } from "../domain/configuration";
import { testContext } from "../../connections/tests/test-support";
import { payload } from "../../credentials/tests/fixtures";
import type { ChannelCredentialKeyring } from "../../credentials/domain/contracts";

export const owner = "acc_owner";
export const context = (accountId = owner) => ({
  ...testContext,
  audit: { ...testContext.audit, forAccountId: accountId as never },
});
export const config = parseEbayOAuthConfiguration("sandbox", "synthetic-app", "synthetic-secret", "synthetic-runame")!;
export const keys = (activeKeyId = "old"): ChannelCredentialKeyring => ({
  activeKeyId,
  keys: new Map([
    ["old", Buffer.alloc(32, 1)],
    ["new", Buffer.alloc(32, 2)],
    ["ebay-subject-root-v1", Buffer.alloc(32, 3)],
  ]),
});
export function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function fixture(suffix: string) {
  const db = credentialDatabase(`ebay_${suffix}`);
  beforeAll(async () => {
    await db().query(
      eventCorePostgresSchemaSql + channelConnectionSchemaSql + connectorFeedSchemaSql + outboundSyncSchemaSql,
    );
  });
  beforeEach(async () => {
    await db()
      .query(`TRUNCATE channels_ebay_oauth_attempts,channels_ebay_disconnect_records,channels_ebay_seller_bindings,
    channels_connection_credentials,channels_ebay_account_deletion_receipts,channel_connections,channel_connector_pairings,
    channel_outbound_operations,event_store_events,event_store_streams CASCADE`);
  });
  function runtime(overrides: Partial<Parameters<typeof createEbayConnectionRuntime>[0]> = {}) {
    const provider: EbayOAuthProvider = {
      exchange: vi.fn(async () => ({
        ...payload,
        refresh: { kind: "present" as const, token: "synthetic-refresh", expiresAt: "2030-01-01T00:00:00Z" },
      })),
      identity: vi.fn(async () => "synthetic-subject"),
      revoke: vi.fn(async () => 200),
    };
    const eventStore = createPostgresEventStore({ pool: db() });
    const service = createEbayConnectionRuntime({
      db: db(),
      eventStore,
      configuration: config,
      keyring: keys(),
      provider,
      ...overrides,
    });
    const feed = createConnectorFeedRuntime({
      db: db(),
      eventStore,
      beforeConnectionLock: service.beforeConnectionLock,
      disconnectEffect: service.disconnectEffect,
    });
    return { service, provider: overrides.provider ?? provider, eventStore, feed };
  }
  async function authorize(r: ReturnType<typeof runtime>, accountId = owner, connectionId: string | null = null) {
    const { authorizationUrl } = await r.service.start(accountId, false, connectionId);
    return new URL(authorizationUrl).searchParams.get("state")!;
  }
  async function connect(r: ReturnType<typeof runtime>, accountId = owner) {
    return r.service.callback(accountId, await authorize(r, accountId), "synthetic-code", context(accountId));
  }
  const envelopes = async () =>
    (
      await db().query<{ row_id: string; token_generation: string; connection_id: string }>(
        "SELECT row_id,token_generation,connection_id FROM channels_connection_credentials ORDER BY row_id",
      )
    ).rows;
  return { db, runtime, authorize, connect, envelopes };
}
