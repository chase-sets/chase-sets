import { formatMoney, t } from "@chase-sets/localization";
import {
  Card,
  Inline,
  LinkButton,
  MarketplaceNotice,
  MarketplaceStatusTimeline,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow } from "../read-model/queries";

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
            {t("settlement.features.payouts.ui.payoutDetailPage.back.to.payouts")}
          </LinkButton>
        }
      />

      {requestSuccess ? (
        <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.payout.requested")}>
          <MarketplaceNotice
            tone="success"
            title={t("settlement.features.payouts.ui.payoutDetailPage.payout.requested.2")}
            description={t("settlement.features.payouts.ui.payoutDetailPage.amount.is.being.sent.to.your.saved", {
              amount: formatMoney(payout.amount, payout.currency_code),
            })}
          />
        </PageSection>
      ) : null}

      <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.summary")}>
        <Stack gap={4}>
          <MarketplaceNotice
            tone={failed ? "danger" : completed ? "success" : "info"}
            title={statusLabel(payout.status)}
            description={
              payout.failure_reason ??
              payout.note ??
              t("settlement.features.payouts.ui.payoutDetailPage.payout.account.saved.payout.account")
            }
          />
          {failed ? (
            <MarketplaceNotice
              tone="warning"
              title={t("settlement.features.payouts.ui.payoutDetailPage.payout.account.needs.review")}
              description={t("settlement.features.payouts.ui.payoutDetailPage.review.payout.details.before.requesting")}
              action={
                <Inline>
                  <LinkButton href="/account/payouts/setup?mode=manage" tone="secondary" size="sm">
                    {t("settlement.features.payouts.ui.payoutDetailPage.review.payout.details")}
                  </LinkButton>
                  <LinkButton href="/account/support" tone="secondary" size="sm">
                    {t("settlement.features.payouts.ui.payoutDetailPage.contact.support")}
                  </LinkButton>
                </Inline>
              }
            />
          ) : null}
          <PriceBreakdown
            lines={[
              {
                label: t("settlement.features.payouts.ui.payoutDetailPage.amount"),
                value: formatMoney(payout.amount, payout.currency_code),
              },
              {
                label: t("settlement.features.payouts.ui.payoutDetailPage.requested.2"),
                value: requestedAt,
              },
              ...(payout.sent_at
                ? [
                    {
                      label: t("settlement.features.payouts.ui.payoutDetailPage.sent"),
                      value: new Date(payout.sent_at).toLocaleString(),
                    },
                  ]
                : []),
              ...(payout.completed_at
                ? [
                    {
                      label: t("settlement.features.payouts.ui.payoutDetailPage.completed"),
                      value: new Date(payout.completed_at).toLocaleString(),
                    },
                  ]
                : []),
              ...(payout.failed_at
                ? [
                    {
                      label: t("settlement.features.payouts.ui.payoutDetailPage.failed"),
                      value: new Date(payout.failed_at).toLocaleString(),
                    },
                  ]
                : []),
            ]}
            total={statusLabel(payout.status)}
            totalLabel={t("settlement.features.payouts.ui.payoutDetailPage.summary")}
          />
          {showSupportDetails && payout.provider_status ? (
            <MarketplaceNotice
              tone="info"
              title={t("settlement.features.payouts.ui.payoutDetailPage.provider.status")}
              description={payout.provider_status}
            />
          ) : null}
          {payout.last_reconciled_at ? (
            <MarketplaceNotice
              tone="neutral"
              title={t("settlement.features.payouts.ui.payoutDetailPage.last.provider.check")}
              description={new Date(payout.last_reconciled_at).toLocaleString()}
            />
          ) : null}
        </Stack>
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.status.timeline")}>
        <MarketplaceStatusTimeline
          steps={[
            {
              label: t("settlement.features.payouts.ui.payoutDetailPage.requested.3"),
              description: requestedAt,
              status: "complete",
            },
            {
              label: t("settlement.features.payouts.ui.payoutDetailPage.provider.transfer.submitted"),
              description:
                payout.provider_transfer_reference ??
                t("settlement.features.payouts.ui.payoutDetailPage.waiting.for.provider.transfer.reference"),
              status: transferSubmitted ? "complete" : "upcoming",
            },
            {
              label: t("settlement.features.payouts.ui.payoutDetailPage.payout.submitted"),
              description:
                payout.provider_payout_reference ??
                t("settlement.features.payouts.ui.payoutDetailPage.waiting.for.provider.payout.reference"),
              status: payoutSubmitted ? "complete" : "upcoming",
            },
            {
              label: t("settlement.features.payouts.ui.payoutDetailPage.provider.event.received"),
              description: payout.last_provider_event_at
                ? new Date(payout.last_provider_event_at).toLocaleString()
                : t("settlement.features.payouts.ui.payoutDetailPage.waiting.for.provider.event"),
              status: payout.last_provider_event_at ? "complete" : "upcoming",
            },
            {
              label: failed
                ? t("settlement.features.payouts.ui.payoutDetailPage.needs.attention.2")
                : t("settlement.features.payouts.ui.payoutDetailPage.paid.2"),
              description:
                completed && payout.completed_at
                  ? new Date(payout.completed_at).toLocaleString()
                  : failed
                    ? (payout.failure_reason ??
                      payout.provider_failure_message ??
                      t("settlement.features.payouts.ui.payoutDetailPage.provider.reported.a.payout.failure"))
                    : t("settlement.features.payouts.ui.payoutDetailPage.usually.1.3.business.days.after"),
              status: failed ? "issue" : completed ? "complete" : "current",
            },
          ]}
        />
      </PageSection>

      {showSupportDetails ? (
        <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.support.details")}>
          <Card>
            <Stack gap={2}>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.internal.payout")}
                {payout.payout_id}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.account")}
                {payout.account_id}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.transfer")}
                {payout.provider_transfer_reference ?? t("settlement.features.payouts.ui.payoutDetailPage.missing")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.payout")}
                {payout.provider_payout_reference ?? t("settlement.features.payouts.ui.payoutDetailPage.missing.2")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.provider.status.2")}
                {payout.provider_status ?? t("settlement.features.payouts.ui.payoutDetailPage.unknown")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.last.provider.event")}
                {payout.last_provider_event_at
                  ? new Date(payout.last_provider_event_at).toLocaleString()
                  : t("settlement.features.payouts.ui.payoutDetailPage.none")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.last.reconciliation.check")}
                {payout.last_reconciled_at
                  ? new Date(payout.last_reconciled_at).toLocaleString()
                  : t("settlement.features.payouts.ui.payoutDetailPage.none.2")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutDetailPage.retry.policy")}
                {payout.next_retry_at
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
                <Text size="sm" tone="secondary">
                  {t("settlement.features.payouts.ui.payoutDetailPage.retry.reason")}
                  {payout.retry_reason}
                </Text>
              ) : null}
              {payout.provider_failure_code ? (
                <Text size="sm" tone="secondary">
                  {t("settlement.features.payouts.ui.payoutDetailPage.provider.failure.code")}
                  {payout.provider_failure_code}
                </Text>
              ) : null}
              {payout.provider_failure_message ? (
                <Text size="sm" tone="secondary">
                  {t("settlement.features.payouts.ui.payoutDetailPage.provider.message")}
                  {payout.provider_failure_message}
                </Text>
              ) : null}
            </Stack>
          </Card>
        </PageSection>
      ) : null}
    </Page>
  );
}

export function SettlementPayoutDetailRecoveryPage() {
  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.payouts.ui.payoutDetailPage.settlement")}
        title={t("settlement.routes.marketplace.accountPayout.payout.preparing")}
        description={t("settlement.routes.marketplace.accountPayout.payout.preparing.description")}
        actions={
          <LinkButton href="/account/payouts" tone="secondary">
            {t("settlement.features.payouts.ui.payoutDetailPage.back.to.payouts")}
          </LinkButton>
        }
      />
      <PageSection title={t("settlement.features.payouts.ui.payoutDetailPage.summary")}>
        <MarketplaceNotice
          tone="info"
          title={t("settlement.routes.marketplace.accountPayout.payout.preparing")}
          description={t("settlement.routes.marketplace.accountPayout.payout.preparing.description")}
        />
      </PageSection>
    </Page>
  );
}
