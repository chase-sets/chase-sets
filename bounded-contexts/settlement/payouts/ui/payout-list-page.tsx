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
  TextInput,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow } from "../queries";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

function statusTone(status: string) {
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

export function SettlementPayoutListPage({
  payouts,
  errorMessage,
}: {
  payouts: readonly SettlementPayoutRow[];
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Settlement"
        title="Payouts"
        description="Schedule and track payouts from your available wallet balance."
        actions={
          <LinkButton href="/account/settlement" tone="secondary">
            View wallet
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Schedule Payout">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="schedule-payout" />
              <TextInput
                label="Amount"
                name="amount"
                placeholder="0.00"
                inputMode="decimal"
                required
              />
              <TextInput
                label="Destination reference"
                name="destinationReference"
                placeholder="Bank account or routing reference"
              />
              <TextInput
                label="Note"
                name="note"
                placeholder="Optional memo"
              />
              <Button type="submit">Schedule payout</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Payout History">
        <DataTable
          rows={[...payouts]}
          getRowId={(row) => row.payout_id}
          columns={[
            {
              key: "amount",
              header: "Amount",
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => (
                <Badge tone={statusTone(row.status)}>{row.status}</Badge>
              ),
            },
            {
              key: "destination",
              header: "Destination",
              cell: (row) => row.destination_reference ?? "—",
            },
            {
              key: "scheduled_at",
              header: "Scheduled",
              cell: (row) => new Date(row.scheduled_at).toLocaleDateString(),
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
          emptyTitle="No payouts yet"
          emptyDescription="Schedule a payout from your available balance to get started."
        />
      </PageSection>
    </Page>
  );
}
