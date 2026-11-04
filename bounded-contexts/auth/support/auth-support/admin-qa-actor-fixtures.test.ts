import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { AUTH_SESSION_COOKIE_NAME } from "@chase-sets/auth-context";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
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
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as identityModule } from "@chase-sets/identity";
import { ADMIN_QA_ACTOR_FIXTURES, DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "@chase-sets/identity/server";
import { module as authModule } from "../../index";
import { listAccountSelectionMemberships } from "../../features/account-selection/read-model/queries";
import { registerAccountSelectionRoutes } from "../api-support/account-selection-routes";
import type { AuthApiEnv } from "../api-support/support";
import { resolveActorFromRequest } from "../runtime-support/runtime";
import { createAuthServices, type AuthServices } from "../runtime-support/services";
import { AUTH_BOOTSTRAP_ACCOUNT_ID, AUTH_BOOTSTRAP_TENANT_ID, AUTH_BOOTSTRAP_USER_ID } from "./constants";
import { insertAccountSelectionToken } from "./store";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const VIEWER_USER = "usr_admin_qa_viewer";
const PRIMARY = {
  accountId: "acc_admin_qa_viewer",
  membershipId: "mbr_admin_qa_viewer",
  accountName: "Admin QA Viewer Primary",
} as const;
const SECONDARY = {
  accountId: "acc_admin_qa_viewer_secondary",
  membershipId: "mbr_admin_qa_viewer_secondary",
  accountName: "Admin QA Viewer Secondary",
} as const;
const context = {
  tenantId: AUTH_BOOTSTRAP_TENANT_ID,
  audit: { performedByUserId: AUTH_BOOTSTRAP_USER_ID, forAccountId: AUTH_BOOTSTRAP_ACCOUNT_ID },
  trace: {},
} as unknown as EventStoreContext;
const ENFORCEMENT = {
  version: 1,
  enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAV",
  reason: "operator-other",
  reference: null,
} as const;

describe("Admin QA Auth projection contract", () => {
  it("has the canonical viewer aliases and exactly two viewer accounts", () => {
    const viewer = ADMIN_QA_ACTOR_FIXTURES.find((fixture) => fixture.actorAlias === "admin-qa-viewer");
    expect(viewer?.accountName).toBe("Admin QA Viewer Primary");
    expect(viewer?.roleKey).toBe("viewer");
    expect(ADMIN_QA_ACTOR_FIXTURES).toHaveLength(6);
  });
});

// Identity provisions through its real seed profile and Auth consumes the
// resulting Identity events through its mounted projections; nothing is mocked.
describeDb("Admin QA viewer selection through provisioned Identity and real Auth projections", () => {
  let pools: Readonly<Record<"identity" | "auth", PgTransactionalPool>>;
  let auth: AuthServices;
  let identity: ReturnType<typeof identityModule.createServices>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity", "auth"], "auth_admin_qa_fixtures");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(authModule, pools.auth);
    await syncContextProjectionGroups(mountedRuntime(), "auth", { requiredOnly: true });
    auth = createAuthServices(pools.auth);
    identity = identityModule.createServices(pools.identity, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    await identityModule.seed!(pools.identity, undefined, { enabledDataProfiles: ["admin-qa-actor-fixtures"] });
    await drain();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("lists exactly the two viewer Accounts and each selection resolves its own active Membership", async () => {
    const response = await buildApp().request(
      "/account-selection/resolve",
      post({ selectionToken: await selectionToken() }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { memberships: ReadonlyArray<{ accountName: string }> };
    expect(body.memberships.map((membership) => membership.accountName).sort()).toEqual([
      PRIMARY.accountName,
      SECONDARY.accountName,
    ]);
    for (const fixture of ADMIN_QA_ACTOR_FIXTURES.filter((candidate) => candidate.userId !== VIEWER_USER)) {
      await expect(listAccountSelectionMemberships(pools.auth, fixture.userId)).resolves.toEqual([
        expect.objectContaining({ accountId: fixture.accountId, accountName: fixture.accountName }),
      ]);
    }

    for (const target of [PRIMARY, SECONDARY]) {
      const actor = await resolve(await select(target.accountId));
      expect(actor).toMatchObject({
        userId: VIEWER_USER,
        accountId: target.accountId,
        membershipId: target.membershipId,
        roleKey: "viewer",
      });
      expect(actor?.permissions).not.toContain("support.evidence.any-case");
    }
  });

  it("denies an unheld Account and a suspended viewer Account while the other stays selectable", async () => {
    const before = await sessionWrites();
    const unheld = await buildApp().request(
      "/account-selection/complete",
      post({ selectionToken: await selectionToken(), accountId: "acc_admin_qa_owner" }),
    );
    expect(unheld.ok).toBe(false);
    expect(await sessionWrites()).toEqual(before);

    const primarySession = await select(PRIMARY.accountId);
    await identity.accounts.commandHandler({
      streamId: `identity.account-${PRIMARY.accountId}`,
      command: { type: "SuspendAccount", enforcement: ENFORCEMENT },
      context,
    });
    await drain();

    expect((await listAccountSelectionMemberships(pools.auth, VIEWER_USER)).map((item) => item.accountName)).toEqual([
      SECONDARY.accountName,
    ]);
    const beforeSuspended = await sessionWrites();
    const suspended = await buildApp().request(
      "/account-selection/complete",
      post({ selectionToken: await selectionToken(), accountId: PRIMARY.accountId }),
    );
    expect(suspended.ok).toBe(false);
    expect(await sessionWrites()).toEqual(beforeSuspended);
    // The Session issued before suspension is denied on its next request; its Membership stays active.
    await expect(resolve(primarySession)).resolves.toBeNull();
    expect(
      (
        await pools.auth.query("SELECT status FROM auth_identity_memberships WHERE membership_id = $1", [
          PRIMARY.membershipId,
        ])
      ).rows,
    ).toEqual([{ status: "active" }]);
    await expect(resolve(await select(SECONDARY.accountId))).resolves.toMatchObject({
      accountId: SECONDARY.accountId,
      membershipId: SECONDARY.membershipId,
    });
  });

  it("shows a role change and a revocation on the stale Session's next request", async () => {
    const session = await select(SECONDARY.accountId);
    const primarySession = await select(PRIMARY.accountId);
    await identity.memberships.commandHandler({
      streamId: `identity.membership-${SECONDARY.membershipId}`,
      command: { type: "ChangeMembershipRole", roleKey: "fulfillment", assignmentAuthority: { type: "system" } },
      context,
    });
    await drain();
    await expect(resolve(session)).resolves.toMatchObject({ accountId: SECONDARY.accountId, roleKey: "fulfillment" });

    await identity.memberships.commandHandler({
      streamId: `identity.membership-${SECONDARY.membershipId}`,
      command: { type: "RevokeMembership" },
      context,
    });
    await drain();
    await expect(resolve(session)).resolves.toBeNull();
    expect((await listAccountSelectionMemberships(pools.auth, VIEWER_USER)).map((item) => item.accountName)).toEqual([
      PRIMARY.accountName,
    ]);
    await expect(resolve(primarySession)).resolves.toMatchObject({ accountId: PRIMARY.accountId, roleKey: "viewer" });
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
  function buildApp() {
    const app = new Hono<AuthApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", null);
      c.set("context", context);
      await next();
    });
    registerAccountSelectionRoutes(app, auth);
    return app;
  }
  async function selectionToken() {
    const token = auth.auth.issueOpaqueToken("acct");
    await insertAccountSelectionToken(pools.auth, {
      tokenId: token,
      userId: VIEWER_USER,
      authenticationMethod: "magic-link",
      tokenHash: auth.auth.hashSecret(token),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    return token;
  }
  async function select(accountId: string) {
    const response = await buildApp().request(
      "/account-selection/complete",
      post({ selectionToken: await selectionToken(), accountId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string; sessionToken: string; session: { account_id: string } };
    expect(body).toMatchObject({ type: "session-started", session: { account_id: accountId } });
    await drain();
    return body.sessionToken;
  }
  async function resolve(sessionToken: string) {
    return resolveActorFromRequest(
      auth,
      new Request("https://synthetic.test/", { headers: { cookie: `${AUTH_SESSION_COOKIE_NAME}=${sessionToken}` } }),
    );
  }
  async function sessionWrites() {
    const result = await pools.auth.query<{ sessions: number; tokens: number }>(
      `SELECT (SELECT count(*)::int FROM event_store_events WHERE event_type = 'auth.session.started') AS sessions,
              (SELECT count(*)::int FROM identity_session_tokens) AS tokens`,
    );
    return result.rows[0];
  }
});

function post(body: unknown) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
