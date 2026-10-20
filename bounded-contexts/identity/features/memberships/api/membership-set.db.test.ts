import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { productionLikeDataProfiles } from "@chase-sets/platform-runtime/api";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { module as identityModule } from "../../../index";
import { createIdentityBootstrapContext } from "../../../support/runtime-support/bootstrap-context";
import { createIdentityServices } from "../../../support/runtime-support/services";
import { seedIdentityDatabase } from "../../../support/runtime-support/seed";
import { bootstrapPlatformAdminIdentity } from "../../../support/runtime-support/production-bootstrap";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../../account-capabilities/api/authority";
import { createMembershipSetRuntime, membershipHistoryReader } from "./membership-set-cutover";
import { planMembershipSetAppends, readUserMembershipSet } from "./membership-set";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const context = createIdentityBootstrapContext();
function grant(index: number, userId = "usr_set_boundary"): AppendToStreamInput {
  const membershipId = `mbr_set_${index}`;
  return {
    streamId: `identity.membership-${membershipId}`,
    expectedVersion: 0,
    context,
    events: [
      {
        eventType: "identity.membership.granted",
        payload: { membershipId, userId, accountId: `acc_set_${index}`, roleKey: "viewer" },
      },
    ],
  };
}

(base ? describe : describe.skip)("User Membership Set PostgreSQL authority", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["identity"], "membership_set_authority");
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

  it("a competing User Set revision rolls back an otherwise new source stream", async () => {
    const store = createPostgresEventStore({ pool });
    const reader = membershipHistoryReader(pool, store);
    const first = await planMembershipSetAppends(reader, [grant(0)]);
    const racing = await planMembershipSetAppends(reader, [grant(1)]);
    await store.appendToStreams!(first);
    await expect(store.appendToStreams!(racing)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await store.readStream({ streamId: grant(1).streamId })).toEqual([]);
    expect((await readUserMembershipSet(reader, "usr_set_boundary", context.tenantId)).memberships).toHaveLength(1);
  });

  it("the production command boundary rolls back Membership when its matching Set insert fails", async () => {
    const services = createIdentityServices(pool, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    await pool.query(
      "CREATE FUNCTION reject_set_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'identity.user-membership-set.membership-recorded' THEN RAISE EXCEPTION 'synthetic Set write failure'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_set_fact BEFORE INSERT ON event_store_events FOR EACH ROW EXECUTE FUNCTION reject_set_fact()",
    );
    const input = grant(0);
    await expect(services.eventStore!.appendToStream(input)).rejects.toMatchObject({
      code: "infrastructure_failure",
      details: { cause: "synthetic Set write failure" },
    });
    expect((await pool.query("SELECT count(*)::text AS count FROM event_store_events")).rows[0].count).toBe("0");
  });

  it.each([500, 501])(
    "reconciles all %i Accounts, active/revoked state and exact revisions without projection authority",
    async (count) => {
      await bootstrapContextDatabase(identityModule, pool);
      const store = createPostgresEventStore({ pool });
      await store.appendToStreams!(Array.from({ length: count }, (_, index) => grant(index)));
      const runtime = createMembershipSetRuntime(pool, store);
      expect(await runtime.authority("usr_set_boundary", context.tenantId)).toMatchObject({
        status: "blocked-unknown",
      });
      await runtime.reconcile(context);
      const last = grant(count - 1);
      await store.appendToStreams!(
        await planMembershipSetAppends(membershipHistoryReader(pool, store), [
          { ...last, expectedVersion: 1, events: [{ eventType: "identity.membership.revoked", payload: {} }] },
        ]),
      );
      const authority = await runtime.authority("usr_set_boundary", context.tenantId);
      expect(authority.status).toBe("authoritative");
      if (authority.status !== "authoritative") throw new Error(authority.reason);
      expect(authority.memberships).toHaveLength(count);
      expect((await pool.query("SELECT count(*)::text AS count FROM identity_user_memberships")).rows[0].count).toBe(
        "0",
      );
      expect(authority.memberships.find((item) => item.membershipId === `mbr_set_${count - 1}`)).toMatchObject({
        status: "revoked",
        sourceRevision: 2,
      });
      expect(await runtime.authority("usr_zero", context.tenantId)).toMatchObject({
        status: "authoritative",
        revision: 0,
        memberships: [],
      });
      const before = await pool.query(
        "SELECT count(*)::text AS count FROM event_store_events WHERE event_type = 'identity.user-membership-set.membership-recorded'",
      );
      await runtime.reconcile(context);
      expect(
        (
          await pool.query(
            "SELECT count(*)::text AS count FROM event_store_events WHERE event_type = 'identity.user-membership-set.membership-recorded'",
          )
        ).rows,
      ).toEqual(before.rows);
    },
  );

  it("restarts after committed imports before checkpoint, includes post-checkpoint dual-writes, and never imports twice", async () => {
    const store = createPostgresEventStore({ pool });
    await store.appendToStreams!([grant(0), grant(1)]);
    let lost = false;
    const interrupted = {
      ...store,
      appendToStreams: async (inputs: readonly AppendToStreamInput[]) => {
        const result = await store.appendToStreams!(inputs);
        if (!lost && inputs.some((input) => input.streamId.startsWith("identity.user-membership-set-usr_"))) {
          lost = true;
          throw new Error("synthetic runner loss after commit");
        }
        return result;
      },
    };
    await expect(createMembershipSetRuntime(pool, interrupted).reconcile(context)).rejects.toThrow(
      "synthetic runner loss",
    );
    await store.appendToStreams!(
      await planMembershipSetAppends(membershipHistoryReader(pool, store), [
        { ...grant(0), expectedVersion: 1, events: [{ eventType: "identity.membership.revoked", payload: {} }] },
      ]),
    );
    await store.appendToStreams!(await planMembershipSetAppends(membershipHistoryReader(pool, store), [grant(2)]));
    const runtime = createMembershipSetRuntime(pool, store);
    await runtime.reconcile(context);
    await runtime.reconcile(context);
    expect(
      (await readUserMembershipSet(membershipHistoryReader(pool, store), "usr_set_boundary", context.tenantId)).facts,
    ).toHaveLength(4);
  });

  it("blocks the bypass mutant when only a post-checkpoint source fact changes", async () => {
    const store = createPostgresEventStore({ pool });
    await store.appendToStream(grant(0));
    let mutated = false;
    const bypass = {
      ...store,
      appendToStream: async (input: AppendToStreamInput) => {
        const result = await store.appendToStream(input);
        if (!mutated && input.streamId === "identity.user-membership-set-cutover") {
          mutated = true;
          await store.appendToStream(grant(1));
        }
        return result;
      },
    };
    const runtime = createMembershipSetRuntime(pool, bypass);
    await expect(runtime.reconcile(context)).rejects.toThrow("source-to-Set census mismatch");
    expect(await runtime.authority("usr_set_boundary", context.tenantId)).toMatchObject({ status: "blocked-unknown" });
    const repair = await planMembershipSetAppends(
      membershipHistoryReader(pool, store),
      [{ ...grant(1), expectedVersion: 1, events: [] }],
      { reconcile: true },
    );
    await store.appendToStreams!(repair);
    await expect(runtime.reconcile(context)).resolves.toMatchObject({ status: "authoritative" });
  });

  it("blocks truncated and poisoned histories rather than accepting a current-looking Set", async () => {
    const store = createPostgresEventStore({ pool });
    await store.appendToStreams!(Array.from({ length: 501 }, (_, index) => grant(index)));
    const capped = {
      ...store,
      readAll: async (input: Parameters<typeof store.readAll>[0]) => (await store.readAll(input)).slice(0, 499),
    };
    await expect(createMembershipSetRuntime(pool, capped).reconcile(context)).rejects.toThrow(
      "global scan count mismatch",
    );
    const runtime = createMembershipSetRuntime(pool, store);
    await runtime.reconcile(context);
    const short = {
      ...store,
      readStream: async (input: Parameters<typeof store.readStream>[0]) =>
        (await store.readStream(input)).slice(0, 499),
    };
    expect(await createMembershipSetRuntime(pool, short).authority("usr_set_boundary", context.tenantId)).toMatchObject(
      { status: "blocked-unknown" },
    );
    await store.appendToStream({
      ...grant(501),
      events: [
        {
          eventType: "identity.membership.granted",
          payload: { ...grant(501).events[0].payload, accountId: "invalid" },
        },
      ],
    });
    await expect(runtime.reconcile(context)).rejects.toThrow("MEMBERSHIP_SET_UNKNOWN");
  });

  it("production seed profiles, bootstrap and boot-twice converge through the same dual-write boundary", async () => {
    await bootstrapContextDatabase(identityModule, pool);
    const services = createIdentityServices(pool, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    const admin = {
      email: "membership-set-admin@example.test",
      displayName: "Set Administrator",
      accountName: "Set Administration",
    };
    await seedIdentityDatabase(pool, undefined, { enabledDataProfiles: productionLikeDataProfiles });
    await bootstrapPlatformAdminIdentity(services, admin);
    for (const profile of ["scenario-seed", "representative-commerce-state", "admin-qa-actor-fixtures"] as const) {
      await seedIdentityDatabase(pool, undefined, { enabledDataProfiles: [profile] });
      await services.membershipSets.reconcile(context);
      await seedIdentityDatabase(pool, undefined, { enabledDataProfiles: [profile] });
      await services.membershipSets.reconcile(context);
    }
    const original = await pool.query(
      "SELECT count(*)::text AS count FROM event_store_events WHERE event_type = 'identity.user-membership-set.membership-recorded'",
    );
    await bootstrapContextDatabase(identityModule, pool);
    await bootstrapPlatformAdminIdentity(services, admin);
    await services.membershipSets.reconcile(context);
    expect(
      (
        await pool.query(
          "SELECT count(*)::text AS count FROM event_store_events WHERE event_type = 'identity.user-membership-set.membership-recorded'",
        )
      ).rows,
    ).toEqual(original.rows);
  });
});
