import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolveRecentAuthenticationStatus, ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import type { AuthenticatedSessionRead } from "../../features/sessions/api/runtime";
import { AUTH_BOOTSTRAP_TENANT_ID } from "../auth-support/constants";
import type { AuthServices, ReservedAuthTokenTransaction } from "./services";
import { resolveActorFromSessionId, startOrResumeReservedAuth } from "./services";

describe("Account lifecycle proof enrollment", () => {
  it("enrolls the real DB proof, excludes it from unit CI, and rejects a deleted proof file", () => {
    const proof = "support/runtime-support/account-lifecycle-authorization.db.test.ts";
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts["test:db"].split(/\s+/)).toContain(proof);
    expect(manifest.scripts["test:unit"]).toContain(`--exclude ${proof}`);
    expect(manifest.scripts["test:db"]).not.toContain("passWithNoTests");
    expect(existsSync(new URL("./account-lifecycle-authorization.db.test.ts", import.meta.url))).toBe(true);
  });

  it("classifies every current interactive caller and all seven overrides", () => {
    const routes = new URL("../api-support/", import.meta.url);
    const files = readdirSync(routes).filter((name) => name.endsWith("-routes.ts"));
    const matching = (pattern: RegExp) =>
      files.filter((name) => pattern.test(readFileSync(new URL(name, routes), "utf8"))).sort();
    expect(matching(/startInteractiveAuth\(/)).toEqual([
      "account-selection-routes.ts",
      "guest-checkout-routes.ts",
      "invitation-routes.ts",
      "magic-link-routes.ts",
      "passkey-routes.ts",
      "password-routes.ts",
      "phone-code-routes.ts",
      "register-routes.ts",
      "social-login-routes.ts",
    ]);
    expect(matching(/membershipsOverride[,:]/)).toEqual([
      "guest-checkout-routes.ts",
      "invitation-routes.ts",
      "magic-link-routes.ts",
      "passkey-routes.ts",
      "phone-code-routes.ts",
      "register-routes.ts",
      "social-login-routes.ts",
    ]);
    // Only Pending Registration consume starts or resumes a reserved Session id.
    expect(matching(/startOrResumeReservedAuth\(/)).toEqual(["magic-link-routes.ts"]);
  });
});

describe("Pending Registration proof enrollment", () => {
  it("runs the real-route DB proof only in the DB profile", () => {
    const proof = "support/api-support/pending-registration.db.test.ts";
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts["test:db"].split(/\s+/)).toContain(proof);
    expect(manifest.scripts["test:unit"]).toContain(`--exclude ${proof}`);
    expect(existsSync(new URL("../api-support/pending-registration.db.test.ts", import.meta.url))).toBe(true);
  });
});

