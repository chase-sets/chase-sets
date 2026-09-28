import type { ResolvedActor } from "@chase-sets/auth-context";
import type { BcApiMount } from "@chase-sets/bounded-context-module";
import {
  attachReadConsistencyMiddleware,
  type ReadConsistencyAuditRecord,
  type ReadConsistencyMiddlewareOptions,
  type ReadConsistencyProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildAuthApi, type AuthApiEnv } from "../../../api";
import contextManifest from "../../../context.json" with { type: "json" };
import { createAuthBootstrapContext, resolveActorFromRequest } from "../../../support/runtime-support/runtime";
import type { AuthServices } from "../../../support/runtime-support/services";

/**
 * Composed regression for the receipt-bound `/api/auth/session` read (#8390).
 *
 * The harness mirrors the platform-api middleware order without importing
 * deployable code: a test actor middleware resolves the actor through the real
 * Auth resolver *before* the real `attachReadConsistencyMiddleware` waits on the
 * `/session` dependencies declared in the real Auth manifest, and the real Auth
 * API router (`buildAuthApi`) serves the route afterwards. The projection
 * groups are synthetic (no database): the `auth-identity-user-projection`
 * runner flips the stub user read model from unverified to verified when its
 * receipt position is refreshed, so a verified read is only observable after
 * the wait for that projection.
 */

const AUTH_MOUNT_PATH = "/api/auth";
const AUTH_SOURCE_POSITION = "4735";
const IDENTITY_SOURCE_POSITION = "19853";
const STALE_IDENTITY_POSITION = "19852";
const SESSION_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
const SESSION_AUTHENTICATED_AT = new Date(Date.now() - 1_000).toISOString();
// Auth session cookie name (`AUTH_SESSION_COOKIE_NAME`), spelled out so this
// slice test only consumes the runtime-support seam the sessions slice already
// declares in `directoryIntent.expectedConsumers`.
const SESSION_COOKIE = "chase_sets_session=session_token";

const SESSION_PROJECTION_NAME = "auth-session-projection";
const MEMBERSHIP_PROJECTION_NAME = "auth-identity-membership-projection";
const USER_PROJECTION_NAME = "auth-identity-user-projection";
const USER_PROJECTION_TABLE = "auth_identity_users";

function requireDeclared<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

const authMount = requireDeclared(
  contextManifest.apiMounts.find((mount) => mount.mountPath === AUTH_MOUNT_PATH),
  "The Auth manifest must declare the /api/auth mount.",
);
const authReadFreshnessRoutes = authMount.readFreshnessRoutes as NonNullable<BcApiMount["readFreshnessRoutes"]>;

const userProjectionGroupDeclaration = requireDeclared(
  contextManifest.projectionGroups.find((group) => group.projectionName === USER_PROJECTION_NAME),
  "The Auth manifest must declare the auth-identity-user-projection group.",
);

type ReadConsistencyTuning = Pick<ReadConsistencyMiddlewareOptions, "timeoutMs" | "pollIntervalMs" | "nowMs">;

type FixtureOptions = Readonly<{
  readFreshnessRoutes?: NonNullable<BcApiMount["readFreshnessRoutes"]>;
  readConsistency?: ReadConsistencyTuning;
  /** When false the Identity user projection never reaches the receipt position. */
  userProjectionAdvances?: boolean;
  /**
   * When true the authenticated session read succeeds once (the pre-wait
   * resolution) and reports the session as gone on every later read.
   */
  revokeSessionAfterPreWaitRead?: boolean;
}>;

