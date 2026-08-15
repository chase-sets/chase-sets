import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import { Badge, DataTable, LinkButton, Page, PageHeader, PageSection, Stack, Text } from "@chase-sets/design-system";
import type { SettlementPayoutRow, SettlementReconciliationRunRow } from "../read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";

function payoutDetailHref(payoutId: string, marketplaceOrigin?: string | null) {
  if (!marketplaceOrigin) {
    return null;
  }

  return new URL(`/account/desk/payouts/${payoutId}`, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
}

export function SettlementMoneyHealthPage({
  payouts,
  negativeBalanceAccounts,
  reconciliationRuns,
  platformBalanceForecast,
  providerHealth,
  marketplaceOrigin,
}: {
  payouts: readonly SettlementPayoutRow[];
  negativeBalanceAccounts: readonly SettlementWalletRow[];
  reconciliationRuns: readonly SettlementReconciliationRunRow[];
  platformBalanceForecast: Readonly<{
    currency_code: string;
    available_amount: string;
    pending_payout_demand_amount: string;
    forecast_after_pending_demand_amount: string;
  }>;
  providerHealth: Readonly<{
    provider_name: string;
    adapter_mode: string;
    webhook_signature_required: boolean;
    webhook_failure_classes: readonly string[];
    platform_balance_supported: boolean;
    connected_account_payouts_supported: boolean;
  }>;
  marketplaceOrigin?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.payouts.ui.moneyHealthPage.operations")}
        title={t("settlement.features.payouts.ui.moneyHealthPage.money.health")}
        description={t(
          "settlement.features.payouts.ui.moneyHealthPage.review.payout.demand.reconciliation.history.and",
        )}
        actions={
          <LinkButton href="/commerce/payout-operations" tone="secondary">
            {t("settlement.features.payouts.ui.moneyHealthPage.payout.operations")}
          </LinkButton>
        }
      />

      <PageSection
        data-testid="platform-balance-forecast-furniture"
        title={t("settlement.features.payouts.ui.moneyHealthPage.platform.balance.forecast")}
      >
        <Stack gap={3}>
          <Stack gap={2}>
            <Badge tone="accent">{t("settlement.features.payouts.ui.moneyHealthPage.provider.balance")}</Badge>
            <Text weight="semibold">
              {t("settlement.features.payouts.ui.moneyHealthPage.amount.available", {
                amount: formatMoney(platformBalanceForecast.available_amount, platformBalanceForecast.currency_code),
              })}
            </Text>
            <Text size="sm" tone="secondary">
              {t("settlement.features.payouts.ui.moneyHealthPage.pending.payout.demand")}
              {formatMoney(platformBalanceForecast.pending_payout_demand_amount, platformBalanceForecast.currency_code)}
            </Text>
            <Text size="sm" tone="secondary">
              {t("settlement.features.payouts.ui.moneyHealthPage.forecast.after.pending.demand")}
              {formatMoney(
                platformBalanceForecast.forecast_after_pending_demand_amount,
                platformBalanceForecast.currency_code,
              )}
            </Text>
          </Stack>
        </Stack>
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.moneyHealthPage.provider.diagnostics")}>
        <DataTable
          rows={[
            {
              id: "adapter",
              label: t("settlement.features.payouts.ui.moneyHealthPage.adapter"),
              value:
                providerHealth.adapter_mode === "fake"
                  ? t("settlement.features.payouts.ui.moneyHealthPage.local.test.adapter")
                  : providerHealth.provider_name,
            },
            {
              id: "webhooks",
              label: t("settlement.features.payouts.ui.moneyHealthPage.webhook.signatures"),
              value: providerHealth.webhook_signature_required
                ? t("settlement.features.payouts.ui.moneyHealthPage.required")
                : t("settlement.features.payouts.ui.moneyHealthPage.local.only"),
            },
            {
              id: "webhook-failure-classes",
              label: t("settlement.features.payouts.ui.moneyHealthPage.webhook.failure.classes"),
              value: providerHealth.webhook_failure_classes.join(", "),
            },
            {
              id: "balance",
              label: t("settlement.features.payouts.ui.moneyHealthPage.platform.balance"),
              value: providerHealth.platform_balance_supported
                ? t("settlement.features.payouts.ui.moneyHealthPage.checked.before.payout")
                : t("settlement.features.payouts.ui.moneyHealthPage.unavailable"),
            },
            {
              id: "payouts",
              label: t("settlement.features.payouts.ui.moneyHealthPage.connected.payouts"),
              value: providerHealth.connected_account_payouts_supported
                ? t("settlement.features.payouts.ui.moneyHealthPage.enabled.through.adapter")
                : t("settlement.features.payouts.ui.moneyHealthPage.unavailable.2"),
            },
          ]}
          getRowId={(row) => row.id}
          columns={[
            {
              key: "label",
              header: t("settlement.features.payouts.ui.moneyHealthPage.signal"),
              cell: (row) => row.label,
            },
            {
              key: "value",
              header: t("settlement.features.payouts.ui.moneyHealthPage.status"),
              cell: (row) => row.value,
            },
          ]}
        />
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.moneyHealthPage.negative.balance.accounts")}>
        <DataTable
          rows={[...negativeBalanceAccounts]}
          getRowId={(row) => row.account_id}
          columns={[
            {
              key: "account",
              header: t("settlement.features.payouts.ui.moneyHealthPage.account"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.account_id}</Text>
                  <Badge tone={row.negative_balance_status === "collections" ? "warning" : "neutral"}>
                    {row.negative_balance_status}
                  </Badge>
                </Stack>
              ),
            },
            {
              key: "amount",
              header: t("settlement.features.payouts.ui.moneyHealthPage.negative.amount"),
              cell: (row) => formatMoney(row.available_balance_amount, row.currency_code),
            },
            {
              key: "age",
              header: t("settlement.features.payouts.ui.moneyHealthPage.negative.since"),
              cell: (row) => (row.negative_balance_started_at ? formatDateTime(row.negative_balance_started_at) : "-"),
            },
            {
              key: "collections",
              header: t("settlement.features.payouts.ui.moneyHealthPage.collections"),
              cell: (row) => (row.collections_escalated_at ? formatDateTime(row.collections_escalated_at) : "-"),
            },
          ]}
          emptyTitle={t("settlement.features.payouts.ui.moneyHealthPage.no.negative.balances")}
          emptyDescription={t(
            "settlement.features.payouts.ui.moneyHealthPage.accounts.with.negative.wallet.balances.appear",
          )}
        />
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.moneyHealthPage.payouts.needing.attention")}>
        <DataTable
          rows={[...payouts]}
          getRowId={(row) => row.payout_id}
          columns={[
            {
              key: "payout",
              header: t("settlement.features.payouts.ui.moneyHealthPage.payout"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.payout_id}</Text>
                  <Text size="sm" tone="secondary">
                    {row.status}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "amount",
              header: t("settlement.features.payouts.ui.moneyHealthPage.amount"),
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "updated",
              header: t("settlement.features.payouts.ui.moneyHealthPage.updated"),
              cell: (row) => formatDateTime(row.updated_at),
            },
            {
              key: "action",
              header: t("settlement.features.payouts.ui.moneyHealthPage.action"),
              cell: (row) => {
                const href = payoutDetailHref(row.payout_id, marketplaceOrigin);
                return href ? (
                  <LinkButton
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    trailingIcon="externalLink"
                    tone="secondary"
                    size="sm"
                  >
                    {t("settlement.features.payouts.ui.moneyHealthPage.open")}
                  </LinkButton>
                ) : null;
              },
            },
          ]}
          emptyTitle={t("settlement.features.payouts.ui.moneyHealthPage.no.payout.issues")}
          emptyDescription={t(
            "settlement.features.payouts.ui.moneyHealthPage.payouts.that.need.reconciliation.or.review",
          )}
        />
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.moneyHealthPage.recent.reconciliation")}>
        <DataTable
          rows={[...reconciliationRuns]}
          getRowId={(row) => row.reconciliation_run_id}
          columns={[
            {
              key: "status",
              header: t("settlement.features.payouts.ui.moneyHealthPage.status.2"),
              cell: (row) => <Badge tone={row.error_count > 0 ? "warning" : "success"}>{row.status}</Badge>,
            },
            {
              key: "counts",
              header: t("settlement.features.payouts.ui.moneyHealthPage.counts"),
              cell: (row) =>
                t("settlement.features.payouts.ui.moneyHealthPage.reconciliation.counts", {
                  checked: row.checked_count,
                  reconciled: row.reconciled_count,
                  errors: row.error_count,
                }),
            },
            {
              key: "completed",
              header: t("settlement.features.payouts.ui.moneyHealthPage.completed"),
              cell: (row) => formatDateTime(row.completed_at),
            },
          ]}
          emptyTitle={t("settlement.features.payouts.ui.moneyHealthPage.no.reconciliation.runs")}
          emptyDescription={t(
            "settlement.features.payouts.ui.moneyHealthPage.scheduled.and.manual.reconciliation.outcomes.appear",
          )}
        />
      </PageSection>
    </Page>
  );
}
