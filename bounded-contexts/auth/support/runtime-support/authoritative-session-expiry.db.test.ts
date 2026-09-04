import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { AccountId, SessionId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as authModule } from "../../index";
import type { AuthMethod } from "../../features/sessions/domain/auth-flow";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import { buildSessionProjectionHandlers } from "../../features/sessions/read-model/projection";
import { registerSessionApiRoutes } from "../api-support/session-routes";
import type { AuthApiEnv } from "../api-support/support";
import { upsertSessionToken } from "../auth-support/store";
import { resolveActorFromRequest } from "./runtime";
import { createAuthServices, resolveActorFromSessionId, type AuthServices } from "./services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["auth"] as const;

const USER_ID = "usr_synthetic_authoritative_session";
const OLD_ACCOUNT_ID = "acc_synthetic_stale_projection";
const NEW_ACCOUNT_ID = "acc_synthetic_aggregate_authority";
const FUTURE_EXPIRY_OFFSET_MS = 5 * 60_000;
const LOCATOR_EXPIRY_OFFSET_MS = 10 * 60_000;

describeDb("authoritative Auth Session actor resolution", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
  let services: AuthServices;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "auth_session_authority",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.auth;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ auth: pool });
    await bootstrapContextDatabase(authModule, pool);
    services = createAuthServices(pool);
    await seedIdentityProjection(pool);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("retained token is denied while the revoke projection is held", async () => {
    const fixture = await startProjectedSession({ sessionId: "ses_synthetic_held_revoke" });
    const app = buildSessionApp(services);

    const signOut = await app.request("/sign-out", sessionRequest(fixture.token, "POST"));

    expect(signOut.status).toBe(200);
    await expect(readProjectedSessionStatus(pool, fixture.sessionId)).resolves.toBe("active");
    const retained = await app.request("/session", sessionRequest(fixture.token));
    expect(retained.status).toBe(401);
  });

  it("retained token remains denied after projection convergence", async () => {
    const fixture = await startProjectedSession({ sessionId: "ses_synthetic_converged_revoke" });
    const app = buildSessionApp(services);

    expect((await app.request("/sign-out", sessionRequest(fixture.token, "POST"))).status).toBe(200);
    await expect(readProjectedSessionStatus(pool, fixture.sessionId)).resolves.toBe("active");
    expect((await app.request("/session", sessionRequest(fixture.token))).status).toBe(401);

    const history = await services.eventStore.readStream({ streamId: toSessionStreamId(fixture.sessionId) });
    const revoked = history.find((event) => event.eventType === "auth.session.revoked");
    expect(revoked).toBeDefined();
    await projectStoredSessionEvent(requireStoredEvent(revoked));

    await expect(readProjectedSessionStatus(pool, fixture.sessionId)).resolves.toBe("revoked");
    expect((await app.request("/session", sessionRequest(fixture.token))).status).toBe(401);
  });

  it("active aggregate with future expiry grants from exact aggregate authority", async () => {
    const fixture = await startProjectedSession({ sessionId: "ses_synthetic_future_expiry" });
    await pool.query(
      `UPDATE identity_sessions
       SET status = 'expired', expires_at = $2, authentication_method = 'google'
       WHERE session_id = $1`,
      [fixture.sessionId, new Date(Date.now() - 60_000).toISOString()],
    );

    const actor = await resolveActorFromSessionId(services, fixture.sessionId);

    expect(actor).toMatchObject({
      sessionId: fixture.sessionId,
      userId: USER_ID,
      accountId: OLD_ACCOUNT_ID,
      membershipId: "mbr_synthetic_old_account",
    });
    expect(actor?.authenticatedAt).toBe(fixture.startedEvent.recordedAt);
  });

  it("active aggregate with elapsed expiry denies before identity resolution", async () => {
    const fixture = await startProjectedSession({
      sessionId: "ses_synthetic_elapsed_expiry",
      aggregateExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      projectedExpiresAt: new Date(Date.now() + FUTURE_EXPIRY_OFFSET_MS).toISOString(),
    });
    const membership = vi.spyOn(services.identity, "getActiveMembershipForUserAccount");
    const user = vi.spyOn(services.identity, "getUser");

    await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.toBeNull();
    expect(membership).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled();
  });

  it("malformed aggregate expiry denies before identity resolution", async () => {
    const fixture = await startAggregateSession({
      sessionId: "ses_synthetic_malformed_expiry",
      aggregateExpiresAt: "not-a-timestamp",
    });
    await insertProjectedSession(pool, {
      sessionId: fixture.sessionId,
      expiresAt: new Date(Date.now() + FUTURE_EXPIRY_OFFSET_MS).toISOString(),
    });
    const membership = vi.spyOn(services.identity, "getActiveMembershipForUserAccount");
    const user = vi.spyOn(services.identity, "getUser");

    await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.toBeNull();
    await expect(readProjectedSessionStatus(pool, fixture.sessionId)).resolves.toBe("active");
    expect(membership).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled();
  });

  it("aggregate account wins over stale projected account", async () => {
    const fixture = await startProjectedSession({
      sessionId: "ses_synthetic_account_switch",
      availableAccountIds: [OLD_ACCOUNT_ID, NEW_ACCOUNT_ID],
    });
    await services.sessions.commandHandler({
      streamId: toSessionStreamId(fixture.sessionId),
      command: { type: "SwitchSessionAccount", accountId: NEW_ACCOUNT_ID as AccountId },
      context: eventContext(),
    });

    const projected = await services.sessions.getSession(fixture.sessionId);
    expect(projected?.account_id).toBe(OLD_ACCOUNT_ID);
    const actor = await resolveActorFromSessionId(services, fixture.sessionId);

    expect(actor).toMatchObject({
      accountId: NEW_ACCOUNT_ID,
      membershipId: "mbr_synthetic_new_account",
      roleKey: "authoritative-role",
    });
    expect(actor?.permissions).toContain("authoritative.account.permission");
    expect(actor?.permissions).not.toContain("stale.account.permission");
  });

  it("aggregate authentication method cannot be overridden by the projection", async () => {
    const fixture = await startProjectedSession({ sessionId: "ses_synthetic_auth_method" });
    await pool.query(
      `UPDATE auth_identity_users
       SET primary_email = 'synthetic@example.test',
           contact_methods = $1::jsonb
       WHERE user_id = $2`,
      [
        JSON.stringify([
          {
            contactMethodId: "ctm_synthetic_unverified",
            type: "email",
            value: "synthetic@example.test",
            verifiedAt: null,
          },
        ]),
        USER_ID,
      ],
    );
    await pool.query("UPDATE identity_sessions SET authentication_method = 'google' WHERE session_id = $1", [
      fixture.sessionId,
    ]);

    const actor = await resolveActorFromSessionId(services, fixture.sessionId);

    expect(actor).not.toBeNull();
    expect(actor?.permissions).not.toContain("listings.manage");
  });

  it.each(["RevokeSession", "ExpireSession"] as const)(
    "%s aggregate state denies while the projection remains active",
    async (commandType) => {
      const fixture = await startProjectedSession({ sessionId: `ses_synthetic_${commandType.toLowerCase()}` });
      const membership = vi.spyOn(services.identity, "getActiveMembershipForUserAccount");

      await services.sessions.commandHandler({
        streamId: toSessionStreamId(fixture.sessionId),
        command: { type: commandType },
        context: eventContext(),
      });

      await expect(readProjectedSessionStatus(pool, fixture.sessionId)).resolves.toBe("active");
      await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.toBeNull();
      expect(membership).not.toHaveBeenCalled();
    },
  );

  it("missing aggregate cannot be rescued by an active projection", async () => {
    const sessionId = "ses_synthetic_missing_aggregate";
    await insertProjectedSession(pool, {
      sessionId,
      expiresAt: new Date(Date.now() + FUTURE_EXPIRY_OFFSET_MS).toISOString(),
    });
    const membership = vi.spyOn(services.identity, "getActiveMembershipForUserAccount");

    await expect(resolveActorFromSessionId(services, sessionId)).resolves.toBeNull();
    expect(membership).not.toHaveBeenCalled();
  });

  async function startProjectedSession(
    options: Readonly<{
      sessionId: string;
      aggregateExpiresAt?: string;
      projectedExpiresAt?: string;
      availableAccountIds?: readonly string[];
    }>,
  ) {
    const fixture = await startAggregateSession(options);
    await projectStoredSessionEvent(fixture.startedEvent);
    if (options.projectedExpiresAt) {
      await pool.query("UPDATE identity_sessions SET expires_at = $2 WHERE session_id = $1", [
        fixture.sessionId,
        options.projectedExpiresAt,
      ]);
    }
    return fixture;
  }

  async function startAggregateSession(
    options: Readonly<{
      sessionId: string;
      aggregateExpiresAt?: string;
      availableAccountIds?: readonly string[];
    }>,
  ) {
    const aggregateExpiresAt =
      options.aggregateExpiresAt ?? new Date(Date.now() + FUTURE_EXPIRY_OFFSET_MS).toISOString();
    const result = await services.sessions.commandHandler({
      streamId: toSessionStreamId(options.sessionId),
      command: {
        type: "StartSession",
        sessionId: options.sessionId as SessionId,
        userId: USER_ID as UserId,
        accountId: OLD_ACCOUNT_ID as AccountId,
        availableAccountIds: [...(options.availableAccountIds ?? [OLD_ACCOUNT_ID])],
        authenticationMethod: "password" satisfies AuthMethod,
        expiresAt: aggregateExpiresAt,
      },
      context: eventContext(),
    });
    const startedEvent = requireStoredEvent(result.storedEvents[0]);
    const token = `session-token-${options.sessionId}`;
    await upsertSessionToken(services.db, {
      sessionId: options.sessionId,
      tokenHash: services.auth.hashSecret(token),
      expiresAt: new Date(Date.now() + LOCATOR_EXPIRY_OFFSET_MS).toISOString(),
    });
    return { sessionId: options.sessionId, token, startedEvent };
  }

  async function projectStoredSessionEvent(event: StoredEvent) {
    const transportEvent = toTransportEvent(event);
    const handler = buildSessionProjectionHandlers(pool)[transportEvent.type];
    if (!handler) {
      throw new Error(`Missing Session projection handler for ${transportEvent.type}.`);
    }
    await handler(transportEvent);
  }
});

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for authoritative Auth Session tests.");
  }
  return databaseBaseUrl;
}

