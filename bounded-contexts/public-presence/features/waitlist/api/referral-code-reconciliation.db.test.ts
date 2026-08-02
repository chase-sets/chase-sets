import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  readGapSafeEventStoreHead,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, GlobalPosition } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as publicPresenceModule } from "../../../index";
import { publicReferralCodeDigest } from "../domain/public-referral-code";
import { waitlistSchemaMigrations } from "../read-model/schema";
import { createPublicReferralCodeReconciliation } from "./referral-code-reconciliation";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Public Referral Code reconciliation DB tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_public_presence" as TenantId,
  audit: { performedByUserId: "usr_reconciliation" as UserId, forAccountId: "acc_public_presence" as AccountId },
};

describeDb("Public Referral Code reconciliation", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["public-presence"],
      "issue_6418_referral_code_reconciliation",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls)["public-presence"];
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ "public-presence": pool });
    await bootstrapContextDatabase(publicPresenceModule, pool);
  });

  afterAll(async () => closeMultiContextTestPools({ "public-presence": pool }));

  it("issue-6418-ac-6 keeps fresh boot and the ledgered legacy migration on the same referral-code columns", async () => {
    expect(await referralColumnInventory(pool)).toEqual(["public_referral_code", "public_referral_code_issued_at"]);
    await resetMultiContextTestSchemas({ "public-presence": pool });
    await pool.query("CREATE TABLE public_presence_waitlist_signups (signup_id text PRIMARY KEY)");
    const migration = waitlistSchemaMigrations.find(
      (entry) => entry.migrationId === "20260802_public_presence_referral_codes",
    );
    expect(migration).toBeDefined();
    for (const statement of migration!.statements) await pool.query(statement);
    expect(await referralColumnInventory(pool)).toEqual(["public_referral_code", "public_referral_code_issued_at"]);
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'public_presence_waitlist_signups' ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      "public_presence_waitlist_signups_public_referral_code_uidx",
    );
  });

  for (const count of [500, 501]) {
    it(`proves the fixed-horizon ${count} exact-coverage boundary in real PostgreSQL`, async () => {
      const eventStore = createPostgresEventStore({ pool });
      await seedCompleteSignups(eventStore, count);
      const reconcile = createPublicReferralCodeReconciliation({
        eventStore,
        pool,
        now: sequenceClock(),
      });
      const receipt = await reconcile({ context });
      expect(receipt.payload).toMatchObject({
        completeSignupCount: count,
        validIssuedCount: count,
        validReservedCount: count,
        cutoverEligible: true,
      });
      expect(receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(receipt)).not.toContain("wlr_");
    });
  }

  it("holds one inclusive horizon when the head moves and ignores projection lag and empty containers", async () => {
    const postgres = createPostgresEventStore({ pool });
    await seedCompleteSignups(postgres, 1);
    await pool.query(
      `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
       VALUES ('public-presence.waitlist-signup-wls_empty', 0, now())`,
    );
    let injected = false;
    const eventStore: EventStore = {
      ...postgres,
      readAll: async (input) => {
        if (!injected) {
          injected = true;
          await postgres.appendToStream(recordedAppend(999));
        }
        return postgres.readAll(input);
      },
    };
    const receipt = await createPublicReferralCodeReconciliation({ eventStore, pool, now: sequenceClock() })({
      context,
    });
    expect(receipt.payload.completeSignupCount).toBe(1);
    expect(receipt.payload.cutoverEligible).toBe(true);
    const projection = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public_presence_waitlist_signups",
    );
    expect(projection.rows[0].count).toBe("0");
  });

  it("refuses a caller horizon beyond the real PostgreSQL gap-safe head", async () => {
    const eventStore = createPostgresEventStore({ pool });
    await eventStore.appendToStream(recordedAppend(1));
    const head = await readGapSafeEventStoreHead(pool);
    const future = (BigInt(head) + 1n).toString() as GlobalPosition;
    await expect(eventStore.readAll({ atOrBeforeGlobalPosition: future, limit: 500 })).rejects.toMatchObject({
      code: "infrastructure_failure",
    });
  });

  it("resumes after a mid-command stop and is inert on triple invocation and a day-after runtime", async () => {
    const eventStore = createPostgresEventStore({ pool });
    await eventStore.appendToStreams!([recordedAppend(1), recordedAppend(2)]);
    let stopped = false;
    const interrupted = createPublicReferralCodeReconciliation({
      eventStore,
      pool,
      now: sequenceClock(),
      randomBytes: uniqueEntropy(),
      afterSignupReconciled: () => {
        if (!stopped) {
          stopped = true;
          throw new Error("simulated mid-command stop");
        }
      },
    });
    await expect(interrupted({ context })).rejects.toThrow("simulated mid-command stop");

    const resumed = createPublicReferralCodeReconciliation({
      eventStore,
      pool,
      now: sequenceClock("2026-08-03T00:00:00.000Z"),
      randomBytes: uniqueEntropy(20),
    });
    const first = await resumed({ context });
    expect(first.payload.cutoverEligible).toBe(true);
    const eventCount = await eventCountForReferralAuthority(pool);
    await resumed({ context });
    await resumed({ context });
    const bootTwo = createPublicReferralCodeReconciliation({
      eventStore: createPostgresEventStore({ pool }),
      pool,
      now: sequenceClock("2026-08-04T00:00:00.000Z"),
    });
    await bootTwo({ context });
    expect(await eventCountForReferralAuthority(pool)).toBe(eventCount);
  });

  it("fails closed across partial, mismatched, duplicate, terminal-order, unexpected, issued-only, and reserved-only histories", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const partialCode = codeFor(1);
    const mismatchCode = codeFor(2);
    await eventStore.appendToStreams!([
      {
        ...recordedAppend(1),
        events: [...recordedAppend(1).events, issuedEvent("wls_1", partialCode)],
      },
      {
        ...recordedAppend(2),
        events: [...recordedAppend(2).events, issuedEvent("wls_other", mismatchCode)],
      },
      {
        ...recordedAppend(3),
        events: [...recordedAppend(3).events, issuedEvent("wls_3", codeFor(3)), issuedEvent("wls_3", codeFor(4))],
      },
      {
        ...recordedAppend(4),
        events: [
          {
            eventType: "public-presence.waitlist-signup.admitted",
            payload: {
              signupId: "wls_4",
              email: "4@example.com",
              waveNumber: 1,
              invitationId: "wvi_4",
              admittedAt: "2026-08-01T00:00:00.000Z",
            },
          },
          ...recordedAppend(4).events,
        ],
      },
      {
        ...recordedAppend(5),
        events: [
          ...recordedAppend(5).events,
          { eventType: "public-presence.waitlist-signup.poisoned", payload: { signupId: "wls_5" } },
        ],
      },
      {
        streamId: "public-presence.waitlist-signup-wls_6",
        expectedVersion: "no_stream",
        context,
        events: [issuedEvent("wls_6", codeFor(6))],
      },
      reservationAppend(codeFor(7)),
    ]);

    const receipt = await createPublicReferralCodeReconciliation({
      eventStore,
      pool,
      now: sequenceClock(),
      randomBytes: uniqueEntropy(50),
    })({ context });
    expect(receipt.payload.cutoverEligible).toBe(false);
    expect(receipt.payload.refusalCounts.mismatched).toBeGreaterThan(0);
    expect(receipt.payload.refusalCounts.duplicate).toBeGreaterThan(0);
    expect(receipt.payload.refusalCounts.unexpected).toBeGreaterThan(0);
    expect(receipt.payload.refusalCounts.missingRecorded).toBeGreaterThan(0);
    expect(receipt.payload.validIssuedCount).toBeGreaterThanOrEqual(1);
    expect(receipt.payload.validReservedCount).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when two complete signup streams claim the same reserved code", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const duplicatedCode = codeFor(1);
    await eventStore.appendToStreams!([
      {
        ...recordedAppend(1),
        events: [...recordedAppend(1).events, issuedEvent("wls_1", duplicatedCode)],
      },
      {
        ...recordedAppend(2),
        events: [...recordedAppend(2).events, issuedEvent("wls_2", duplicatedCode)],
      },
      reservationAppend(duplicatedCode),
    ]);

    const receipt = await createPublicReferralCodeReconciliation({ eventStore, pool, now: sequenceClock() })({
      context,
    });
    expect(receipt.payload).toMatchObject({
      completeSignupCount: 2,
      validIssuedCount: 0,
      validReservedCount: 0,
      cutoverEligible: false,
    });
    expect(receipt.payload.refusalCounts.duplicate).toBe(2);
  });
});

