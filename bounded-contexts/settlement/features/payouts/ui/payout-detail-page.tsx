import {
  Badge,
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
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
  errorMessage,
}: {
  backHref: string;
  payout: SettlementPayoutRow;
  errorMessage?: string | null;
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

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

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
          </Stack>
        </Card>
      </PageSection>

      {payout.status === "scheduled" ? (
        <PageSection title="Actions">
          <Card>
            <form method="post">
              <input type="hidden" name="intent" value="send-payout" />
              <Button type="submit">Mark in transit</Button>
            </form>
          </Card>
        </PageSection>
      ) : null}

      {payout.status === "in-transit" ? (
        <PageSection title="Actions">
          <Stack gap={3}>
            <Card>
              <form method="post">
                <input type="hidden" name="intent" value="complete-payout" />
                <Button type="submit">Mark completed</Button>
              </form>
            </Card>
            <Card>
              <form method="post">
                <Stack gap={3}>
                  <input type="hidden" name="intent" value="fail-payout" />
                  <TextInput
                    label="Failure reason"
                    name="failureReason"
                    placeholder="Describe why the payout failed"
                  />
                  <Button type="submit" tone="danger">Mark failed</Button>
                </Stack>
              </form>
            </Card>
          </Stack>
        </PageSection>
      ) : null}
    </Page>
  );
}
