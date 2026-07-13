import { useMemo, useRef, useState } from "react";
import { formatMoney, t } from "@chase-sets/localization";
import { useNavigation, useSubmit } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  AlertDialog,
  Banner,
  Button,
  Card,
  CurrencyInput,
  HiddenInput,
  KeyValueList,
  PageStepper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TagInput,
  ValidationSummary,
  type PageStepperItem,
} from "@chase-sets/design-system";
import type { WalletAdjustmentReasonCode } from "../domain/wallet-adjustment";
import type { SettlementWalletAdjustmentPreview } from "../../../client";
import type { WalletAdjustmentFlowError } from "../../../support/request-support/wallet-adjustment-flow-error";
import {
  WALLET_ADJUSTMENT_GUIDED_FLOW_DEFAULT_VALUES,
  type WalletAdjustmentGuidedFlowValues,
} from "../../../support/request-support/wallet-adjustment-guided-flow-form-data";
import {
  walletAdjustmentDirectionLabel,
  walletAdjustmentDirectionTone,
  walletAdjustmentElevationReasonLabel,
  walletAdjustmentFlowErrorTitle,
  walletAdjustmentFlowErrorTone,
  walletAdjustmentReasonCodeItems,
  walletAdjustmentReasonCodeLabel,
  walletAdjustmentReasonCodeRequiresExplanation,
} from "./wallet-adjustment-copy";

export { WALLET_ADJUSTMENT_GUIDED_FLOW_DEFAULT_VALUES, type WalletAdjustmentGuidedFlowValues };

function guidedFlowSteps(hasPreview: boolean, hasSubmitted: boolean): PageStepperItem[] {
  return [
    {
      label: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.step.details"),
      description: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.step.details.description"),
      status: hasSubmitted ? "complete" : hasPreview ? "complete" : "current",
    },
    {
      label: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.step.review"),
      description: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.step.review.description"),
      status: hasSubmitted ? "complete" : hasPreview ? "current" : "upcoming",
    },
    {
      label: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.step.confirm"),
      description: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.step.confirm.description"),
      status: hasSubmitted ? "complete" : "upcoming",
    },
  ];
}

/**
 * The guided credit/debit preview -> confirmation -> submission flow. Two
 * independent `RouterForm`s intentionally share the same field
 * values: the visible "Preview" form the operator edits, and a hidden
 * "Confirm & submit" form whose submit button lives inside an `AlertDialog`
 * so a bare Enter keypress can never post the high-risk command -- only an
 * explicit dialog confirmation can (`useSubmit` fires the hidden form on
 * `onConfirm`).
 */
