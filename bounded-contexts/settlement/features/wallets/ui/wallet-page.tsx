import { formatDate, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  DataTable,
  Grid,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  type Tone,
} from "@chase-sets/design-system";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "../read-model/queries";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import { PayoutReadinessPanel } from "../../payout-readiness/ui/payout-readiness-panel";
import { sellerFundsAvailableAt, sellerFundsHoldPolicy } from "../domain/funds-hold-policy";

function directionTone(direction: string): Tone {
  return direction === "credit" ? "success" : "danger";
}

function fundsStatusTone(status: string): Tone {
  return status === "available" ? "success" : "warning";
}

function checklistTone(isComplete: boolean): Tone {
  return isComplete ? "success" : "neutral";
}

function fundsAvailabilityLabel(row: SettlementLedgerEntryRow) {
  if (row.funds_status === "available") {
    return row.available_at
      ? t("settlement.features.wallets.ui.walletPage.available.on.date", {
          date: formatDate(row.available_at),
        })
      : t("settlement.features.wallets.ui.walletPage.available.now");
  }
  if (row.direction === "credit" && row.kind === "sale") {
    const availableAt = sellerFundsAvailableAt(row.posted_at);
    return availableAt
      ? t("settlement.features.wallets.ui.walletPage.expected.on.date", {
          date: formatDate(availableAt),
        })
      : t("settlement.features.wallets.ui.walletPage.pending.review");
  }
  return t("settlement.features.wallets.ui.walletPage.pending");
}

