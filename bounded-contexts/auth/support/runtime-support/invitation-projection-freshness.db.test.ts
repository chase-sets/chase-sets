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
    const reader = createAuthIdentityInvitationProjectionProbe(db, "3");
    await upsertCheckpointPosition(db, "3");

    // A frozen clock never times the wait out, so only a fresh read can settle it.
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition: reader.read,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
      nowMs: () => 0,
    });

    const settlement = wait(invitationReceipt("5")).then(() => ({
      freshReadBeforeSettlement: reader.positions().includes("5"),
    }));

    // Advance the durable checkpoint only after the waiter has observed it stale.
    await reader.firstStaleRead;
    const readsBeforeWrite = reader.positions();
    await upsertCheckpointPosition(db, "5");

    await expect(settlement).resolves.toEqual({ freshReadBeforeSettlement: true });
    expect(readsBeforeWrite[0]).toBe("3");
    expect(readsBeforeWrite).not.toContain("5");
  });

  it("falls back gracefully and bounded when the checkpoint never reaches the version", async () => {
    const timeoutMs = 60;
    const clock = createSteppedClock(10);
    await upsertCheckpointPosition(db, "1");
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition: createAuthIdentityInvitationProjectionPositionReader(db),
      timeoutMs,
      pollIntervalMs: 5,
      nowMs: clock.nowMs,
    });

    await expect(wait(invitationReceipt("5"))).resolves.toBeUndefined();

    // The stepped clock starts at 0, so each reading is the elapsed time the
    // waiter saw: it gave up exactly when that first reached timeoutMs.
    const readings = clock.readings();
    expect(readings.at(-1)).toBeGreaterThanOrEqual(timeoutMs);
    expect(readings.filter((elapsedMs) => elapsedMs >= timeoutMs)).toHaveLength(1);
  });
});

function createAuthIdentityInvitationProjectionProbe(db: PgQueryable, stalePosition: string) {
  const read = createAuthIdentityInvitationProjectionPositionReader(db);
  const positions: string[] = [];
  let markFirstStaleRead: () => void = () => undefined;
  const firstStaleRead = new Promise<void>((resolve) => {
    markFirstStaleRead = resolve;
  });
  return {
    read: async () => {
      const position = await read();
      positions.push(position);
      if (position === stalePosition) {
        markFirstStaleRead();
      }
      return position;
    },
    positions: () => [...positions],
    firstStaleRead,
  };
}

function createSteppedClock(stepMs: number) {
  const readings: number[] = [];
  return {
    nowMs: () => {
      const readingMs = readings.length * stepMs;
      readings.push(readingMs);
      return readingMs;
    },
    readings: () => [...readings],
  };
}