describe("startOrResumeReservedAuth", () => {
  const RESERVED_SESSION = "ses_synthetic_reserved";
  const RESERVED_USER = "usr_synthetic_reserved";
  const RESERVED_ACCOUNT = "acc_synthetic_reserved";
  const STARTED_AT = "2026-11-21T08:00:00.000Z";
  const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
  const owner = {
    membershipId: "mbr_synthetic_reserved",
    accountId: RESERVED_ACCOUNT,
    roleKey: "owner",
    status: "active",
    rolePermissions: ROLE_PERMISSIONS.owner,
  } as const;

  function reservedState(overrides: Partial<AuthenticatedSessionRead["state"]> = {}) {
    return {
      id: RESERVED_SESSION,
      userId: RESERVED_USER,
      accountId: RESERVED_ACCOUNT,
      availableAccountIds: [RESERVED_ACCOUNT],
      authenticationMethod: "magic-link",
      status: "active",
      expiresAt: EXPIRES_AT,
      sessionGeneration: 0,
      ...overrides,
    } as AuthenticatedSessionRead["state"];
  }

  function createReservedServices(
    started: Readonly<{
      state: AuthenticatedSessionRead["state"];
      authenticated: AuthenticatedSessionRead | null;
    }> | null,
  ) {
    const commandHandler = vi.fn(async (input: { command: Record<string, unknown> }) => ({
      state: {
        id: input.command.sessionId,
        userId: input.command.userId,
        accountId: input.command.accountId,
        availableAccountIds: input.command.availableAccountIds,
        authenticationMethod: input.command.authenticationMethod,
        status: "active",
        expiresAt: input.command.expiresAt,
        sessionGeneration: 0,
      },
      storedEvents: [{ recordedAt: STARTED_AT }],
    }));
    const services = {
      db: {
        query: vi.fn(async (sql: string, params?: readonly unknown[]) =>
          sql.includes("FROM auth_identity_accounts")
            ? { rows: (params![0] as string[]).map((account_id) => ({ account_id })) }
            : { rows: [] },
        ),
      },
      auth: {
        issueOpaqueToken: vi.fn(() => "session_token"),
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: { listActiveMembershipsForUser: vi.fn(async () => []) },
      sessions: {
        getSessionState: vi.fn(async () => started?.state ?? null),
        readAuthenticatedSession: vi.fn(async () => started?.authenticated ?? null),
        getSession: vi.fn(async () => null),
        commandHandler,
      },
    } as unknown as AuthServices;
    return { services, commandHandler };
  }

  const params = {
    userId: RESERVED_USER,
    sessionId: RESERVED_SESSION,
    accountId: RESERVED_ACCOUNT,
    authenticationMethod: "magic-link",
    context: {} as never,
    membershipsOverride: [owner],
  } as const;

  /** The caller's open transaction: every statement it runs, and the epochs fencing its Session Token write. */
  function callerTransaction() {
    const client = { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })) };
    const epochs = { enrollOnClient: vi.fn(async (_client: unknown, _keys: readonly string[]) => undefined) };
    const writes = (table: string) =>
      client.query.mock.calls.filter(([sql]) => sql.includes(`INSERT INTO ${table}`)).map(([, values]) => values);
    return { client, epochs, tokens: { client, epochs } as unknown as ReservedAuthTokenTransaction, writes };
  }

  it("starts the reserved id once through the generation-guarded start and writes the token on the caller's transaction", async () => {
    const { services, commandHandler } = createReservedServices(null);
    const { client, epochs, tokens, writes } = callerTransaction();

    const result = await startOrResumeReservedAuth(services, params, tokens);

    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(commandHandler.mock.calls[0]![0].command).toMatchObject({
      type: "StartSession",
      sessionId: RESERVED_SESSION,
      userId: RESERVED_USER,
      accountId: RESERVED_ACCOUNT,
    });
    expect(epochs.enrollOnClient).toHaveBeenCalledWith(client, [`session/${RESERVED_SESSION}`]);
    expect(writes("identity_session_tokens")).toEqual([
      [
        RESERVED_SESSION,
        "hashed:session_token",
        (commandHandler.mock.calls[0]![0].command as { expiresAt: string }).expiresAt,
      ],
    ]);
    expect(services.db.query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO"), expect.anything());
    expect(result).toMatchObject({
      type: "session-started",
      sessionId: RESERVED_SESSION,
      sessionToken: "session_token",
      session: { started_at: STARTED_AT },
    });
  });

  it("resumes this User's active, unexpired, current-generation Session with its account, method, expiry and authentication time", async () => {
    const state = reservedState({ authenticationMethod: "password" });
    const { services, commandHandler } = createReservedServices({
      state,
      // A projection miss (getSession -> null) still resumes from the aggregate.
      authenticated: { state, authenticatedAt: STARTED_AT },
    });
    const { tokens, writes } = callerTransaction();

    const result = await startOrResumeReservedAuth(services, { ...params, accountId: "acc_synthetic_other" }, tokens);

    expect(commandHandler).not.toHaveBeenCalled();
    expect(writes("identity_session_tokens")).toEqual([[RESERVED_SESSION, "hashed:session_token", EXPIRES_AT]]);
    expect(result).toMatchObject({
      type: "session-started",
      session: {
        session_id: RESERVED_SESSION,
        account_id: RESERVED_ACCOUNT,
        authentication_method: "password",
        expires_at: EXPIRES_AT,
        started_at: STARTED_AT,
      },
    });
  });

  it.each([
    ["another User's Session", reservedState({ userId: "usr_synthetic_other" }), STARTED_AT, "same"],
    ["a revoked Session", reservedState({ status: "revoked" }), STARTED_AT, "same"],
    ["an expired Session", reservedState({ expiresAt: "2020-01-01T00:00:00.000Z" }), STARTED_AT, "same"],
    ["a superseded Session Generation", reservedState(), STARTED_AT, "superseded"],
    ["a Session with no authentication moment", reservedState(), null, "same"],
  ] as const)("refuses to resume %s and writes no token", async (_label, state, authenticatedAt, generation) => {
    const { services, commandHandler } = createReservedServices({
      state,
      authenticated: generation === "superseded" ? null : { state, authenticatedAt },
    });
    const { client, tokens } = callerTransaction();

    await expect(startOrResumeReservedAuth(services, params, tokens)).resolves.toBeNull();
    expect(commandHandler).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("writes an existing User's Account Selection token on the caller's transaction, never on the ordinary pool", async () => {
    const { services, commandHandler } = createReservedServices(null);
    vi.mocked(services.identity.listActiveMembershipsForUser).mockResolvedValue([
      { ...owner, accountId: "acc_synthetic_a" },
      { ...owner, accountId: "acc_synthetic_b" },
    ] as never);
    const { epochs, tokens, writes } = callerTransaction();

    const result = await startOrResumeReservedAuth(
      services,
      { userId: RESERVED_USER, sessionId: RESERVED_SESSION, authenticationMethod: "magic-link", context: {} as never },
      tokens,
    );

    expect(result).toMatchObject({
      type: "account-selection-required",
      userId: RESERVED_USER,
      selectionToken: "session_token",
    });
    expect(commandHandler).not.toHaveBeenCalled();
    expect(writes("identity_account_selection_tokens")).toEqual([
      [expect.stringMatching(/^cmd_/), RESERVED_USER, "magic-link", "hashed:session_token", expect.any(String)],
    ]);
    expect(writes("identity_session_tokens")).toEqual([]);
    expect(epochs.enrollOnClient).not.toHaveBeenCalled();
    expect(services.db.query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO"), expect.anything());
  });
});

/**
 * Every identity below is SYNTHETIC and exists only inside this file. None of
 * them corresponds to a seeded, staging, or production session, user, account,
 * or membership -- the `_synthetic_` infix is the marker.
 */
const SYNTHETIC_SESSION_ID = "ses_synthetic_projection_miss";
const SYNTHETIC_USER_ID = "usr_synthetic_projection_miss";
const SYNTHETIC_ACCOUNT_ID = "acc_synthetic_projection_miss";
const SYNTHETIC_MEMBERSHIP_ID = "mbr_synthetic_projection_miss";

/**
 * Frozen, non-governing inputs. The read moment, the session aggregate, the
 * membership, the user, and the expiry are identical in every case below; the
 * ONLY thing that varies is where the moment-of-authentication comes from.
 */
const FROZEN_READ_MOMENT = new Date("2026-08-10T12:00:00.000Z");
const SYNTHETIC_EXPIRES_AT = "2026-08-11T12:00:00.000Z";
/** Authoritative `recordedAt` of a session started well outside any step-up window. */
const SYNTHETIC_OLD_RECORDED_AT = "2026-01-02T03:04:05.678Z";
/** Authoritative `recordedAt` of a session started two minutes before the frozen read. */
const SYNTHETIC_FRESH_RECORDED_AT = "2026-08-10T11:58:00.000Z";
/** Settlement's shipped payout account-management window (ADR 0020's money-surface value). */
const STEP_UP_WINDOW_MINUTES = 15;

function syntheticSessionState() {
  return {
    id: SYNTHETIC_SESSION_ID,
    userId: SYNTHETIC_USER_ID,
    accountId: SYNTHETIC_ACCOUNT_ID,
    availableAccountIds: [SYNTHETIC_ACCOUNT_ID],
    authenticationMethod: "password",
    status: "active",
    expiresAt: SYNTHETIC_EXPIRES_AT,
    sessionGeneration: 0,
  } as AuthenticatedSessionRead["state"];
}

/** Projection miss (`getSession` -> null) with a controlled aggregate-side authority. */
function createServicesWithProjectionMiss(authenticatedAt: string | null) {
  const getSession = vi.fn(async () => null);
  const readAuthenticatedSession = vi.fn(
    async (): Promise<AuthenticatedSessionRead> => ({ state: syntheticSessionState(), authenticatedAt }),
  );

  return {
    services: {
      identity: {
        bootstrapTenantId: "tnt_synthetic_auth",
        getUser: vi.fn(async () => ({
          user_id: SYNTHETIC_USER_ID,
          primary_email: null,
          contact_methods: [],
          social_login_links: [],
        })),
        getActiveMembershipForUserAccount: vi.fn(async () => ({
          membership_id: SYNTHETIC_MEMBERSHIP_ID,
          user_id: SYNTHETIC_USER_ID,
          account_id: SYNTHETIC_ACCOUNT_ID,
          role_key: "owner",
          role_permissions: ["payouts.setup"],
          status: "active",
        })),
      },
      sessions: { getSession, readAuthenticatedSession },
    } as unknown as AuthServices,
    getSession,
    readAuthenticatedSession,
  };
}

function recentlyAuthenticated(authenticatedAt: string | null | undefined) {
  return resolveRecentAuthenticationStatus(
    { authenticatedAt: authenticatedAt ?? null },
    { maxAgeMinutes: STEP_UP_WINDOW_MINUTES, now: FROZEN_READ_MOMENT },
  ).recentlyAuthenticated;
}

describe("resolveActorFromSessionId on a session-projection miss", () => {
  it("resolveActorFromSessionId uses the current reported-content platform-admin preset", async () => {
    const { services } = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);
    const membership = await services.identity.getActiveMembershipForUserAccount(
      SYNTHETIC_USER_ID,
      SYNTHETIC_ACCOUNT_ID,
    );
    for (const roleKey of [
      "platform-admin",
      "owner",
      "manager",
      "fulfillment",
      "viewer",
      "synthetic-no-grants",
      "constructor",
      "__proto__",
    ]) {
      vi.mocked(services.identity.getActiveMembershipForUserAccount).mockResolvedValue({
        ...membership!,
        role_key: roleKey,
        role_permissions: [],
      });
      const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);
      expect(actor).not.toBeNull();
      expect(actor?.roleKey).toBe(roleKey);
      expect(actor?.permissions.includes("reported-content.view")).toBe(roleKey === "platform-admin");
      if (!Object.hasOwn(ROLE_PERMISSIONS, roleKey)) expect(actor?.permissions).toEqual([]);
    }
  });
  it.each(["platform-admin", "owner", "manager", "fulfillment", "viewer"] as const)(
    "resolves the canonical role permissions at sign-in from empty, stale and current snapshots: %s",
    async (roleKey) => {
      for (const stored of [[], ["catalog.manage", "public-presence.view"], [...ROLE_PERMISSIONS[roleKey]]]) {
        const { services } = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);
        vi.mocked(services.identity.getActiveMembershipForUserAccount).mockResolvedValue({
          membership_id: SYNTHETIC_MEMBERSHIP_ID,
          user_id: SYNTHETIC_USER_ID,
          account_id: SYNTHETIC_ACCOUNT_ID,
          role_key: roleKey,
          role_permissions: stored,
          status: "active",
          updated_at: SYNTHETIC_FRESH_RECORDED_AT,
        });
        const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);
        expect([...(actor?.permissions ?? [])].sort()).toEqual([...ROLE_PERMISSIONS[roleKey]].sort());
      }
    },
  );
  it("ignores stored pricing grants outside the current role", async () => {
    const { services } = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);
    const membership = await services.identity.getActiveMembershipForUserAccount(
      SYNTHETIC_USER_ID,
      SYNTHETIC_ACCOUNT_ID,
    );
    vi.mocked(services.identity.getActiveMembershipForUserAccount).mockResolvedValue({
      ...membership!,
      role_key: "viewer",
      role_permissions: ["pricing.manage"],
    });
    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);
    expect(actor?.permissions).not.toContain("pricing.manage");
    expect(actor?.permissions).toContain("pricing.view");
  });
  it.each(["owner", "manager", "fulfillment", "viewer", "platform-admin"])(
    "resolves current pricing presets for empty and stale memberships: %s",
    async (roleKey) => {
      for (const stored of [[], ["accounts.view", "synthetic.retained"]]) {
        for (const projectionHit of [false, true]) {
          const { services } = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);
          vi.mocked(services.identity.getActiveMembershipForUserAccount).mockResolvedValue({
            membership_id: SYNTHETIC_MEMBERSHIP_ID,
            user_id: SYNTHETIC_USER_ID,
            account_id: SYNTHETIC_ACCOUNT_ID,
            role_key: roleKey,
            role_permissions: stored,
            status: "active",
            updated_at: SYNTHETIC_FRESH_RECORDED_AT,
          });
          if (projectionHit) {
            vi.mocked(services.sessions.getSession).mockResolvedValue({
              session_id: SYNTHETIC_SESSION_ID,
              user_id: SYNTHETIC_USER_ID,
              user_display_name: null,
              user_primary_email: null,
              account_id: SYNTHETIC_ACCOUNT_ID,
              account_display_name: null,
              account_name: null,
              available_account_ids: [SYNTHETIC_ACCOUNT_ID],
              authentication_method: "password",
              status: "active",
              expires_at: SYNTHETIC_EXPIRES_AT,
              updated_at: SYNTHETIC_FRESH_RECORDED_AT,
            });
          }
          const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);
          expect(actor?.roleKey).toBe(roleKey);
          expect(actor?.permissions.includes("pricing.view")).toBe(roleKey !== "platform-admin");
          expect(actor?.permissions.includes("pricing.manage")).toBe(["owner", "manager"].includes(roleKey));
          expect(actor?.permissions).not.toContain("synthetic.retained");
          expect(services.sessions.readAuthenticatedSession).toHaveBeenCalledWith(SYNTHETIC_SESSION_ID);
        }
      }
    },
  );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_READ_MOMENT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the exact old authoritative recordedAt", async () => {
    const { services, readAuthenticatedSession } = createServicesWithProjectionMiss(SYNTHETIC_OLD_RECORDED_AT);

    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(readAuthenticatedSession).toHaveBeenCalledWith(SYNTHETIC_SESSION_ID);
    expect(actor?.authenticatedAt).toBe(SYNTHETIC_OLD_RECORDED_AT);
    expect(recentlyAuthenticated(actor?.authenticatedAt)).toBe(false);
  });

  it("preserves the exact fresh authoritative recordedAt", async () => {
    const { services } = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);

    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(actor?.authenticatedAt).toBe(SYNTHETIC_FRESH_RECORDED_AT);
    expect(recentlyAuthenticated(actor?.authenticatedAt)).toBe(true);
  });

  it("reports no authentication moment when the start event is absent, snapshotted away, or unreadable", async () => {
    const { services } = createServicesWithProjectionMiss(null);

    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(actor?.authenticatedAt).toBeNull();
    expect(recentlyAuthenticated(actor?.authenticatedAt)).toBe(false);
  });

  it("keeps every other actor field intact on the fallback path", async () => {
    const { services } = createServicesWithProjectionMiss(SYNTHETIC_OLD_RECORDED_AT);

    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(actor).toMatchObject({
      sessionId: SYNTHETIC_SESSION_ID,
      userId: SYNTHETIC_USER_ID,
      accountId: SYNTHETIC_ACCOUNT_ID,
      membershipId: SYNTHETIC_MEMBERSHIP_ID,
      roleKey: "owner",
    });
    expect(actor?.permissions).toContain("payouts.setup");
  });

  it("keeps aggregate authority when the projection hits", async () => {
    const { services, readAuthenticatedSession } = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);
    const projectedStartedAt = "2026-08-10T11:59:30.000Z";
    (services.sessions.getSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      session_id: SYNTHETIC_SESSION_ID,
      user_id: SYNTHETIC_USER_ID,
      user_display_name: null,
      user_primary_email: null,
      account_id: SYNTHETIC_ACCOUNT_ID,
      account_display_name: null,
      account_name: null,
      available_account_ids: [SYNTHETIC_ACCOUNT_ID],
      authentication_method: "password",
      status: "active",
      expires_at: SYNTHETIC_EXPIRES_AT,
      started_at: projectedStartedAt,
      updated_at: projectedStartedAt,
    });

    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(actor?.authenticatedAt).toBe(SYNTHETIC_FRESH_RECORDED_AT);
    expect(actor?.authenticatedAt).not.toBe(projectedStartedAt);
    expect(readAuthenticatedSession).toHaveBeenCalledWith(SYNTHETIC_SESSION_ID);
  });
});

