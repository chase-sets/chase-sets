import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeEmail,
  normalizeReferralCode,
  normalizeSource,
  normalizeWaitlistGames,
  normalizeWaitlistInterests,
  normalizeWaitlistCommerceIntent,
  normalizeWaitlistInventorySize,
  normalizeWaitlistStoreUrl,
  PublicPresenceDomainError,
  stableWaitlistSignupId,
  type WaitlistGame,
  type WaitlistInterest,
  type WaitlistInventorySize,
  type WaitlistCommerceIntent,
  type WaitlistSource,
} from "./common";

/**
 * Wave-1 cohort quality signals, captured only when a signup expresses
 * sell/both intent. Never a condition of joining the waitlist -- every field
 * is optional and normalizes to its "unset" value rather than rejecting the
 * signup, matching `marketingConsentAcceptedAt`'s optional-consent shape.
 */
export type WaitlistCohortQuality = Readonly<{
  games: readonly WaitlistGame[];
  hasStoreLink: boolean;
  storeUrl: string | null;
  inventorySize: WaitlistInventorySize | null;
}>;

const emptyCohortQuality: WaitlistCohortQuality = {
  games: [],
  hasStoreLink: false,
  storeUrl: null,
  inventorySize: null,
};

function cohortQualityEquals(left: WaitlistCohortQuality, right: WaitlistCohortQuality): boolean {
  return (
    left.hasStoreLink === right.hasStoreLink &&
    left.storeUrl === right.storeUrl &&
    left.inventorySize === right.inventorySize &&
    left.games.length === right.games.length &&
    left.games.every((game, index) => game === right.games[index])
  );
}

function normalizeCohortQuality(
  role: WaitlistCommerceIntent,
  input: Readonly<{
    games?: readonly string[];
    hasStoreLink?: boolean;
    storeUrl?: string | null;
    inventorySize?: string | null;
  }>,
): WaitlistCohortQuality {
  // Buy-only signups never carry seller cohort-quality data, even if a
  // stale client sent some: the quality bar only ever measures sellers.
  if (role === "buy") {
    return emptyCohortQuality;
  }

  const hasStoreLink = Boolean(input.hasStoreLink);
  return {
    games: normalizeWaitlistGames(input.games),
    hasStoreLink,
    storeUrl: normalizeWaitlistStoreUrl(hasStoreLink, input.storeUrl),
    inventorySize: normalizeWaitlistInventorySize(input.inventorySize),
  };
}

export type WaitlistSignupState = Readonly<{
  signupId: string | null;
  email: string | null;
  role: WaitlistCommerceIntent | null;
  interests: readonly WaitlistInterest[];
  emailConsentAcceptedAt: string | null;
  marketingConsentAcceptedAt: string | null;
  source: WaitlistSource | null;
  /** The referring signup's id, set once at initial signup and never overwritten by later updates. */
  referredBySignupId: string | null;
  cohortQuality: WaitlistCohortQuality;
  submittedAt: string | null;
  updatedAt: string | null;
  admission: Readonly<{ waveNumber: 1 | 2 | 3; invitationId: string; admittedAt: string }> | null;
  /** The one immutable Public Referral Code issued with this signup's first write; never reissued. */
  publicReferralCode: string | null;
  publicReferralCodeIssuedAt: string | null;
  /** Code-free audit history of protected referral-link provisionings, keyed by tuple and link digests. */
  referralLinkProvisionings: readonly Readonly<{
    provisioningId: string;
    tupleSha256: string;
    referralLinkSha256: string;
    performedByUserId: string;
    issuedAt: string;
  }>[];
}>;

export const initialWaitlistSignupState: WaitlistSignupState = {
  signupId: null,
  email: null,
  role: null,
  interests: [],
  emailConsentAcceptedAt: null,
  marketingConsentAcceptedAt: null,
  source: null,
  referredBySignupId: null,
  cohortQuality: emptyCohortQuality,
  submittedAt: null,
  updatedAt: null,
  admission: null,
  publicReferralCode: null,
  publicReferralCodeIssuedAt: null,
  referralLinkProvisionings: [],
};

