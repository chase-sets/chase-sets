import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  createTestApp,
  createTestEventStoreContext,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import {
  createPgPool,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { createIdentityAuthRequestClient, type RegistrationConsentSubmission } from "@chase-sets/identity/server";
import { module as authModule } from "../../index";
import { module as identityModule } from "../../../identity/index";
import { buildIdentityApi, type IdentityApiEnv } from "../../../identity/api";
import { createIdentityServices } from "../../../identity/support/runtime-support/services";
import { createIdentityBootstrapContext } from "../../../identity/support/runtime-support/bootstrap-context";
import { resolveRegistrationConsentSigningKeys } from "../../../identity/support/runtime-support/registration-consent-signing";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../../../identity/features/account-capabilities/api/authority";
import {
  mintRegistrationConsentResolution,
  REGISTRATION_CONSENT_FRESHNESS_WINDOW_MS,
} from "../../../identity/features/consents/domain/registration-consent";
import * as consentBundle from "../../../identity/features/consents/domain/consent-bundle";
import { activeRegistrationConsentFixture } from "../../../identity/tests/consent-activation-authority-fixtures";
import { createAuthServices, revokeSession, type AuthServices } from "../runtime-support/services";
import { insertMagicLinkToken, type PendingRegistration } from "../auth-support/store";
import {
  insertActiveAuthIdentityMembershipMirror,
  insertCreatedAuthIdentityAccountMirror,
  insertRegisteredAuthIdentityUserMirror,
} from "../auth-support/identity-projection";
import type { AuthApiEnv } from "./support";
import { registerMagicLinkRoutes } from "./magic-link-routes";

/**
 * The real consume route over real Identity and Auth persistence: Identity's
 * API serves its own database through a stubbed fetch, Sessions and tokens
 * persist in Auth's database, and the link's row lock is held on a separate
 * two-connection pool to the same Auth database. Every identity is synthetic.
 */
const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");

const LOCK_CONNECT_TIMEOUT_MS = 1_000;
const CONSENT_BUNDLE = [
  { policyKey: "terms-of-service", version: "v1", href: "/terms" },
  { policyKey: "privacy-policy", version: "v3", href: "/privacy" },
] as const;
const operatorContext = () =>
  createTestEventStoreContext(
    createInternalSystemTestActor({ userId: "usr_synthetic_operator", accountId: "acc_synthetic_operator" }),
    { tenantId: "ten_synthetic", trace: {} },
  );
let requestOrdinal = 0;
let stageOrdinal = 0;

/** A one-shot injected failure; with `after`, it arms only once its client has run that statement. */
type Fault = Readonly<{ pattern: RegExp; after?: RegExp; fired: { value: boolean } }>;

const fault = (pattern: RegExp, after?: RegExp): Fault => ({ pattern, after, fired: { value: false } });

function throwOnce(target: Fault | null, text: string) {
  if (target && !target.fired.value && target.pattern.test(text)) {
    target.fired.value = true;
    throw Object.assign(new Error("synthetic injected failure"), { code: "infrastructure_failure" });
  }
}

function faultingQueryable(db: PgQueryable, target: Fault): PgQueryable {
  return {
    query: ((sql: string, values?: readonly unknown[]) => {
      throwOnce(target, sql);
      return db.query(sql, values);
    }) as PgQueryable["query"],
  };
}

/** Each checked-out client may wait at `pause` before a matching statement, then fail once per `target`. */
function faultingPool(
  pool: PgTransactionalPool,
  target: Fault | null,
  pause?: Readonly<{ pattern: RegExp; gate: ReturnType<typeof createGate> }>,
): PgTransactionalPool {
  return {
    query: pool.query.bind(pool),
    connect: async (): Promise<PgPoolClient> => {
      const client = await pool.connect();
      let armed = !target?.after;
      return {
        query: (async (sql: string, values?: readonly unknown[]) => {
          if (pause?.pattern.test(sql)) await pause.gate.pass();
          if (armed) throwOnce(target, sql);
          armed ||= target?.after?.test(sql) ?? false;
          return client.query(sql, values);
        }) as PgPoolClient["query"],
        release: (error?: unknown) => client.release(error),
      };
    },
  };
}

/** A latch a call passes through, so a test can hold a lock holder mid-finalization. */
function createGate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let arrivals = 0;
  const watchers: { count: number; resolve: () => void }[] = [];
  return {
    async pass() {
      arrivals += 1;
      const arrival = arrivals;
      for (const watcher of watchers.filter(({ count }) => arrivals >= count)) watcher.resolve();
      await opened;
      return arrival;
    },
    arrived(count: number) {
      return arrivals >= count ? Promise.resolve() : new Promise<void>((resolve) => watchers.push({ count, resolve }));
    },
    open: () => open(),
  };
}

