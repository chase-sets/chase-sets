import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_GUEST_CHECKOUT_COOKIE_NAME,
  AUTH_SESSION_COOKIE_NAME,
  type ResolvedActor,
} from "@chase-sets/auth-context";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  resetProjectionGroup,
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
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as identityModule } from "@chase-sets/identity";
import { parseCapabilityAdministrationAuthority } from "@chase-sets/identity/server";
import { module as authModule } from "../../index";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import { AUTH_BOOTSTRAP_TENANT_ID } from "../auth-support/constants";
import {
  buildAuthIdentityAccountCapabilityProjectionHandlers,
  buildAuthIdentityAccountProjectionHandlers,
  buildAuthIdentityMembershipProjectionHandlers,
  buildAuthIdentityUserProjectionHandlers,
} from "../auth-support/identity-projection";
import { upsertGuestCheckoutToken } from "../auth-support/store";
import { resolveActorFromRequest } from "./runtime";
import { createAuthServices, startInteractiveAuth, type AuthServices } from "./services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

// Every identity below is synthetic and exists only inside this file.
const KEY = "support.evidence.any-case";
const ADMINISTRATOR = "usr_synthetic_capability_admin";
const USER = "usr_synthetic_capability_holder";
const UNVERIFIED_USER = "usr_synthetic_capability_unverified";
const ACCOUNT = "acc_synthetic_capability_granted";
const OTHER = "acc_synthetic_capability_other";
const MEMBERSHIP = "mbr_synthetic_capability_granted";
const future = () => new Date(Date.now() + 60 * 60_000).toISOString();
const authContext = {
  tenantId: AUTH_BOOTSTRAP_TENANT_ID,
  audit: { performedByUserId: USER, forAccountId: ACCOUNT },
} as unknown as EventStoreContext;
const registry = [
  { owningContext: "platform-operations", key: KEY, description: "Synthetic", kind: "boolean", defaultValue: false },
] as const;

