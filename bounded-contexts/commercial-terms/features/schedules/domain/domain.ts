import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  assert,
  assertNever,
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  normalizeCommercialAccountType,
  normalizeCommercialTermsStatus,
  normalizeEffectiveWindow,
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
  shippingAllowancePercentageBps: number | null;
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
  shippingAllowancePercentageBps: null,
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
  shippingAllowancePercentageBps?: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type ReviseScheduleCommand = Readonly<{
  type: "ReviseSchedule";
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type CommercialTermsScheduleCommand = CreateScheduleCommand | ReviseScheduleCommand;

export type ScheduleCreatedEvent = DomainEvent<
  "commercial-terms.schedule.created",
  Readonly<{
    scheduleId: string;
    label: string;
    accountType: CommercialAccountType;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps: number;
    status: CommercialTermsStatus;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>
>;

export type ScheduleRevisedEvent = DomainEvent<
  "commercial-terms.schedule.revised",
  Readonly<{
    scheduleId: string;
    label: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps: number;
    status: CommercialTermsStatus;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>
>;

export type CommercialTermsScheduleEvent = ScheduleCreatedEvent | ScheduleRevisedEvent;

function normalizeScheduleWindow(effectiveFrom: string, effectiveUntil: string | null) {
  return normalizeEffectiveWindow(effectiveFrom, effectiveUntil, {
    from: "Schedule effective from",
    until: "Schedule effective until",
  });
}

export const decideCommercialTermsSchedule: AggregateDecider<
  CommercialTermsScheduleState,
  CommercialTermsScheduleCommand,
  CommercialTermsScheduleEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateSchedule":
      assert(state.scheduleId === null, "Schedule has already been created.");
      const createWindow = normalizeScheduleWindow(command.effectiveFrom, command.effectiveUntil);
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
            marketplaceSalesFeeFixedAmount: normalizeMoneyAmount(command.marketplaceSalesFeeFixedAmount, {
              fieldName: "Marketplace sales fee fixed amount",
              allowZero: true,
            }),
            shippingAllowancePercentageBps: normalizePercentageBps(
              command.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
              "Shipping allowance percentage",
            ),
            status: normalizeCommercialTermsStatus(command.status),
            effectiveFrom: createWindow.effectiveFrom,
            effectiveUntil: createWindow.effectiveUntil,
          },
        },
      ];
    case "ReviseSchedule":
      assert(state.scheduleId !== null, "Schedule must be created before it can be revised.");
      const reviseWindow = normalizeScheduleWindow(command.effectiveFrom, command.effectiveUntil);
      return [
        {
          type: "commercial-terms.schedule.revised",
          data: {
            scheduleId: state.scheduleId,
            label: normalizeLabel(command.label, "Schedule label"),
            marketplaceSalesFeePercentageBps: normalizePercentageBps(
              command.marketplaceSalesFeePercentageBps,
              "Marketplace sales fee percentage",
            ),
            marketplaceSalesFeeFixedAmount: normalizeMoneyAmount(command.marketplaceSalesFeeFixedAmount, {
              fieldName: "Marketplace sales fee fixed amount",
              allowZero: true,
            }),
            shippingAllowancePercentageBps: normalizePercentageBps(
              command.shippingAllowancePercentageBps,
              "Shipping allowance percentage",
            ),
            status: normalizeCommercialTermsStatus(command.status),
            effectiveFrom: reviseWindow.effectiveFrom,
            effectiveUntil: reviseWindow.effectiveUntil,
          },
        },
      ];
    default:
      throw assertNever(command);
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
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        status: event.data.status,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    case "commercial-terms.schedule.revised":
      return {
        ...state,
        label: event.data.label,
        marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps,
        marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount,
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        status: event.data.status,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    default:
      throw assertNever(event);
  }
};
