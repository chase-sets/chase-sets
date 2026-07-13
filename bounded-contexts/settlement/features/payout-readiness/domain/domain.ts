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
  advisoryRequirements: readonly string[];
  disabledReason: string | null;
  requirementsDeadline: string | null;
  providerReference: string | null;
  contactEmail: string | null;
  onboardingStatus: ProviderSetupStatus;
  transferCapabilityStatus: ProviderCapabilityStatus;
  payoutCapabilityStatus: ProviderCapabilityStatus;
  payoutDestinationStatus: ProviderPayoutDestinationStatus;
  payoutDestinationFingerprint: string | null;
  payoutDestinationChangedAt: string | null;
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
  advisoryRequirements: [],
  disabledReason: null,
  requirementsDeadline: null,
  providerReference: null,
  contactEmail: null,
  onboardingStatus: "not-started",
  transferCapabilityStatus: "inactive",
  payoutCapabilityStatus: "inactive",
  payoutDestinationStatus: "missing",
  payoutDestinationFingerprint: null,
  payoutDestinationChangedAt: null,
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
  advisoryRequirements?: readonly string[];
  disabledReason?: string | null;
  requirementsDeadline?: string | null;
  providerReference?: string | null;
  contactEmail?: string | null;
  onboardingStatus?: ProviderSetupStatus | string;
  transferCapabilityStatus?: ProviderCapabilityStatus | string;
  payoutCapabilityStatus?: ProviderCapabilityStatus | string;
  payoutDestinationStatus?: ProviderPayoutDestinationStatus | string;
  payoutDestinationFingerprint?: string | null;
  payoutDestinationChangedAt?: string | null;
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
    previousStatus: PayoutReadinessStatus;
    status: PayoutReadinessStatus;
    missingRequirements: string[];
    advisoryRequirements: string[];
    disabledReason: string | null;
    requirementsDeadline: string | null;
    providerReference: string | null;
    contactEmail: string | null;
    onboardingStatus: ProviderSetupStatus;
    transferCapabilityStatus: ProviderCapabilityStatus;
    payoutCapabilityStatus: ProviderCapabilityStatus;
    payoutDestinationStatus: ProviderPayoutDestinationStatus;
    payoutDestinationFingerprint: string | null;
    payoutDestinationChangedAt: string | null;
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
> = (state, command) => {
  switch (command.type) {
    case "RecordPayoutReadiness":
      return [
        {
          type: "settlement.payout-readiness.recorded",
          data: {
            accountId: command.accountId,
            previousStatus: state.status,
            status: normalizePayoutReadinessStatus(command.status),
            missingRequirements: normalizeRequirements(command.missingRequirements),
            advisoryRequirements: normalizeRequirements(command.advisoryRequirements),
            disabledReason: normalizeOptionalText(command.disabledReason),
            requirementsDeadline: command.requirementsDeadline
              ? ensureIsoTimestamp(command.requirementsDeadline, "Requirement deadline must be a timestamp.")
              : null,
            providerReference: normalizeOptionalText(command.providerReference),
            contactEmail: normalizeOptionalText(command.contactEmail),
            onboardingStatus: normalizeProviderSetupStatus(command.onboardingStatus ?? "not-started"),
            transferCapabilityStatus: normalizeProviderCapabilityStatus(command.transferCapabilityStatus ?? "inactive"),
            payoutCapabilityStatus: normalizeProviderCapabilityStatus(command.payoutCapabilityStatus ?? "inactive"),
            payoutDestinationStatus: normalizeProviderPayoutDestinationStatus(
              command.payoutDestinationStatus ?? "missing",
            ),
            payoutDestinationFingerprint: normalizeOptionalText(command.payoutDestinationFingerprint),
            payoutDestinationChangedAt: command.payoutDestinationChangedAt
              ? ensureIsoTimestamp(
                  command.payoutDestinationChangedAt,
                  "Payout destination change recording must include a timestamp.",
                )
              : null,
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
        advisoryRequirements: event.data.advisoryRequirements ?? [],
        disabledReason: event.data.disabledReason ?? null,
        requirementsDeadline: event.data.requirementsDeadline ?? null,
        providerReference: event.data.providerReference,
        contactEmail: event.data.contactEmail,
        onboardingStatus: event.data.onboardingStatus,
        transferCapabilityStatus: event.data.transferCapabilityStatus,
        payoutCapabilityStatus: event.data.payoutCapabilityStatus,
        payoutDestinationStatus: event.data.payoutDestinationStatus,
        payoutDestinationFingerprint: event.data.payoutDestinationFingerprint,
        payoutDestinationChangedAt: event.data.payoutDestinationChangedAt,
        payoutAccountDashboard: event.data.payoutAccountDashboard,
        lossesCollector: event.data.lossesCollector,
        feesCollector: event.data.feesCollector,
        requirementsCollector: event.data.requirementsCollector,
        updatedAt: event.data.recordedAt,
      };
  }
};
