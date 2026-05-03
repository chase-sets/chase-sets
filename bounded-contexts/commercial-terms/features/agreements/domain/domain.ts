import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeCommercialTermsStatus,
  normalizeLabel,
  normalizeMoneyAmount,
  normalizePercentageBps,
  type CommercialTermsStatus,
} from "../../../support/runtime-support/common";

export type CommercialAgreementState = Readonly<{
  agreementId: string | null;
  accountId: string | null;
  label: string | null;
  marketplaceFeePercentageBps: number | null;
  marketplaceFeeFixedAmount: string | null;
  status: CommercialTermsStatus | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;

export const initialCommercialAgreementState: CommercialAgreementState = {
  agreementId: null,
  accountId: null,
  label: null,
  marketplaceFeePercentageBps: null,
  marketplaceFeeFixedAmount: null,
  status: null,
  effectiveFrom: null,
  effectiveUntil: null,
};

export type CreateAgreementCommand = Readonly<{
  type: "CreateAgreement";
  agreementId: string;
  accountId: string;
  label: string;
  marketplaceFeePercentageBps: number;
  marketplaceFeeFixedAmount: string;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type CommercialAgreementCommand = CreateAgreementCommand;

export type AgreementCreatedEvent = DomainEvent<
  "commercial-terms.agreement.created",
  Readonly<{
    agreementId: string;
    accountId: string;
    label: string;
    marketplaceFeePercentageBps: number;
    marketplaceFeeFixedAmount: string;
    status: CommercialTermsStatus;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>
>;

export type CommercialAgreementEvent = AgreementCreatedEvent;

export const decideCommercialAgreement: AggregateDecider<
  CommercialAgreementState,
  CommercialAgreementCommand,
  CommercialAgreementEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateAgreement":
      assert(state.agreementId === null, "Agreement has already been created.");
      return [
        {
          type: "commercial-terms.agreement.created",
          data: {
            agreementId: normalizeLabel(command.agreementId, "Agreement id"),
            accountId: normalizeLabel(command.accountId, "Account id"),
            label: normalizeLabel(command.label, "Agreement label"),
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
            status: normalizeCommercialTermsStatus(command.status),
            effectiveFrom: ensureIsoTimestamp(
              command.effectiveFrom,
              "Agreement effective from must be an ISO timestamp.",
            ),
            effectiveUntil:
              command.effectiveUntil === null
                ? null
                : ensureIsoTimestamp(
                    command.effectiveUntil,
                    "Agreement effective until must be an ISO timestamp.",
                  ),
          },
        },
      ];
    default:
      throw assertNever(command as never);
  }
};

export const evolveCommercialAgreement: AggregateEvolver<
  CommercialAgreementState,
  CommercialAgreementEvent
> = (state, event) => {
  switch (event.type) {
    case "commercial-terms.agreement.created":
      return {
        agreementId: event.data.agreementId,
        accountId: event.data.accountId,
        label: event.data.label,
        marketplaceFeePercentageBps: event.data.marketplaceFeePercentageBps,
        marketplaceFeeFixedAmount: event.data.marketplaceFeeFixedAmount,
        status: event.data.status,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    default:
      throw assertNever(event as never);
  }
};
