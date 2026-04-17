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
  marketplaceFeePercentageBps: number | null;
  marketplaceFeeFixedAmount: string | null;
  paymentFeePercentageBps: number | null;
  paymentFeeFixedAmount: string | null;
  status: CommercialTermsStatus | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;

export const initialCommercialTermsScheduleState: CommercialTermsScheduleState = {
  scheduleId: null,
  label: null,
  accountType: null,
  marketplaceFeePercentageBps: null,
  marketplaceFeeFixedAmount: null,
  paymentFeePercentageBps: null,
  paymentFeeFixedAmount: null,
  status: null,
  effectiveFrom: null,
  effectiveUntil: null,
};

export type CreateScheduleCommand = Readonly<{
  type: "CreateSchedule";
  scheduleId: string;
  label: string;
  accountType: CommercialAccountType;
  marketplaceFeePercentageBps: number;
  marketplaceFeeFixedAmount: string;
  paymentFeePercentageBps: number;
  paymentFeeFixedAmount: string;
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
    marketplaceFeePercentageBps: number;
    marketplaceFeeFixedAmount: string;
    paymentFeePercentageBps: number;
    paymentFeeFixedAmount: string;
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
            marketplaceFeePercentageBps: normalizePercentageBps(
              command.marketplaceFeePercentageBps,
              "Marketplace fee percentage",
            ),
            marketplaceFeeFixedAmount: normalizeMoneyAmount(
              command.marketplaceFeeFixedAmount,
              {
                fieldName: "Marketplace fee fixed amount",
                allowZero: true,
              },
            ),
            paymentFeePercentageBps: normalizePercentageBps(
              command.paymentFeePercentageBps,
              "Payment fee percentage",
            ),
            paymentFeeFixedAmount: normalizeMoneyAmount(command.paymentFeeFixedAmount, {
              fieldName: "Payment fee fixed amount",
              allowZero: true,
            }),
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
        marketplaceFeePercentageBps: event.data.marketplaceFeePercentageBps,
        marketplaceFeeFixedAmount: event.data.marketplaceFeeFixedAmount,
        paymentFeePercentageBps: event.data.paymentFeePercentageBps,
        paymentFeeFixedAmount: event.data.paymentFeeFixedAmount,
        status: event.data.status,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    default:
      throw assertNever(event as never);
  }
};