export function WalletAdjustmentGuidedFlowForm({
  targetAccountId,
  targetAccountLabel,
  currencyCode,
  preview,
  flowError,
  defaultValues = WALLET_ADJUSTMENT_GUIDED_FLOW_DEFAULT_VALUES,
}: {
  targetAccountId: string;
  targetAccountLabel: string;
  currencyCode: string;
  preview: SettlementWalletAdjustmentPreview | null;
  flowError: WalletAdjustmentFlowError | null;
  defaultValues?: WalletAdjustmentGuidedFlowValues;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const requestFormRef = useRef<HTMLFormElement | null>(null);
  const [direction, setDirection] = useState<"credit" | "debit">(defaultValues.direction);
  const [amount, setAmount] = useState<string | null>(defaultValues.amount || null);
  const [reasonCode, setReasonCode] = useState<WalletAdjustmentReasonCode>(defaultValues.reasonCode);
  const [explanation, setExplanation] = useState(defaultValues.explanation);
  const [evidenceReferences, setEvidenceReferences] = useState<string[]>([...defaultValues.evidenceReferences]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const explanationRequired = walletAdjustmentReasonCodeRequiresExplanation(reasonCode);
  const submitting = navigation.state === "submitting";
  const canPreview = Boolean(amount) && (!explanationRequired || explanation.trim().length > 0);
  const previewMatchesForm =
    preview !== null &&
    preview.direction === direction &&
    preview.amount === amount &&
    preview.reason_code === reasonCode;
  const blocked = previewMatchesForm && preview.blocked_reason !== null;
  const reasonItems = useMemo(() => walletAdjustmentReasonCodeItems(), []);

  const validationErrors = flowError?.fieldErrors ?? [];

  function requestConfirm() {
    setConfirmOpen(false);
    if (requestFormRef.current) {
      submit(requestFormRef.current);
    }
  }

  return (
    <Stack gap={4}>
      <PageStepper items={guidedFlowSteps(previewMatchesForm, false)} />

      {flowError ? (
        <Banner
          tone={walletAdjustmentFlowErrorTone(flowError.kind)}
          title={walletAdjustmentFlowErrorTitle(flowError.kind)}
          description={flowError.message}
        />
      ) : null}

      {validationErrors.length > 0 ? (
        <ValidationSummary
          id="wallet-adjustment-validation-summary"
          errors={validationErrors}
          description={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.fix.the.highlighted.fields")}
        />
      ) : null}

      <Card>
        <RouterForm
          method="post"
          spacing="md"
          submitting={submitting}
          validationSummaryId={validationErrors.length > 0 ? "wallet-adjustment-validation-summary" : undefined}
        >
          <HiddenInput type="hidden" name="intent" value="preview" />
          <HiddenInput type="hidden" name="targetAccountId" value={targetAccountId} />
          <HiddenInput type="hidden" name="direction" value={direction} />

          <Stack gap={1}>
            <Text size="sm" weight="semibold">
              {t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.credit.or.debit")}
            </Text>
            <SegmentedControl
              label={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.credit.or.debit")}
              value={direction}
              onValueChange={(value) => setDirection(value === "debit" ? "debit" : "credit")}
              items={[
                { value: "credit", label: walletAdjustmentDirectionLabel("credit") },
                { value: "debit", label: walletAdjustmentDirectionLabel("debit") },
              ]}
            />
          </Stack>

          <CurrencyInput
            id="wallet-adjustment-amount"
            name="amount"
            label={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.amount")}
            currencyCode={currencyCode}
            value={amount}
            onValueChange={setAmount}
            required
          />

          <Select
            id="wallet-adjustment-reason-code"
            name="reasonCode"
            label={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.reason")}
            items={reasonItems}
            value={reasonCode}
            onValueChange={(value) => setReasonCode(value as WalletAdjustmentReasonCode)}
            required
          />

          <Textarea
            id="wallet-adjustment-explanation"
            name="explanation"
            label={
              explanationRequired
                ? t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.explanation.required")
                : t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.explanation.optional")
            }
            description={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.explanation.description")}
            value={explanation}
            onChange={(event) => setExplanation(event.target.value)}
            required={explanationRequired}
          />

          <TagInput
            name="evidenceReferences"
            label={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.related.references")}
            description={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.related.references.description")}
            values={evidenceReferences}
            onValuesChange={setEvidenceReferences}
          />

          <Button type="submit" tone="secondary" disabled={!canPreview || submitting}>
            {t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.request.preview")}
          </Button>
        </RouterForm>
      </Card>

      {previewMatchesForm ? (
        <Card>
          <Stack gap={3}>
            <Text weight="semibold">
              {t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.preview.title")}
            </Text>
            <KeyValueList
              items={[
                {
                  key: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.target.account"),
                  value: targetAccountLabel,
                },
                {
                  key: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.available.balance.before"),
                  value: formatMoney(preview.available_balance_before, preview.currency_code),
                },
                {
                  key: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.available.balance.after"),
                  value: formatMoney(preview.available_balance_after, preview.currency_code),
                },
                {
                  key: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.spendable"),
                  value: preview.spendable
                    ? t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.yes")
                    : t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.no"),
                },
                {
                  key: t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.payoutable"),
                  value: preview.payoutable
                    ? t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.yes")
                    : t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.no"),
                },
              ]}
            />

            {preview.creates_or_increases_negative_balance ? (
              <Banner
                tone="warning"
                title={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.negative.balance.title")}
                description={t(
                  "settlement.features.wallets.ui.walletAdjustmentGuidedFlow.negative.balance.description",
                )}
              />
            ) : null}

            {preview.requires_second_approval ? (
              <Banner
                tone="warning"
                title={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.second.approval.title")}
                description={preview.elevation_reasons.map(walletAdjustmentElevationReasonLabel).join("; ")}
              />
            ) : null}

            {blocked ? (
              <Banner
                tone="danger"
                title={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.self.benefiting.title")}
                description={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.self.benefiting.description")}
              />
            ) : (
              <Stack direction="row" gap={2}>
                <AlertDialog
                  open={confirmOpen}
                  onOpenChange={setConfirmOpen}
                  tone={direction === "debit" ? "danger" : "warning"}
                  title={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.confirm.title")}
                  description={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.confirm.description", {
                    direction: walletAdjustmentDirectionLabel(direction).toLowerCase(),
                    amount: formatMoney(preview.amount, preview.currency_code),
                    account: targetAccountLabel,
                    after: formatMoney(preview.available_balance_after, preview.currency_code),
                  })}
                  confirmLabel={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.confirm.submit")}
                  cancelLabel={t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.cancel")}
                  onConfirm={requestConfirm}
                  trigger={
                    <Button tone={direction === "debit" ? "danger" : "primary"} disabled={submitting}>
                      {t("settlement.features.wallets.ui.walletAdjustmentGuidedFlow.confirm.and.submit")}
                    </Button>
                  }
                />
              </Stack>
            )}
          </Stack>
        </Card>
      ) : null}

      <RouterForm
        id="wallet-adjustment-request-form"
        ref={requestFormRef}
        method="post"
        spacing="none"
        aria-hidden="true"
      >
        <HiddenInput type="hidden" name="intent" value="request" />
        <HiddenInput type="hidden" name="targetAccountId" value={targetAccountId} />
        <HiddenInput type="hidden" name="direction" value={direction} />
        <HiddenInput type="hidden" name="amount" value={amount ?? ""} />
        <HiddenInput type="hidden" name="currencyCode" value={currencyCode} />
        <HiddenInput type="hidden" name="reasonCode" value={reasonCode} />
        <HiddenInput type="hidden" name="explanation" value={explanation} />
        {evidenceReferences.map((reference) => (
          <HiddenInput key={reference} type="hidden" name="evidenceReferences" value={reference} />
        ))}
        <HiddenInput type="hidden" name="expectedBalanceRevision" value={preview?.balance_revision ?? ""} />
      </RouterForm>
    </Stack>
  );
}