/**
 * DISCRIMINATING DEFECT CONTROL for the fabricated-read-time bypass this repair
 * removes.
 *
 * Non-governing inputs are frozen and identical across both arms: the same
 * projection miss, the same session aggregate, the same membership, the same
 * `FROZEN_READ_MOMENT`, and the same step-up window. Only the source of the
 * moment-of-authentication varies.
 *
 * - PREDECESSOR (shipped before this repair): `getSessionForAuth` set
 *   `started_at` to `new Date().toISOString()` at read time, so a session
 *   authenticated in January reported "authenticated now" and Settlement's
 *   payout account-management step-up window ADMITTED it.
 * - CANDIDATE: `started_at` comes from the stored `auth.session.started`
 *   event's `recordedAt`, so the same session reports January and the window
 *   REJECTS it.
 *
 * The assertions below are red under the predecessor derivation and green
 * under the candidate's, so this control cannot pass by accident.
 */
describe("fabricated read-time authentication moment (predecessor) vs stored authority (candidate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_READ_MOMENT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The exact derivation the predecessor used on the projection-miss path. */
  function predecessorFabricatedStartedAt(): string {
    return new Date().toISOString();
  }

  it("admits a months-old session under the predecessor derivation and rejects it under the candidate", async () => {
    const { services } = createServicesWithProjectionMiss(SYNTHETIC_OLD_RECORDED_AT);

    const candidateActor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);
    const predecessorAuthenticatedAt = predecessorFabricatedStartedAt();

    // The bypass, reproduced: read time is inside the window no matter how old
    // the session actually is.
    expect(predecessorAuthenticatedAt).toBe(FROZEN_READ_MOMENT.toISOString());
    expect(recentlyAuthenticated(predecessorAuthenticatedAt)).toBe(true);

    // The candidate carries the authority instead, and fails closed.
    expect(candidateActor?.authenticatedAt).toBe(SYNTHETIC_OLD_RECORDED_AT);
    expect(candidateActor?.authenticatedAt).not.toBe(predecessorAuthenticatedAt);
    expect(recentlyAuthenticated(candidateActor?.authenticatedAt)).toBe(false);
  });

  it("admits a session with no resolvable start authority under the predecessor derivation and rejects it under the candidate", async () => {
    const { services } = createServicesWithProjectionMiss(null);

    const candidateActor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(recentlyAuthenticated(predecessorFabricatedStartedAt())).toBe(true);
    expect(candidateActor?.authenticatedAt).toBeNull();
    expect(recentlyAuthenticated(candidateActor?.authenticatedAt)).toBe(false);
  });
});

