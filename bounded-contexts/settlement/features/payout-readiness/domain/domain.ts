import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  ensureIsoTimestamp,
  normalizeProviderCapabilityStatus,
  normalizeProviderPayoutAccountDashboard,
  normalizeProviderPayoutAccountResponsibility,
  normalizeProviderPayoutDestinationStatus,
  normalizeProviderSetupStatus,
  normalizeOptionalText,
  normalizePayoutReadinessStatus,
  type ProviderCapabilityStatus,
  type ProviderPayoutAccountDashboard,
  type ProviderPayoutAccountResponsibility,
  type ProviderPayoutDestinationStatus,
  type ProviderSetupStatus,
  type PayoutReadinessStatus,
} from "../../../support/runtime-support/common";

export type PayoutReadinessState = Readonly<{
  accountId: AccountId | null;
  status: PayoutReadinessStatus;
  missingRequirements: readonly string[];
  providerReference: string | null;
  onboardingStatus: ProviderSetupStatus;
  transferCapabilityStatus: ProviderCapabilityStatus;
  payoutCapabilityStatus: ProviderCapabilityStatus;
  payoutDestinationStatus: ProviderPayoutDestinationStatus;
  payoutAccountDashboard: ProviderPayoutAccountDashboard;
  lossesCollector: ProviderPayoutAccountResponsibility;
  feesCollector: ProviderPayoutAccountResponsibility;
  requirementsCollector: ProviderPayoutAccountResponsibility;
  updatedAt: string | null;
}>;

export const initialPayoutReadinessState: PayoutReadinessState = {
  accountId: null,
  status: "not-started",
  missingRequirements: [],
  providerReference: null,
  onboardingStatus: "not-started",
  transferCapabilityStatus: "inactive",
  payoutCapabilityStatus: "inactive",
  payoutDestinationStatus: "missing",
  payoutAccountDashboard: "unknown",
  lossesCollector: "unknown",
  feesCollector: "unknown",
  requirementsCollector: "unknown",
  updatedAt: null,
};

export type RecordPayoutReadinessCommand = Readonly<{
  type: "RecordPayoutReadiness";
  accountId: AccountId;
  status: PayoutReadinessStatus;
  missingRequirements?: readonly string[];
  providerReference?: string | null;
  onboardingStatus?: ProviderSetupStatus | string;
  transferCapabilityStatus?: ProviderCapabilityStatus | string;
  payoutCapabilityStatus?: ProviderCapabilityStatus | string;
  payoutDestinationStatus?: ProviderPayoutDestinationStatus | string;
  payoutAccountDashboard?: ProviderPayoutAccountDashboard | string;
  lossesCollector?: ProviderPayoutAccountResponsibility | string;
  feesCollector?: ProviderPayoutAccountResponsibility | string;
  requirementsCollector?: ProviderPayoutAccountResponsibility | string;
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
    onboardingStatus: ProviderSetupStatus;
    transferCapabilityStatus: ProviderCapabilityStatus;
    payoutCapabilityStatus: ProviderCapabilityStatus;
    payoutDestinationStatus: ProviderPayoutDestinationStatus;
    payoutAccountDashboard: ProviderPayoutAccountDashboard;
    lossesCollector: ProviderPayoutAccountResponsibility;
    feesCollector: ProviderPayoutAccountResponsibility;
    requirementsCollector: ProviderPayoutAccountResponsibility;
    recordedAt: string;
  }>
>;

export type PayoutReadinessEvent = PayoutReadinessRecordedEvent;

function normalizeRequirements(values: readonly string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
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
            onboardingStatus: normalizeProviderSetupStatus(command.onboardingStatus ?? "not-started"),
            transferCapabilityStatus: normalizeProviderCapabilityStatus(command.transferCapabilityStatus ?? "inactive"),
            payoutCapabilityStatus: normalizeProviderCapabilityStatus(command.payoutCapabilityStatus ?? "inactive"),
            payoutDestinationStatus: normalizeProviderPayoutDestinationStatus(
              command.payoutDestinationStatus ?? "missing",
            ),
            payoutAccountDashboard: normalizeProviderPayoutAccountDashboard(
              command.payoutAccountDashboard ?? "unknown",
            ),
            lossesCollector: normalizeProviderPayoutAccountResponsibility(command.lossesCollector ?? "unknown"),
            feesCollector: normalizeProviderPayoutAccountResponsibility(command.feesCollector ?? "unknown"),
            requirementsCollector: normalizeProviderPayoutAccountResponsibility(
              command.requirementsCollector ?? "unknown",
            ),
            recordedAt: ensureIsoTimestamp(command.recordedAt, "Payout readiness recording must include a timestamp."),
          },
        },
      ];
  }
};

export const evolvePayoutReadiness: AggregateEvolver<PayoutReadinessState, PayoutReadinessEvent> = (_state, event) => {
  switch (event.type) {
    case "settlement.payout-readiness.recorded":
      return {
        accountId: event.data.accountId,
        status: event.data.status,
        missingRequirements: event.data.missingRequirements,
        providerReference: event.data.providerReference,
        onboardingStatus: event.data.onboardingStatus,
        transferCapabilityStatus: event.data.transferCapabilityStatus,
        payoutCapabilityStatus: event.data.payoutCapabilityStatus,
        payoutDestinationStatus: event.data.payoutDestinationStatus,
        payoutAccountDashboard: event.data.payoutAccountDashboard,
        lossesCollector: event.data.lossesCollector,
        feesCollector: event.data.feesCollector,
        requirementsCollector: event.data.requirementsCollector,
        updatedAt: event.data.recordedAt,
      };
  }
};
