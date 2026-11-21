import { t } from "@chase-sets/localization";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Badge,
  Button,
  Cluster,
  DataTable,
  EmptyState,
  Grid,
  HiddenInput,
  NativeSelect,
  Stack,
  Surface,
  Text,
  Textarea,
  TextInput,
} from "@chase-sets/design-system";
import type { PlatformRemedyProposalInput, PlatformRemedyProposalPreview, SupportRequestDetail } from "./contracts";
import type { SupportRemedyOffer } from "../domain/remedy-offer";
import { formatSupportDateTime } from "./support-request-presentation";

function proposalNestedValue(
  input: PlatformRemedyProposalInput | null | undefined,
  group: string,
  key: string,
  fallback: string,
) {
  const nested = input?.[group];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return fallback;
  return String((nested as Record<string, unknown>)[key] ?? fallback);
}

function proposalValue(input: PlatformRemedyProposalInput | null | undefined, key: string, fallback: string) {
  return String(input?.[key] ?? fallback);
}

function PlatformRemedyPreview({ preview }: Readonly<{ preview: PlatformRemedyProposalPreview }>) {
  const rows = [
    [t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.customer"), preview.customerOutcome],
    [t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.seller"), preview.sellerImpact],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.reserve"),
      preview.protectionReserveImpact,
    ],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.labelPayer"),
      preview.returnLabelCostPayer,
    ],
    [t("support.features.supportRequests.ui.supportOperationsPage.remedy.refundTrigger"), preview.refundTrigger],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.expiry"),
      formatSupportDateTime(preview.reservationExpiresAt),
    ],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.approvals"),
      String(preview.requiredApprovalCount),
    ],
    [t("support.features.supportRequests.ui.supportOperationsPage.remedy.policyVersion"), preview.policyVersion],
  ] as const;
  return (
    <Surface tone="muted" elevation="tinted" data-elevation-role="furniture">
      <Stack gap={2}>
        <Text weight="semibold">
          {t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.title")}
        </Text>
        {rows.map(([label, value]) => (
          <Cluster key={label} align="start" justify="between" gap={2}>
            <Text size="sm" weight="semibold">
              {label}
            </Text>
            <Text size="sm" tone="secondary" align="right" wrap="anywhere">
              {value}
            </Text>
          </Cluster>
        ))}
        {preview.requiresElevatedApproval ? (
          <Badge tone="warning">
            {t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.elevated")}
          </Badge>
        ) : null}
        {preview.returnOverrideRequired ? (
          <Badge tone="warning">
            {t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.returnOverride")}
          </Badge>
        ) : null}
      </Stack>
    </Surface>
  );
}

export function PlatformRemedyWorkflowPanel({
  request,
  offer,
  preview,
  proposalInput,
}: Readonly<{
  request: SupportRequestDetail;
  offer: SupportRemedyOffer;
  preview?: PlatformRemedyProposalPreview | null;
  proposalInput?: PlatformRemedyProposalInput | null;
}>) {
  const workflow = request.remedy_approval;
  const remedy = request.remedy;
  const decidedAmount = request.resolution?.refundAmount ?? "";
  const { choices } = offer;

  if (!workflow) {
    if (!offer.propose) {
      return (
        <EmptyState
          title={t("support.features.supportRequests.ui.supportOperationsPage.remedy.unavailable.title")}
          description={t("support.features.supportRequests.ui.supportOperationsPage.remedy.unavailable.description")}
        />
      );
    }
    return (
      <Stack gap={3}>
        <RouterForm method="post" spacing="md">
          <HiddenInput name="supportRequestId" value={request.support_request_id} readOnly />
          <Grid columns={{ base: 1, lg: 2 }}>
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.kind")}
              name="remedyKind"
              items={[
                {
                  value: "full-refund",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.fullRefund"),
                },
                {
                  value: "partial-refund",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.partialRefund"),
                },
              ]}
              defaultValue={proposalNestedValue(proposalInput, "remedy", "kind", "full-refund")}
              required
            />
            <TextInput
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.amount")}
              name="remedyAmount"
              inputMode="decimal"
              defaultValue={proposalNestedValue(proposalInput, "remedy", "amount", decidedAmount)}
              required
            />
            <TextInput
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.currency")}
              name="currencyCode"
              defaultValue={proposalNestedValue(proposalInput, "remedy", "currencyCode", offer.currencyCode)}
              required
            />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.fundingKind")}
              name="fundingKind"
              items={[
                {
                  value: "platform-funded",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.funding.platform"),
                },
                ...(choices.splitFundingAllowed
                  ? [
                      {
                        value: "split",
                        label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.funding.split"),
                      },
                    ]
                  : []),
                {
                  value: "seller-funded",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.funding.seller"),
                },
              ]}
              defaultValue={proposalNestedValue(proposalInput, "allocation", "fundingKind", "platform-funded")}
              required
            />
            <TextInput
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.sellerAmount")}
              name="sellerFundedAmount"
              inputMode="decimal"
              defaultValue={proposalNestedValue(proposalInput, "allocation", "sellerFundedAmount", "0.00")}
              required
            />
            <TextInput
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.platformAmount")}
              name="platformFundedAmount"
              inputMode="decimal"
              defaultValue={proposalNestedValue(proposalInput, "allocation", "platformFundedAmount", decidedAmount)}
              required
            />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.returnDirective")}
              name="returnDirective"
              items={[
                {
                  value: "no-return",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.return.none"),
                },
                {
                  value: "return-to-seller",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.return.seller"),
                },
                {
                  value: "return-to-platform",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.return.platform"),
                },
              ]}
              defaultValue={proposalValue(proposalInput, "returnDirective", "no-return")}
              required
            />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.refundTrigger")}
              name="refundTrigger"
              items={choices.refundTriggers.map((value) => ({ value, label: value }))}
              defaultValue={proposalValue(proposalInput, "refundTrigger", choices.refundTriggers[0] ?? "")}
              required
            />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.reason")}
              name="reasonCode"
              items={choices.eligibleReasonCodes.map((value) => ({ value, label: value }))}
              defaultValue={proposalValue(proposalInput, "reasonCode", choices.eligibleReasonCodes[0] ?? "")}
              required
            />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.returnException")}
              name="returnExceptionReasonCode"
              items={choices.returnExceptionReasonCodes.map((value) => ({ value, label: value }))}
              defaultValue={proposalValue(
                proposalInput,
                "returnExceptionReasonCode",
                choices.returnExceptionReasonCodes[0] ?? "",
              )}
            />
          </Grid>
          <Textarea
            label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.rationale")}
            name="rationale"
            defaultValue={proposalValue(proposalInput, "rationale", "")}
            rows={3}
            required
          />
          <Textarea
            label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.evidenceReferences")}
            name="evidenceReferences"
            defaultValue={proposalValue(proposalInput, "evidenceReferences", "")}
            rows={3}
            required
          />
          <HiddenInput type="hidden" name="idempotencyKey" value={offer.propose.idempotencyKey} readOnly />
          <Cluster justify="end">
            <Button
              type="submit"
              name="intent"
              value="preview-remedy"
              tone="secondary"
              disabled={!offer.propose.allowed}
            >
              {t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.submit")}
            </Button>
            <Button type="submit" name="intent" value="propose-remedy" disabled={!offer.propose.allowed || !preview}>
              {t("support.features.supportRequests.ui.supportOperationsPage.remedy.propose.submit")}
            </Button>
          </Cluster>
        </RouterForm>
        {preview ? <PlatformRemedyPreview preview={preview} /> : null}
      </Stack>
    );
  }

  return (
    <Stack gap={4}>
      <Surface elevation="tinted" data-elevation-role="furniture">
        <Stack gap={2}>
          <Cluster justify="between">
            <Text weight="semibold">
              {t("support.features.supportRequests.ui.supportOperationsPage.remedy.workflow.title")}
            </Text>
            <Badge
              tone={
                workflow.status === "reservation-rejected" || workflow.status === "correction-requested"
                  ? "danger"
                  : workflow.status === "authorized"
                    ? "success"
                    : "warning"
              }
            >
              {workflow.status}
            </Badge>
          </Cluster>
          <Text size="sm" tone="secondary" wrap="anywhere">
            {workflow.terms.remedyId}
          </Text>
          <Text size="sm">
            {workflow.terms.remedy.amount} {workflow.terms.remedy.currencyCode} ·{" "}
            {workflow.terms.allocation.fundingKind}
          </Text>
          <Text size="sm">
            {workflow.terms.returnDirective} · {workflow.terms.refundTrigger}
          </Text>
          <Text size="sm">
            {t("support.features.supportRequests.ui.supportOperationsPage.remedy.reservationStatus")}:{" "}
            {workflow.reservationStatus}
          </Text>
          <Text size="sm">
            {t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.approvals")}:{" "}
            {workflow.approvals.length}/{workflow.requiredApprovalCount}
          </Text>
          <Text size="sm" wrap="anywhere">
            {t("support.features.supportRequests.ui.supportOperationsPage.remedy.policyVersion")}:{" "}
            {workflow.terms.policyVersion}
          </Text>
          {workflow.reservationReasonCode ? <Badge tone="danger">{workflow.reservationReasonCode}</Badge> : null}
        </Stack>
      </Surface>

      {offer.approve ? (
        <Surface elevation="tinted" data-elevation-role="furniture">
          <RouterForm method="post" spacing="md">
            <HiddenInput name="supportRequestId" value={request.support_request_id} readOnly />
            <HiddenInput type="hidden" name="idempotencyKey" value={offer.approve.idempotencyKey} readOnly />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.approval.reason")}
              name="reasonCode"
              items={[
                {
                  value: "policy-approved",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.approval.policyApproved"),
                },
              ]}
              required
            />
            <Textarea
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.rationale")}
              name="rationale"
              rows={3}
              required
            />
            <Textarea
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.evidenceReferences")}
              name="evidenceReferences"
              rows={2}
              required
            />
            <Cluster justify="end">
              <Button type="submit" name="intent" value="approve-remedy" disabled={!offer.approve.allowed}>
                {t("support.features.supportRequests.ui.supportOperationsPage.remedy.approve.submit")}
              </Button>
            </Cluster>
          </RouterForm>
        </Surface>
      ) : null}

      {remedy ? (
        <Stack gap={3}>
          <Text weight="semibold">
            {t("support.features.supportRequests.ui.supportOperationsPage.remedy.effects.title")}
          </Text>
          {remedy.effects.map((effect) => {
            const latest = effect.facts.at(-1);
            const retryable = effect.status === "failed-retryable";
            const actions = offer.effects.find((candidate) => candidate.effect === effect.effect);
            return (
              <Surface
                key={effect.effect}
                tone={retryable || effect.status === "failed-terminal" ? "muted" : undefined}
                elevation="tinted"
                data-elevation-role="furniture"
              >
                <Stack gap={2}>
                  <Cluster justify="between">
                    <Text weight="semibold">{effect.effect}</Text>
                    <Badge
                      tone={
                        effect.status === "satisfied" || effect.status === "waived"
                          ? "success"
                          : effect.status.startsWith("failed")
                            ? "danger"
                            : "warning"
                      }
                    >
                      {effect.status}
                    </Badge>
                  </Cluster>
                  {latest ? (
                    <Text size="sm" tone="secondary">
                      {latest.reasonCode} · {formatSupportDateTime(latest.occurredAt)}
                    </Text>
                  ) : null}
                  {actions?.retry ? (
                    <RouterForm method="post" spacing="sm">
                      <HiddenInput name="supportRequestId" value={request.support_request_id} readOnly />
                      <HiddenInput type="hidden" name="remedyId" value={remedy.remedyId} readOnly />
                      <HiddenInput type="hidden" name="effect" value={effect.effect} readOnly />
                      <HiddenInput type="hidden" name="idempotencyKey" value={actions.retry.idempotencyKey} readOnly />
                      <TextInput
                        label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.recovery.reason")}
                        name="reasonCode"
                        required
                      />
                      <Textarea
                        label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.rationale")}
                        name="rationale"
                        rows={2}
                        required
                      />
                      <Button type="submit" name="intent" value="retry-remedy-effect" disabled={!actions.retry.allowed}>
                        {t("support.features.supportRequests.ui.supportOperationsPage.remedy.retry.submit")}
                      </Button>
                    </RouterForm>
                  ) : null}
                  {actions?.waive ? (
                    <RouterForm method="post" spacing="sm">
                      <HiddenInput name="supportRequestId" value={request.support_request_id} readOnly />
                      <HiddenInput type="hidden" name="remedyId" value={remedy.remedyId} readOnly />
                      <HiddenInput type="hidden" name="effect" value={effect.effect} readOnly />
                      <HiddenInput type="hidden" name="idempotencyKey" value={actions.waive.idempotencyKey} readOnly />
                      <TextInput
                        label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.recovery.reason")}
                        name="reasonCode"
                        required
                      />
                      <Textarea
                        label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.rationale")}
                        name="rationale"
                        rows={2}
                        required
                      />
                      <Textarea
                        label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.evidenceReferences")}
                        name="evidenceReferences"
                        rows={2}
                        required
                      />
                      <Button
                        type="submit"
                        name="intent"
                        value="waive-remedy-effect"
                        disabled={!actions.waive.allowed}
                        tone="secondary"
                      >
                        {t("support.features.supportRequests.ui.supportOperationsPage.remedy.waive.submit")}
                      </Button>
                    </RouterForm>
                  ) : null}
                  {actions?.release ? (
                    <RouterForm method="post" spacing="sm">
                      <HiddenInput name="supportRequestId" value={request.support_request_id} readOnly />
                      <HiddenInput type="hidden" name="remedyId" value={remedy.remedyId} readOnly />
                      <HiddenInput
                        type="hidden"
                        name="idempotencyKey"
                        value={actions.release.idempotencyKey}
                        readOnly
                      />
                      <TextInput
                        label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.recovery.reason")}
                        name="reasonCode"
                        required
                      />
                      <Button
                        type="submit"
                        name="intent"
                        value="release-remedy-refund"
                        disabled={!actions.release.allowed}
                      >
                        {t("support.features.supportRequests.ui.supportOperationsPage.remedy.release.submit")}
                      </Button>
                    </RouterForm>
                  ) : null}
                </Stack>
              </Surface>
            );
          })}
        </Stack>
      ) : null}

      {offer.correct ? (
        <Surface elevation="tinted" data-elevation-role="furniture">
          <RouterForm method="post" spacing="md">
            <HiddenInput name="supportRequestId" value={request.support_request_id} readOnly />
            <HiddenInput type="hidden" name="idempotencyKey" value={offer.correct.idempotencyKey} readOnly />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.correction.reason")}
              name="reasonCode"
              items={choices.escalationReasonCodes.map((value) => ({ value, label: value }))}
              required
            />
            <Textarea
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.rationale")}
              name="rationale"
              rows={2}
              required
            />
            <Textarea
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.evidenceReferences")}
              name="evidenceReferences"
              rows={2}
              required
            />
            <Cluster justify="end">
              <Button
                type="submit"
                name="intent"
                value="request-remedy-correction"
                tone="secondary"
                disabled={!offer.correct.allowed}
              >
                {t("support.features.supportRequests.ui.supportOperationsPage.remedy.correction.submit")}
              </Button>
            </Cluster>
          </RouterForm>
        </Surface>
      ) : null}

      <DataTable
        density="compact"
        rows={[...workflow.auditTrail]}
        getRowId={(entry) => `${entry.action}:${entry.correlationId}`}
        columns={[
          {
            key: "action",
            header: t("support.features.supportRequests.ui.supportOperationsPage.action"),
            cell: (entry) => entry.action,
          },
          {
            key: "actor",
            header: t("support.features.supportRequests.ui.supportOperationsPage.remedy.audit.actor"),
            cell: (entry) =>
              entry.actorType === "system"
                ? t("support.features.supportRequests.ui.supportOperationsPage.remedy.audit.system")
                : (entry.actorAccountId ?? ""),
          },
          {
            key: "reason",
            header: t("support.features.supportRequests.ui.supportOperationsPage.remedy.reason"),
            cell: (entry) => entry.reasonCode,
          },
          {
            key: "time",
            header: t("support.features.supportRequests.ui.supportOperationsPage.submitted"),
            cell: (entry) => formatSupportDateTime(entry.occurredAt),
          },
        ]}
      />
    </Stack>
  );
}