export type RecordWaitlistSignupCommand = Readonly<{
  type: "RecordWaitlistSignup";
  email: string;
  role: string;
  interests: readonly string[];
  /** Optional consent to additional product updates beyond early-access notifications. Early-access consent is implied by signing up and is not user-optional. */
  marketingConsentAcceptedAt: string | null;
  source: WaitlistSource;
  /** Referral code (the referring signup's id) captured from the inbound `?ref=` link, if any. Ignored on updates to an existing signup and when it equals the signer-upper's own id. */
  referredBySignupId?: string | null;
  /** Wave-1 cohort quality signals; see {@link WaitlistCohortQuality}. Ignored (and re-derived as empty) for buy-only signups. */
  games?: readonly string[];
  hasStoreLink?: boolean;
  storeUrl?: string | null;
  inventorySize?: string | null;
  recordedAt: string;
}>;

/**
 * Progressive cohort-quality save from the post-signup welcome page ("help us
 * place you in the right wave"). Each field is optional and individually
 * saved -- only fields present on the command are updated; absent fields keep
 * their recorded values (never a submit-wall). Keyed by the signup's stream,
 * so no email round-trip is required after the initial signup.
 */
export type ProvideWaitlistCohortQualityCommand = Readonly<{
  type: "ProvideWaitlistCohortQuality";
  games?: readonly string[];
  inventorySize?: string | null;
  hasStoreLink?: boolean;
  storeUrl?: string | null;
  providedAt: string;
}>;

export type AdmitWaitlistSignupCommand = Readonly<{
  type: "AdmitWaitlistSignup";
  waveNumber: 1 | 2 | 3;
  invitationId: string;
  admittedAt: string;
}>;

export type WaitlistSignupCommand =
  | RecordWaitlistSignupCommand
  | ProvideWaitlistCohortQualityCommand
  | AdmitWaitlistSignupCommand;

export type WaitlistSignupRecordedEvent = DomainEvent<
  "public-presence.waitlist-signup.recorded",
  Readonly<{
    signupId: string;
    email: string;
    role: WaitlistCommerceIntent;
    interests: WaitlistInterest[];
    emailConsentAcceptedAt: string;
    marketingConsentAcceptedAt: string | null;
    source: WaitlistSource;
    /** Referral attribution captured only at initial signup; never revisited by later updates. */
    referredBySignupId: string | null;
    cohortQuality: WaitlistCohortQuality;
    recordedAt: string;
  }>
>;

export type WaitlistSignupUpdatedEvent = DomainEvent<
  "public-presence.waitlist-signup.updated",
  Readonly<{
    signupId: string;
    email: string;
    role: WaitlistCommerceIntent;
    interests: WaitlistInterest[];
    emailConsentAcceptedAt: string;
    marketingConsentAcceptedAt: string | null;
    source: WaitlistSource;
    cohortQuality: WaitlistCohortQuality;
    updatedAt: string;
  }>
>;

export type WaitlistCohortQualityProvidedEvent = DomainEvent<
  "public-presence.waitlist-signup.cohort-quality-provided",
  Readonly<{
    signupId: string;
    /** The full merged cohort-quality record after this save, never a delta. */
    cohortQuality: WaitlistCohortQuality;
    providedAt: string;
  }>
>;

export type WaitlistSignupAdmittedEvent = DomainEvent<
  "public-presence.waitlist-signup.admitted",
  Readonly<{
    signupId: string;
    email: string;
    waveNumber: 1 | 2 | 3;
    invitationId: string;
    admittedAt: string;
  }>
>;

export type WaitlistReferralCodeIssuedEvent = DomainEvent<
  "public-presence.waitlist-referral-code.issued",
  Readonly<{
    signupId: string;
    publicReferralCode: string;
    issuedAt: string;
  }>
