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
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { isoUtcFromDate } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId, SessionId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as authModule } from "../../index";
import { createSessionRuntime } from "../../features/sessions/api/runtime";
import type { AuthMethod } from "../../features/sessions/domain/auth-flow";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import {
  SESSION_GENERATION_ADVANCED_EVENT_TYPE,
  SESSION_GENERATION_SCHEMA_MIGRATION_ID,
  toUserSessionAuthorityStreamId,
  UserSessionAuthorityUnreadableError,
} from "../../features/sessions/domain/session-generation";
import { buildSessionProjectionHandlers } from "../../features/sessions/read-model/projection";
import { registerSessionApiRoutes } from "../api-support/session-routes";
import type { AuthApiEnv } from "../api-support/support";
import { upsertSessionToken } from "../auth-support/store";
import { resolveActorFromRequest } from "./runtime";
import { seedAuthDatabase } from "./seed";
import { createAuthServices, resolveActorFromSessionId, startInteractiveAuth, type AuthServices } from "./services";

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

  describe("session-generation-zero-compatibility", () => {
    it("reads a pre-feature start, token, and row as generation 0 and authenticates exactly like a guarded start", async () => {
      const sessionId = "ses_synthetic_pre_feature";
      const started = await appendPreFloorStart(services.eventStore, sessionId);
      const legacyToken = await issueLocatorToken(sessionId);
      await insertProjectedSession(pool, { sessionId, expiresAt: futureExpiry() });
      const guarded = await startProjectedSession({ sessionId: "ses_synthetic_post_feature" });
      const app = buildSessionApp(services);

      // The pre-feature reader's column list still reads the expanded table.
      const preFeatureRead = await pool.query(
        `SELECT session_id, user_id, account_id, available_account_ids, authentication_method, status, expires_at,
                started_at, updated_at
         FROM identity_sessions WHERE session_id = $1`,
        [sessionId],
      );
      expect(preFeatureRead.rows).toHaveLength(1);
      await expect(services.sessions.getSession(sessionId)).resolves.toMatchObject({ session_generation: 0 });
      await expect(services.sessions.readUserSessionAuthority(USER_ID)).resolves.toEqual({
        userId: USER_ID,
        sessionGeneration: 0,
        version: 0,
      });
      await expect(services.sessions.readAuthenticatedSession(sessionId)).resolves.toMatchObject({
        state: { sessionGeneration: 0, status: "active" },
        authenticatedAt: started.recordedAt,
      });
      expect(guarded.startedEvent.payload).toMatchObject({ sessionGeneration: 0 });
      for (const token of [legacyToken, guarded.token])
        expect((await app.request("/session", sessionRequest(token))).status).toBe(200);
      await expect(resolveActorFromSessionId(services, sessionId)).resolves.toMatchObject({
        sessionProvenance: "auth-session",
        authenticatedAt: started.recordedAt,
      });

      for (const sessionToRevoke of [sessionId, guarded.sessionId])
        await services.sessions.commandHandler({
          streamId: toSessionStreamId(sessionToRevoke),
          command: { type: "RevokeSession" },
          context: eventContext(),
        });
      for (const token of [legacyToken, guarded.token])
        expect((await app.request("/session", sessionRequest(token))).status).toBe(401);
    });

    it("expands a pre-feature table without rewriting started_at and keeps it through reset and day-after replay", async () => {
      const sessionId = "ses_synthetic_pre_feature_row";
      const dayBefore = isoUtcFromDate(new Date(Date.now() - 24 * 60 * 60_000));
      const started = await appendPreFloorStart(createPostgresEventStore({ pool, now: () => dayBefore }), sessionId);
      await pool.query("ALTER TABLE identity_sessions DROP COLUMN session_generation");
      await insertPreFeatureRow(sessionId, started.recordedAt);

      const migration = authModule.schemaMigrations?.find(
        (entry) => entry.migrationId === SESSION_GENERATION_SCHEMA_MIGRATION_ID,
      );
      expect(migration).toBeDefined();
      for (const statement of migration?.statements ?? []) await pool.query(statement);
      await expect(readGenerationRow(sessionId)).resolves.toEqual({ startedAt: started.recordedAt, generation: 0 });

      // Boot re-convergence is idempotent over the expanded table.
      await bootstrapContextDatabase(authModule, pool);
      await expect(readGenerationRow(sessionId)).resolves.toEqual({ startedAt: started.recordedAt, generation: 0 });

      // Reset, then replay the day-old start the next day: started_at stays the start's recordedAt.
      await pool.query("DELETE FROM identity_sessions WHERE session_id = $1", [sessionId]);
      await projectStoredSessionEvent(started);
      await projectStoredSessionEvent(started);
      await expect(readGenerationRow(sessionId)).resolves.toEqual({ startedAt: started.recordedAt, generation: 0 });
      await expect(resolveActorFromSessionId(services, sessionId)).resolves.toMatchObject({
        authenticatedAt: dayBefore,
      });
    });
  });

  describe("session-start-generation-zero-guard", () => {
    it("starts through the real interactive contract in generation 0 without authority history", async () => {
      const sessionId = "ses_synthetic_guarded_start";
      const result = await startInteractiveAuth(services, guardedStartParams(sessionId));

      expect(result.type).toBe("session-started");
      const history = await services.eventStore.readStream({ streamId: toSessionStreamId(sessionId) });
      expect(history.map((event) => [event.eventType, event.payload.sessionGeneration])).toEqual([
        ["auth.session.started", 0],
      ]);
      await expect(
        services.eventStore.readStream({ streamId: toUserSessionAuthorityStreamId(USER_ID) }),
      ).resolves.toEqual([]);
      await expect(readTokenCount(sessionId)).resolves.toBe(1);
      if (result.type !== "session-started") throw new Error("Expected a started Session.");
      expect((await buildSessionApp(services).request("/session", sessionRequest(result.sessionToken))).status).toBe(
        200,
      );
    });

    it("commits no Session or token when authority moves between read and append, and the replay starts current", async () => {
      const sessionId = "ses_synthetic_guard_conflict";
      const authorityStreamId = toUserSessionAuthorityStreamId(USER_ID);
      let contending = true;
      const barrier: EventStore = {
        ...services.eventStore,
        readStream: async (input) => {
          const page = await services.eventStore.readStream(input);
          if (contending && input.streamId === authorityStreamId) await advanceAuthority();
          return page;
        },
      };
      const guarded = {
        ...services,
        sessions: createSessionRuntime({
          eventStore: barrier,
          checkpointStore: createPostgresProjectionStore({ db: pool }),
          db: pool,
        }),
      } as AuthServices;

      await expect(startInteractiveAuth(guarded, guardedStartParams(sessionId))).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
      await expect(services.eventStore.readStream({ streamId: toSessionStreamId(sessionId) })).resolves.toEqual([]);
      await expect(readTokenCount(sessionId)).resolves.toBe(0);

      contending = false;
      const replay = await startInteractiveAuth(guarded, guardedStartParams(sessionId));

      expect(replay.type).toBe("session-started");
      const authority = await services.sessions.readUserSessionAuthority(USER_ID);
      expect(authority.sessionGeneration).toBeGreaterThan(0);
      const [startedEvent] = await services.eventStore.readStream({ streamId: toSessionStreamId(sessionId) });
      expect(startedEvent?.payload.sessionGeneration).toBe(authority.sessionGeneration);
      await expect(readTokenCount(sessionId)).resolves.toBe(1);
      await expect(resolveActorFromSessionId(services, sessionId)).resolves.toMatchObject({ sessionId });
    });

    it("starts every seed Session through the same guard in generation 0 and reconciles without restarting", async () => {
      await seedAuthDatabase(pool);
      const seeded = [identitySeedIds.demo, identitySeedIds.support, identitySeedIds.collector];
      const firstPass = [];
      for (const seed of seeded) {
        const history = await services.eventStore.readStream({ streamId: toSessionStreamId(seed.sessionId) });
        expect(history[0]).toMatchObject({ eventType: "auth.session.started", payload: { sessionGeneration: 0 } });
        await expect(
          services.eventStore.readStream({ streamId: toUserSessionAuthorityStreamId(seed.userId) }),
        ).resolves.toEqual([]);
        firstPass.push(history.length);
      }

      await seedAuthDatabase(pool);
      for (const [index, seed] of seeded.entries())
        expect((await services.eventStore.readStream({ streamId: toSessionStreamId(seed.sessionId) })).length).toBe(
          firstPass[index],
        );
    });
  });

  describe("session-generation-actor-resolution", () => {
    it("projection hit and miss agree while authority is 0", async () => {
      const fixture = await startProjectedSession({ sessionId: "ses_synthetic_generation_agreement" });

      const hit = await resolveActorFromSessionId(services, fixture.sessionId);
      await pool.query("DELETE FROM identity_sessions WHERE session_id = $1", [fixture.sessionId]);
      const miss = await resolveActorFromSessionId(services, fixture.sessionId);

      expect(hit).toMatchObject({
        sessionId: fixture.sessionId,
        sessionProvenance: "auth-session",
        authenticatedAt: fixture.startedEvent.recordedAt,
      });
      expect(miss).toEqual(hit);
    });

    it("rejects a generation-0 Session under authority 1 on hit, miss, and reset while lifecycle and recent-auth remain", async () => {
      const fixture = await startProjectedSession({ sessionId: "ses_synthetic_superseded" });
      const app = buildSessionApp(services);
      expect((await app.request("/session", sessionRequest(fixture.token))).status).toBe(200);

      await advanceAuthority();
      const membership = vi.spyOn(services.identity, "getActiveMembershipForUserAccount");

      await expect(readProjectedSessionStatus(pool, fixture.sessionId)).resolves.toBe("active");
      await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.toBeNull();
      expect((await app.request("/session", sessionRequest(fixture.token))).status).toBe(401);
      await pool.query("DELETE FROM identity_sessions WHERE session_id = $1", [fixture.sessionId]);
      await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.toBeNull();
      await projectStoredSessionEvent(fixture.startedEvent);
      await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.toBeNull();
      expect(membership).not.toHaveBeenCalled();
      membership.mockRestore();

      await services.sessions.commandHandler({
        streamId: toSessionStreamId(fixture.sessionId),
        command: { type: "RevokeSession" },
        context: eventContext(),
      });
      await expect(services.sessions.getSessionState(fixture.sessionId)).resolves.toMatchObject({
        status: "revoked",
        sessionGeneration: 0,
      });
      const current = await startProjectedSession({ sessionId: "ses_synthetic_current_generation" });
      expect(current.startedEvent.payload).toMatchObject({ sessionGeneration: 1 });
      await expect(resolveActorFromSessionId(services, current.sessionId)).resolves.toMatchObject({
        authenticatedAt: current.startedEvent.recordedAt,
      });
    });

    it("folds a complete 500-event and 501-event authority history", async () => {
      await services.eventStore.appendToStream({
        streamId: toUserSessionAuthorityStreamId(USER_ID),
        expectedVersion: "no_stream",
        context: eventContext(),
        events: Array.from({ length: 500 }, (_, index) => ({
          eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE,
          payload: { userId: USER_ID, sessionGeneration: index + 1 },
        })),
      });
      const fixture = await startProjectedSession({ sessionId: "ses_synthetic_history_500" });
      expect(fixture.startedEvent.payload).toMatchObject({ sessionGeneration: 500 });
      await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.not.toBeNull();

      await advanceAuthority();

      await expect(services.sessions.readUserSessionAuthority(USER_ID)).resolves.toEqual({
        userId: USER_ID,
        sessionGeneration: 501,
        version: 501,
      });
      await expect(resolveActorFromSessionId(services, fixture.sessionId)).resolves.toBeNull();
    });

    it("fails closed for newer, malformed, foreign-User, foreign-authority, and synthetic shapes", async () => {
      const app = buildSessionApp(services);
      for (const [sessionId, sessionGeneration] of [
        ["ses_synthetic_newer_generation", 1],
        ["ses_synthetic_malformed_generation", "0"],
      ] as const) {
        const started = await appendPreFloorStart(services.eventStore, sessionId, { sessionGeneration });
        await projectStoredSessionEvent(started);
        await expect(readProjectedSessionStatus(pool, sessionId)).resolves.toBe("active");
        await expect(resolveActorFromSessionId(services, sessionId)).resolves.toBeNull();
      }

      const foreignUser = await appendPreFloorStart(services.eventStore, "ses_synthetic_foreign_user", {
        userId: "usr_synthetic_foreign_user",
      });
      await projectStoredSessionEvent(foreignUser);
      await expect(resolveActorFromSessionId(services, "ses_synthetic_foreign_user")).resolves.toBeNull();

      for (const syntheticId of ["guest:tok_synthetic", "ucp:lpa_synthetic"]) {
        const token = await issueLocatorToken(syntheticId);
        expect((await app.request("/session", sessionRequest(token))).status).toBe(401);
      }

      const fixture = await startProjectedSession({ sessionId: "ses_synthetic_foreign_authority" });
      await services.eventStore.appendToStream({
        streamId: toUserSessionAuthorityStreamId(USER_ID),
        expectedVersion: "no_stream",
        context: eventContext(),
        events: [
          {
            eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE,
            payload: { userId: "usr_synthetic_foreign_user", sessionGeneration: 1 },
          },
        ],
      });
      await expect(resolveActorFromSessionId(services, fixture.sessionId)).rejects.toBeInstanceOf(
        UserSessionAuthorityUnreadableError,
      );
    });
  });

  describe("session-generation-mixed-version-floor", () => {
    it("serves pre-floor and floor pods side by side, keeps pre-floor rollback safe, and never grants from the projection", async () => {
      const oldPodSessionId = "ses_synthetic_old_pod";
      const oldPodStart = await appendPreFloorStart(services.eventStore, oldPodSessionId);
      await insertProjectedSession(pool, { sessionId: oldPodSessionId, expiresAt: futureExpiry() });
      const oldPodToken = await issueLocatorToken(oldPodSessionId);
      const newPod = await startInteractiveAuth(services, guardedStartParams("ses_synthetic_new_pod"));
      if (newPod.type !== "session-started") throw new Error("Expected a started Session.");
      const app = buildSessionApp(services);

      // A pre-floor reader folds the floor's start unchanged: rollback before any advance is safe.
      const newPodHistory = await services.eventStore.readStream({
        streamId: toSessionStreamId("ses_synthetic_new_pod"),
      });
      expect(foldWithPreFloorReader(newPodHistory)).toEqual({
        id: "ses_synthetic_new_pod",
        userId: USER_ID,
        accountId: OLD_ACCOUNT_ID,
        availableAccountIds: [NEW_ACCOUNT_ID, OLD_ACCOUNT_ID].sort(),
        authenticationMethod: "password",
        status: "active",
        expiresAt: newPodHistory[0]?.payload.expiresAt,
      });
      await expect(services.sessions.readAuthenticatedSession(oldPodSessionId)).resolves.toMatchObject({
        state: { sessionGeneration: 0 },
        authenticatedAt: oldPodStart.recordedAt,
      });
      for (const token of [oldPodToken, newPod.sessionToken])
        expect((await app.request("/session", sessionRequest(token))).status).toBe(200);

      // Neither a forged projection generation nor a stream-less row can grant.
      await pool.query("UPDATE identity_sessions SET session_generation = 1 WHERE user_id = $1", [USER_ID]);
      await insertProjectedSession(pool, { sessionId: "ses_synthetic_projection_only", expiresAt: futureExpiry() });
      await pool.query("UPDATE identity_sessions SET session_generation = 1 WHERE session_id = $1", [
        "ses_synthetic_projection_only",
      ]);
      await advanceAuthority();
      for (const token of [oldPodToken, newPod.sessionToken, await issueLocatorToken("ses_synthetic_projection_only")])
        expect((await app.request("/session", sessionRequest(token))).status).toBe(401);
    });
  });

  function futureExpiry() {
    return new Date(Date.now() + FUTURE_EXPIRY_OFFSET_MS).toISOString();
  }

  function guardedStartParams(sessionId: string) {
    return {
      userId: USER_ID,
      sessionId,
      accountId: OLD_ACCOUNT_ID,
      authenticationMethod: "password" as const,
      context: eventContext(),
    };
  }

  /** The `auth.session.started` shape every pre-floor writer (old pod, retained history) appended. */
  async function appendPreFloorStart(
    eventStore: EventStore,
    sessionId: string,
    overrides: Readonly<Record<string, unknown>> = {},
  ) {
    const [started] = await eventStore.appendToStream({
      streamId: toSessionStreamId(sessionId),
      expectedVersion: "no_stream",
      context: eventContext(),
      events: [
        {
          eventType: "auth.session.started",
          payload: {
            sessionId,
            userId: USER_ID,
            accountId: OLD_ACCOUNT_ID,
            availableAccountIds: [OLD_ACCOUNT_ID],
            authenticationMethod: "password",
            expiresAt: futureExpiry(),
            ...overrides,
          },
        },
      ],
    });
    return requireStoredEvent(started);
  }

  /** Stands in for the successor bulk command, the only future writer of authority history. */
  async function advanceAuthority() {
    const authority = await services.sessions.readUserSessionAuthority(USER_ID);
    await services.eventStore.appendToStream({
      streamId: toUserSessionAuthorityStreamId(USER_ID),
      expectedVersion: authority.version === 0 ? "no_stream" : authority.version,
      context: eventContext(),
      events: [
        {
          eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE,
          payload: { userId: USER_ID, sessionGeneration: authority.sessionGeneration + 1 },
        },
      ],
    });
  }

  async function issueLocatorToken(sessionId: string) {
    const token = `session-token-${sessionId}`;
    await upsertSessionToken(services.db, {
      sessionId,
      tokenHash: services.auth.hashSecret(token),
      expiresAt: new Date(Date.now() + LOCATOR_EXPIRY_OFFSET_MS).toISOString(),
    });
    return token;
  }

  async function readTokenCount(sessionId: string) {
    const result = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM identity_session_tokens WHERE session_id = $1",
      [sessionId],
    );
    return result.rows[0]?.total ?? 0;
  }

  /** The pre-feature projection INSERT: no session_generation column exists or is named. */
  async function insertPreFeatureRow(sessionId: string, startedAt: string) {
    await pool.query(
      `INSERT INTO identity_sessions (
         session_id, user_id, account_id, available_account_ids, authentication_method,
         status, expires_at, started_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, 'password', 'active', $5, $6, $6)`,
      [sessionId, USER_ID, OLD_ACCOUNT_ID, JSON.stringify([OLD_ACCOUNT_ID]), futureExpiry(), startedAt],
    );
  }

  async function readGenerationRow(sessionId: string) {
    const result = await pool.query<{ started_at: Date | string; session_generation: number }>(
      "SELECT started_at, session_generation FROM identity_sessions WHERE session_id = $1",
      [sessionId],
    );
    const row = result.rows[0];
    return row ? { startedAt: new Date(row.started_at).toISOString(), generation: row.session_generation } : null;
  }

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

