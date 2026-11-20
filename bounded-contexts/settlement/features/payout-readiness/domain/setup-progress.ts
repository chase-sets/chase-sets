import type { SettlementPayoutReadinessRow } from "../read-model/queries";

export type PayoutSetupProgressStep = Readonly<{
  id: "payout-setup" | "identity-and-business" | "transfer-capability" | "payout-capability" | "payout-destination";
  label: string;
  status: "not-started" | "needs-attention" | "pending" | "ready";
  detail: string;
}>;

export type MissingRequirementGroupId =
  | "payout-account"
  | "identity-and-business"
  | "account-agreement"
  | "platform-review"
  | "verification-review";

export type MissingRequirementGroup = Readonly<{
  id: MissingRequirementGroupId;
  label: string;
  count: number;
  detail: string;
}>;

export const PAYOUT_SETUP_NEXT_STEPS = [
  "restricted_past_due",
  "restricted_review",
  "restricted_rejected",
  "restricted_paused",
  "restricted",
  "platform_review",
  "complete_requirements",
  "add_destination",
  "provider_review",
  "none",
] as const;

export type PayoutSetupNextStep = (typeof PAYOUT_SETUP_NEXT_STEPS)[number];

export type PayoutSetupDecision = Readonly<{
  next_step: PayoutSetupNextStep;
  support_recommended: boolean;
  provider_setup_available: boolean;
  provider_management_available: boolean;
}>;

export type PayoutSetupAttention = Readonly<{
  setup_blocked: boolean;
  setup_stale: boolean;
  setup_stale_after_days: 30;
}>;

export const PAYOUT_SETUP_STALE_AFTER_DAYS = 30;
export const PAYOUT_SETUP_STALE_AFTER_MS = PAYOUT_SETUP_STALE_AFTER_DAYS * 24 * 60 * 60 * 1_000;

export function derivePayoutSetupAttention(
  readiness: Pick<SettlementPayoutReadinessRow, "status" | "provider_reference" | "updated_at">,
  evaluatedAt = new Date().toISOString(),
): PayoutSetupAttention {
  const updatedAt = readiness.updated_at ? Date.parse(readiness.updated_at) : null;
  const now = Date.parse(evaluatedAt);

  return {
    setup_blocked: readiness.status !== "ready" || !readiness.provider_reference,
    setup_stale: updatedAt !== null && Number.isFinite(updatedAt) && now - updatedAt > PAYOUT_SETUP_STALE_AFTER_MS,
    setup_stale_after_days: PAYOUT_SETUP_STALE_AFTER_DAYS,
  };
}

export type PayoutSetupProgress = Readonly<{
  account_id: string;
  status: SettlementPayoutReadinessRow["status"];
  ready: boolean;
  last_checked_at: string | null;
  missing_requirement_groups: readonly MissingRequirementGroup[];
  advisory_requirement_groups: readonly MissingRequirementGroup[];
  disabled_reason: string | null;
  requirements_deadline: string | null;
  steps: readonly PayoutSetupProgressStep[];
}> &
  PayoutSetupDecision;

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

function missingRequirementGroupId(requirement: string): MissingRequirementGroupId {
  const normalized = requirement.toLowerCase();
  if (normalized.startsWith("provider_") && normalized.endsWith("_posture")) {
    return "platform-review";
  }
  if (normalized.includes("external_account") || normalized.includes("bank") || normalized.includes("payout")) {
    return "payout-account";
  }
  if (
    normalized.includes("individual") ||
    normalized.includes("representative") ||
    normalized.includes("owner") ||
    normalized.includes("person") ||
    normalized.includes("identity") ||
    normalized.includes("business") ||
    normalized.includes("company") ||
    normalized.includes("profile") ||
    normalized.includes("mcc") ||
    normalized.includes("url")
  ) {
    return "identity-and-business";
  }
  if (normalized.includes("tos") || normalized.includes("terms")) {
    return "account-agreement";
  }
  return "verification-review";
}

function hasPendingProviderStatus(readiness: SettlementPayoutReadinessRow) {
  return (
    readiness.onboarding_status === "pending" ||
    readiness.transfer_capability_status === "pending" ||
    readiness.payout_capability_status === "pending" ||
    readiness.payout_destination_status === "pending"
  );
}

