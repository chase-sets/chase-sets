import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as authModule } from "@chase-sets/auth";
import { createConnectorOAuthService, type ConnectorOAuthService } from "@chase-sets/auth/server";
import { CHANNEL_CONNECTOR_SCOPE_FAMILY } from "@chase-sets/auth-context";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";
import { module as channelsModule } from "../../../index";
import { createConnectorFeedRuntime } from "../api/runtime";
import { testContext } from "../../connections/tests/test-support";
import { createChannelConnectionRuntime } from "../../connections/api/runtime";
import type { ChannelConnectionHostPorts } from "../../connections/domain/contracts";
import { connectorFeedSchemaMigrations, connectorFeedSchemaSql } from "../read-model/schema";

const baseUrl = process.env.TEST_DATABASE_URL;
function databaseUrl() {
  if (!baseUrl) throw new Error("TEST_DATABASE_URL is required for connector pairing DB tests.");
  return baseUrl;
}
const describeDb = baseUrl ? describe : describe.skip;
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
let pools: Readonly<Record<"auth" | "channels" | "inventory", PgTransactionalPool>>;
async function releaseAfterConnectionLockWaiter(release: () => void) {
  try {
    await vi.waitFor(async () => {
      const waiting = await pools.channels.query(`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%event_store_streams%' AND pid <> pg_backend_pid()`);
      expect(waiting.rows.length).toBeGreaterThan(0);
    });
  } finally {
    release();
  }
}
let auth: ReturnType<typeof authModule.createServices>;
let channels: ReturnType<typeof channelsModule.createServices>;
let oauth: ConnectorOAuthService;
let clock: Date;
const seller = { userId: "usr_channels", accountId: "acc_owner", permissions: ["channels.manage", "channels.view"] };
const target = { accountId: seller.accountId, connectionId: "connection_connector" };
const verifier = "connector-secret-sentinel-verifier-" + "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const ports: ChannelConnectionHostPorts = {
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
};
function feed(service = oauth) {
  return createConnectorFeedRuntime({
    db: pools.channels,
    eventStore: createPostgresEventStore({ pool: pools.channels }),
    oauth: service,
    now: () => clock,
  });
}
async function code() {
  return feed().createPairingCode(target, seller);
}
async function client() {
  return oauth.register({
    redirect_uri: "https://connector.example/callback",
    token_endpoint_auth_method: "none",
    scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
  });
}
async function pair() {
  const registration = await client();
  const pairing = await code();
  const authorized = await feed().consumePairingCode(
    {
      pairing_code: pairing.code,
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    },
    seller,
  );
  const tokens = await feed().exchange({
    grant_type: "authorization_code",
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uri,
    code: authorized.code,
    code_verifier: verifier,
  });
  return { registration, pairing, authorized, tokens };
}

