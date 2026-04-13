import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "../read-model/queries";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

function directionTone(direction: string) {
  return direction === "credit" ? "success" : "danger";
}

function fundsStatusTone(status: string) {
  return status === "available" ? "success" : "warning";
}

export function SettlementWalletPage({
  wallet,
  entries,
}: {
  wallet: SettlementWalletRow;
  entries: readonly SettlementLedgerEntryRow[];
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Settlement"
        title="Wallet"
        description="Track your pending and available balances, and review all ledger activity."
        actions={
          <LinkButton href="/account/payouts" tone="secondary">
            View payouts
          </LinkButton>
        }
      />

      <PageSection title="Balance">
        <Stack gap={3}>
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">Pending</Text>
              <Text size="lg">{formatMoney(wallet.pending_balance_amount, wallet.currency_code)}</Text>
              <Text size="sm" tone="secondary">Funds in transit, not yet available for payout.</Text>
            </Stack>
          </Card>
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">Available</Text>
              <Text size="lg">{formatMoney(wallet.available_balance_amount, wallet.currency_code)}</Text>
              <Text size="sm" tone="secondary">Funds ready for payout.</Text>
            </Stack>
          </Card>
        </Stack>
      </PageSection>

      <PageSection title="Ledger">
        <DataTable
          rows={[...entries]}
          getRowId={(row) => row.ledger_entry_id}
          columns={[
            {
              key: "kind",
              header: "Kind",
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.kind}</Text>
                  {row.description ? (
                    <Text size="sm" tone="secondary">{row.description}</Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "direction",
              header: "Direction",
              cell: (row) => (
                <Badge tone={directionTone(row.direction)}>{row.direction}</Badge>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              align: "right",
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "status",
              header: "Status",
              cell: (row) =>
                row.direction === "credit" ? (
                  <Badge tone={fundsStatusTone(row.funds_status)}>{row.funds_status}</Badge>
                ) : null,
            },
            {
              key: "posted_at",
              header: "Posted",
              cell: (row) => new Date(row.posted_at).toLocaleDateString(),
            },
          ]}
          emptyTitle="No ledger activity"
          emptyDescription="Ledger entries appear here once sales, fees, and payouts are processed."
        />
      </PageSection>
    </Page>
  );
}
