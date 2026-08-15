import { formatDate, formatDateTime, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Form,
  HiddenInput,
  KeyValueList,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  SideSheet,
  Stack,
  Text,
  Timeline,
  type Tone,
} from "@chase-sets/design-system";
import type { SettlementPayoutPreview } from "../../../client";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import { payoutUnavailableReasonLabel } from "../../payouts/domain/reason-codes";
import type { SettlementPayoutRow } from "../../payouts/read-model/queries";
import { selectBlockedPayoutAttentionRows } from "../../payouts/read-model/seller-attention-source";
import { SettlementPayoutRequestPanel } from "../../payouts/ui/payout-request-panel";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "../../wallets/read-model/queries";
import type { SettlementWalletAdjustmentAccountDetailRow } from "../../wallets/read-model/wallet-adjustment-queries";
import type { WalletAdjustmentReasonCode } from "../../wallets/domain/wallet-adjustment";
import { walletAdjustmentCustomerReasonCategoryLabel } from "../../wallets/integrations/transactional-notifications/wallet-adjustment-notification-intents";
import {
  walletAdjustmentAccountDirectionLabel,
  walletAdjustmentAccountDirectionTone,
  walletAdjustmentAccountStatusLabel,
  walletAdjustmentAccountStatusTone,
} from "../../wallets/ui/wallet-adjustment-account-copy";
import { selectNextPayout } from "../domain/dashboard-model";

function payoutStatusLabel(status: string) {
  switch (status) {
    case "requested":
      return t("settlement.features.moneyDashboard.ui.requested");
    case "in-transit":
      return t("settlement.features.moneyDashboard.ui.onTheWay");
    case "completed":
      return t("settlement.features.moneyDashboard.ui.paid");
    case "failed":
      return t("settlement.features.moneyDashboard.ui.needsAttention");
    default:
      return status;
  }
}

function payoutStatusTone(status: string): Tone {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "in-transit") return "accent";
  return "neutral";
}

function attentionKindLabel(kind?: string) {
  if (kind === "failed") return t("settlement.features.moneyDashboard.ui.failedPayout");
  if (kind === "missing-provider-reference") {
    return t("settlement.features.moneyDashboard.ui.awaitingConfirmation");
  }
  return t("settlement.features.moneyDashboard.ui.statusCheckOverdue");
}

export type MoneyDashboardActionState = Readonly<{
  error?: string;
  draft?: Readonly<{ amount: string; note: string | null }>;
  confirmation?: Readonly<{ amount: string; note: string | null; preview: SettlementPayoutPreview }>;
  reconciliationStatus?: string;
}>;

