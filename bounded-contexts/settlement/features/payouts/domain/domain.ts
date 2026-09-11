import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  addMoney,
  assert,
  assertNever,
  compareMoney,
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
  requestedAmount: string | null;
  feeAmount: string | null;
  netAmount: string | null;
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
  requestedAmount: null,
  feeAmount: null,
  netAmount: null,
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
  requestedAmount: string;
  feeAmount: string;
  netAmount: string;
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
    /** Requested amount. Retained as `amount` for historical event compatibility. */
    amount: string;
    requestedAmount?: string;
    feeAmount?: string;
    netAmount?: string;
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
    requestedAmount: string;
    feeAmount: string;
    netAmount: string;
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
    /** Net amount delivered to the connected payout account. */
    amount: string;
    requestedAmount: string;
    feeAmount: string;
    netAmount: string;
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
    requestedAmount: string;
    feeAmount: string;
    netAmount: string;
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
    case "RequestPayout": {
      assert(state.payoutId === null, "Payout has already been requested.");
      const requestedAmount = normalizeMoneyAmount(command.requestedAmount, {
        fieldName: "Payout requested amount",
      });
      const feeAmount = normalizeMoneyAmount(command.feeAmount, {
        fieldName: "Payout fee amount",
        allowZero: true,
      });
      const netAmount = normalizeMoneyAmount(command.netAmount, {
        fieldName: "Payout net amount",
      });
      assert(
        compareMoney(addMoney(netAmount, feeAmount), requestedAmount) === 0,
        "Payout net amount plus fee must equal requested amount.",
      );
      return [
        {
          type: "settlement.payout.requested",
          data: {
            payoutId: command.payoutId,
            accountId: command.accountId,
            amount: requestedAmount,
            requestedAmount,
            feeAmount,
            netAmount,
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            destinationReference: normalizeOptionalText(command.destinationReference),
            note: normalizeOptionalText(command.note),
            notificationEmail: normalizeOptionalText(command.notificationEmail),
            requestedAt: ensureIsoTimestamp(command.requestedAt, "Payout request must record a timestamp."),
          },
        },
      ];
    }
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
      assert(state.requestedAmount !== null, "Payout must include a requested amount before sending.");
      assert(state.feeAmount !== null, "Payout must include a fee amount before sending.");
      assert(state.netAmount !== null, "Payout must include a net amount before sending.");
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
            requestedAmount: state.requestedAmount,
            feeAmount: state.feeAmount,
            netAmount: state.netAmount,
            sentAt: ensureIsoTimestamp(command.sentAt, "Payout send must record a timestamp."),
          },
        },
      ];
    case "CompletePayout":
      assert(state.payoutId !== null, "Payout must be requested first.");
      assert(state.accountId !== null, "Payout must reference an account before completion.");
      assert(state.requestedAmount !== null, "Payout must include a requested amount before completion.");
      assert(state.feeAmount !== null, "Payout must include a fee amount before completion.");
      assert(state.netAmount !== null, "Payout must include a net amount before completion.");
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
            amount: state.netAmount,
            requestedAmount: state.requestedAmount,
            feeAmount: state.feeAmount,
            netAmount: state.netAmount,
            notificationEmail: state.notificationEmail,
            completedAt: ensureIsoTimestamp(command.completedAt, "Payout completion must record a timestamp."),
            ...(command.csatOutcomeFact ? { csatOutcomeFact: command.csatOutcomeFact } : {}),
          },
        },
      ];
    case "FailPayout":
      assert(state.payoutId !== null, "Payout must be requested first.");
      assert(state.requestedAmount !== null, "Payout must include a requested amount before failure.");
      assert(state.feeAmount !== null, "Payout must include a fee amount before failure.");
      assert(state.netAmount !== null, "Payout must include a net amount before failure.");
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
            requestedAmount: state.requestedAmount,
            feeAmount: state.feeAmount,
            netAmount: state.netAmount,
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
        requestedAmount: event.data.requestedAmount ?? event.data.amount,
        feeAmount: event.data.feeAmount ?? "0.00",
        netAmount: event.data.netAmount ?? event.data.amount,
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

export type PayoutMonthState = Readonly<{
  initialized: boolean;
  legacyActivePayoutCount: number;
  activePayoutIds: readonly PayoutId[];
}>;

export const initialPayoutMonthState: PayoutMonthState = {
  initialized: false,
  legacyActivePayoutCount: 0,
  activePayoutIds: [],
};

