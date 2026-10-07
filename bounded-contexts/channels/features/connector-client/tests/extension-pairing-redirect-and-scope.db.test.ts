import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as authModule } from "@chase-sets/auth";
import { createConnectorOAuthService } from "@chase-sets/auth/server";
import { CHANNEL_CONNECTOR_SCOPE_FAMILY, type ResolvedActor } from "@chase-sets/auth-context";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { createChannelConnectionRuntime } from "../../connections/api/runtime";
import { testContext } from "../../connections/tests/test-support";
import { createConnectorFeedRuntime } from "../../connector-feed/api/runtime";
import { createConnectorCredentialRoutes } from "../../connector-feed/api/routes";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "../domain/identity";
import { pairingSessionKey } from "../domain/connector-pairing";
import { backgroundFixture } from "./connector-background-test-support";
import { extensionCredentialKey, now } from "./extension-test-support";

const baseUrl = process.env.TEST_DATABASE_URL;
const describeDb = baseUrl ? describe : describe.skip;
const seller: ResolvedActor = {
  userId: "usr_channels",
  accountId: "acc_owner",
  sessionId: "ses_extension",
  tenantId: "tnt_channels",
  membershipId: "membership_extension",
  roleKey: "seller",
  permissions: ["channels.manage", "channels.view"],
};
let pools: Readonly<Record<"auth" | "channels", PgTransactionalPool>>;
let oauth: ReturnType<typeof createConnectorOAuthService>;
let feed: ReturnType<typeof createConnectorFeedRuntime>;
let routes: ReturnType<typeof createConnectorCredentialRoutes>;
let clientId: string;
let actor: ResolvedActor | null;
let serverNow: number;

async function fixture(pair = true) {
  if (pair) await feed.createPairingCode({ accountId: seller.accountId, connectionId: "connection_A" }, seller);
  const f = backgroundFixture("unpaired", {
    clientId,
    request: vi.fn(async (request) => {
      const url = new URL(request.url);
      return routes.request(
        new Request(`http://localhost${url.pathname.replace("/channel-connector/oauth", "")}`, request),
      );
    }),
    coordinate: vi.fn(async ({ connectionId, accessToken }) => {
      await feed.withAuthority({ token: accessToken, connectionId, operation: "ingest" }, async () => ({}));
      return { outcome: "ok" as const };
    }),
  });
  vi.mocked(f.ports.identity.launchWebAuthFlow).mockImplementation(async ({ url, interactive }) => {
    expect(interactive).toBe(true);
    const authorize = new URL(url);
    expect(authorize.pathname).toBe("/channel-connector/oauth/authorize");
    expect([...authorize.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "response_type",
      "state",
    ]);
    expect(authorize.searchParams.get("redirect_uri")).toBe(TCGPLAYER_CONNECTOR_REDIRECT_URI);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const result = await routes.request(`http://localhost/authorize${authorize.search}`);
    expect(result.status).toBe(302);
    return result.headers.get("location")!;
  });
  return f;
}
async function refused(f: Awaited<ReturnType<typeof fixture>>) {
  await f.command("start-pairing");
  expect((await f.background.status()).state).toBe("unpaired");
  expect(f.fake.rows()[extensionCredentialKey]).toBeUndefined();
  expect(f.session.rows()[pairingSessionKey]).toBeUndefined();
  expect(f.alarms.has("connector-work")).toBe(false);
}