export function SettlementMoneyDashboardPage({
  wallet,
  entries,
  payouts,
  payoutReadiness,
  evaluatedAt,
  canRequestPayouts,
  canSetupPayouts,
  canReconcilePayouts,
  selectedWalletAdjustment = null,
  actionState,
}: {
  wallet: SettlementWalletRow;
  entries: readonly SettlementLedgerEntryRow[];
  payouts: readonly SettlementPayoutRow[];
  payoutReadiness: SettlementPayoutReadinessRow;
  evaluatedAt: string;
  canRequestPayouts: boolean;
  canSetupPayouts: boolean;
  canReconcilePayouts: boolean;
  selectedWalletAdjustment?: SettlementWalletAdjustmentAccountDetailRow | null;
  actionState?: MoneyDashboardActionState;
}) {
  const nextPayout = selectNextPayout(payouts);
  const attention = selectBlockedPayoutAttentionRows(payouts, {
    accountId: wallet.account_id,
    now: evaluatedAt,
  });
  const setupIncomplete = payoutReadiness.status !== "ready" || !payoutReadiness.provider_reference;

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.moneyDashboard.ui.sellerDesk")}
        title={t("settlement.features.moneyDashboard.ui.title")}
        description={t("settlement.features.moneyDashboard.ui.description")}
        actions={
          canSetupPayouts ? (
            <LinkButton href="/account/desk/settings" tone="secondary">
              {t("settlement.features.moneyDashboard.ui.managePayoutAccount")}
            </LinkButton>
          ) : null
        }
      />

      <MarketplaceDashboardPanel
        title={t("settlement.features.moneyDashboard.ui.atAGlance")}
        metrics={[
          {
            label: t("settlement.features.moneyDashboard.ui.walletBalance"),
            value: formatMoney(wallet.available_balance_amount, wallet.currency_code),
            detail: t("settlement.features.moneyDashboard.ui.pendingBalance", {
              amount: formatMoney(wallet.pending_balance_amount, wallet.currency_code),
            }),
          },
          {
            label: t("settlement.features.moneyDashboard.ui.nextPayout"),
            value: nextPayout
              ? formatMoney(nextPayout.amount, nextPayout.currencyCode)
              : t("settlement.features.moneyDashboard.ui.noneScheduled"),
            detail: nextPayout
              ? t("settlement.features.moneyDashboard.ui.estimatedBy", {
                  date: formatDate(nextPayout.estimatedArrivalAt),
                })
              : t("settlement.features.moneyDashboard.ui.requestWhenReady"),
          },
          {
            label: t("settlement.features.moneyDashboard.ui.blocked"),
            value: t(
              attention.length === 1
                ? "settlement.features.moneyDashboard.ui.oneNeedsAttention"
                : "settlement.features.moneyDashboard.ui.manyNeedAttention",
              { count: attention.length },
            ),
            detail: t("settlement.features.moneyDashboard.ui.blockedDetail"),
          },
        ]}
      />

      {selectedWalletAdjustment ? (
        <SideSheet
          defaultOpen
          title={t("settlement.features.moneyDashboard.ui.walletAdjustmentTitle", {
            reference: selectedWalletAdjustment.display_reference,
          })}
          description={t("settlement.features.moneyDashboard.ui.walletAdjustmentDescription")}
          footer={
            <LinkButton href="/account/support" tone="secondary">
              {t("settlement.features.moneyDashboard.ui.contactSupport")}
            </LinkButton>
          }
        >
          <Stack gap={4}>
            <Stack direction="row" gap={2} align="center">
              <Badge tone={walletAdjustmentAccountStatusTone(selectedWalletAdjustment.status)}>
                {walletAdjustmentAccountStatusLabel(selectedWalletAdjustment.status)}
              </Badge>
              <Text weight="semibold">{selectedWalletAdjustment.display_reference}</Text>
            </Stack>
            <KeyValueList
              items={[
                {
                  key: t("settlement.features.moneyDashboard.ui.direction"),
                  value: (
                    <Badge tone={walletAdjustmentAccountDirectionTone(selectedWalletAdjustment.direction)}>
                      {walletAdjustmentAccountDirectionLabel(selectedWalletAdjustment.direction)}
                    </Badge>
                  ),
                },
                {
                  key: t("settlement.features.moneyDashboard.ui.amount"),
                  value: formatMoney(selectedWalletAdjustment.amount, selectedWalletAdjustment.currency_code),
                },
                {
                  key: t("settlement.features.moneyDashboard.ui.reason"),
                  value: walletAdjustmentCustomerReasonCategoryLabel(
                    selectedWalletAdjustment.reason_code as WalletAdjustmentReasonCode,
                  ),
                },
                {
                  key: t("settlement.features.moneyDashboard.ui.requested"),
                  value: formatDate(selectedWalletAdjustment.requested_at),
                },
                ...(selectedWalletAdjustment.available_balance_after
                  ? [
                      {
                        key: t("settlement.features.moneyDashboard.ui.resultingBalance"),
                        value: formatMoney(
                          selectedWalletAdjustment.available_balance_after,
                          selectedWalletAdjustment.currency_code,
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            <MarketplaceNotice
              tone="info"
              title={t("settlement.features.moneyDashboard.ui.walletAdjustmentSafeTitle")}
              description={t("settlement.features.moneyDashboard.ui.walletAdjustmentSafeDescription")}
            />
          </Stack>
        </SideSheet>
      ) : null}

      {actionState?.error ? (
        <MarketplaceNotice
          tone="danger"
          title={t("settlement.features.moneyDashboard.ui.actionFailed")}
          description={actionState.error}
        />
      ) : null}
      {actionState?.reconciliationStatus ? (
        <MarketplaceNotice
          tone="info"
          title={t("settlement.features.moneyDashboard.ui.statusCheckQueued")}
          description={actionState.reconciliationStatus}
        />
      ) : null}

      {setupIncomplete ? (
        <PageSection title={t("settlement.features.moneyDashboard.ui.needsAttention")}>
          <MarketplaceNotice
            tone="warning"
            title={t("settlement.features.moneyDashboard.ui.finishPayoutSetup")}
            description={payoutUnavailableReasonLabel("payout-setup-incomplete")}
            action={
              canSetupPayouts ? (
                <LinkButton href="/account/desk/settings" tone="secondary" size="sm">
                  {t("settlement.features.moneyDashboard.ui.finishPayoutSetup")}
                </LinkButton>
              ) : undefined
            }
          />
        </PageSection>
      ) : null}

      <PageSection title={t("settlement.features.moneyDashboard.ui.requestPayout")}>
        <Card data-testid="payout-request-entity" elevation="elevated">
          <SettlementPayoutRequestPanel
            wallet={wallet}
            payoutReadiness={payoutReadiness}
            canRequestPayouts={canRequestPayouts}
            draft={actionState?.draft}
            confirmation={actionState?.confirmation}
          />
        </Card>
      </PageSection>

      <PageSection title={t("settlement.features.moneyDashboard.ui.payoutAttention")}>
        <DataTable
          rows={[...attention]}
          getRowId={(row) => row.payoutId}
          columns={[
            {
              key: "payout",
              header: t("settlement.features.moneyDashboard.ui.payout"),
              cell: (row) => <Text weight="semibold">{row.reference}</Text>,
            },
            {
              key: "reason",
              header: t("settlement.features.moneyDashboard.ui.reason"),
              cell: (row) => (
                <Stack gap={1}>
                  <Badge tone={row.kind === "failed" ? "danger" : "warning"}>{attentionKindLabel(row.kind)}</Badge>
                  <Text size="sm" tone="secondary">
                    {payoutUnavailableReasonLabel(row.blockReason)}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "next-action",
              header: t("settlement.features.moneyDashboard.ui.nextAction"),
              cell: (row) => (
                <Stack direction="row" gap={2}>
                  {canReconcilePayouts ? (
                    <Form spacing="none" method="post">
                      <HiddenInput type="hidden" name="intent" value={row.nextAction ?? "run-reconciliation"} />
                      <Button type="submit" size="sm">
                        {row.nextAction === "retry"
                          ? t("settlement.features.moneyDashboard.ui.retryPayout")
                          : t("settlement.features.moneyDashboard.ui.checkStatus")}
                      </Button>
                    </Form>
                  ) : null}
                  <LinkButton href="/account/support" tone="secondary" size="sm">
                    {t("settlement.features.moneyDashboard.ui.contactSupport")}
                  </LinkButton>
                </Stack>
              ),
            },
          ]}
          emptyTitle={t("settlement.features.moneyDashboard.ui.noBlockedPayouts")}
          emptyDescription={t("settlement.features.moneyDashboard.ui.noBlockedPayoutsDetail")}
        />
      </PageSection>

      <PageSection title={t("settlement.features.moneyDashboard.ui.payoutTimeline")}>
        <Timeline
          items={payouts.map((payout) => ({
            title: (
              <Stack direction="row" gap={2} align="center">
                <Text weight="semibold">{payout.display_reference}</Text>
                <Badge tone={payoutStatusTone(payout.status)}>{payoutStatusLabel(payout.status)}</Badge>
              </Stack>
            ),
            description: (
              <Stack gap={2}>
                <Text>{formatMoney(payout.amount, payout.currency_code)}</Text>
                <SideSheet
                  title={t("settlement.features.moneyDashboard.ui.payoutBreakdown", {
                    reference: payout.display_reference,
                  })}
                  description={payoutStatusLabel(payout.status)}
                  trigger={
                    <Button tone="secondary" size="sm">
                      {t("settlement.features.moneyDashboard.ui.viewBreakdown")}
                    </Button>
                  }
                  footer={
                    <LinkButton href={`/account/desk/payouts/${payout.payout_id}`} tone="secondary">
                      {t("settlement.features.moneyDashboard.ui.openPayout")}
                    </LinkButton>
                  }
                >
                  <PriceBreakdown
                    lines={[
                      {
                        label: t("settlement.features.moneyDashboard.ui.amount"),
                        value: formatMoney(payout.amount, payout.currency_code),
                      },
                      {
                        label: t("settlement.features.moneyDashboard.ui.requested"),
                        value: formatDateTime(payout.requested_at),
                      },
                      ...(payout.sent_at
                        ? [
                            {
                              label: t("settlement.features.moneyDashboard.ui.sent"),
                              value: formatDateTime(payout.sent_at),
                            },
                          ]
                        : []),
                      ...(payout.completed_at
                        ? [
                            {
                              label: t("settlement.features.moneyDashboard.ui.completed"),
                              value: formatDateTime(payout.completed_at),
                            },
                          ]
                        : []),
                    ]}
                    total={payoutStatusLabel(payout.status)}
                    totalLabel={t("settlement.features.moneyDashboard.ui.status")}
                  />
                </SideSheet>
              </Stack>
            ),
            timestamp: formatDateTime(payout.updated_at),
          }))}
        />
      </PageSection>

      <PageSection title={t("settlement.features.moneyDashboard.ui.walletActivity")}>
        <DataTable
          rows={[...entries]}
          getRowId={(entry) => entry.ledger_entry_id}
          columns={[
            {
              key: "kind",
              header: t("settlement.features.moneyDashboard.ui.activity"),
              cell: (entry) =>
                entry.kind === "adjustment"
                  ? t("settlement.features.moneyDashboard.ui.walletAdjustment")
                  : (entry.description ?? entry.kind),
            },
            {
              key: "amount",
              header: t("settlement.features.moneyDashboard.ui.amount"),
              cell: (entry) => formatMoney(entry.amount, entry.currency_code),
            },
            {
              key: "status",
              header: t("settlement.features.moneyDashboard.ui.status"),
              cell: (entry) => (
                <Badge tone={entry.funds_status === "available" ? "success" : "warning"}>{entry.funds_status}</Badge>
              ),
            },
            {
              key: "posted",
              header: t("settlement.features.moneyDashboard.ui.posted"),
              cell: (entry) => formatDate(entry.posted_at),
            },
            {
              key: "actions",
              header: t("settlement.features.moneyDashboard.ui.actions"),
              cell: (entry) =>
                entry.kind === "adjustment" && entry.adjustment_display_reference ? (
                  <LinkButton
                    href={`/account/desk/money?drawer=wallet-adjustment&entity=${encodeURIComponent(entry.adjustment_display_reference)}`}
                    tone="secondary"
                    size="sm"
                  >
                    {t("settlement.features.moneyDashboard.ui.viewBreakdown")}
                  </LinkButton>
                ) : null,
            },
          ]}
          emptyTitle={t("settlement.features.moneyDashboard.ui.noWalletActivity")}
          emptyDescription={t("settlement.features.moneyDashboard.ui.noWalletActivityDetail")}
        />
      </PageSection>
    </Page>
  );
}
