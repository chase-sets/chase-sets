import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  type Tone,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow } from "../read-model/queries";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

function statusTone(status: string): Tone {
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
      return t("settlement.features.payouts.ui.payoutDetailPage.requested");
    case "in-transit":
      return t("settlement.features.payouts.ui.payoutDetailPage.on.the.way");
    case "completed":
      return t("settlement.features.payouts.ui.payoutDetailPage.paid");
    case "failed":
      return t("settlement.features.payouts.ui.payoutDetailPage.needs.attention");
    default:
      return status;
  }
}

function timelineTone(isComplete: boolean, isFailed = false): Tone {
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
        eyebrow={t("settlement.features.payouts.ui.payoutDetailPage.settlement")}
        title={t("settlement.features.payouts.ui.payoutDetailPage.payout.title", {
          payoutId: payout.payout_id,
        })}
        description={formatMoney(payout.amount, payout.currency_code)}
        actions={
          <LinkButton href={backHref} tone="secondary">
            {t("settlement.features.payouts.ui.payoutDetailPage.back.to.payouts")}</LinkButton>
        }
      />

      {requestSuccess ? (
        <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.payout.requested")}>
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">{t("settlement.features.payouts.ui.payoutDetailPage.payout.requested.2")}</Text>
              <Text size="sm" tone="secondary">
                {formatMoney(payout.amount, payout.currency_code)} {t("settlement.features.payouts.ui.payoutDetailPage.is.being.sent.to.your.saved")}</Text>
            </Stack>
          </Card>
        </PageSection>
      ) : null}

      <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.summary")}>
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(payout.status)}>
              {statusLabel(payout.status)}
            </Badge>
            <Text>{t("settlement.features.payouts.ui.payoutDetailPage.amount")}{formatMoney(payout.amount, payout.currency_code)}</Text>
            <Text>{t("settlement.features.payouts.ui.payoutDetailPage.payout.account.saved.payout.account")}</Text>
            {payout.note ? <Text>{t("settlement.features.payouts.ui.payoutDetailPage.note")}{payout.note}</Text> : null}
            <Text size="sm" tone="secondary">
              {t("settlement.features.payouts.ui.payoutDetailPage.requested.2")}{requestedAt}
            </Text>
            {payout.sent_at ? (
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.sent")}{new Date(payout.sent_at).toLocaleString()}
              </Text>
            ) : null}
            {payout.completed_at ? (
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.completed")}{new Date(payout.completed_at).toLocaleString()}
              </Text>
            ) : null}
            {payout.failed_at ? (
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.failed")}{new Date(payout.failed_at).toLocaleString()}
              </Text>
            ) : null}
            {payout.failure_reason ? (
              <Text tone="secondary">{t("settlement.features.payouts.ui.payoutDetailPage.reason")}{payout.failure_reason}</Text>
            ) : null}
            {showSupportDetails && payout.provider_status ? (
              <Text size="sm" tone="secondary">{t("settlement.features.payouts.ui.payoutDetailPage.provider.status")}{payout.provider_status}</Text>
            ) : null}
            {payout.last_reconciled_at ? (
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.last.provider.check")}{new Date(payout.last_reconciled_at).toLocaleString()}
              </Text>
            ) : null}
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.status.timeline")}>
        <Card>
          <Stack gap={2}>
            <Stack gap={1}>
              <Badge tone="success">{t("settlement.features.payouts.ui.payoutDetailPage.requested.3")}</Badge>
              <Text size="sm" tone="secondary">{requestedAt}</Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(transferSubmitted)}>
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.transfer.submitted")}</Badge>
              <Text size="sm" tone="secondary">
                {payout.provider_transfer_reference ?? t("settlement.features.payouts.ui.payoutDetailPage.waiting.for.provider.transfer.reference")}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(payoutSubmitted)}>
                {t("settlement.features.payouts.ui.payoutDetailPage.payout.submitted")}</Badge>
              <Text size="sm" tone="secondary">
                {payout.provider_payout_reference ?? t("settlement.features.payouts.ui.payoutDetailPage.waiting.for.provider.payout.reference")}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(Boolean(payout.last_provider_event_at))}>
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.event.received")}</Badge>
              <Text size="sm" tone="secondary">
                {payout.last_provider_event_at
                  ? new Date(payout.last_provider_event_at).toLocaleString()
                  : t("settlement.features.payouts.ui.payoutDetailPage.waiting.for.provider.event")}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Badge tone={timelineTone(completed, failed)}>
                {failed ? t("settlement.features.payouts.ui.payoutDetailPage.needs.attention.2") : t("settlement.features.payouts.ui.payoutDetailPage.paid.2")}
              </Badge>
              <Text size="sm" tone="secondary">
                {completed && payout.completed_at
                  ? new Date(payout.completed_at).toLocaleString()
                  : failed
                    ? payout.failure_reason ?? payout.provider_failure_message ?? t("settlement.features.payouts.ui.payoutDetailPage.provider.reported.a.payout.failure")
                    : t("settlement.features.payouts.ui.payoutDetailPage.usually.1.3.business.days.after")}
              </Text>
            </Stack>
          </Stack>
        </Card>
      </PageSection>

      {showSupportDetails ? (
        <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.support.details")}>
          <Card>
            <Stack gap={2}>
              <Text size="sm" tone="secondary">{t("settlement.features.payouts.ui.payoutDetailPage.internal.payout")}{payout.payout_id}</Text>
              <Text size="sm" tone="secondary">{t("settlement.features.payouts.ui.payoutDetailPage.account")}{payout.account_id}</Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.transfer")}{payout.provider_transfer_reference ?? t("settlement.features.payouts.ui.payoutDetailPage.missing")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.payout")}{payout.provider_payout_reference ?? t("settlement.features.payouts.ui.payoutDetailPage.missing.2")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.status.2")}{payout.provider_status ?? t("settlement.features.payouts.ui.payoutDetailPage.unknown")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.last.provider.event")}{payout.last_provider_event_at ? new Date(payout.last_provider_event_at).toLocaleString() : t("settlement.features.payouts.ui.payoutDetailPage.none")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.last.reconciliation.check")}{payout.last_reconciled_at ? new Date(payout.last_reconciled_at).toLocaleString() : t("settlement.features.payouts.ui.payoutDetailPage.none.2")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.retry.policy")}{payout.next_retry_at
                  ? t("settlement.features.payouts.ui.payoutDetailPage.retry.next", {
                      count: payout.retry_count,
                      attemptLabel: t(
                        payout.retry_count === 1
                          ? "settlement.features.payouts.ui.payoutDetailPage.attempt.singular"
                          : "settlement.features.payouts.ui.payoutDetailPage.attempt.plural",
                      ),
                      nextAt: new Date(payout.next_retry_at).toLocaleString(),
                    })
                  : payout.retry_count > 0
                    ? t("settlement.features.payouts.ui.payoutDetailPage.retry.none.pending", {
                        count: payout.retry_count,
                        attemptLabel: t(
                          payout.retry_count === 1
                            ? "settlement.features.payouts.ui.payoutDetailPage.attempt.singular"
                            : "settlement.features.payouts.ui.payoutDetailPage.attempt.plural",
                        ),
                      })
                    : t("settlement.features.payouts.ui.payoutDetailPage.no.retry.scheduled")}
              </Text>
              {payout.retry_reason ? (
                <Text size="sm" tone="secondary">{t("settlement.features.payouts.ui.payoutDetailPage.retry.reason")}{payout.retry_reason}</Text>
              ) : null}
              {payout.provider_failure_code ? (
                <Text size="sm" tone="secondary">
                  {t("settlement.features.payouts.ui.payoutDetailPage.provider.failure.code")}{payout.provider_failure_code}
                </Text>
              ) : null}
              {payout.provider_failure_message ? (
                <Text size="sm" tone="secondary">
                  {t("settlement.features.payouts.ui.payoutDetailPage.provider.message")}{payout.provider_failure_message}
                </Text>
              ) : null}
            </Stack>
          </Card>
        </PageSection>
      ) : null}
    </Page>
  );
}
