import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventSubscriptionSchemaSql } from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { FreshWriteReceipt } from "@chase-sets/http/responses";
import {
  createAuthIdentityInvitationProjectionPositionReader,
  createInvitationProjectionFreshnessWaiter,
} from "./invitation-projection-freshness";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

// The literal checkpoint identity the Auth runtime writes for this projection
// (projectionName:sourceContextName:vSubscriptionVersion, per its context.json
// subscription). The reader must reconstruct exactly this key from its own
// constants -- inserting the literal here keeps the assertion non-tautological.
const AUTH_INVITATION_CHECKPOINT_KEY = "auth-identity-invitation-projection:identity:v1";

function invitationReceipt(maxGlobalPosition: string): FreshWriteReceipt {
  return {
    observedAtMs: 1,
    sources: [{ sourceContextName: "identity", maxGlobalPosition, eventIds: [`evt_${maxGlobalPosition}`] }],
  };
}

async function upsertCheckpointPosition(db: PgQueryable, lastGlobalPosition: string): Promise<void> {
  await db.query(
    `INSERT INTO event_subscription_checkpoints (
       checkpoint_key, projection_name, source_context_name, subscription_version, last_global_position, updated_at
     ) VALUES ($1, 'auth-identity-invitation-projection', 'identity', 1, $2, now())
     ON CONFLICT (checkpoint_key)
     DO UPDATE SET last_global_position = EXCLUDED.last_global_position, updated_at = EXCLUDED.updated_at`,
    [AUTH_INVITATION_CHECKPOINT_KEY, lastGlobalPosition],
  );
}

describeDb("invitation projection freshness (database)", () => {
  let pool: PgTransactionalPool;
  let db: PgQueryable;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl as string, ["auth"], "auth-invite-fresh");
    await ensureMultiContextTestDatabases(adminDatabaseUrl as string, databaseUrls);
    const pools = createMultiContextTestPools(databaseUrls);
    pool = pools.auth;
    db = pool as PgQueryable;
    await db.query(eventSubscriptionSchemaSql);
  });

  afterAll(async () => {
    if (pool) {
      await closeMultiContextTestPools({ auth: pool });
    }
  });

  beforeEach(async () => {
    await db.query("DELETE FROM event_subscription_checkpoints");
  });

  it("reads the durable checkpoint position under the runtime's checkpoint key", async () => {
    const reader = createAuthIdentityInvitationProjectionPositionReader(db);

    expect(await reader()).toBe("0");

    await upsertCheckpointPosition(db, "7");
    expect(await reader()).toBe("7");
  });

  it("settles once the projection checkpoint reaches the forwarded version (stale then fresh)", async () => {
    const reader = createAuthIdentityInvitationProjectionProbe(db);
    await upsertCheckpointPosition(db, "3");

    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition: reader.read,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });

    // Advance the durable checkpoint to the forwarded version mid-wait.
    setTimeout(() => {
      void upsertCheckpointPosition(db, "5");
    }, 30);

    const startedAt = performance.now();
    await wait(invitationReceipt("5"));

    expect(performance.now() - startedAt).toBeLessThan(900);
    expect(reader.reads()).toBeGreaterThan(1);
  });

  it("falls back gracefully and bounded when the checkpoint never reaches the version", async () => {
    await upsertCheckpointPosition(db, "1");
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition: createAuthIdentityInvitationProjectionPositionReader(db),
      timeoutMs: 60,
      pollIntervalMs: 5,
    });

    const startedAt = performance.now();
    await expect(wait(invitationReceipt("5"))).resolves.toBeUndefined();
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2_000);
  });
});

function createAuthIdentityInvitationProjectionProbe(db: PgQueryable) {
  const read = createAuthIdentityInvitationProjectionPositionReader(db);
  let count = 0;
  return {
    read: async () => {
      count += 1;
      return read();
    },
    reads: () => count,
  };
}
