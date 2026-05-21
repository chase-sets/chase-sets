import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow, SettlementReconciliationRunRow } from "../read-model/queries";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

export function SettlementMoneyHealthPage({
  payouts,
  reconciliationRuns,
  platformBalanceForecast,
  providerHealth,
}: {
  payouts: readonly SettlementPayoutRow[];
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
    platform_balance_supported: boolean;
    connected_account_payouts_supported: boolean;
  }>;
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
          <LinkButton href="/account/payout-operations" tone="secondary">
            {t("settlement.features.payouts.ui.moneyHealthPage.payout.operations")}
          </LinkButton>
        }
      />

      <PageSection title={t("settlement.features.payouts.ui.moneyHealthPage.platform.balance.forecast")}>
        <Stack gap={3}>
          <Card>
            <Stack gap={2}>
              <Badge tone="accent">{t("settlement.features.payouts.ui.moneyHealthPage.provider.balance")}</Badge>
              <Text weight="semibold">
                {t("settlement.features.payouts.ui.moneyHealthPage.amount.available", {
                  amount: formatMoney(platformBalanceForecast.available_amount, platformBalanceForecast.currency_code),
                })}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.moneyHealthPage.pending.payout.demand")}
                {formatMoney(
                  platformBalanceForecast.pending_payout_demand_amount,
                  platformBalanceForecast.currency_code,
                )}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.moneyHealthPage.forecast.after.pending.demand")}
                {formatMoney(
                  platformBalanceForecast.forecast_after_pending_demand_amount,
                  platformBalanceForecast.currency_code,
                )}
              </Text>
            </Stack>
          </Card>
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
              cell: (row) => new Date(row.updated_at).toLocaleString(),
            },
            {
              key: "action",
              header: t("settlement.features.payouts.ui.moneyHealthPage.action"),
              cell: (row) => (
                <LinkButton href={`/account/payouts/${row.payout_id}`} tone="secondary" size="sm">
                  {t("settlement.features.payouts.ui.moneyHealthPage.open")}
                </LinkButton>
              ),
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
              cell: (row) => new Date(row.completed_at).toLocaleString(),
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