function createFixture(options: FixtureOptions = {}) {
  let userVerified = false;
  let authenticatedSessionReads = 0;
  const readUser = () => ({
    user_id: "usr_1",
    display_name: "Seller",
    primary_email: "seller@example.test",
    status: "active",
    contact_methods: [
      {
        contactMethodId: "ctm_email",
        type: "email",
        value: "seller@example.test",
        verifiedAt: userVerified ? "2026-07-06T12:00:00.000Z" : null,
      },
    ],
    social_login_links: [],
  });

  // Minimal AuthServices double: only the members the real session resolver
  // (`resolveActorFromRequest` -> `resolveActorFromSessionId`) and the Auth
  // API router touch. The unverified/verified flip lives in `readUser`.
  const services = {
    db: {
      query: vi.fn(async () => ({
        rows: [{ session_id: "ses_1", token_hash: "hashed:session_token", expires_at: SESSION_EXPIRES_AT }],
      })),
    },
    auth: {
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      bootstrapTenantId: "tnt_identity",
      getUser: vi.fn(async () => readUser()),
      getActiveMembershipForUserAccount: vi.fn(async () => ({
        membership_id: "mem_1",
        user_id: "usr_1",
        account_id: "acc_1",
        role_key: "owner",
        role_permissions: ["accounts.view"],
        status: "active",
        updated_at: new Date().toISOString(),
      })),
    },
    sessions: {
      getSession: vi.fn(async () => null),
      readAuthenticatedSession: vi.fn(async (sessionId: string) => {
        authenticatedSessionReads += 1;
        if (sessionId !== "ses_1") return null;
        if (options.revokeSessionAfterPreWaitRead && authenticatedSessionReads > 1) return null;
        return {
          state: {
            id: "ses_1",
            userId: "usr_1",
            accountId: "acc_1",
            availableAccountIds: ["acc_1"],
            authenticationMethod: "password",
            status: "active",
            expiresAt: SESSION_EXPIRES_AT,
          },
          authenticatedAt: SESSION_AUTHENTICATED_AT,
        };
      }),
    },
    socialLoginProviders: [],
    adminGoogleWorkspaceSso: null,
    projectors: [],
  } as unknown as AuthServices;

  const refreshAuthSession = vi.fn(async () => ({
    lastGlobalPosition: AUTH_SOURCE_POSITION,
    state: "caught-up",
    lastError: null,
  }));
  const refreshAuthMembership = vi.fn(async () => ({
    lastGlobalPosition: IDENTITY_SOURCE_POSITION,
    state: "caught-up",
    lastError: null,
  }));
  const refreshAuthUser = vi.fn(async () => {
    if (options.userProjectionAdvances === false) {
      return { lastGlobalPosition: STALE_IDENTITY_POSITION, state: "behind", lastError: null };
    }
    userVerified = true;
    return { lastGlobalPosition: IDENTITY_SOURCE_POSITION, state: "caught-up", lastError: null };
  });

  const projectionGroups: ReadConsistencyProjectionGroup[] = [
    {
      targetContextName: "auth",
      projectionName: SESSION_PROJECTION_NAME,
      ownedTables: ["identity_sessions", "identity_session_lookup"],
      subscriptionRunners: [{ sourceContextName: "auth", refreshStatus: refreshAuthSession }],
    },
    {
      targetContextName: "auth",
      projectionName: MEMBERSHIP_PROJECTION_NAME,
      ownedTables: ["auth_identity_memberships", "auth_identity_user_memberships"],
      subscriptionRunners: [{ sourceContextName: "identity", refreshStatus: refreshAuthMembership }],
    },
    {
      targetContextName: "auth",
      projectionName: USER_PROJECTION_NAME,
      ownedTables: [...userProjectionGroupDeclaration.ownedTables],
      subscriptionRunners: [{ sourceContextName: "identity", refreshStatus: refreshAuthUser }],
    },
  ];

  const audits: ReadConsistencyAuditRecord[] = [];
  const preWaitActors: (ResolvedActor | null)[] = [];
  const app = new Hono<AuthApiEnv>();

  // platform-api order: identity auth middleware (actor resolved before the wait) ...
  app.use("*", async (c, next) => {
    const actor = await resolveActorFromRequest(services, c.req.raw);
    preWaitActors.push(actor);
    c.set("actor", actor);
    c.set("context", actor ? createActorEventStoreContext(actor) : createAuthBootstrapContext(services));
    await next();
  });
  // ... then the read-consistency wait on the manifest-declared dependencies ...
  attachReadConsistencyMiddleware(
    app,
    [
      {
        contextName: contextManifest.contextName,
        mountPath: AUTH_MOUNT_PATH,
        readFreshnessRoutes: options.readFreshnessRoutes ?? authReadFreshnessRoutes,
      },
    ],
    projectionGroups,
    {
      timeoutMs: 0,
      pollIntervalMs: 1,
      ...options.readConsistency,
      recordReadConsistencyAudit: (record) => {
        audits.push(record);
      },
    },
  );
  // ... then the mounted Auth API router.
  app.route(AUTH_MOUNT_PATH, buildAuthApi(services));

  return {
    app,
    services,
    audits,
    preWaitActors,
    refreshAuthSession,
    refreshAuthMembership,
    refreshAuthUser,
    authenticatedSessionReads: () => authenticatedSessionReads,
  };
}

function createIdentityReceipt() {
  return encodeFreshWriteReceipt({
    observedAtMs: Date.now(),
    sources: [
      { sourceContextName: "auth", maxGlobalPosition: AUTH_SOURCE_POSITION, eventIds: ["evt_auth"] },
      { sourceContextName: "identity", maxGlobalPosition: IDENTITY_SOURCE_POSITION, eventIds: ["evt_identity"] },
    ],
  });
}