>;

export type WaitlistReferralLinkProvisionedEvent = DomainEvent<
  "public-presence.waitlist-referral-link.provisioned",
  Readonly<{
    signupId: string;
    provisioningId: string;
    tupleSha256: string;
    referralLinkSha256: string;
    performedByUserId: string;
    issuedAt: string;
  }>
>;

export type WaitlistSignupEvent =
  | WaitlistSignupRecordedEvent
  | WaitlistSignupUpdatedEvent
  | WaitlistCohortQualityProvidedEvent
  | WaitlistSignupAdmittedEvent
  | WaitlistReferralCodeIssuedEvent
  | WaitlistReferralLinkProvisionedEvent;

export const decideWaitlistSignup: AggregateDecider<WaitlistSignupState, WaitlistSignupCommand, WaitlistSignupEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "RecordWaitlistSignup": {
      const email = normalizeEmail(command.email);
      const signupId = stableWaitlistSignupId(email);
      const role = normalizeWaitlistCommerceIntent(command.role);
      const interests = normalizeWaitlistInterests(command.interests);
      const recordedAt = ensureIsoTimestamp(command.recordedAt, "Waitlist signup must record a timestamp.");
      // Early-access consent is implied by signing up, not a user-optional
      // control, so it is always granted at the moment the signup records.
      const emailConsentAcceptedAt = recordedAt;
      const marketingConsentAcceptedAt = command.marketingConsentAcceptedAt
        ? ensureIsoTimestamp(command.marketingConsentAcceptedAt, "Marketing consent must record a timestamp.")
        : null;
      const cohortQuality = normalizeCohortQuality(role, command);

      if (state.signupId !== null) {
        return [
          {
            type: "public-presence.waitlist-signup.updated",
            data: {
              signupId: state.signupId,
              email,
              role,
              interests,
              emailConsentAcceptedAt,
              marketingConsentAcceptedAt,
              source: normalizeSource(command.source),
              cohortQuality,
              updatedAt: recordedAt,
            },
          },
        ];
      }

      const referralCandidate = normalizeReferralCode(command.referredBySignupId ?? null);
      // Self-referral (a signer-upper's own code somehow arriving as their
      // referrer) never counts as attribution.
      const referredBySignupId = referralCandidate && referralCandidate !== signupId ? referralCandidate : null;

      return [
        {
          type: "public-presence.waitlist-signup.recorded",
          data: {
            signupId,
            email,
            role,
            interests,
            emailConsentAcceptedAt,
            marketingConsentAcceptedAt,
            source: normalizeSource(command.source),
            referredBySignupId,
            cohortQuality,
            recordedAt,
          },
        },
      ];
    }
    case "ProvideWaitlistCohortQuality": {
      assert(state.signupId !== null, "Join the waitlist before adding wave-placement details.");
      const providedAt = ensureIsoTimestamp(command.providedAt, "Cohort quality must record a timestamp.");

      // Buy-only signups never carry seller cohort-quality data (the quality
      // bar only ever measures sellers), so a stale client's save is a quiet
      // no-op rather than an error -- the signup itself stays untouched.
      if (state.role === "buy") {
        return [];
      }

      const current = state.cohortQuality;
      const hasStoreLink = command.hasStoreLink ?? current.hasStoreLink;
      const nextCohortQuality: WaitlistCohortQuality = {
        games: command.games !== undefined ? normalizeWaitlistGames(command.games) : current.games,
        hasStoreLink,
        storeUrl: normalizeWaitlistStoreUrl(
          hasStoreLink,
          command.storeUrl !== undefined ? command.storeUrl : current.storeUrl,
        ),
        inventorySize:
          command.inventorySize !== undefined
            ? normalizeWaitlistInventorySize(command.inventorySize)
            : current.inventorySize,
      };

      // Individual saves fire per field change; a repeat of the same values
      // (double-click, retried request) must not append a new event.
      if (cohortQualityEquals(current, nextCohortQuality)) {
        return [];
      }

      return [
        {
          type: "public-presence.waitlist-signup.cohort-quality-provided",
          data: {
            signupId: state.signupId,
            cohortQuality: nextCohortQuality,
            providedAt,
          },
        },
      ];
    }
    case "AdmitWaitlistSignup": {
      assert(state.signupId !== null && state.email !== null, "Join the waitlist before beta admission.");
      const admittedAt = ensureIsoTimestamp(command.admittedAt, "Beta admission must record a timestamp.");
      assert([1, 2, 3].includes(command.waveNumber), "Beta admission wave must be 1, 2, or 3.");
      assert(command.invitationId.trim().length > 0, "Beta invitation id is required.");
      if (state.admission) {
        assert(
          state.admission.waveNumber === command.waveNumber && state.admission.invitationId === command.invitationId,
          "Waitlist signup has already been admitted by another wave.",
        );
        return [];
      }
      return [
        {
          type: "public-presence.waitlist-signup.admitted",
          data: {
            signupId: state.signupId,
            email: state.email,
            waveNumber: command.waveNumber,
            invitationId: command.invitationId.trim(),
            admittedAt,
          },
        },
      ];
    }
    default:
      throw new PublicPresenceDomainError(`Unsupported waitlist command: ${JSON.stringify(command)}`);
  }
};

