import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  ensureIsoTimestamp,
  normalizeOptionalText,
  normalizePayoutReadinessStatus,
  type PayoutReadinessStatus,
} from "../../../support/runtime-support/common";

export type PayoutReadinessState = Readonly<{
  accountId: AccountId | null;
  status: PayoutReadinessStatus;
  missingRequirements: readonly string[];
  providerReference: string | null;
  updatedAt: string | null;
}>;

export const initialPayoutReadinessState: PayoutReadinessState = {
  accountId: null,
  status: "not-started",
  missingRequirements: [],
  providerReference: null,
  updatedAt: null,
};

export type RecordPayoutReadinessCommand = Readonly<{
  type: "RecordPayoutReadiness";
  accountId: AccountId;
  status: PayoutReadinessStatus;
  missingRequirements?: readonly string[];
  providerReference?: string | null;
  recordedAt: string;
}>;

export type PayoutReadinessCommand = RecordPayoutReadinessCommand;

export type PayoutReadinessRecordedEvent = DomainEvent<
  "settlement.payout-readiness.recorded",
  Readonly<{
    accountId: AccountId;
    status: PayoutReadinessStatus;
    missingRequirements: string[];
    providerReference: string | null;
    recordedAt: string;
  }>
>;

export type PayoutReadinessEvent = PayoutReadinessRecordedEvent;

function normalizeRequirements(values: readonly string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export const decidePayoutReadiness: AggregateDecider<
  PayoutReadinessState,
  PayoutReadinessCommand,
  PayoutReadinessEvent
> = (_state, command) => {
  switch (command.type) {
    case "RecordPayoutReadiness":
      return [
        {
          type: "settlement.payout-readiness.recorded",
          data: {
            accountId: command.accountId,
            status: normalizePayoutReadinessStatus(command.status),
            missingRequirements: normalizeRequirements(command.missingRequirements),
            providerReference: normalizeOptionalText(command.providerReference),
            recordedAt: ensureIsoTimestamp(
              command.recordedAt,
              "Payout readiness recording must include a timestamp.",
            ),
          },
        },
      ];
  }
};

export const evolvePayoutReadiness: AggregateEvolver<
  PayoutReadinessState,
  PayoutReadinessEvent
> = (_state, event) => {
  switch (event.type) {
    case "settlement.payout-readiness.recorded":
      return {
        accountId: event.data.accountId,
        status: event.data.status,
        missingRequirements: event.data.missingRequirements,
        providerReference: event.data.providerReference,
        updatedAt: event.data.recordedAt,
      };
  }
};
