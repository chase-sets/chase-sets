import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  type ConsentSubjectType,
} from "../common";

export type ConsentState = Readonly<{
  id: ConsentId | null;
  subjectType: ConsentSubjectType | null;
  userId: UserId | null;
  accountId: AccountId | null;
  policyKey: string | null;
  policyVersion: string | null;
  recordedAt: string | null;
}>;

export const initialConsentState: ConsentState = {
  id: null,
  subjectType: null,
  userId: null,
  accountId: null,
  policyKey: null,
  policyVersion: null,
  recordedAt: null,
};

export type RecordConsentCommand = Readonly<{
  type: "RecordConsent";
  consentId: ConsentId;
  subjectType: ConsentSubjectType;
  userId?: UserId;
  accountId?: AccountId;
  policyKey: string;
  policyVersion: string;
  recordedAt: string;
}>;

export type ConsentCommand = RecordConsentCommand;

export type ConsentRecordedEvent = DomainEvent<
  "identity.consent.recorded",
  Readonly<{
    consentId: ConsentId;
    subjectType: ConsentSubjectType;
    userId: UserId | null;
    accountId: AccountId | null;
    policyKey: string;
    policyVersion: string;
    recordedAt: string;
  }>
>;

export type ConsentEvent = ConsentRecordedEvent;

export const decideConsent: AggregateDecider<
  ConsentState,
  ConsentCommand,
  ConsentEvent
> = (state, command) => {
  assert(state.id === null, "Consent has already been recorded.");
  return [
    {
      type: "identity.consent.recorded",
      data: {
        consentId: command.consentId,
        subjectType: command.subjectType,
        userId: command.userId ?? null,
        accountId: command.accountId ?? null,
        policyKey: command.policyKey,
        policyVersion: command.policyVersion,
        recordedAt: command.recordedAt,
      },
    },
  ];
};

export const evolveConsent: AggregateEvolver<ConsentState, ConsentEvent> = (
  state,
  event,
) => ({
  id: event.data.consentId,
  subjectType: event.data.subjectType,
  userId: event.data.userId,
  accountId: event.data.accountId,
  policyKey: event.data.policyKey,
  policyVersion: event.data.policyVersion,
  recordedAt: event.data.recordedAt,
});
