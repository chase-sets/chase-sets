import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as authModule } from "../../index";
import { listAccountSelectionMemberships } from "../../features/account-selection/read-model/queries";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import { buildSessionProjectionHandlers } from "../../features/sessions/read-model/projection";
import { registerAccountSelectionRoutes } from "../api-support/account-selection-routes";
import { registerGuestCheckoutRoutes } from "../api-support/guest-checkout-routes";
import { registerInvitationRoutes } from "../api-support/invitation-routes";
import { registerMagicLinkRoutes } from "../api-support/magic-link-routes";
import { registerPasskeyRoutes } from "../api-support/passkey-routes";
import { registerPhoneCodeRoutes } from "../api-support/phone-code-routes";
import { registerRegistrationRoutes } from "../api-support/register-routes";
import { registerSocialLoginRoutes } from "../api-support/social-login-routes";
import type { AuthApiEnv } from "../api-support/support";
import {
  buildAuthIdentityAccountProjectionHandlers,
  buildAuthIdentityMembershipProjectionHandlers,
  buildAuthIdentityUserProjectionHandlers,
  insertCreatedAuthIdentityAccountMirror,
} from "../auth-support/identity-projection";
import {
  insertAccountSelectionToken,
  insertChallenge,
  insertGuestCheckoutClaimToken,
  insertMagicLinkToken,
  insertPhoneCodeToken,
} from "../auth-support/store";
import { resolveActorFromRequest } from "./runtime";
import { createAuthServices, resolveActorFromSessionId, startInteractiveAuth, type AuthServices } from "./services";

// Only upstream mutation/provider boundaries are controlled. Account/Membership
// projections, SQL, Auth routes, Session aggregates and tokens are real.
const { upstream, verifyRegistration } = vi.hoisted(() => ({
  upstream: {
    createPersonalIdentity: vi.fn(),
    resolveRegistrationConsent: vi.fn(async () => ({ synthetic: true })),
    verifyEmailContactMethod: vi.fn(async () => ({ ok: true })),
    enablePasswordCredential: vi.fn(async () => ({ ok: true })),
    registerPasskeyCredential: vi.fn(async () => ({ ok: true })),
    verifyInvitationAcceptanceToken: vi.fn(),
    acceptInvitationForUser: vi.fn(),
    claimGuestAccount: vi.fn(),
    linkSocialLogin: vi.fn(async () => ({ ok: true })),
  },
  verifyRegistration: vi.fn(),
}));

vi.mock("@chase-sets/identity/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/identity/server")>()),
  createIdentityAuthRequestClient: () => upstream,
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: verifyRegistration,
}));

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const USER = "usr_synthetic_lifecycle";
const ACCOUNT = "acc_synthetic_lifecycle";
const OTHER = "acc_synthetic_unrelated";
const MEMBERSHIP = "mbr_synthetic_lifecycle";
const EMAIL = "synthetic@chasesets.com";
const future = () => new Date(Date.now() + 60 * 60_000).toISOString();
const context = {
  tenantId: "tnt_synthetic_lifecycle" as never,
  audit: { performedByUserId: USER as never, forAccountId: ACCOUNT as never },
};

