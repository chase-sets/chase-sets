import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow } from "../read-model/queries";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

function statusTone(status: string) {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "in-transit":
      return "accent";
    default:
      return "neutral";
  }
}

export function SettlementPayoutDetailPage({
  backHref,
  payout,
}: {
  backHref: string;
  payout: SettlementPayoutRow;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Settlement"
        title={`Payout ${payout.payout_id}`}
        description={formatMoney(payout.amount, payout.currency_code)}
        actions={
          <LinkButton href={backHref} tone="secondary">
            Back to payouts
          </LinkButton>
        }
      />

      <PageSection title="Summary">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(payout.status) as any}>{payout.status}</Badge>
            <Text>Amount: {formatMoney(payout.amount, payout.currency_code)}</Text>
            {payout.destination_reference ? (
              <Text>Destination: {payout.destination_reference}</Text>
            ) : null}
            {payout.note ? <Text>Note: {payout.note}</Text> : null}
            <Text size="sm" tone="secondary">
              Scheduled: {new Date(payout.scheduled_at).toLocaleString()}
            </Text>
            {payout.sent_at ? (
              <Text size="sm" tone="secondary">
                Sent: {new Date(payout.sent_at).toLocaleString()}
              </Text>
            ) : null}
            {payout.completed_at ? (
              <Text size="sm" tone="secondary">
                Completed: {new Date(payout.completed_at).toLocaleString()}
              </Text>
            ) : null}
            {payout.failed_at ? (
              <Text size="sm" tone="secondary">
                Failed: {new Date(payout.failed_at).toLocaleString()}
              </Text>
            ) : null}
            {payout.failure_reason ? (
              <Text tone="secondary">Reason: {payout.failure_reason}</Text>
            ) : null}
            {payout.provider_status ? (
              <Text size="sm" tone="secondary">
                Provider status: {payout.provider_status}
              </Text>
            ) : null}
            {payout.provider_transfer_reference ? (
              <Text size="sm" tone="secondary">
                Provider transfer: {payout.provider_transfer_reference}
              </Text>
            ) : null}
            {payout.provider_payout_reference ? (
              <Text size="sm" tone="secondary">
                Provider payout: {payout.provider_payout_reference}
              </Text>
            ) : null}
            {payout.provider_failure_message ? (
              <Text tone="secondary">
                Provider message: {payout.provider_failure_message}
              </Text>
            ) : null}
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
