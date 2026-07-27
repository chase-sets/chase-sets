import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import { assert, assertNever, type ConsentSubjectType } from "../../../support/runtime-support/common";
import { assertConsentVersionIsPublished, identityConsentPublicationCorpus } from "./consent-bundle";

export type ConsentState = Readonly<{
  id: ConsentId | null;
  subjectType: ConsentSubjectType | null;
  userId: UserId | null;
  accountId: AccountId | null;
  policyKey: string | null;
  policyVersion: string | null;
  recordedAt: string | null;
  status: "unrecorded" | "recorded" | "withdrawn";
  withdrawnAt: string | null;
}>;

export const initialConsentState: ConsentState = {
  id: null,
  subjectType: null,
  userId: null,
  accountId: null,
  policyKey: null,
  policyVersion: null,
  recordedAt: null,
  status: "unrecorded",
  withdrawnAt: null,
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

export type WithdrawConsentCommand = Readonly<{
  type: "WithdrawConsent";
  withdrawnAt: string;
}>;

export type ConsentCommand = RecordConsentCommand | WithdrawConsentCommand;

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

export type ConsentWithdrawnEvent = DomainEvent<
  "identity.consent.withdrawn",
  Readonly<{
    consentId: ConsentId;
    subjectType: ConsentSubjectType;
    userId: UserId | null;
    accountId: AccountId | null;
    policyKey: string;
    policyVersion: string;
    withdrawnAt: string;
  }>
>;

export type ConsentEvent = ConsentRecordedEvent | ConsentWithdrawnEvent;

export const decideConsent: AggregateDecider<ConsentState, ConsentCommand, ConsentEvent> = (state, command) => {
  switch (command.type) {
    case "RecordConsent":
      assert(state.id === null, "Consent has already been recorded.");
      // The publication half of the recording admission. Pure, so it holds on
      // every path into this decider -- route, registration, seed, bootstrap
      // and fixture alike. The activation half needs the authority stream and
      // therefore lives one layer out, in `../api/runtime.ts`.
      assertConsentVersionIsPublished(command.policyKey, command.policyVersion, identityConsentPublicationCorpus);
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
    case "WithdrawConsent":
      assert(state.id !== null, "Consent must be recorded before it can be withdrawn.");
      if (state.status === "withdrawn") {
        return [];
      }
      assert(state.status === "recorded", "Only recorded consent can be withdrawn.");
      assert(state.subjectType !== null, "Recorded consent must have a subject type.");
      assert(state.policyKey !== null, "Recorded consent must have a policy key.");
      assert(state.policyVersion !== null, "Recorded consent must have a policy version.");
      return [
        {
          type: "identity.consent.withdrawn",
          data: {
            consentId: state.id,
            subjectType: state.subjectType,
            userId: state.userId,
            accountId: state.accountId,
            policyKey: state.policyKey,
            policyVersion: state.policyVersion,
            withdrawnAt: command.withdrawnAt,
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveConsent: AggregateEvolver<ConsentState, ConsentEvent> = (state, event) => {
  switch (event.type) {
    case "identity.consent.recorded":
      return {
        id: event.data.consentId,
        subjectType: event.data.subjectType,
        userId: event.data.userId,
        accountId: event.data.accountId,
        policyKey: event.data.policyKey,
        policyVersion: event.data.policyVersion,
        recordedAt: event.data.recordedAt,
        status: "recorded",
        withdrawnAt: null,
      };
    case "identity.consent.withdrawn":
      return { ...state, status: "withdrawn", withdrawnAt: event.data.withdrawnAt };
    default:
      return assertNever(event);
  }
};
