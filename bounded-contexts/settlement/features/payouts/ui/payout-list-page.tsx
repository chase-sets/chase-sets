import { formatMoney, t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  Card,
  CurrencyInput,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  ProgressiveDisclosure,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow } from "../read-model/queries";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import { PayoutReadinessPanel } from "../../payout-readiness/ui/payout-readiness-panel";
import { capPayoutAmountToPolicy, payoutAmountPolicy } from "../domain/payout-policy";
import { payoutUnavailableReasonLabel } from "../domain/reason-codes";

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
      return t("settlement.features.payouts.ui.payoutListPage.requested");
    case "in-transit":
      return t("settlement.features.payouts.ui.payoutListPage.on.the.way");
    case "completed":
      return t("settlement.features.payouts.ui.payoutListPage.paid");
    case "failed":
      return t("settlement.features.payouts.ui.payoutListPage.needs.attention");
    default:
      return status;
  }
}

function estimatedArrivalLabel(row: SettlementPayoutRow) {
  if (row.completed_at) {
    return t("settlement.features.payouts.ui.payoutListPage.paid.on.date", {
      date: new Date(row.completed_at).toLocaleDateString(),
    });
  }
  if (row.failed_at) {
    return t("settlement.features.payouts.ui.payoutListPage.not.sent");
  }
  if (row.sent_at) {
    return t("settlement.features.payouts.ui.payoutListPage.typically.1.3.business.days");
  }
  return t("settlement.features.payouts.ui.payoutListPage.after.provider.submission");
}

