import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  resetProjectionGroup,
  seedApiModuleIfEmpty,
  syncContextProjectionGroups,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as identityModule } from "@chase-sets/identity";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { executeRetentionSweepBatch } from "@chase-sets/platform-runtime/retention-sweep";
import type { TenantId } from "@chase-sets/primitives/typed-ids";
import { module as authModule } from "../../index";
import type { AuthApiEnv } from "../../api";
import { sessionRoutes } from "../../features/sessions/api/route";
import type { SessionServices } from "../../features/sessions/api/runtime";
import type { SessionRow } from "../../features/sessions/read-model/queries";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import { createAuthServices } from "./services";
import { inspectAuthSeedState, seedAuthDatabase } from "./seed";
import { authRetentionSweeps } from "./retention-policy";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity", "auth"] as const;
const dayMs = 24 * 60 * 60 * 1_000;
const fixtures = [identitySeedIds.demo, identitySeedIds.support, identitySeedIds.collector];
const fixtureIds = fixtures.map(({ sessionId }) => sessionId).sort();
const expectedStatuses = [
  { session_id: identitySeedIds.demo.sessionId, status: "active" },
  { session_id: identitySeedIds.support.sessionId, status: "active" },
  { session_id: identitySeedIds.collector.sessionId, status: "expired" },
].sort((left, right) => left.session_id.localeCompare(right.session_id));
const seedContext: EventStoreContext = {
  tenantId: "tenant_seed_auth" as TenantId,
  audit: {
    performedByUserId: identitySeedIds.support.userId,
    forAccountId: identitySeedIds.support.accountId,
  },
  trace: {},
};
const sessionsSweep = authRetentionSweeps.find(({ tableName }) => tableName === "identity_sessions")!;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed auth seed reconciliation tests.");
  }
  return databaseBaseUrl;
}

function sweepAt(bootstrapTime: number, daysLater: number) {
  const timestamp = new Date(bootstrapTime + daysLater * dayMs).toISOString();
  return {
    ...sessionsSweep,
    predicateSql: sessionsSweep.predicateSql.replace("now()", `'${timestamp}'::timestamptz`),
  };
}

async function startFixtureSession(sessions: SessionServices, fixture: (typeof fixtures)[number], expiresAt: string) {
  await sessions.commandHandler({
    streamId: toSessionStreamId(fixture.sessionId),
    command: {
      type: "StartSession",
      sessionId: fixture.sessionId,
      userId: fixture.userId,
      accountId: fixture.accountId,
      availableAccountIds:
        fixture.sessionId === identitySeedIds.support.sessionId
          ? [fixture.accountId, identitySeedIds.demo.accountId]
          : [fixture.accountId],
      authenticationMethod: fixture.sessionId === identitySeedIds.support.sessionId ? "magic-link" : "password",
      expiresAt,
    },
    context: seedContext,
  });
}

function sessionsApp(sessions: SessionServices, actor: ResolvedActor) {
  const app = new Hono<AuthApiEnv>();
  app.use("*", async (context, next) => {
    context.set("actor", actor);
    context.set("context", seedContext);
    await next();
  });
  app.route("/sessions", sessionRoutes(sessions));
  return app;
}