describeDb("extension-pairing-redirect-and-scope", () => {
  beforeAll(async () => {
    if (!baseUrl) throw new Error("TEST_DATABASE_URL is required");
    const urls = createMultiContextTestDatabaseUrls(baseUrl, ["auth", "channels"], "extension_lifecycle_7920");
    await ensureMultiContextTestDatabases(baseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    serverNow = Date.parse(now);
    actor = seller;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    const auth = authModule.createServices(pools.auth, {});
    oauth = createConnectorOAuthService(
      () => auth,
      { connectorRedirectUris: [TCGPLAYER_CONNECTOR_REDIRECT_URI] },
      () => new Date(serverNow),
    );
    feed = createConnectorFeedRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      oauth: { ...oauth, resolveSeller: async () => actor },
      now: () => new Date(serverNow),
    });
    routes = createConnectorCredentialRoutes(feed, pools.channels);
    await pools.auth.query(
      `INSERT INTO auth_identity_accounts (account_id, name, display_name, account_type, status, updated_at)
      VALUES ($1, '', 'Synthetic seller', 'personal', 'active', now())`,
      [seller.accountId],
    );
    await pools.auth.query(
      `INSERT INTO auth_identity_user_memberships (membership_id, user_id, account_id, role_key, role_permissions, status)
      VALUES ($1, $2, $3, 'seller', '["channels.manage","channels.view"]', 'active')`,
      [seller.membershipId, seller.userId, seller.accountId],
    );
    const connections = createChannelConnectionRuntime(
      { eventStore: createPostgresEventStore({ pool: pools.channels }), db: pools.channels },
      {
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
      },
    );
    for (const connectionId of ["connection_A", "connection_B"]) {
      const target = { accountId: seller.accountId, connectionId };
      await connections.connectChannel(
        { ...target, providerKey: "fixture-connector" },
        { deploymentEnvironment: "test" },
        testContext,
      );
      await connections.activateChannelConnection(
        { ...target, bindings: [{ storageLocationId: "location_connector", revision: 1 }] },
        testContext,
      );
    }
    clientId = (
      await oauth.register({
        redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
        token_endpoint_auth_method: "none",
        scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
      })
    ).client_id;
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("background PKCE GET and real token routes bind one connection; every later call presents it; withAuthority refuses a swap", async () => {
    const f = await fixture();
    await f.command("start-pairing");
    expect(await f.background.status()).toMatchObject({
      state: "paired-idle",
      connectionId: "connection_A",
      pollWindowSeconds: 60,
    });
    const captured = await f.fake.custody.capture("connection_A");
    expect(captured.credential?.clientId).toBe(clientId);
    expect(f.session.rows()[pairingSessionKey]).toBeUndefined();
    await f.alarm("connector-work");
    expect(f.ports.transport.coordinate).toHaveBeenCalledWith({
      connectionId: "connection_A",
      accessToken: captured.credential!.accessToken,
    });
    await expect(
      feed.withAuthority(
        { token: captured.credential!.accessToken, connectionId: "connection_B", operation: "ingest" },
        async () => ({}),
      ),
    ).rejects.toThrow("invalid-credential");
    await f.command("unpair");
    const requests = vi.mocked(f.ports.transport.request).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers.get("X-Channel-Connection-Id")).toBe("connection_A");
    expect((await f.background.status()).state).toBe("unpaired");
    expect(await oauth.resolveToken(captured.credential!.accessToken)).toBeNull();
  });
  it.each(["state", "redirect", "expiry"])(
    "real authorization callback refuses %s before token transport",
    async (fault) => {
      const f = await fixture();
      const launch = f.ports.identity.launchWebAuthFlow;
      const original = vi.mocked(launch).getMockImplementation()!;
      vi.mocked(launch).mockImplementation(async (details) => {
        const callback = new URL(await original(details));
        if (fault === "state") callback.searchParams.set("state", "foreign-state");
        if (fault === "redirect") callback.pathname = "/other-callback";
        if (fault === "expiry") f.setTime(Date.parse(now) + 600_000);
        return callback.href;
      });
      await refused(f);
      expect(f.ports.transport.request).not.toHaveBeenCalled();
    },
  );
  it.each(["wrong-client", "wrong-redirect", "expired-code", "reused-code"])(
    "real token route refuses %s without a credential write",
    async (fault) => {
      const f = await fixture();
      const original = vi.mocked(f.ports.transport.request).getMockImplementation()!;
      vi.mocked(f.ports.transport.request).mockImplementation(async (request) => {
        const input = (await request.clone().json()) as Record<string, unknown>;
        if (fault === "wrong-client") input.client_id = "cc_client_wrong";
        if (fault === "wrong-redirect") input.redirect_uri = `${TCGPLAYER_CONNECTOR_REDIRECT_URI}/wrong`;
        if (fault === "expired-code") serverNow += 600_000;
        if (fault === "reused-code") expect((await original(request.clone())).status).toBe(200);
        const result = await original(new Request(request, { body: JSON.stringify(input) }));
        expect(result.status).toBe(400);
        return result;
      });
      await refused(f);
    },
  );
  it("real exchange missing identity or multiple identities is refused by background codec", async () => {
    for (const multiple of [false, true]) {
      const f = await fixture();
      const original = vi.mocked(f.ports.transport.request).getMockImplementation()!;
      vi.mocked(f.ports.transport.request).mockImplementation(async (request) => {
        const response = await original(request);
        expect(response.status).toBe(200);
        const tokens = (await response.json()) as Record<string, unknown>;
        expect(Object.keys(tokens).sort()).toEqual([
          "access_token",
          "connection_id",
          "expires_in",
          "refresh_token",
          "scope",
          "token_type",
        ]);
        if (multiple) tokens.connection_id = ["connection_A", "connection_B"];
        else delete tokens.connection_id;
        return Response.json(tokens);
      });
      await refused(f);
    }
  });
  it.each(["pairing_code_missing", "pairing_code_ambiguous", "authorization_refused"])(
    "real GET error %s ends pairing",
    async (error) => {
      const f = await fixture(error !== "pairing_code_missing");
      if (error === "pairing_code_ambiguous")
        await feed.createPairingCode({ accountId: seller.accountId, connectionId: "connection_B" }, seller);
      if (error === "authorization_refused") actor = { ...seller, permissions: [] };
      const original = vi.mocked(f.ports.identity.launchWebAuthFlow).getMockImplementation()!;
      vi.mocked(f.ports.identity.launchWebAuthFlow).mockImplementation(async (details) => {
        const callback = await original(details);
        expect(new URL(callback).searchParams.get("error_description")).toBe(error);
        return callback;
      });
      await refused(f);
      expect(f.ports.transport.request).not.toHaveBeenCalled();
    },
  );
});
