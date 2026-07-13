import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOptionalText,
  type CurrencyCode,
  type PayoutStatus,
} from "../../../support/runtime-support/common";

export type PayoutState = Readonly<{
  payoutId: PayoutId | null;
  accountId: AccountId | null;
  amount: string | null;
  currencyCode: CurrencyCode | null;
  destinationReference: string | null;
  note: string | null;
  status: PayoutStatus | null;
  providerTransferReference: string | null;
  providerPayoutReference: string | null;
  providerStatus: string | null;
  providerFailureCode: string | null;
  providerFailureMessage: string | null;
  notificationEmail: string | null;
  requestedAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
}>;

export const initialPayoutState: PayoutState = {
  payoutId: null,
  accountId: null,
  amount: null,
  currencyCode: null,
  destinationReference: null,
  note: null,
  status: null,
  providerTransferReference: null,
  providerPayoutReference: null,
  providerStatus: null,
  providerFailureCode: null,
  providerFailureMessage: null,
  notificationEmail: null,
  requestedAt: null,
  sentAt: null,
  completedAt: null,
  failedAt: null,
  failureReason: null,
};

export type RequestPayoutCommand = Readonly<{
  type: "RequestPayout";
  payoutId: PayoutId;
  accountId: AccountId;
  amount: string;
  currencyCode: CurrencyCode;
  destinationReference?: string | null;
  note?: string | null;
  notificationEmail?: string | null;
  requestedAt: string;
}>;

export type MarkPayoutInTransitCommand = Readonly<{
  type: "MarkPayoutInTransit";
  providerTransferReference?: string | null;
  providerPayoutReference?: string | null;
  providerStatus?: string | null;
  sentAt: string;
}>;

export type RecordPayoutProviderReferencesCommand = Readonly<{
  type: "RecordPayoutProviderReferences";
  providerTransferReference?: string | null;
  providerPayoutReference?: string | null;
  providerStatus?: string | null;
  recordedAt: string;
}>;

export type CompletePayoutCommand = Readonly<{
  type: "CompletePayout";
  csatOutcomeFact?: JsonObject;
  providerStatus?: string | null;
  completedAt: string;
}>;

export type FailPayoutCommand = Readonly<{
  type: "FailPayout";
  failureReason?: string | null;
  providerStatus?: string | null;
  providerFailureCode?: string | null;
  providerFailureMessage?: string | null;
  failedAt: string;
}>;

export type PayoutCommand =
  | RequestPayoutCommand
  | RecordPayoutProviderReferencesCommand
  | MarkPayoutInTransitCommand
  | CompletePayoutCommand
  | FailPayoutCommand;

export type PayoutRequestedEvent = DomainEvent<
  "settlement.payout.requested",
  Readonly<{
    payoutId: PayoutId;
    accountId: AccountId;
    amount: string;
    currencyCode: CurrencyCode;
    destinationReference: string | null;
    note: string | null;
    notificationEmail: string | null;
    requestedAt: string;
  }>
>;

export type PayoutInTransitEvent = DomainEvent<
  "settlement.payout.in-transit-recorded",
  Readonly<{
    payoutId: PayoutId;
    providerTransferReference: string | null;
    providerPayoutReference: string | null;
    providerStatus: string | null;
    sentAt: string;
  }>
>;

export type PayoutProviderReferencesRecordedEvent = DomainEvent<
  "settlement.payout.provider-references-recorded",
  Readonly<{
    payoutId: PayoutId;
    providerTransferReference: string | null;
    providerPayoutReference: string | null;
    providerStatus: string | null;
    recordedAt: string;
  }>
>;

export type PayoutCompletedEvent = DomainEvent<
  "settlement.payout.completed",
  Readonly<{
    payoutId: PayoutId;
    accountId: AccountId;
    providerStatus: string | null;
    amount: string;
    notificationEmail: string | null;
    completedAt: string;
    csatOutcomeFact?: JsonObject;
  }>
>;

export type PayoutFailedEvent = DomainEvent<
  "settlement.payout.failed",
  Readonly<{
    payoutId: PayoutId;
    failureReason: string | null;
    providerStatus: string | null;
    providerFailureCode: string | null;
    providerFailureMessage: string | null;
    failedAt: string;
  }>
>;

export type PayoutEvent =
  | PayoutRequestedEvent
  | PayoutProviderReferencesRecordedEvent
  | PayoutInTransitEvent
  | PayoutCompletedEvent
  | PayoutFailedEvent;

