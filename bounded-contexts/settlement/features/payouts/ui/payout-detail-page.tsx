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

function statusLabel(status: string) {
  switch (status) {
    case "requested":
      return "Requested";
    case "in-transit":
      return "On the way";
    case "completed":
      return "Paid";
    case "failed":
      return "Needs attention";
    default:
      return status;
  }
}

function timelineTone(isComplete: boolean, isFailed = false) {
  if (isFailed) {
    return "danger";
  }
  return isComplete ? "success" : "neutral";
}

export function SettlementPayoutDetailPage({
  backHref,
  payout,
  requestSuccess = false,
  showSupportDetails = false,
}: {
  backHref: string;
  payout: SettlementPayoutRow;
  requestSuccess?: boolean;
  showSupportDetails?: boolean;
}) {
  const requestedAt = new Date(payout.requested_at).toLocaleString();
  const transferSubmitted = Boolean(payout.provider_transfer_reference || payout.sent_at);
  const payoutSubmitted = Boolean(payout.provider_payout_reference || payout.sent_at);
  const completed = payout.status === "completed";
  const failed = payout.status === "failed";

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

      {requestSuccess ? (
        <PageSection title="Payout Requested">
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">Payout requested</Text>
              <Text size="sm" tone="secondary">
                {formatMoney(payout.amount, payout.currency_code)} is being sent to your saved payout account. Most payouts arrive in 1-3 business days after provider acceptance.
              </Text>
            </Stack>
          </Card>
        </PageSection>
      ) : null}

      <PageSection title="Summary">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(payout.status) as any}>
              {statusLabel(payout.status)}
            </Badge>
            <Text>Amount: {formatMoney(payout.amount, payout.currency_code)}</Text>
            <Text>Payout account: Saved payout account</Text>
            {payout.note ? <Text>Note: {payout.note}</Text> : null}
            <Text size="sm" tone="secondary">
              Requested: {requestedAt}
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
            {showSupportDetails && payout.provider_status ? (
              <Text size="sm" tone="secondary">Provider status: {payout.provider_status}</Text>
            ) : null}
            {payout.last_reconciled_at ? (
              <Text size="sm" tone="secondary">
                Last provider check: {new Date(payout.last_reconciled_at).toLocaleString()}
              </Text>
            ) : null}
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Status Timeline">
        <Card>
          <Stack gap={2}>
            <Stack gap={1}>
              <Badge tone="success">Requested</Badge>
              <Text size="sm" tone="secondary">{requestedAt}</Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(transferSubmitted) as any}>
                Provider transfer submitted
              </Badge>
              <Text size="sm" tone="secondary">
                {payout.provider_transfer_reference ?? "Waiting for provider transfer reference"}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(payoutSubmitted) as any}>
                Payout submitted
              </Badge>
              <Text size="sm" tone="secondary">
                {payout.provider_payout_reference ?? "Waiting for provider payout reference"}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(Boolean(payout.last_provider_event_at)) as any}>
                Provider event received
              </Badge>
              <Text size="sm" tone="secondary">
                {payout.last_provider_event_at
                  ? new Date(payout.last_provider_event_at).toLocaleString()
                  : "Waiting for provider event"}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(completed, failed) as any}>
                {failed ? "Needs attention" : "Paid"}
              </Badge>
              <Text size="sm" tone="secondary">
                {completed && payout.completed_at
                  ? new Date(payout.completed_at).toLocaleString()
                  : failed
                    ? payout.failure_reason ?? payout.provider_failure_message ?? "Provider reported a payout failure."
                    : "Usually 1-3 business days after provider acceptance"}
              </Text>
            </Stack>
          </Stack>
        </Card>
      </PageSection>

      {showSupportDetails ? (
        <PageSection title="Support Details">
          <Card>
            <Stack gap={2}>
              <Text size="sm" tone="secondary">Internal payout: {payout.payout_id}</Text>
              <Text size="sm" tone="secondary">Account: {payout.account_id}</Text>
              <Text size="sm" tone="secondary">
                Provider transfer: {payout.provider_transfer_reference ?? "Missing"}
              </Text>
              <Text size="sm" tone="secondary">
                Provider payout: {payout.provider_payout_reference ?? "Missing"}
              </Text>
              <Text size="sm" tone="secondary">
                Provider status: {payout.provider_status ?? "Unknown"}
              </Text>
              <Text size="sm" tone="secondary">
                Last provider event: {payout.last_provider_event_at ? new Date(payout.last_provider_event_at).toLocaleString() : "None"}
              </Text>
              <Text size="sm" tone="secondary">
                Last reconciliation check: {payout.last_reconciled_at ? new Date(payout.last_reconciled_at).toLocaleString() : "None"}
              </Text>
              <Text size="sm" tone="secondary">
                Retry policy: {payout.next_retry_at
                  ? `${payout.retry_count} attempt${payout.retry_count === 1 ? "" : "s"}; next ${new Date(payout.next_retry_at).toLocaleString()}`
                  : payout.retry_count > 0
                    ? `${payout.retry_count} attempt${payout.retry_count === 1 ? "" : "s"}; no automatic retry pending`
                    : "No retry scheduled"}
              </Text>
              {payout.retry_reason ? (
                <Text size="sm" tone="secondary">Retry reason: {payout.retry_reason}</Text>
              ) : null}
              {payout.provider_failure_code ? (
                <Text size="sm" tone="secondary">
                  Provider failure code: {payout.provider_failure_code}
                </Text>
              ) : null}
              {payout.provider_failure_message ? (
                <Text size="sm" tone="secondary">
                  Provider message: {payout.provider_failure_message}
                </Text>
              ) : null}
            </Stack>
          </Card>
        </PageSection>
      ) : null}
    </Page>
  );
}
