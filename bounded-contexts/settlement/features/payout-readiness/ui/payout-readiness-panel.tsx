import {
  Badge,
  Button,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import { buildPayoutSetupProgress } from "../domain/setup-progress";

function readinessTone(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return "success";
    case "restricted":
      return "danger";
    case "not-started":
      return "neutral";
    default:
      return "warning";
  }
}

function readinessTitle(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return "Payouts are ready";
    case "restricted":
      return "Payout setup needs attention";
    case "not-started":
      return "Set up payouts";
    default:
      return "Finish setup to receive payouts";
  }
}

function readinessDescription(
  status: SettlementPayoutReadinessRow["status"],
  readyDescription: string,
) {
  switch (status) {
    case "ready":
      return readyDescription;
    case "restricted":
      return "Some payout details need to be corrected before payouts can be requested.";
    case "not-started":
      return "Add a payout account using the hosted setup flow before requesting payouts.";
    default:
      return "Continue the hosted setup flow before requesting payouts.";
  }
}

function readinessLabel(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return "Ready";
    case "restricted":
      return "Needs attention";
    case "not-started":
      return "Not started";
    default:
      return "In progress";
  }
}

function primaryActionLabel(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "not-started":
      return "Start payout setup";
    case "restricted":
      return "Fix payout setup";
    default:
      return "Continue payout setup";
  }
}

function setupStatusLabel(value: string) {
  switch (value) {
    case "not-started":
      return "Not started";
    case "pending":
      return "Needs attention";
    case "complete":
    case "active":
    case "ready":
      return "Ready";
    case "inactive":
    case "missing":
      return "Missing";
    default:
      return value.replaceAll("_", " ").replaceAll(".", " ");
  }
}

function requirementLabel(value: string) {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function requirementGroup(value: string) {
  const normalized = value.toLowerCase();
  if (
    normalized.includes("external_account") ||
    normalized.includes("bank") ||
    normalized.includes("payout")
  ) {
    return "Payout account";
  }
  if (
    normalized.includes("individual") ||
    normalized.includes("representative") ||
    normalized.includes("owner") ||
    normalized.includes("person") ||
    normalized.includes("identity")
  ) {
    return "Identity details";
  }
  if (
    normalized.includes("business") ||
    normalized.includes("company") ||
    normalized.includes("profile") ||
    normalized.includes("mcc") ||
    normalized.includes("url")
  ) {
    return "Business profile";
  }
  if (normalized.includes("tos") || normalized.includes("terms")) {
    return "Account agreement";
  }
  return "Verification review";
}

function groupedRequirements(requirements: readonly string[]) {
  const groups = new Map<string, string[]>();
  for (const requirement of requirements) {
    const group = requirementGroup(requirement);
    groups.set(group, [...(groups.get(group) ?? []), requirementLabel(requirement)]);
  }
  return [...groups.entries()];
}

function checkedAtLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not checked yet";
}

function progressTone(status: string) {
  switch (status) {
    case "ready":
      return "success";
    case "needs-attention":
      return "warning";
    case "pending":
      return "accent";
    default:
      return "neutral";
  }
}

function progressLabel(status: string) {
  switch (status) {
    case "ready":
      return "Ready";
    case "needs-attention":
      return "Needs attention";
    case "pending":
      return "In review";
    default:
      return "Not started";
  }
}

export function PayoutReadinessPanel({
  payoutReadiness,
  readyDescription = "Payout setup is complete.",
  showActions = false,
}: {
  payoutReadiness: SettlementPayoutReadinessRow;
  readyDescription?: string;
  showActions?: boolean;
}) {
  const hasProviderAccount = Boolean(payoutReadiness.provider_reference);
  const missingRequirementGroups = groupedRequirements(
    payoutReadiness.missing_requirements,
  );
  const progress = buildPayoutSetupProgress(payoutReadiness);

  return (
    <Stack gap={2}>
      <Badge tone={readinessTone(payoutReadiness.status) as any}>
        {readinessLabel(payoutReadiness.status)}
      </Badge>
      <Text weight="semibold">{readinessTitle(payoutReadiness.status)}</Text>
      <Text size="sm" tone="secondary">
        {readinessDescription(payoutReadiness.status, readyDescription)}
      </Text>
      <Text size="sm" tone="secondary">
        Last checked: {checkedAtLabel(payoutReadiness.updated_at)}
      </Text>
      <Stack gap={1}>
        {progress.steps.map((step) => (
          <Stack key={step.id} gap={1}>
            <Badge tone={progressTone(step.status) as any}>
              {progressLabel(step.status)}
            </Badge>
            <Text size="sm" weight="semibold">{step.label}</Text>
            <Text size="sm" tone="secondary">{step.detail}</Text>
          </Stack>
        ))}
      </Stack>
      <Text size="sm" tone="secondary">
        Onboarding: {setupStatusLabel(payoutReadiness.onboarding_status)}
      </Text>
      <Text size="sm" tone="secondary">
        Transfers: {setupStatusLabel(payoutReadiness.transfer_capability_status)}
      </Text>
      <Text size="sm" tone="secondary">
        Payouts: {setupStatusLabel(payoutReadiness.payout_capability_status)}
      </Text>
      <Text size="sm" tone="secondary">
        Payout destination: {setupStatusLabel(payoutReadiness.payout_destination_status)}
      </Text>
      {missingRequirementGroups.length > 0 ? (
        <Stack gap={1}>
          <Text size="sm" weight="semibold">What needs attention</Text>
          {missingRequirementGroups.map(([group, requirements]) => (
            <Text key={group} size="sm" tone="secondary">
              {group}: {requirements.join(", ")}
            </Text>
          ))}
        </Stack>
      ) : null}
      {showActions ? (
        <Stack gap={2}>
          {payoutReadiness.status === "ready" ? null : (
            <form method="post">
              <input type="hidden" name="intent" value="start-payout-setup" />
              <Button type="submit">{primaryActionLabel(payoutReadiness.status)}</Button>
            </form>
          )}
          {hasProviderAccount ? (
            <form method="post">
              <input type="hidden" name="intent" value="manage-payout-account" />
              <Button type="submit" tone="secondary">
                Manage payout account
              </Button>
            </form>
          ) : null}
          <form method="post">
            <input type="hidden" name="intent" value="refresh-payout-setup" />
            <Button type="submit" tone="secondary">
              Check setup status
            </Button>
          </form>
        </Stack>
      ) : null}
    </Stack>
  );
}