export const decidePayout: AggregateDecider<PayoutState, PayoutCommand, PayoutEvent> = (state, command) => {
  switch (command.type) {
    case "RequestPayout":
      assert(state.payoutId === null, "Payout has already been requested.");
      return [
        {
          type: "settlement.payout.requested",
          data: {
            payoutId: command.payoutId,
            accountId: command.accountId,
            amount: normalizeMoneyAmount(command.amount, {
              fieldName: "Payout amount",
            }),
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            destinationReference: normalizeOptionalText(command.destinationReference),
            note: normalizeOptionalText(command.note),
            notificationEmail: normalizeOptionalText(command.notificationEmail),
            requestedAt: ensureIsoTimestamp(command.requestedAt, "Payout request must record a timestamp."),
          },
        },
      ];
    case "RecordPayoutProviderReferences": {
      assert(state.payoutId !== null, "Payout must be requested first.");
      assert(
        state.status === "requested" || state.status === "in-transit",
        "Only active payouts can record provider references.",
      );
      const providerTransferReference = normalizeOptionalText(command.providerTransferReference);
      const providerPayoutReference = normalizeOptionalText(command.providerPayoutReference);
      const providerStatus = normalizeOptionalText(command.providerStatus);
      if (
        (providerTransferReference === null || providerTransferReference === state.providerTransferReference) &&
        (providerPayoutReference === null || providerPayoutReference === state.providerPayoutReference) &&
        (providerStatus === null || providerStatus === state.providerStatus)
      ) {
        return [];
      }
      return [
        {
          type: "settlement.payout.provider-references-recorded",
          data: {
            payoutId: state.payoutId,
            providerTransferReference,
            providerPayoutReference,
            providerStatus,
            recordedAt: ensureIsoTimestamp(
              command.recordedAt,
              "Provider reference recording must include a timestamp.",
            ),
          },
        },
      ];
    }
    case "MarkPayoutInTransit":
      assert(state.payoutId !== null, "Payout must be requested first.");
      if (state.status === "in-transit") {
        return [];
      }
      assert(state.status === "requested", "Only requested payouts can be sent.");
      return [
        {
          type: "settlement.payout.in-transit-recorded",
          data: {
            payoutId: state.payoutId,
            providerTransferReference: normalizeOptionalText(command.providerTransferReference),
            providerPayoutReference: normalizeOptionalText(command.providerPayoutReference),
            providerStatus: normalizeOptionalText(command.providerStatus),
            sentAt: ensureIsoTimestamp(command.sentAt, "Payout send must record a timestamp."),
          },
        },
      ];
    case "CompletePayout":
      assert(state.payoutId !== null, "Payout must be requested first.");
      assert(state.accountId !== null, "Payout must reference an account before completion.");
      assert(state.amount !== null, "Payout must include an amount before completion.");
      if (state.status === "completed") {
        return [];
      }
      assert(
        state.status === "requested" || state.status === "in-transit",
        "Only requested or in-transit payouts can complete.",
      );
      return [
        {
          type: "settlement.payout.completed",
          data: {
            payoutId: state.payoutId,
            accountId: state.accountId,
            providerStatus: normalizeOptionalText(command.providerStatus),
            amount: state.amount,
            notificationEmail: state.notificationEmail,
            completedAt: ensureIsoTimestamp(command.completedAt, "Payout completion must record a timestamp."),
            ...(command.csatOutcomeFact ? { csatOutcomeFact: command.csatOutcomeFact } : {}),
          },
        },
      ];
    case "FailPayout":
      assert(state.payoutId !== null, "Payout must be requested first.");
      if (state.status === "failed") {
        return [];
      }
      assert(state.status !== "completed", "Completed payouts cannot fail.");
      return [
        {
          type: "settlement.payout.failed",
          data: {
            payoutId: state.payoutId,
            failureReason: normalizeOptionalText(command.failureReason),
            providerStatus: normalizeOptionalText(command.providerStatus),
            providerFailureCode: normalizeOptionalText(command.providerFailureCode),
            providerFailureMessage: normalizeOptionalText(command.providerFailureMessage),
            failedAt: ensureIsoTimestamp(command.failedAt, "Payout failure must record a timestamp."),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolvePayout: AggregateEvolver<PayoutState, PayoutEvent> = (state, event) => {
  switch (event.type) {
    case "settlement.payout.requested":
      return {
        payoutId: event.data.payoutId,
        accountId: event.data.accountId,
        amount: event.data.amount,
        currencyCode: event.data.currencyCode,
        destinationReference: event.data.destinationReference,
        note: event.data.note,
        status: "requested",
        providerTransferReference: null,
        providerPayoutReference: null,
        providerStatus: null,
        providerFailureCode: null,
        providerFailureMessage: null,
        notificationEmail: event.data.notificationEmail,
        requestedAt: event.data.requestedAt,
        sentAt: null,
        completedAt: null,
        failedAt: null,
        failureReason: null,
      };
    case "settlement.payout.provider-references-recorded":
      return {
        ...state,
        providerTransferReference: event.data.providerTransferReference ?? state.providerTransferReference,
        providerPayoutReference: event.data.providerPayoutReference ?? state.providerPayoutReference,
        providerStatus: event.data.providerStatus ?? state.providerStatus,
      };
    case "settlement.payout.in-transit-recorded":
      return {
        ...state,
        status: "in-transit",
        providerTransferReference: event.data.providerTransferReference ?? state.providerTransferReference,
        providerPayoutReference: event.data.providerPayoutReference ?? state.providerPayoutReference,
        providerStatus: event.data.providerStatus ?? state.providerStatus,
        providerFailureCode: null,
        providerFailureMessage: null,
        sentAt: event.data.sentAt,
      };
    case "settlement.payout.completed":
      return {
        ...state,
        status: "completed",
        providerStatus: event.data.providerStatus ?? state.providerStatus,
        providerFailureCode: null,
        providerFailureMessage: null,
        completedAt: event.data.completedAt,
        failedAt: null,
        failureReason: null,
      };
    case "settlement.payout.failed":
      return {
        ...state,
        status: "failed",
        providerStatus: event.data.providerStatus ?? state.providerStatus,
        providerFailureCode: event.data.providerFailureCode,
        providerFailureMessage: event.data.providerFailureMessage,
        failedAt: event.data.failedAt,
        failureReason: event.data.failureReason,
      };
    default:
      return assertNever(event);
  }
};
