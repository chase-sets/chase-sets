import { useRef, useState } from "react";
import { formatMoney, t } from "@chase-sets/localization";
import { useNavigation, useSubmit } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { AlertDialog, Banner, Button, HiddenInput, Stack, Text, TextInput, Textarea } from "@chase-sets/design-system";
import type { SettlementWalletAdjustment } from "../../../client";
import type { WalletAdjustmentFlowError } from "../../../support/request-support/wallet-adjustment-flow-error";
import { WALLET_ADJUSTMENT_FORM_INTENTS } from "../../../support/request-support/wallet-adjustment-guided-flow-form-data";
import { walletAdjustmentFlowErrorTitle, walletAdjustmentFlowErrorTone } from "./wallet-adjustment-copy";
import { WalletAdjustmentReauthenticationLink } from "./wallet-adjustment-reauthentication-link";

/**
 * Reversal is always elevated by construction (ADR 0020): the API requires a
 * primary approver and a distinct elevated approver for the linked reversal
 * adjustment, so both are collected up front rather than discovered via a
 * conflict retry the way approval's occasional elevation is.
 */
export function WalletAdjustmentReversalActions({
  adjustment,
  targetAccountLabel,
  returnTo,
  flowError,
}: {
  adjustment: SettlementWalletAdjustment;
  targetAccountLabel: string;
  returnTo: string;
  flowError: WalletAdjustmentFlowError | null;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const formRef = useRef<HTMLFormElement | null>(null);
  const submitting = navigation.state === "submitting";
  const [open, setOpen] = useState(false);
  const [approvedByUserId, setApprovedByUserId] = useState("");
  const [elevationApprovedByUserId, setElevationApprovedByUserId] = useState("");
  const [explanation, setExplanation] = useState("");
  const canReverse = approvedByUserId.trim().length > 0 && elevationApprovedByUserId.trim().length > 0;

  if (adjustment.status !== "posted") {
    return null;
  }

  return (
    <Stack gap={3}>
      {flowError ? (
        <Stack gap={2}>
          <Banner
            tone={walletAdjustmentFlowErrorTone(flowError.kind)}
            title={walletAdjustmentFlowErrorTitle(flowError.kind)}
            description={flowError.message}
          />
          <WalletAdjustmentReauthenticationLink errorKind={flowError.kind} returnTo={returnTo} />
        </Stack>
      ) : null}

      <Text size="sm" tone="secondary">
        {t("settlement.features.wallets.ui.walletAdjustmentReversalActions.reversal.explanation")}
      </Text>

      <TextInput
        label={t("settlement.features.wallets.ui.walletAdjustmentReversalActions.approver")}
        value={approvedByUserId}
        onChange={(event) => setApprovedByUserId(event.target.value)}
        placeholder="usr_..."
        required
      />
      <TextInput
        label={t("settlement.features.wallets.ui.walletAdjustmentReversalActions.elevated.approver")}
        value={elevationApprovedByUserId}
        onChange={(event) => setElevationApprovedByUserId(event.target.value)}
        placeholder="usr_..."
        required
      />
      <Textarea
        label={t("settlement.features.wallets.ui.walletAdjustmentReversalActions.reversal.reason")}
        value={explanation}
        onChange={(event) => setExplanation(event.target.value)}
      />

      <Stack direction="row" gap={2}>
        <AlertDialog
          open={open}
          onOpenChange={setOpen}
          tone="danger"
          title={t("settlement.features.wallets.ui.walletAdjustmentReversalActions.confirm.title")}
          description={t("settlement.features.wallets.ui.walletAdjustmentReversalActions.confirm.description", {
            amount: formatMoney(adjustment.amount, adjustment.currency_code),
            account: targetAccountLabel,
          })}
          confirmLabel={t("settlement.features.wallets.ui.walletAdjustmentReversalActions.confirm.reverse")}
          cancelLabel={t("settlement.features.wallets.ui.walletAdjustmentReversalActions.cancel")}
          onConfirm={() => {
            if (formRef.current) {
              submit(formRef.current);
            }
          }}
          trigger={
            <Button tone="danger" disabled={!canReverse || submitting}>
              {t("settlement.features.wallets.ui.walletAdjustmentReversalActions.reverse")}
            </Button>
          }
        />
      </Stack>

      <RouterForm
        id={`wallet-adjustment-reverse-form-${adjustment.adjustment_id}`}
        ref={formRef}
        method="post"
        spacing="none"
        aria-hidden="true"
      >
        <HiddenInput type="hidden" name="intent" value={WALLET_ADJUSTMENT_FORM_INTENTS.reverse} />
        <HiddenInput type="hidden" name="adjustmentId" value={adjustment.adjustment_id} />
        <HiddenInput type="hidden" name="approvedByUserId" value={approvedByUserId.trim()} />
        <HiddenInput type="hidden" name="elevationApprovedByUserId" value={elevationApprovedByUserId.trim()} />
        <HiddenInput type="hidden" name="explanation" value={explanation} />
      </RouterForm>
    </Stack>
  );
}
