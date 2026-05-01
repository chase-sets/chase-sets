import {
  Badge,
  Card,
  DataTable,
  Grid,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "../read-model/queries";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import { PayoutReadinessPanel } from "../../payout-readiness/ui/payout-readiness-panel";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

function directionTone(direction: string) {
  return direction === "credit" ? "success" : "danger";
}

function fundsStatusTone(status: string) {
  return status === "available" ? "success" : "warning";
}

function checklistTone(isComplete: boolean) {
  return isComplete ? "success" : "neutral";
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
  const hasLedgerActivity = entries.length > 0;
  const setupChecklist = [
    {
      label: "Start payout setup",
      complete: Boolean(payoutReadiness?.provider_reference),
      detail: payoutReadiness?.provider_reference
        ? "Provider account created"
        : "Create the hosted payout setup session",
    },
    {
      label: "Finish account verification",
      complete: payoutReadiness?.status === "ready",
      detail: payoutReadiness
        ? `Setup is ${payoutReadiness.status.replace("-", " ")}`
        : "Setup has not started",
    },
    {
      label: "Add payout destination",
      complete: payoutReadiness?.payout_destination_status === "ready",
      detail: payoutReadiness?.payout_destination_status === "ready"
        ? "Destination is ready"
        : "Add or verify a payout destination",
    },
    {
      label: "Earn available funds",
      complete: hasLedgerActivity && availableBalance > 0,
      detail: availableBalance > 0
        ? `${formatMoney(wallet.available_balance_amount, wallet.currency_code)} available`
        : "Available funds appear here after sales settle",
    },
  ];

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
        <Grid columns={{ base: 1, md: 2 }} gap={3}>
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
              <Text size="sm" tone="secondary">Funds ready for platform purchases and, after payout setup, payouts.</Text>
            </Stack>
          </Card>
        </Grid>
        <Stack gap={1}>
          <Text size="sm" tone="secondary">
            Lifetime credits: {formatMoney(wallet.total_credited_amount, wallet.currency_code)}
          </Text>
          <Text size="sm" tone="secondary">
            Lifetime debits: {formatMoney(wallet.total_debited_amount, wallet.currency_code)}
          </Text>
          <Text size="sm" tone="secondary">
            Available balance can be used for marketplace purchases or requested as a payout after setup is ready. Payout requests move money into a payout-in-progress ledger entry until the provider confirms the result.
          </Text>
        </Stack>
      </PageSection>

      {payoutReadiness ? (
        <PageSection title="Payout Setup">
          <Card>
            <PayoutReadinessPanel payoutReadiness={payoutReadiness} />
          </Card>
        </PageSection>
      ) : null}

      <PageSection title="Seller Setup Checklist">
        <Grid columns={{ base: 1, md: 2 }} gap={3}>
          {setupChecklist.map((item) => (
            <Card key={item.label}>
              <Stack gap={2}>
                <Badge tone={checklistTone(item.complete)}>
                  {item.complete ? "Done" : "Next"}
                </Badge>
                <Text weight="semibold">{item.label}</Text>
                <Text size="sm" tone="secondary">{item.detail}</Text>
              </Stack>
            </Card>
          ))}
        </Grid>
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
