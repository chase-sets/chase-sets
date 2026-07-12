import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
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

export type WaitlistSignupCommand = RecordWaitlistSignupCommand;

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

export type WaitlistSignupEvent = WaitlistSignupRecordedEvent | WaitlistSignupUpdatedEvent;

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
    default:
      return assertNever(event);
  }
};
