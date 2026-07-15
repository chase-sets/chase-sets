import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { useMemo, useState } from "react";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Badge,
  Banner,
  Button,
  CheckboxGroup,
  Cluster,
  DataTable,
  HiddenInput,
  Inline,
  Inset,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  PageStepper,
  RadioGroup,
  Stack,
  Surface,
  Text,
  type DataColumn,
} from "@chase-sets/design-system";
import type { SupportFlowSummary, SupportOrderLookup, SupportRequestListItem } from "./contracts";
import { CustomerRemedyStatus, type CustomerRemedyRole } from "./customer-remedy-status";
import { SupportEvidenceAttachmentInput } from "./support-evidence-attachments";

type SupportRequestListPageProps = Readonly<{
  buyerRequests: readonly SupportRequestListItem[];
  sellerRequests: readonly SupportRequestListItem[];
  flows: readonly SupportFlowSummary[];
  actionError?: string | null;
  lookupError?: string | null;
  openedSupportRequestId?: string | null;
  supportOrder?: SupportOrderLookup | null;
  initialFlowType?: string | null;
  recoverySupportRequestId?: string | null;
  uploadedAttachmentReferences?: readonly string[];
}>;

function statusTone(status: string) {
  return status === "resolved" || status === "closed"
    ? "success"
    : status === "ready-for-support"
      ? "warning"
      : "neutral";
}

function priorityTone(priority: string) {
  return priority === "urgent" ? "danger" : "neutral";
}

function formatRequestDateTime(value: string | null) {
  return value
    ? formatDateTime(value, { preset: "short" })
    : t("support.features.supportRequests.ui.supportRequestListPage.not.applicable");
}

function nextDeadline(request: SupportRequestListItem) {
  return request.seller_response_due_at ?? request.support_review_due_at ?? request.seller_condition_attestation_due_at;
}

function checklistSummary(request: SupportRequestListItem) {
  const required = request.checklist.filter((item) => item.required);
  const satisfied = required.filter((item) => item.satisfiedAt !== null);
  return t("support.features.supportRequests.ui.supportRequestListPage.checklist.summary", {
    satisfied: satisfied.length,
    required: required.length,
  });
}

function resolutionLabel(resolution: SupportFlowSummary["defaultResolution"]) {
  switch (resolution) {
    case "full-refund":
      return t("support.features.supportRequests.ui.supportOperationsPage.resolution.fullRefund");
    case "partial-refund":
      return t("support.features.supportRequests.ui.supportOperationsPage.resolution.partialRefund");
    case "return-for-refund":
      return t("support.features.supportRequests.ui.supportOperationsPage.resolution.returnForRefund");
    case "replacement":
      return t("support.features.supportRequests.ui.supportOperationsPage.resolution.replacement");
    case "cancel-order":
      return t("support.features.supportRequests.ui.supportOperationsPage.resolution.cancelOrder");
    case "no-action":
      return t("support.features.supportRequests.ui.supportOperationsPage.resolution.noAction");
    case "support-reviewed":
      return t("support.features.supportRequests.ui.supportOperationsPage.resolution.supportReviewed");
  }
}

function SupportRequestTable({
  requests,
  role,
}: Readonly<{ requests: readonly SupportRequestListItem[]; role: CustomerRemedyRole }>) {
  const columns: DataColumn<SupportRequestListItem>[] = [
    {
      key: "reference",
      header: t("support.features.supportRequests.ui.supportRequestListPage.reference"),
      cell: (request) => request.display_reference || request.support_request_id,
    },
    {
      key: "issue",
      header: t("support.features.supportRequests.ui.supportRequestListPage.issue"),
      cell: (request) => request.flow_type,
    },
    {
      key: "order",
      header: t("support.features.supportRequests.ui.supportRequestListPage.order"),
      cell: (request) => request.order_id,
    },
    {
      key: "status",
      header: t("support.features.supportRequests.ui.supportRequestListPage.status"),
      cell: (request) => <Badge tone={statusTone(request.status)}>{request.status}</Badge>,
    },
    {
      key: "priority",
      header: t("support.features.supportRequests.ui.supportRequestListPage.priority"),
      cell: (request) => <Badge tone={priorityTone(request.priority)}>{request.priority}</Badge>,
    },
    {
      key: "nextDeadline",
      header: t("support.features.supportRequests.ui.supportRequestListPage.next.deadline"),
      mobileLabel: t("support.features.supportRequests.ui.supportRequestListPage.next.deadline"),
      cell: (request) => formatRequestDateTime(nextDeadline(request)),
    },
    {
      key: "checklist",
      header: t("support.features.supportRequests.ui.supportRequestListPage.checklist"),
      cell: (request) => checklistSummary(request),
    },
    {
      key: "resolution",
      header: t("support.features.supportRequests.ui.supportRequestListPage.resolution"),
      mobileLabel: t("support.features.supportRequests.ui.supportRequestListPage.resolution"),
      cell: (request) => <CustomerRemedyStatus request={request} role={role} />,
    },
  ];

  return (
    <DataTable
      rows={[...requests]}
      columns={columns}
      getRowId={(request) => request.support_request_id}
      emptyTitle={t("support.features.supportRequests.ui.supportRequestListPage.no.requests")}
      emptyDescription={t("support.features.supportRequests.ui.supportRequestListPage.no.requests.description")}
    />
  );
}