export function SettlementWalletPage({
  wallet,
  entries,
  payoutReadiness,
}: {
  wallet: SettlementWalletRow;
  entries: readonly SettlementLedgerEntryRow[];
  payoutReadiness?: SettlementPayoutReadinessRow | null;
}) {
  const availableBalance = Number.parseFloat(wallet.available_balance_amount);
  const pendingBalance = Number.parseFloat(wallet.pending_balance_amount);
  const setupReady = payoutReadiness?.status === "ready";
  const payoutAvailability: Readonly<{ tone: Tone; label: string; detail: string }> =
    setupReady && availableBalance > 0
      ? {
          tone: "success",
          label: t("settlement.features.wallets.ui.walletPage.payout.available.now"),
          detail: t("settlement.features.wallets.ui.walletPage.amount.can.be.requested.for.payout", {
            amount: formatMoney(wallet.available_balance_amount, wallet.currency_code),
          }),
        }
      : !setupReady
        ? {
            tone: "warning",
            label: t("settlement.features.wallets.ui.walletPage.setup.is.the.blocker"),
            detail: t("settlement.features.wallets.ui.walletPage.finish.payout.setup.before.requesting.available"),
          }
        : pendingBalance > 0
          ? {
              tone: "warning",
              label: t("settlement.features.wallets.ui.walletPage.funds.are.still.pending"),
              detail: t("settlement.features.wallets.ui.walletPage.amount.is.pending", {
                amount: formatMoney(wallet.pending_balance_amount, wallet.currency_code),
              }),
            }
          : {
              tone: "neutral",
              label: t("settlement.features.wallets.ui.walletPage.no.payoutable.funds"),
              detail: t("settlement.features.wallets.ui.walletPage.available.funds.appear.here.after.sales"),
            };
  const hasLedgerActivity = entries.length > 0;
  const setupChecklist = [
    {
      label: t("settlement.features.wallets.ui.walletPage.start.payout.setup"),
      complete: Boolean(payoutReadiness?.provider_reference),
      detail: payoutReadiness?.provider_reference
        ? t("settlement.features.wallets.ui.walletPage.provider.account.created")
        : t("settlement.features.wallets.ui.walletPage.create.the.hosted.payout.setup.session"),
    },
    {
      label: t("settlement.features.wallets.ui.walletPage.finish.account.verification"),
      complete: payoutReadiness?.status === "ready",
      detail: payoutReadiness
        ? t("settlement.features.wallets.ui.walletPage.setup.status", {
            status: payoutReadiness.status.replace("-", " "),
          })
        : t("settlement.features.wallets.ui.walletPage.setup.has.not.started"),
    },
    {
      label: t("settlement.features.wallets.ui.walletPage.add.payout.destination"),
      complete: payoutReadiness?.payout_destination_status === "ready",
      detail:
        payoutReadiness?.payout_destination_status === "ready"
          ? t("settlement.features.wallets.ui.walletPage.destination.is.ready")
          : t("settlement.features.wallets.ui.walletPage.add.or.verify.a.payout.destination"),
    },
    {
      label: t("settlement.features.wallets.ui.walletPage.earn.available.funds"),
      complete: hasLedgerActivity && availableBalance > 0,
      detail:
        availableBalance > 0
          ? t("settlement.features.wallets.ui.walletPage.amount.available", {
              amount: formatMoney(wallet.available_balance_amount, wallet.currency_code),
            })
          : t("settlement.features.wallets.ui.walletPage.available.funds.appear.here.after.sales.2"),
    },
  ];

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.wallets.ui.walletPage.settlement")}
        title={t("settlement.features.wallets.ui.walletPage.wallet")}
        description={t("settlement.features.wallets.ui.walletPage.track.your.pending.and.available.balances")}
        actions={
          <LinkButton href="/account/payouts" tone="secondary">
            {t("settlement.features.wallets.ui.walletPage.view.payouts")}
          </LinkButton>
        }
      />

      <MarketplaceDashboardPanel
        title={t("settlement.features.wallets.ui.walletPage.balance")}
        description={t("settlement.features.wallets.ui.walletPage.track.your.pending.and.available.balances")}
        metrics={[
          {
            label: t("settlement.features.wallets.ui.walletPage.available"),
            value: formatMoney(wallet.available_balance_amount, wallet.currency_code),
            detail: t("settlement.features.wallets.ui.walletPage.funds.ready.for.platform.purchases.and"),
          },
          {
            label: t("settlement.features.wallets.ui.walletPage.pending.2"),
            value: formatMoney(wallet.pending_balance_amount, wallet.currency_code),
            detail: t("settlement.features.wallets.ui.walletPage.hold.days.before.they.become.available", {
              count: sellerFundsHoldPolicy.holdDays,
            }),
          },
          {
            label: t("settlement.features.wallets.ui.walletPage.payout.availability"),
            value: payoutAvailability.label,
            detail: payoutAvailability.detail,
          },
        ]}
        action={
          <LinkButton href="/account/payouts" tone="secondary" size="sm">
            {t("settlement.features.wallets.ui.walletPage.view.payouts")}
          </LinkButton>
        }
      />

      <PageSection title={t("settlement.features.wallets.ui.walletPage.balance")}>
        <Grid columns={{ base: 1, md: 2 }} gap={3}>
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">{t("settlement.features.wallets.ui.walletPage.pending.2")}</Text>
              <Text size="lg">{formatMoney(wallet.pending_balance_amount, wallet.currency_code)}</Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.wallets.ui.walletPage.sale.funds.are.held.for")}
                {sellerFundsHoldPolicy.holdDays}{" "}
                {t("settlement.features.wallets.ui.walletPage.days.before.they.become.available")}
              </Text>
            </Stack>
          </Card>
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">{t("settlement.features.wallets.ui.walletPage.available")}</Text>
              <Text size="lg">{formatMoney(wallet.available_balance_amount, wallet.currency_code)}</Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.wallets.ui.walletPage.funds.ready.for.platform.purchases.and")}
              </Text>
            </Stack>
          </Card>
        </Grid>
        <Stack gap={1}>
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletPage.lifetime.credits")}
            {formatMoney(wallet.total_credited_amount, wallet.currency_code)}
          </Text>
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletPage.lifetime.debits")}
            {formatMoney(wallet.total_debited_amount, wallet.currency_code)}
          </Text>
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletPage.available.balance.can.be.used.for")}
          </Text>
        </Stack>
      </PageSection>

      {payoutReadiness ? (
        <PageSection title={t("settlement.features.wallets.ui.walletPage.payout.setup")}>
          <Card>
            <PayoutReadinessPanel payoutReadiness={payoutReadiness} />
          </Card>
        </PageSection>
      ) : null}

      <PageSection title={t("settlement.features.wallets.ui.walletPage.payout.availability")}>
        <MarketplaceNotice
          tone={payoutAvailability.tone === "accent" ? "info" : payoutAvailability.tone}
          title={payoutAvailability.label}
          description={
            <>
              {payoutAvailability.detail}
              <br />
              {t("settlement.features.wallets.ui.walletPage.available.funds.can.be.requested.on")}
            </>
          }
        />
      </PageSection>

      <PageSection title={t("settlement.features.wallets.ui.walletPage.seller.setup.checklist")}>
        <Grid columns={{ base: 1, md: 2 }} gap={3}>
          {setupChecklist.map((item) => (
            <Card key={item.label}>
              <Stack gap={2}>
                <Badge tone={checklistTone(item.complete)}>
                  {item.complete
                    ? t("settlement.features.wallets.ui.walletPage.done")
                    : t("settlement.features.wallets.ui.walletPage.next")}
                </Badge>
                <Text weight="semibold">{item.label}</Text>
                <Text size="sm" tone="secondary">
                  {item.detail}
                </Text>
              </Stack>
            </Card>
          ))}
        </Grid>
      </PageSection>

      <PageSection title={t("settlement.features.wallets.ui.walletPage.ledger")}>
        <DataTable
          rows={[...entries]}
          getRowId={(row) => row.ledger_entry_id}
          columns={[
            {
              key: "kind",
              header: t("settlement.features.wallets.ui.walletPage.kind"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.kind}</Text>
                  {row.description ? (
                    <Text size="sm" tone="secondary">
                      {row.description}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "direction",
              header: t("settlement.features.wallets.ui.walletPage.direction"),
              cell: (row) => <Badge tone={directionTone(row.direction)}>{row.direction}</Badge>,
            },
            {
              key: "amount",
              header: t("settlement.features.wallets.ui.walletPage.amount"),
              align: "right",
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "status",
              header: t("settlement.features.wallets.ui.walletPage.status"),
              cell: (row) =>
                row.direction === "credit" ? (
                  <Stack gap={1}>
                    <Badge tone={fundsStatusTone(row.funds_status)}>{row.funds_status}</Badge>
                    <Text size="sm" tone="secondary">
                      {fundsAvailabilityLabel(row)}
                    </Text>
                  </Stack>
                ) : null,
            },
            {
              key: "posted_at",
              header: t("settlement.features.wallets.ui.walletPage.posted"),
              cell: (row) => formatDate(row.posted_at),
            },
          ]}
          emptyTitle={t("settlement.features.wallets.ui.walletPage.no.ledger.activity")}
          emptyDescription={t("settlement.features.wallets.ui.walletPage.ledger.entries.appear.here.once.sales")}
        />
      </PageSection>
    </Page>
  );
}