function payoutUnavailableReasons(wallet: SettlementWalletRow, payoutReadiness?: SettlementPayoutReadinessRow | null) {
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
      t("settlement.features.payouts.ui.payoutListPage.no.available.balance.detail", {
        reason: payoutUnavailableReasonLabel("no-available-wallet-balance"),
      }),
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
  setupNotice?: string | null;
}) {
  const attentionCount = payouts.filter((row) => row.status === "failed").length;
  const setupFresh = Boolean(payoutReadiness?.updated_at);
  const canRequestPayout =
    canRequestPayouts &&
    payoutReadiness?.status === "ready" &&
    setupFresh &&
    Number.parseFloat(wallet.available_balance_amount) > 0;
  const unavailableReasons = canRequestPayout ? [] : payoutUnavailableReasons(wallet, payoutReadiness);
  const confirmationRemainingBalance = payoutConfirmation
    ? (payoutConfirmation.preview?.estimated_wallet_balance_after ??
      subtractMoney(wallet.available_balance_amount, payoutConfirmation.amount))
    : null;
  const confirmationCanRequest = canRequestPayout && (payoutConfirmation?.preview?.can_request ?? true);

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.payouts.ui.payoutListPage.settlement")}
        title={t("settlement.features.payouts.ui.payoutListPage.payouts")}
        description={t("settlement.features.payouts.ui.payoutListPage.request.payouts.from.your.available.wallet")}
        actions={
          <LinkButton href="/account/settlement" tone="secondary">
            {t("settlement.features.payouts.ui.payoutListPage.view.wallet")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}
      {attentionCount > 0 ? (
        <Card>
          <Text weight="semibold">
            {t("settlement.features.payouts.ui.payoutListPage.n.payouts.need.attention", { count: attentionCount })}
          </Text>
        </Card>
      ) : null}
      {setupNotice ? (
        <Card>
          <Stack gap={1}>
            <Badge tone="success">{t("settlement.features.payouts.ui.payoutListPage.setup.checked")}</Badge>
            <Text>{setupNotice}</Text>
          </Stack>
        </Card>
      ) : null}

      <PageSection title={t("settlement.features.payouts.ui.payoutListPage.request.payout")}>
        <Card>
          <Stack gap={3}>
            {payoutReadiness ? (
              <PayoutReadinessPanel
                payoutReadiness={payoutReadiness}
                showActions={canSetupPayouts}
                showSupportEscalation={
                  payoutReadiness.status === "restricted" || payoutReadiness.missing_requirements.length > 0
                }
              />
            ) : null}
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutListPage.available.to.request")}
                {formatMoney(wallet.available_balance_amount, wallet.currency_code)}
              </Text>
              <Text size="sm" tone="secondary">
                {t("settlement.features.payouts.ui.payoutListPage.payouts.must.be.between")}
                {formatMoney(payoutAmountPolicy.minimumAmount, payoutAmountPolicy.currencyCode)}{" "}
                {t("settlement.features.payouts.ui.payoutListPage.and")}
                {formatMoney(payoutAmountPolicy.maximumAmount, payoutAmountPolicy.currencyCode)}
                {t("settlement.features.payouts.ui.payoutListPage.arrival.is.usually.1.3.business")}
              </Text>
            </Stack>
            {unavailableReasons.length > 0 ? (
              <ProgressiveDisclosure
                title={t("settlement.features.payouts.ui.payoutListPage.why.payouts.are.unavailable")}
                summary={unavailableReasons[0]}
                tone="warning"
                defaultOpen
              >
                <Stack gap={1}>
                  {unavailableReasons.map((reason) => (
                    <Text key={reason} size="sm" tone="secondary">
                      {reason}
                    </Text>
                  ))}
                </Stack>
              </ProgressiveDisclosure>
            ) : null}
            {payoutConfirmation ? (
              <Stack gap={2}>
                <Form spacing="none" method="post">
                  <Stack gap={3}>
                    <HiddenInput type="hidden" name="intent" value="confirm-payout" />
                    <HiddenInput type="hidden" name="amount" value={payoutConfirmation.amount} />
                    {payoutConfirmation.note ? (
                      <HiddenInput type="hidden" name="note" value={payoutConfirmation.note} />
                    ) : null}
                    <Stack gap={1}>
                      <Text weight="semibold">
                        {t("settlement.features.payouts.ui.payoutListPage.confirm.payout.request")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("settlement.features.payouts.ui.payoutListPage.amount")}
                        {formatMoney(payoutConfirmation.amount, wallet.currency_code)}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("settlement.features.payouts.ui.payoutListPage.available.after.request")}
                        {formatMoney(confirmationRemainingBalance ?? "0.00", wallet.currency_code)}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("settlement.features.payouts.ui.payoutListPage.payout.account.saved.payout.account")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("settlement.features.payouts.ui.payoutListPage.estimated.arrival.usually.1.3.business")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("settlement.features.payouts.ui.payoutListPage.if.the.provider.cannot.complete.the")}
                      </Text>
                      {payoutConfirmation.preview?.unavailable_reason_details.length ? (
                        <ProgressiveDisclosure
                          title={t("settlement.features.payouts.ui.payoutListPage.before.this.can.be.requested")}
                          summary={payoutConfirmation.preview.unavailable_reason_details[0]?.message}
                          tone="warning"
                          defaultOpen
                        >
                          <Stack gap={1}>
                            {payoutConfirmation.preview.unavailable_reason_details.map((reason) => (
                              <Text key={reason.code} size="sm" tone="secondary">
                                {reason.message}
                              </Text>
                            ))}
                          </Stack>
                        </ProgressiveDisclosure>
                      ) : null}
                      {payoutConfirmation.note ? (
                        <Text size="sm" tone="secondary">
                          {t("settlement.features.payouts.ui.payoutListPage.note")}
                          {payoutConfirmation.note}
                        </Text>
                      ) : null}
                    </Stack>
                    <Button type="submit" disabled={!confirmationCanRequest}>
                      {t("settlement.features.payouts.ui.payoutListPage.confirm.payout")}
                    </Button>
                  </Stack>
                </Form>
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="edit-payout" />
                  <HiddenInput type="hidden" name="amount" value={payoutConfirmation.amount} />
                  {payoutConfirmation.note ? (
                    <HiddenInput type="hidden" name="note" value={payoutConfirmation.note} />
                  ) : null}
                  <Button type="submit" tone="secondary">
                    {t("settlement.features.payouts.ui.payoutListPage.back.to.edit")}
                  </Button>
                </Form>
              </Stack>
            ) : (
              <Form spacing="none" method="post">
                <Stack gap={3}>
                  <HiddenInput type="hidden" name="intent" value="preview-payout" />
                  <HiddenInput type="hidden" name="availableAmount" value={wallet.available_balance_amount} />
                  <CurrencyInput
                    label={t("settlement.features.payouts.ui.payoutListPage.amount.2")}
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
                      {t("settlement.features.payouts.ui.payoutListPage.minimum")}
                      {formatMoney(payoutAmountPolicy.minimumAmount, wallet.currency_code)}
                    </Button>
                    <Button
                      type="submit"
                      name="quickAmount"
                      value="available"
                      tone="secondary"
                      disabled={!canRequestPayout}
                    >
                      {t("settlement.features.payouts.ui.payoutListPage.full.available")}
                      {formatMoney(capPayoutAmountToPolicy(wallet.available_balance_amount), wallet.currency_code)}
                    </Button>
                  </Stack>
                  <ProgressiveDisclosure
                    title={t("settlement.features.payouts.ui.payoutListPage.note.2")}
                    summary={
                      payoutDraft?.note
                        ? t("settlement.features.payouts.ui.payoutListPage.note.summary", {
                            note: payoutDraft.note,
                          })
                        : t("settlement.features.payouts.ui.payoutListPage.optional.memo")
                    }
                    tone="info"
                  >
                    <TextInput
                      label={t("settlement.features.payouts.ui.payoutListPage.note.2")}
                      name="note"
                      placeholder={t("settlement.features.payouts.ui.payoutListPage.optional.memo")}
                      disabled={!canRequestPayout}
                      defaultValue={payoutDraft?.note ?? ""}
                    />
                  </ProgressiveDisclosure>
                  <Button type="submit" disabled={!canRequestPayout}>
                    {t("settlement.features.payouts.ui.payoutListPage.preview.payout")}
                  </Button>
                </Stack>
              </Form>
            )}
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.payoutListPage.payout.history")}>
        <DataTable
          rows={[...payouts]}
          getRowId={(row) => row.payout_id}
          columns={[
            {
              key: "amount",
              header: t("settlement.features.payouts.ui.payoutListPage.amount.3"),
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "status",
              header: t("settlement.features.payouts.ui.payoutListPage.status"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>,
            },
            {
              key: "destination",
              header: t("settlement.features.payouts.ui.payoutListPage.payout.account"),
              cell: () => t("settlement.features.payouts.ui.payoutListPage.saved.payout.account"),
            },
            {
              key: "estimated_arrival",
              header: t("settlement.features.payouts.ui.payoutListPage.estimated.arrival"),
              cell: (row) => estimatedArrivalLabel(row),
            },
            {
              key: "requested_at",
              header: t("settlement.features.payouts.ui.payoutListPage.requested.2"),
              cell: (row) => new Date(row.requested_at).toLocaleDateString(),
            },
            {
              key: "actions",
              header: t("settlement.features.payouts.ui.payoutListPage.actions"),
              cell: (row) => (
                <LinkButton href={`/account/payouts/${row.payout_id}`} tone="secondary" size="sm">
                  {t("settlement.features.payouts.ui.payoutListPage.open")}
                </LinkButton>
              ),
            },
          ]}
          emptyTitle={t("settlement.features.payouts.ui.payoutListPage.no.payouts.yet")}
          emptyDescription={t("settlement.features.payouts.ui.payoutListPage.request.a.payout.from.your.available")}
        />
      </PageSection>
    </Page>
  );
}