type PreFloorSessionState = Readonly<{
  id: string | null;
  userId: string | null;
  accountId: string | null;
  availableAccountIds: readonly string[];
  authenticationMethod: string | null;
  status: string;
  expiresAt: string | null;
}>;

/**
 * Frozen copy of `evolveSession` as it shipped before the Session Generation
 * floor -- the reader a rolled-back pod runs. It must keep folding every
 * floor-written start unchanged for pre-floor rollback to be safe.
 */
function foldWithPreFloorReader(history: readonly StoredEvent[]): PreFloorSessionState {
  const initial: PreFloorSessionState = {
    id: null,
    userId: null,
    accountId: null,
    availableAccountIds: [],
    authenticationMethod: null,
    status: "active",
    expiresAt: null,
  };
  return history.reduce<PreFloorSessionState>((state, event) => {
    const data = event.payload as Readonly<Record<string, unknown>>;
    switch (event.eventType) {
      case "auth.session.started":
        return {
          id: data.sessionId as string,
          userId: data.userId as string,
          accountId: data.accountId as string,
          availableAccountIds: data.availableAccountIds as readonly string[],
          authenticationMethod: data.authenticationMethod as string,
          status: "active",
          expiresAt: data.expiresAt as string,
        };
      case "auth.session.account-switched":
        return { ...state, accountId: data.accountId as string };
      case "auth.session.revoked":
        return { ...state, status: "revoked" };
      case "auth.session.expired":
        return { ...state, status: "expired" };
      default:
        throw new Error(`The pre-floor Session reader cannot fold ${event.eventType}.`);
    }
  }, initial);
}

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