function receiptHeaders(extra: Record<string, string> = {}) {
  return {
    cookie: SESSION_COOKIE,
    [CHASE_SETS_READ_AFTER_WRITE_HEADER]: createIdentityReceipt(),
    [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "auth",
    ...extra,
  };
}

function sessionRouteDependencies(routes: NonNullable<BcApiMount["readFreshnessRoutes"]>) {
  return routes
    .filter((route) => route.routePath === "/session")
    .flatMap((route) => route.dependencies.map((dependency) => dependency.readModelTable));
}

function withoutUserProjectionDependency(routes: NonNullable<BcApiMount["readFreshnessRoutes"]>) {
  return routes.map((route) =>
    route.routePath === "/session"
      ? {
          ...route,
          dependencies: route.dependencies.filter((dependency) => dependency.readModelTable !== USER_PROJECTION_TABLE),
        }
      : route,
  );
}

function projectionNames(record: ReadConsistencyAuditRecord | undefined) {
  return [...(record?.dependencies ?? [])].map((dependency) => dependency.projectionName).sort();
}

describe("Auth session read freshness (receipt-bound /api/auth/session)", () => {
  it("declares the Identity user projection as a /session dependency next to the session and membership tables", () => {
    expect(sessionRouteDependencies(authReadFreshnessRoutes)).toEqual([
      "identity_sessions",
      "auth_identity_user_memberships",
      "auth_identity_memberships",
      USER_PROJECTION_TABLE,
    ]);
    expect(userProjectionGroupDeclaration.ownedTables).toContain(USER_PROJECTION_TABLE);
    expect(
      authReadFreshnessRoutes.filter((route) => route.routePath === "/session").flatMap((route) => route.methods ?? []),
    ).toEqual(["GET", "HEAD"]);
  });

  it.each(["GET", "HEAD"] as const)(
    "%s /session with an Identity receipt waits on the session, membership and user projections as exact dependencies",
    async (method) => {
      const fixture = createFixture();

      const response = await fixture.app.request("/api/auth/session", { method, headers: receiptHeaders() });

      expect(response.status).toBe(200);
      expect(fixture.audits).toHaveLength(1);
      expect(fixture.audits[0]).toMatchObject({
        outcome: "fresh",
        method,
        mountPath: AUTH_MOUNT_PATH,
        routePaths: ["/session"],
        waitMode: "exact-dependency",
        requestedTargetContextName: "auth",
      });
      expect(projectionNames(fixture.audits[0])).toEqual(
        [SESSION_PROJECTION_NAME, MEMBERSHIP_PROJECTION_NAME, USER_PROJECTION_NAME].sort(),
      );
      expect(fixture.refreshAuthSession).toHaveBeenCalledTimes(1);
      expect(fixture.refreshAuthMembership).toHaveBeenCalledTimes(1);
      expect(fixture.refreshAuthUser).toHaveBeenCalledTimes(1);
    },
  );

  it("returns the verified read-model permissions only from the post-wait resolution", async () => {
    const fixture = createFixture();

    const response = await fixture.app.request("/api/auth/session", { headers: receiptHeaders() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { actor: ResolvedActor };

    // The pre-wait actor was resolved from the unverified projection ...
    expect(fixture.preWaitActors).toHaveLength(1);
    expect(fixture.preWaitActors[0]?.permissions).toContain("accounts.view");
    expect(fixture.preWaitActors[0]?.permissions).not.toContain("offers.manage");
    // ... the receipt wait advanced the user projection ...
    expect(fixture.refreshAuthUser).toHaveBeenCalledTimes(1);
    // ... and the same route response carries the verified permissions from
    // a second, post-wait read of the user read model.
    expect(body.actor).toMatchObject({
      sessionId: "ses_1",
      userId: "usr_1",
      accountId: "acc_1",
      membershipId: "mem_1",
      authenticatedAt: SESSION_AUTHENTICATED_AT,
    });
    expect(body.actor.permissions).toEqual(expect.arrayContaining(["accounts.view", "offers.manage"]));
    expect(fixture.services.identity.getUser).toHaveBeenCalledTimes(2);
    expect(body.actor).not.toEqual(fixture.preWaitActors[0]);
  });

  it("(negative control) a /session declaration without the auth_identity_users dependency never waits for the user projection", async () => {
    const mutatedRoutes = withoutUserProjectionDependency(authReadFreshnessRoutes);
    expect(sessionRouteDependencies(mutatedRoutes)).not.toContain(USER_PROJECTION_TABLE);
    const fixture = createFixture({ readFreshnessRoutes: mutatedRoutes });

    const response = await fixture.app.request("/api/auth/session", { headers: receiptHeaders() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { actor: ResolvedActor };
    expect(projectionNames(fixture.audits[0])).toEqual([SESSION_PROJECTION_NAME, MEMBERSHIP_PROJECTION_NAME].sort());
    expect(fixture.refreshAuthUser).not.toHaveBeenCalled();
    // Without the dependency the receipt buys nothing for the user projection:
    // the "fresh" read still reflects the stale, unverified user row.
    expect(body.actor.permissions).not.toContain("offers.manage");
  });

  it("serves an unreceipted read from the current projection without a fresh claim or the verified permissions", async () => {
    const fixture = createFixture();

    const response = await fixture.app.request("/api/auth/session", { headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { actor: ResolvedActor };
    expect(fixture.audits).toHaveLength(1);
    expect(fixture.audits[0]).toMatchObject({ outcome: "missing-receipt", routePaths: ["/session"] });
    expect(fixture.refreshAuthSession).not.toHaveBeenCalled();
    expect(fixture.refreshAuthMembership).not.toHaveBeenCalled();
    expect(fixture.refreshAuthUser).not.toHaveBeenCalled();
    expect(body.actor.permissions).toContain("accounts.view");
    expect(body.actor.permissions).not.toContain("offers.manage");
  });

  it("fails closed with projection_freshness_timeout when the user projection cannot reach the receipt position", async () => {
    const fixture = createFixture({ userProjectionAdvances: false });

    const response = await fixture.app.request("/api/auth/session", { headers: receiptHeaders() });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "projection_freshness_timeout",
        waitMode: "exact-dependency",
        pending: [
          {
            targetContextName: "auth",
            projectionName: USER_PROJECTION_NAME,
            sourceContextName: "identity",
            requiredGlobalPosition: IDENTITY_SOURCE_POSITION,
            lastGlobalPosition: STALE_IDENTITY_POSITION,
          },
        ],
      },
    });
    expect(fixture.audits[0]).toMatchObject({ outcome: "timeout", routePaths: ["/session"] });
    // The route body never ran: the actor was resolved once (pre-wait) and no
    // post-wait resolution happened.
    expect(fixture.services.identity.getUser).toHaveBeenCalledTimes(1);
  });

  it("keeps the unchanged default freshness budget of 2 500 ms when no route tuning overrides it", async () => {
    // Deterministic clock: the middleware and wait start at 0 ms; the first poll
    // sees 2 499 ms elapsed and keeps waiting, the second sees 2 500 ms and
    // fails closed. No production timeout value is touched by this slice.
    const clockReadings = [0, 0, 2_499, 2_500];
    const nowMs = vi.fn(() => (clockReadings.length > 1 ? clockReadings.shift()! : clockReadings[0]));
    const fixture = createFixture({
      userProjectionAdvances: false,
      readConsistency: { timeoutMs: undefined, pollIntervalMs: undefined, nowMs },
    });

    const response = await fixture.app.request("/api/auth/session", { headers: receiptHeaders() });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "projection_freshness_timeout", pending: [{ projectionName: USER_PROJECTION_NAME }] },
    });
    expect(fixture.refreshAuthUser).toHaveBeenCalledTimes(2);
  });

  it("returns 401 for an anonymous receipted read after the wait, with no anonymous exemption from the wait", async () => {
    const fixture = createFixture();

    const response = await fixture.app.request("/api/auth/session", {
      headers: {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: createIdentityReceipt(),
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "auth",
      },
    });

    expect(response.status).toBe(401);
    expect(fixture.audits[0]).toMatchObject({ outcome: "fresh", routePaths: ["/session"] });
    expect(fixture.refreshAuthUser).toHaveBeenCalledTimes(1);
    expect(fixture.preWaitActors).toEqual([null]);
  });

  it("fails closed after the wait when the fresh session read no longer grants an actor", async () => {
    // The pre-wait read still sees the active session; the post-wait read
    // observes the revocation that landed in between.
    const fixture = createFixture({ revokeSessionAfterPreWaitRead: true });

    const response = await fixture.app.request("/api/auth/session", { headers: receiptHeaders() });

    expect(response.status).toBe(401);
    expect(fixture.preWaitActors[0]?.sessionId).toBe("ses_1");
    expect(fixture.authenticatedSessionReads()).toBe(2);
  });
});
