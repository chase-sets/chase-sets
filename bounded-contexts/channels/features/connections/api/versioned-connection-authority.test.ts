import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresConfigurationEpochStore,
  createPostgresEventStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { ConfigurationEpochError } from "@chase-sets/event-core/configuration-epoch";
import { activateFixture, connectFixture, createConnectionHarness, testContext } from "../tests/test-support";
import { channelConnectionEventCodec } from "../domain/codec";
import { evolveChannelConnection, initialChannelConnectionState } from "../domain/domain";
import * as projections from "../read-model/queries";
import { connectionAuthorityEventClassification, createConnectionEpochs } from "./owner-epochs";
import { createVersionedConnectionAuthority } from "./versioned-connection-authority";

const consumer = { storeId: "synthetic-terminal", incarnation: "synthetic-terminal-v1" };
const target = { accountId: "acc_owner", connectionId: "connection_1" };
const input = { ...target, consumer };

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const h = createConnectionHarness();
  const query: PgTransactionalPool["query"] = async <Row = Record<string, unknown>>(sql: string) => {
    if (sql.includes("channel_connections")) throw new Error("poisoned projection SQL");
    const rows = sql.startsWith("SELECT current_version")
      ? [{ current_version: h.memory.streams.get("channels.connection-connection_1")?.length ?? 0 }]
      : [];
    return { rows: rows as Row[] };
  };
  const pool: PgTransactionalPool = { query, connect: async () => ({ query: pool.query, release() {} }) };
  const querySpy = vi.spyOn(pool, "query");
  const raw = createPostgresEventStore({ pool });
  vi.spyOn(raw, "readStreamInTransaction").mockImplementation((_db, request) =>
    h.memory.eventStore.readStream(request),
  );
  const epochs = createConnectionEpochs(pool);
  const source = createPostgresConfigurationEpochStore({
    pool,
    consumers: [],
    sourceIncarnation: "synthetic-source-v1",
    readCanonicalCreation: async () => ({
      kind: "CREATED",
      sourceIncarnation: "synthetic-source-v1",
      keyCreationEpoch: 0,
    }),
  });
  const captureGrant = vi.spyOn(source, "captureGrantInTransaction").mockResolvedValue({
    key: "connection/connection_1",
    sourceIncarnation: "synthetic-source-v1",
    keyCreationEpoch: 0,
    epoch: 0,
    topologyRevision: 1,
    consumer,
  });
  vi.spyOn(epochs, "source").mockResolvedValue(source);
  const poisoned = vi
    .spyOn(projections, "getPublicChannelConnection")
    .mockRejectedValue(new Error("poisoned getConnection"));
  const authority = createVersionedConnectionAuthority(pool, raw, epochs);
  return { ...h, pool, query: querySpy, authority, captureGrant, poisoned };
}

describe("Versioned Connection Authority", () => {
  it("captures canonical active identity, loaded version and class-C grant with poisoned projections", async () => {
    const f = await fixture();
    await connectFixture(f.services);
    await activateFixture(f.services);
    expect(await f.authority.capture(input)).toMatchObject({
      kind: "granted",
      accountId: input.accountId,
      connectionId: input.connectionId,
      providerKey: "fixture-provider",
      environment: "sandbox",
      status: "active",
      version: 2,
      seal: { version: 2, storeIncarnation: "synthetic-source-v1" },
      grant: { key: "connection/connection_1", epoch: 0, consumer },
    });
    expect(f.captureGrant).toHaveBeenCalledWith(expect.anything(), "connection/connection_1", consumer);
    expect(f.poisoned).not.toHaveBeenCalled();
  });

  it.each(["absent", "foreign", "pending-setup", "paused", "disconnected"])(
    "refuses %s without granting",
    async (state) => {
      const f = await fixture();
      if (state !== "absent") await connectFixture(f.services);
      if (["foreign", "paused", "disconnected"].includes(state)) await activateFixture(f.services);
      if (state === "paused") await f.services.pauseChannelConnection(target, testContext);
      if (state === "disconnected") await f.services.disconnectChannelConnection(target, testContext);
      expect(
        await f.authority.capture({ ...input, accountId: state === "foreign" ? "acc_foreign" : input.accountId }),
      ).toEqual({
        kind: "denied",
        reason: ["absent", "foreign"].includes(state) ? "connection-not-found" : "connection-not-active",
      });
      expect(f.captureGrant).not.toHaveBeenCalled();
      expect(f.poisoned).not.toHaveBeenCalled();
    },
  );

  it("refuses CLOSING and a stream head beyond the complete loaded history", async () => {
    const f = await fixture();
    await connectFixture(f.services);
    await activateFixture(f.services);
    f.captureGrant.mockRejectedValueOnce(new ConfigurationEpochError("source is CLOSING"));
    expect(await f.authority.capture(input)).toEqual({ kind: "denied", reason: "connection-authority-unavailable" });
    f.query.mockImplementation(async <Row>(sql: string) => ({
      rows: (sql.startsWith("SELECT current_version") ? [{ current_version: 3 }] : []) as Row[],
    }));
    expect(await f.authority.capture(input)).toEqual({ kind: "denied", reason: "connection-authority-unavailable" });
    expect(f.captureGrant).toHaveBeenCalledTimes(1);
  });

  it("excludes sibling facts and credentials from the canonical Connection fold", async () => {
    const f = await fixture();
    await connectFixture(f.services);
    await activateFixture(f.services);
    const history = await f.memory.eventStore.readStream({ streamId: "channels.connection-connection_1" });
    const fold = () =>
      history.map(channelConnectionEventCodec.decode).reduce(evolveChannelConnection, initialChannelConnectionState);
    const before = fold();
    for (const eventType of [
      "channels.connection.health-changed",
      "channels.connection.attention-opened",
      "channels.connection.attention-resolved",
      "channels.connector.paired",
      "channels.credential.replaced",
      "channels.ebay-account-deletion.received",
      "channels.ebay-credential-refresh.completed",
    ]) {
      expect(() => channelConnectionEventCodec.decode({ ...history[0], eventType, payload: {} })).toThrow();
    }
    for (const sibling of [
      "connection-health",
      "connection-attention",
      "connector-pairing",
      "tcgplayer-sync-run",
      "ebay-credential-refresh",
    ]) {
      await f.memory.eventStore.appendToStream({
        streamId: `channels.${sibling}-${input.connectionId}`,
        expectedVersion: "no_stream",
        context: testContext,
        events: [{ eventType: "synthetic.sibling-changed", payload: {} }],
      });
    }
    expect(await f.authority.capture(input)).toMatchObject({ kind: "granted", version: 2 });
    expect(fold()).toEqual(before);
    expect(Object.keys(connectionAuthorityEventClassification)).toEqual([
      "channels.connection.connected",
      "channels.connection.activated",
      "channels.connection.paused",
      "channels.connection.resumed",
      "channels.connection.disconnected",
    ]);
  });
  it("denies replayed creation or a lifecycle event after disconnect instead of reopening identity", async () => {
    const f = await fixture();
    await connectFixture(f.services);
    await activateFixture(f.services);
    await f.services.disconnectChannelConnection(target, testContext);
    await f.memory.eventStore.appendToStream({
      streamId: "channels.connection-connection_1",
      expectedVersion: 3,
      context: testContext,
      events: [{ eventType: "channels.connection.resumed", payload: { connectionId: input.connectionId } }],
    });
    expect(await f.authority.capture(input)).toEqual({ kind: "denied", reason: "connection-authority-unavailable" });
    expect(f.captureGrant).not.toHaveBeenCalled();
  });
});