export type PayoutMonthEvent =
  | DomainEvent<
      "settlement.payout.monthly-baseline-recorded",
      Readonly<{ accountId: AccountId; legacyActivePayoutCount: number; recordedAt: string }>
    >
  | DomainEvent<
      "settlement.payout.monthly-request-counted",
      Readonly<{ accountId: AccountId; payoutId: PayoutId; requestedAt: string }>
    >
  | DomainEvent<
      "settlement.payout.monthly-request-released",
      Readonly<{ accountId: AccountId; payoutId: PayoutId; failedAt: string }>
    >;

export const evolvePayoutMonth: AggregateEvolver<PayoutMonthState, PayoutMonthEvent> = (state, event) => {
  switch (event.type) {
    case "settlement.payout.monthly-baseline-recorded":
      return state.initialized
        ? state
        : {
            ...state,
            initialized: true,
            legacyActivePayoutCount: event.data.legacyActivePayoutCount,
          };
    case "settlement.payout.monthly-request-counted":
      return state.activePayoutIds.includes(event.data.payoutId)
        ? state
        : { ...state, activePayoutIds: [...state.activePayoutIds, event.data.payoutId] };
    case "settlement.payout.monthly-request-released":
      return {
        ...state,
        activePayoutIds: state.activePayoutIds.filter((payoutId) => payoutId !== event.data.payoutId),
      };
    default:
      return assertNever(event);
  }
};

export function payoutMonthHasActivePayout(state: PayoutMonthState) {
  return state.legacyActivePayoutCount > 0 || state.activePayoutIds.length > 0;
}

export function planPayoutMonthRequest(
  state: PayoutMonthState,
  input: Readonly<{
    accountId: AccountId;
    payoutId: PayoutId;
    requestedAt: string;
    legacyActivePayoutCount: number;
  }>,
) {
  assert(
    Number.isSafeInteger(input.legacyActivePayoutCount) && input.legacyActivePayoutCount >= 0,
    "Payout month baseline count must be a non-negative integer.",
  );
  const events: PayoutMonthEvent[] = [];
  let effectiveState = state;
  if (!state.initialized) {
    const baselineEvent: PayoutMonthEvent = {
      type: "settlement.payout.monthly-baseline-recorded",
      data: {
        accountId: input.accountId,
        legacyActivePayoutCount: input.legacyActivePayoutCount,
        recordedAt: ensureIsoTimestamp(input.requestedAt, "Payout month baseline must include a timestamp."),
      },
    };
    events.push(baselineEvent);
    effectiveState = evolvePayoutMonth(effectiveState, baselineEvent);
  }

  const isFirstPayoutOfMonth = !payoutMonthHasActivePayout(effectiveState);
  if (!effectiveState.activePayoutIds.includes(input.payoutId)) {
    events.push({
      type: "settlement.payout.monthly-request-counted",
      data: {
        accountId: input.accountId,
        payoutId: input.payoutId,
        requestedAt: ensureIsoTimestamp(input.requestedAt, "Payout month request must include a timestamp."),
      },
    });
  }
  return { isFirstPayoutOfMonth, events } as const;
}

export function planPayoutMonthFailure(
  state: PayoutMonthState,
  input: Readonly<{
    accountId: AccountId;
    payoutId: PayoutId;
    failedAt: string;
    legacyActivePayoutCount: number;
  }>,
) {
  const events: PayoutMonthEvent[] = [];
  if (!state.initialized) {
    events.push({
      type: "settlement.payout.monthly-baseline-recorded",
      data: {
        accountId: input.accountId,
        legacyActivePayoutCount: Math.max(0, input.legacyActivePayoutCount),
        recordedAt: ensureIsoTimestamp(input.failedAt, "Payout month baseline must include a timestamp."),
      },
    });
  }
  if (state.activePayoutIds.includes(input.payoutId)) {
    events.push({
      type: "settlement.payout.monthly-request-released",
      data: {
        accountId: input.accountId,
        payoutId: input.payoutId,
        failedAt: ensureIsoTimestamp(input.failedAt, "Payout month failure must include a timestamp."),
      },
    });
  }
  return events;
}

export function payoutMonthStreamId(accountId: AccountId, occurredAt: string) {
  const timestamp = ensureIsoTimestamp(occurredAt, "Payout month selection must include a timestamp.");
  return `settlement.payout-month-${accountId}-${timestamp.slice(0, 7)}`;
}

export function payoutUtcMonthWindow(occurredAt: string) {
  const timestamp = ensureIsoTimestamp(occurredAt, "Payout month selection must include a timestamp.");
  const year = Number.parseInt(timestamp.slice(0, 4), 10);
  const monthIndex = Number.parseInt(timestamp.slice(5, 7), 10) - 1;
  return {
    startsAt: new Date(Date.UTC(year, monthIndex, 1)).toISOString(),
    endsAt: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString(),
  } as const;
}