describeDb("connector-pairing-lifecycle", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseUrl(),
      ["auth", "channels", "inventory"],
      "connector_authority_7993",
    );
    await ensureMultiContextTestDatabases(databaseUrl(), urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    clock = new Date("2026-09-14T12:00:00.000Z");
    auth = authModule.createServices(pools.auth, {});
    oauth = createConnectorOAuthService(
      () => auth,
      () => clock,
    );
    channels = channelsModule.createServices(pools.channels, {
      ...ports,
      connectorOAuth: oauth,
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, testContext),
    });
    await pools.auth.query(
      `INSERT INTO auth_identity_user_memberships (membership_id, user_id, account_id, role_key, role_permissions, status)
      VALUES ('membership_connector', $1, $2, 'seller', '["channels.manage","channels.view"]', 'active')`,
      [seller.userId, seller.accountId],
    );
    await channels.connections.connectChannel(
      { ...target, providerKey: "fixture-connector" },
      { deploymentEnvironment: "test" },
      testContext,
    );
    await channels.connections.activateChannelConnection(
      { ...target, bindings: [{ storageLocationId: "location_connector", revision: 1 }] },
      testContext,
    );
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("consumes one ten-minute code once with one concurrent winner", async () => {
    const registration = await client();
    const pairing = await code();
    expect(Date.parse(pairing.expiresAt) - clock.getTime()).toBe(600_000);
    const request = {
      pairing_code: pairing.code,
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const results = await Promise.allSettled([
      feed().consumePairingCode(request, seller),
      feed().consumePairingCode(request, seller),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(feed().consumePairingCode(request, seller)).rejects.toMatchObject({ code: "invalid-credential" });
    const count = await pools.channels.query("SELECT * FROM channel_connector_pairings WHERE state = 'paired'");
    expect(count.rows).toHaveLength(1);
    expect((await feed().detail(target)).lastSeenAt).toBeNull();
  });

  it("refuses expired codes without publishing a grant and remains inert the next day", async () => {
    const registration = await client();
    const pairing = await code();
    clock = new Date(clock.getTime() + 600_000);
    await expect(
      feed().consumePairingCode(
        {
          pairing_code: pairing.code,
          client_id: registration.client_id,
          redirect_uri: registration.redirect_uri,
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        seller,
      ),
    ).rejects.toMatchObject({ code: "pairing-expired" });
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants")).rows).toHaveLength(0);
    expect((await feed().detail(target)).state).toBe("expired");
    clock = new Date(clock.getTime() + 86_400_000);
    expect((await feed().readAuthority(target)).inbound).toBe("revoked");
    expect((await feed().detail(target)).state).toBe("unpaired");
  });

  it("rotates PKCE and refresh credentials and refuses wrong verifiers without consuming the code", async () => {
    const registration = await client();
    const pairing = await code();
    const authorized = await feed().consumePairingCode(
      {
        pairing_code: pairing.code,
        client_id: registration.client_id,
        redirect_uri: registration.redirect_uri,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      seller,
    );
    const input = {
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code: authorized.code,
      code_verifier: verifier,
    };
    await expect(feed().exchange({ ...input, code_verifier: "w".repeat(64) })).rejects.toMatchObject({
      code: "invalid-credential",
    });
    const tokens = await feed().exchange(input);
    await expect(feed().exchange(input)).rejects.toMatchObject({ code: "invalid-credential" });
    const refresh = {
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: tokens.refresh_token,
    };
    const results = await Promise.allSettled([feed().exchange(refresh), feed().exchange(refresh)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await oauth.resolveToken(tokens.access_token)).toBeNull();
    await expect(feed().exchange(refresh)).rejects.toMatchObject({ code: "invalid-credential" });
  });

  it.each(["active", "paused"] as const)(
    "connector-authority-operation-matrix: %s retains only ingest after membership loss",
    async (status) => {
      const paired = await pair();
      if (status === "paused") await channels.connections.pauseChannelConnection(target, testContext);
      await pools.auth.query("UPDATE auth_identity_user_memberships SET status = 'revoked' WHERE user_id = $1", [
        seller.userId,
      ]);
      const authority = await feed().readAuthority(target);
      expect(authority).toMatchObject({
        inbound: "live",
        claimReportAllowed: false,
        connectionState: status,
        pairingId: paired.pairing.pairingId,
      });
      for (const operation of ["claim", "report"] as const)
        await expect(
          feed().withAuthority(
            { token: paired.tokens.access_token, connectionId: target.connectionId, operation },
            async () => "bad",
          ),
        ).rejects.toMatchObject({ code: "authorization-refused" });
      expect(
        await feed().withAuthority(
          { token: paired.tokens.access_token, connectionId: target.connectionId, operation: "ingest" },
          async (value) => value.inbound,
        ),
      ).toBe("live");
      await expect(code()).rejects.toMatchObject({ code: "authorization-refused" });
      expect((await feed().detail(target)).lastSeenAt).toBeNull();
    },
  );

  it("revokes before replacement and stale unpair cannot close the newer pairing", async () => {
    const paired = await pair();
    const replacement = await code();
    expect(await oauth.resolveToken(paired.tokens.access_token)).toBeNull();
    await feed().consumePairingCode(
      {
        pairing_code: replacement.code,
        client_id: paired.registration.client_id,
        redirect_uri: paired.registration.redirect_uri,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      seller,
    );
    await expect(feed().unpair(target, paired.pairing.pairingId, 2, seller)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await feed().detail(target)).toMatchObject({
      pairingId: replacement.pairingId,
      state: "paired",
      revision: 2,
    });
  });

  it("failed revocation cannot falsely close or publish a replacement, then recovery revokes before close", async () => {
    const paired = await pair();
    const failed: ConnectorOAuthService = {
      ...oauth,
      revokePairing: async () => {
        throw new Error("connector-secret-sentinel-cleanup");
      },
    };
    await expect(feed(failed).createPairingCode(target, seller)).rejects.toThrow("connector-secret-sentinel-cleanup");
    expect(await feed().detail(target)).toMatchObject({ pairingId: paired.pairing.pairingId, state: "paired" });
    expect((await pools.channels.query("SELECT * FROM channel_connector_pairings")).rows).toHaveLength(1);
    await feed().unpair(target, paired.pairing.pairingId, 2, seller);
    await feed().unpair(target, paired.pairing.pairingId, 2, seller);
    expect(await oauth.resolveToken(paired.tokens.access_token)).toBeNull();
    expect((await feed().readAuthority(target)).inbound).toBe("revoked");
  });

  it("disconnect races regeneration and never leaves live authority, including after boot twice", async () => {
    const paired = await pair();
    await Promise.allSettled([code(), channels.connections.disconnectChannelConnection(target, testContext)]);
    expect(await oauth.resolveToken(paired.tokens.access_token)).toBeNull();
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect((await feed().readAuthority(target)).inbound).not.toBe("live");
    await channels.connections.disconnectChannelConnection(target, testContext);
    await expect(code()).rejects.toMatchObject({ code: "authorization-refused" });
    expect((await channels.connections.disconnectChannelConnection(target, testContext)).newEvents).toHaveLength(0);
  });

  it.each(["consume-first", "disconnect-first"])("consume and disconnect race: %s", async (order) => {
    const registration = await client();
    const pairing = await code();
    const input = {
      pairing_code: pairing.code,
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const entered = signal();
    const release = signal();
    const service: ConnectorOAuthService = {
      ...oauth,
      authorize: async (...args) => {
        entered.resolve();
        await release.promise;
        return oauth.authorize(...args);
      },
      revokePairing: async (binding) => {
        entered.resolve();
        await release.promise;
        await oauth.revokePairing(binding);
      },
    };
    if (order === "consume-first") {
      const consuming = feed(service).consumePairingCode(input, seller);
      await entered.promise;
      const disconnecting = channels.connections.disconnectChannelConnection(target, testContext);
      await releaseAfterConnectionLockWaiter(release.resolve);
      await Promise.all([consuming, disconnecting]);
    } else {
      const disconnecting = feed(service).disconnectChannelConnection(target, testContext);
      await entered.promise;
      const refusal = expect(feed().consumePairingCode(input, seller)).rejects.toMatchObject({
        code: "invalid-credential",
      });
      await releaseAfterConnectionLockWaiter(release.resolve);
      await Promise.all([disconnecting, refusal]);
    }
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants WHERE revoked_at IS NULL")).rows).toHaveLength(
      0,
    );
    expect((await feed().readAuthority(target)).inbound).toBe("revoked");
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect((await feed().readAuthority(target)).connectionState).toBe("disconnected");
    await expect(code()).rejects.toMatchObject({ code: "authorization-refused" });
  });

  it.each(["cleanup-first", "re-pair-first"])("unpair cleanup and re-pair race: %s", async (order) => {
    const paired = await pair();
    const entered = signal();
    const release = signal();
    const service: ConnectorOAuthService = {
      ...oauth,
      revokePairing: async (binding) => {
        entered.resolve();
        await release.promise;
        await oauth.revokePairing(binding);
      },
    };
    if (order === "cleanup-first") {
      const cleanup = feed(service).unpair(target, paired.pairing.pairingId, 2, seller);
      await entered.promise;
      const replacing = code();
      await releaseAfterConnectionLockWaiter(release.resolve);
      await Promise.all([cleanup, replacing]);
    } else {
      const replacing = feed(service).createPairingCode(target, seller);
      await entered.promise;
      const refusal = expect(feed().unpair(target, paired.pairing.pairingId, 2, seller)).rejects.toMatchObject({
        code: "conflict",
      });
      await releaseAfterConnectionLockWaiter(release.resolve);
      await Promise.all([replacing, refusal]);
    }
    expect(await oauth.resolveToken(paired.tokens.access_token)).toBeNull();
    const replacement = await feed().detail(target);
    expect(replacement).toMatchObject({ state: "code", revision: 1 });
    expect(replacement.pairingId).not.toBe(paired.pairing.pairingId);
    expect(
      (await pools.channels.query("SELECT * FROM channel_connector_pairings WHERE state <> 'closed'")).rows,
    ).toHaveLength(1);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await feed().detail(target)).toEqual(replacement);
  });

  it("connector-feed-scope-isolation: foreign and missing targets refuse equally and call no consumer", async () => {
    const paired = await pair();
    await channels.connections.connectChannel(
      { accountId: "acc_foreign", connectionId: "foreign-connection", providerKey: "fixture-connector" },
      { deploymentEnvironment: "test" },
      testContext,
    );
    const work = vi.fn();
    for (const connectionId of ["foreign-connection", "nonexistent-connection"]) {
      await expect(
        feed().withAuthority({ token: paired.tokens.access_token, connectionId, operation: "ingest" }, work),
      ).rejects.toMatchObject({ code: "invalid-credential" });
    }
    expect(work).not.toHaveBeenCalled();
    await expect(feed().readAuthority({ ...target, accountId: "foreign-account" })).rejects.toMatchObject({
      code: "connection-not-found",
    });
    await expect(feed().readAuthority({ ...target, connectionId: "missing" })).rejects.toMatchObject({
      code: "connection-not-found",
    });
  });

  it("grant expiry invalidates authority before closing and last-seen stays null", async () => {
    const paired = await pair();
    clock = new Date(clock.getTime() + 31 * 86_400_000);
    expect((await feed().readAuthority(target)).inbound).toBe("revoked");
    expect((await feed().detail(target)).lastSeenAt).toBeNull();
    expect(await oauth.resolveToken(paired.tokens.access_token)).toBeNull();
    expect((await pools.auth.query("SELECT revoked_at FROM auth_connector_grants")).rows[0]?.revoked_at).not.toBeNull();
  });

  it("connector-feed-bootstrap-and-manifest: migrations and repeated boot produce identical tables and indexes", async () => {
    async function shape() {
      const columns = await pools.channels.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'channel_connector_%' ORDER BY table_name, ordinal_position`);
      const indexes = await pools.channels.query(`SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename LIKE 'channel_connector_%' ORDER BY indexname`);
      return { columns: columns.rows, indexes: indexes.rows };
    }
    const boot = await shape();
    expect(boot.columns.length).toBeGreaterThan(15);
    await resetMultiContextTestSchemas({ channels: pools.channels });
    for (const migration of connectorFeedSchemaMigrations)
      for (const statement of migration.statements) await pools.channels.query(statement);
    expect(await shape()).toEqual(boot);
    await pools.channels.query(connectorFeedSchemaSql);
    await pools.channels.query(connectorFeedSchemaSql);
    expect(await shape()).toEqual(boot);
  });

  it("an admitted consumer completes before concurrent revoke on the real connection stream", async () => {
    const paired = await pair();
    const order: string[] = [];
    let release = () => {};
    let entered = () => {};
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumer = feed().withAuthority(
      { token: paired.tokens.access_token, connectionId: target.connectionId, operation: "ingest" },
      async () => {
        entered();
        await releasePromise;
        order.push("consumer");
      },
    );
    await enteredPromise;
    const revoke = feed()
      .revoke(paired.tokens.access_token)
      .then(() => {
        order.push("revoke");
      });
    release();
    await Promise.all([consumer, revoke]);
    expect(order).toEqual(["consumer", "revoke"]);
    const refused = vi.fn();
    await expect(
      feed().withAuthority(
        { token: paired.tokens.access_token, connectionId: target.connectionId, operation: "ingest" },
        refused,
      ),
    ).rejects.toMatchObject({ code: "invalid-credential" });
    expect(refused).not.toHaveBeenCalled();
  });

  it("concurrent revoke wins before a waiting consumer and the next-day runtime stays closed", async () => {
    const paired = await pair();
    const entered = signal();
    const release = signal();
    const service: ConnectorOAuthService = {
      ...oauth,
      revokePairing: async (binding) => {
        entered.resolve();
        await release.promise;
        await oauth.revokePairing(binding);
      },
    };
    const revocation = feed(service).revoke(paired.tokens.access_token);
    await entered.promise;
    const work = vi.fn();
    const consumer = feed().withAuthority(
      { token: paired.tokens.access_token, connectionId: target.connectionId, operation: "ingest" },
      work,
    );
    const refusal = expect(consumer).rejects.toMatchObject({ code: "invalid-credential" });
    release.resolve();
    await Promise.all([revocation, refusal]);
    expect(work).not.toHaveBeenCalled();
    clock = new Date(clock.getTime() + 86_400_000);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect((await feed().readAuthority(target)).inbound).toBe("revoked");
  });

  it.each(["consume-first", "cleanup-first"])("consume and supersession race: %s", async (order) => {
    const registration = await client();
    const pairing = await code();
    const input = {
      pairing_code: pairing.code,
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const entered = signal();
    const release = signal();
    const service: ConnectorOAuthService = {
      ...oauth,
      authorize: async (...args) => {
        entered.resolve();
        await release.promise;
        return oauth.authorize(...args);
      },
      revokePairing: async (binding) => {
        entered.resolve();
        await release.promise;
        await oauth.revokePairing(binding);
      },
    };
    if (order === "consume-first") {
      const consuming = feed(service).consumePairingCode(input, seller);
      await entered.promise;
      const replacing = code();
      release.resolve();
      await Promise.all([consuming, replacing]);
    } else {
      const replacing = feed(service).createPairingCode(target, seller);
      await entered.promise;
      const refusal = expect(feed().consumePairingCode(input, seller)).rejects.toMatchObject({
        code: "invalid-credential",
      });
      release.resolve();
      await Promise.all([replacing, refusal]);
    }
    const current = await feed().detail(target);
    expect(current).toMatchObject({ state: "code", lastSeenAt: null });
    expect(current.pairingId).not.toBe(pairing.pairingId);
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants WHERE revoked_at IS NULL")).rows).toHaveLength(
      0,
    );
    expect(
      (await pools.channels.query("SELECT * FROM channel_connector_pairings WHERE state <> 'closed'")).rows,
    ).toHaveLength(1);
  });

  it("cleans an Auth-committed grant after Channels rollback before allowing regeneration", async () => {
    const registration = await client();
    const pairing = await code();
    const eventStore = createPostgresEventStore({ pool: pools.channels });
    vi.spyOn(eventStore, "appendToStreamInTransaction").mockRejectedValueOnce(
      new Error("connector-secret-sentinel-rollback"),
    );
    const failed = createConnectorFeedRuntime({ db: pools.channels, eventStore, oauth, now: () => clock });
    const input = {
      pairing_code: pairing.code,
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    await expect(failed.consumePairingCode(input, seller)).rejects.toThrow("connector-secret-sentinel-rollback");
    expect((await feed().readAuthority(target)).inbound).toBe("absent");
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants WHERE revoked_at IS NULL")).rows).toHaveLength(
      1,
    );
    await expect(feed().consumePairingCode(input, seller)).rejects.toMatchObject({ code: "invalid-credential" });
    const replacement = await code();
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants WHERE revoked_at IS NULL")).rows).toHaveLength(
      0,
    );
    await feed().consumePairingCode({ ...input, pairing_code: replacement.code }, seller);
    expect((await feed().readAuthority(target)).inbound).toBe("live");
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants WHERE revoked_at IS NULL")).rows).toHaveLength(
      1,
    );
  });

  it("withheld, pending setup, disconnected, and unpaired states never admit a consumer", async () => {
    expect((await feed().readAuthority(target)).inbound).toBe("absent");
    const pending = { ...target, connectionId: "pending-connector" };
    await channels.connections.connectChannel(
      { ...pending, providerKey: "fixture-connector" },
      { deploymentEnvironment: "test" },
      testContext,
    );
    expect(await feed().readAuthority(pending)).toMatchObject({
      inbound: "absent",
      connectionState: "pending-setup",
      claimReportAllowed: false,
    });
    await expect(feed().createPairingCode(pending, seller)).rejects.toMatchObject({ code: "authorization-refused" });
    const paired = await pair();
    await feed().unpair(target, paired.pairing.pairingId, 2, seller);
    const work = vi.fn();
    for (const connectionId of [target.connectionId, pending.connectionId])
      await expect(
        feed().withAuthority({ token: paired.tokens.access_token, connectionId, operation: "ingest" }, work),
      ).rejects.toMatchObject({ code: "invalid-credential" });
    await channels.connections.disconnectChannelConnection(target, testContext);
    expect(await feed().readAuthority(target)).toMatchObject({
      inbound: "revoked",
      connectionState: "disconnected",
      claimReportAllowed: false,
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("rechecks connection authority even when credential cleanup has not run", async () => {
    const paired = await pair();
    const connection = createChannelConnectionRuntime(
      { db: pools.channels, eventStore: createPostgresEventStore({ pool: pools.channels }) },
      ports,
    );
    await connection.disconnectChannelConnection(target, testContext);
    expect(await oauth.resolveToken(paired.tokens.access_token)).not.toBeNull();
    const work = vi.fn();
    await expect(
      feed().withAuthority(
        { token: paired.tokens.access_token, connectionId: target.connectionId, operation: "ingest" },
        work,
      ),
    ).rejects.toMatchObject({ code: "invalid-credential" });
    expect(work).not.toHaveBeenCalled();
    expect((await feed().readAuthority(target)).inbound).toBe("revoked");
    expect(await oauth.resolveToken(paired.tokens.access_token)).toBeNull();
  });

  it("actual Auth composition validates lifetime overrides before issuing rotating connector tokens", async () => {
    const overrides = {
      ucpAccessTokenTtlMs: 300_000,
      ucpRefreshTokenTtlMs: 86_400_000,
      ucpAuthorizationCodeTtlMs: 30_000,
    };
    for (const value of [undefined, "300000", 0, -1, NaN, Infinity, 86_400_001]) {
      const ports: unknown = { securityLifetimes: { ucpAccessTokenTtlMs: value } };
      // Invalid deployment values are deliberately passed through the real bootstrap boundary.
      expect(() => Reflect.apply(authModule.createServices, authModule, [pools.auth, ports])).toThrow();
    }
    auth = authModule.createServices(pools.auth, { securityLifetimes: overrides });
    const paired = await pair();
    expect(paired.tokens.expires_in).toBe(300);
    const rows = await pools.auth.query<{ code_expires_at: Date; access_expires_at: Date; expires_at: Date }>(
      "SELECT code_expires_at, access_expires_at, expires_at FROM auth_connector_grants",
    );
    const row = rows.rows[0];
    if (!row) throw new Error("Connector grant missing");
    expect(row.code_expires_at.getTime() - clock.getTime()).toBe(30_000);
    expect(row.access_expires_at.getTime() - clock.getTime()).toBe(300_000);
    expect(row.expires_at.getTime() - clock.getTime()).toBe(86_400_000);
    clock = new Date(clock.getTime() + 300_000);
    expect(await oauth.resolveToken(paired.tokens.access_token)).toBeNull();
    const refreshed = await feed().exchange({
      grant_type: "refresh_token",
      client_id: paired.registration.client_id,
      refresh_token: paired.tokens.refresh_token,
    });
    expect(refreshed.expires_in).toBe(300);
    expect(await oauth.resolveToken(refreshed.access_token)).not.toBeNull();
  });

  it("Auth boot and migrations agree for connector tables and the live-grant uniqueness fence", async () => {
    async function shape() {
      const columns = await pools.auth.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'auth_connector_%' ORDER BY table_name, ordinal_position`);
      const indexes = await pools.auth.query(`SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename LIKE 'auth_connector_%' ORDER BY indexname`);
      return { columns: columns.rows, indexes: indexes.rows };
    }
    const boot = await shape();
    expect(boot.indexes.some((index) => index.indexname === "auth_connector_grants_live_connection_idx")).toBe(true);
    await resetMultiContextTestSchemas({ auth: pools.auth });
    const migration = authModule.schemaMigrations?.find(
      (entry) => entry.migrationId === "20260914_auth_connector_oauth",
    );
    if (!migration) throw new Error("Connector Auth migration missing");
    for (const statement of migration.statements) await pools.auth.query(statement);
    expect(await shape()).toEqual(boot);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(authModule, pools.auth);
    expect(await shape()).toEqual(boot);
  });

  it("rejects recursively malformed authorization inputs before grant or pairing writes", async () => {
    const registration = await client();
    const pairing = await code();
    const valid = {
      pairing_code: pairing.code,
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    for (const input of [
      { ...valid, client_id: { value: registration.client_id } },
      { ...valid, redirect_uri: "javascript:sentinel" },
      { ...valid, redirect_uri: "https://user:password@connector.example/callback" },
      { ...valid, code_challenge: "a".repeat(44) },
      { ...valid, code_challenge: "a".repeat(42) + "." },
      { ...valid, code_challenge_method: "plain" },
      { ...valid, unknown: { nested: "sentinel" } },
    ]) {
      await expect(feed().consumePairingCode(input, seller)).rejects.toMatchObject({ code: "invalid-request" });
      expect((await pools.auth.query("SELECT * FROM auth_connector_grants")).rows).toHaveLength(0);
      expect(await feed().detail(target)).toMatchObject({ pairingId: pairing.pairingId, revision: 1, state: "code" });
    }
    await feed().consumePairingCode(valid, seller);
    expect((await feed().readAuthority(target)).inbound).toBe("live");
  });
});
