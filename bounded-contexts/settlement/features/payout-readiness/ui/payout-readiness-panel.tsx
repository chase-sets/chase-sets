import {
  Badge,
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

export function PayoutReadinessPanel({
  payoutReadiness,
  readyDescription = "Payout setup is complete.",
}: {
  payoutReadiness: SettlementPayoutReadinessRow;
  readyDescription?: string;
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
      {payoutReadiness.missing_requirements.length > 0 ? (
        <Text size="sm" tone="secondary">
          Missing: {payoutReadiness.missing_requirements.join(", ")}
        </Text>
      ) : null}
    </Stack>
  );
}