function SupportFlowTable({ flows }: Readonly<{ flows: readonly SupportFlowSummary[] }>) {
  const columns: DataColumn<SupportFlowSummary>[] = [
    {
      key: "flow",
      header: t("support.features.supportRequests.ui.supportRequestListPage.flow"),
      cell: (flow) => flow.title,
    },
    {
      key: "defaultOutcome",
      header: t("support.features.supportRequests.ui.supportRequestListPage.default.outcome"),
      cell: (flow) => resolutionLabel(flow.defaultResolution),
    },
    {
      key: "responseWindow",
      header: t("support.features.supportRequests.ui.supportRequestListPage.response.window"),
      cell: (flow) =>
        flow.sellerResponseHours === null
          ? t("support.features.supportRequests.ui.supportRequestListPage.support.owned")
          : t("support.features.supportRequests.ui.supportRequestListPage.hours", {
              hours: flow.sellerResponseHours,
            }),
    },
  ];

  return <DataTable rows={[...flows]} columns={columns} getRowId={(flow) => flow.flowType} />;
}

function SupportIntakeStart() {
  return (
    <Surface>
      <Stack>
        <Text>{t("support.features.supportRequests.ui.supportRequestListPage.intake.fromOrder")}</Text>
        <Cluster>
          <LinkButton href="/account/purchases">
            {t("support.features.supportRequests.ui.supportRequestListPage.intake.purchases")}
          </LinkButton>
          <LinkButton href="/account/sales" tone="secondary">
            {t("support.features.supportRequests.ui.supportRequestListPage.intake.sales")}
          </LinkButton>
        </Cluster>
      </Stack>
    </Surface>
  );
}

type IntakeStep = "items" | "issue" | "review";
const intakeSteps: readonly IntakeStep[] = ["items", "issue", "review"];

