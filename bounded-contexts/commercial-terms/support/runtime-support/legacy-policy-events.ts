import type { DomainEvent } from "@chase-sets/event-core/domain";
import type {
  PolicyDocumentCreatedEvent,
  PolicyDocumentRevisedEvent,
  PolicyDocumentStatus,
} from "@chase-sets/platform-policy/domain";
import { commercialTermsAgreementPolicyKey, commercialTermsSchedulePolicyKey } from "./terms-policy";
import type { CommercialTermsAgreementPolicyValue, CommercialTermsSchedulePolicyValue } from "./terms-policy";
import type { CommercialAccountType } from "./common";

/**
 * Pre-convergence event shapes. These are immutable history -- streams already
 * contain them and always will -- so this module exists purely to upcast
 * them into the shared `platform-policy.document.*` shape at read time
 * (aggregate replay and projection). Nothing here may change once shipped;
 * only new upcast paths may be added if the aggregate ever needs to evolve
 * further shapes in the future.
 */

export type LegacyScheduleCreatedEvent = DomainEvent<
  "commercial-terms.schedule.created",
  Readonly<{
    scheduleId: string;
    label: string;
    accountType: CommercialAccountType;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps?: number;
    status: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    createdByUserId?: string;
  }>
>;

export type LegacyScheduleRevisedEvent = DomainEvent<
  "commercial-terms.schedule.revised",
  Readonly<{
    scheduleId: string;
    label: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps: number;
    status: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    revisedByUserId?: string;
  }>
>;

export type LegacyAgreementCreatedEvent = DomainEvent<
  "commercial-terms.agreement.created",
  Readonly<{
    agreementId: string;
    accountId: string;
    label: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps?: number;
    status: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    createdByUserId?: string;
  }>
>;

export type LegacyAgreementRevisedEvent = DomainEvent<
  "commercial-terms.agreement.revised",
  Readonly<{
    agreementId: string;
    label: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    shippingAllowancePercentageBps: number;
    status: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    revisedByUserId?: string;
  }>
>;

export type LegacyCommercialTermsPolicyEvent =
  | LegacyScheduleCreatedEvent
  | LegacyScheduleRevisedEvent
  | LegacyAgreementCreatedEvent
  | LegacyAgreementRevisedEvent;

const DEFAULT_SHIPPING_ALLOWANCE_BPS = 500;

export function upcastLegacyScheduleCreated(
  event: LegacyScheduleCreatedEvent,
  fallbackActorUserId: string,
): PolicyDocumentCreatedEvent["data"] {
  const value: CommercialTermsSchedulePolicyValue = {
    label: event.data.label,
    accountType: event.data.accountType,
    marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps,
    marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount,
    shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_BPS,
  };

  return {
    documentId: event.data.scheduleId,
    policyKey: commercialTermsSchedulePolicyKey(event.data.accountType),
    contextName: "commercial-terms",
    schemaSummary:
      "{ label, accountType, marketplaceSalesFeePercentageBps, marketplaceSalesFeeFixedAmount, shippingAllowancePercentageBps }",
    status: event.data.status as PolicyDocumentStatus,
    value,
    effectiveFrom: event.data.effectiveFrom,
    effectiveUntil: event.data.effectiveUntil,
    actorUserId: event.data.createdByUserId ?? fallbackActorUserId,
  };
}

export function upcastLegacyScheduleRevised(
  event: LegacyScheduleRevisedEvent,
  priorValue: CommercialTermsSchedulePolicyValue,
  priorPolicyKey: string,
  fallbackActorUserId: string,
): PolicyDocumentRevisedEvent["data"] {
  const value: CommercialTermsSchedulePolicyValue = {
    label: event.data.label,
    accountType: priorValue.accountType,
    marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps,
    marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount,
    shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
  };

  return {
    documentId: event.data.scheduleId,
    policyKey: priorPolicyKey,
    status: event.data.status as PolicyDocumentStatus,
    value,
    effectiveFrom: event.data.effectiveFrom,
    effectiveUntil: event.data.effectiveUntil,
    actorUserId: event.data.revisedByUserId ?? fallbackActorUserId,
  };
}

export function upcastLegacyAgreementCreated(
  event: LegacyAgreementCreatedEvent,
  fallbackActorUserId: string,
): PolicyDocumentCreatedEvent["data"] {
  const value: CommercialTermsAgreementPolicyValue = {
    label: event.data.label,
    accountId: event.data.accountId,
    marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps,
    marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount,
    shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_BPS,
  };

  return {
    documentId: event.data.agreementId,
    policyKey: commercialTermsAgreementPolicyKey(event.data.accountId),
    contextName: "commercial-terms",
    schemaSummary:
      "{ label, accountId, marketplaceSalesFeePercentageBps, marketplaceSalesFeeFixedAmount, shippingAllowancePercentageBps }",
    status: event.data.status as PolicyDocumentStatus,
    value,
    effectiveFrom: event.data.effectiveFrom,
    effectiveUntil: event.data.effectiveUntil,
    actorUserId: event.data.createdByUserId ?? fallbackActorUserId,
  };
}

export function upcastLegacyAgreementRevised(
  event: LegacyAgreementRevisedEvent,
  priorValue: CommercialTermsAgreementPolicyValue,
  priorPolicyKey: string,
  fallbackActorUserId: string,
): PolicyDocumentRevisedEvent["data"] {
  const value: CommercialTermsAgreementPolicyValue = {
    label: event.data.label,
    accountId: priorValue.accountId,
    marketplaceSalesFeePercentageBps: event.data.marketplaceSalesFeePercentageBps,
    marketplaceSalesFeeFixedAmount: event.data.marketplaceSalesFeeFixedAmount,
    shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
  };

  return {
    documentId: event.data.agreementId,
    policyKey: priorPolicyKey,
    status: event.data.status as PolicyDocumentStatus,
    value,
    effectiveFrom: event.data.effectiveFrom,
    effectiveUntil: event.data.effectiveUntil,
    actorUserId: event.data.revisedByUserId ?? fallbackActorUserId,
  };
}