async function seedCompleteSignups(eventStore: EventStore, count: number) {
  const inputs: AppendToStreamInput[] = [];
  for (let index = 1; index <= count; index += 1) {
    const code = codeFor(index);
    inputs.push({
      ...recordedAppend(index),
      events: [...recordedAppend(index).events, issuedEvent(`wls_${index}`, code)],
    });
    inputs.push(reservationAppend(code));
  }
  await eventStore.appendToStreams!(inputs);
}

function recordedAppend(index: number): AppendToStreamInput {
  const signupId = `wls_${index}`;
  return {
    streamId: `public-presence.waitlist-signup-${signupId}`,
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "public-presence.waitlist-signup.recorded",
        payload: {
          signupId,
          email: `${index}@example.com`,
          role: "both",
          interests: ["low-sales-fees"],
          emailConsentAcceptedAt: "2026-08-01T00:00:00.000Z",
          marketingConsentAcceptedAt: null,
          source: {
            pagePath: "/",
            referrer: null,
            utmSource: null,
            utmMedium: null,
            utmCampaign: null,
            utmContent: null,
            utmTerm: null,
          },
          referredBySignupId: null,
          cohortQuality: { games: [], hasStoreLink: false, storeUrl: null, inventorySize: null },
          recordedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    ],
  };
}

