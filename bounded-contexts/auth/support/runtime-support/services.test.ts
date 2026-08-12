import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRecentAuthenticationStatus } from "@chase-sets/auth-context";
import type { AuthenticatedSessionRead } from "../../features/sessions/api/runtime";
import type { AuthServices } from "./services";
import { resolveActorFromSessionId } from "./services";

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

  it("keeps reading the projection when it hits, without consulting the aggregate", async () => {
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

    expect(actor?.authenticatedAt).toBe(projectedStartedAt);
    expect(readAuthenticatedSession).not.toHaveBeenCalled();
  });
});

/**
 * Request-time proof that the reported-content operator grant reaches a live
 * platform-admin actor with no data backfill.
 *
 * `resolveRolePermissions()` unions a membership's STORED projection permission
 * array with the CURRENT `AUTH_ROLE_PERMISSIONS` preset for its role. Freezing
 * the stored array to `[]` in both arms removes the stored table as a possible
 * source of the key, so the only thing that can supply it is the current
 * preset -- which is exactly the claim that "an active platform-admin receives
 * the current preset on its next actor resolution".
 *
 * All identities are SYNTHETIC (`_synthetic_` infix) and exist only in this
 * file.
 */
const SYNTHETIC_PRESET_SESSION_ID = "ses_synthetic_reported_content_preset";
const SYNTHETIC_PRESET_USER_ID = "usr_synthetic_reported_content_preset";
const SYNTHETIC_PRESET_ACCOUNT_ID = "acc_synthetic_reported_content_preset";
const SYNTHETIC_PRESET_MEMBERSHIP_ID = "mbr_synthetic_reported_content_preset";

/**
 * Frozen non-governing inputs: same session, same user, same account, same
 * membership id, same authentication method, same expiry, same EMPTY stored
 * permission array. The ONLY variable is the membership's role key.
 */
function createServicesForRole(roleKey: string) {
  return {
    identity: {
      bootstrapTenantId: "tnt_synthetic_auth",
      getUser: vi.fn(async () => ({
        user_id: SYNTHETIC_PRESET_USER_ID,
        primary_email: null,
        contact_methods: [],
        social_login_links: [],
      })),
      getActiveMembershipForUserAccount: vi.fn(async () => ({
        membership_id: SYNTHETIC_PRESET_MEMBERSHIP_ID,
        user_id: SYNTHETIC_PRESET_USER_ID,
        account_id: SYNTHETIC_PRESET_ACCOUNT_ID,
        role_key: roleKey,
        role_permissions: [] as readonly string[],
        status: "active",
      })),
    },
    sessions: {
      getSession: vi.fn(async () => null),
      readAuthenticatedSession: vi.fn(async (): Promise<AuthenticatedSessionRead> => {
        const state = syntheticSessionState();
        return {
          state: {
            ...state,
            id: SYNTHETIC_PRESET_SESSION_ID,
            userId: SYNTHETIC_PRESET_USER_ID,
            accountId: SYNTHETIC_PRESET_ACCOUNT_ID,
            availableAccountIds: [SYNTHETIC_PRESET_ACCOUNT_ID],
          } as AuthenticatedSessionRead["state"],
          authenticatedAt: SYNTHETIC_FRESH_RECORDED_AT,
        };
      }),
    },
  } as unknown as AuthServices;
}

describe("reported-content operator grant at request time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_READ_MOMENT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolveActorFromSessionId uses the current reported-content platform-admin preset", async () => {
    const platformAdminActor = await resolveActorFromSessionId(
      createServicesForRole("platform-admin"),
      SYNTHETIC_PRESET_SESSION_ID,
    );

    // The stored projection array was empty, so the production resolver can
    // only have obtained this from the current AUTH_ROLE_PERMISSIONS preset --
    // no backfill of stored membership permissions is required.
    expect(platformAdminActor?.roleKey).toBe("platform-admin");
    expect(platformAdminActor?.permissions).toContain("reported-content.view");

    // Same frozen inputs, only the role key varies: an ordinary account role
    // resolves without the operator key.
    const ownerActor = await resolveActorFromSessionId(createServicesForRole("owner"), SYNTHETIC_PRESET_SESSION_ID);

    expect(ownerActor?.roleKey).toBe("owner");
    expect(ownerActor?.permissions).not.toContain("reported-content.view");
    // The owner arm did resolve to a real actor carrying its own preset, so the
    // negative above is the permission check failing -- not a null actor.
    expect(ownerActor?.permissions).toContain("support.manage");
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