function requireStoredEvent(event: StoredEvent | undefined): StoredEvent {
  if (!event) {
    throw new Error("Expected a stored Auth Session event.");
  }
  return event;
}

function eventContext() {
  return {
    tenantId: "tnt_synthetic_authoritative_session" as never,
    audit: {
      performedByUserId: USER_ID as never,
      forAccountId: OLD_ACCOUNT_ID as never,
    },
  };
}

function sessionRequest(token: string, method = "GET") {
  return {
    method,
    headers: { cookie: `chase_sets_session=${token}` },
  };
}

function buildSessionApp(services: AuthServices) {
  const app = new Hono<AuthApiEnv>();
  app.use("*", async (context, next) => {
    const actor = await resolveActorFromRequest(services, context.req.raw);
    context.set("actor", actor);
    if (actor) {
      context.set("context", createActorEventStoreContext(actor));
    }
    await next();
  });
  registerSessionApiRoutes(app, services);
  return app;
}

async function seedIdentityProjection(pool: PgTransactionalPool) {
  await pool.query(
    `INSERT INTO auth_identity_users (
       user_id, display_name, given_name, family_name, primary_email, status,
       contact_methods, auth_methods, password_credential_id, passkey_credential_ids,
       social_login_links, updated_at
     ) VALUES ($1, 'Synthetic User', 'Synthetic', 'User', NULL, 'active', '[]', '["password"]', NULL, '[]', '[]', now())`,
    [USER_ID],
  );
  await pool.query(
    `INSERT INTO auth_identity_accounts (account_id, name, display_name, account_type, status, updated_at)
     VALUES
       ($1, 'synthetic-stale', 'Synthetic Stale', 'seller', 'active', now()),
       ($2, 'synthetic-authority', 'Synthetic Authority', 'seller', 'active', now())`,
    [OLD_ACCOUNT_ID, NEW_ACCOUNT_ID],
  );
  const membershipValues = [
    USER_ID,
    OLD_ACCOUNT_ID,
    NEW_ACCOUNT_ID,
    JSON.stringify(["stale.account.permission", "listings.manage"]),
    JSON.stringify(["authoritative.account.permission"]),
  ];
  await pool.query(
    `INSERT INTO auth_identity_memberships (
       membership_id, user_id, account_id, role_key, role_permissions, status, updated_at
     ) VALUES
       ('mbr_synthetic_old_account', $1, $2, 'stale-role', $4::jsonb, 'active', now()),
       ('mbr_synthetic_new_account', $1, $3, 'authoritative-role', $5::jsonb, 'active', now())`,
    membershipValues,
  );
  await pool.query(
    `INSERT INTO auth_identity_user_memberships (
       membership_id, user_id, account_id, role_key, role_permissions, status, updated_at
     ) VALUES
       ('mbr_synthetic_old_account', $1, $2, 'stale-role', $4::jsonb, 'active', now()),
       ('mbr_synthetic_new_account', $1, $3, 'authoritative-role', $5::jsonb, 'active', now())`,
    membershipValues,
  );
}

async function insertProjectedSession(
  pool: PgTransactionalPool,
  options: Readonly<{ sessionId: string; expiresAt: string }>,
) {
  await pool.query(
    `INSERT INTO identity_sessions (
       session_id, user_id, account_id, available_account_ids, authentication_method,
       status, expires_at, started_at, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, 'password', 'active', $5, now(), now())`,
    [options.sessionId, USER_ID, OLD_ACCOUNT_ID, JSON.stringify([OLD_ACCOUNT_ID]), options.expiresAt],
  );
}

async function readProjectedSessionStatus(pool: PgTransactionalPool, sessionId: string) {
  const result = await pool.query<{ status: string }>("SELECT status FROM identity_sessions WHERE session_id = $1", [
    sessionId,
  ]);
  return result.rows[0]?.status ?? null;
}
