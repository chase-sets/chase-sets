import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeModuleSchemaSql, syncLocalProjectionGroups } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { module as identityModule } from "../../../index";
import { createIdentityServices, type IdentityServices } from "../../../support/runtime-support/services";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../../account-capabilities/api/authority";
import { createAccountManagementRuntime, type MutationInput } from "./runtime";
import { createIdentityMutationPersistence, type IdentityMutationPersistence } from "./fences";
import { attemptStreamId } from "../domain/attempt";
import { buildIdentityApi } from "../../../api";
import { mintRegistrationConsentResolution } from "../../consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../../../support/runtime-support/registration-consent-signing";
import { bootstrapPlatformAdminIdentity } from "../../../support/runtime-support/production-bootstrap";
import { upsertApiKeySecret } from "../../api-keys/api/secret-store";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for issue #7168 DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const actor: ResolvedActor = {
  tenantId: parseTypedId("tnt_synthetic7168", "tnt"),
  userId: parseTypedId("usr_synthetic7168", "usr"),
  accountId: parseTypedId("acc_synthetic7168", "acc"),
  membershipId: parseTypedId("mbr_synthetic7168", "mbr"),
  sessionId: parseTypedId("ses_synthetic7168", "ses"),
  roleKey: "owner",
  permissions: ["accounts.manage", "security.manage", "memberships.manage"],
};
const binding = { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId };
const context: EventStoreContext = {
  tenantId: parseTypedId(actor.tenantId, "tnt"),
  audit: { performedByUserId: parseTypedId(actor.userId, "usr"), forAccountId: parseTypedId(actor.accountId, "acc") },
};
const key = "9230f01b-7871-420b-9c32-37139f80f749";
const profile: MutationInput = {
  actor,
  context,
  key,
  action: "update-profile",
  target: actor.accountId,
  body: { name: "New", displayName: "New" },
};
const address = {
  label: "Home",
  name: "Synthetic",
  line1: "1 Test St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++arrived === parties) release();
    await ready;
  };
}

