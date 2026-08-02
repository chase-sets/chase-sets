// Public-Presence-owned public event payloads (waitlist slice).

export type WaitlistSourcePayload = Readonly<{
  pagePath: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
}>;

/** Wave-1 cohort quality signals, captured only from sell/both-intent signups. */
export type WaitlistCohortQualityPayload = Readonly<{
  games: readonly string[];
  hasStoreLink: boolean;
  storeUrl: string | null;
  inventorySize: string | null;
}>;

export type WaitlistSignupRecordedPayload = Readonly<{
  signupId: string;
  email: string;
  role: string;
  interests: readonly string[];
  /** Implied early-access consent, granted automatically at signup time (never user-optional). */
  emailConsentAcceptedAt: string;
  /** Optional consent to additional product updates beyond early-access notifications. */
  marketingConsentAcceptedAt: string | null;
  source: WaitlistSourcePayload;
  /** Referring signup's id, set once at initial signup only. Additive/optional so legacy events without it replay as unattributed. */
  referredBySignupId?: string | null;
  /** Additive/optional so legacy events without it replay as an empty cohort-quality record. */
  cohortQuality?: WaitlistCohortQualityPayload;
  recordedAt?: string;
}>;

export type WaitlistSignupUpdatedPayload = WaitlistSignupRecordedPayload &
  Readonly<{
    updatedAt?: string;
  }>;

/**
 * Progressive cohort-quality save from the post-signup welcome page: carries
 * the full merged cohort-quality record (not a delta) so projections replace
 * the read-model columns without re-deriving merge semantics.
 */
export type WaitlistCohortQualityProvidedPayload = Readonly<{
  signupId: string;
  cohortQuality: WaitlistCohortQualityPayload;
  providedAt: string;
}>;

export type WaitlistSignupAdmittedPayload = Readonly<{
  signupId: string;
  email: string;
  waveNumber: 1 | 2 | 3;
  invitationId: string;
  admittedAt: string;
}>;

export type WaitlistReferralCodeReservedPayload = Readonly<{
  codeDigest: string;
  reservedAt: string;
}>;

export type WaitlistReferralCodeIssuedPayload = Readonly<{
  signupId: string;
  publicReferralCode: string;
  issuedAt: string;
}>;

export type WaitlistReferralLinkProvisionedPayload = Readonly<{
  signupId: string;
  provisioningId: string;
  tupleSha256: string;
  referralLinkSha256: string;
  performedByUserId: string;
  issuedAt: string;
}>;

export type PublicPresenceEventPayloads = Readonly<{
  "public-presence.waitlist-signup.recorded": WaitlistSignupRecordedPayload;
  "public-presence.waitlist-signup.updated": WaitlistSignupUpdatedPayload;
  "public-presence.waitlist-signup.cohort-quality-provided": WaitlistCohortQualityProvidedPayload;
  "public-presence.waitlist-signup.admitted": WaitlistSignupAdmittedPayload;
  "public-presence.waitlist-referral-code.reserved": WaitlistReferralCodeReservedPayload;
  "public-presence.waitlist-referral-code.issued": WaitlistReferralCodeIssuedPayload;
  "public-presence.waitlist-referral-link.provisioned": WaitlistReferralLinkProvisionedPayload;
}>;
