import { vi } from "vitest";
import { AUTH_ROLE_PERMISSIONS } from "./constants";
import type { AuthServices, AuthSessionMembership } from "../runtime-support/services";

const DEFAULT_MEMBERSHIP: AuthSessionMembership = {
  membershipId: "mbr_test",
  accountId: "acc_test",
  roleKey: "owner",
  status: "active",
  rolePermissions: AUTH_ROLE_PERMISSIONS.owner,
};

type AuthServicesFakeSession = Readonly<{
  session_id: string;
  user_id: string;
  account_id: string;
  available_account_ids: readonly string[];
  authentication_method: string;
  status: string;
  expires_at: string;
  updated_at: string;
}>;

const DEFAULT_SESSION: AuthServicesFakeSession = {
  session_id: "ses_test",
  user_id: "usr_test",
  account_id: "acc_test",
  available_account_ids: ["acc_test"],
  authentication_method: "password",
  status: "active",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  updated_at: new Date().toISOString(),
};

export type AuthServicesFakeOverrides = Readonly<{
  db?: unknown;
  auth?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  sessions?: Record<string, unknown>;
  registrationAdmission?: Record<string, unknown>;
  session?: Partial<AuthServicesFakeSession>;
  memberships?: readonly AuthSessionMembership[];
  [key: string]: unknown;
}>;

/**
 * Shared AuthServices test double. The `sessions.commandHandler` /
 * `sessions.getSession` pair below was previously re-implemented
 * near-identically across passkey and social-login route tests; route test
 * files compose this baseline with their own db/identity overrides (plain
 * object spread -- the same shallow-merge convention `services.ts` uses for
 * `registrationAdmission`).
 */
export function createAuthServicesFake(overrides: AuthServicesFakeOverrides = {}): AuthServices {
  const { db, auth, identity, sessions, registrationAdmission, session, memberships, ...rest } = overrides;
  const resolvedSession = { ...DEFAULT_SESSION, ...session };
  const resolvedMemberships = memberships ?? [DEFAULT_MEMBERSHIP];

  return {
    db: db ?? { query: vi.fn(async () => ({ rows: [] })) },
    eventStore: { appendToStream: vi.fn(async () => ({ version: 1 })) },
    auth: {
      issueOpaqueToken: vi.fn((prefix: string) => `${prefix}_token`),
      issueChallenge: vi.fn(() => "challenge_value"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
      verifySecret: vi.fn(() => true),
      ...auth,
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUser: vi.fn(async () => ({ user_id: resolvedSession.user_id, status: "active" })),
      getUserByEmail: vi.fn(async () => null),
      getUserByPhone: vi.fn(async () => null),
      getUserBySocialLogin: vi.fn(async () => null),
      findPendingInvitationByEmail: vi.fn(async () => null),
      listActiveMembershipsForUser: vi.fn(async () => resolvedMemberships),
      getActiveMembershipForUserAccount: vi.fn(async () => resolvedMemberships[0] ?? null),
      ...identity,
    },
    sessions: {
      commandHandler: vi.fn(async (input: { command: Record<string, unknown> }) => ({
        version: 1,
        state: {
          id: input.command.sessionId,
          userId: input.command.userId,
          accountId: input.command.accountId,
          availableAccountIds: input.command.availableAccountIds,
          authenticationMethod: input.command.authenticationMethod,
          status: "active",
          expiresAt: input.command.expiresAt,
        },
        storedEvents: [{ recordedAt: new Date().toISOString() }],
      })),
      getSession: vi.fn(async () => resolvedSession),
      ...sessions,
    },
    registrationAdmission: {
      mode: "open",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
      ...registrationAdmission,
    },
    socialLoginProviders: [],
    adminGoogleWorkspaceSso: null,
    notificationOutbox: { enqueueNotification: vi.fn(async () => undefined) },
    projectors: [],
    ...rest,
  } as unknown as AuthServices;
}
