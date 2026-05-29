import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  assert,
  assertNever,
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  normalizeCommercialTermsStatus,
  normalizeEffectiveWindow,
  normalizeLabel,
  normalizeMoneyAmount,
  normalizePercentageBps,
  type CommercialTermsStatus,
} from "../../../support/runtime-support/common";

export type CommercialAgreementState = Readonly<{
  agreementId: string | null;
  accountId: string | null;
  label: string | null;
  marketplaceSalesFeePercentageBps: number | null;
  marketplaceSalesFeeFixedAmount: string | null;
  shippingAllowancePercentageBps: number | null;
  status: CommercialTermsStatus | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;

export const initialCommercialAgreementState: CommercialAgreementState = {
  agreementId: null,
  accountId: null,
  label: null,
  marketplaceSalesFeePercentageBps: null,
  marketplaceSalesFeeFixedAmount: null,
  shippingAllowancePercentageBps: null,
  status: null,
  effectiveFrom: null,
  effectiveUntil: null,
};

export type CreateAgreementCommand = Readonly<{
  type: "CreateAgreement";
  agreementId: string;
  accountId: string;
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps?: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type ReviseAgreementCommand = Readonly<{
  type: "ReviseAgreement";
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type CommercialAgreementCommand = CreateAgreementCommand | ReviseAgreementCommand;

export type AgreementCreatedEvent = DomainEvent<
  "commercial-terms.agreement.created",
  Readonly<{
    agreementId: string;
    accountId: string;
    label: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps: number;
    status: CommercialTermsStatus;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>
>;

export type AgreementRevisedEvent = DomainEvent<
  "commercial-terms.agreement.revised",
  Readonly<{
    agreementId: string;
    label: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps: number;
    status: CommercialTermsStatus;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>
>;

export type CommercialAgreementEvent = AgreementCreatedEvent | AgreementRevisedEvent;

function normalizeAgreementWindow(effectiveFrom: string, effectiveUntil: string | null) {
  return normalizeEffectiveWindow(effectiveFrom, effectiveUntil, {
    from: "Agreement effective from",
    until: "Agreement effective until",
  });
}

export const decideCommercialAgreement: AggregateDecider<
  CommercialAgreementState,
  CommercialAgreementCommand,
  CommercialAgreementEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateAgreement":
      assert(state.agreementId === null, "Agreement has already been created.");
      const createWindow = normalizeAgreementWindow(command.effectiveFrom, command.effectiveUntil);
      return [
        {
          type: "commercial-terms.agreement.created",
          data: {
            agreementId: normalizeLabel(command.agreementId, "Agreement id"),
            accountId: normalizeLabel(command.accountId, "Account id"),
            label: normalizeLabel(command.label, "Agreement label"),
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
    case "ReviseAgreement":
      assert(state.agreementId !== null, "Agreement must be created before it can be revised.");
      const reviseWindow = normalizeAgreementWindow(command.effectiveFrom, command.effectiveUntil);
      return [
        {
          type: "commercial-terms.agreement.revised",
          data: {
            agreementId: state.agreementId,
            label: normalizeLabel(command.label, "Agreement label"),
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
      throw assertNever(command as never);
  }
};

export const evolveCommercialAgreement: AggregateEvolver<CommercialAgreementState, CommercialAgreementEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "commercial-terms.agreement.created":
      return {
        agreementId: event.data.agreementId,
        accountId: event.data.accountId,
        label: event.data.label,
        marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps,
        marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount,
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        status: event.data.status,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    case "commercial-terms.agreement.revised":
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
      throw assertNever(event as never);
  }
};
