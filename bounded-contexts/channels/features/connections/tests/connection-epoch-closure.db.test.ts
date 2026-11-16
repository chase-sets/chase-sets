import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  initializeConfigurationConsumer,
  withConfigurationEpochTransaction,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import * as epochModule from "../api/owner-epochs";
import { createConnectionEpochs, createConnectionPersistence, type ConnectionEpochs } from "../api/owner-epochs";
import { createVersionedConnectionAuthority } from "../api/versioned-connection-authority";
import { createChannelConnectionRuntime } from "../api/runtime";
import { activateFixture, connectFixture, createConnectionHarness, testContext } from "./test-support";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels closure DB tests in CI.");
const describeDb = baseUrl ? describe : describe.skip;
const names = ["channels", "marketplace"] as const;
const consumer = { storeId: "synthetic-connection-terminal", incarnation: "synthetic-connection-terminal-v1" };
const target = { accountId: "acc_owner", connectionId: "connection_1" };
const input = { ...target, consumer };
const streamId = `channels.connection-${input.connectionId}`;
const key = `connection/${input.connectionId}`;
const writers = [
  { name: "handler disconnect", mutant: "REMOVE_HANDLER_DISCONNECT_ENROLLMENT" },
  { name: "installed Connector Feed disconnect", mutant: "REMOVE_INSTALLED_DISCONNECT_ENROLLMENT" },
  { name: "pause", mutant: "REMOVE_PAUSE_ENROLLMENT" },
  { name: "resume", mutant: "REMOVE_RESUME_ENROLLMENT" },
  { name: "activation", mutant: "REMOVE_ACTIVATION_ENROLLMENT" },
  { name: "retained mutation replay", mutant: "REMOVE_REPLAY_ENROLLMENT" },
] as const;
type Writer = (typeof writers)[number];

