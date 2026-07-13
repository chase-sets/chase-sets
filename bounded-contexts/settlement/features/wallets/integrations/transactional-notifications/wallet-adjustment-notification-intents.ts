import { formatMoney, t } from "@chase-sets/localization";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { AccountId, WalletAdjustmentId } from "@chase-sets/primitives/typed-ids";
import type {
  EmailNotificationChannel,
  NotificationMessage,
  WebNotificationChannel,
} from "@chase-sets/outbound-messaging";
import type { WalletAdjustmentReasonCode } from "../../domain/wallet-adjustment";
import type { LedgerEntryDirection } from "../../../../support/runtime-support/common";

/**
 * Customer-safe Wallet Adjustment reason-category copy for account notices
 * and the account-facing ledger detail surface. Deliberately separate from
 * the operator-facing labels in `ui/wallet-adjustment-copy.ts`: this file
 * owns its own translation keys so account-facing wording can evolve without
 * touching the platform-admin workbench, matching how the Notifications
 * context's own intent mappers never reuse another context's UI copy.
 */
const CUSTOMER_REASON_CATEGORY_LABEL_KEYS: Record<WalletAdjustmentReasonCode, string> = {
  "transaction-correction":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.transaction.correction",
  "refund-correction":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.refund.correction",
  "fee-correction":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.fee.correction",
  "dispute-resolution":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.dispute.resolution",
  "fraud-recovery":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.fraud.recovery",
  "support-resolution":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.support.resolution",
  "legal-obligation":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.legal.obligation",
  "goodwill-cash-credit":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.goodwill.cash.credit",
  "operational-error":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.operational.error",
  "other-with-required-detail":
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.other",
};

export function walletAdjustmentCustomerReasonCategoryLabel(reasonCode: WalletAdjustmentReasonCode): string {
  return t(CUSTOMER_REASON_CATEGORY_LABEL_KEYS[reasonCode]);
}

function walletAdjustmentReferenceOrRaw(adjustmentId: string): string {
  return deriveDisplayReferenceOrRaw(adjustmentId as WalletAdjustmentId);
}

function walletAdjustmentDetailHref(adjustmentId: string): string {
  return `/account/wallet/adjustments/${walletAdjustmentReferenceOrRaw(adjustmentId)}`;
}

export type WalletAdjustmentPostedNotificationInput = Readonly<{
  adjustmentId: string;
  targetAccountId: AccountId;
  targetAccountEmail?: string | null;
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode: string;
  reasonCode: WalletAdjustmentReasonCode;
  resultingBalanceAmount: string;
  /** True when this posting is itself the correcting entry for an earlier adjustment (its own notice is suppressed in favor of the reversal notice below). */
  isReversalPosting: boolean;
  correlationId: string;
}>;

/**
 * Ordinary Wallet Adjustment posted notice. Never sent for a posting that is
 * itself a reversal's own correcting entry -- callers check
 * `isReversalPosting` and route those through
 * {@link mapWalletAdjustmentReversedToNotification} instead, so a reversal
 * produces exactly one notice, not two.
 */
export function mapWalletAdjustmentPostedToNotification(
  input: WalletAdjustmentPostedNotificationInput,
): NotificationMessage {
  const reference = walletAdjustmentReferenceOrRaw(input.adjustmentId);
  const actionHref = walletAdjustmentDetailHref(input.adjustmentId);
  const reasonCategory = walletAdjustmentCustomerReasonCategoryLabel(input.reasonCode);
  const signedAmount = formatMoney(input.amount, input.currencyCode);
  const resultingBalance = formatMoney(input.resultingBalanceAmount, input.currencyCode);

  const title =
    input.direction === "credit"
      ? t(
          "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.posted.credit.title",
          { amount: signedAmount },
        )
      : t(
          "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.posted.debit.title",
          { amount: signedAmount },
        );
  const body = t(
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.posted.body",
    { reasonCategory, resultingBalance, reference },
  );

  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.targetAccountId },
    title,
    body,
    actionHref,
  };
  const targetEmail = input.targetAccountEmail?.trim();
  const channels: NotificationMessage["channels"] = targetEmail
    ? [
        {
          channel: "email",
          to: [{ email: targetEmail }],
          subject: title,
          templateId: "wallet_adjustment_posted",
          templateVersion: 1,
          templateData: { reasonCategory, signedAmount, resultingBalance, reference, actionHref },
        } satisfies EmailNotificationChannel,
        webChannel,
      ]
    : [webChannel];

  return {
    messageType: "settlement.wallet-adjustment.posted",
    criticality: "commerce",
    category: "order-critical",
    recipientAccountId: input.targetAccountId,
    title,
    body,
    actionHref,
    templateId: "wallet_adjustment_posted",
    templateVersion: 1,
    locale: "en",
    templateData: { reasonCategory, signedAmount, resultingBalance, reference, actionHref },
    channels,
    idempotencyKey: `settlement:wallet_adjustment_posted:${input.adjustmentId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.targetAccountId },
  };
}

export type WalletAdjustmentReversedNotificationInput = Readonly<{
  originalAdjustmentId: string;
  reversalAdjustmentId: string;
  targetAccountId: AccountId;
  targetAccountEmail?: string | null;
  originalDirection: LedgerEntryDirection;
  amount: string;
  currencyCode: string;
  resultingBalanceAmount: string;
  correlationId: string;
}>;

/** Links the original and correcting entries so the account holder can see exactly what changed. */
export function mapWalletAdjustmentReversedToNotification(
  input: WalletAdjustmentReversedNotificationInput,
): NotificationMessage {
  const originalReference = walletAdjustmentReferenceOrRaw(input.originalAdjustmentId);
  const reversalReference = walletAdjustmentReferenceOrRaw(input.reversalAdjustmentId);
  const actionHref = walletAdjustmentDetailHref(input.originalAdjustmentId);
  const resultingBalance = formatMoney(input.resultingBalanceAmount, input.currencyCode);

  const title = t(
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reversed.title",
    { reference: originalReference },
  );
  const body = t(
    "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reversed.body",
    { originalReference, reversalReference, resultingBalance },
  );

  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.targetAccountId },
    title,
    body,
    actionHref,
  };
  const targetEmail = input.targetAccountEmail?.trim();
  const channels: NotificationMessage["channels"] = targetEmail
    ? [
        {
          channel: "email",
          to: [{ email: targetEmail }],
          subject: title,
          templateId: "wallet_adjustment_reversed",
          templateVersion: 1,
          templateData: { originalReference, reversalReference, resultingBalance, actionHref },
        } satisfies EmailNotificationChannel,
        webChannel,
      ]
    : [webChannel];

  return {
    messageType: "settlement.wallet-adjustment.reversed",
    criticality: "commerce",
    category: "order-critical",
    recipientAccountId: input.targetAccountId,
    title,
    body,
    actionHref,
    templateId: "wallet_adjustment_reversed",
    templateVersion: 1,
    locale: "en",
    templateData: { originalReference, reversalReference, resultingBalance, actionHref },
    channels,
    idempotencyKey: `settlement:wallet_adjustment_reversed:${input.originalAdjustmentId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.targetAccountId },
  };
}