function restrictedNextStep(disabledReason: string | null): PayoutSetupNextStep {
  const normalized = disabledReason?.toLowerCase() ?? "";
  if (normalized.includes("past_due")) {
    return "restricted_past_due";
  }
  if (normalized.includes("review") || normalized.includes("pending")) {
    return "restricted_review";
  }
  if (normalized.includes("rejected") || normalized.includes("fraud")) {
    return "restricted_rejected";
  }
  if (normalized.includes("paused") || normalized.includes("inactivity")) {
    return "restricted_paused";
  }
  return "restricted";
}

export function derivePayoutSetupDecision(readiness: SettlementPayoutReadinessRow): PayoutSetupDecision {
  const missingRequirementGroups = buildMissingRequirementGroups(readiness.missing_requirements);
  const hasMissingRequirements = missingRequirementGroups.length > 0;
  const onlyPlatformReview =
    hasMissingRequirements && missingRequirementGroups.every((group) => group.id === "platform-review");

  let next_step: PayoutSetupNextStep;
  if (readiness.status === "restricted") {
    next_step = restrictedNextStep(readiness.disabled_reason);
  } else if (readiness.status === "ready") {
    next_step = "none";
  } else if (onlyPlatformReview) {
    next_step = "platform_review";
  } else if (hasMissingRequirements) {
    next_step = "complete_requirements";
  } else if (readiness.payout_destination_status === "missing") {
    next_step = "add_destination";
  } else if (hasPendingProviderStatus(readiness)) {
    next_step = "provider_review";
  } else {
    next_step = "none";
  }

  return {
    next_step,
    support_recommended: readiness.status === "restricted" || hasMissingRequirements,
    provider_setup_available:
      readiness.status !== "ready" &&
      (!hasMissingRequirements || missingRequirementGroups.some((group) => group.id !== "platform-review")),
    provider_management_available: Boolean(readiness.provider_reference),
  };
}

export function withPayoutSetupDecision(
  readiness: SettlementPayoutReadinessRow,
): SettlementPayoutReadinessRow & PayoutSetupDecision {
  return { ...readiness, ...derivePayoutSetupDecision(readiness) };
}

function groupLabel(id: MissingRequirementGroupId) {
  switch (id) {
    case "payout-account":
      return "Payout account";
    case "identity-and-business":
      return "Identity and business details";
    case "account-agreement":
      return "Account agreement";
    case "platform-review":
      return "Platform review";
    default:
      return "Verification review";
  }
}

function groupDetail(id: MissingRequirementGroupId) {
  switch (id) {
    case "payout-account":
      return "Add or confirm the payout account before requesting payouts.";
    case "identity-and-business":
      return "Review the account, identity, or business details requested during setup.";
    case "account-agreement":
      return "Review and accept the required account terms.";
    case "platform-review":
      return "Contact support while Chase Sets reviews the payout provider configuration.";
    default:
      return "Review the remaining verification details requested during setup.";
  }
}

export function buildMissingRequirementGroups(requirements: readonly string[]): readonly MissingRequirementGroup[] {
  const counts = new Map<MissingRequirementGroupId, number>();
  const normalizedRequirements = [...new Set(requirements.map((requirement) => requirement.trim()).filter(Boolean))];

  for (const requirement of normalizedRequirements) {
    const id = missingRequirementGroupId(requirement);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return (
    ["payout-account", "identity-and-business", "account-agreement", "platform-review", "verification-review"] as const
  ).flatMap((id) => {
    const count = counts.get(id) ?? 0;
    return count > 0
      ? [
          {
            id,
            label: groupLabel(id),
            count,
            detail: groupDetail(id),
          },
        ]
      : [];
  });
}

export function buildPayoutSetupProgressDetails(
  readiness: SettlementPayoutReadinessRow,
): Omit<PayoutSetupProgress, keyof PayoutSetupDecision> {
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
    missing_requirement_groups: buildMissingRequirementGroups(readiness.missing_requirements),
    advisory_requirement_groups: buildMissingRequirementGroups(readiness.advisory_requirements),
    disabled_reason: readiness.disabled_reason,
    requirements_deadline: readiness.requirements_deadline,
    steps: [
      {
        id: "payout-setup",
        label: "Payout setup",
        status: onboardingStatus,
        detail: onboardingStatus === "ready" ? "Payout setup is complete." : "Continue the payout setup page.",
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

export function buildPayoutSetupProgress(readiness: SettlementPayoutReadinessRow): PayoutSetupProgress {
  return { ...buildPayoutSetupProgressDetails(readiness), ...derivePayoutSetupDecision(readiness) };
}
