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
import { payoutUnavailableReasonLabel } from "../domain/reason-codes";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

function subtractMoney(left: string, right: string) {
  return (Number.parseFloat(left) - Number.parseFloat(right)).toFixed(2);
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

function payoutUnavailableReasons(
  wallet: SettlementWalletRow,
  payoutReadiness?: SettlementPayoutReadinessRow | null,
) {
  const reasons: string[] = [];
  const availableBalance = Number.parseFloat(wallet.available_balance_amount);
  if (!payoutReadiness || payoutReadiness.status === "not-started") {
    reasons.push(payoutUnavailableReasonLabel("payout-setup-incomplete"));
  } else if (payoutReadiness.status !== "ready") {
    reasons.push(payoutUnavailableReasonLabel("payout-setup-incomplete"));
  }
  if (payoutReadiness?.status === "ready" && !payoutReadiness.updated_at) {
    reasons.push(payoutUnavailableReasonLabel("payout-setup-refresh-required"));
  }
  if (payoutReadiness?.missing_requirements.length) {
    reasons.push(payoutUnavailableReasonLabel("provider-requirements-open"));
  }
  if (availableBalance <= 0) {
    reasons.push(
      `${payoutUnavailableReasonLabel("no-available-wallet-balance")} Pending funds become available after settlement review.`,
    );
  }
  return reasons;
}

export function SettlementPayoutListPage({
  wallet,
  payouts,
  payoutReadiness,
  errorMessage,
  payoutDraft,
  payoutConfirmation,
  canRequestPayouts = false,
  canSetupPayouts = false,
  showOperations = false,
  setupNotice = null,
}: {
  wallet: SettlementWalletRow;
  payouts: readonly SettlementPayoutRow[];
  payoutReadiness?: SettlementPayoutReadinessRow | null;
  errorMessage?: string | null;
  payoutDraft?: Readonly<{ amount: string; note: string | null }> | null;
  payoutConfirmation?: Readonly<{
    amount: string;
    note: string | null;
    preview?: Readonly<{
      estimated_wallet_balance_after: string;
      can_request: boolean;
      unavailable_reason_details: readonly Readonly<{
        code: string;
        message: string;
      }>[];
    }>;
  }> | null;
  canRequestPayouts?: boolean;
  canSetupPayouts?: boolean;
  showOperations?: boolean;
  setupNotice?: string | null;
}) {
  const setupFresh = Boolean(payoutReadiness?.updated_at);
  const canRequestPayout =
    canRequestPayouts &&
    payoutReadiness?.status === "ready" &&
    setupFresh &&
    Number.parseFloat(wallet.available_balance_amount) > 0;
  const unavailableReasons = canRequestPayout
    ? []
    : payoutUnavailableReasons(wallet, payoutReadiness);
  const confirmationRemainingBalance = payoutConfirmation
    ? payoutConfirmation.preview?.estimated_wallet_balance_after ??
      subtractMoney(wallet.available_balance_amount, payoutConfirmation.amount)
    : null;
  const confirmationCanRequest =
    canRequestPayout && (payoutConfirmation?.preview?.can_request ?? true);

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
      {setupNotice ? (
        <Card>
          <Stack gap={1}>
            <Badge tone="success">Setup checked</Badge>
            <Text>{setupNotice}</Text>
          </Stack>
        </Card>
      ) : null}

      <PageSection title="Request Payout">
        <Card>
          <Stack gap={3}>
            {payoutReadiness ? (
              <PayoutReadinessPanel
                payoutReadiness={payoutReadiness}
                showActions={canSetupPayouts}
              />
            ) : null}
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                Available to request: {formatMoney(wallet.available_balance_amount, wallet.currency_code)}
              </Text>
              <Text size="sm" tone="secondary">
                Payouts must be between {formatMoney(payoutAmountPolicy.minimumAmount, payoutAmountPolicy.currencyCode)} and {formatMoney(payoutAmountPolicy.maximumAmount, payoutAmountPolicy.currencyCode)}. Arrival is usually 1-3 business days after the provider accepts the payout.
              </Text>
            </Stack>
            {unavailableReasons.length > 0 ? (
              <Stack gap={1}>
                <Text size="sm" weight="semibold">Why payouts are unavailable</Text>
                {unavailableReasons.map((reason) => (
                  <Text key={reason} size="sm" tone="secondary">
                    {reason}
                  </Text>
                ))}
              </Stack>
            ) : null}
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
                        Available after request: {formatMoney(confirmationRemainingBalance ?? "0.00", wallet.currency_code)}
                      </Text>
                      <Text size="sm" tone="secondary">
                        Payout account: Saved payout account
                      </Text>
                      <Text size="sm" tone="secondary">
                        Estimated arrival: Usually 1-3 business days after provider acceptance
                      </Text>
                      <Text size="sm" tone="secondary">
                        If the provider cannot complete the transfer or payout, the wallet is credited back automatically.
                      </Text>
                      {payoutConfirmation.preview?.unavailable_reason_details.length ? (
                        <Stack gap={1}>
                          <Text size="sm" weight="semibold">
                            Before this can be requested
                          </Text>
                          {payoutConfirmation.preview.unavailable_reason_details.map(
                            (reason) => (
                              <Text key={reason.code} size="sm" tone="secondary">
                                {reason.message}
                              </Text>
                            ),
                          )}
                        </Stack>
                      ) : null}
                      {payoutConfirmation.note ? (
                        <Text size="sm" tone="secondary">
                          Note: {payoutConfirmation.note}
                        </Text>
                      ) : null}
                    </Stack>
                    <Button type="submit" disabled={!confirmationCanRequest}>
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
                  Preview payout
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