function SupportRequestOpenPanel({
  flows,
  supportOrder,
  initialFlowType,
  recoverySupportRequestId,
  uploadedAttachmentReferences = [],
}: Readonly<{
  flows: readonly SupportFlowSummary[];
  supportOrder: SupportOrderLookup;
  initialFlowType?: string | null;
  recoverySupportRequestId?: string | null;
  uploadedAttachmentReferences?: readonly string[];
}>) {
  const visibleFlows = useMemo(
    () => flows.filter((flow) => flow.openedBy.includes(supportOrder.openedByRole)),
    [flows, supportOrder.openedByRole],
  );
  const initialFlow = visibleFlows.find((flow) => flow.flowType === initialFlowType) ?? visibleFlows[0];
  const [step, setStep] = useState<IntakeStep>("items");
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>(
    supportOrder.lines.length === 1 ? [supportOrder.lines[0]!.lineId] : [],
  );
  const [selectedFlowType, setSelectedFlowType] = useState(initialFlow?.flowType ?? "");
  const selectedFlow = visibleFlows.find((flow) => flow.flowType === selectedFlowType) ?? initialFlow;
  const selectedLines = supportOrder.lines.filter((line) => selectedLineIds.includes(line.lineId));
  const currentStepIndex = intakeSteps.indexOf(step);
  const photoRequired = Boolean(
    selectedFlow?.checklist.some(
      (item) => item.required && item.ownerRole === supportOrder.openedByRole && item.evidenceTypes.includes("photo"),
    ),
  );

  if (
    supportOrder.existingOpenRequest &&
    supportOrder.existingOpenRequest.supportRequestId !== recoverySupportRequestId
  ) {
    const existing = supportOrder.existingOpenRequest;
    const existingFlow = flows.find((flow) => flow.flowType === existing.flowType);
    return (
      <Stack>
        <Banner
          tone="warning"
          title={t("support.features.supportRequests.ui.supportRequestListPage.duplicate.title")}
          description={t("support.features.supportRequests.ui.supportRequestListPage.duplicate.description")}
          actions={
            <LinkButton href="#existing-support-request" tone="secondary">
              {t("support.features.supportRequests.ui.supportRequestListPage.duplicate.view")}
            </LinkButton>
          }
        />
        <Surface id="existing-support-request">
          <Stack>
            <Inline>
              <Text weight="semibold">{existing.displayReference || existing.supportRequestId}</Text>
              <Badge tone={statusTone(existing.status)}>{existing.status}</Badge>
            </Inline>
            <Text tone="secondary">{existingFlow?.title ?? existing.flowType}</Text>
          </Stack>
        </Surface>
      </Stack>
    );
  }

  const stepperItems = intakeSteps.map((candidate, index) => ({
    label:
      candidate === "items"
        ? t("support.features.supportRequests.ui.supportRequestListPage.intake.items")
        : candidate === "issue"
          ? t("support.features.supportRequests.ui.supportRequestListPage.intake.issue")
          : t("support.features.supportRequests.ui.supportRequestListPage.intake.review"),
    status:
      index < currentStepIndex
        ? ("complete" as const)
        : index === currentStepIndex
          ? ("current" as const)
          : ("upcoming" as const),
  }));

  return (
    <Surface>
      <RouterForm method="post" encType="multipart/form-data" spacing="md">
        <HiddenInput type="hidden" name="orderId" value={supportOrder.orderId} readOnly />
        <HiddenInput type="hidden" name="flowType" value={selectedFlowType} readOnly />
        <HiddenInput type="hidden" name="photoRequired" value={String(photoRequired)} readOnly />
        {recoverySupportRequestId ? (
          <HiddenInput type="hidden" name="supportRequestId" value={recoverySupportRequestId} readOnly />
        ) : null}
        {uploadedAttachmentReferences.map((reference) => (
          <HiddenInput key={reference} type="hidden" name="uploadedAttachmentReferences" value={reference} readOnly />
        ))}
        {selectedLineIds.map((lineId) => (
          <HiddenInput key={lineId} type="hidden" name="affectedLineIds" value={lineId} readOnly />
        ))}

        <Stack>
          <Inline>
            <Text weight="semibold">{supportOrder.orderId}</Text>
            <Badge tone="neutral">{supportOrder.status}</Badge>
            <Text tone="secondary">
              {formatMoney(supportOrder.totalAmount, supportOrder.lines[0]?.currencyCode || "USD")}
            </Text>
          </Inline>
          <PageStepper items={stepperItems} variant="compact" />
        </Stack>

        {step === "items" ? (
          <Stack>
            <Text size="lg" weight="semibold">
              {t("support.features.supportRequests.ui.supportRequestListPage.intake.items")}
            </Text>
            {supportOrder.lines.length > 0 ? (
              <CheckboxGroup
                label={t("support.features.supportRequests.ui.supportRequestListPage.intake.items.label")}
                description={t("support.features.supportRequests.ui.supportRequestListPage.intake.items.description")}
                items={supportOrder.lines.map((line) => ({
                  value: line.lineId,
                  label: t("support.features.supportRequests.ui.supportRequestListPage.intake.item.label", {
                    title: line.itemTitle,
                    quantity: line.quantity,
                    amount: formatMoney(line.amount, line.currencyCode || "USD"),
                  }),
                  description: line.productSummary ?? undefined,
                }))}
                values={selectedLineIds}
                onValuesChange={setSelectedLineIds}
                required
              />
            ) : (
              <Banner
                tone="info"
                title={t("support.features.supportRequests.ui.supportRequestListPage.intake.wholeOrder")}
              />
            )}
          </Stack>
        ) : null}

        {step === "issue" ? (
          <Stack>
            <Text size="lg" weight="semibold">
              {t("support.features.supportRequests.ui.supportRequestListPage.intake.issue")}
            </Text>
            <RadioGroup
              label={t("support.features.supportRequests.ui.supportRequestListPage.intake.issue.label")}
              items={visibleFlows.map((flow) => ({
                value: flow.flowType,
                label: flow.title,
                description: flow.automationSummary,
              }))}
              value={selectedFlowType}
              onValueChange={(value) => setSelectedFlowType(value as SupportFlowSummary["flowType"])}
              required
            />
          </Stack>
        ) : null}

        {step === "review" && selectedFlow ? (
          <Stack>
            <Text size="lg" weight="semibold">
              {t("support.features.supportRequests.ui.supportRequestListPage.intake.review")}
            </Text>
            <Inset>
              <Stack>
                <Text weight="semibold">{selectedFlow.title}</Text>
                <Text tone="secondary">
                  {t("support.features.supportRequests.ui.supportRequestListPage.intake.affectedCount", {
                    count: selectedLines.length || supportOrder.lines.length,
                  })}
                </Text>
                <Inline>
                  <Text weight="semibold">
                    {t("support.features.supportRequests.ui.supportRequestListPage.default.outcome")}
                  </Text>
                  <Text>{resolutionLabel(selectedFlow.defaultResolution)}</Text>
                </Inline>
                <Inline>
                  <Text weight="semibold">
                    {t("support.features.supportRequests.ui.supportRequestListPage.intake.sellerWindow")}
                  </Text>
                  <Text>
                    {selectedFlow.sellerResponseHours === null
                      ? t("support.features.supportRequests.ui.supportRequestListPage.support.owned")
                      : t("support.features.supportRequests.ui.supportRequestListPage.hours", {
                          hours: selectedFlow.sellerResponseHours,
                        })}
                  </Text>
                </Inline>
                <Text weight="semibold">
                  {t("support.features.supportRequests.ui.supportRequestListPage.intake.automaticOutcome")}
                </Text>
                <Text tone="secondary">{selectedFlow.automationSummary}</Text>
              </Stack>
            </Inset>
            {photoRequired ? (
              <SupportEvidenceAttachmentInput required={uploadedAttachmentReferences.length === 0} />
            ) : null}
          </Stack>
        ) : null}

        <Cluster justify="end">
          {step !== "items" ? (
            <Button type="button" tone="secondary" onClick={() => setStep(step === "review" ? "issue" : "items")}>
              {t("support.features.supportRequests.ui.supportRequestListPage.intake.back")}
            </Button>
          ) : null}
          {step !== "review" ? (
            <Button
              type="button"
              disabled={step === "items" && supportOrder.lines.length > 0 && selectedLineIds.length === 0}
              onClick={() => setStep(step === "items" ? "issue" : "review")}
            >
              {t("support.features.supportRequests.ui.supportRequestListPage.intake.continue")}
            </Button>
          ) : (
            <Button type="submit">
              {t("support.features.supportRequests.ui.supportRequestListPage.intake.submit")}
            </Button>
          )}
        </Cluster>
      </RouterForm>
    </Surface>
  );
}

