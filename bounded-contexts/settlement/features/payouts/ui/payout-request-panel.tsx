import { formatMoney, t } from "@chase-sets/localization";
import {
  Button,
  CurrencyInput,
  Form,
  HiddenInput,
  ProgressiveDisclosure,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { SettlementPayoutPreview } from "../../../client";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import { capPayoutAmountToPolicy, payoutAmountPolicy } from "../domain/payout-policy";
import { payoutUnavailableReasonLabel } from "../domain/reason-codes";

function unavailableReasons(wallet: SettlementWalletRow, readiness: SettlementPayoutReadinessRow) {
  const reasons: string[] = [];
  if (readiness.status !== "ready") {
    reasons.push(payoutUnavailableReasonLabel("payout-setup-incomplete"));
  }
  if (readiness.status === "ready" && !readiness.updated_at) {
    reasons.push(payoutUnavailableReasonLabel("payout-setup-refresh-required"));
  }
  if (readiness.missing_requirements.length > 0) {
    reasons.push(payoutUnavailableReasonLabel("provider-requirements-open"));
  }
  if (Number.parseFloat(wallet.available_balance_amount) <= 0) {
    reasons.push(payoutUnavailableReasonLabel("no-available-wallet-balance"));
  }
  return reasons;
}

export function SettlementPayoutRequestPanel({
  wallet,
  payoutReadiness,
  canRequestPayouts,
  draft,
  confirmation,
}: {
  wallet: SettlementWalletRow;
  payoutReadiness: SettlementPayoutReadinessRow;
  canRequestPayouts: boolean;
  draft?: Readonly<{ amount: string; note: string | null }> | null;
  confirmation?: Readonly<{ amount: string; note: string | null; preview: SettlementPayoutPreview }> | null;
}) {
  const canRequest =
    canRequestPayouts &&
    payoutReadiness.status === "ready" &&
    Boolean(payoutReadiness.updated_at) &&
    Number.parseFloat(wallet.available_balance_amount) > 0;
  const reasons = canRequest ? [] : unavailableReasons(wallet, payoutReadiness);

  if (confirmation) {
    return (
      <Stack gap={3}>
        <Text weight="semibold">{t("settlement.features.moneyDashboard.ui.confirmPayout")}</Text>
        <Text>
          {formatMoney(confirmation.amount, wallet.currency_code)} ·{" "}
          {t("settlement.features.moneyDashboard.ui.availableAfter", {
            amount: formatMoney(confirmation.preview.estimated_wallet_balance_after, wallet.currency_code),
          })}
        </Text>
        {confirmation.preview.unavailable_reason_details.length > 0 ? (
          <ProgressiveDisclosure
            title={t("settlement.features.moneyDashboard.ui.payoutBlocked")}
            summary={confirmation.preview.unavailable_reason_details[0]?.message}
            tone="warning"
            defaultOpen
          >
            <Stack gap={1}>
              {confirmation.preview.unavailable_reason_details.map((reason) => (
                <Text key={reason.code} size="sm" tone="secondary">
                  {reason.message}
                </Text>
              ))}
            </Stack>
          </ProgressiveDisclosure>
        ) : null}
        <Form spacing="none" method="post">
          <HiddenInput type="hidden" name="intent" value="confirm-payout" />
          <HiddenInput type="hidden" name="amount" value={confirmation.amount} />
          {confirmation.note ? <HiddenInput type="hidden" name="note" value={confirmation.note} /> : null}
          <Button type="submit" disabled={!confirmation.preview.can_request}>
            {t("settlement.features.moneyDashboard.ui.confirmPayout")}
          </Button>
        </Form>
        <Form spacing="none" method="post">
          <HiddenInput type="hidden" name="intent" value="edit-payout" />
          <HiddenInput type="hidden" name="amount" value={confirmation.amount} />
          {confirmation.note ? <HiddenInput type="hidden" name="note" value={confirmation.note} /> : null}
          <Button type="submit" tone="secondary">
            {t("settlement.features.moneyDashboard.ui.editPayout")}
          </Button>
        </Form>
      </Stack>
    );
  }

  return (
    <Form spacing="none" method="post">
      <Stack gap={3}>
        <HiddenInput type="hidden" name="intent" value="preview-payout" />
        <HiddenInput type="hidden" name="availableAmount" value={wallet.available_balance_amount} />
        <Text size="sm" tone="secondary">
          {t("settlement.features.moneyDashboard.ui.availableToRequest", {
            amount: formatMoney(wallet.available_balance_amount, wallet.currency_code),
          })}
        </Text>
        {reasons.length > 0 ? (
          <ProgressiveDisclosure
            title={t("settlement.features.moneyDashboard.ui.payoutBlocked")}
            summary={reasons[0]}
            tone="warning"
            defaultOpen
          >
            <Stack gap={1}>
              {reasons.map((reason) => (
                <Text key={reason} size="sm" tone="secondary">
                  {reason}
                </Text>
              ))}
            </Stack>
          </ProgressiveDisclosure>
        ) : null}
        <CurrencyInput
          label={t("settlement.features.moneyDashboard.ui.payoutAmount")}
          name="amount"
          currencyCode={wallet.currency_code}
          currencyAccessibleDescription={t("localization.currency.amountIn", { currency: wallet.currency_code })}
          decrementLabel={t("localization.currency.decreaseAmount")}
          incrementLabel={t("localization.currency.increaseAmount")}
          placeholder="0.00"
          min={payoutAmountPolicy.minimumAmount}
          max={payoutAmountPolicy.maximumAmount}
          step="0.01"
          required
          disabled={!canRequest}
          defaultValue={draft?.amount}
        />
        <Stack direction="row" gap={2}>
          <Button type="submit" name="quickAmount" value="minimum" tone="secondary" disabled={!canRequest}>
            {t("settlement.features.moneyDashboard.ui.minimumAmount", {
              amount: formatMoney(payoutAmountPolicy.minimumAmount, wallet.currency_code),
            })}
          </Button>
          <Button type="submit" name="quickAmount" value="available" tone="secondary" disabled={!canRequest}>
            {t("settlement.features.moneyDashboard.ui.fullAvailable", {
              amount: formatMoney(capPayoutAmountToPolicy(wallet.available_balance_amount), wallet.currency_code),
            })}
          </Button>
        </Stack>
        <ProgressiveDisclosure
          title={t("settlement.features.moneyDashboard.ui.optionalNote")}
          summary={draft?.note ?? t("settlement.features.moneyDashboard.ui.optionalNoteSummary")}
          tone="info"
        >
          <TextInput
            label={t("settlement.features.moneyDashboard.ui.optionalNote")}
            name="note"
            defaultValue={draft?.note ?? ""}
            disabled={!canRequest}
          />
        </ProgressiveDisclosure>
        <Button type="submit" disabled={!canRequest}>
          {t("settlement.features.moneyDashboard.ui.previewPayout")}
        </Button>
      </Stack>
    </Form>
  );
}
