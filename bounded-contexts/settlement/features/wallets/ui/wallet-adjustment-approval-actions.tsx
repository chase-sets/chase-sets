import { useRef, useState } from "react";
import { formatMoney, t } from "@chase-sets/localization";
import { useNavigation, useSubmit } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { AlertDialog, Banner, Button, HiddenInput, Stack, Text, TextInput, Textarea } from "@chase-sets/design-system";
import type { SettlementWalletAdjustment } from "../../../client";
import type { WalletAdjustmentFlowError } from "../../../support/request-support/wallet-adjustment-flow-error";
import { walletAdjustmentFlowErrorTitle, walletAdjustmentFlowErrorTone } from "./wallet-adjustment-copy";

/**
 * Approve/reject guided actions for a single "requested" Wallet Adjustment.
 * The server is the authority on separation of duties (a requester can never
 * approve their own request, and an elevated approver must be distinct from
 * both); this only prevents the obvious same-actor case in the UI ahead of
 * that server round trip. Both actions require an explicit
 * `AlertDialog` confirmation click -- a bare Enter keypress in the rejection
 * reason field or the elevation-approver field can never post either action.
 */
export function WalletAdjustmentApprovalActions({
  adjustment,
  targetAccountLabel,
  currentActorUserId,
  flowError,
}: {
  adjustment: SettlementWalletAdjustment;
  targetAccountLabel: string;
  currentActorUserId: string;
  flowError: WalletAdjustmentFlowError | null;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const approveFormRef = useRef<HTMLFormElement | null>(null);
  const rejectFormRef = useRef<HTMLFormElement | null>(null);
  const submitting = navigation.state === "submitting";
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [elevationApprovedByUserId, setElevationApprovedByUserId] = useState("");
  const isSameActor = adjustment.requested_by === currentActorUserId;
  const requiresElevatedApproval = flowError?.kind === "requires-elevated-approval";

  if (adjustment.status !== "requested") {
    return null;
  }

  return (
    <Stack gap={3}>
      {isSameActor ? (
        <Banner
          tone="warning"
          title={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.you.requested.this.adjustment")}
          description={t(
            "settlement.features.wallets.ui.walletAdjustmentApprovalActions.another.platform.admin.must.approve",
          )}
        />
      ) : null}

      {flowError ? (
        <Banner
          tone={walletAdjustmentFlowErrorTone(flowError.kind)}
          title={walletAdjustmentFlowErrorTitle(flowError.kind)}
          description={flowError.message}
        />
      ) : null}

      {requiresElevatedApproval ? (
        <Stack gap={2}>
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.elevation.explanation")}
          </Text>
          <TextInput
            label={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.elevation.approver")}
            value={elevationApprovedByUserId}
            onChange={(event) => setElevationApprovedByUserId(event.target.value)}
            placeholder="usr_..."
          />
        </Stack>
      ) : null}

      {rejectOpen ? (
        <Textarea
          label={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.rejection.reason")}
          value={rejectionReason}
          onChange={(event) => setRejectionReason(event.target.value)}
        />
      ) : null}

      <Stack direction="row" gap={2}>
        <AlertDialog
          open={approveOpen}
          onOpenChange={setApproveOpen}
          tone="warning"
          title={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.approve.title")}
          description={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.approve.description", {
            amount: formatMoney(adjustment.amount, adjustment.currency_code),
            account: targetAccountLabel,
          })}
          confirmLabel={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.approve.confirm")}
          cancelLabel={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.cancel")}
          onConfirm={() => {
            if (approveFormRef.current) {
              submit(approveFormRef.current);
            }
          }}
          trigger={
            <Button tone="primary" disabled={isSameActor || submitting}>
              {t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.approve")}
            </Button>
          }
        />

        <AlertDialog
          open={rejectOpen}
          onOpenChange={setRejectOpen}
          tone="danger"
          title={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.reject.title")}
          description={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.reject.description")}
          confirmLabel={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.reject.confirm")}
          cancelLabel={t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.cancel")}
          onConfirm={() => {
            if (rejectFormRef.current) {
              submit(rejectFormRef.current);
            }
          }}
          trigger={
            <Button tone="danger" disabled={isSameActor || submitting}>
              {t("settlement.features.wallets.ui.walletAdjustmentApprovalActions.reject")}
            </Button>
          }
        />
      </Stack>

      <RouterForm
        id={`wallet-adjustment-approve-form-${adjustment.adjustment_id}`}
        ref={approveFormRef}
        method="post"
        spacing="none"
        aria-hidden="true"
      >
        <HiddenInput type="hidden" name="intent" value="approve" />
        <HiddenInput type="hidden" name="adjustmentId" value={adjustment.adjustment_id} />
        {requiresElevatedApproval && elevationApprovedByUserId.trim() ? (
          <HiddenInput type="hidden" name="elevationApprovedByUserId" value={elevationApprovedByUserId.trim()} />
        ) : null}
      </RouterForm>

      <RouterForm
        id={`wallet-adjustment-reject-form-${adjustment.adjustment_id}`}
        ref={rejectFormRef}
        method="post"
        spacing="none"
        aria-hidden="true"
      >
        <HiddenInput type="hidden" name="intent" value="reject" />
        <HiddenInput type="hidden" name="adjustmentId" value={adjustment.adjustment_id} />
        <HiddenInput type="hidden" name="rejectionReason" value={rejectionReason} />
      </RouterForm>
    </Stack>
  );
}
