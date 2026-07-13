import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { module as authModule } from "../../index";
import { createAuthServices } from "./services";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import { seedAuthDatabase } from "./seed";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["auth"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed auth seed reconciliation tests.");
  }

  return databaseBaseUrl;
}

async function countSessionEvents(pool: PgTransactionalPool, sessionId: string) {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
    [toSessionStreamId(sessionId)],
  );

  return Number(result.rows[0]?.count ?? 0);
}

describeDb("auth seed reconciliation", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

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
    await resetMultiContextTestSchemas({ auth: pool });
    await bootstrapContextDatabase(authModule, pool);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("reseeds idempotently when the full seed runs twice back to back", async () => {
    await seedAuthDatabase(pool);
    const firstPassCount = await countSessionEvents(pool, identitySeedIds.demo.sessionId);
    expect(firstPassCount).toBeGreaterThan(0);

    await expect(seedAuthDatabase(pool)).resolves.toBeUndefined();

    expect(await countSessionEvents(pool, identitySeedIds.demo.sessionId)).toBe(firstPassCount);
    expect(await countSessionEvents(pool, identitySeedIds.support.sessionId)).toBeGreaterThan(0);
    expect(await countSessionEvents(pool, identitySeedIds.collector.sessionId)).toBeGreaterThan(0);
  });

  it("reconciles cleanly when the session projection is reset but the event store retains seeded sessions", async () => {
    // Mirrors the auth-session-projection's "truncate-owned-tables" reset
    // strategy landing between bootstraps (or a projection that has not
    // caught up yet after an interrupted bootstrap): the identity_sessions
    // read model goes empty while the event store retains every
    // already-seeded session's history. Reconciliation must key off the
    // event store, not the read model, or it replays StartSession into an
    // already-started aggregate and fails with "Session has already been
    // started."
    await seedAuthDatabase(pool);
    const eventsBefore = await countSessionEvents(pool, identitySeedIds.demo.sessionId);

    await pool.query("TRUNCATE TABLE identity_sessions, identity_session_lookup");

    await expect(seedAuthDatabase(pool)).resolves.toBeUndefined();
    expect(await countSessionEvents(pool, identitySeedIds.demo.sessionId)).toBe(eventsBefore);
  });

  it("completes the remaining seed steps after an interrupted bootstrap left only the demo session started", async () => {
    // Simulates a crash immediately after the first StartSession append: the
    // demo session aggregate exists, but nothing else the seed produces
    // (support/collector sessions, credentials) has run yet.
    const services = createAuthServices(pool);
    const context = {
      tenantId: "tenant_seed_auth" as never,
      audit: {
        performedByUserId: identitySeedIds.support.userId,
        forAccountId: identitySeedIds.support.accountId,
      },
    };
    await services.sessions.commandHandler({
      streamId: toSessionStreamId(identitySeedIds.demo.sessionId),
      command: {
        type: "StartSession",
        sessionId: identitySeedIds.demo.sessionId,
        userId: identitySeedIds.demo.userId,
        accountId: identitySeedIds.demo.accountId,
        availableAccountIds: [identitySeedIds.demo.accountId],
        authenticationMethod: "password",
        expiresAt: new Date("2026-05-10T00:00:00.000Z").toISOString(),
      },
      context,
    });

    await expect(seedAuthDatabase(pool)).resolves.toBeUndefined();

    expect(await countSessionEvents(pool, identitySeedIds.demo.sessionId)).toBe(1);
    expect(await countSessionEvents(pool, identitySeedIds.support.sessionId)).toBeGreaterThan(0);
    expect(await countSessionEvents(pool, identitySeedIds.collector.sessionId)).toBeGreaterThan(0);

    const credential = await pool.query<{ credential_id: string }>(
      "SELECT credential_id FROM identity_password_credentials WHERE credential_id = $1",
      [identitySeedIds.demo.credentialId],
    );
    expect(credential.rows).toHaveLength(1);
  });
});