describeDb("Connection acknowledged epoch closure", () => {
  let pools: Record<(typeof names)[number], PgTransactionalPool>;
  let pool: PgTransactionalPool;
  let terminalPool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, names, "channels_connection_closure");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.channels;
    terminalPool = pools.marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pool);
    await terminalPool.query(eventCorePostgresSchemaSql);
    await initializeConfigurationConsumer(terminalPool, consumer);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function fixture(writer: Writer) {
    const raw = createPostgresEventStore({ pool });
    const epochs = createConnectionEpochs(pool, [{ identity: consumer, pool: terminalPool }]);
    const ports = createConnectionHarness().ports;
    const servicesFor = (active: ConnectionEpochs) =>
      createChannelConnectionRuntime({ eventStore: createConnectionPersistence(raw, active), db: pool }, ports);
    const services = servicesFor(epochs);
    await connectFixture(services);
    if (writer.name !== "activation") await activateFixture(services);
    if (writer.name === "resume") await services.pauseChannelConnection(target, testContext);
    const authority = createVersionedConnectionAuthority(pool, raw, epochs);
    await authority.registerConsumer(input);
    const source = await epochs.source();
    const grant = await source.captureGrant(key, consumer);
    const terminalStore = createPostgresEventStore({ pool: terminalPool });
    const terminal: AppendToStreamInput = {
      streamId: "synthetic.connection-terminal",
      expectedVersion: "no_stream",
      context: testContext,
      configurationGrants: [grant],
      events: [{ eventType: "synthetic.connection-committed", payload: {} }],
    };
    async function write(active: ConnectionEpochs = epochs) {
      const current = servicesFor(active);
      if (writer.name === "installed Connector Feed disconnect") {
        // Exercise the actual production composition, not only a hand-wired fallback.
        const substitute = vi.spyOn(epochModule, "createConnectionEpochs").mockReturnValue(active);
        try {
          const installed = channelsModule.createServices(pool, {
            channelSaleRecorder: async () => {
              throw new Error("unused fixture port");
            },
          });
          return await installed.connections.disconnectChannelConnection(target, testContext);
        } finally {
          substitute.mockRestore();
        }
      }
      if (writer.name === "handler disconnect") return current.disconnectChannelConnection(target, testContext);
      if (writer.name === "pause") return current.pauseChannelConnection(target, testContext);
      if (writer.name === "resume") return current.resumeChannelConnection(target, testContext);
      if (writer.name === "activation") return activateFixture(current);
      const version = (await raw.readStream({ streamId })).at(-1)!.streamVersion;
      return createConnectionPersistence(raw, active).appendToStreams!([
        {
          streamId,
          expectedVersion: version,
          context: testContext,
          events: [{ eventType: "channels.connection.paused", payload: { connectionId: input.connectionId } }],
        },
      ]);
    }
    return { raw, epochs, authority, source, grant, terminalStore, terminal, write };
  }

  it.each(writers)(
    "$name: close-first refuses stale terminal with zero events; newer grant succeeds",
    async (writer) => {
      const f = await fixture(writer);
      await f.write();
      await expect(f.terminalStore.appendToStreams!([f.terminal])).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
      expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(0);
      const next = await f.source.captureGrant(key, consumer);
      expect(next.epoch).toBe(f.grant.epoch + 1);
      await f.terminalStore.appendToStreams!([{ ...f.terminal, configurationGrants: [next] }]);
      expect((await f.authority.capture(input)).kind).toBe(
        ["activation", "resume"].includes(writer.name) ? "granted" : "denied",
      );
    },
  );

  it.each(writers)("$name: terminal-first installs only after consumer COMMIT", async (writer) => {
    const f = await fixture(writer);
    const before = await f.raw.readStream({ streamId });
    const client = await terminalPool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await f.terminalStore.appendToStreamsInTransaction(client, [f.terminal]);
      writing = f.write();
      let status = await f.source.status(key);
      for (let attempt = 0; attempt < 100 && status.status === "OPEN"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await f.source.status(key);
      }
      expect(status.status).toBe("PENDING");
      expect(await f.raw.readStream({ streamId })).toEqual(before);
      await client.query("COMMIT");
      await writing;
      expect((await f.source.status(key)).epoch).toBe(f.grant.epoch + 1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      if (writing) await writing;
    }
  });

  it.each(writers)("$name: $mutant breaks the stale-terminal refusal oracle", async (writer) => {
    const f = await fixture(writer);
    const omitted: ConnectionEpochs = {
      ...f.epochs,
      transaction: (_keys, work) => withConfigurationEpochTransaction(pool, work),
    };
    await f.write(omitted);
    const refused = await f.terminalStore.appendToStreams!([f.terminal]).then(
      () => false,
      () => true,
    );
    expect(refused, writer.mutant).toBe(false);
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(1);
  });

  it.each(writers)(
    "$name: unavailable consumer retains CLOSING with zero business effects; recovery installs",
    async (writer) => {
      const f = await fixture(writer);
      const before = await f.raw.readStream({ streamId });
      await expect(f.write(createConnectionEpochs(pool))).rejects.toMatchObject({ code: "connection-change-pending" });
      expect(await f.raw.readStream({ streamId })).toEqual(before);
      expect((await f.source.status(key)).status).toBe("BLOCKED");
      expect((await f.authority.capture(input)).kind).toBe("denied");
      await f.write();
      await expect(f.terminalStore.appendToStreams!([f.terminal])).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
    },
  );

  it("creation without Guard History starts OPEN at creation epoch zero and captures only after COMMIT", async () => {
    const raw = createPostgresEventStore({ pool });
    const epochs = createConnectionEpochs(pool);
    const authority = createVersionedConnectionAuthority(pool, raw, epochs);
    expect(await authority.capture(input)).toEqual({ kind: "denied", reason: "connection-not-found" });
    const current = createChannelConnectionRuntime({ eventStore: raw, db: pool }, createConnectionHarness().ports);
    await connectFixture(current);
    await activateFixture(current);
    expect(
      (await pool.query("SELECT key FROM event_configuration_guard_history WHERE key = $1", [key])).rows,
    ).toHaveLength(0);
    await authority.registerConsumer(input);
    expect(await authority.capture(input)).toMatchObject({
      kind: "granted",
      version: 2,
      grant: { epoch: 0, keyCreationEpoch: 0 },
    });
  });
});