export function SupportRequestListPage({
  buyerRequests,
  sellerRequests,
  flows,
  actionError,
  lookupError,
  openedSupportRequestId,
  supportOrder,
  initialFlowType,
  recoverySupportRequestId,
  uploadedAttachmentReferences,
}: SupportRequestListPageProps) {
  return (
    <Page>
      <PageHeader
        title={t("support.features.supportRequests.ui.supportRequestListPage.title")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.description")}
      />

      {openedSupportRequestId ? (
        <Banner
          tone="success"
          title={t("support.features.supportRequests.ui.supportRequestListPage.open.success", {
            id: deriveDisplayReferenceOrRaw(openedSupportRequestId as SupportRequestId),
          })}
        />
      ) : null}

      {actionError ? <Banner tone="danger" title={actionError} /> : null}
      {lookupError ? <Banner tone="danger" title={lookupError} /> : null}

      <PageSection
        title={t("support.features.supportRequests.ui.supportRequestListPage.open.title")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.open.description")}
      >
        {supportOrder ? (
          <SupportRequestOpenPanel
            flows={flows}
            supportOrder={supportOrder}
            initialFlowType={initialFlowType}
            recoverySupportRequestId={recoverySupportRequestId}
            uploadedAttachmentReferences={uploadedAttachmentReferences}
          />
        ) : (
          <SupportIntakeStart />
        )}
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportRequestListPage.buyer.requests")}>
        <SupportRequestTable requests={buyerRequests} role="buyer" />
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportRequestListPage.seller.requests")}>
        <SupportRequestTable requests={sellerRequests} role="seller" />
      </PageSection>

      <PageSection
        title={t("support.features.supportRequests.ui.supportRequestListPage.available.flows")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.available.flows.description")}
      >
        <SupportFlowTable flows={flows} />
      </PageSection>
    </Page>
  );
}