describeDb("auth seed reconciliation", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "auth_seed_reconciliation",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.auth;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(authModule, pool);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function mountedRuntime() {
    return createMountedContextTestRuntime([
      { contextName: "identity", mountRole: "source-only", module: identityModule, pool: pools.identity, ports: {} },
      { contextName: "auth", module: authModule, pool, ports: {} },
    ]);
  }

  async function fullBootstrap() {
    await bootstrapContextDatabase(authModule, pool);
    const runtime = mountedRuntime();
    await syncContextProjectionGroups(runtime, "auth", { requiredOnly: true });
    // The host reconciles once, after catch-up, and after all contexts drain.
    for (let pass = 0; pass < 3; pass += 1) {
      await seedApiModuleIfEmpty(authModule, pool);
      await syncContextProjectionGroups(runtime, "auth");
      await drainContextRuntime(runtime);
    }
    return runtime;
  }

  async function history() {
    const eventStore = createPostgresEventStore({ pool });
    return Promise.all(
      fixtures.map(async ({ sessionId }) => ({
        sessionId,
        events: await eventStore.readStream({ streamId: toSessionStreamId(sessionId) }),
      })),
    );
  }

  async function rows() {
    const result = await pool.query<Pick<SessionRow, "session_id" | "status" | "started_at" | "expires_at">>(
      `SELECT session_id, status, started_at::text AS started_at, expires_at::text AS expires_at
       FROM identity_sessions WHERE session_id = ANY($1) ORDER BY session_id`,
      [fixtureIds],
    );
    return result.rows.map((row) => ({
      ...row,
      started_at: new Date(row.started_at!).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
    }));
  }

  async function assertSeedState() {
    expect((await rows()).map(({ session_id, status }) => ({ session_id, status }))).toEqual(expectedStatuses);
    expect((await inspectAuthSeedState(pool)).map(({ key, kind, status }) => ({ key, kind, status }))).toEqual([
      { key: "demo", kind: "active", status: "active" },
      { key: "support", kind: "active", status: "active" },
      { key: "collector", kind: "active", status: "expired" },
    ]);
  }

  async function resetAndReplay() {
    const runtime = mountedRuntime();
    const group = runtime.projectionGroups.find(({ projectionName }) => projectionName === "auth-session-projection")!;
    const revisionSyncToken = await resetProjectionGroup(group);
    expect(await rows()).toEqual([]);
    await drainContextRuntime({ subscriptionRunners: group.subscriptionRunners });
    await group.markRevisionSynced(revisionSyncToken);
  }

  it("characterizes historic seed deletion at the real DB clock and catch-up cannot resurrect deleted rows", async () => {
    const sessions = createAuthServices(pool).sessions;
    for (const fixture of fixtures) {
      await startFixtureSession(
        sessions,
        fixture,
        fixture.sessionId === identitySeedIds.collector.sessionId
          ? "2026-04-15T00:00:00.000Z"
          : "2026-05-10T00:00:00.000Z",
      );
    }
    await sessions.commandHandler({
      streamId: toSessionStreamId(identitySeedIds.support.sessionId),
      command: { type: "SwitchSessionAccount", accountId: identitySeedIds.demo.accountId },
      context: seedContext,
    });
    await sessions.commandHandler({
      streamId: toSessionStreamId(identitySeedIds.collector.sessionId),
      command: { type: "ExpireSession" },
      context: seedContext,
    });
    await syncContextProjectionGroups(mountedRuntime(), "auth");
    await assertSeedState();
    const original = await history();

    expect(await executeRetentionSweepBatch(pool, sessionsSweep)).toBe(3);
    await drainContextRuntime(mountedRuntime());
    expect(await rows()).toEqual([]);
    await fullBootstrap();
    expect(await rows()).toEqual([]);
    expect(await history()).toEqual(original);
    await resetAndReplay();
    await assertSeedState();
    expect(await history()).toEqual(original);
    expect(await executeRetentionSweepBatch(pool, sessionsSweep)).toBe(3);
  });

  it("keeps bootstrap-relative fixtures at T+1 while the unchanged seven-day sweep deletes an old control", async () => {
    const before = Date.now();
    await fullBootstrap();
    const after = Date.now();
    await assertSeedState();
    const originalRows = await rows();
    const demo = originalRows.find(({ session_id }) => session_id === identitySeedIds.demo.sessionId)!;
    const bootstrapTime = Date.parse(demo.started_at);
    expect(bootstrapTime).toBeGreaterThanOrEqual(before);
    expect(bootstrapTime).toBeLessThanOrEqual(after);
    for (const row of originalRows) {
      const collector = row.session_id === identitySeedIds.collector.sessionId;
      expect(Date.parse(row.started_at)).toBe(bootstrapTime - (collector ? 2 * dayMs : 0));
      expect(Date.parse(row.expires_at)).toBe(bootstrapTime + (collector ? -dayMs : 30 * dayMs));
    }
    const original = await history();
    expect(original.map(({ events }) => events.length)).toEqual([1, 2, 2]);
    for (const { sessionId, events } of original) {
      expect(events[0].recordedAt).toBe(originalRows.find(({ session_id }) => session_id === sessionId)!.started_at);
    }
    await pool.query(
      `INSERT INTO identity_sessions
       (session_id, user_id, account_id, available_account_ids, authentication_method, status, expires_at, started_at, updated_at)
       VALUES ('ses_synthetic_retention_control', 'usr_synthetic_retention', 'acc_synthetic_retention', '[]',
               'password', 'expired', $1, $1, $1)`,
      [new Date(bootstrapTime - 9 * dayMs).toISOString()],
    );

    expect(await executeRetentionSweepBatch(pool, sweepAt(bootstrapTime, 1))).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT session_id FROM identity_sessions WHERE session_id = 'ses_synthetic_retention_control'",
        )
      ).rows,
    ).toEqual([]);
    await assertSeedState();
    expect(await rows()).toEqual(originalRows);
    await drainContextRuntime(mountedRuntime());
    expect(await rows()).toEqual(originalRows);
    expect(await history()).toEqual(original);
  });

  it("preserves all three histories and times across same-boot repeat, retained restart, and committed reset/replay", async () => {
    await fullBootstrap();
    const original = await history();
    const originalRows = await rows();
    await seedAuthDatabase(pool);
    await drainContextRuntime(mountedRuntime());
    await assertSeedState();
    expect(await history()).toEqual(original);
    expect(await rows()).toEqual(originalRows);

    await fullBootstrap();
    await assertSeedState();
    expect(await history()).toEqual(original);
    expect(await rows()).toEqual(originalRows);
    await resetAndReplay();
    await assertSeedState();
    expect(await history()).toEqual(original);
    expect(await rows()).toEqual(originalRows);
  });

  it("completes a demo-only interrupted bootstrap without re-dating committed history", async () => {
    const services = createAuthServices(pool);
    await startFixtureSession(services.sessions, identitySeedIds.demo, "2026-05-10T00:00:00.000Z");
    const interrupted = await history();
    expect(interrupted.map(({ events }) => events.length)).toEqual([1, 0, 0]);
    await fullBootstrap();
    await assertSeedState();
    const completed = await history();
    const completedRows = await rows();
    expect(completed[0]).toEqual(interrupted[0]);
    expect(completed.map(({ events }) => events.length)).toEqual([1, 2, 2]);
    await fullBootstrap();
    await resetAndReplay();
    await assertSeedState();
    expect(await history()).toEqual(completed);
    expect(await rows()).toEqual(completedRows);
    const credentials = await pool.query<{ credential_id: string }>(
      "SELECT credential_id FROM identity_password_credentials ORDER BY credential_id",
    );
    expect(credentials.rows.map(({ credential_id }) => credential_id).sort()).toEqual(
      [identitySeedIds.demo.credentialId, identitySeedIds.collector.credentialId].sort(),
    );
  });

  it("lets an aged collector disappear without recreating or re-dating its stream", async () => {
    await fullBootstrap();
    const original = await history();
    const originalRows = await rows();
    const bootstrapTime = Date.parse(
      originalRows.find(({ session_id }) => session_id === identitySeedIds.demo.sessionId)!.started_at,
    );
    expect(await executeRetentionSweepBatch(pool, sweepAt(bootstrapTime, 7))).toBe(1);
    await fullBootstrap();
    expect(await rows()).toEqual(
      originalRows.filter(({ session_id }) => session_id !== identitySeedIds.collector.sessionId),
    );
    expect(await history()).toEqual(original);
    expect((await inspectAuthSeedState(pool)).find(({ key }) => key === "collector")?.status).toBe("expired");
    await resetAndReplay();
    expect(await rows()).toEqual(originalRows);
    expect(await executeRetentionSweepBatch(pool, sweepAt(bootstrapTime, 7))).toBe(1);
    expect(await history()).toEqual(original);
  });

  it("serves seeded list/detail rows to explicit actors without exposing another user's sessions to the collector", async () => {
    await fullBootstrap();
    const sessions = createAuthServices(pool).sessions;
    const collectorActor: ResolvedActor = {
      sessionId: "ses_synthetic_collector_request",
      tenantId: "tenant_seed_auth",
      userId: identitySeedIds.collector.userId,
      accountId: identitySeedIds.collector.accountId,
      membershipId: "mbr_synthetic_collector_request",
      roleKey: "collector",
      permissions: [],
    };
    const collectorApp = sessionsApp(sessions, collectorActor);
    const collectorList = await collectorApp.request("/sessions?limit=50&offset=0");
    expect(collectorList.status).toBe(200);
    expect(await collectorList.json()).toMatchObject({
      items: [{ session_id: identitySeedIds.collector.sessionId, status: "expired" }],
      total: 1,
      count: 1,
    });
    const collectorDetail = await collectorApp.request(`/sessions/${identitySeedIds.collector.sessionId}`);
    expect(collectorDetail.status).toBe(200);
    expect(await collectorDetail.json()).toMatchObject({
      session_id: identitySeedIds.collector.sessionId,
      status: "expired",
    });
    for (const fixture of [identitySeedIds.demo, identitySeedIds.support]) {
      const forbidden = await collectorApp.request(`/sessions/${fixture.sessionId}`);
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ error: { code: "authorization_forbidden" } });
    }
    const missing = await collectorApp.request("/sessions/ses_synthetic_nonexistent");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });

    const adminApp = sessionsApp(sessions, {
      ...collectorActor,
      roleKey: "platform-admin",
      userId: identitySeedIds.support.userId,
    });
    const adminList = await adminApp.request("/sessions?limit=50&offset=0");
    expect(adminList.status).toBe(200);
    const adminData = (await adminList.json()) as { items: SessionRow[]; total: number; count: number };
    expect(adminData.total).toBe(3);
    expect(adminData.count).toBe(3);
    expect(
      adminData.items
        .map(({ session_id, status }) => ({ session_id, status }))
        .sort((left, right) => left.session_id.localeCompare(right.session_id)),
    ).toEqual(expectedStatuses);
    for (const { session_id, status } of expectedStatuses) {
      const detail = await adminApp.request(`/sessions/${session_id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ session_id, status });
    }
  });
});
