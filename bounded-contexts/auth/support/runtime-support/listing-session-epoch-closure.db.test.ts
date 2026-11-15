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
  initializeConfigurationConsumer,
  withConfigurationEpochTransaction,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { module as authModule } from "../../index";
import * as epochModule from "../../features/sessions/api/owner-epochs";
import { createAuthSessionEpochs, type AuthSessionEpochs } from "../../features/sessions/api/owner-epochs";
import { createAuthSessionAuthority } from "../../features/sessions/api/session-authority";
import { upsertSessionToken } from "../auth-support/store";
import { upsertSessionToken as seedToken } from "../seed-support/store";
import { createAuthServices, revokeSession } from "./services";
import { seedAuthDatabase } from "./seed";
import { identitySeedIds } from "@chase-sets/identity-seed";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = baseUrl ? describe : describe.skip;
const contextNames = ["auth", "marketplace"] as const;
const consumer = { storeId: "synthetic-session-terminal", incarnation: "synthetic-session-terminal-v1" };
const context: EventStoreContext = {
  tenantId: "tenant_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};
const sessionId = "ses_synthetic_closure";
const streamId = `auth.session-${sessionId}`;
const key = `session/${sessionId}`;
const input = {
  sessionId,
  userId: "usr_synthetic",
  tenantId: context.tenantId,
  tokenHash: "synthetic-token",
  consumer,
};
const expiresAt = "2099-01-01T00:00:00.000Z";
const writers = [
  { name: "revoke", mutant: "REMOVE_REVOKE_ENROLLMENT" },
  { name: "logout", mutant: "REMOVE_LOGOUT_ENROLLMENT" },
  { name: "switch account", mutant: "REMOVE_SWITCH_ENROLLMENT" },
  { name: "explicit expiry", mutant: "REMOVE_EXPIRE_ENROLLMENT" },
  { name: "retained recovery append", mutant: "REMOVE_RECOVERY_ENROLLMENT" },
  { name: "token rotation", mutant: "REMOVE_TOKEN_ENROLLMENT" },
  { name: "seed token", mutant: "REMOVE_SEED_TOKEN_ENROLLMENT" },
] as const;
type Writer = (typeof writers)[number];

function commitTerminal(store: ReturnType<typeof createPostgresEventStore>, input: AppendToStreamInput) {
  return store.appendToStreams!([input]);
}

describeDb("Listing Session acknowledged epoch closure", () => {
  let pools: Record<(typeof contextNames)[number], PgTransactionalPool>;
  let pool: PgTransactionalPool;
  let terminalPool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, contextNames, "auth_listing_session_closure");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.auth;
    terminalPool = pools.marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(authModule, pool);
    // Only the landed event-store schema is needed at the synthetic consumer.
    const { eventCorePostgresSchemaSql } = await import("@chase-sets/event-core-postgres");
    await terminalPool.query(eventCorePostgresSchemaSql);
    await initializeConfigurationConsumer(terminalPool, consumer);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function servicesFor(epochs: AuthSessionEpochs) {
    const substitute = vi.spyOn(epochModule, "createAuthSessionEpochs").mockReturnValue(epochs);
    try {
      return createAuthServices(pool);
    } finally {
      substitute.mockRestore();
    }
  }

  async function fixture(legacyToken = false) {
    const raw = createPostgresEventStore({ pool });
    const services = createAuthServices(pool, { sessionConsumers: [{ identity: consumer, pool: terminalPool }] });
    const epochs = services.sessionEpochs!;
    const sessions = services.sessions;
    await sessions.commandHandler({
      streamId,
      context,
      command: {
        type: "StartSession",
        sessionId: sessionId as never,
        userId: input.userId as never,
        accountId: "acc_synthetic" as never,
        availableAccountIds: ["acc_synthetic", "acc_second"],
        authenticationMethod: "password",
        expiresAt,
      },
    });
    if (legacyToken) {
      // A genuine pre-enrollment SQL row, with no invented Guard History.
      await pool.query("INSERT INTO identity_session_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
        sessionId,
        input.tokenHash,
        expiresAt,
      ]);
      expect(
        (await pool.query("SELECT key FROM event_configuration_guard_history WHERE key = $1", [key])).rows,
      ).toHaveLength(0);
    } else await upsertSessionToken(pool, { sessionId, tokenHash: input.tokenHash, expiresAt }, epochs);
    const authority = services.sessionAuthority!;
    await authority.registerConsumer(input);
    const captured = await authority.capture(input);
    if (captured.kind !== "granted") throw new Error("synthetic capture refused");
    const terminalStore = createPostgresEventStore({ pool: terminalPool });
    const terminal: AppendToStreamInput = {
      streamId: "synthetic.terminal",
      expectedVersion: "no_stream",
      context,
      configurationGrants: [captured.grant],
      events: [{ eventType: "synthetic.committed", payload: {} }],
    };
    async function write(writer: Writer, activeEpochs: AuthSessionEpochs = epochs) {
      const current = servicesFor(activeEpochs);
      if (writer.name === "token rotation" || writer.name === "seed token")
        return (writer.name === "seed token" ? seedToken : upsertSessionToken)(
          pool,
          { sessionId, tokenHash: "synthetic-next-token", expiresAt },
          activeEpochs,
        );
      if (writer.name === "retained recovery append")
        return current.eventStore.appendToStreams!([
          { streamId, expectedVersion: 1, context, events: [{ eventType: "auth.session.revoked", payload: {} }] },
        ]);
      if (writer.name === "logout") {
        return revokeSession(current, { sessionId, context });
      }
      return current.sessions.commandHandler({
        streamId,
        context,
        command:
          writer.name === "switch account"
            ? { type: "SwitchSessionAccount", accountId: "acc_second" as never }
            : { type: writer.name === "explicit expiry" ? "ExpireSession" : "RevokeSession" },
      });
    }
    const row = async () => ({
      history: await raw.readStream({ streamId }),
      tokens: (
        await pool.query("SELECT token_hash, revision::text FROM identity_session_tokens WHERE session_id = $1", [
          sessionId,
        ])
      ).rows,
    });
    return { raw, epochs, authority, captured, terminalStore, terminal, write, row };
  }

  it.each(writers)(
    "$name: close-first refuses stale terminal with zero events; newer grant succeeds",
    async (writer) => {
      const f = await fixture();
      await f.write(writer);
      await expect(commitTerminal(f.terminalStore, f.terminal)).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(0);
      const next = await (await f.epochs.source()).captureGrant(key, consumer, expiresAt);
      expect(next.epoch).toBe(f.captured.grant.epoch + 1);
      await commitTerminal(f.terminalStore, { ...f.terminal, configurationGrants: [next] });
      const recaptured = await f.authority.capture({
        ...input,
        tokenHash:
          writer.name.includes("token") || writer.name === "token rotation" ? "synthetic-next-token" : input.tokenHash,
      });
      expect(recaptured.kind).toBe(
        ["switch account", "token rotation", "seed token"].includes(writer.name) ? "granted" : "denied",
      );
    },
  );

  it.each(writers)("$name: terminal-first installs only after consumer COMMIT", async (writer) => {
    const f = await fixture();
    const before = await f.row();
    const client = await terminalPool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await f.terminalStore.appendToStreamsInTransaction(client, [f.terminal]);
      writing = f.write(writer);
      const source = await f.epochs.source();
      let status = await source.status(key);
      for (let attempt = 0; attempt < 100 && status.status === "OPEN"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await source.status(key);
      }
      expect(status.status).toBe("PENDING");
      expect(await f.row()).toEqual(before);
      await client.query("COMMIT");
      await writing;
      expect((await source.status(key)).epoch).toBe(f.captured.grant.epoch + 1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      if (writing) await writing;
    }
  });

  it.each(writers)("$name: $mutant breaks the stale-terminal refusal oracle", async (writer) => {
    const f = await fixture();
    const omitted: AuthSessionEpochs = {
      ...f.epochs,
      transaction: (_keys, work) => withConfigurationEpochTransaction(pool, work),
    };
    await f.write(writer, omitted);
    const refused = await commitTerminal(f.terminalStore, f.terminal).then(
      () => false,
      () => true,
    );
    expect(refused, writer.mutant).toBe(false);
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(1);
  });

  it.each(writers)(
    "$name: unavailable route retains CLOSING, no business effects, then recovery installs",
    async (writer) => {
      const f = await fixture();
      const before = await f.row();
      await expect(f.write(writer, createAuthSessionEpochs(pool))).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
      expect(await f.row()).toEqual(before);
      expect((await (await f.epochs.source()).status(key)).status).toBe("BLOCKED");
      expect((await f.authority.capture(input)).kind).toBe("denied");
      await f.write(writer);
      await expect(commitTerminal(f.terminalStore, f.terminal)).rejects.toMatchObject({ code: "concurrency_conflict" });
    },
  );

  it("checks expiry at the terminal store clock under lock, without a timer or closing the grant", async () => {
    const f = await fixture();
    const source = await f.epochs.source();
    const before = await source.status(key);
    // Synthetic validity bounds exercise the exact landed terminal, never a local clock or sleep.
    const storeTime = await terminalPool.query<{ before: string; after: string }>(
      "SELECT (clock_timestamp() - interval '1 minute')::text AS before, (clock_timestamp() + interval '1 minute')::text AS after",
    );
    const bounds = storeTime.rows[0];
    const expired = { ...f.captured.grant, validUntil: new Date(bounds.before).toISOString() };
    await expect(
      commitTerminal(f.terminalStore, { ...f.terminal, configurationGrants: [expired] }),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(0);
    await commitTerminal(f.terminalStore, {
      ...f.terminal,
      configurationGrants: [{ ...expired, validUntil: new Date(bounds.after).toISOString() }],
    });
    expect(await source.status(key)).toEqual(before);
  });

  it("captures real revisions without Guard History and ignores projection SQL writers", async () => {
    const f = await fixture(true);
    expect(f.captured).toMatchObject({
      sessionId,
      userId: input.userId,
      sessionRevision: 1,
      tokenRevision: "1",
      seal: { version: 1 },
      expiresAt,
    });
    expect(await f.raw.readStream({ streamId })).toHaveLength(1);
    await pool.query("TRUNCATE identity_sessions, identity_session_lookup");
    expect((await f.authority.capture(input)).kind).toBe("granted");
    expect(f.captured.grant.epoch).toBe(0);
    await f.write(writers[0]);
    await expect(commitTerminal(f.terminalStore, f.terminal)).rejects.toMatchObject({ code: "concurrency_conflict" });
  });

  it("enrolls Sessions in a co-hosted physical store without replacing its canonical identity", async () => {
    const incarnation = "synthetic-cohosted-physical-incarnation";
    await pool.query(
      "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, 'identity', $1)",
      [incarnation],
    );
    const f = await fixture();
    expect(f.captured.grant.sourceIncarnation).toBe(incarnation);
    await f.write(writers[0]);
    await expect(commitTerminal(f.terminalStore, f.terminal)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(
      (await pool.query("SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true"))
        .rows,
    ).toEqual([{ store_id: "identity", incarnation }]);
  });

  it("creation cannot grant before canonical commit and no-consumer token writes install immediately", async () => {
    const raw = createPostgresEventStore({ pool });
    const epochs = createAuthSessionEpochs(pool);
    const authority = createAuthSessionAuthority(pool, raw, epochs);
    expect((await authority.capture(input)).kind).toBe("denied");
    const f = await fixture();
    const nextSessionId = "ses_synthetic_no_consumer";
    await f.raw.appendToStream({
      streamId: `auth.session-${nextSessionId}`,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "auth.session.started",
          payload: {
            sessionId: nextSessionId,
            userId: input.userId,
            accountId: "acc_synthetic",
            availableAccountIds: ["acc_synthetic"],
            authenticationMethod: "password",
            expiresAt,
          },
        },
      ],
    });
    await upsertSessionToken(pool, { sessionId: nextSessionId, tokenHash: "synthetic-no-consumer", expiresAt });
    expect(await (await epochs.source()).status(`session/${nextSessionId}`)).toMatchObject({
      status: "OPEN",
      pendingConsumers: [],
    });
  });

  it.each([
    ["unauthenticated", { tokenHash: "" }],
    ["foreign user", { userId: "usr_foreign" }],
    ["foreign tenant", { tenantId: "tenant_foreign" }],
    ["foreign token", { tokenHash: "wrong" }],
    ["synthetic handle", { sessionId: "guest:synthetic" }],
    ["absent session", { sessionId: "ses_absent" }],
  ])("capture refuses %s", async (_name, change) => {
    const f = await fixture();
    expect((await f.authority.capture({ ...input, ...change })).kind).toBe("denied");
  });

  it("capture refuses expired token by store clock", async () => {
    const f = await fixture();
    await upsertSessionToken(
      pool,
      { sessionId, tokenHash: input.tokenHash, expiresAt: "2000-01-01T00:00:00.000Z" },
      f.epochs,
    );
    expect((await f.authority.capture(input)).kind).toBe("denied");
  });

  it("retention deletion cannot authorize an expired grant or a missing token", async () => {
    const f = await fixture();
    const source = await f.epochs.source();
    await upsertSessionToken(
      pool,
      { sessionId, tokenHash: input.tokenHash, expiresAt: "2000-01-01T00:00:00.000Z" },
      f.epochs,
    );
    const expired = await source.captureGrant(key, consumer, "2000-01-01T00:00:00.000Z");
    const before = await source.status(key);
    await pool.query(
      "DELETE FROM identity_session_tokens AS candidate WHERE candidate.expires_at < now() - interval '7 days'",
    );
    await expect(
      commitTerminal(f.terminalStore, { ...f.terminal, configurationGrants: [expired] }),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect((await f.authority.capture(input)).kind).toBe("denied");
    expect(await source.status(key)).toEqual(before);
  });

  const seedWriters = [
    { name: "account reconciliation", mutant: "REMOVE_SEED_SWITCH_ENROLLMENT" },
    { name: "expiry reconciliation", mutant: "REMOVE_SEED_EXPIRY_ENROLLMENT" },
  ] as const;
  async function seedFixture(writer: (typeof seedWriters)[number]) {
    const target = writer.name === "account reconciliation" ? identitySeedIds.support : identitySeedIds.collector;
    const targetKey = `session/${target.sessionId}`;
    const targetStream = `auth.session-${target.sessionId}`;
    const seedContext: EventStoreContext = { ...context, tenantId: "tenant_seed_auth" as never };
    const epochs = createAuthSessionEpochs(pool, [{ identity: consumer, pool: terminalPool }]);
    const services = servicesFor(epochs);
    await services.sessions.commandHandler({
      streamId: targetStream,
      context: seedContext,
      command: {
        type: "StartSession",
        sessionId: target.sessionId,
        userId: target.userId,
        accountId: target.accountId,
        availableAccountIds: [target.accountId, identitySeedIds.demo.accountId],
        authenticationMethod: "password",
        expiresAt: writer.name === "expiry reconciliation" ? "2000-01-01T00:00:00.000Z" : expiresAt,
      },
    });
    const source = await epochs.source();
    await source.registerConsumer(targetKey, consumer);
    // Closure-only synthetic grant: seed expiry is already invalid for authentication.
    const grant = await source.captureGrant(targetKey, consumer);
    const terminalStore = createPostgresEventStore({ pool: terminalPool });
    const terminal: AppendToStreamInput = {
      streamId: "synthetic.seed-terminal",
      context,
      expectedVersion: "no_stream",
      configurationGrants: [grant],
      events: [{ eventType: "synthetic.committed", payload: {} }],
    };
    async function write(activeEpochs: AuthSessionEpochs = epochs) {
      const substitute = vi.spyOn(epochModule, "createAuthSessionEpochs").mockReturnValue(activeEpochs);
      try {
        await seedAuthDatabase(pool);
      } finally {
        substitute.mockRestore();
      }
    }
    return { epochs, source, targetKey, targetStream, services, terminalStore, terminal, write };
  }
  it.each(seedWriters)("seed $name: close-first and newer epoch; $mutant defeats refusal", async (writer) => {
    const f = await seedFixture(writer);
    await f.write();
    await expect(commitTerminal(f.terminalStore, f.terminal)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(0);
    await commitTerminal(f.terminalStore, {
      ...f.terminal,
      configurationGrants: [await f.source.captureGrant(f.targetKey, consumer)],
    });
  });
  it.each(seedWriters)("seed $name: $mutant makes stale terminal commit", async (writer) => {
    const f = await seedFixture(writer);
    await f.write({ ...f.epochs, transaction: (_keys, work) => withConfigurationEpochTransaction(pool, work) });
    await commitTerminal(f.terminalStore, f.terminal);
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId }), writer.mutant).toHaveLength(1);
  });
  it.each(seedWriters)("seed $name: terminal-first installs only after COMMIT", async (writer) => {
    const f = await seedFixture(writer);
    const client = await terminalPool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await f.terminalStore.appendToStreamsInTransaction(client, [f.terminal]);
      writing = f.write();
      let status = await f.source.status(f.targetKey);
      for (let attempt = 0; attempt < 100 && status.status === "OPEN"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await f.source.status(f.targetKey);
      }
      expect(status.status).toBe("PENDING");
      expect(await f.services.eventStore.readStream({ streamId: f.targetStream })).toHaveLength(1);
      await client.query("COMMIT");
      await writing;
      expect(await f.services.eventStore.readStream({ streamId: f.targetStream })).toHaveLength(2);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      if (writing) await writing;
    }
  });
});
