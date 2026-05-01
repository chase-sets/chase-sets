import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
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
  scheduledAt: string | null;
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
  scheduledAt: null,
  sentAt: null,
  completedAt: null,
  failedAt: null,
  failureReason: null,
};

export type SchedulePayoutCommand = Readonly<{
  type: "SchedulePayout";
  payoutId: PayoutId;
  accountId: AccountId;
  amount: string;
  currencyCode: CurrencyCode;
  destinationReference?: string | null;
  note?: string | null;
  scheduledAt: string;
}>;

export type MarkPayoutInTransitCommand = Readonly<{
  type: "MarkPayoutInTransit";
  providerTransferReference?: string | null;
  providerPayoutReference?: string | null;
  providerStatus?: string | null;
  sentAt: string;
}>;

export type CompletePayoutCommand = Readonly<{
  type: "CompletePayout";
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
  | SchedulePayoutCommand
  | MarkPayoutInTransitCommand
  | CompletePayoutCommand
  | FailPayoutCommand;

export type PayoutScheduledEvent = DomainEvent<
  "settlement.payout.scheduled",
  Readonly<{
    payoutId: PayoutId;
    accountId: AccountId;
    amount: string;
    currencyCode: CurrencyCode;
    destinationReference: string | null;
    note: string | null;
    scheduledAt: string;
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

export type PayoutCompletedEvent = DomainEvent<
  "settlement.payout.completed",
  Readonly<{
    payoutId: PayoutId;
    providerStatus: string | null;
    completedAt: string;
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
  | PayoutScheduledEvent
  | PayoutInTransitEvent
  | PayoutCompletedEvent
  | PayoutFailedEvent;

export const decidePayout: AggregateDecider<
  PayoutState,
  PayoutCommand,
  PayoutEvent
> = (state, command) => {
  switch (command.type) {
    case "SchedulePayout":
      assert(state.payoutId === null, "Payout has already been scheduled.");
      return [
        {
          type: "settlement.payout.scheduled",
          data: {
            payoutId: command.payoutId,
            accountId: command.accountId,
            amount: normalizeMoneyAmount(command.amount, {
              fieldName: "Payout amount",
            }),
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            destinationReference: normalizeOptionalText(command.destinationReference),
            note: normalizeOptionalText(command.note),
            scheduledAt: ensureIsoTimestamp(
              command.scheduledAt,
              "Payout scheduling must record a timestamp.",
            ),
          },
        },
      ];
    case "MarkPayoutInTransit":
      assert(state.payoutId !== null, "Payout must be scheduled first.");
      if (state.status === "in-transit") {
        return [];
      }
      assert(state.status === "scheduled", "Only scheduled payouts can be sent.");
      return [
        {
          type: "settlement.payout.in-transit-recorded",
          data: {
            payoutId: state.payoutId,
            providerTransferReference: normalizeOptionalText(
              command.providerTransferReference,
            ),
            providerPayoutReference: normalizeOptionalText(
              command.providerPayoutReference,
            ),
            providerStatus: normalizeOptionalText(command.providerStatus),
            sentAt: ensureIsoTimestamp(
              command.sentAt,
              "Payout send must record a timestamp.",
            ),
          },
        },
      ];
    case "CompletePayout":
      assert(state.payoutId !== null, "Payout must be scheduled first.");
      if (state.status === "completed") {
        return [];
      }
      assert(
        state.status === "scheduled" || state.status === "in-transit",
        "Only scheduled or in-transit payouts can complete.",
      );
      return [
        {
          type: "settlement.payout.completed",
          data: {
            payoutId: state.payoutId,
            providerStatus: normalizeOptionalText(command.providerStatus),
            completedAt: ensureIsoTimestamp(
              command.completedAt,
              "Payout completion must record a timestamp.",
            ),
          },
        },
      ];
    case "FailPayout":
      assert(state.payoutId !== null, "Payout must be scheduled first.");
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
            providerFailureMessage: normalizeOptionalText(
              command.providerFailureMessage,
            ),
            failedAt: ensureIsoTimestamp(
              command.failedAt,
              "Payout failure must record a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolvePayout: AggregateEvolver<
  PayoutState,
  PayoutEvent
> = (state, event) => {
  switch (event.type) {
    case "settlement.payout.scheduled":
      return {
        payoutId: event.data.payoutId,
        accountId: event.data.accountId,
        amount: event.data.amount,
        currencyCode: event.data.currencyCode,
        destinationReference: event.data.destinationReference,
        note: event.data.note,
        status: "scheduled",
        providerTransferReference: null,
        providerPayoutReference: null,
        providerStatus: null,
        providerFailureCode: null,
        providerFailureMessage: null,
        scheduledAt: event.data.scheduledAt,
        sentAt: null,
        completedAt: null,
        failedAt: null,
        failureReason: null,
      };
    case "settlement.payout.in-transit-recorded":
      return {
        ...state,
        status: "in-transit",
        providerTransferReference:
          event.data.providerTransferReference ?? state.providerTransferReference,
        providerPayoutReference:
          event.data.providerPayoutReference ?? state.providerPayoutReference,
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
