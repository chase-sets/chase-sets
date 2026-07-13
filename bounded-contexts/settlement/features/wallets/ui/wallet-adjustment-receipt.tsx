import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import { Badge, Card, KeyValueList, Stack, Text } from "@chase-sets/design-system";
import type { SettlementWalletAdjustment } from "../../../client";
import {
  walletAdjustmentDirectionLabel,
  walletAdjustmentDirectionTone,
  walletAdjustmentReasonCodeLabel,
  walletAdjustmentStatusLabel,
  walletAdjustmentStatusTone,
} from "./wallet-adjustment-copy";
import type { WalletAdjustmentReasonCode } from "../domain/wallet-adjustment";

/**
 * The command-owned receipt for a Wallet Adjustment: exactly the fields an
 * operator needs to confirm what happened, in plain reviewer-facing language.
 * Never renders raw JSON, the ledger-entry id, the generic "workflow"
 * concept, or the server-derived idempotency key.
 */
export function WalletAdjustmentReceiptCard({
  adjustment,
  targetAccountLabel,
}: {
  adjustment: SettlementWalletAdjustment;
  targetAccountLabel: string;
}) {
  const items = [
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.account"),
      value: targetAccountLabel,
    },
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.direction"),
      value: (
        <Badge tone={walletAdjustmentDirectionTone(adjustment.direction)}>
          {walletAdjustmentDirectionLabel(adjustment.direction)}
        </Badge>
      ),
    },
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.amount"),
      value: formatMoney(adjustment.amount, adjustment.currency_code),
    },
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.reason"),
      value: walletAdjustmentReasonCodeLabel(adjustment.reason_code as WalletAdjustmentReasonCode),
    },
    ...(adjustment.explanation
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.explanation"),
            value: adjustment.explanation,
          },
        ]
      : []),
    ...(adjustment.evidence_references.length > 0
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.references"),
            value: adjustment.evidence_references.join(", "),
          },
        ]
      : []),
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.requested"),
      value: formatDateTime(adjustment.requested_at),
    },
    ...(adjustment.approved_at
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.approved"),
            value: formatDateTime(adjustment.approved_at),
          },
        ]
      : []),
    ...(adjustment.posted_at
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.posted"),
            value: formatDateTime(adjustment.posted_at),
          },
        ]
      : []),
    ...(adjustment.available_balance_before !== null && adjustment.available_balance_after !== null
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.balance.impact"),
            value: t("settlement.features.wallets.ui.walletAdjustmentReceipt.balance.before.after", {
              before: formatMoney(adjustment.available_balance_before, adjustment.currency_code),
              after: formatMoney(adjustment.available_balance_after, adjustment.currency_code),
            }),
          },
        ]
      : []),
    ...(adjustment.rejected_at
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.rejected"),
            value: adjustment.rejection_reason
              ? t("settlement.features.wallets.ui.walletAdjustmentReceipt.rejected.on.with.reason", {
                  date: formatDateTime(adjustment.rejected_at),
                  reason: adjustment.rejection_reason,
                })
              : formatDateTime(adjustment.rejected_at),
          },
        ]
      : []),
    ...(adjustment.reversed_at
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentReceipt.reversed"),
            value: formatDateTime(adjustment.reversed_at),
          },
        ]
      : []),
  ];

  return (
    <Card>
      <Stack gap={3}>
        <Stack direction="row" gap={2} align="center">
          <Badge tone={walletAdjustmentStatusTone(adjustment.status)}>
            {walletAdjustmentStatusLabel(adjustment.status)}
          </Badge>
          <Text weight="semibold">{t("settlement.features.wallets.ui.walletAdjustmentReceipt.receipt")}</Text>
        </Stack>
        <KeyValueList items={items} />
      </Stack>
    </Card>
  );
}
