import {
  Badge,
  Button,
  Card,
  CurrencyInput,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow } from "../read-model/queries";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import { PayoutReadinessPanel } from "../../payout-readiness/ui/payout-readiness-panel";
import {
  capPayoutAmountToPolicy,
  payoutAmountPolicy,
} from "../domain/payout-policy";

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

function statusLabel(status: string) {
  switch (status) {
    case "requested":
      return "Requested";
    case "in-transit":
      return "On the way";
    case "completed":
      return "Paid";
    case "failed":
      return "Needs attention";
    default:
      return status;
  }
}

function estimatedArrivalLabel(row: SettlementPayoutRow) {
  if (row.completed_at) {
    return `Paid ${new Date(row.completed_at).toLocaleDateString()}`;
  }
  if (row.failed_at) {
    return "Not sent";
  }
  if (row.sent_at) {
    return "Typically 1-3 business days";
  }
  return "After provider submission";
}

export function SettlementPayoutListPage({
  wallet,
  payouts,
  payoutReadiness,
  errorMessage,
  payoutDraft,
  payoutConfirmation,
  showOperations = false,
}: {
  wallet: SettlementWalletRow;
  payouts: readonly SettlementPayoutRow[];
  payoutReadiness?: SettlementPayoutReadinessRow | null;
  errorMessage?: string | null;
  payoutDraft?: Readonly<{ amount: string; note: string | null }> | null;
  payoutConfirmation?: Readonly<{ amount: string; note: string | null }> | null;
  showOperations?: boolean;
}) {
  const canRequestPayout = payoutReadiness?.status === "ready";

  return (
    <Page>
      <PageHeader
        eyebrow="Settlement"
        title="Payouts"
        description="Request payouts from your available wallet balance to your saved payout account."
        actions={
          <Stack direction="row" gap={2}>
            {showOperations ? (
              <LinkButton href="/account/payout-operations" tone="secondary">
                Operations
              </LinkButton>
            ) : null}
            <LinkButton href="/account/settlement" tone="secondary">
              View wallet
            </LinkButton>
          </Stack>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Request Payout">
        <Card>
          <Stack gap={3}>
            {payoutReadiness ? (
              <PayoutReadinessPanel payoutReadiness={payoutReadiness} showActions />
            ) : null}
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                Available to request: {formatMoney(wallet.available_balance_amount, wallet.currency_code)}
              </Text>
              <Text size="sm" tone="secondary">
                Payouts must be between {formatMoney(payoutAmountPolicy.minimumAmount, payoutAmountPolicy.currencyCode)} and {formatMoney(payoutAmountPolicy.maximumAmount, payoutAmountPolicy.currencyCode)}. Arrival is usually 1-3 business days after the provider accepts the payout.
              </Text>
            </Stack>
            {payoutConfirmation ? (
              <Stack gap={2}>
                <form method="post">
                  <Stack gap={3}>
                    <input type="hidden" name="intent" value="confirm-payout" />
                    <input type="hidden" name="amount" value={payoutConfirmation.amount} />
                    {payoutConfirmation.note ? (
                      <input type="hidden" name="note" value={payoutConfirmation.note} />
                    ) : null}
                    <Stack gap={1}>
                      <Text weight="semibold">Confirm payout request</Text>
                      <Text size="sm" tone="secondary">
                        Amount: {formatMoney(payoutConfirmation.amount, wallet.currency_code)}
                      </Text>
                      <Text size="sm" tone="secondary">
                        Payout account: Saved payout account
                      </Text>
                      <Text size="sm" tone="secondary">
                        Estimated arrival: Usually 1-3 business days after provider acceptance
                      </Text>
                      {payoutConfirmation.note ? (
                        <Text size="sm" tone="secondary">
                          Note: {payoutConfirmation.note}
                        </Text>
                      ) : null}
                    </Stack>
                    <Button type="submit" disabled={!canRequestPayout}>
                      Confirm payout
                    </Button>
                  </Stack>
                </form>
                <form method="post">
                  <input type="hidden" name="intent" value="edit-payout" />
                  <input type="hidden" name="amount" value={payoutConfirmation.amount} />
                  {payoutConfirmation.note ? (
                    <input type="hidden" name="note" value={payoutConfirmation.note} />
                  ) : null}
                  <Button type="submit" tone="secondary">
                    Back to edit
                  </Button>
                </form>
              </Stack>
            ) : (
              <form method="post">
              <Stack gap={3}>
                <input type="hidden" name="intent" value="preview-payout" />
                <input
                  type="hidden"
                  name="availableAmount"
                  value={wallet.available_balance_amount}
                />
                <CurrencyInput
                  label="Amount"
                  name="amount"
                  placeholder="0.00"
                  inputMode="decimal"
                  min={payoutAmountPolicy.minimumAmount}
                  max={payoutAmountPolicy.maximumAmount}
                  step="0.01"
                  required
                  disabled={!canRequestPayout}
                  defaultValue={payoutDraft?.amount ?? ""}
                />
                <Stack direction="row" gap={2}>
                  <Button
                    type="submit"
                    name="quickAmount"
                    value="minimum"
                    tone="secondary"
                    disabled={!canRequestPayout}
                  >
                    Minimum {formatMoney(payoutAmountPolicy.minimumAmount, wallet.currency_code)}
                  </Button>
                  <Button
                    type="submit"
                    name="quickAmount"
                    value="available"
                    tone="secondary"
                    disabled={!canRequestPayout}
                  >
                    Full available {formatMoney(
                      capPayoutAmountToPolicy(wallet.available_balance_amount),
                      wallet.currency_code,
                    )}
                  </Button>
                </Stack>
                <TextInput
                  label="Note"
                  name="note"
                  placeholder="Optional memo"
                  disabled={!canRequestPayout}
                  defaultValue={payoutDraft?.note ?? ""}
                />
                <Button type="submit" disabled={!canRequestPayout}>
                  Request payout
                </Button>
              </Stack>
            </form>
            )}
          </Stack>
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
                <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
              ),
            },
            {
              key: "destination",
              header: "Payout account",
              cell: () => "Saved payout account",
            },
            {
              key: "estimated_arrival",
              header: "Estimated arrival",
              cell: (row) => estimatedArrivalLabel(row),
            },
            {
              key: "requested_at",
              header: "Requested",
              cell: (row) => new Date(row.requested_at).toLocaleDateString(),
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
          emptyDescription="Request a payout from your available balance to get started."
        />
      </PageSection>
    </Page>
  );
}
