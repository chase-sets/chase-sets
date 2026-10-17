import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { buildChannelConnectionProjectionHandlers } from "../read-model/projection";
import { listPublicChannelConnections } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-connection-projection-concurrency", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_connection_projection");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("keeps the newer row when a stale projector writer arrives later", async () => {
    const handlers = buildChannelConnectionProjectionHandlers(pools.channels);
    await apply(handlers, connected("connection_stale", 1));
    await apply(handlers, activated("connection_stale", 2));
    await apply(handlers, transition("channels.connection.paused", "connection_stale", 3));
    await apply(handlers, activated("connection_stale", 2));
    const row = await pools.channels.query<{ status: string; last_stream_version: string }>(
      "SELECT status, last_stream_version::text FROM channel_connections WHERE connection_id = $1",
      ["connection_stale"],
    );
    expect(row.rows[0]).toEqual({ status: "paused", last_stream_version: "3" });
  });

  it("drains three pages for default and disconnected history with bound cursors and tied-time ordering", async () => {
    const handlers = buildChannelConnectionProjectionHandlers(pools.channels);
    for (let index = 0; index < 9; index += 1) {
      const id = `connection_${index}`;
      await apply(handlers, connected(id, 1));
      if (index % 3 === 0) {
        await apply(handlers, activated(id, 2));
      } else if (index % 3 === 1) {
        await apply(handlers, transition("channels.connection.disconnected", id, 2));
      }
    }
    const defaults = await drain({ accountId: "acc_owner", limit: 2 });
    const disconnected = await drain({ accountId: "acc_owner", status: "disconnected", limit: 1 });
    expect(defaults).toHaveLength(6);
    expect(defaults.every((item) => item.status !== "disconnected")).toBe(true);
    expect(disconnected).toHaveLength(3);
    expect(disconnected.every((item) => item.status === "disconnected")).toBe(true);
    expect(defaults.map((item) => item.connectionId)).toEqual(
      [...defaults.map((item) => item.connectionId)].sort().reverse(),
    );

    const first = await listPublicChannelConnections(pools.channels, { accountId: "acc_owner", limit: 2 });
    await expect(
      listPublicChannelConnections(pools.channels, { accountId: "acc_foreign", limit: 2, cursor: first.nextCursor }),
    ).rejects.toThrow("invalid-page");
    await expect(
      listPublicChannelConnections(pools.channels, {
        accountId: "acc_owner",
        status: "disconnected",
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("invalid-page");
  });
});

async function drain(input: { accountId: string; limit: number; status?: "disconnected" }) {
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await listPublicChannelConnections(pools.channels, { ...input, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function apply(
  handlers: ReturnType<typeof buildChannelConnectionProjectionHandlers>,
  event: ReturnType<typeof connected>,
) {
  await handlers[event.type]?.(event);
}

function connected(connectionId: string, streamVersion: number) {
  return buildTransportEvent(
    "channels.connection.connected",
    {
      connectionId,
      accountId: "acc_owner",
      providerKey: "fixture-provider",
      environment: "sandbox",
      createdAt: "2026-09-05T12:34:56.789-05:00",
    },
    {
      streamId: `channels.connection-${connectionId}`,
      streamVersion,
      globalPosition: `${connectionId}_${streamVersion}`,
    },
  );
}

function activated(connectionId: string, streamVersion: number) {
  return buildTransportEvent(
    "channels.connection.activated",
    {
      connectionId,
      credentialReference: "credential-reference-1",
      bindings: [{ storageLocationId: "location_1", revision: 1 }],
    },
    {
      streamId: `channels.connection-${connectionId}`,
      streamVersion,
      globalPosition: `${connectionId}_${streamVersion}`,
    },
  );
}

function transition(
  type: "channels.connection.paused" | "channels.connection.disconnected",
  connectionId: string,
  streamVersion: number,
) {
  return buildTransportEvent(
    type,
    { connectionId },
    {
      streamId: `channels.connection-${connectionId}`,
      streamVersion,
      globalPosition: `${connectionId}_${streamVersion}`,
    },
  );
}
