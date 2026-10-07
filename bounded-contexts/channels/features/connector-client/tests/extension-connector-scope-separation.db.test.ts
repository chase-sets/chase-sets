import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { createChannelConnectionRuntime } from "../../connections/api/runtime";
import type { ChannelConnectionHostPorts } from "../../connections/domain/contracts";
import { testContext } from "../../connections/tests/test-support";
import { module as channelsModule } from "../../../index";
import { createConnectorFeedRuntime } from "../../connector-feed/api/runtime";
import { createConnectorCredentialRoutes } from "../../connector-feed/api/routes";
import { binding, extensionCredentialKey, extensionProfileKey, now, profile, storage } from "./extension-test-support";

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
let pools: Readonly<Record<"auth" | "channels", PgTransactionalPool>>;
let oauth: ReturnType<typeof createConnectorOAuthService>;
let feed: ReturnType<typeof createConnectorFeedRuntime>;
let routes: ReturnType<typeof createConnectorCredentialRoutes>;
const verifier = "synthetic-extension-pkce-" + "v".repeat(43);
const redirectUri = "https://connector.example/callback";

async function postToken(input: unknown) {
  const response = await routes.request("http://localhost/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}
async function exchange(connectionId = "connection_A") {
  const client = await oauth.register({
    redirect_uri: redirectUri,
    token_endpoint_auth_method: "none",
    scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
  });
  await feed.createPairingCode({ accountId: seller.accountId, connectionId }, seller);
  const response = await routes.request(
    `http://localhost/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "synthetic-state",
    })}`,
  );
  expect(response.status).toBe(302);
  const code = new URL(response.headers.get("location")!).searchParams.get("code");
  expect(typeof code).toBe("string");
  const tokens = await postToken({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
  });
  return { tokens, clientId: client.client_id };
}
async function admit(tokens: unknown, clientId: string) {
  const fake = storage({ [extensionProfileKey]: profile("pairing-pending") });
  const captured = await fake.custody.capture(null);
  expect(await fake.custody.exchange(captured.fence, tokens, { ...binding, clientId })).toBe("committed");
  return fake;
}

describeDb("extension-connector-scope-separation", () => {
  beforeAll(async () => {
    if (!baseUrl) throw new Error("TEST_DATABASE_URL is required");
    const urls = createMultiContextTestDatabaseUrls(baseUrl, ["auth", "channels"], "extension_custody_7919");
    await ensureMultiContextTestDatabases(baseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    const auth = authModule.createServices(pools.auth, {});
    oauth = createConnectorOAuthService(
      () => auth,
      { connectorRedirectUris: [redirectUri] },
      () => new Date(now),
    );
    feed = createConnectorFeedRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      oauth: { ...oauth, resolveSeller: async () => seller },
      now: () => new Date(now),
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
      ports,
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
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("real composed exchange and rotation admit exactly one connection and six wire keys", async () => {
    const first = await exchange();
    const exactKeys = ["access_token", "refresh_token", "token_type", "expires_in", "scope", "connection_id"].sort();
    expect(Object.keys(first.tokens).sort()).toEqual(exactKeys);
    expect(first.tokens.connection_id).toBe("connection_A");
    const fake = await admit(first.tokens, first.clientId);
    const captured = await fake.custody.capture("connection_A");
    const rotated = await postToken({
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: captured.credential!.refreshToken,
    });
    expect(Object.keys(rotated).sort()).toEqual(exactKeys);
    expect(await fake.custody.refresh(captured.fence, rotated, now)).toBe("committed");
    const stale = await routes.request("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: first.clientId,
        refresh_token: captured.credential!.refreshToken,
      }),
    });
    expect(stale.status).toBe(400);
    expect((await oauth.resolveToken(rotated.access_token as string))?.connectionId).toBe("connection_A");
    const current = await fake.custody.capture("connection_A");
    expect(await fake.custody.advance(current.fence, profile("unpairing"))).toBe("committed");
    const unpairing = await fake.custody.capture("connection_A");
    const revoked = await routes.request("http://localhost/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: unpairing.credential!.accessToken }),
    });
    expect(revoked.status).toBe(200);
    expect(await fake.custody.advance(unpairing.fence, profile("revoked"))).toBe("committed");
    expect(fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(await oauth.resolveToken(rotated.access_token as string)).toBeNull();
    expect(await fake.custody.refresh(captured.fence, rotated, now)).toBe("stale-response-discarded");
  });
  it("identity-omitted and agent-family-merge controls refuse the real response with zero writes", async () => {
    const first = await exchange();
    const { connection_id: _identity, ...omitted } = first.tokens;
    for (const tokens of [
      omitted,
      { ...first.tokens, scope: `${first.tokens.scope} agent:read` },
      { ...first.tokens, connection_id: ["connection_A", "connection_A"] },
      { ...first.tokens, account_id: "acc_foreign" },
    ]) {
      const fake = storage({ [extensionProfileKey]: profile("pairing-pending") });
      const captured = await fake.custody.capture(null);
      expect(await fake.custody.exchange(captured.fence, tokens, { ...binding, clientId: first.clientId })).toBe(
        "refused",
      );
      expect(fake.writes()).toBe(0);
      expect(fake.deletes()).toBe(0);
    }
  });
  it("refresh-connection-swap and A-for-B refuse; transport presents the stored connection", async () => {
    const first = await exchange();
    const fake = await admit(first.tokens, first.clientId);
    const capture = await fake.custody.capture("connection_A");
    await expect(fake.custody.capture("connection_B")).rejects.toThrow("unavailable");
    const consumer = async () => ({ admitted: true });
    expect((await oauth.resolveToken(capture.credential!.accessToken))?.connectionId).toBe("connection_A");
    await expect(
      feed.withAuthority(
        { token: capture.credential!.accessToken, connectionId: "connection_B", operation: "ingest" },
        consumer,
      ),
    ).rejects.toThrow();
    const rotated = await postToken({
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: capture.credential!.refreshToken,
    });
    const before = fake.rows();
    expect(await fake.custody.refresh(capture.fence, { ...rotated, connection_id: "connection_B" }, now)).toBe(
      "refused",
    );
    expect(fake.rows()).toEqual(before);
    expect(await fake.custody.refresh(capture.fence, rotated, now)).toBe("committed");
    const current = await fake.custody.capture("connection_A");
    expect(
      await feed.withAuthority(
        { token: current.credential!.accessToken, connectionId: current.credential!.connectionId, operation: "ingest" },
        consumer,
      ),
    ).toEqual({ admitted: true });
  });
  it("real concurrent one-use refresh success and refusal leave the successful rotation intact", async () => {
    const first = await exchange();
    const fake = await admit(first.tokens, first.clientId);
    const captured = await fake.custody.capture("connection_A");
    const input = {
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: captured.credential!.refreshToken,
    };
    const results = await Promise.allSettled([feed.exchange(input), feed.exchange(input)]);
    const success = results.find((result) => result.status === "fulfilled");
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    if (!success || success.status !== "fulfilled") throw new Error("missing-rotation-winner");
    expect(await fake.custody.refuse(captured.fence)).toBe("refused");
    expect(await fake.custody.refresh(captured.fence, success.value, now)).toBe("committed");
    expect(await fake.custody.refuse(captured.fence)).toBe("stale-response-discarded");
    const current = await fake.custody.capture("connection_A");
    expect(await oauth.resolveToken(current.credential!.refreshToken, "refresh")).not.toBeNull();
    expect(fake.rows()[extensionCredentialKey]).toBeDefined();
  });
});