describeDb("issue-7168 PostgreSQL authority", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let services: IdentityServices;
  let persistence: IdentityMutationPersistence;
  let runtime: ReturnType<typeof createAccountManagementRuntime>;
  let raw: ReturnType<typeof createPostgresEventStore>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_7168");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.identity;
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(composeModuleSchemaSql(identityModule));
    services = createIdentityServices(pool, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    raw = createPostgresEventStore({ pool });
    persistence = createIdentityMutationPersistence(pool, raw);
    runtime = createAccountManagementRuntime(persistence, services);
    await seed(`identity.account-${actor.accountId}`, "identity.account.created", {
      accountId: actor.accountId,
      name: "Old",
      displayName: "Old",
      accountType: "personal",
    });
    await seed(`identity.user-${actor.userId}`, "identity.user.created", {
      userId: actor.userId,
      displayName: "Old",
      givenName: "Old",
      familyName: "User",
      primaryEmail: "synthetic@example.test",
    });
    await seed(`identity.membership-${actor.membershipId}`, "identity.membership.granted", {
      membershipId: actor.membershipId,
      userId: actor.userId,
      accountId: actor.accountId,
      roleKey: "owner",
    });
    await seed("identity.membership-mbr_second7168", "identity.membership.granted", {
      membershipId: "mbr_second7168",
      userId: "usr_second7168",
      accountId: actor.accountId,
      roleKey: "owner",
    });
    await seed("identity.consent-cns_synthetic7168", "identity.consent.recorded", {
      consentId: "cns_synthetic7168",
      subjectType: "user",
      userId: actor.userId,
      accountId: actor.accountId,
      policyKey: "synthetic-policy",
      policyVersion: "v1",
      recordedAt: "2026-01-01T00:00:00Z",
    });
    await sync();
  });

  async function seed(streamId: string, eventType: string, payload: Record<string, unknown>) {
    return services.eventStore!.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType, payload: payload as never }],
    });
  }
  async function sync() {
    const names = [
      "identity-membership-projection",
      "identity-consent-projection",
      "identity-consent-current-state-projection",
    ];
    await syncLocalProjectionGroups(
      {
        contextName: "identity",
        module: identityModule,
        services,
        pool,
        projectionHandlerSets: services.projectors.filter((set) => names.includes(set.projectionName)),
      },
      { settleIdleCheckpoints: true },
    );
  }
  async function eventCount() {
    return Number(
      (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events")).rows[0].count,
    );
  }
  async function failEvent(eventType: string) {
    await pool.query(`CREATE FUNCTION issue7168_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = '${eventType}' THEN RAISE EXCEPTION 'synthetic atom fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER issue7168_fail BEFORE INSERT ON event_store_events FOR EACH ROW EXECUTE FUNCTION issue7168_fail()`);
  }

  it("issue-7168-ac3-atomic-replay: seven owners, exact versions, no-op and original proof after loss", async () => {
    const cases: readonly MutationInput[] = [
      profile,
      {
        ...profile,
        action: "update-user",
        target: actor.userId,
        body: { displayName: "New", givenName: "New", familyName: "User" },
      },
      { ...profile, action: "create", target: null, body: address },
      { ...profile, action: "withdraw", target: "cns_synthetic7168", body: {} },
      { ...profile, action: "create-api-key", target: null, body: { userId: actor.userId, name: "Synthetic" } },
      {
        ...profile,
        action: "create-invitation",
        target: null,
        body: {
          accountId: actor.accountId,
          invitationId: "ivt_generated7168",
          email: "invitee@example.test",
          roleKey: "viewer",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
      { ...profile, action: "change-role", target: "mbr_second7168", body: { roleKey: "viewer" } },
    ];
    for (const [index, input] of cases.entries()) {
      const request = { ...input, key: `9230f01b-7871-420b-9c32-37139f80f74${index}` };
      await sync();
      const first = await runtime.submit(request);
      expect(first.outcome).toBe("committed");
      if (first.outcome !== "committed") throw new Error("Expected commit");
      const count = await eventCount();
      const replay = await runtime.submit(request);
      expect(replay).toMatchObject({ outcome: "committed", newlyCommitted: false, receipt: first.receipt });
      expect(await eventCount()).toBe(count);
      expect(await runtime.lookup(request)).toMatchObject({ outcome: "committed", receipt: first.receipt });
      expect(first.receipt.events).toHaveLength(first.receipt.committedVersion - first.receipt.priorVersion);
    }
    const noOp = await runtime.submit({ ...profile, key: "f230f01b-7871-420b-9c32-37139f80f749" });
    expect(noOp).toMatchObject({
      outcome: "committed",
      receipt: { priorVersion: 2, committedVersion: 2, events: [], result: { changed: false } },
    });
    await runtime.submit({
      ...profile,
      key: "a230f01b-7871-420b-9c32-37139f80f749",
      body: { name: "Later", displayName: "Later" },
    });
    expect(await runtime.lookup({ ...profile, key: cases[0].key.replace(/.$/, "0") })).toMatchObject({
      outcome: "committed",
      receipt: { committedVersion: 2 },
      current: { version: 3 },
    });
  });

  it("issue-7168-ac11-caller-compatibility: fenced production registration rolls back on second Consent and converges; boot twice is authoritative", async () => {
    const app = buildIdentityApi(services);
    const body = {
      email: "synthetic-registration7168@example.test",
      displayName: "Synthetic Registration7168",
      registrationConsent: {
        affirmed: true,
        resolution: mintRegistrationConsentResolution({
          requirements: [
            { policyKey: "synthetic-first7168", version: "v1", href: "/terms" },
            { policyKey: "synthetic-second7168", version: "v1", href: "/privacy" },
          ],
          resolvedAt: new Date().toISOString(),
          signingKeys: resolveRegistrationConsentSigningKeys(),
        }),
      },
    };
    const register = () =>
      app.request("/internal/auth/personal-identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const count = await eventCount();
    await pool.query(`CREATE FUNCTION issue7168_registration_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'identity.consent.recorded' AND NEW.payload->>'policyKey' = 'synthetic-second7168' THEN RAISE EXCEPTION 'synthetic second Consent failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER issue7168_registration_fail BEFORE INSERT ON event_store_events FOR EACH ROW EXECUTE FUNCTION issue7168_registration_fail()`);
    expect((await register()).status).toBe(500);
    expect(await eventCount()).toBe(count);
    expect(
      (
        await pool.query(
          "SELECT account_id FROM identity_account_display_name_reservations WHERE display_name_key = 'synthetic registration7168'",
        )
      ).rows,
    ).toHaveLength(0);
    await pool.query("DROP TRIGGER issue7168_registration_fail ON event_store_events");
    expect((await register()).status).toBe(201);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM event_store_events WHERE event_type = 'identity.consent.recorded' AND payload->>'policyKey' LIKE 'synthetic-%7168'",
        )
      ).rows,
    ).toHaveLength(2);
    const config = {
      email: "synthetic-bootstrap7168@example.test",
      displayName: "Synthetic Bootstrap7168",
      accountName: "Synthetic Platform7168",
    };
    await bootstrapPlatformAdminIdentity(services, config);
    const bootCount = await eventCount();
    expect(await bootstrapPlatformAdminIdentity(services, config)).toMatchObject({
      createdAccount: false,
      createdUser: false,
      createdMembership: false,
    });
    expect(await eventCount()).toBe(bootCount);
  });

  it("issue-7168-ac4-concurrency: withdrawal and superseding direct record share a subject-policy fence", async () => {
    const recordStream = "identity.consent-cns_raced7168";
    const scopes = [JSON.stringify(["identity", actor.tenantId, "consent", "user", actor.userId, "synthetic-policy"])];
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const withdraw = createAccountManagementRuntime(
      {
        ...persistence,
        transaction: (keys, work) =>
          persistence.transaction(keys, async (tx) => {
            if (keys.length) {
              expect(keys).toEqual(scopes);
              entered();
              await held;
            }
            return work(tx);
          }),
      },
      services,
    );
    const withdrawing = withdraw.submit({ ...profile, action: "withdraw", target: "cns_synthetic7168", body: {} });
    await ready;
    let recordFinished = false;
    const recording = seed(recordStream, "identity.consent.recorded", {
      consentId: "cns_raced7168",
      subjectType: "user",
      userId: actor.userId,
      accountId: actor.accountId,
      policyKey: "synthetic-policy",
      policyVersion: "v2",
      recordedAt: "2026-02-01T00:00:00Z",
    }).then(() => {
      recordFinished = true;
    });
    try {
      // PostgreSQL's own lock census proves the writer reached the held fence.
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ waiting: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted) AS waiting",
              )
            ).rows[0].waiting,
          { interval: 10, timeout: 1000 },
        )
        .toBe(true);
      expect(recordFinished).toBe(false);
    } finally {
      release();
    }
    expect(await withdrawing).toMatchObject({ outcome: "committed" });
    await recording;
    await sync();
    expect(
      await runtime.submit({
        ...profile,
        key: "f230f01b-7871-420b-9c32-37139f80f749",
        action: "withdraw",
        target: "cns_synthetic7168",
        body: {},
      }),
    ).toMatchObject({ outcome: "conflict", code: "current-consent" });
    expect(await runtime.lookup({ ...profile, action: "withdraw", target: "cns_synthetic7168" })).toMatchObject({
      outcome: "committed",
    });
  });

  it("issue-7168-ac5-history: all fifteen intents retain their no-op and terminal decisions", async () => {
    let ordinal = 0;
    async function submit(action: string, target: string | null, body: unknown = {}) {
      await sync();
      return runtime.submit({
        ...profile,
        action,
        target,
        body,
        key: `9230f01b-7871-420b-9c32-${String(++ordinal).padStart(12, "0")}`,
      });
    }
    async function noOp(action: string, target: string, body: unknown = {}) {
      const result = await submit(action, target, body);
      expect(result).toMatchObject({ outcome: "committed", receipt: { events: [], result: { changed: false } } });
    }
    await noOp("update-profile", actor.accountId, { name: "Old", displayName: "Old" });
    await noOp("update-user", actor.userId, { displayName: "Old", givenName: "Old", familyName: "User" });
    const added = await submit("create", null, address);
    if (added.outcome !== "committed") throw new Error("Expected address commit");
    const adr = added.receipt.result.id;
    await noOp("update", adr, address);
    await noOp("default", adr);
    expect(await submit("archive", adr)).toMatchObject({ outcome: "committed" });
    await noOp("archive", adr);
    expect(await submit("default", adr)).toMatchObject({ outcome: "conflict" });
    expect(await submit("withdraw", "cns_synthetic7168")).toMatchObject({ outcome: "committed" });
    await noOp("withdraw", "cns_synthetic7168");
    const created = await submit("create-api-key", null, { userId: actor.userId, name: "Synthetic" });
    if (created.outcome !== "committed") throw new Error("Expected key commit");
    const keyId = created.receipt.result.id;
    expect(await submit("rotate-api-key", keyId)).toMatchObject({ outcome: "committed" });
    expect(await submit("revoke-api-key", keyId)).toMatchObject({ outcome: "committed" });
    await noOp("revoke-api-key", keyId);
    expect(await submit("rotate-api-key", keyId)).toMatchObject({ outcome: "conflict" });
    const invitation = await submit("create-invitation", null, {
      accountId: actor.accountId,
      invitationId: "ivt_synthetic7168",
      email: "invitee@example.test",
      roleKey: "viewer",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    if (invitation.outcome !== "committed") throw new Error("Expected invitation commit");
    expect(await submit("cancel-invitation", invitation.receipt.result.id)).toMatchObject({ outcome: "committed" });
    await noOp("cancel-invitation", invitation.receipt.result.id);
    await noOp("change-role", "mbr_second7168", { roleKey: "owner" });
    expect(await submit("reinstate", "mbr_second7168")).toMatchObject({ outcome: "conflict" });
    expect(await submit("change-role", "mbr_second7168", { roleKey: "viewer" })).toMatchObject({
      outcome: "committed",
    });
    expect(await submit("revoke", "mbr_second7168")).toMatchObject({ outcome: "committed" });
    await noOp("revoke", "mbr_second7168");
    expect(await submit("reinstate", "mbr_second7168")).toMatchObject({ outcome: "committed" });
    await noOp("reinstate", "mbr_second7168");
    expect(await submit("change-role", "mbr_second7168", { roleKey: "owner" })).toMatchObject({ outcome: "committed" });
    await noOp("reinstate", "mbr_second7168");
    for (const terminal of ["accepted", "declined", "expired"] as const) {
      const id = `ivt_${terminal}7168`;
      await seed(`identity.invitation-${id}`, "identity.invitation.created", {
        invitationId: id,
        accountId: actor.accountId,
        email: "invitee@example.test",
        roleKey: "viewer",
        expiresAt: "2099-01-01T00:00:00Z",
      });
      await services.eventStore!.appendToStream({
        streamId: `identity.invitation-${id}`,
        expectedVersion: 1,
        context,
        events: [
          {
            eventType: `identity.invitation.${terminal}`,
            payload: terminal === "accepted" ? { userId: actor.userId, acceptedAt: "2026-01-01T00:00:00Z" } : {},
          },
        ],
      });
      expect(await submit("cancel-invitation", id)).toMatchObject({ outcome: "conflict" });
    }
  });

  it.each([
    ["update-profile", actor.accountId, { name: "New", displayName: "New" }, "identity.account.profile-updated"],
    [
      "update-user",
      actor.userId,
      { displayName: "New", givenName: "New", familyName: "User" },
      "identity.user.profile-updated",
    ],
    ["create", null, address, "identity.shipping-address.added"],
    ["withdraw", "cns_synthetic7168", {}, "identity.consent.withdrawn"],
    ["create-api-key", null, { userId: actor.userId, name: "Synthetic" }, "identity.api-key.verifier-recorded"],
    [
      "create-invitation",
      null,
      {
        accountId: actor.accountId,
        invitationId: "ivt_synthetic7168",
        email: "invitee@example.test",
        roleKey: "viewer",
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "identity.invitation.created",
    ],
    ["change-role", "mbr_second7168", { roleKey: "viewer" }, "identity.membership.role-changed"],
  ] as const)(
    "issue-7168-ac3-atomic-replay: %s rejects split/business-only rollback mutants",
    async (action, target, body, failedType) => {
      const before = await eventCount();
      await failEvent(failedType);
      const request = { ...profile, action, target, body };
      expect(await runtime.submit(request)).toMatchObject({ outcome: "indeterminate" });
      expect(await eventCount()).toBe(before);
      expect(await runtime.lookup(request)).toEqual({ outcome: "not-recorded", code: "not-recorded" });
    },
  );

  it.each(["identity.account.profile-updated", "identity.account-management-mutation-attempt.committed"])(
    "issue-7168-ac3-atomic-replay: rolls back both sides when %s fails",
    async (eventType) => {
      const count = await eventCount();
      await failEvent(eventType);
      expect(await runtime.submit(profile)).toMatchObject({ outcome: "indeterminate" });
      expect(await eventCount()).toBe(count);
      expect(await runtime.lookup(profile)).toEqual({ outcome: "not-recorded", code: "not-recorded" });
    },
  );

  it("issue-7168-ac6-api-key-secret: verifier failure rolls back business and receipt; replay/revoke never reveal plaintext", async () => {
    const request = {
      ...profile,
      action: "create-api-key",
      target: null,
      body: { userId: actor.userId, name: "Synthetic" },
    };
    const before = await eventCount();
    await pool.query(`CREATE FUNCTION issue7168_secret_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic secret fault'; END $$;
      CREATE TRIGGER issue7168_secret_fail BEFORE INSERT ON identity_api_key_secrets FOR EACH ROW EXECUTE FUNCTION issue7168_secret_fail()`);
    expect(await runtime.submit(request)).toMatchObject({ outcome: "indeterminate" });
    expect(await eventCount()).toBe(before);
    await pool.query("DROP TRIGGER issue7168_secret_fail ON identity_api_key_secrets");
    const first = await runtime.submit(request);
    if (first.outcome !== "committed" || !first.secret) throw new Error("Expected first secret");
    const replay = await runtime.submit(request);
    expect(replay).toMatchObject({ outcome: "committed", secretState: "committed-secret-unrecoverable" });
    expect(JSON.stringify(replay)).not.toContain(first.secret);
    const stored = await pool.query<{ payload: unknown }>(
      "SELECT payload FROM event_store_events WHERE stream_id = ANY($1::text[])",
      [[first.receipt.owner, attemptStreamId(binding, key)]],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(first.secret);
    const verifier = await pool.query<{ secret_hash: string }>(
      "SELECT secret_hash FROM identity_api_key_secrets WHERE api_key_id = $1",
      [first.receipt.result.id],
    );
    expect(verifier.rows[0].secret_hash).toBe(services.auth.hashSecret(first.secret));
    expect(
      await runtime.submit({
        ...profile,
        key: "f230f01b-7871-420b-9c32-37139f80f749",
        action: "revoke-api-key",
        target: first.receipt.result.id,
        body: {},
      }),
    ).toMatchObject({ outcome: "committed" });
    expect((await pool.query("SELECT api_key_id FROM identity_api_key_secrets")).rows).toHaveLength(0);
    const revokedCount = await eventCount();
    expect(
      await runtime.submit({
        ...profile,
        key: "e230f01b-7871-420b-9c32-37139f80f749",
        action: "rotate-api-key",
        target: first.receipt.result.id,
        body: {},
      }),
    ).toMatchObject({ outcome: "conflict", code: "owner-state-conflict", current: { status: "revoked" } });
    expect(await eventCount()).toBe(revokedCount);
  });

  it("issue-7168-ac6-api-key-secret: late legacy verifier writes cannot replace a newer keyed or legacy rotation", async () => {
    const first = await runtime.submit({
      ...profile,
      action: "create-api-key",
      target: null,
      body: { userId: actor.userId, name: "Synthetic delayed verifier" },
    });
    if (first.outcome !== "committed" || !first.secret) throw new Error("Expected first secret");
    const id = parseTypedId(first.receipt.result.id, "key");
    const legacySecret = `${first.secret.slice(0, 12)}synthetic-new-secret`;
    const legacyHash = services.auth.hashSecret(legacySecret);
    const legacy = await services.apiKeys.commandHandler({
      streamId: first.receipt.owner,
      context,
      command: { type: "RotateApiKey", keyPrefix: legacySecret.slice(0, 12), secretHash: legacyHash },
    });
    expect(legacy.state.verifierHash).toBe(legacyHash);
    await upsertApiKeySecret(pool, {
      apiKeyId: id,
      userId: actor.userId,
      keyPrefix: legacySecret.slice(0, 12),
      secretHash: legacyHash,
      expectedVersion: legacy.version,
    });
    await upsertApiKeySecret(pool, {
      apiKeyId: id,
      userId: actor.userId,
      keyPrefix: first.secret.slice(0, 12),
      secretHash: services.auth.hashSecret(first.secret),
      expectedVersion: first.receipt.committedVersion,
    });
    async function verifierHash() {
      return (
        await pool.query<{ secret_hash: string }>(
          "SELECT secret_hash FROM identity_api_key_secrets WHERE api_key_id = $1",
          [id],
        )
      ).rows[0]?.secret_hash;
    }
    expect(await verifierHash()).toBe(legacyHash);
    const rotated = await runtime.submit({
      ...profile,
      key: "f230f01b-7871-420b-9c32-37139f80f749",
      action: "rotate-api-key",
      target: id,
      body: {},
    });
    if (rotated.outcome !== "committed" || !rotated.secret) throw new Error("Expected rotated secret");
    await upsertApiKeySecret(pool, {
      apiKeyId: id,
      userId: actor.userId,
      keyPrefix: legacySecret.slice(0, 12),
      secretHash: legacyHash,
      expectedVersion: legacy.version,
    });
    expect(await verifierHash()).toBe(services.auth.hashSecret(rotated.secret));
    expect(await runtime.lookup({ ...profile, action: "create-api-key", target: null })).toMatchObject({
      outcome: "committed",
      secretState: "committed-secret-unrecoverable",
    });
  });

  it("issue-7168-ac4-concurrency: same-key loser reloads once; different-key loser does not redecide", async () => {
    async function race(sameKey: boolean) {
      const arrive = barrier(2);
      const observed: IdentityMutationPersistence = {
        ...persistence,
        transaction: async (scopes, work) => {
          await arrive();
          return persistence.transaction(scopes, work);
        },
      };
      const raced = createAccountManagementRuntime(observed, services);
      return Promise.all([
        raced.submit(profile),
        raced.submit({ ...profile, key: sameKey ? key : "f230f01b-7871-420b-9c32-37139f80f749" }),
      ]);
    }
    const same = await race(true);
    expect(same).toMatchObject([{ outcome: "committed" }, { outcome: "committed" }]);
    expect(same.filter((result) => result.outcome === "committed" && result.newlyCommitted)).toHaveLength(1);
    // A new target read/version for each contender; the previously recorded receipt is not involved.
    const arrive = barrier(2);
    const observed: IdentityMutationPersistence = {
      ...persistence,
      transaction: async (scopes, work) => {
        await arrive();
        return persistence.transaction(scopes, work);
      },
    };
    const raced = createAccountManagementRuntime(observed, services);
    const different = await Promise.all(
      ["a230f01b-7871-420b-9c32-37139f80f749", "b230f01b-7871-420b-9c32-37139f80f749"].map((attempt) =>
        raced.submit({ ...profile, key: attempt, body: { name: attempt.slice(0, 1), displayName: "Raced" } }),
      ),
    );
    expect(different.filter((result) => result.outcome === "committed")).toHaveLength(1);
    expect(different.filter((result) => result.outcome === "conflict")).toHaveLength(1);
  });

  it("issue-7168-ac4-concurrency: mixed legacy/participant owner removal retains one and a closed Account permits teardown", async () => {
    const arrive = barrier(2);
    const participant: IdentityMutationPersistence = {
      ...persistence,
      transaction: async (scopes, work) => {
        await arrive();
        return persistence.transaction(scopes, work);
      },
    };
    const raced = createAccountManagementRuntime(participant, services);
    const legacy = async () => {
      await arrive();
      return services.memberships.commandHandler({
        streamId: `identity.membership-${actor.membershipId}`,
        context,
        command: { type: "RevokeMembership" },
      });
    };
    const results = await Promise.allSettled([
      raced.submit({ ...profile, action: "revoke", target: "mbr_second7168", body: {} }),
      legacy(),
    ]);
    expect(results).toHaveLength(2);
    await sync();
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM identity_memberships WHERE account_id = $1 AND role_key = 'owner' AND status = 'active'",
          [actor.accountId],
        )
      ).rows[0].count,
    ).toBe("1");
    await services.eventStore!.appendToStream({
      streamId: `identity.account-${actor.accountId}`,
      expectedVersion: 1,
      context,
      events: [{ eventType: "identity.account.closed", payload: {} }],
    });
    const remaining = (
      await pool.query<{ membership_id: string }>(
        "SELECT membership_id FROM identity_memberships WHERE status = 'active' AND role_key = 'owner'",
      )
    ).rows[0].membership_id;
    expect(
      await runtime.submit({
        ...profile,
        key: "d230f01b-7871-420b-9c32-37139f80f749",
        action: "revoke",
        target: remaining,
        body: {},
      }),
    ).toMatchObject({ outcome: "committed" });
  });

  it("issue-7168-ac5-history: superseded withdrawn Consent refuses a new no-op but original receipt replays", async () => {
    const request = { ...profile, action: "withdraw", target: "cns_synthetic7168", body: {} };
    const first = await runtime.submit(request);
    expect(first.outcome).toBe("committed");
    await seed("identity.consent-cns_later7168", "identity.consent.recorded", {
      consentId: "cns_later7168",
      subjectType: "user",
      userId: actor.userId,
      accountId: actor.accountId,
      policyKey: "synthetic-policy",
      policyVersion: "v2",
      recordedAt: "2026-02-01T00:00:00Z",
    });
    await sync();
    const count = await eventCount();
    expect(await runtime.submit({ ...request, key: "f230f01b-7871-420b-9c32-37139f80f749" })).toMatchObject({
      outcome: "conflict",
      code: "current-consent",
      current: { id: "cns_synthetic7168", status: "withdrawn" },
    });
    expect(await runtime.submit(request)).toMatchObject({ outcome: "committed", newlyCommitted: false });
    expect(await eventCount()).toBe(count);
  });

  it.each(["checkpoint", "recovery", "generation", "incomplete", "ignored-poison"])(
    "issue-7168-ac5-history: %s never supplies eligibility authority",
    async (defect) => {
      const projection = "identity-membership-projection";
      const checkpoint = `${projection}:identity:v1`;
      if (defect === "checkpoint")
        await pool.query(
          "UPDATE event_subscription_checkpoints SET last_global_position = 0 WHERE checkpoint_key = $1",
          [checkpoint],
        );
      if (defect === "recovery")
        await pool.query("DELETE FROM event_projection_recovery_markers WHERE projection_key = $1", [checkpoint]);
      if (defect === "generation")
        await pool.query("UPDATE event_projection_group_generations SET state = 'failed' WHERE projection_name = $1", [
          projection,
        ]);
      if (defect === "incomplete")
        await pool.query("UPDATE event_subscription_applications SET status = 'started' WHERE projection_key = $1", [
          checkpoint,
        ]);
      if (defect === "ignored-poison")
        await pool.query(
          `INSERT INTO event_projection_poison_events (projection_key,event_id,projection_name,projection_kind,stream_id,stream_version,event_type,global_position,failure_kind,error_message,state,first_seen_at,last_seen_at)
      VALUES ($1,'evt_synthetic_poison',$2,'subscription','identity.membership-mbr_second7168',1,'identity.membership.granted',1,'poison','synthetic','ignored',now(),now())`,
          [checkpoint, projection],
        );
      const count = await eventCount();
      expect(await runtime.submit({ ...profile, action: "revoke", target: "mbr_second7168", body: {} })).toEqual({
        outcome: "indeterminate",
        code: "INDETERMINATE",
      });
      expect(await eventCount()).toBe(count);
    },
  );

  it("issue-7168-ac5-history: complete 500/501 pages, truncated head and attempt 0/1/2", async () => {
    await raw.appendToStream({
      streamId: `identity.account-${actor.accountId}`,
      expectedVersion: 1,
      context,
      events: Array.from({ length: 500 }, (_, index) => ({
        eventType: "identity.account.profile-updated",
        payload: { name: `Name ${index}`, displayName: "Synthetic" },
      })),
    });
    const first = await runtime.submit(profile);
    expect(first).toMatchObject({ outcome: "committed", receipt: { priorVersion: 501, committedVersion: 502 } });
    expect(await runtime.lookup({ ...profile, key: "f230f01b-7871-420b-9c32-37139f80f749" })).toMatchObject({
      outcome: "not-recorded",
    });
    const streamId = attemptStreamId(binding, key);
    const receipt = await raw.readStream({ streamId });
    await raw.appendToStream({
      streamId,
      expectedVersion: 1,
      context,
      events: [{ eventType: receipt[0].eventType, payload: receipt[0].payload }],
    });
    expect(await runtime.lookup(profile)).toMatchObject({ outcome: "indeterminate" });
    await pool.query("DELETE FROM event_store_events WHERE stream_id = $1 AND stream_version = 502", [
      `identity.account-${actor.accountId}`,
    ]);
    expect(await runtime.submit({ ...profile, key: "a230f01b-7871-420b-9c32-37139f80f749" })).toMatchObject({
      outcome: "indeterminate",
    });
  });
});
