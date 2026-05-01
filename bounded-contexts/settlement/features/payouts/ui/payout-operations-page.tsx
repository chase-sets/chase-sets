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
import type {
  SettlementPayoutRow,
  SettlementProviderIdempotencyKeyRow,
} from "../read-model/queries";

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
  idempotencyKeys = [],
  runResult,
  currentFilter = "all",
  lastCheckedAt,
}: {
  payouts: readonly SettlementPayoutRow[];
  idempotencyKeys?: readonly SettlementProviderIdempotencyKeyRow[];
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
  const failedCount = payouts.filter((payout) => payout.status === "failed").length;
  const missingReferenceCount = payouts.filter((payout) => !payout.provider_payout_reference).length;
  const retryQueuedCount = payouts.filter((payout) => Boolean(payout.next_retry_at)).length;
  const staleCheckCount = payouts.filter((payout) => {
    if (!payout.last_reconciled_at) {
      return payout.status !== "requested";
    }
    return Date.now() - new Date(payout.last_reconciled_at).getTime() > 30 * 60 * 1000;
  }).length;

  return (
    <Page>
      <PageHeader
        eyebrow="Settlement"
        title="Payout Operations"
        description="Monitor payouts that may need provider reconciliation or support review."
        actions={
          <Stack direction="row" gap={2}>
            <LinkButton href="/account/money-health" tone="secondary">
              Money health
            </LinkButton>
            <LinkButton href="/account/payouts" tone="secondary">
              Back to payouts
            </LinkButton>
          </Stack>
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
        <DataTable
          rows={[
            { id: "failed", label: "Failed payouts", value: failedCount, detail: "Provider reported failure or internal submission failed" },
            { id: "missing-reference", label: "Missing provider references", value: missingReferenceCount, detail: "Transfer or payout reference has not been recorded" },
            { id: "retry-queued", label: "Retry queued", value: retryQueuedCount, detail: "Retry policy has a next provider action time" },
            { id: "stale-checks", label: "Stale reconciliation", value: staleCheckCount, detail: "Provider status has not been checked recently" },
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
              header: "Count",
              cell: (row) => (
                <Badge tone={row.value > 0 ? "warning" : "success"}>
                  {row.value}
                </Badge>
              ),
            },
            {
              key: "detail",
              header: "Meaning",
              cell: (row) => row.detail,
            },
          ]}
        />
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

      <PageSection title="Recent Provider Attempts">
        <DataTable
          rows={[...idempotencyKeys]}
          getRowId={(row) => row.operation_key}
          columns={[
            {
              key: "operation",
              header: "Operation",
              cell: (row) => row.operation_kind,
            },
            {
              key: "payout",
              header: "Payout",
              cell: (row) => row.payout_id ?? "None",
            },
            {
              key: "provider",
              header: "Provider reference",
              cell: (row) => row.provider_object_reference ?? "Pending",
            },
            {
              key: "idempotency",
              header: "Idempotency key",
              cell: (row) => row.idempotency_key,
            },
            {
              key: "created",
              header: "Created",
              cell: (row) => new Date(row.created_at).toLocaleString(),
            },
          ]}
          emptyTitle="No provider attempts"
          emptyDescription="Provider transfer and payout submissions appear here."
        />
      </PageSection>
    </Page>
  );
}
