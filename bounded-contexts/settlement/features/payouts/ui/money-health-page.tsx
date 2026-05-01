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
import type {
  SettlementPayoutRow,
  SettlementReconciliationRunRow,
} from "../read-model/queries";

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
        eyebrow="Operations"
        title="Money Health"
        description="Review payout demand, reconciliation history, and provider-facing money movement signals."
        actions={
          <LinkButton href="/account/payout-operations" tone="secondary">
            Payout operations
          </LinkButton>
        }
      />

      <PageSection title="Platform Balance Forecast">
        <Stack gap={3}>
          <Card>
            <Stack gap={2}>
              <Badge tone="accent">Provider balance</Badge>
              <Text weight="semibold">
                {formatMoney(
                  platformBalanceForecast.available_amount,
                  platformBalanceForecast.currency_code,
                )} available
              </Text>
              <Text size="sm" tone="secondary">
                Pending payout demand: {formatMoney(
                  platformBalanceForecast.pending_payout_demand_amount,
                  platformBalanceForecast.currency_code,
                )}
              </Text>
              <Text size="sm" tone="secondary">
                Forecast after pending demand: {formatMoney(
                  platformBalanceForecast.forecast_after_pending_demand_amount,
                  platformBalanceForecast.currency_code,
                )}
              </Text>
            </Stack>
          </Card>
        </Stack>
      </PageSection>

      <PageSection title="Provider Diagnostics">
        <DataTable
          rows={[
            {
              id: "adapter",
              label: "Adapter",
              value:
                providerHealth.adapter_mode === "fake"
                  ? "Local test adapter"
                  : providerHealth.provider_name,
            },
            {
              id: "webhooks",
              label: "Webhook signatures",
              value: providerHealth.webhook_signature_required
                ? "Required"
                : "Local only",
            },
            {
              id: "balance",
              label: "Platform balance",
              value: providerHealth.platform_balance_supported
                ? "Checked before payout"
                : "Unavailable",
            },
            {
              id: "payouts",
              label: "Connected payouts",
              value: providerHealth.connected_account_payouts_supported
                ? "Enabled through adapter"
                : "Unavailable",
            },
          ]}
          getRowId={(row) => row.id}
          columns={[
            {
              key: "label",
              header: "Signal",
              cell: (row) => row.label,
            },
            {
              key: "value",
              header: "Status",
              cell: (row) => row.value,
            },
          ]}
        />
      </PageSection>

      <PageSection title="Payouts Needing Attention">
        <DataTable
          rows={[...payouts]}
          getRowId={(row) => row.payout_id}
          columns={[
            {
              key: "payout",
              header: "Payout",
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.payout_id}</Text>
                  <Text size="sm" tone="secondary">{row.status}</Text>
                </Stack>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "updated",
              header: "Updated",
              cell: (row) => new Date(row.updated_at).toLocaleString(),
            },
            {
              key: "action",
              header: "Action",
              cell: (row) => (
                <LinkButton href={`/account/payouts/${row.payout_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No payout issues"
          emptyDescription="Payouts that need reconciliation or review appear here."
        />
      </PageSection>

      <PageSection title="Recent Reconciliation">
        <DataTable
          rows={[...reconciliationRuns]}
          getRowId={(row) => row.reconciliation_run_id}
          columns={[
            {
              key: "status",
              header: "Status",
              cell: (row) => <Badge tone={row.error_count > 0 ? "warning" : "success"}>{row.status}</Badge>,
            },
            {
              key: "counts",
              header: "Counts",
              cell: (row) =>
                `Checked ${row.checked_count}; reconciled ${row.reconciled_count}; errors ${row.error_count}`,
            },
            {
              key: "completed",
              header: "Completed",
              cell: (row) => new Date(row.completed_at).toLocaleString(),
            },
          ]}
          emptyTitle="No reconciliation runs"
          emptyDescription="Scheduled and manual reconciliation outcomes appear here."
        />
      </PageSection>
    </Page>
  );
}