function issuedEvent(signupId: string, publicReferralCode: string) {
  return {
    eventType: "public-presence.waitlist-referral-code.issued",
    payload: { signupId, publicReferralCode, issuedAt: "2026-08-01T00:00:00.000Z" },
  };
}

function reservationAppend(publicReferralCode: string): AppendToStreamInput {
  const codeDigest = publicReferralCodeDigest(publicReferralCode);
  return {
    streamId: `public-presence.waitlist-referral-code-${codeDigest}`,
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "public-presence.waitlist-referral-code.reserved",
        payload: { codeDigest, reservedAt: "2026-08-01T00:00:00.000Z" },
      },
    ],
  };
}

function codeFor(index: number) {
  return `wlr_${Buffer.from(index.toString().padStart(24, "0"), "utf8").toString("base64url")}`;
}

function uniqueEntropy(start = 1) {
  let value = start;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    new DataView(bytes.buffer).setUint32(length - 4, value++);
    return bytes;
  };
}

function sequenceClock(initial = "2026-08-02T00:00:00.000Z") {
  let next = new Date(initial).getTime();
  return () => new Date(next++);
}

async function eventCountForReferralAuthority(pool: PgTransactionalPool) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM event_store_events
     WHERE event_type IN ('public-presence.waitlist-referral-code.issued', 'public-presence.waitlist-referral-code.reserved')`,
  );
  return Number(result.rows[0].count);
}

async function referralColumnInventory(pool: PgTransactionalPool) {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'public_presence_waitlist_signups'
       AND column_name LIKE 'public_referral_code%'
     ORDER BY column_name`,
  );
  return result.rows.map((row) => row.column_name);
}