export const evolveWaitlistSignup: AggregateEvolver<WaitlistSignupState, WaitlistSignupEvent> = (state, event) => {
  switch (event.type) {
    case "public-presence.waitlist-signup.recorded":
      return {
        signupId: event.data.signupId,
        email: event.data.email,
        role: event.data.role,
        interests: event.data.interests,
        emailConsentAcceptedAt: event.data.emailConsentAcceptedAt,
        marketingConsentAcceptedAt: event.data.marketingConsentAcceptedAt ?? null,
        source: event.data.source,
        referredBySignupId: event.data.referredBySignupId ?? null,
        cohortQuality: event.data.cohortQuality ?? emptyCohortQuality,
        submittedAt: event.data.recordedAt,
        updatedAt: event.data.recordedAt,
        admission: null,
        // `recorded` is always the first event on a signup stream, so the
        // referral facts that follow it in the same atomic append rebuild from
        // their own events rather than from anything this case carries over.
        publicReferralCode: null,
        publicReferralCodeIssuedAt: null,
        referralLinkProvisionings: [],
      };
    case "public-presence.waitlist-signup.updated":
      return {
        ...state,
        email: event.data.email,
        role: event.data.role,
        interests: event.data.interests,
        emailConsentAcceptedAt: event.data.emailConsentAcceptedAt,
        marketingConsentAcceptedAt: event.data.marketingConsentAcceptedAt ?? null,
        source: event.data.source,
        cohortQuality: event.data.cohortQuality ?? state.cohortQuality,
        updatedAt: event.data.updatedAt,
      };
    case "public-presence.waitlist-signup.cohort-quality-provided":
      return {
        ...state,
        cohortQuality: event.data.cohortQuality,
        updatedAt: event.data.providedAt,
      };
    case "public-presence.waitlist-signup.admitted":
      return {
        ...state,
        admission: {
          waveNumber: event.data.waveNumber,
          invitationId: event.data.invitationId,
          admittedAt: event.data.admittedAt,
        },
        updatedAt: event.data.admittedAt,
      };
    case "public-presence.waitlist-referral-code.issued":
      return {
        ...state,
        publicReferralCode: event.data.publicReferralCode,
        publicReferralCodeIssuedAt: event.data.issuedAt,
      };
    case "public-presence.waitlist-referral-link.provisioned":
      return {
        ...state,
        referralLinkProvisionings: [...state.referralLinkProvisionings, event.data],
      };
    default:
      return assertNever(event);
  }
};
