import {
  Badge,
  Button,
  Card,
  DataTable,
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

function operationsTone(row: SettlementPayoutRow) {
  if (row.status === "failed") {
    return "danger";
  }
  if (!row.provider_payout_reference) {
    return "warning";
  }
  return "accent";
}

function operationsLabel(row: SettlementPayoutRow) {
  if (row.status === "failed" && row.next_retry_at) {
    return "Retry queued";
  }
  if (!row.provider_payout_reference) {
    return "Needs provider reference";
  }
  if (row.status === "in-transit") {
    return "Ready to reconcile";
  }
  return "Review";
}

export function SettlementPayoutOperationsPage({
  payouts,
  runResult,
  currentFilter = "all",
  lastCheckedAt,
}: {
  payouts: readonly SettlementPayoutRow[];
  runResult?: Readonly<{
    checked: number;
    reconciled: number;
    ignored: number;
    skipped: number;
    errors: readonly Readonly<{ payoutId: string; message: string }>[];
  }> | null;
  currentFilter?: string;
  lastCheckedAt?: string | null;
}) {
  const filters = [
    ["all", "All"],
    ["missing-provider-reference", "Missing reference"],
    ["in-transit", "In transit"],
    ["failed", "Failed"],
    ["stale-requested", "Older than 15 minutes"],
  ] as const;

  return (
    <Page>
      <PageHeader
        eyebrow="Settlement"
        title="Payout Operations"
        description="Monitor payouts that may need provider reconciliation or support review."
        actions={
          <LinkButton href="/account/payouts" tone="secondary">
            Back to payouts
          </LinkButton>
        }
      />

      <PageSection title="Reconciliation">
        <Card>
          <Stack gap={3}>
            <form method="post">
              <input type="hidden" name="intent" value="run-reconciliation" />
              <Button type="submit">Run reconciliation</Button>
            </form>
            <Text size="sm" tone="secondary">
              Last checked: {lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : "Not checked in this session"}
            </Text>
            {runResult ? (
              <Stack gap={1}>
                <Text size="sm" tone="secondary">
                  Checked {runResult.checked}; reconciled {runResult.reconciled}; ignored {runResult.ignored}; skipped {runResult.skipped}.
                </Text>
                {runResult.errors.length > 0 ? (
                  <Text size="sm" tone="secondary">
                    Errors: {runResult.errors.map((error) => `${error.payoutId}: ${error.message}`).join("; ")}
                  </Text>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Needs Attention">
        <Stack direction="row" gap={2}>
          {filters.map(([value, label]) => (
            <LinkButton
              key={value}
              href={value === "all" ? "/account/payout-operations" : `/account/payout-operations?filter=${value}`}
              tone={currentFilter === value ? "primary" : "secondary"}
              size="sm"
            >
              {label}
            </LinkButton>
          ))}
        </Stack>
        <DataTable
          rows={[...payouts]}
          getRowId={(row) => row.payout_id}
          columns={[
            {
              key: "status",
              header: "Status",
              cell: (row) => (
                <Badge tone={operationsTone(row) as any}>{operationsLabel(row)}</Badge>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "provider_payout_reference",
              header: "Provider payout",
              cell: (row) => row.provider_payout_reference ?? "Missing",
            },
            {
              key: "provider_status",
              header: "Provider status",
              cell: (row) => row.provider_status ?? "Unknown",
            },
            {
              key: "last_reconciled_at",
              header: "Last checked",
              cell: (row) => row.last_reconciled_at
                ? new Date(row.last_reconciled_at).toLocaleString()
                : "Not checked",
            },
            {
              key: "retry",
              header: "Retry policy",
              cell: (row) => row.next_retry_at
                ? `${row.retry_count} attempt${row.retry_count === 1 ? "" : "s"}; next ${new Date(row.next_retry_at).toLocaleString()}`
                : row.retry_count > 0
                  ? `${row.retry_count} attempt${row.retry_count === 1 ? "" : "s"}`
                  : "None",
            },
            {
              key: "updated_at",
              header: "Updated",
              cell: (row) => new Date(row.updated_at).toLocaleString(),
            },
            {
              key: "actions",
              header: "Actions",
              cell: (row) => (
                <LinkButton href={`/account/payouts/${row.payout_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No payouts need attention"
          emptyDescription="Provider payout reconciliation is clear."
        />
      </PageSection>
    </Page>
  );
}