function consentSubmission(
  options: Readonly<{
    resolvedAt?: string;
    affirmed?: boolean;
    requirements?: readonly Readonly<{ policyKey: string; version: string; href: string }>[];
  }> = {},
): RegistrationConsentSubmission {
  return {
    resolution: mintRegistrationConsentResolution({
      requirements: options.requirements ?? CONSENT_BUNDLE,
      resolvedAt: options.resolvedAt ?? new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    }),
    affirmed: options.affirmed ?? true,
  };
}

(base ? describe : describe.skip)(
  "Pending Registration magic-link consume over real Identity and Session persistence",
  () => {
    let pools: Readonly<Record<"identity" | "auth", PgTransactionalPool>>;
    let lockPool: PgTransactionalPool;
    let services: AuthServices;
    let identityFault: Fault | null;
    let identityInterceptor: ((url: string, init?: RequestInit) => Promise<Response | null>) | null;

    beforeAll(async () => {
      const urls = createMultiContextTestDatabaseUrls(base!, ["identity", "auth"], "pending_registration_consume");
      await ensureMultiContextTestDatabases(base!, urls);
      pools = createMultiContextTestPools(urls);
      // The serving process's cap: two direct connections, and a bounded wait behind them.
      lockPool = createPgPool(urls.auth, { max: 2, connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS });
    });

    beforeEach(async () => {
      await resetMultiContextTestSchemas(pools);
      await bootstrapContextDatabase(identityModule, pools.identity);
      await bootstrapContextDatabase(authModule, pools.auth);
      identityFault = null;
      identityInterceptor = null;

      const identityServices = createIdentityServices(pools.identity, {
        capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
      });
      // Two active Consent policies, so a registration appends two Consent streams.
      const consentFixture = await activeRegistrationConsentFixture(identityServices.eventStore!, pools.identity, {
        "terms-of-service": "v1",
        "privacy-policy": "v3",
      });
      vi.spyOn(consentBundle, "resolveConsentBundle").mockImplementation((authority, bundleKey) =>
        consentBundle.resolveConsentBundleAgainstCorpus(authority, bundleKey, consentFixture.publications),
      );
      const inner = identityServices.eventStore!;
      const identityEventStore: EventStore = {
        ...inner,
        appendToStream: async (input: AppendToStreamInput) => {
          throwOnce(identityFault, input.streamId);
          return inner.appendToStream(input);
        },
        appendToStreams: inner.appendToStreams
          ? async (inputs: readonly AppendToStreamInput[]) => {
              for (const input of inputs) throwOnce(identityFault, input.streamId);
              return inner.appendToStreams!(inputs);
            }
          : undefined,
      };
      const identityApp = new Hono<IdentityApiEnv>();
      identityApp.onError(errorHandler);
      identityApp.use("*", async (c, next) => {
        c.set("context", createIdentityBootstrapContext());
        await next();
      });
      identityApp.route("/api/identity", buildIdentityApi({ ...identityServices, eventStore: identityEventStore }));
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const intercepted = await identityInterceptor?.(String(input), init);
        return intercepted ?? identityApp.request(String(input), init);
      });

      services = createAuthServices(pools.auth, {
        pendingRegistrationLocks: lockPool,
        registrationAdmission: { mode: "open", disposableEmailMode: "enforce", disposableEmailDomains: [] },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (pools) await closeMultiContextTestPools({ ...pools, lockPool });
    });

    async function consume(token: string, routeServices: AuthServices = services) {
      requestOrdinal += 1;
      const app = createTestApp<AuthApiEnv>({
        actor: createAnonymousTestActor(),
        context: operatorContext(),
        routes: (routes) => {
          registerMagicLinkRoutes(routes, routeServices);
          routes.onError(errorHandler);
        },
      });
      // The consume limits stay unchanged; each request comes from its own synthetic address.
      const response = await app.request("http://localhost/magic-link/consume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": `198.51.${Math.floor(requestOrdinal / 250) % 250}.${requestOrdinal % 250}`,
        },
        body: JSON.stringify({ token }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    async function stage(label: string, overrides: Partial<PendingRegistration> = {}) {
      stageOrdinal += 1;
      const suffix = `${label}_${stageOrdinal}`;
      const pending: PendingRegistration = {
        displayName: `Staged ${suffix}`,
        givenName: "Staged",
        familyName: label,
        registrationConsent: consentSubmission(),
        reservedUserId: `usr_reserved_${suffix}`,
        reservedSessionId: `ses_reserved_${suffix}`,
        password: {
          credentialId: `pwd_reserved_${suffix}`,
          secretHash: await services.auth.hashPassword(`synthetic-${suffix}`),
        },
        passkey: {
          credentialId: `pk_reserved_${suffix}`,
          externalCredentialId: `synthetic-handle-${suffix}`,
          label: "Synthetic laptop",
          publicKey: `synthetic-public-key-${suffix}`,
          signCount: 0,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
        ...overrides,
      };
      const token = `synthetic-pending-token-${suffix}`;
      const email = `staged-${stageOrdinal}@example.test`;
      await insertMagicLinkToken(pools.auth, {
        tokenId: `cmd_pending_${suffix}`,
        userId: null,
        email,
        tokenHash: services.auth.hashSecret(token),
        deliveryToken: null,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        pendingRegistration: pending,
      });
      return { token, email, pending };
    }

    async function count(db: PgQueryable, from: string, values: readonly unknown[] = []) {
      return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${from}`, values)).rows[0]!.n);
    }

    const identityEvents = (eventType: string, streamId: string, credentialId?: string) =>
      credentialId
        ? count(
            pools.identity,
            "event_store_events WHERE event_type = $1 AND stream_id = $2 AND payload->>'credentialId' = $3",
            [eventType, streamId, credentialId],
          )
        : count(pools.identity, "event_store_events WHERE event_type = $1 AND stream_id = $2", [eventType, streamId]);

    async function linkState(token: string) {
      return (
        await pools.auth.query<{ pending: boolean; consumed: boolean }>(
          `SELECT pending_registration IS NOT NULL AS pending, consumed_at IS NOT NULL AS consumed
         FROM identity_magic_link_tokens WHERE token_hash = $1`,
          [services.auth.hashSecret(token)],
        )
      ).rows[0];
    }

    async function expectRetryable(token: string, sessionId: string) {
      expect(await linkState(token)).toEqual({ pending: true, consumed: false });
      expect(await count(pools.auth, "identity_session_tokens WHERE session_id = $1", [sessionId])).toBe(0);
    }

    /** Exactly one registration, one Session and one committed token for the staged payload. */
    async function expectRegisteredOnce(staged: Awaited<ReturnType<typeof stage>>, sessionToken: unknown) {
      const { pending } = staged;
      const userStream = `identity.user-${pending.reservedUserId}`;
      expect(await identityEvents("identity.user.created", userStream)).toBe(1);
      expect(
        await identityEvents("identity.user.password-credential-attached", userStream, pending.password!.credentialId),
      ).toBe(1);
      expect(await identityEvents("identity.user.passkey-registered", userStream, pending.passkey!.credentialId)).toBe(
        1,
      );
      expect(
        await count(
          pools.identity,
          "event_store_events WHERE event_type = 'identity.consent.recorded' AND payload->>'userId' = $1",
          [pending.reservedUserId],
        ),
      ).toBe(2);
      expect(
        await count(pools.auth, "event_store_events WHERE stream_id = $1 AND event_type = 'auth.session.started'", [
          `auth.session-${pending.reservedSessionId}`,
        ]),
      ).toBe(1);
      // The staged hash is the stored hash: never rehashed, never replaced.
      expect(
        (
          await pools.auth.query(
            "SELECT user_id, secret_hash FROM identity_password_credentials WHERE credential_id = $1",
            [pending.password!.credentialId],
          )
        ).rows,
      ).toEqual([{ user_id: pending.reservedUserId, secret_hash: pending.password!.secretHash }]);
      expect(
        await count(pools.auth, "identity_passkey_credentials WHERE credential_id = $1 AND user_id = $2", [
          pending.passkey!.credentialId,
          pending.reservedUserId,
        ]),
      ).toBe(1);
      expect(
        (
          await pools.auth.query("SELECT token_hash FROM identity_session_tokens WHERE session_id = $1", [
            pending.reservedSessionId,
          ])
        ).rows,
      ).toEqual([{ token_hash: services.auth.hashSecret(String(sessionToken)) }]);
      expect(await services.identity.getUserByEmail(staged.email)).toMatchObject({
        user_id: pending.reservedUserId,
        display_name: pending.displayName,
      });
      expect(await linkState(staged.token)).toEqual({ pending: false, consumed: true });
    }

    /** Auth's projection catching up with a User Identity already committed. */
    async function mirrorIdentityUser(
      created: Readonly<{ userId: string; accountId: string; membershipId: string }>,
      email: string,
      displayName: string,
    ) {
      const updatedAt = new Date().toISOString();
      await insertCreatedAuthIdentityAccountMirror(pools.auth, { accountId: created.accountId, displayName });
      await insertRegisteredAuthIdentityUserMirror(pools.auth, {
        userId: created.userId,
        displayName,
        givenName: "",
        familyName: "",
        email,
        emailVerifiedAt: updatedAt,
        authMethods: ["magic-link"],
        passwordCredentialId: null,
        passkeyCredentialIds: [],
        updatedAt,
      });
      await insertActiveAuthIdentityMembershipMirror(pools.auth, {
        membershipId: created.membershipId,
        userId: created.userId,
        accountId: created.accountId,
        roleKey: "owner",
        updatedAt,
      });
    }

    const registerDirectly = (email: string, displayName: string, reservedUserId: string) =>
      createIdentityAuthRequestClient(new Request("http://localhost/register")).createPersonalIdentity({
        email,
        displayName,
        registrationConsent: consentSubmission(),
        reservedUserId,
      });

    it("finishes a new registration once, commits before responding, and refuses a replay", async () => {
      const staged = await stage("fresh");

      const first = await consume(staged.token);

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ type: "session-started", userId: staged.pending.reservedUserId });
      await expectRegisteredOnce(staged, first.body.sessionToken);
      expect(JSON.stringify(first.body)).not.toContain(staged.pending.password!.secretHash);
      expect((await consume(staged.token)).status).toBe(401);
    });

    const cuts: readonly Readonly<{ name: string; arm: () => AuthServices }>[] = [
      {
        name: "during the Consent append",
        arm: () => {
          identityFault = fault(/^identity\.consent-/);
          return services;
        },
      },
      {
        name: "after the Identity commit, during the Auth mirrors",
        arm: () => ({
          ...services,
          pool: faultingPool(services.pool, fault(/INSERT INTO "?auth_identity_users"?[\s(]/)),
        }),
      },
      {
        name: "after the password credential event, before the Auth credential row",
        arm: () => ({
          ...services,
          db: faultingQueryable(services.db, fault(/INSERT INTO identity_password_credentials/)),
        }),
      },
      {
        name: "after the passkey credential event, before the Auth credential row",
        arm: () => ({
          ...services,
          db: faultingQueryable(services.db, fault(/INSERT INTO identity_passkey_credentials/)),
        }),
      },
      {
        name: "after SessionStarted, before the token write",
        arm: () => ({
          ...services,
          pendingRegistrationLocks: faultingPool(lockPool, fault(/INSERT INTO identity_session_tokens/)),
        }),
      },
      {
        name: "after the token write, before commit",
        arm: () => ({
          ...services,
          // The admission transaction's own COMMIT precedes this one and must still land.
          pendingRegistrationLocks: faultingPool(lockPool, fault(/^COMMIT$/, /INSERT INTO identity_session_tokens/)),
        }),
      },
    ];

    it.each(cuts)("leaves the link retryable when interrupted $name, and the retry completes once", async ({ arm }) => {
      const staged = await stage("cut");
      const routeServices = arm();

      const interrupted = await consume(staged.token, routeServices);

      expect(interrupted.status).toBeGreaterThanOrEqual(500);
      expect(interrupted.body).not.toHaveProperty("sessionToken");
      await expectRetryable(staged.token, staged.pending.reservedSessionId);

      const retried = await consume(staged.token, routeServices);

      expect(retried.status).toBe(200);
      await expectRegisteredOnce(staged, retried.body.sessionToken);
      expect((await consume(staged.token)).status).toBe(401);
    });

    it("refuses to resume a reserved Session revoked between attempts and leaves the link retryable", async () => {
      const staged = await stage("revoked");
      const routeServices = {
        ...services,
        pendingRegistrationLocks: faultingPool(lockPool, fault(/INSERT INTO identity_session_tokens/)),
      };
      expect((await consume(staged.token, routeServices)).status).toBeGreaterThanOrEqual(500);
      await revokeSession(services, { sessionId: staged.pending.reservedSessionId, context: operatorContext() });

      const retried = await consume(staged.token, routeServices);

      expect(retried.status).toBe(401);
      await expectRetryable(staged.token, staged.pending.reservedSessionId);
    });

    it("signs a different existing User in normally and writes none of the staged details", async () => {
      const staged = await stage("existing");
      const existing = await registerDirectly(staged.email, "Existing Owner", "usr_synthetic_existing");
      await mirrorIdentityUser(existing, staged.email, "Existing Owner");

      const response = await consume(staged.token);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ type: "session-started", userId: existing.userId });
      expect(await identityEvents("identity.user.created", `identity.user-${staged.pending.reservedUserId}`)).toBe(0);
      expect(await count(pools.auth, "identity_password_credentials")).toBe(0);
      expect(await count(pools.auth, "identity_passkey_credentials")).toBe(0);
      expect(await services.identity.getUserByEmail(staged.email)).toMatchObject({
        user_id: existing.userId,
        display_name: "Existing Owner",
      });
      expect(await linkState(staged.token)).toEqual({ pending: false, consumed: true });
    });

    it("keeps a claim race retryable until the winner is visible, then signs the winner in", async () => {
      const staged = await stage("race");
      const winner = await registerDirectly(staged.email, "Race Winner", "usr_synthetic_winner");

      const lagged = await consume(staged.token);

      expect(lagged.status).toBe(409);
      await expectRetryable(staged.token, staged.pending.reservedSessionId);
      expect(await identityEvents("identity.user.created", `identity.user-${staged.pending.reservedUserId}`)).toBe(0);

      await mirrorIdentityUser(winner, staged.email, "Race Winner");
      const caughtUp = await consume(staged.token);

      expect(caughtUp.status).toBe(200);
      expect(caughtUp.body).toMatchObject({ type: "session-started", userId: winner.userId });
      expect(await count(pools.auth, "identity_password_credentials")).toBe(0);
      expect(await count(pools.auth, "identity_passkey_credentials")).toBe(0);
      expect(await linkState(staged.token)).toEqual({ pending: false, consumed: true });
    });

    it("commits an existing User's Account Selection token only with the link's consumption", async () => {
      const staged = await stage("selection");
      const existing = await registerDirectly(staged.email, "Selecting Owner", "usr_synthetic_selector");
      await mirrorIdentityUser(existing, staged.email, "Selecting Owner");
      await insertCreatedAuthIdentityAccountMirror(pools.auth, {
        accountId: "acc_synthetic_second",
        displayName: "Second Shop",
      });
      await insertActiveAuthIdentityMembershipMirror(pools.auth, {
        membershipId: "mbr_synthetic_second",
        userId: existing.userId,
        accountId: "acc_synthetic_second",
        roleKey: "owner",
        updatedAt: new Date().toISOString(),
      });
      const selectionTokens = () =>
        count(pools.auth, "identity_account_selection_tokens WHERE user_id = $1", [existing.userId]);
      const routeServices = {
        ...services,
        pendingRegistrationLocks: faultingPool(
          lockPool,
          fault(/^COMMIT$/, /INSERT INTO identity_account_selection_tokens/),
        ),
      };

      const interrupted = await consume(staged.token, routeServices);

      expect(interrupted.status).toBeGreaterThanOrEqual(500);
      expect(interrupted.body).not.toHaveProperty("selectionToken");
      expect(await selectionTokens()).toBe(0);
      expect(await linkState(staged.token)).toEqual({ pending: true, consumed: false });

      const retried = await consume(staged.token, routeServices);

      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ type: "account-selection-required", userId: existing.userId });
      expect(await selectionTokens()).toBe(1);
      expect(await linkState(staged.token)).toEqual({ pending: false, consumed: true });
      expect((await consume(staged.token)).status).toBe(401);
      expect(await selectionTokens()).toBe(1);
      expect(await count(pools.auth, "identity_session_tokens")).toBe(0);
    });

    it("finishes a retry on the link's recorded admission after Identity committed, though the invitation has since expired", async () => {
      const invitationOnly: AuthServices = {
        ...services,
        registrationAdmission: { mode: "invitation", disposableEmailMode: "enforce", disposableEmailDomains: [] },
      };
      const staged = await stage("admitted");
      await pools.auth.query(
        `INSERT INTO auth_identity_invitations (invitation_id, account_id, email, role_key, status, expires_at)
         VALUES ('inv_synthetic_admitted', 'acc_synthetic_inviter', $1, 'owner', 'pending', now() + interval '1 day')`,
        [staged.email],
      );
      // Identity commits the registration, then the Auth mirrors fail, so Auth's projection stays behind.
      const cutBeforeMirrors: AuthServices = {
        ...invitationOnly,
        pool: faultingPool(services.pool, fault(/INSERT INTO "?auth_identity_users"?[\s(]/)),
      };

      const interrupted = await consume(staged.token, cutBeforeMirrors);

      expect(interrupted.status).toBeGreaterThanOrEqual(500);
      expect(await identityEvents("identity.user.created", `identity.user-${staged.pending.reservedUserId}`)).toBe(1);
      expect(await services.identity.getUserByEmail(staged.email)).toBeNull();
      await expectRetryable(staged.token, staged.pending.reservedSessionId);

      await pools.auth.query(
        "UPDATE auth_identity_invitations SET expires_at = now() - interval '1 minute' WHERE invitation_id = 'inv_synthetic_admitted'",
      );
      expect(await services.identity.findPendingInvitationByEmail(staged.email)).toBeNull();

      const retried = await consume(staged.token, cutBeforeMirrors);

      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({
        type: "session-started",
        userId: staged.pending.reservedUserId,
        sessionId: staged.pending.reservedSessionId,
      });
      await expectRegisteredOnce(staged, retried.body.sessionToken);

      // A link never admitted still meets the gate: terminal 403, consumed, nothing registered.
      const unadmitted = await stage("unadmitted");
      const refused = await consume(unadmitted.token, invitationOnly);

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: "registration_admission_required" } });
      expect(await linkState(unadmitted.token)).toEqual({ pending: false, consumed: true });
      expect(await identityEvents("identity.user.created", `identity.user-${unadmitted.pending.reservedUserId}`)).toBe(
        0,
      );
    });

    async function waitForRowLockWaiter() {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const waiting = await count(
          pools.auth,
          "pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'",
        );
        if (waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("The same-link waiter never blocked on the link's row lock.");
    }

    const holdRegistrationCalls = (gate: ReturnType<typeof createGate>) => {
      identityInterceptor = async (url) => {
        if (!url.endsWith("/personal-identities")) return null;
        await gate.pass();
        return null;
      };
    };

    it("answers a same-link waiter with 401 once the holder commits", async () => {
      const staged = await stage("waiter");
      const gate = createGate();
      holdRegistrationCalls(gate);

      const holder = consume(staged.token);
      await gate.arrived(1);
      const waiter = consume(staged.token);
      await waitForRowLockWaiter();
      gate.open();

      const [held, waited] = await Promise.all([holder, waiter]);
      expect(held.status).toBe(200);
      expect(waited.status).toBe(401);
      await expectRegisteredOnce(staged, held.body.sessionToken);
    });

    it("lets a same-link waiter resume the holder's started Session when the holder fails just before commit", async () => {
      const staged = await stage("takeover");
      const sessionStarts = () =>
        count(pools.auth, "event_store_events WHERE stream_id = $1 AND event_type = 'auth.session.started'", [
          `auth.session-${staged.pending.reservedSessionId}`,
        ]);
      const tokenWrite = createGate();
      const routeServices = {
        ...services,
        // The holder pauses at its token write, after SessionStarted, and later fails its final COMMIT.
        pendingRegistrationLocks: faultingPool(lockPool, fault(/^COMMIT$/, /INSERT INTO identity_session_tokens/), {
          pattern: /INSERT INTO identity_session_tokens/,
          gate: tokenWrite,
        }),
      };

      const holder = consume(staged.token, routeServices);
      await tokenWrite.arrived(1);
      expect(await sessionStarts()).toBe(1);
      const waiter = consume(staged.token, routeServices);
      await waitForRowLockWaiter();

      // The holder and its same-link waiter occupy both lock connections: ordinary Auth work
      // still finishes, and a third lock checkout times out.
      expect(await services.identity.getUserByEmail(staged.email)).toMatchObject({
        user_id: staged.pending.reservedUserId,
      });
      await expect(lockPool.connect().then((client) => client.release())).rejects.toThrow(/timeout/i);

      tokenWrite.open();
      const [held, waited] = await Promise.all([holder, waiter]);

      expect(held.status).toBeGreaterThanOrEqual(500);
      expect(held.body).not.toHaveProperty("sessionToken");
      expect(waited.status).toBe(200);
      expect(waited.body).toMatchObject({ type: "session-started", sessionId: staged.pending.reservedSessionId });
      expect(await sessionStarts()).toBe(1);
      await expectRegisteredOnce(staged, waited.body.sessionToken);
    });

    it.each(["per-link gates", "one shared gate"] as const)(
      "lets two holders progress on the two lock connections with %s while ordinary Auth work finishes and a third consume times out",
      async (mode) => {
        const first = await stage("holder");
        const second = await stage("holder");
        const third = await stage("holder");
        const firstGate = createGate();
        const secondGate = mode === "one shared gate" ? firstGate : createGate();
        identityInterceptor = async (url, init) => {
          if (!url.endsWith("/personal-identities")) return null;
          const { email } = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
          await (email === second.email ? secondGate : firstGate).pass();
          return null;
        };

        const holders = [consume(first.token), consume(second.token)];
        await (mode === "one shared gate"
          ? firstGate.arrived(2)
          : Promise.all([firstGate.arrived(1), secondGate.arrived(1)]));

        // Both lock connections are held; the ordinary Auth pool still serves.
        expect(await services.identity.getUserByEmail(first.email)).toBeNull();
        expect(await count(services.db, "identity_magic_link_tokens WHERE pending_registration IS NOT NULL")).toBe(3);
        // A third Pending Registration consume waits behind the cap, times out, and leaves its link untouched.
        expect((await consume(third.token)).status).toBeGreaterThanOrEqual(500);
        await expectRetryable(third.token, third.pending.reservedSessionId);

        firstGate.open();
        secondGate.open();
        const [heldFirst, heldSecond] = await Promise.all(holders);
        expect(heldFirst.status).toBe(200);
        expect(heldSecond.status).toBe(200);
        await expectRegisteredOnce(first, heldFirst.body.sessionToken);
        await expectRegisteredOnce(second, heldSecond.body.sessionToken);

        // The refused link finishes once a connection is free.
        identityInterceptor = null;
        const retried = await consume(third.token);
        expect(retried.status).toBe(200);
        await expectRegisteredOnce(third, retried.body.sessionToken);
      },
    );

    const stagedConsentCases: readonly (readonly [
      reason: string,
      consent: () => RegistrationConsentSubmission | undefined,
      code: string,
    ])[] = [
      ["absent", () => undefined, "registration_consent_not_server_minted"],
      [
        "stale",
        () =>
          consentSubmission({
            resolvedAt: new Date(Date.now() - REGISTRATION_CONSENT_FRESHNESS_WINDOW_MS - 60_000).toISOString(),
          }),
        "registration_consent_expired",
      ],
      ["unaffirmed", () => consentSubmission({ affirmed: false }), "registration_consent_affirmation_required"],
      [
        "superseded",
        () => consentSubmission({ requirements: [CONSENT_BUNDLE[0], { ...CONSENT_BUNDLE[1], version: "v2" }] }),
        "registration_consent_expired",
      ],
    ];

    it.each(stagedConsentCases)(
      "finishes the link with Identity's terminal 400 and writes nothing when the staged consent is %s",
      async (reason, consent, code) => {
        const staged = await stage("consent", { registrationConsent: consent() as RegistrationConsentSubmission });
        const identityEventsBefore = await count(pools.identity, "event_store_events");

        const response = await consume(staged.token);

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ error: { code, reason } });
        expect(JSON.stringify(response.body)).not.toContain(staged.pending.password!.secretHash);
        expect(await linkState(staged.token)).toEqual({ pending: false, consumed: true });
        // No Account, User, Membership or Consent write in Identity, and nothing mirrored or issued in Auth.
        expect(await count(pools.identity, "event_store_events")).toBe(identityEventsBefore);
        for (const table of [
          "auth_identity_accounts",
          "auth_identity_users",
          "auth_identity_user_memberships",
          "identity_password_credentials",
          "identity_passkey_credentials",
          "identity_session_tokens",
          "identity_account_selection_tokens",
        ]) {
          expect(await count(pools.auth, table), table).toBe(0);
        }
      },
    );
  },
);
