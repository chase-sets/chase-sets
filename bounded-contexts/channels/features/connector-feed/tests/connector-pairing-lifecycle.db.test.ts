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
import { CHANNEL_CONNECTOR_SCOPE_FAMILY, type ResolvedActor } from "@chase-sets/auth-context";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";
import { module as channelsModule } from "../../../index";
import { createConnectorFeedRuntime } from "../api/runtime";
import { createConnectorCredentialRoutes } from "../api/routes";
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
  const authorized = await feed().authorizePairing(
    {
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

function authorizeHttp(registration: Awaited<ReturnType<typeof client>>, service = oauth, actor = seller) {
  const resolved: ResolvedActor = {
    ...actor,
    sessionId: "ses_connector",
    tenantId: "tnt_channels",
    membershipId: "membership_connector",
    roleKey: "seller",
  };
  const runtime = feed({ ...service, resolveSeller: async () => resolved });
  return createConnectorCredentialRoutes(runtime, pools.channels).request(
    `http://localhost/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "binding-state-sentinel",
    })}`,
  );
}
async function refuseHttp(
  registration: Awaited<ReturnType<typeof client>>,
  reason: string,
  description = "pairing_code_missing",
  actor = seller,
  identity: { connection_id: string | null; pairing_id: string | null } = { connection_id: null, pairing_id: null },
) {
  const before = await pools.channels.query("SELECT * FROM channel_connector_pairings ORDER BY created_sequence");
  const grants = await pools.auth.query("SELECT * FROM auth_connector_grants ORDER BY grant_id");
  const audit = await pools.channels.query<{ request_id: string }>("SELECT request_id FROM channel_connector_audit");
  const response = await authorizeHttp(registration, oauth, actor);
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Object.fromEntries(new URL(response.headers.get("location")!).searchParams)).toEqual({
    error: "access_denied",
    state: "binding-state-sentinel",
    error_description: description,
  });
  const rows = await pools.channels.query("SELECT * FROM channel_connector_audit");
  const added = rows.rows.filter((row) => !audit.rows.some((old) => old.request_id === row.request_id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ route: "authorize", outcome: "refused", reason, ...identity });
  expect(
    (await pools.channels.query("SELECT * FROM channel_connector_pairings ORDER BY created_sequence")).rows,
  ).toEqual(before.rows);
  expect((await pools.auth.query("SELECT * FROM auth_connector_grants ORDER BY grant_id")).rows).toEqual(grants.rows);
}
async function secondConnection(connectionId: string, accountId = seller.accountId) {
  const second = { accountId, connectionId };
  await channels.connections.connectChannel(
    { ...second, providerKey: "fixture-connector" },
    { deploymentEnvironment: "test" },
    testContext,
  );
  await channels.connections.activateChannelConnection(
    { ...second, bindings: [{ storageLocationId: "location_connector", revision: 1 }] },
    testContext,
  );
  return second;
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
      { connectorRedirectUris: ["https://connector.example/callback"] },
      () => clock,
    );
    channels = channelsModule.createServices(pools.channels, {
      ...ports,
      connectorOAuth: oauth,
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, testContext),
    });
    await pools.auth.query(
      `INSERT INTO auth_identity_accounts (account_id, name, display_name, account_type, status, updated_at)
       VALUES ($1, '', $2, 'personal', 'active', now())
       ON CONFLICT (account_id) DO NOTHING`,
      [seller.accountId, "Connector test seller"],
    );
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

  it("connector-live-code-binding: missing, expired and consumed codes refuse without writes and audit once", async () => {
    const registration = await client();
    await refuseHttp(registration, "invalid-credential");
    const generated = await code();
    clock = new Date(clock.getTime() + 600_000);
    await refuseHttp(registration, "pairing-expired", "pairing_code_missing", seller, {
      connection_id: target.connectionId,
      pairing_id: generated.pairingId,
    });
    await code();
    const accepted = await authorizeHttp(registration);
    expect(accepted.status).toBe(302);
    expect(new URL(accepted.headers.get("location")!).searchParams.has("code")).toBe(true);
    await refuseHttp(registration, "invalid-credential");
  });

  it("connector-live-code-binding: two own live codes are ambiguous; expired siblings are not candidates", async () => {
    const registration = await client();
    const second = await secondConnection("second-connector");
    await feed().createPairingCode(second, seller);
    clock = new Date(clock.getTime() + 1);
    const current = await code();
    await refuseHttp(registration, "conflict", "pairing_code_ambiguous");
    clock = new Date(clock.getTime() + 599_999);
    const accepted = await authorizeHttp(registration);
    expect(new URL(accepted.headers.get("location")!).searchParams.has("code")).toBe(true);
    const grants = await pools.auth.query("SELECT connection_id, pairing_id, user_id FROM auth_connector_grants");
    expect(grants.rows).toEqual([
      { connection_id: target.connectionId, pairing_id: current.pairingId, user_id: seller.userId },
    ]);
  });

  it("connector-live-code-binding: another member's code never grants the requesting user", async () => {
    const registration = await client();
    const other = { ...seller, userId: "usr_other" };
    await pools.auth.query(
      `INSERT INTO auth_identity_user_memberships
      (membership_id, user_id, account_id, role_key, role_permissions, status)
      VALUES ('other_member', $1, $2, 'seller', '["channels.manage"]', 'active')`,
      [other.userId, other.accountId],
    );
    await feed().createPairingCode(target, other);
    await refuseHttp(registration, "invalid-credential");
    const accepted = await authorizeHttp(registration, oauth, other);
    expect(new URL(accepted.headers.get("location")!).searchParams.has("code")).toBe(true);
    expect((await pools.auth.query("SELECT user_id FROM auth_connector_grants")).rows).toEqual([
      { user_id: other.userId },
    ]);
  });

  it("connector-live-code-binding: another account's code is not a candidate even for the same user", async () => {
    const registration = await client();
    const other = { ...seller, accountId: "acc_other" };
    await pools.auth.query(
      `INSERT INTO auth_identity_accounts (account_id, name, display_name, account_type, status, updated_at)
      VALUES ($1, '', 'Other', 'personal', 'active', now())`,
      [other.accountId],
    );
    await pools.auth.query(
      `INSERT INTO auth_identity_user_memberships
      (membership_id, user_id, account_id, role_key, role_permissions, status)
      VALUES ('other_account_member', $1, $2, 'seller', '["channels.manage"]', 'active')`,
      [other.userId, other.accountId],
    );
    await feed().createPairingCode(await secondConnection("other-account-connector", other.accountId), other);
    await refuseHttp(registration, "invalid-credential");
  });

  it("connector-live-code-binding: permission and current membership are independent gates", async () => {
    const registration = await client();
    await code();
    const input = {
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const denied = { ...seller, permissions: [] };
    await refuseHttp(registration, "authorization-refused", "authorization_refused", denied);
    await expect(feed().authorizePairing(input, denied)).rejects.toMatchObject({ code: "authorization-refused" });
    await pools.auth.query("UPDATE auth_identity_user_memberships SET status = 'revoked' WHERE user_id = $1", [
      seller.userId,
    ]);
    await refuseHttp(registration, "authorization-refused", "authorization_refused");
    await expect(feed().authorizePairing(input, seller)).rejects.toMatchObject({ code: "authorization-refused" });
  });

  it("connector-live-code-binding: concurrent HTTP authorization has one grant and one conflict audit", async () => {
    const registration = await client();
    const generated = await code();
    const entered = signal();
    const release = signal();
    const first = authorizeHttp(registration, {
      ...oauth,
      authorize: async (...args) => {
        entered.resolve();
        await release.promise;
        return oauth.authorize(...args);
      },
    });
    await entered.promise;
    const second = authorizeHttp(registration);
    await releaseAfterConnectionLockWaiter(release.resolve);
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    expect(Object.fromEntries(new URL(responses[1]!.headers.get("location")!).searchParams)).toEqual({
      error: "access_denied",
      state: "binding-state-sentinel",
      error_description: "pairing_code_missing",
    });
    const rows = await pools.channels.query(
      "SELECT outcome, reason, connection_id, pairing_id FROM channel_connector_audit ORDER BY occurred_at",
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        {
          outcome: "accepted",
          reason: "accepted",
          connection_id: target.connectionId,
          pairing_id: generated.pairingId,
        },
        { outcome: "refused", reason: "conflict", connection_id: null, pairing_id: null },
      ]),
    );
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants")).rows).toHaveLength(1);
  });

  it("connector-live-code-binding: consume CAS refuses a changed read revision before publishing", async () => {
    const registration = await client();
    const generated = await code();
    const db: PgTransactionalPool = {
      query: pools.channels.query.bind(pools.channels),
      async connect() {
        const connection = await pools.channels.connect();
        return {
          release: connection.release.bind(connection),
          async query<Row>(text: string, values?: readonly unknown[]) {
            if (text.includes("UPDATE channel_connector_pairings SET state = 'paired'")) {
              await connection.query(
                "UPDATE channel_connector_pairings SET revision = revision + 1 WHERE pairing_id = $1",
                [generated.pairingId],
              );
            }
            return connection.query<Row>(text, values);
          },
        };
      },
    };
    const runtime = createConnectorFeedRuntime({
      db,
      eventStore: createPostgresEventStore({ pool: db }),
      oauth,
      now: () => clock,
    });
    await expect(
      runtime.authorizePairing(
        {
          client_id: registration.client_id,
          redirect_uri: registration.redirect_uri,
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        seller,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await pools.channels.query("SELECT state, revision FROM channel_connector_pairings WHERE pairing_id = $1", [
          generated.pairingId,
        ])
      ).rows,
    ).toEqual([{ state: "code", revision: 1 }]);
    expect(
      (
        await pools.channels.query("SELECT event_type FROM event_store_events WHERE stream_id = $1", [
          `channels.connector-pairing-${generated.pairingId}`,
        ])
      ).rows,
    ).toEqual([{ event_type: "channels.connector-pairing.code-created" }]);
  });

  it("connector-live-code-binding: paused connection binds both exact token responses and supersession revokes", async () => {
    const second = await secondConnection("token-identity-connector");
    await channels.connections.pauseChannelConnection(second, testContext);
    const registration = await client();
    const generated = await feed().createPairingCode(second, seller);
    const response = await authorizeHttp(registration);
    const authorizationCode = new URL(response.headers.get("location")!).searchParams.get("code");
    const tokens = await feed().exchange({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code: authorizationCode,
      code_verifier: verifier,
    });
    const refreshed = await feed().exchange({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: tokens.refresh_token,
    });
    for (const result of [tokens, refreshed]) {
      expect(Object.keys(result).sort()).toEqual([
        "access_token",
        "connection_id",
        "expires_in",
        "refresh_token",
        "scope",
        "token_type",
      ]);
      expect(result.connection_id).toBe(second.connectionId);
    }
    const safe = JSON.stringify({
      audits: (await pools.channels.query("SELECT * FROM channel_connector_audit")).rows,
      events: (await pools.channels.query("SELECT payload, metadata FROM event_store_events")).rows,
      authEvents: (await pools.auth.query("SELECT payload, metadata FROM event_store_events")).rows,
    });
    for (const secret of [
      generated.code,
      authorizationCode!,
      verifier,
      tokens.access_token,
      tokens.refresh_token,
      refreshed.access_token,
      refreshed.refresh_token,
      "binding-state-sentinel",
    ])
      expect(safe).not.toContain(secret);
    await feed().createPairingCode(second, seller);
    expect(await oauth.resolveToken(refreshed.access_token)).toBeNull();
    await expect(
      feed().exchange({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: refreshed.refresh_token,
      }),
    ).rejects.toMatchObject({ code: "invalid-credential" });
  });

  it("connector-live-code-binding: disconnected and closed pairings never become candidates", async () => {
    const registration = await client();
    const generated = await code();
    await feed().unpair(target, generated.pairingId, generated.revision, seller);
    await refuseHttp(registration, "invalid-credential");
    await code();
    await channels.connections.disconnectChannelConnection(target, testContext);
    await refuseHttp(registration, "invalid-credential");
  });

  it("consumes one ten-minute code once with one concurrent winner", async () => {
    const registration = await client();
    const pairing = await code();
    expect(Date.parse(pairing.expiresAt) - clock.getTime()).toBe(600_000);
    const request = {
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const results = await Promise.allSettled([
      feed().authorizePairing(request, seller),
      feed().authorizePairing(request, seller),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(feed().authorizePairing(request, seller)).rejects.toMatchObject({ code: "invalid-credential" });
    const count = await pools.channels.query("SELECT * FROM channel_connector_pairings WHERE state = 'paired'");
    expect(count.rows).toHaveLength(1);
    expect((await feed().detail(target)).lastSeenAt).toBeNull();
  });

  it("refuses expired codes without publishing a grant and remains inert the next day", async () => {
    const registration = await client();
    await code();
    clock = new Date(clock.getTime() + 600_000);
    await expect(
      feed().authorizePairing(
        {
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
    await code();
    const authorized = await feed().authorizePairing(
      {
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
    await feed().authorizePairing(
      {
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
    await code();
    const input = {
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
      const consuming = feed(service).authorizePairing(input, seller);
      await entered.promise;
      const disconnecting = channels.connections.disconnectChannelConnection(target, testContext);
      await releaseAfterConnectionLockWaiter(release.resolve);
      await Promise.all([consuming, disconnecting]);
    } else {
      const disconnecting = feed(service).disconnectChannelConnection(target, testContext);
      await entered.promise;
      const refusal = expect(feed().authorizePairing(input, seller)).rejects.toMatchObject({
        code: "conflict",
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
      const consuming = feed(service).authorizePairing(input, seller);
      await entered.promise;
      const replacing = code();
      release.resolve();
      await Promise.all([consuming, replacing]);
    } else {
      const replacing = feed(service).createPairingCode(target, seller);
      await entered.promise;
      const refusal = expect(feed().authorizePairing(input, seller)).rejects.toMatchObject({
        code: "conflict",
      });
      await releaseAfterConnectionLockWaiter(release.resolve);
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
    await code();
    const eventStore = createPostgresEventStore({ pool: pools.channels });
    vi.spyOn(eventStore, "appendToStreamInTransaction").mockRejectedValueOnce(
      new Error("connector-secret-sentinel-rollback"),
    );
    const failed = createConnectorFeedRuntime({ db: pools.channels, eventStore, oauth, now: () => clock });
    const input = {
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    await expect(failed.authorizePairing(input, seller)).rejects.toThrow("connector-secret-sentinel-rollback");
    expect((await feed().readAuthority(target)).inbound).toBe("absent");
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants WHERE revoked_at IS NULL")).rows).toHaveLength(
      1,
    );
    await expect(feed().authorizePairing(input, seller)).rejects.toMatchObject({ code: "invalid-credential" });
    await code();
    expect((await pools.auth.query("SELECT * FROM auth_connector_grants WHERE revoked_at IS NULL")).rows).toHaveLength(
      0,
    );
    await feed().authorizePairing(input, seller);
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
      await expect(feed().authorizePairing(input, seller)).rejects.toMatchObject({ code: "invalid-request" });
      expect((await pools.auth.query("SELECT * FROM auth_connector_grants")).rows).toHaveLength(0);
      expect(await feed().detail(target)).toMatchObject({ pairingId: pairing.pairingId, revision: 1, state: "code" });
    }
    await feed().authorizePairing(valid, seller);
    expect((await feed().readAuthority(target)).inbound).toBe("live");
  });
});
