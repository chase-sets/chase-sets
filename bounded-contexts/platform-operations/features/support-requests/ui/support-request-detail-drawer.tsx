import {
  Badge,
  Button,
  Cluster,
  DataTable,
  EmptyState,
  HiddenInput,
  KeyValueList,
  NativeSelect,
  ProgressiveDisclosure,
  SideSheet,
  Stack,
  Surface,
  Text,
  Textarea,
  TextInput,
} from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { t } from "@chase-sets/localization";
import { normalizeFlowType } from "../domain/common";
import { getSupportResponsibilityReasonDefinitions } from "../domain/responsibility";
import type { PlatformRemedyProposalInput, PlatformRemedyProposalPreview, SupportRequestDetail } from "./contracts";
import { PlatformRemedyWorkflowPanel } from "./platform-remedy-workflow-panel";
import { SupportEvidenceAttachmentGallery } from "./support-evidence-attachments";
import {
  formatSupportDateTime,
  nextSupportDeadline,
  SupportDeadlineCountdown,
  SupportOrderMarketplaceLinks,
} from "./support-request-presentation";

type OperatorAction = "response" | "escalate" | "resolve";

const responseTypeItems = [
  {
    value: "request-support-review",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.requestSupportReview"),
  },
  {
    value: "provide-tracking",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.provideTracking"),
  },
  {
    value: "accept-return",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.acceptReturn"),
  },
  {
    value: "offer-partial-refund",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.offerPartialRefund"),
  },
  {
    value: "offer-replacement",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.offerReplacement"),
  },
  {
    value: "issue-refund",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.issueRefund"),
  },
  {
    value: "challenge-with-evidence",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.challengeWithEvidence"),
  },
  {
    value: "confirm-cancellation",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.confirmCancellation"),
  },
  {
    value: "confirm-cannot-fulfill",
    label: t("support.features.supportRequests.ui.supportOperationsPage.response.confirmCannotFulfill"),
  },
];

const resolutionTypeItems = [
  {
    value: "support-reviewed",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.supportReviewed"),
  },
  {
    value: "full-refund",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.fullRefund"),
  },
  {
    value: "partial-refund",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.partialRefund"),
  },
  {
    value: "return-for-refund",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.returnForRefund"),
  },
  {
    value: "replacement",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.replacement"),
  },
  {
    value: "cancel-order",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.cancelOrder"),
  },
  {
    value: "no-action",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.noAction"),
  },
];

const evidenceBasisItems = [
  {
    value: "operator-finding",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolve.evidenceBasis.operatorFinding"),
  },
  {
    value: "insufficient-evidence",
    label: t("support.features.supportRequests.ui.supportOperationsPage.resolve.evidenceBasis.insufficientEvidence"),
  },
];

function isTerminalStatus(status: string) {
  return status === "resolved" || status === "closed" || status === "cancelled";
}

export function supportRequestPrimaryAction(request: SupportRequestDetail, now: string): OperatorAction {
  if (request.status === "ready-for-support") {
    return "resolve";
  }

  const deadline = nextSupportDeadline(request);
  if (deadline && new Date(deadline).getTime() <= new Date(now).getTime()) {
    return "escalate";
  }

  return "response";
}

function returnContextRows(request: SupportRequestDetail) {
  return Array.isArray(request.order_return_context)
    ? request.order_return_context
        .map((line) => (line && typeof line === "object" ? (line as Record<string, unknown>) : null))
        .filter((line): line is Record<string, unknown> => Boolean(line))
    : [];
}

