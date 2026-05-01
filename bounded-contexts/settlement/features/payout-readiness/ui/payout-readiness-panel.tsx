import {
  Badge,
  Button,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";

function readinessTone(status: SettlementPayoutReadinessRow["status"]) {
  return status === "ready" ? "success" : "warning";
}

function readinessTitle(status: SettlementPayoutReadinessRow["status"]) {
  return status === "ready"
    ? "Payouts are ready"
    : "Finish setup to receive payouts";
}

function readinessDescription(
  status: SettlementPayoutReadinessRow["status"],
  readyDescription: string,
) {
  return status === "ready"
    ? readyDescription
    : "You can keep buying and selling while payout setup is incomplete.";
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

export function PayoutReadinessPanel({
  payoutReadiness,
  readyDescription = "Payout setup is complete.",
  showActions = false,
}: {
  payoutReadiness: SettlementPayoutReadinessRow;
  readyDescription?: string;
  showActions?: boolean;
}) {
  return (
    <Stack gap={2}>
      <Badge tone={readinessTone(payoutReadiness.status)}>
        {payoutReadiness.status}
      </Badge>
      <Text weight="semibold">{readinessTitle(payoutReadiness.status)}</Text>
      <Text size="sm" tone="secondary">
        {readinessDescription(payoutReadiness.status, readyDescription)}
      </Text>
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
      {payoutReadiness.missing_requirements.length > 0 ? (
        <Text size="sm" tone="secondary">
          Missing: {payoutReadiness.missing_requirements.map(requirementLabel).join(", ")}
        </Text>
      ) : null}
      {showActions ? (
        <Stack gap={2}>
          {payoutReadiness.status === "ready" ? null : (
            <form method="post">
              <input type="hidden" name="intent" value="start-payout-setup" />
              <Button type="submit">Continue payout setup</Button>
            </form>
          )}
          <form method="post">
            <input type="hidden" name="intent" value="refresh-payout-setup" />
            <Button type="submit" tone="secondary">
              Refresh setup
            </Button>
          </form>
        </Stack>
      ) : null}
    </Stack>
  );
}
