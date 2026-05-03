import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeCommercialAccountType,
  normalizeCommercialTermsStatus,
  normalizeLabel,
  normalizeMoneyAmount,
  normalizePercentageBps,
  type CommercialAccountType,
  type CommercialTermsStatus,
} from "../../../support/runtime-support/common";

export type CommercialTermsScheduleState = Readonly<{
  scheduleId: string | null;
  label: string | null;
  accountType: CommercialAccountType | null;
  marketplaceSalesFeePercentageBps: number | null;
  marketplaceSalesFeeFixedAmount: string | null;
  status: CommercialTermsStatus | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;

export const initialCommercialTermsScheduleState: CommercialTermsScheduleState = {
  scheduleId: null,
  label: null,
  accountType: null,
  marketplaceSalesFeePercentageBps: null,
  marketplaceSalesFeeFixedAmount: null,
  status: null,
  effectiveFrom: null,
  effectiveUntil: null,
};

export type CreateScheduleCommand = Readonly<{
  type: "CreateSchedule";
  scheduleId: string;
  label: string;
  accountType: CommercialAccountType;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type CommercialTermsScheduleCommand = CreateScheduleCommand;

export type ScheduleCreatedEvent = DomainEvent<
  "commercial-terms.schedule.created",
  Readonly<{
    scheduleId: string;
    label: string;
    accountType: CommercialAccountType;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    status: CommercialTermsStatus;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>
>;

export type CommercialTermsScheduleEvent = ScheduleCreatedEvent;

export const decideCommercialTermsSchedule: AggregateDecider<
  CommercialTermsScheduleState,
  CommercialTermsScheduleCommand,
  CommercialTermsScheduleEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateSchedule":
      assert(state.scheduleId === null, "Schedule has already been created.");
      return [
        {
          type: "commercial-terms.schedule.created",
          data: {
            scheduleId: normalizeLabel(command.scheduleId, "Schedule id"),
            label: normalizeLabel(command.label, "Schedule label"),
            accountType: normalizeCommercialAccountType(command.accountType),
            marketplaceSalesFeePercentageBps: normalizePercentageBps(
              command.marketplaceSalesFeePercentageBps,
              "Marketplace sales fee percentage",
            ),
            marketplaceSalesFeeFixedAmount: normalizeMoneyAmount(
              command.marketplaceSalesFeeFixedAmount,
              {
                fieldName: "Marketplace sales fee fixed amount",
                allowZero: true,
              },
            ),
            status: normalizeCommercialTermsStatus(command.status),
            effectiveFrom: ensureIsoTimestamp(
              command.effectiveFrom,
              "Schedule effective from must be an ISO timestamp.",
            ),
            effectiveUntil:
              command.effectiveUntil === null
                ? null
                : ensureIsoTimestamp(
                    command.effectiveUntil,
                    "Schedule effective until must be an ISO timestamp.",
                  ),
          },
        },
      ];
    default:
      throw assertNever(command as never);
  }
};

export const evolveCommercialTermsSchedule: AggregateEvolver<
  CommercialTermsScheduleState,
  CommercialTermsScheduleEvent
> = (state, event) => {
  switch (event.type) {
    case "commercial-terms.schedule.created":
      return {
        scheduleId: event.data.scheduleId,
        label: event.data.label,
        accountType: event.data.accountType,
        marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps,
        marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount,
        status: event.data.status,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    default:
      throw assertNever(event as never);
  }
};
