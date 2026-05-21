import type { SettlementPayoutReadinessRow } from "../read-model/queries";

export type PayoutSetupProgressStep = Readonly<{
  id:
    | "hosted-onboarding"
    | "identity-and-business"
    | "transfer-capability"
    | "payout-capability"
    | "payout-destination";
  label: string;
  status: "not-started" | "needs-attention" | "pending" | "ready";
  detail: string;
}>;

export type PayoutSetupProgress = Readonly<{
  account_id: string;
  status: SettlementPayoutReadinessRow["status"];
  ready: boolean;
  last_checked_at: string | null;
  steps: readonly PayoutSetupProgressStep[];
}>;

function capabilityStepStatus(value: "inactive" | "pending" | "active") {
  if (value === "active") {
    return "ready";
  }
  if (value === "pending") {
    return "pending";
  }
  return "needs-attention";
}

function destinationStepStatus(value: "missing" | "pending" | "ready") {
  if (value === "ready") {
    return "ready";
  }
  if (value === "pending") {
    return "pending";
  }
  return "needs-attention";
}

function hasRequirement(readiness: SettlementPayoutReadinessRow, patterns: readonly string[]) {
  return readiness.missing_requirements.some((requirement) => {
    const normalized = requirement.toLowerCase();
    return patterns.some((pattern) => normalized.includes(pattern));
  });
}

export function buildPayoutSetupProgress(readiness: SettlementPayoutReadinessRow): PayoutSetupProgress {
  const onboardingStatus =
    readiness.onboarding_status === "complete"
      ? "ready"
      : readiness.onboarding_status === "pending"
        ? "pending"
        : "not-started";
  const identityNeedsAttention = hasRequirement(readiness, [
    "individual",
    "representative",
    "owner",
    "person",
    "identity",
    "business",
    "company",
    "profile",
    "mcc",
    "url",
    "tos",
    "terms",
  ]);

  return {
    account_id: readiness.account_id,
    status: readiness.status,
    ready: readiness.status === "ready",
    last_checked_at: readiness.updated_at,
    steps: [
      {
        id: "hosted-onboarding",
        label: "Hosted setup",
        status: onboardingStatus,
        detail: onboardingStatus === "ready" ? "Hosted setup is complete." : "Continue the hosted setup flow.",
      },
      {
        id: "identity-and-business",
        label: "Identity and business details",
        status:
          readiness.onboarding_status === "not-started"
            ? "not-started"
            : identityNeedsAttention
              ? "needs-attention"
              : readiness.onboarding_status === "complete"
                ? "ready"
                : "pending",
        detail: identityNeedsAttention
          ? "Some verification details need attention."
          : "Verification details are being tracked.",
      },
      {
        id: "transfer-capability",
        label: "Transfers enabled",
        status: capabilityStepStatus(readiness.transfer_capability_status),
        detail:
          readiness.transfer_capability_status === "active"
            ? "Funds can move from the platform balance."
            : "Transfers must be enabled before payouts can be requested.",
      },
      {
        id: "payout-capability",
        label: "Payouts enabled",
        status: capabilityStepStatus(readiness.payout_capability_status),
        detail:
          readiness.payout_capability_status === "active"
            ? "Payout creation is enabled."
            : "Payouts must be enabled before funds can be sent.",
      },
      {
        id: "payout-destination",
        label: "Payout destination",
        status: destinationStepStatus(readiness.payout_destination_status),
        detail:
          readiness.payout_destination_status === "ready"
            ? "A payout destination is ready."
            : "Add or confirm the payout destination.",
      },
    ],
  };
}
