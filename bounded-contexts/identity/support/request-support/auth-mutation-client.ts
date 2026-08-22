import type {
  RegistrationConsentSubmission,
  SignedRegistrationConsentResolution,
} from "../../features/consents/domain/registration-consent";

/**
 * The Auth-to-Identity mutation contract.
 *
 * Declared here rather than in the `server.ts` barrel so Identity's own tests
 * can assert against the exact type Auth compiles against without importing
 * their context's public surface.
 */
export type IdentityCommandSnapshot = Readonly<{
  aggregate: "account" | "api-key" | "consent" | "invitation" | "membership" | "user";
  id: string;
  version: number;
  status: string;
}>;

export type IdentityAuthMutationClient = Readonly<{
  createGuestAccount: (
    params: Readonly<{
      email: string;
      displayName: string;
    }>,
  ) => Promise<Readonly<{ accountId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  createUser: (
    params: Readonly<{
      email: string;
      displayName: string;
    }>,
  ) => Promise<Readonly<{ userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  /**
   * Mint a registration consent resolution. Callers resolve, then submit the
   * value they were given; nothing else can produce one that verifies.
   */
  resolveRegistrationConsent: () => Promise<SignedRegistrationConsentResolution>;
  createPersonalIdentity: (
    params: Readonly<{
      email?: string | null;
      phone?: string | null;
      displayName: string;
      givenName?: string;
      familyName?: string;
      /** Required, non-optional, non-nullable -- omitting it is a typecheck failure. */
      registrationConsent: RegistrationConsentSubmission;
      foundersBetaAccessStartedAt?: string;
    }>,
  ) => Promise<
    Readonly<{
      userId: string;
      accountId: string;
      membershipId: string;
      snapshots: readonly IdentityCommandSnapshot[];
    }>
  >;
  enablePasswordCredential: (
    params: Readonly<{
      userId: string;
      credentialId: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  registerPasskeyCredential: (
    params: Readonly<{
      userId: string;
      credentialId: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  enableSmsCode: (
    params: Readonly<{
      userId: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  linkSocialLogin: (
    params: Readonly<{
      userId: string;
      providerName: "google" | "facebook";
      providerSubject: string;
      email: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  /**
   * Converge an unclaimed guest Account display name from the placeholder to
   * its bound Guest Contact name. Idempotent: an Account already carrying the
   * requested name resolves with `converged: false` and appends nothing.
   *
   * A 409 is Identity refusing -- the name is held elsewhere, or the Account is
   * outside the one window in which it may converge -- and never a transient
   * failure the caller should retry.
   */
  convergeGuestAccountDisplayName: (
    params: Readonly<{
      accountId: string;
      displayName: string;
    }>,
  ) => Promise<
    Readonly<{
      accountId: string;
      displayName: string;
      converged: boolean;
      snapshots: readonly IdentityCommandSnapshot[];
    }>
  >;
  claimGuestAccount: (
    params: Readonly<{
      accountId: string;
      userId: string;
      roleKey: string;
    }>,
  ) => Promise<Readonly<{ membershipId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  acceptInvitationForUser: (
    params: Readonly<{
      invitationId: string;
      userId: string;
      acceptanceTokenHash: string;
    }>,
  ) => Promise<Readonly<{ membershipId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  issueInvitationAcceptanceToken: (
    params: Readonly<{
      invitationId: string;
      tokenHash: string;
      expiresAt: string;
    }>,
  ) => Promise<
    Readonly<{
      invitationId: string;
      accountId: string;
      email: string;
      roleKey: string;
      expiresAt: string;
      snapshots: readonly IdentityCommandSnapshot[];
    }>
  >;
  verifyInvitationAcceptanceToken: (
    params: Readonly<{
      invitationId: string;
      acceptanceTokenHash: string;
    }>,
  ) => Promise<
    Readonly<{
      invitationId: string;
      accountId: string;
      email: string;
      roleKey: string;
      expiresAt: string;
    }>
  >;
  verifyEmailContactMethod: (
    params: Readonly<{
      userId: string;
      email: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
}>;