function gradedCardSummary(line: Record<string, unknown>) {
  const gradedCard =
    line.gradedCard && typeof line.gradedCard === "object" ? (line.gradedCard as Record<string, unknown>) : null;
  if (!gradedCard) {
    return t("support.features.supportRequests.ui.supportOperationsPage.not.applicable");
  }

  return [
    gradedCard.gradingCompany,
    gradedCard.grade,
    gradedCard.certificationNumber
      ? t("support.features.supportRequests.ui.supportOperationsPage.certification.number", {
          certificationNumber: String(gradedCard.certificationNumber),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function responsibilityReasonItems(request: SupportRequestDetail) {
  return getSupportResponsibilityReasonDefinitions(normalizeFlowType(request.flow_type))
    .filter(({ operatorSelectable }) => operatorSelectable)
    .map(({ code, responsibility, operatorLabel }) => ({
      value: `${responsibility}|${code}`,
      label: t("support.features.supportRequests.ui.supportOperationsPage.resolve.responsibilityReasonOption", {
        reason: operatorLabel,
        responsibility,
      }),
    }));
}

function ResponseForm({ actionHref }: Readonly<{ actionHref: string }>) {
  return (
    <RouterForm method="post" action={actionHref} spacing="md" data-support-action="response">
      <HiddenInput name="intent" value="response" readOnly />
      <NativeSelect
        label={t("support.features.supportRequests.ui.supportOperationsPage.response.type")}
        name="responseType"
        items={responseTypeItems}
        defaultValue="request-support-review"
        required
      />
      <Textarea
        label={t("support.features.supportRequests.ui.supportOperationsPage.response.summary")}
        name="summary"
        required
        rows={3}
      />
      <Cluster justify="end">
        <Button type="submit">{t("support.features.supportRequests.ui.supportOperationsPage.response.submit")}</Button>
      </Cluster>
    </RouterForm>
  );
}

function EscalateForm({ actionHref }: Readonly<{ actionHref: string }>) {
  return (
    <RouterForm method="post" action={actionHref} spacing="md" data-support-action="escalate">
      <HiddenInput name="intent" value="escalate" readOnly />
      <Textarea
        label={t("support.features.supportRequests.ui.supportOperationsPage.escalate.reason")}
        name="reason"
        required
        rows={3}
      />
      <Cluster justify="end">
        <Button type="submit" tone="secondary">
          {t("support.features.supportRequests.ui.supportOperationsPage.escalate.submit")}
        </Button>
      </Cluster>
    </RouterForm>
  );
}

function ResolveForm({ request, actionHref }: Readonly<{ request: SupportRequestDetail; actionHref: string }>) {
  const reasons = responsibilityReasonItems(request);

  return (
    <RouterForm method="post" action={actionHref} spacing="md" data-support-action="resolve">
      <HiddenInput name="intent" value="resolve" readOnly />
      <NativeSelect
        label={t("support.features.supportRequests.ui.supportOperationsPage.resolve.type")}
        name="resolutionType"
        items={resolutionTypeItems}
        defaultValue="support-reviewed"
        required
      />
      <Textarea
        label={t("support.features.supportRequests.ui.supportOperationsPage.resolve.summary")}
        name="summary"
        required
        rows={3}
      />
      <TextInput
        label={t("support.features.supportRequests.ui.supportOperationsPage.resolve.refundAmount")}
        name="refundAmount"
        inputMode="decimal"
      />
      <NativeSelect
        label={t("support.features.supportRequests.ui.supportOperationsPage.resolve.responsibilityReason")}
        name="responsibilityFinding"
        items={reasons}
        defaultValue={reasons[0]?.value}
        required
      />
      <NativeSelect
        label={t("support.features.supportRequests.ui.supportOperationsPage.resolve.evidenceBasis")}
        name="evidenceBasisType"
        items={evidenceBasisItems}
        defaultValue="operator-finding"
        required
      />
      <Cluster justify="end">
        <Button type="submit">{t("support.features.supportRequests.ui.supportOperationsPage.resolve.submit")}</Button>
      </Cluster>
    </RouterForm>
  );
}

function OperatorActionForm({
  action,
  request,
  actionHref,
}: Readonly<{ action: OperatorAction; request: SupportRequestDetail; actionHref: string }>) {
  switch (action) {
    case "response":
      return <ResponseForm actionHref={actionHref} />;
    case "escalate":
      return <EscalateForm actionHref={actionHref} />;
    case "resolve":
      return <ResolveForm request={request} actionHref={actionHref} />;
  }
}

function actionResultMessage(actionResult: string | null | undefined) {
  switch (actionResult) {
    case "note":
      return t("support.features.supportRequests.ui.supportOperationsPage.actionResult.note");
    case "response":
      return t("support.features.supportRequests.ui.supportOperationsPage.actionResult.response");
    case "escalate":
      return t("support.features.supportRequests.ui.supportOperationsPage.actionResult.escalate");
    case "resolve":
      return t("support.features.supportRequests.ui.supportOperationsPage.actionResult.resolve");
    case "close":
      return t("support.features.supportRequests.ui.supportOperationsPage.actionResult.close");
    case "cancel":
      return t("support.features.supportRequests.ui.supportOperationsPage.actionResult.cancel");
    case "remedy-proposed":
      return t("support.features.supportRequests.ui.supportOperationsPage.remedy.action.proposed");
    case "remedy-approved":
      return t("support.features.supportRequests.ui.supportOperationsPage.remedy.action.approved");
    case "remedy-retry-requested":
      return t("support.features.supportRequests.ui.supportOperationsPage.remedy.action.retryRequested");
    case "remedy-effect-waived":
      return t("support.features.supportRequests.ui.supportOperationsPage.remedy.action.waived");
    case "remedy-refund-released":
      return t("support.features.supportRequests.ui.supportOperationsPage.remedy.action.refundReleased");
    case "remedy-correction-requested":
      return t("support.features.supportRequests.ui.supportOperationsPage.remedy.action.correctionRequested");
    default:
      return null;
  }
}

function Notes({ request }: Readonly<{ request: SupportRequestDetail }>) {
  const notes = request.evidence.filter((item) => item.evidenceType === "support-note");
  return (
    <Stack gap={2}>
      <Text weight="semibold">{t("support.features.supportRequests.ui.supportOperationsPage.notes")}</Text>
      {notes.length === 0 ? (
        <EmptyState
          title={t("support.features.supportRequests.ui.supportOperationsPage.notes.empty")}
          description={t("support.features.supportRequests.ui.supportOperationsPage.notes.empty.description")}
        />
      ) : (
        <DataTable
          density="compact"
          rows={notes}
          getRowId={(note) => note.evidenceId}
          columns={[
            {
              key: "summary",
              header: t("support.features.supportRequests.ui.supportOperationsPage.summary"),
              cell: (note) => <Text wrap="anywhere">{note.summary}</Text>,
            },
            {
              key: "submitted",
              header: t("support.features.supportRequests.ui.supportOperationsPage.submitted"),
              cell: (note) => formatSupportDateTime(note.submittedAt),
            },
          ]}
        />
      )}
    </Stack>
  );
}

type AuditItem = Readonly<{
  id: string;
  kind: string;
  summary: string;
  actor: string;
  at: string;
  attachments: readonly string[];
}>;

function auditItems(request: SupportRequestDetail): AuditItem[] {
  const items: AuditItem[] = [
    ...request.evidence.map((item) => ({
      id: `evidence:${item.evidenceId}`,
      kind:
        item.evidenceType === "support-note"
          ? t("support.features.supportRequests.ui.supportOperationsPage.audit.note")
          : t("support.features.supportRequests.ui.supportOperationsPage.audit.evidence"),
      summary: item.summary,
      actor: item.submittedByRole,
      at: item.submittedAt,
      attachments: item.attachments,
    })),
    ...request.responses.map((item) => ({
      id: `response:${item.responseId}`,
      kind: t("support.features.supportRequests.ui.supportOperationsPage.audit.response"),
      summary: item.summary,
      actor: item.submittedByRole,
      at: item.submittedAt,
      attachments: [],
    })),
    ...request.offers.map((item) => ({
      id: `offer:${item.offerId}`,
      kind: t("support.features.supportRequests.ui.supportOperationsPage.audit.offer"),
      summary: item.summary,
      actor: item.offeredByRole,
      at: item.offeredAt,
      attachments: [],
    })),
  ];

  if (request.escalated_at) {
    items.push({
      id: "escalation",
      kind: t("support.features.supportRequests.ui.supportOperationsPage.audit.escalation"),
      summary: request.escalation_reason ?? "",
      actor: request.escalated_by_role ?? "support",
      at: request.escalated_at,
      attachments: [],
    });
  }

  if (request.resolution) {
    items.push({
      id: "resolution",
      kind: t("support.features.supportRequests.ui.supportOperationsPage.audit.resolution"),
      summary: request.resolution.summary,
      actor: request.resolution.resolvedByRole ?? "support",
      at: request.resolution.resolvedAt,
      attachments: [],
    });
  }

  return items.sort((left, right) => right.at.localeCompare(left.at));
}

function AuditTrail({ request }: Readonly<{ request: SupportRequestDetail }>) {
  const items = auditItems(request);
  return (
    <Stack gap={2}>
      <Text weight="semibold">{t("support.features.supportRequests.ui.supportOperationsPage.auditTrail")}</Text>
      <DataTable
        density="compact"
        rows={items}
        getRowId={(item) => item.id}
        emptyTitle={t("support.features.supportRequests.ui.supportOperationsPage.audit.empty")}
        emptyDescription={t("support.features.supportRequests.ui.supportOperationsPage.audit.empty.description")}
        columns={[
          {
            key: "kind",
            header: t("support.features.supportRequests.ui.supportOperationsPage.type"),
            cell: (item) => item.kind,
          },
          {
            key: "summary",
            header: t("support.features.supportRequests.ui.supportOperationsPage.summary"),
            cell: (item) => <Text wrap="anywhere">{item.summary}</Text>,
          },
          {
            key: "submitted",
            header: t("support.features.supportRequests.ui.supportOperationsPage.submitted"),
            cell: (item) => formatSupportDateTime(item.at),
          },
          {
            key: "attachments",
            header: t("support.features.supportRequests.ui.supportOperationsPage.attachments"),
            cell: (item) => (
              <SupportEvidenceAttachmentGallery
                supportRequestId={request.support_request_id}
                attachments={item.attachments}
              />
            ),
          },
        ]}
      />
    </Stack>
  );
}

function StructuredOffers({ request }: Readonly<{ request: SupportRequestDetail }>) {
  if (request.offers.length === 0) {
    return null;
  }

  return (
    <Stack gap={2}>
      <Text weight="semibold">{t("support.features.supportRequests.ui.supportOperationsPage.offers")}</Text>
      <DataTable
        density="compact"
        rows={[...request.offers]}
        getRowId={(offer) => offer.offerId}
        columns={[
          {
            key: "offer",
            header: t("support.features.supportRequests.ui.supportOperationsPage.offer"),
            cell: (offer) => (
              <Stack gap={1}>
                <Text weight="semibold">{offer.resolutionType}</Text>
                <Text size="xs" tone="secondary" wrap="anywhere">
                  {offer.summary}
                </Text>
              </Stack>
            ),
          },
          {
            key: "status",
            header: t("support.features.supportRequests.ui.supportOperationsPage.status"),
            cell: (offer) => <Badge tone={offer.status === "pending" ? "warning" : "neutral"}>{offer.status}</Badge>,
          },
          {
            key: "amount",
            header: t("support.features.supportRequests.ui.supportOperationsPage.resolve.refundAmount"),
            cell: (offer) =>
              offer.refundAmount ?? t("support.features.supportRequests.ui.supportOperationsPage.not.applicable"),
          },
        ]}
      />
    </Stack>
  );
}

function Checklist({ request }: Readonly<{ request: SupportRequestDetail }>) {
  return (
    <Stack gap={2}>
      <Text weight="semibold">{t("support.features.supportRequests.ui.supportOperationsPage.checklist")}</Text>
      <DataTable
        density="compact"
        rows={[...request.checklist]}
        getRowId={(item) => item.key}
        columns={[
          {
            key: "requirement",
            header: t("support.features.supportRequests.ui.supportOperationsPage.detail.requirement"),
            cell: (item) => <Text wrap="anywhere">{item.label}</Text>,
          },
          {
            key: "status",
            header: t("support.features.supportRequests.ui.supportOperationsPage.status"),
            cell: (item) => (
              <Badge tone={item.satisfiedAt ? "success" : item.required ? "warning" : "neutral"}>
                {item.satisfiedAt
                  ? t("support.features.supportRequests.ui.supportOperationsPage.checklist.complete")
                  : t("support.features.supportRequests.ui.supportOperationsPage.checklist.incomplete")}
              </Badge>
            ),
          },
        ]}
      />
    </Stack>
  );
}

function FullCaseContext({ request }: Readonly<{ request: SupportRequestDetail }>) {
  const returnRows = returnContextRows(request);
  const nonNoteEvidence = request.evidence.filter((item) => item.evidenceType !== "support-note");

  return (
    <ProgressiveDisclosure
      title={t("support.features.supportRequests.ui.supportOperationsPage.fullCase")}
      description={t("support.features.supportRequests.ui.supportOperationsPage.fullCase.description")}
    >
      <Stack gap={4}>
        <DataTable
          density="compact"
          rows={returnRows}
          getRowId={(item) => String(item.lineId)}
          emptyTitle={t("support.features.supportRequests.ui.supportOperationsPage.no.return.context")}
          emptyDescription={t(
            "support.features.supportRequests.ui.supportOperationsPage.no.return.context.description",
          )}
          columns={[
            {
              key: "item",
              header: t("support.features.supportRequests.ui.supportOperationsPage.item"),
              cell: (item) => String(item.itemTitle ?? ""),
            },
            {
              key: "listing",
              header: t("support.features.supportRequests.ui.supportOperationsPage.listing"),
              cell: (item) => String(item.listingId ?? ""),
            },
            {
              key: "gradedCard",
              header: t("support.features.supportRequests.ui.supportOperationsPage.graded.card"),
              cell: gradedCardSummary,
            },
          ]}
        />
        <DataTable
          density="compact"
          rows={nonNoteEvidence}
          getRowId={(item) => item.evidenceId}
          emptyTitle={t("support.features.supportRequests.ui.supportOperationsPage.no.evidence")}
          emptyDescription={t("support.features.supportRequests.ui.supportOperationsPage.no.evidence.description")}
          columns={[
            {
              key: "type",
              header: t("support.features.supportRequests.ui.supportOperationsPage.type"),
              cell: (item) => item.evidenceType,
            },
            {
              key: "summary",
              header: t("support.features.supportRequests.ui.supportOperationsPage.summary"),
              cell: (item) => <Text wrap="anywhere">{item.summary}</Text>,
            },
            {
              key: "submitted",
              header: t("support.features.supportRequests.ui.supportOperationsPage.submitted"),
              cell: (item) => formatSupportDateTime(item.submittedAt),
            },
          ]}
        />
      </Stack>
    </ProgressiveDisclosure>
  );
}

function OtherActions({
  request,
  actionHref,
  primaryAction,
}: Readonly<{ request: SupportRequestDetail; actionHref: string; primaryAction: OperatorAction }>) {
  const alternateActions = (["response", "escalate", "resolve"] as const).filter((action) => action !== primaryAction);
  const canMutate = !isTerminalStatus(request.status);

  return (
    <ProgressiveDisclosure
      title={t("support.features.supportRequests.ui.supportOperationsPage.otherActions")}
      description={t("support.features.supportRequests.ui.supportOperationsPage.otherActions.description")}
    >
      <Stack gap={4}>
        {canMutate
          ? alternateActions.map((action) => (
              <Surface key={action} tone="muted">
                <OperatorActionForm action={action} request={request} actionHref={actionHref} />
              </Surface>
            ))
          : null}
        {canMutate ? (
          <Surface tone="muted">
            <RouterForm method="post" action={actionHref} spacing="md" data-support-action="note">
              <HiddenInput name="intent" value="note" readOnly />
              <Textarea
                label={t("support.features.supportRequests.ui.supportOperationsPage.note.summary")}
                name="summary"
                required
                rows={3}
              />
              <Cluster justify="end">
                <Button type="submit" tone="secondary">
                  {t("support.features.supportRequests.ui.supportOperationsPage.note.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>
        ) : null}
        {request.status === "resolved" ? (
          <Surface tone="muted">
            <RouterForm method="post" action={actionHref} spacing="md" data-support-action="close">
              <HiddenInput name="intent" value="close" readOnly />
              <Text size="sm" tone="secondary">
                {t("support.features.supportRequests.ui.supportOperationsPage.close.description")}
              </Text>
              {request.closure_blocking_reasons.length > 0 ? (
                <Stack gap={1}>
                  {request.closure_blocking_reasons.map((reason) => (
                    <Badge key={reason} tone="danger">
                      {reason}
                    </Badge>
                  ))}
                </Stack>
              ) : null}
              <Cluster justify="end">
                <Button type="submit" tone="secondary" disabled={!request.closure_eligible}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.close.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>
        ) : null}
        {canMutate ? (
          <Surface tone="muted">
            <RouterForm method="post" action={actionHref} spacing="md" data-support-action="cancel">
              <HiddenInput name="intent" value="cancel" readOnly />
              <Textarea
                label={t("support.features.supportRequests.ui.supportOperationsPage.cancel.reason")}
                name="reason"
                required
                rows={3}
              />
              <Cluster justify="end">
                <Button type="submit" tone="danger">
                  {t("support.features.supportRequests.ui.supportOperationsPage.cancel.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>
        ) : null}
      </Stack>
    </ProgressiveDisclosure>
  );
}

export function EntityDetailDrawer({
  request,
  now,
  actionHref,
  marketplaceOrigin,
  actionError,
  actionResult,
  actorPermissions,
  remedyPreview,
  remedyProposalInput,
  onClose,
}: Readonly<{
  request: SupportRequestDetail;
  now: string;
  actionHref: string;
  marketplaceOrigin?: string | null;
  actionError?: string | null;
  actionResult?: string | null;
  actorPermissions: readonly string[];
  remedyPreview?: PlatformRemedyProposalPreview | null;
  remedyProposalInput?: PlatformRemedyProposalInput | null;
  onClose: () => void;
}>) {
  const primaryAction = supportRequestPrimaryAction(request, now);
  const successMessage = actionResultMessage(actionResult);

  return (
    <SideSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={request.display_reference || request.support_request_id}
      description={t("support.features.supportRequests.ui.supportOperationsPage.drawer.description")}
      closeLabel={t("support.features.supportRequests.ui.supportOperationsPage.drawer.close")}
      width="lg"
    >
      <Stack gap={5}>
        {successMessage ? (
          <Surface tone="muted">
            <Badge tone="success">{successMessage}</Badge>
          </Surface>
        ) : null}
        {actionError ? (
          <Surface tone="muted">
            <Badge tone="danger">{actionError}</Badge>
          </Surface>
        ) : null}

        <KeyValueList
          variant="surface"
          density="compact"
          items={[
            {
              key: t("support.features.supportRequests.ui.supportOperationsPage.order"),
              value: <SupportOrderMarketplaceLinks orderId={request.order_id} marketplaceOrigin={marketplaceOrigin} />,
            },
            { key: t("support.features.supportRequests.ui.supportOperationsPage.issue"), value: request.flow_type },
            {
              key: t("support.features.supportRequests.ui.supportOperationsPage.status"),
              value: <Badge>{request.status}</Badge>,
            },
            {
              key: t("support.features.supportRequests.ui.supportOperationsPage.priority"),
              value: <Badge tone={request.priority === "urgent" ? "danger" : "neutral"}>{request.priority}</Badge>,
            },
            {
              key: t("support.features.supportRequests.ui.supportOperationsPage.next.deadline"),
              value: <SupportDeadlineCountdown dueAt={nextSupportDeadline(request)} now={now} />,
            },
            {
              key: t("support.features.supportRequests.ui.supportOperationsPage.accounts"),
              value: `${request.buyer_account_id} / ${request.seller_account_id}`,
            },
          ]}
        />

        {!isTerminalStatus(request.status) ? (
          <Stack gap={2}>
            <Text weight="semibold">
              {t("support.features.supportRequests.ui.supportOperationsPage.recommendedAction")}
            </Text>
            <Surface tone="muted" data-support-primary-action={primaryAction}>
              <OperatorActionForm action={primaryAction} request={request} actionHref={actionHref} />
            </Surface>
          </Stack>
        ) : null}

        <Checklist request={request} />
        <Notes request={request} />
        <StructuredOffers request={request} />
        <AuditTrail request={request} />
        {request.resolution?.refundAmount || request.remedy_approval || request.remedy ? (
          <ProgressiveDisclosure
            title={t("support.features.supportRequests.ui.supportOperationsPage.remedy.workflow.title")}
            defaultOpen={Boolean(remedyPreview || request.remedy_approval || request.remedy)}
          >
            <PlatformRemedyWorkflowPanel
              request={request}
              actorPermissions={actorPermissions}
              preview={remedyPreview}
              proposalInput={remedyProposalInput}
            />
          </ProgressiveDisclosure>
        ) : null}
        <FullCaseContext request={request} />
        <OtherActions request={request} actionHref={actionHref} primaryAction={primaryAction} />
      </Stack>
    </SideSheet>
  );
}
