import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  assertNever,
  ensureIsoTimestamp,
  normalizeEmail,
  normalizeSource,
  normalizeWaitlistInterests,
  normalizeWaitlistCommerceIntent,
  PublicPresenceDomainError,
  stableWaitlistSignupId,
  type WaitlistInterest,
  type WaitlistCommerceIntent,
  type WaitlistSource,
} from "./common";

export type WaitlistSignupState = Readonly<{
  signupId: string | null;
  email: string | null;
  role: WaitlistCommerceIntent | null;
  interests: readonly WaitlistInterest[];
  emailConsentAcceptedAt: string | null;
  marketingConsentAcceptedAt: string | null;
  source: WaitlistSource | null;
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
              updatedAt: recordedAt,
            },
          },
        ];
      }

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
        updatedAt: event.data.updatedAt,
      };
    default:
      return assertNever(event);
  }
};