describeDb("Auth projection of Identity Capability Grants", () => {
  let pools: Readonly<Record<"identity" | "auth", PgTransactionalPool>>;
  let auth: AuthServices;
  let identity: ReturnType<typeof identityModule.createServices>;
  let administrator: ResolvedActor;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity", "auth"], "auth_capability_grants");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(authModule, pools.auth);
    await syncContextProjectionGroups(mountedRuntime(), "auth", { requiredOnly: true });
    auth = createAuthServices(pools.auth);
    const deploymentInstance = '["support-deployment-instance/v1","synthetic","auth-capability"]';
    identity = identityModule.createServices(pools.identity, {
      capabilityAdministrationAuthority: parseCapabilityAdministrationAuthority(
        JSON.stringify({
          version: 1,
          environment: "test",
          deploymentInstance,
          authorityId: "synthetic-auth-projection",
          revision: 1,
          adminUserIds: [ADMINISTRATOR],
        }),
        { environment: "test", deploymentInstance, implementationSha: "0".repeat(40) },
      ),
      accountCapabilityRegistry: registry,
    });
    await identity.accountCapabilities.initializeAdministrationAuthority();
    await projectUser(ADMINISTRATOR, true);
    await projectUser(USER, true);
    await projectUser(UNVERIFIED_USER, false);
    for (const accountId of [ACCOUNT, OTHER]) {
      await projectAccount(accountId);
      await identity.eventStore!.appendToStream({
        streamId: `identity.account-${accountId}`,
        expectedVersion: "no_stream",
        context: authContext,
        events: [
          {
            eventType: "identity.account.created",
            payload: { accountId, name: accountId, displayName: accountId, accountType: "business" },
          },
        ],
      });
    }
    await projectMembership(MEMBERSHIP, USER, ACCOUNT);
    await projectMembership("mbr_synthetic_capability_other", USER, OTHER);
    await projectMembership("mbr_synthetic_capability_unverified", UNVERIFIED_USER, ACCOUNT);
    await projectMembership("mbr_synthetic_capability_admin", ADMINISTRATOR, ACCOUNT);
    const resolved = await resolve(await signIn(ADMINISTRATOR, ACCOUNT));
    if (!resolved) throw new Error("Synthetic administrator must resolve an active human Session.");
    administrator = resolved;
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("stores the projection as an unlogged table keyed by tenant, Account and key", async () => {
    const result = await pools.auth.query<{ relpersistence: string; key: string }>(
      `SELECT c.relpersistence, pg_get_indexdef(i.indexrelid) AS key
       FROM pg_class c JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
       WHERE c.relname = 'auth_identity_account_capabilities'`,
    );
    expect(result.rows).toEqual([
      { relpersistence: "u", key: expect.stringContaining("(tenant_id, account_id, capability_key)") },
    ]);
  });

  it("gains and loses the key on the next request after projection commit while in-flight snapshots stay", async () => {
    const cookie = await signIn(USER, ACCOUNT);
    const writes = await sessionWrites();
    const before = await resolve(cookie);
    expect(before).not.toHaveProperty("capabilityAssignments");

    const granted = await grant(0);
    // Committed in Identity but not yet projected: the next request still carries nothing.
    expect(await resolve(cookie)).not.toHaveProperty("capabilityAssignments");
    await drain();
    const holding = await resolve(cookie);
    const holdingSnapshot = structuredClone(holding);
    expect(holding?.capabilityAssignments).toEqual([{ key: KEY, assignmentId: granted.assignmentId, version: 1 }]);

    await revoke(1);
    await drain();
    expect(await resolve(cookie)).not.toHaveProperty("capabilityAssignments");
    expect(holding).toEqual(holdingSnapshot);
    expect(before).not.toHaveProperty("capabilityAssignments");

    await grant(2);
    await drain();
    expect((await resolve(cookie))?.capabilityAssignments).toEqual([
      { key: KEY, assignmentId: granted.assignmentId, version: 3 },
    ]);
    // Grant changes never mint, extend or rewrite a Session.
    expect(await sessionWrites()).toEqual(writes);
  });

  it("never carries one Account's grant across an account switch", async () => {
    await grant(0);
    await drain();
    const cookie = await signIn(USER, ACCOUNT);
    expect((await resolve(cookie))?.capabilityAssignments).toHaveLength(1);

    await switchAccount(cookie.sessionId, OTHER);
    const switched = await resolve(cookie);
    expect(switched).toMatchObject({ accountId: OTHER, sessionId: cookie.sessionId });
    expect(switched).not.toHaveProperty("capabilityAssignments");

    await switchAccount(cookie.sessionId, ACCOUNT);
    expect((await resolve(cookie))?.capabilityAssignments).toHaveLength(1);
  });

  it("does not surface a grant recorded under another tenant", async () => {
    // Bypass mutant: dropping tenant_id from the grant lookup would surface this grant.
    const otherTenant = "tnt_synthetic_other";
    await buildAuthIdentityAccountCapabilityProjectionHandlers(pools.auth)["identity.account-capability.granted"]!(
      buildTransportEvent(
        "identity.account-capability.granted",
        {
          tenantId: otherTenant,
          accountId: ACCOUNT,
          capabilityKey: KEY,
          assignmentId: "acap_synthetic_other_tenant",
          version: 1,
        },
        { tenantId: otherTenant },
      ),
    );
    await drain();

    expect(await resolve(await signIn(USER, ACCOUNT))).not.toHaveProperty("capabilityAssignments");
  });

  it("keeps membership, unverified-email, guest and agent restrictions", async () => {
    await grant(0);
    await drain();
    const holder = await signIn(USER, ACCOUNT);
    const unverified = await signIn(UNVERIFIED_USER, ACCOUNT);
    await upsertGuestCheckoutToken(auth.db, {
      tokenId: "gct_synthetic_capability",
      accountId: ACCOUNT,
      contactEmail: null,
      contactName: null,
      tokenHash: auth.auth.hashSecret("guest-synthetic-capability"),
      expiresAt: future(),
    });

    const unverifiedActor = await resolve(unverified);
    expect(unverifiedActor).toMatchObject({ userId: UNVERIFIED_USER, accountId: ACCOUNT });
    expect(unverifiedActor).not.toHaveProperty("capabilityAssignments");

    const guest = await resolveActorFromRequest(
      auth,
      new Request("https://synthetic.test/", {
        headers: { cookie: `${AUTH_GUEST_CHECKOUT_COOKIE_NAME}=guest-synthetic-capability` },
      }),
    );
    expect(guest).toMatchObject({ roleKey: "guest-buyer", accountId: ACCOUNT });
    expect(guest).not.toHaveProperty("capabilityAssignments");

    const agent = await resolveActorFromRequest(
      auth,
      new Request("https://synthetic.test/", { headers: { authorization: "Bearer ucp_at_synthetic_capability" } }),
      {
        linkedPlatformAuthorizations: {
          resolveAccessToken: async () => ({
            authorization_id: "lpa_synthetic_capability",
            platform_profile_url: "https://agent.example/.well-known/ucp",
            user_id: USER,
            account_id: ACCOUNT,
            scopes: ["support:read"],
          }),
        },
      },
    );
    expect(agent?.agentGrant).toBeDefined();
    expect(agent).not.toHaveProperty("capabilityAssignments");

    await buildAuthIdentityMembershipProjectionHandlers(pools.auth)["identity.membership.revoked"]!(
      buildTransportEvent("identity.membership.revoked", {}, { streamId: `identity.membership-${MEMBERSHIP}` }),
    );
    expect(await resolve(holder)).toBeNull();
  });

  it("converges after revoke/regrant replay and ignores delayed older events", async () => {
    await grant(0);
    await revoke(1);
    await grant(2);
    await drain();
    const converged = await projectedRows();
    expect(converged).toEqual([
      { tenant_id: AUTH_BOOTSTRAP_TENANT_ID, account_id: ACCOUNT, capability_key: KEY, version: 3, status: "granted" },
    ]);

    // A delayed, re-delivered revoke at version 2 must not shadow the version-3 regrant.
    const assignment = await identity.accountCapabilities.loadAccountCapabilityAssignment({
      tenantId: AUTH_BOOTSTRAP_TENANT_ID,
      accountId: ACCOUNT,
      capabilityKey: KEY,
    });
    await buildAuthIdentityAccountCapabilityProjectionHandlers(pools.auth)["identity.account-capability.revoked"]!(
      buildTransportEvent(
        "identity.account-capability.revoked",
        {
          tenantId: AUTH_BOOTSTRAP_TENANT_ID,
          accountId: ACCOUNT,
          capabilityKey: KEY,
          assignmentId: assignment.status === "absent" ? "missing" : assignment.assignmentId,
          version: 2,
        },
        { tenantId: AUTH_BOOTSTRAP_TENANT_ID },
      ),
    );
    expect(await projectedRows()).toEqual(converged);

    const runtime = mountedRuntime();
    const group = runtime.projectionGroups.find(
      ({ projectionName }) => projectionName === "auth-identity-account-capability-projection",
    )!;
    // The group resets replay-only (checkpoints, not rows), so simulate projection loss to prove rebuild from empty.
    await pools.auth.query("TRUNCATE TABLE auth_identity_account_capabilities");
    const revisionSyncToken = await resetProjectionGroup(group);
    expect(await projectedRows()).toEqual([]);
    await drainContextRuntime({ subscriptionRunners: group.subscriptionRunners });
    await group.markRevisionSynced(revisionSyncToken);
    expect(await projectedRows()).toEqual(converged);
  });

  function mountedRuntime() {
    return createMountedContextTestRuntime([
      {
        contextName: "identity",
        mountRole: "source-only",
        module: identityModule,
        pool: pools.identity,
        ports: { capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" } },
      },
      { contextName: "auth", module: authModule, pool: pools.auth, ports: {} },
    ]);
  }
  async function drain() {
    await drainContextRuntime(mountedRuntime());
  }
  function identityContext() {
    return {
      tenantId: AUTH_BOOTSTRAP_TENANT_ID,
      audit: { performedByUserId: ADMINISTRATOR, forAccountId: ACCOUNT },
    } as unknown as EventStoreContext;
  }
  function request(expectedVersion: number) {
    return {
      accountId: ACCOUNT,
      capabilityKey: KEY,
      expectedVersion,
    };
  }
  async function grant(expectedVersion: number) {
    const result = await identity.accountCapabilities.attemptAccountCapabilityAssignment(
      "grant",
      administrator,
      request(expectedVersion),
      identityContext(),
    );
    if (result.state.status !== "granted") throw new Error("Synthetic grant must leave the assignment granted.");
    return result.state;
  }
  async function revoke(expectedVersion: number) {
    await identity.accountCapabilities.attemptAccountCapabilityAssignment(
      "revoke",
      administrator,
      request(expectedVersion),
      identityContext(),
    );
  }
  async function signIn(userId: string, accountId: string) {
    const result = await startInteractiveAuth(auth, {
      userId,
      accountId,
      authenticationMethod: "password",
      context: authContext,
    });
    if (result.type !== "session-started") throw new Error("Synthetic fixture must start a Session.");
    await drain();
    return { sessionId: result.sessionId, token: result.sessionToken };
  }
  async function switchAccount(sessionId: string, accountId: string) {
    await auth.sessions.commandHandler({
      streamId: toSessionStreamId(sessionId),
      command: { type: "SwitchSessionAccount", accountId: accountId as never },
      context: authContext,
    });
    await drain();
  }
  async function resolve(cookie: Readonly<{ token: string }>): Promise<ResolvedActor | null> {
    return resolveActorFromRequest(
      auth,
      new Request("https://synthetic.test/", { headers: { cookie: `${AUTH_SESSION_COOKIE_NAME}=${cookie.token}` } }),
    );
  }
  async function sessionWrites() {
    const result = await pools.auth.query<{ events: number; tokens: number; sessions: string }>(
      `SELECT (SELECT count(*)::int FROM event_store_events WHERE event_type LIKE 'auth.session.%') AS events,
              (SELECT count(*)::int FROM identity_session_tokens) AS tokens,
              (SELECT string_agg(session_id || ':' || account_id || ':' || expires_at::text, ',' ORDER BY session_id)
                 FROM identity_sessions) AS sessions`,
    );
    return result.rows[0];
  }
  async function projectedRows() {
    const result = await pools.auth.query(
      `SELECT tenant_id, account_id, capability_key, version, status
       FROM auth_identity_account_capabilities ORDER BY tenant_id, account_id, capability_key`,
    );
    return result.rows;
  }
  async function projectUser(userId: string, verified: boolean) {
    const email = `${userId}@chasesets.test`;
    await buildAuthIdentityUserProjectionHandlers(pools.auth)["identity.user.created"]!(
      buildTransportEvent(
        "identity.user.created",
        {
          userId,
          displayName: "Synthetic",
          givenName: "",
          familyName: "",
          primaryEmail: email,
          primaryContactMethod: {
            contactMethodId: `${userId}-email`,
            type: "email",
            value: email,
            verifiedAt: verified ? "2026-10-01T00:00:00.000Z" : null,
          },
        },
        { streamId: `identity.user-${userId}` },
      ),
    );
  }
  async function projectAccount(accountId: string) {
    await buildAuthIdentityAccountProjectionHandlers(pools.auth)["identity.account.created"]!(
      buildTransportEvent(
        "identity.account.created",
        { accountId, name: accountId, displayName: accountId, accountType: "business" },
        { streamId: `identity.account-${accountId}` },
      ),
    );
  }
  async function projectMembership(membershipId: string, userId: string, accountId: string) {
    await buildAuthIdentityMembershipProjectionHandlers(pools.auth)["identity.membership.granted"]!(
      buildTransportEvent(
        "identity.membership.granted",
        { membershipId, accountId, userId, roleKey: "owner" },
        { streamId: `identity.membership-${membershipId}` },
      ),
    );
  }
});