describe("Projected Capability Grants on Session-backed actors", () => {
  const SYNTHETIC_GRANT = { key: "support.evidence.any-case", assignmentId: "acap_synthetic", version: 3 } as const;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_READ_MOMENT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function servicesWithGrants(grants: readonly (typeof SYNTHETIC_GRANT)[], primaryEmail: string | null = null) {
    const fixture = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);
    const listGrantedAccountCapabilities = vi.fn(async () => grants);
    vi.mocked(fixture.services.identity.getUser).mockResolvedValue({
      user_id: SYNTHETIC_USER_ID,
      primary_email: primaryEmail,
      contact_methods: primaryEmail ? [{ type: "email", value: primaryEmail, verifiedAt: null }] : [],
      social_login_links: [],
    } as never);
    Object.assign(fixture.services.identity, { listGrantedAccountCapabilities });
    return { ...fixture, listGrantedAccountCapabilities };
  }

  it("keeps the any-case key and its administration out of every Auth role preset", () => {
    expect(
      Object.entries(ROLE_PERMISSIONS).flatMap(([roleKey, permissions]) =>
        [roleKey, ...permissions].filter((value) => /support\.evidence|any-case|capabilit/i.test(value)),
      ),
    ).toEqual([]);
  });

  it("enrolls the real DB proof and excludes it from unit CI", () => {
    const proof = "support/runtime-support/account-capability-projection.db.test.ts";
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts["test:db"].split(/\s+/)).toContain(proof);
    expect(manifest.scripts["test:unit"]).toContain(`--exclude ${proof}`);
    expect(existsSync(new URL("./account-capability-projection.db.test.ts", import.meta.url))).toBe(true);
  });

  it("carries the selected Account's current grants read under Auth's tenant", async () => {
    const { services, listGrantedAccountCapabilities } = servicesWithGrants([SYNTHETIC_GRANT]);

    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(actor?.capabilityAssignments).toEqual([SYNTHETIC_GRANT]);
    expect(listGrantedAccountCapabilities).toHaveBeenCalledWith(AUTH_BOOTSTRAP_TENANT_ID, SYNTHETIC_ACCOUNT_ID);
  });

  it("omits capabilityAssignments when the Account holds no grant or no reader is wired", async () => {
    expect(await resolveActorFromSessionId(servicesWithGrants([]).services, SYNTHETIC_SESSION_ID)).not.toHaveProperty(
      "capabilityAssignments",
    );
    const { services } = createServicesWithProjectionMiss(SYNTHETIC_FRESH_RECORDED_AT);
    expect(await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID)).not.toHaveProperty("capabilityAssignments");
  });

  it("withholds grants from an actor whose email is unverified for commerce", async () => {
    // Bypass mutant: dropping the verified-email gate would surface SYNTHETIC_GRANT here.
    const { services, listGrantedAccountCapabilities } = servicesWithGrants(
      [SYNTHETIC_GRANT],
      "synthetic-unverified@chasesets.test",
    );

    const actor = await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID);

    expect(actor).not.toBeNull();
    expect(actor?.permissions).not.toContain("listings.manage");
    expect(actor).not.toHaveProperty("capabilityAssignments");
    expect(listGrantedAccountCapabilities).not.toHaveBeenCalled();
  });

  it("resolves no actor and reads no grant without an active Membership", async () => {
    const { services, listGrantedAccountCapabilities } = servicesWithGrants([SYNTHETIC_GRANT]);
    vi.mocked(services.identity.getActiveMembershipForUserAccount).mockResolvedValue(null as never);

    expect(await resolveActorFromSessionId(services, SYNTHETIC_SESSION_ID)).toBeNull();
    expect(listGrantedAccountCapabilities).not.toHaveBeenCalled();
  });
});