describeDb("Account lifecycle at Auth authorization boundaries", () => {
  let pool: PgTransactionalPool;
  let services: AuthServices;
  let pools: Readonly<Record<"auth", PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["auth"], "auth_account_lifecycle");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.auth;
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetMultiContextTestSchemas({ auth: pool });
    await bootstrapContextDatabase(authModule, pool);
    services = boot();
    await projectUser(USER, EMAIL);
    await projectAccount(ACCOUNT);
    await projectAccount(OTHER);
    await projectMembership(MEMBERSHIP, ACCOUNT);
    await projectMembership("mbr_synthetic_unrelated", OTHER);
    upstream.createPersonalIdentity.mockResolvedValue({
      userId: "usr_synthetic_created",
      accountId: "acc_synthetic_created",
      membershipId: "mbr_synthetic_created",
    });
    upstream.acceptInvitationForUser.mockResolvedValue({ membershipId: MEMBERSHIP });
    upstream.claimGuestAccount.mockResolvedValue({ membershipId: MEMBERSHIP });
    upstream.verifyInvitationAcceptanceToken.mockResolvedValue({
      invitationId: "inv_synthetic_lifecycle",
      accountId: ACCOUNT,
      email: EMAIL,
      roleKey: "owner",
      expiresAt: future(),
    });
    verifyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "synthetic-credential", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
      },
    });
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("selection removes only the inactive Account and reactivation restores its display and role", async () => {
    const initial = await listAccountSelectionMemberships(pool, USER);
    expect(initial).toHaveLength(2);
    const choice = initial.find((item) => item.accountId === ACCOUNT);
    expect(choice).toMatchObject({ accountId: ACCOUNT, accountName: ACCOUNT, roleLabel: expect.any(String) });
    for (const status of ["suspended", "active", "closed"] as const) {
      await lifecycle(status);
      for (const current of [services, boot()]) {
        const app = buildApp(current);
        const token = await selectionToken();
        const response = await app.request("/account-selection/resolve", post({ selectionToken: token }));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.memberships).toEqual(
          expect.arrayContaining([{ ...initial.find((item) => item.accountId === OTHER) }]),
        );
        if (status === "active") expect(body.memberships).toContainEqual(choice);
        else expect(body.memberships).toHaveLength(1);
        const before = await writeCounts();
        const complete = await app.request(
          "/account-selection/complete",
          post({ selectionToken: token, accountId: ACCOUNT }),
        );
        if (status === "active") {
          expect(complete.status).toBe(200);
          expect(await complete.json()).toMatchObject({ type: "session-started", session: { account_id: ACCOUNT } });
        } else {
          expect(complete.ok).toBe(false);
          expect(await writeCounts()).toEqual(before);
        }
      }
    }
  });

  it("default start chooses the remaining active Account and new starts resume after reactivation", async () => {
    await lifecycle("suspended");
    const result = await startInteractiveAuth(services, { userId: USER, authenticationMethod: "password", context });
    expect(result).toMatchObject({ type: "session-started", session: { account_id: OTHER } });
    await lifecycle("active");
    expect(await start(ACCOUNT)).toMatchObject({ type: "session-started", session: { account_id: ACCOUNT } });
  });

  it.each(["suspended", "closed", "missing"] as const)(
    "default, explicit and override starts deny %s authority before Session/token writes",
    async (status) => {
      const memberships = await services.identity.listActiveMembershipsForUser(USER);
      await setAccountStatus(status);
      const before = await writeCounts();
      await expect(
        startInteractiveAuth(services, { userId: USER, accountId: ACCOUNT, authenticationMethod: "password", context }),
      ).rejects.toThrow("Selected account is not available");
      await expect(
        startInteractiveAuth(services, {
          userId: USER,
          accountId: ACCOUNT,
          authenticationMethod: "password",
          context,
          membershipsOverride: memberships,
        }),
      ).rejects.toThrow("Selected account is not available");
      await pool.query("DELETE FROM auth_identity_user_memberships WHERE account_id = $1", [OTHER]);
      await expect(
        startInteractiveAuth(services, { userId: USER, authenticationMethod: "password", context }),
      ).rejects.toThrow("no active memberships");
      await expect(
        startInteractiveAuth(services, {
          userId: USER,
          authenticationMethod: "password",
          context,
          membershipsOverride: memberships.filter((membership) => membership.accountId === ACCOUNT),
        }),
      ).rejects.toThrow("no active memberships");
      expect(await writeCounts()).toEqual(before);
      expect(
        (await pool.query("SELECT status FROM auth_identity_memberships WHERE membership_id = $1", [MEMBERSHIP])).rows,
      ).toEqual([{ status: "active" }]);
    },
  );

  it.each([
    ["primary", true],
    ["primary", false],
    ["fallback", true],
    ["fallback", false],
  ] as const)(
    "Session and linked actors use Account authority on %s membership / projection hit=%s",
    async (table, hit) => {
      const session = await start(ACCOUNT);
      const unrelated = await start(OTHER);
      if (hit) await projectSession(session.sessionId);
      if (table === "fallback") await pool.query("DELETE FROM auth_identity_user_memberships");
      expect(await services.sessions.getSession(session.sessionId)).toEqual(hit ? expect.any(Object) : null);
      for (const status of ["active", "suspended", "active", "closed", "missing"] as const) {
        await setAccountStatus(status);
        for (const current of [services, boot()]) {
          const actor = await resolveActorFromSessionId(current, session.sessionId);
          const cookieActor = await resolveActorFromRequest(
            current,
            new Request("https://synthetic.test/session", {
              headers: { cookie: `chase_sets_session=${session.sessionToken}` },
            }),
          );
          const linkedActor = await linked(current, ACCOUNT);
          if (status === "active") {
            expect(actor).toMatchObject({
              userId: USER,
              accountId: ACCOUNT,
              membershipId: MEMBERSHIP,
              roleKey: "owner",
            });
            expect(actor?.permissions).not.toContain("support.evidence.any-case");
            expect(cookieActor).toEqual(actor);
            expect(linkedActor).toMatchObject({ accountId: ACCOUNT, membershipId: MEMBERSHIP });
            expect(linkedActor?.permissions).toEqual(["catalog.view"]);
            expect(linkedActor?.permissions).not.toContain("payouts.request");
          } else {
            expect(actor).toBeNull();
            expect(cookieActor).toBeNull();
            expect(linkedActor).toBeNull();
          }
          expect(await resolveActorFromSessionId(current, unrelated.sessionId)).toMatchObject({ accountId: OTHER });
          expect(await linked(current, OTHER)).toMatchObject({ accountId: OTHER });
          expect((await current.sessions.readAuthenticatedSession(session.sessionId))?.state.status).toBe("active");
          expect(
            (await pool.query("SELECT status FROM auth_identity_memberships WHERE membership_id = $1", [MEMBERSHIP]))
              .rows,
          ).toEqual([{ status: "active" }]);
        }
      }
    },
  );

  it("role changes and Membership revocation remain independent after Account reactivation", async () => {
    const session = await start(ACCOUNT);
    await lifecycle("suspended");
    await projectMembershipEvent("identity.membership.role-changed", { roleKey: "viewer" });
    await lifecycle("active");
    expect(await resolveActorFromSessionId(boot(), session.sessionId)).toMatchObject({ roleKey: "viewer" });
    await projectMembershipEvent("identity.membership.revoked", {});
    await lifecycle("suspended");
    await lifecycle("active");
    expect(await resolveActorFromSessionId(boot(), session.sessionId)).toBeNull();
    expect(await linked(boot(), ACCOUNT)).toBeNull();
  });

  it.each(["RevokeSession", "ExpireSession"] as const)(
    "reactivation never revives %s behind an active projection",
    async (type) => {
      const session = await start(ACCOUNT);
      await projectSession(session.sessionId);
      await lifecycle("suspended");
      await services.sessions.commandHandler({
        streamId: toSessionStreamId(session.sessionId),
        command: { type },
        context,
      });
      await lifecycle("active");
      expect((await services.sessions.getSession(session.sessionId))?.status).toBe("active");
      for (const current of [services, boot()])
        expect(await resolveActorFromSessionId(current, session.sessionId)).toBeNull();
    },
  );

  it.each([
    [500, "auth.session.revoked"],
    [501, "auth.session.revoked"],
    [500, "auth.session.expired"],
    [501, "auth.session.expired"],
  ] as const)("reactivation cannot hide a terminal Session event at position %s (%s)", async (position, eventType) => {
    const session = await start(ACCOUNT);
    await projectSession(session.sessionId);
    await lifecycle("suspended");
    // Persist a complete synthetic stream, not a readStream double. Alternating
    // account switches keep the entire pre-terminal history independently valid.
    await services.eventStore.appendToStream({
      streamId: toSessionStreamId(session.sessionId),
      expectedVersion: 1,
      context,
      events: [
        ...Array.from({ length: position - 2 }, (_, index) => ({
          eventType: "auth.session.account-switched",
          payload: { accountId: index % 2 === 0 ? OTHER : ACCOUNT },
        })),
        { eventType, payload: {} },
      ],
    });
    await lifecycle("active");
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM event_store_events WHERE stream_id = $1",
          [toSessionStreamId(session.sessionId)],
        )
      ).rows[0]?.count,
    ).toBe(position);
    expect((await services.sessions.getSession(session.sessionId))?.status).toBe("active");
    for (const current of [services, boot()])
      expect(await resolveActorFromSessionId(current, session.sessionId)).toBeNull();
  });

  it("reactivation cannot revive an elapsed authoritative Session expiry", async () => {
    const sessionId = "ses_synthetic_elapsed";
    await services.sessions.commandHandler({
      streamId: toSessionStreamId(sessionId),
      context,
      command: {
        type: "StartSession",
        sessionId: sessionId as never,
        userId: USER as never,
        accountId: ACCOUNT as never,
        availableAccountIds: [ACCOUNT],
        authenticationMethod: "password",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    await projectSession(sessionId);
    await pool.query("UPDATE identity_sessions SET expires_at = $2 WHERE session_id = $1", [sessionId, future()]);
    await lifecycle("suspended");
    await lifecycle("active");
    for (const current of [services, boot()]) expect(await resolveActorFromSessionId(current, sessionId)).toBeNull();
  });

  it.each(["invitation", "guest claim", "admin social"] as const)(
    "%s composed override obeys active, suspended, closed and missing Account facts",
    async (journey) => {
      if (journey === "admin social")
        await projectMembershipEvent("identity.membership.role-changed", { roleKey: "platform-admin" });
      for (const status of ["active", "suspended", "closed", "missing"] as const) {
        await setAccountStatus(status);
        const before = await writeCounts();
        const response = await overrideRequest(journey);
        const after = await writeCounts();
        if (status === "active") {
          expect(response.status).toBe(journey === "admin social" ? 302 : 200);
          expect(after.sessions).toBe(before.sessions + 1);
          expect(after.tokens).toBe(before.tokens + 1);
        } else {
          expect(after).toEqual(before);
          expect(response.headers.getSetCookie().join(";")).not.toContain("chase_sets_session=");
        }
      }
    },
  );

  it.each(["register", "magic-link", "phone-code", "passkey"] as const)(
    "%s registration exposes its created Account before the first Session without a worker",
    async (journey) => {
      const app = buildApp(services);
      const email = "created@synthetic.test";
      const accountId = "acc_synthetic_created";
      expect(
        (await pool.query("SELECT account_id FROM auth_identity_accounts WHERE account_id = $1", [accountId])).rows,
      ).toEqual([]);
      let response: Response;
      if (journey === "register") {
        response = await app.request("/register", post({ email, displayName: "Synthetic Created" }));
      } else if (journey === "magic-link") {
        await insertMagicLinkToken(pool, {
          tokenId: "cmd_synthetic_magic",
          userId: null,
          email,
          tokenHash: services.auth.hashSecret("synthetic-magic"),
          deliveryToken: "synthetic-magic",
          expiresAt: future(),
        });
        response = await app.request("/magic-link/consume", post({ token: "synthetic-magic" }));
      } else if (journey === "phone-code") {
        await insertPhoneCodeToken(pool, {
          tokenId: "cmd_synthetic_phone",
          userId: null,
          phone: "+15555550123",
          codeHash: services.auth.hashSecret("+15555550123:123456"),
          deliveryCode: "123456",
          expiresAt: future(),
        });
        response = await app.request(
          "/phone-code/consume",
          post({ tokenId: "cmd_synthetic_phone", phone: "+15555550123", code: "123456" }),
        );
      } else {
        await insertChallenge(pool, {
          challengeId: "cmd_synthetic_passkey",
          purpose: "passkey-register",
          email,
          userId: null,
          challengeValue: "synthetic-challenge",
          expiresAt: future(),
        });
        response = await app.request(
          "/passkeys/register",
          post({
            challengeId: "cmd_synthetic_passkey",
            challenge: "synthetic-challenge",
            externalCredentialId: "synthetic-credential",
            webauthnResponse: {
              id: "synthetic-credential",
              rawId: "synthetic-credential",
              type: "public-key",
              response: { clientDataJSON: "synthetic", attestationObject: "synthetic" },
              clientExtensionResults: {},
            },
          }),
        );
      }
      expect(response.status).toBe(journey === "register" || journey === "passkey" ? 201 : 200);
      const body = await response.json();
      expect(body.authResult ?? body).toMatchObject({ type: "session-started", session: { account_id: accountId } });
      expect(upstream.createPersonalIdentity).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query("SELECT status FROM auth_identity_accounts WHERE account_id = $1", [accountId])).rows,
      ).toEqual([{ status: "active" }]);
      expect(await writeCounts()).toMatchObject({ sessions: 1, tokens: 1 });
    },
  );

  it.each(["suspended", "closed"] as const)(
    "created-Account mirror cannot overwrite an already projected %s Account",
    async (status) => {
      await lifecycle(status);
      await insertCreatedAuthIdentityAccountMirror(pool, { accountId: ACCOUNT, displayName: "Must not replace" });
      expect(
        (await pool.query("SELECT status, display_name FROM auth_identity_accounts WHERE account_id = $1", [ACCOUNT]))
          .rows,
      ).toEqual([{ status, display_name: ACCOUNT }]);
      await expect(start(ACCOUNT)).rejects.toThrow("not available");
    },
  );

  function boot() {
    return createAuthServices(pool, {
      registrationAdmission: { mode: "open", disposableEmailMode: "enforce", disposableEmailDomains: [] },
      adminGoogleWorkspaceSso: { allowedHostedDomains: ["chasesets.com"] },
      socialLoginProviders: [
        {
          providerName: "google",
          createAuthorizationUrl: ({ state }) =>
            `https://synthetic-provider.test/auth?state=${encodeURIComponent(state)}`,
          exchangeCallback: async () => ({
            providerName: "google",
            providerSubject: "synthetic-subject",
            email: EMAIL,
            emailVerified: true,
            hostedDomain: "chasesets.com",
            displayName: "Synthetic",
          }),
        },
      ],
    });
  }
  function buildApp(current: AuthServices) {
    const app = new Hono<AuthApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", null);
      c.set("context", context);
      await next();
    });
    for (const register of [
      registerAccountSelectionRoutes,
      registerInvitationRoutes,
      registerGuestCheckoutRoutes,
      registerRegistrationRoutes,
      registerMagicLinkRoutes,
      registerPhoneCodeRoutes,
      registerPasskeyRoutes,
      registerSocialLoginRoutes,
    ]) {
      register(app, current);
    }
    return app;
  }
  async function projectAccount(accountId: string) {
    await buildAuthIdentityAccountProjectionHandlers(pool)["identity.account.created"]!(
      buildTransportEvent(
        "identity.account.created",
        { accountId, name: accountId, displayName: accountId, accountType: "personal" },
        { streamId: `identity.account-${accountId}` },
      ),
    );
  }
  async function lifecycle(status: "active" | "suspended" | "closed") {
    const type = `identity.account.${status === "active" ? "reactivated" : status}`;
    await buildAuthIdentityAccountProjectionHandlers(pool)[type]!(
      buildTransportEvent(
        type,
        {
          enforcement: {
            version: 1,
            enforcementActionId: "enf_synthetic_lifecycle",
            reason: "operator-other",
            reference: null,
          },
        },
        { streamId: `identity.account-${ACCOUNT}` },
      ),
    );
  }
  async function setAccountStatus(status: "active" | "suspended" | "closed" | "missing") {
    if (status === "missing") await pool.query("DELETE FROM auth_identity_accounts WHERE account_id = $1", [ACCOUNT]);
    else await lifecycle(status);
  }
  async function projectUser(userId: string, email: string) {
    await buildAuthIdentityUserProjectionHandlers(pool)["identity.user.created"]!(
      buildTransportEvent(
        "identity.user.created",
        { userId, displayName: "Synthetic", givenName: "", familyName: "", primaryEmail: email },
        { streamId: `identity.user-${userId}` },
      ),
    );
  }
  async function projectMembership(membershipId: string, accountId: string) {
    await buildAuthIdentityMembershipProjectionHandlers(pool)["identity.membership.granted"]!(
      buildTransportEvent(
        "identity.membership.granted",
        { membershipId, accountId, userId: USER, roleKey: "owner" },
        { streamId: `identity.membership-${membershipId}` },
      ),
    );
  }
  async function projectMembershipEvent(type: string, data: Record<string, string>) {
    await buildAuthIdentityMembershipProjectionHandlers(pool)[type]!(
      buildTransportEvent(type, data, { streamId: `identity.membership-${MEMBERSHIP}` }),
    );
  }
  async function start(accountId: string) {
    const result = await startInteractiveAuth(services, {
      userId: USER,
      accountId,
      authenticationMethod: "password",
      context,
    });
    if (result.type !== "session-started") throw new Error("Synthetic fixture must start a Session");
    return result;
  }
  async function projectSession(sessionId: string) {
    const events = await services.eventStore.readStream({ streamId: toSessionStreamId(sessionId) });
    for (const event of events) {
      const transport = toTransportEvent(event);
      await buildSessionProjectionHandlers(pool)[transport.type]!(transport);
    }
  }
  async function linked(current: AuthServices, accountId: string) {
    return resolveActorFromRequest(
      current,
      new Request("https://synthetic.test/session", {
        headers: { authorization: "Bearer ucp_at_synthetic_lifecycle" },
      }),
      {
        linkedPlatformAuthorizations: {
          resolveAccessToken: async () => ({
            authorization_id: "lpa_synthetic_lifecycle",
            user_id: USER,
            account_id: accountId,
            scopes: ["catalog:read"],
          }),
        },
      },
    );
  }
  async function selectionToken() {
    const token = services.auth.issueOpaqueToken("acct");
    await insertAccountSelectionToken(pool, {
      tokenId: token,
      userId: USER,
      authenticationMethod: "password",
      tokenHash: services.auth.hashSecret(token),
      expiresAt: future(),
    });
    return token;
  }
  async function writeCounts() {
    const result = await pool.query<{ sessions: number; tokens: number; selections: number }>(
      `SELECT (SELECT count(*)::int FROM event_store_events WHERE event_type = 'auth.session.started') AS sessions,
              (SELECT count(*)::int FROM identity_session_tokens) AS tokens,
              (SELECT count(*)::int FROM identity_account_selection_tokens) AS selections`,
    );
    return result.rows[0]!;
  }
  async function overrideRequest(journey: "invitation" | "guest claim" | "admin social") {
    const app = buildApp(services);
    if (journey === "invitation") {
      return app.request(
        "/invitations/accept",
        post({
          invitationId: "inv_synthetic_lifecycle",
          token: "synthetic-invite",
          password: "Synthetic-Password-123!",
        }),
      );
    }
    if (journey === "guest claim") {
      const continuation = services.auth.issueOpaqueToken("claim");
      await insertGuestCheckoutClaimToken(pool, {
        tokenId: continuation,
        accountId: ACCOUNT,
        paymentId: "pay_synthetic",
        email: EMAIL,
        displayName: "Synthetic",
        tokenHash: services.auth.hashSecret(continuation),
        continuationHash: services.auth.hashSecret(continuation),
        expiresAt: future(),
      });
      return app.request("/guest-checkout/claim-with-continuation", post({ paymentId: "pay_synthetic", continuation }));
    }
    const response = await app.request("/social/google/start?journey=admin&returnTo=/support/platform-feedback");
    const state = new URL(response.headers.get("Location")!).searchParams.get("state");
    return app.request(`/social/google/callback?state=${encodeURIComponent(state!)}&code=synthetic-code`);
  }
});

function post(body: unknown) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
