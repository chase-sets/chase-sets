import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { module as authModule } from "@chase-sets/auth";
import { module as channelsModule } from "@chase-sets/channels";
import { module as identityModule } from "@chase-sets/identity";
import { createConnectorOAuthService, resolveActorFromRequest } from "@chase-sets/auth/server";
import { isChannelsServices, type ChannelsServices } from "@chase-sets/channels/server";
import { AUTH_SESSION_COOKIE_NAME, CHANNEL_CONNECTOR_SCOPE_FAMILY } from "@chase-sets/auth-context";
import { createId } from "@chase-sets/primitives/typed-ids";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";

let pools: PlatformApiTestPools;
let auth: ReturnType<typeof authModule.createServices>;
let app: ReturnType<typeof buildPlatformApiApp>;
let connectorFeed: ChannelsServices["connectorFeed"];
let cookie: string;
let accountId: ReturnType<typeof createId<"acc">>;
let userId: ReturnType<typeof createId<"usr">>;
const connectionId = "connector-composed-fixture";
const secretSentinel = "connector-secret-sentinel-";
const verifier = secretSentinel + "v".repeat(50);
const seenSecrets: string[] = [verifier];
let logs: ReturnType<typeof vi.spyOn>[] = [];
function request(path: string, input: unknown, authenticated = false) {
  return app.request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { cookie } : {}),
    },
    body: JSON.stringify(input),
  });
}
async function pairThroughHttp() {
  const registrationResponse = await request("/channel-connector/oauth/register", {
    redirect_uri: "https://connector.example/callback",
    token_endpoint_auth_method: "none",
    scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
  });
  expect(registrationResponse.status).toBe(200);
  const registration = await registrationResponse.json();
  const codeResponse = await request(`/api/channels/connections/${connectionId}/connector-pairing/code`, {}, true);
  expect(codeResponse.status).toBe(200);
  const pairing = await codeResponse.json();
  seenSecrets.push(pairing.code);
  const authorizationResponse = await request(
    "/channel-connector/oauth/authorize",
    {
      pairing_code: pairing.code,
      client_id: registration.client_id,
      redirect_uri: registration.redirect_uri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    },
    true,
  );
  expect(authorizationResponse.status).toBe(200);
  const authorized = await authorizationResponse.json();
  seenSecrets.push(authorized.code);
  const tokenResponse = await request("/channel-connector/oauth/token", {
    grant_type: "authorization_code",
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uri,
    code: authorized.code,
    code_verifier: verifier,
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = await tokenResponse.json();
  seenSecrets.push(tokens.access_token, tokens.refresh_token);
  return { tokens, pairing };
}

describe("connector-mount-gate-isolation", () => {
  createPlatformApiBootstrapTestHarness(
    "connector_composed_7993",
    (state) => {
      pools = state.pools;
    },
    { activeContextNames: ["auth", "identity", "channels"] },
  );
  beforeEach(async () => {
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    auth = authModule.createServices(pools.auth, {});
    const oauth = createConnectorOAuthService(() => auth);
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: { processorGateway: createFakePaymentProcessorGateway(), listingPhotoStorage },
    });
    app = buildPlatformApiApp(runtime, { resolveActor: (request) => resolveActorFromRequest(auth, request) });
    accountId = createId("acc");
    userId = createId("usr");
    const sessionId = createId("ses");
    const context = { tenantId: createId("tnt"), audit: { performedByUserId: userId, forAccountId: accountId } };
    await pools.auth.query(
      `INSERT INTO auth_identity_user_memberships (membership_id, user_id, account_id, role_key, role_permissions, status)
      VALUES ($1,$2,$3,'connector-test-seller','["channels.manage","channels.view"]','active')`,
      [createId("mem"), userId, accountId],
    );
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await auth.sessions.commandHandler({
      streamId: `auth.session-${sessionId}`,
      command: {
        type: "StartSession",
        sessionId,
        userId,
        accountId,
        availableAccountIds: [accountId],
        authenticationMethod: "passkey",
        expiresAt,
      },
      context,
    });
    const sessionToken = auth.auth.issueOpaqueToken("session_sentinel");
    seenSecrets.push(sessionToken);
    cookie = `${AUTH_SESSION_COOKIE_NAME}=${sessionToken}`;
    await pools.auth.query(
      `INSERT INTO identity_session_tokens (session_id, token_hash, expires_at)
      VALUES ($1,$2,$3)`,
      [sessionId, auth.auth.hashSecret(sessionToken), expiresAt],
    );
    const services = runtime.services.channels;
    if (!isChannelsServices(services)) throw new Error("Channels real composition unavailable");
    connectorFeed = services.connectorFeed;
    const connections = channelsModule.createServices(pools.channels, {
      connectorOAuth: oauth,
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context),
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
    }).connections;
    await connections.connectChannel(
      { accountId, connectionId, providerKey: "fixture-connector" },
      { deploymentEnvironment: "test" },
      context,
    );
    await connections.activateChannelConnection(
      { accountId, connectionId, bindings: [{ storageLocationId: "fixture-location", revision: 1 }] },
      context,
    );
    const foreignAccountId = createId("acc");
    await connections.connectChannel(
      { accountId: foreignAccountId, connectionId: "foreign", providerKey: "fixture-connector" },
      { deploymentEnvironment: "test" },
      { ...context, audit: { ...context.audit, forAccountId: foreignAccountId } },
    );
    logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  });
  afterEach(async () => {
    try {
      const rows = await pools.channels.query("SELECT * FROM channel_connector_audit");
      const events = await pools.channels.query("SELECT payload, metadata FROM event_store_events");
      const authEvents = await pools.auth.query("SELECT payload, metadata FROM event_store_events");
      const output = JSON.stringify({
        rows: rows.rows,
        events: events.rows,
        authEvents: authEvents.rows,
        logs: inspect(
          logs.flatMap((log) => log.mock.calls),
          { depth: null },
        ),
      });
      for (const secret of seenSecrets) expect(output).not.toContain(secret);
      expect(output).not.toContain(secretSentinel);
      expect(output).not.toContain("agent_grant_id");
    } finally {
      logs.forEach((log) => log.mockRestore());
    }
  });

  it("runs public registration, seller pairing, credential exchange and denies both principal substitutions", async () => {
    const paired = await pairThroughHttp();
    const sellerOnly = await request("/channel-connector/oauth/token", {}, true);
    expect(sellerOnly.status).toBe(400);
    expect(await sellerOnly.json()).toEqual({ error: "invalid-request" });
    const connectorOnSeller = await app.request(`http://localhost/api/channels/connections/${connectionId}`, {
      headers: { authorization: `Bearer ${paired.tokens.access_token}` },
    });
    expect(connectorOnSeller.status).toBe(401);
    const connectorAndCookie = await app.request(`http://localhost/api/channels/connections/${connectionId}`, {
      headers: { authorization: `Bearer ${paired.tokens.access_token}`, cookie },
    });
    expect(connectorAndCookie.status).toBe(401);
    const noSeller = await request(`/api/channels/connections/${connectionId}/connector-pairing/code`, {});
    expect(noSeller.status).toBe(401);
    const revoked = await request("/channel-connector/oauth/revoke", { token: paired.tokens.access_token });
    expect(revoked.status).toBe(200);
    expect(await createConnectorOAuthService(() => auth).resolveToken(paired.tokens.access_token)).toBeNull();
  });

  it("connector-feed-audit-completeness: one safe row per success/refusal, verified identities only", async () => {
    await pairThroughHttp();
    const denied = await request(`/api/channels/connections/${connectionId}/connector-pairing/code`, {});
    expect(denied.status).toBe(401);
    const foreign = await request("/api/channels/connections/foreign/connector-pairing/code", {}, true);
    const missing = await request("/api/channels/connections/missing/connector-pairing/code", {}, true);
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.text()).toBe(await missing.text());
    const invalid = await request("/channel-connector/oauth/token", {
      grant_type: "authorization_code",
      code: secretSentinel,
      nested: { secret: secretSentinel },
    });
    expect(invalid.status).toBe(400);
    const rows = await pools.channels.query("SELECT * FROM channel_connector_audit ORDER BY occurred_at");
    expect(rows.rows).toHaveLength(8);
    expect(rows.rows.filter((row) => row.outcome === "accepted")).toHaveLength(4);
    for (const row of rows.rows.filter((row) => row.outcome === "refused")) {
      expect(row.connection_id).toBeNull();
      expect(row.pairing_id).toBeNull();
    }
    const events = await pools.channels.query("SELECT payload, metadata FROM event_store_events");
    const output = JSON.stringify({
      rows: rows.rows,
      events: events.rows,
      logs: inspect(
        logs.flatMap((log) => log.mock.calls),
        { depth: null },
      ),
    });
    for (const secret of seenSecrets) expect(output).not.toContain(secret);
    expect(output).not.toContain(secretSentinel);
    expect(output).not.toContain("agent_grant_id");
  });

  it("classifies raw exceptions without leaking their sentinel into responses, audit, logs or events", async () => {
    const failure = vi.spyOn(connectorFeed, "exchange").mockRejectedValue(new Error(secretSentinel + "raw-exception"));
    try {
      const response = await request("/channel-connector/oauth/token", { code: secretSentinel });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable" });
      const rows = await pools.channels.query("SELECT * FROM channel_connector_audit");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        route: "token",
        outcome: "refused",
        reason: "unavailable",
        connection_id: null,
        pairing_id: null,
      });
    } finally {
      failure.mockRestore();
    }
  });

  it("audits every OAuth refusal and malformed transport once with unresolved identity", async () => {
    for (const route of ["register", "authorize", "token", "revoke"]) {
      const response = await request(
        `/channel-connector/oauth/${route}`,
        { unknown: { secret: secretSentinel } },
        true,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid-request" });
    }
    for (const payload of ["{", JSON.stringify({ code: secretSentinel + "x".repeat(8192) })]) {
      const response = await app.request("http://localhost/channel-connector/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid-request" });
    }
    const rows = await pools.channels.query("SELECT * FROM channel_connector_audit");
    expect(rows.rows).toHaveLength(6);
    for (const row of rows.rows)
      expect(row).toMatchObject({
        outcome: "refused",
        reason: "invalid-request",
        connection_id: null,
        pairing_id: null,
      });
    for (const route of ["register", "authorize", "revoke"])
      expect(rows.rows.filter((row) => row.route === route)).toHaveLength(1);
    expect(rows.rows.filter((row) => row.route === "token")).toHaveLength(3);
  });

  it("audits detail, unpair, repeat cleanup and refused authorize/revoke without trusting route identity", async () => {
    const paired = await pairThroughHttp();
    const detail = await app.request(`http://localhost/api/channels/connections/${connectionId}/connector-pairing`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ state: "paired", lastSeenAt: null });
    const unauthorized = await request("/channel-connector/oauth/authorize", { pairing_code: secretSentinel });
    expect(unauthorized.status).toBe(403);
    for (let attempt = 0; attempt < 2; attempt++) {
      const unpaired = await request(
        `/api/channels/connections/${connectionId}/connector-pairing/unpair`,
        { pairingId: paired.pairing.pairingId, revision: 2 },
        true,
      );
      expect(unpaired.status).toBe(200);
    }
    const revoke = await request("/channel-connector/oauth/revoke", { token: paired.tokens.access_token });
    expect(revoke.status).toBe(400);
    expect(await revoke.json()).toEqual({ error: "invalid-credential" });
    const rows = await pools.channels.query("SELECT * FROM channel_connector_audit");
    expect(rows.rows).toHaveLength(9);
    expect(rows.rows.filter((row) => row.route === "unpair")).toHaveLength(2);
    for (const row of rows.rows.filter((row) => row.route === "unpair" || row.route === "pairing-read")) {
      expect(row.connection_id).toBe(connectionId);
      expect(row.pairing_id).toBe(paired.pairing.pairingId);
    }
  });
});
