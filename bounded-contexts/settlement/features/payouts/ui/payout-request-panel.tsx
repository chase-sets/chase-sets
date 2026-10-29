import { formatMoney, t } from "@chase-sets/localization";
import { trySignedMoneyToCents } from "@chase-sets/primitives/money";
import {
  Button,
  CurrencyInput,
  Form,
  HiddenInput,
  LinkButton,
  PriceBreakdown,
  ProgressiveDisclosure,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { SettlementPayoutPreview, SettlementPayoutQuickAmounts } from "../../../client";
import type { PayoutAvailability } from "../read-model/payout-summary";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";

function PayoutFeeDisclosureLinks() {
  return (
    <Stack gap={2}>
      <LinkButton href="/payments-terms#payout-fee" tone="secondary" size="sm">
        {t("settlement.features.payouts.ui.payoutFeeTerms")}
      </LinkButton>
      <LinkButton href="/seller-agreement#fees-and-deductions" tone="secondary" size="sm">
        {t("settlement.features.payouts.ui.sellerFeesAndDeductions")}
      </LinkButton>
    </Stack>
  );
}

export function SettlementPayoutRequestPanel({
  wallet,
  availability,
  quickAmounts,
  draft,
  confirmation,
}: {
  wallet: SettlementWalletRow;
  availability: PayoutAvailability;
  quickAmounts: SettlementPayoutQuickAmounts;
  draft?: Readonly<{ amount: string; note: string | null }> | null;
  confirmation?: Readonly<{ amount: string; note: string | null; preview: SettlementPayoutPreview }> | null;
}) {
  const canRequest = availability.can_request;
  const reasons = availability.unavailable_reason_details;
  const fullAvailableCents = trySignedMoneyToCents(quickAmounts.full_available_amount);

  if (confirmation) {
    return (
      <Stack gap={3}>
        <Text weight="semibold">{t("settlement.features.moneyDashboard.ui.confirmPayout")}</Text>
        <PriceBreakdown
          lines={[
            {
              label: t("settlement.features.payouts.ui.requestedAmount"),
              value: formatMoney(confirmation.preview.requested_amount, wallet.currency_code),
            },
            ...confirmation.preview.fee_lines.map((line) => ({
              label: line.label,
              value: formatMoney(line.amount, wallet.currency_code),
            })),
          ]}
          total={formatMoney(confirmation.preview.net_amount, wallet.currency_code)}
          totalLabel={t("settlement.features.payouts.ui.netPayout")}
        />
        <Text>
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
        <PayoutFeeDisclosureLinks />
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
        <Text size="sm" tone="secondary">
          {t("settlement.features.moneyDashboard.ui.availableToRequest", {
            amount: formatMoney(wallet.available_balance_amount, wallet.currency_code),
          })}
        </Text>
        {reasons.length > 0 ? (
          <ProgressiveDisclosure
            title={t("settlement.features.moneyDashboard.ui.payoutBlocked")}
            summary={reasons[0]?.message}
            tone="warning"
            defaultOpen
          >
            <Stack gap={1}>
              {reasons.map((reason) => (
                <Text key={reason.code} size="sm" tone="secondary">
                  {reason.message}
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
          min={quickAmounts.minimum_amount}
          max={quickAmounts.maximum_amount}
          step="0.01"
          required
          disabled={!canRequest}
          defaultValue={draft?.amount}
        />
        <Stack direction="row" gap={2}>
          <Button type="submit" name="quickAmount" value="minimum" tone="secondary" disabled={!canRequest}>
            {t("settlement.features.moneyDashboard.ui.minimumAmount", {
              amount: formatMoney(quickAmounts.minimum_amount, wallet.currency_code),
            })}
          </Button>
          <Button
            type="submit"
            name="quickAmount"
            value="available"
            tone="secondary"
            disabled={!canRequest || fullAvailableCents === null || fullAvailableCents <= 0n}
          >
            {t("settlement.features.moneyDashboard.ui.fullAvailable", {
              amount: formatMoney(quickAmounts.full_available_amount, wallet.currency_code),
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
        <PayoutFeeDisclosureLinks />
        <Button type="submit" disabled={!canRequest}>
          {t("settlement.features.moneyDashboard.ui.previewPayout")}
        </Button>
      </Stack>
    </Form>
  );
}
