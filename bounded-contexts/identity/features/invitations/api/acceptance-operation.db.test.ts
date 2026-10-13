import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { acceptInvitationOperation } from "./acceptance-operation";
import { acceptanceContext, acceptanceOperation, seedAcceptance } from "./acceptance-test-support";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
(base ? describe : describe.skip)("invitation-acceptance-identity-atomicity", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["identity"], "invitation_acceptance_atomicity");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.identity;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  it.each([
    "identity.invitation-ivt_invited",
    "identity.membership-mbr_reserved",
    `identity.invitation-acceptance-${acceptanceOperation.attemptId}`,
  ])("rolls back every participant after a database fault at %s", async (streamId) => {
    const store = createPostgresEventStore({ pool });
    await seedAcceptance(store);
    await pool.query(
      `CREATE FUNCTION reject_acceptance_participant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stream_id = '${streamId}' THEN RAISE EXCEPTION 'synthetic participant fault'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER acceptance_fault BEFORE INSERT ON event_store_events FOR EACH ROW EXECUTE FUNCTION reject_acceptance_participant()",
    );
    await expect(
      acceptInvitationOperation(store, {
        operation: acceptanceOperation,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).rejects.toThrow();
    expect(await store.readStream({ streamId: "identity.invitation-ivt_invited" })).toHaveLength(2);
    expect(await store.readStream({ streamId: "identity.membership-mbr_reserved" })).toHaveLength(0);
    expect(
      await store.readStream({ streamId: `identity.invitation-acceptance-${acceptanceOperation.attemptId}` }),
    ).toHaveLength(0);
    await pool.query("DROP TRIGGER acceptance_fault ON event_store_events");
    await expect(
      acceptInvitationOperation(store, {
        operation: acceptanceOperation,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      }),
    ).resolves.toMatchObject({ membershipId: "mbr_reserved" });
  });
  it("concurrent exact replays converge and wrong-bound replays append nothing", async () => {
    const store = createPostgresEventStore({ pool });
    await seedAcceptance(store);
    const input = {
      operation: acceptanceOperation,
      acceptanceTokenHash: "existing-store-token-hash",
      context: acceptanceContext,
    };
    const results = await Promise.all([
      acceptInvitationOperation(store, input),
      acceptInvitationOperation(store, input),
    ]);
    expect(results.map((result) => result.membershipId)).toEqual(["mbr_reserved", "mbr_reserved"]);
    expect(await store.readStream({ streamId: "identity.membership-mbr_reserved" })).toHaveLength(1);
    await expect(
      acceptInvitationOperation(store, {
        ...input,
        operation: { ...acceptanceOperation, bindingDigest: "c".repeat(64) },
      }),
    ).rejects.toThrow();
    expect(
      await store.readStream({ streamId: `identity.invitation-acceptance-${acceptanceOperation.attemptId}` }),
    ).toHaveLength(1);
  });
});
