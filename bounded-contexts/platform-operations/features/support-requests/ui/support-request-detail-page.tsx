import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Cluster,
  CurrencyInput,
  HiddenInput,
  KeyValueList,
  LinkButton,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  Textarea,
  Timeline,
  type TimelineItem,
} from "@chase-sets/design-system";
import { ParticipantForm as RouterForm } from "./participant-form";
import { formatMoney, t } from "@chase-sets/localization";
import type {
  SupportChecklistItem,
  SupportEvidenceType,
  SupportRequesterRole,
  SupportResponseType,
} from "../domain/common";
import type {
  SupportFlowDetail,
  SupportParticipantAction,
  SupportParticipantPolicy,
} from "../api/support-flow-projection";
import type { SupportRequestDetail } from "./contracts";
import { formatSupportDateTime, SupportDeadlineCountdown } from "./support-request-presentation";

export type SupportParticipantRole = Exclude<SupportRequesterRole, "support">;

type SupportRequestDetailPageProps = Readonly<{
  request: SupportRequestDetail;
  flow: SupportFlowDetail;
  viewerRole: SupportParticipantRole;
  participantPolicy: SupportParticipantPolicy;
  now: string;
  actionError?: string | null;
  actionResult?: string | null;
}>;

function isTerminalStatus(status: string) {
  return status === "resolved" || status === "closed" || status === "cancelled";
}

function statusLabel(status: string) {
  switch (status) {
    case "waiting-on-buyer":
      return t("support.features.supportRequests.ui.supportRequestDetailPage.status.waitingOnBuyer");
    case "waiting-on-seller":
      return t("support.features.supportRequests.ui.supportRequestDetailPage.status.waitingOnSeller");
    case "ready-for-support":
      return t("support.features.supportRequests.ui.supportRequestDetailPage.status.readyForSupport");
    case "resolved":
      return t("support.features.supportRequests.ui.supportRequestDetailPage.status.resolved");
    case "closed":
      return t("support.features.supportRequests.ui.supportRequestDetailPage.status.closed");
    case "cancelled":
      return t("support.features.supportRequests.ui.supportRequestDetailPage.status.cancelled");
    default:
      return t("support.features.supportRequests.ui.supportRequestDetailPage.status.open");
  }
}

function actionTitle(nextActor: SupportRequesterRole | null, viewerRole: SupportParticipantRole, status: string) {
  if (isTerminalStatus(status)) return statusLabel(status);
  if (nextActor === viewerRole) {
    return t("support.features.supportRequests.ui.supportRequestDetailPage.next.you");
  }
  if (nextActor === "support") {
    return t("support.features.supportRequests.ui.supportRequestDetailPage.next.support");
  }
  return t("support.features.supportRequests.ui.supportRequestDetailPage.next.waiting", {
    party:
      nextActor === "buyer"
        ? t("support.features.supportRequests.ui.supportRequestDetailPage.party.buyer")
        : t("support.features.supportRequests.ui.supportRequestDetailPage.party.seller"),
  });
}

function evidenceTypeLabel(type: SupportEvidenceType) {
  return t(`support.features.supportRequests.ui.supportRequestDetailPage.evidenceType.${type}`);
}

function responseTypeLabel(type: SupportResponseType) {
  return t(`support.features.supportRequests.ui.supportRequestDetailPage.responseType.${type}`);
}

function EvidencePrompt({
  item,
  viewerRole,
}: Readonly<{ item: SupportChecklistItem; viewerRole: SupportParticipantRole }>) {
  const evidenceTypes = item.evidenceTypes.filter((type) => type !== "support-note");
  const firstEvidenceType = evidenceTypes[0];
  if (!firstEvidenceType) return null;

  return (
    <Card elevation="tinted" data-elevation-role="furniture">
      <Card.Header>
        <Card.Title>{item.label}</Card.Title>
        <Card.Description>
          {t("support.features.supportRequests.ui.supportRequestDetailPage.prompt.description")}
        </Card.Description>
      </Card.Header>
      <Card.Body>
        <RouterForm method="post" spacing="md">
          <HiddenInput name="intent" value="evidence" readOnly />
          <HiddenInput name="submittedByRole" value={viewerRole} readOnly />
          <NativeSelect
            label={t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.type")}
            name="evidenceType"
            items={evidenceTypes.map((type) => ({ value: type, label: evidenceTypeLabel(type) }))}
            defaultValue={firstEvidenceType}
            required
          />
          <Textarea
            label={t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.summary")}
            name="summary"
            required
            rows={3}
          />
          <Cluster justify="end">
            <Button type="submit">
              {t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.submit")}
            </Button>
          </Cluster>
        </RouterForm>
      </Card.Body>
    </Card>
  );
}

function ResponseForm({ flow, viewerRole }: Readonly<{ flow: SupportFlowDetail; viewerRole: SupportParticipantRole }>) {
  const allowedResponses = flow.allowedResponses.filter((response) => response !== "request-support-review");
  const firstResponse = allowedResponses[0];
  const [responseType, setResponseType] = useState<SupportResponseType | null>(firstResponse ?? null);
  if (!firstResponse || !responseType) return null;

  return (
    <Card elevation="tinted" data-elevation-role="furniture">
      <Card.Header>
        <Card.Title>{t("support.features.supportRequests.ui.supportRequestDetailPage.response.title")}</Card.Title>
        <Card.Description>
          {t("support.features.supportRequests.ui.supportRequestDetailPage.response.description")}
        </Card.Description>
      </Card.Header>
      <Card.Body>
        <RouterForm method="post" spacing="md">
          <HiddenInput name="intent" value="response" readOnly />
          <HiddenInput name="submittedByRole" value={viewerRole} readOnly />
          <NativeSelect
            label={t("support.features.supportRequests.ui.supportRequestDetailPage.response.type")}
            name="responseType"
            items={allowedResponses.map((type) => ({ value: type, label: responseTypeLabel(type) }))}
            value={responseType}
            onChange={(event) => setResponseType(event.currentTarget.value as SupportResponseType)}
            required
          />
          {responseType === "offer-partial-refund" ? (
            <CurrencyInput
              label={t("support.features.supportRequests.ui.supportRequestDetailPage.response.refundAmount")}
              name="refundAmount"
              currencyCode="USD"
              min="0.01"
              required
            />
          ) : null}
          <Textarea
            label={t("support.features.supportRequests.ui.supportRequestDetailPage.response.summary")}
            name="summary"
            required
            rows={3}
          />
          <Cluster justify="end">
            <Button type="submit">
              {t("support.features.supportRequests.ui.supportRequestDetailPage.response.submit")}
            </Button>
          </Cluster>
        </RouterForm>
      </Card.Body>
    </Card>
  );
}

function RequestSupportReviewForm() {
  return (
    <RouterForm method="post" spacing="md">
      <HiddenInput name="intent" value="escalate" readOnly />
      <HiddenInput
        name="reason"
        value={t("support.features.supportRequests.ui.supportRequestDetailPage.review.defaultReason")}
        readOnly
      />
      <Button type="submit" tone="secondary">
        {t("support.features.supportRequests.ui.supportRequestDetailPage.review.submit")}
      </Button>
    </RouterForm>
  );
}

function OfferDecision({
  request,
  canAccept,
  canDecline,
}: Readonly<{ request: SupportRequestDetail; canAccept: boolean; canDecline: boolean }>) {
  const offer = request.pending_offer;
  if (!offer) return null;

  return (
    <Card elevation="tinted" data-elevation-role="furniture">
      <Card.Header>
        <Card.Title>{t("support.features.supportRequests.ui.supportRequestDetailPage.offer.title")}</Card.Title>
        <Card.Description>{offer.summary}</Card.Description>
      </Card.Header>
      <Card.Body>
        <KeyValueList
          items={[
            {
              key: t("support.features.supportRequests.ui.supportRequestDetailPage.offer.outcome"),
              value: offer.resolutionType,
            },
            {
              key: t("support.features.supportRequests.ui.supportRequestDetailPage.offer.amount"),
              value: offer.refundAmount
                ? formatMoney(offer.refundAmount, "USD")
                : t("support.features.supportRequests.ui.supportRequestDetailPage.notApplicable"),
            },
          ]}
        />
        <Cluster>
          {canAccept ? (
            <RouterForm method="post">
              <HiddenInput name="intent" value="accept-offer" readOnly />
              <HiddenInput name="offerId" value={offer.offerId} readOnly />
              <Button type="submit">
                {t("support.features.supportRequests.ui.supportRequestDetailPage.offer.accept")}
              </Button>
            </RouterForm>
          ) : null}
          {canDecline ? (
            <RouterForm method="post">
              <HiddenInput name="intent" value="decline-offer" readOnly />
              <HiddenInput name="offerId" value={offer.offerId} readOnly />
              <HiddenInput
                name="summary"
                value={t("support.features.supportRequests.ui.supportRequestDetailPage.offer.declineSummary")}
                readOnly
              />
              <Button type="submit" tone="secondary">
                {t("support.features.supportRequests.ui.supportRequestDetailPage.offer.decline")}
              </Button>
            </RouterForm>
          ) : null}
        </Cluster>
      </Card.Body>
    </Card>
  );
}

function CancelCaseForm() {
  return (
    <Card elevation="tinted" data-elevation-role="furniture">
      <Card.Header>
        <Card.Title>{t("support.features.supportRequests.ui.supportRequestDetailPage.cancel.title")}</Card.Title>
      </Card.Header>
      <Card.Body>
        <RouterForm method="post" spacing="md">
          <HiddenInput name="intent" value="cancel" readOnly />
          <Textarea
            label={t("support.features.supportRequests.ui.supportRequestDetailPage.cancel.reason")}
            name="reason"
            required
            rows={2}
          />
          <Cluster justify="end">
            <Button type="submit" tone="danger">
              {t("support.features.supportRequests.ui.supportRequestDetailPage.cancel.submit")}
            </Button>
          </Cluster>
        </RouterForm>
      </Card.Body>
    </Card>
  );
}

function timelineItems(request: SupportRequestDetail): TimelineItem[] {
  const items: Array<TimelineItem & { id: string; at: string }> = [
    {
      id: "opened",
      at: request.opened_at,
      title: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.opened"),
      description: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.openedBy", {
        party: request.opened_by_role,
      }),
      timestamp: formatSupportDateTime(request.opened_at),
    },
    ...request.evidence.map((evidence) => ({
      id: `evidence:${evidence.evidenceId}`,
      at: evidence.submittedAt,
      title: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.evidence"),
      description: evidence.summary,
      timestamp: formatSupportDateTime(evidence.submittedAt),
    })),
    ...request.responses
      .filter((response) => response.offerId === null)
      .map((response) => ({
        id: `response:${response.responseId}`,
        at: response.submittedAt,
        title: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.response"),
        description: response.summary,
        timestamp: formatSupportDateTime(response.submittedAt),
      })),
    ...request.offers.flatMap((offer) => {
      const offerItems: Array<TimelineItem & { id: string; at: string }> = [
        {
          id: `offer:${offer.offerId}`,
          at: offer.offeredAt,
          title: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.offer"),
          description: offer.summary,
          timestamp: formatSupportDateTime(offer.offeredAt),
        },
      ];
      if (offer.decidedAt) {
        offerItems.push({
          id: `offer-decision:${offer.offerId}`,
          at: offer.decidedAt,
          title:
            offer.status === "accepted"
              ? t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.offerAccepted")
              : t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.offerDeclined"),
          description: offer.decisionSummary ?? offer.summary,
          timestamp: formatSupportDateTime(offer.decidedAt),
        });
      }
      return offerItems;
    }),
  ];

  if (request.escalated_at) {
    items.push({
      id: "escalated",
      at: request.escalated_at,
      title: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.escalated"),
      description: request.escalation_reason ?? undefined,
      timestamp: formatSupportDateTime(request.escalated_at),
    });
  }
  if (request.resolution) {
    items.push({
      id: "resolved",
      at: request.resolution.resolvedAt,
      title: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.resolved"),
      description: request.resolution.summary,
      timestamp: formatSupportDateTime(request.resolution.resolvedAt),
    });
  }
  if (request.closed_at) {
    items.push({
      id: "closed",
      at: request.closed_at,
      title: t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.closed"),
      timestamp: formatSupportDateTime(request.closed_at),
    });
  }

  return items.sort((left, right) => left.at.localeCompare(right.at));
}

function ResolutionSummary({ request }: Readonly<{ request: SupportRequestDetail }>) {
  if (!request.resolution) return null;
  const hasRefund = request.resolution.refundAmount !== null;
  const progress = request.remedy
    ? t(`support.features.supportRequests.ui.supportRequestDetailPage.resolution.progress.${request.case_presentation}`)
    : hasRefund
      ? t("support.features.supportRequests.ui.supportRequestDetailPage.resolution.refundPending")
      : t("support.features.supportRequests.ui.supportRequestDetailPage.resolution.complete");

  return (
    <PageSection title={t("support.features.supportRequests.ui.supportRequestDetailPage.resolution.title")}>
      <KeyValueList
        variant="surface"
        items={[
          {
            key: t("support.features.supportRequests.ui.supportRequestDetailPage.resolution.outcome"),
            value: request.resolution.resolutionType,
          },
          {
            key: t("support.features.supportRequests.ui.supportRequestDetailPage.resolution.summary"),
            value: request.resolution.summary,
          },
          ...(hasRefund
            ? [
                {
                  key: t("support.features.supportRequests.ui.supportRequestDetailPage.resolution.refundAmount"),
                  value: formatMoney(request.resolution.refundAmount!, "USD"),
                },
                {
                  key: t("support.features.supportRequests.ui.supportRequestDetailPage.resolution.refundProgress"),
                  value: progress,
                },
              ]
            : []),
        ]}
      />
    </PageSection>
  );
}

function actionResultMessage(actionResult: string | null | undefined) {
  switch (actionResult) {
    case "evidence":
    case "response":
    case "offerAccepted":
    case "offerDeclined":
    case "escalated":
    case "cancelled":
      return t(`support.features.supportRequests.ui.supportRequestDetailPage.actionResult.${actionResult}`);
    default:
      return null;
  }
}

export function SupportRequestDetailPage({
  request,
  flow,
  viewerRole,
  participantPolicy,
  now,
  actionError,
  actionResult,
}: SupportRequestDetailPageProps) {
  const { nextActor, deadlineAt, actions } = participantPolicy;
  const viewerActsNext = nextActor === viewerRole;
  const allows = (kind: SupportParticipantAction["kind"]) => actions.some((action) => action.kind === kind);
  const prompts = request.checklist.filter((item) =>
    actions.some((action) => action.kind === "submit-evidence" && action.checklistItemKey === item.key),
  );
  const resultMessage = actionResultMessage(actionResult);

  return (
    <Page width="content">
      <PageHeader
        eyebrow={t("support.features.supportRequests.ui.supportRequestDetailPage.eyebrow")}
        title={request.display_reference || request.support_request_id}
        description={flow.title}
        actions={
          <LinkButton href="/account/support" tone="secondary">
            {t("support.features.supportRequests.ui.supportRequestDetailPage.back")}
          </LinkButton>
        }
      />

      {actionError ? <MarketplaceNotice tone="danger" title={actionError} /> : null}
      {resultMessage ? <MarketplaceNotice tone="success" title={resultMessage} /> : null}

      <MarketplaceNotice
        tone={isTerminalStatus(request.status) ? "success" : viewerActsNext ? "warning" : "info"}
        title={actionTitle(nextActor, viewerRole, request.status)}
        description={
          <Stack gap={2}>
            <Text size="sm">
              {t("support.features.supportRequests.ui.supportRequestDetailPage.currentStatus", {
                status: statusLabel(request.status),
              })}
            </Text>
            {!isTerminalStatus(request.status) ? <SupportDeadlineCountdown dueAt={deadlineAt} now={now} /> : null}
            <Text size="sm">{flow.automationSummary}</Text>
          </Stack>
        }
      />

      <PageSection title={t("support.features.supportRequests.ui.supportRequestDetailPage.overview.title")}>
        <KeyValueList
          items={[
            {
              key: t("support.features.supportRequests.ui.supportRequestDetailPage.overview.order"),
              value: request.order_id,
            },
            {
              key: t("support.features.supportRequests.ui.supportRequestDetailPage.overview.status"),
              value: (
                <Badge tone={isTerminalStatus(request.status) ? "success" : "warning"}>
                  {statusLabel(request.status)}
                </Badge>
              ),
            },
            {
              key: t("support.features.supportRequests.ui.supportRequestDetailPage.overview.opened"),
              value: formatSupportDateTime(request.opened_at),
            },
          ]}
        />
      </PageSection>

      {prompts.length > 0 ? (
        <PageSection
          title={t("support.features.supportRequests.ui.supportRequestDetailPage.prompts.title")}
          description={t("support.features.supportRequests.ui.supportRequestDetailPage.prompts.description")}
        >
          <Stack gap={4}>
            {prompts.map((item) => (
              <EvidencePrompt key={item.key} item={item} viewerRole={viewerRole} />
            ))}
          </Stack>
        </PageSection>
      ) : null}

      {request.pending_offer && (allows("accept-offer") || allows("decline-offer")) ? (
        <PageSection title={t("support.features.supportRequests.ui.supportRequestDetailPage.actions.title")}>
          <OfferDecision request={request} canAccept={allows("accept-offer")} canDecline={allows("decline-offer")} />
        </PageSection>
      ) : null}

      {allows("record-response") ? (
        <PageSection title={t("support.features.supportRequests.ui.supportRequestDetailPage.actions.title")}>
          <Stack gap={4}>
            <ResponseForm flow={flow} viewerRole={viewerRole} />
            {allows("escalate") ? <RequestSupportReviewForm /> : null}
          </Stack>
        </PageSection>
      ) : null}

      {allows("escalate") && !allows("record-response") ? (
        <PageSection title={t("support.features.supportRequests.ui.supportRequestDetailPage.actions.title")}>
          <RequestSupportReviewForm />
        </PageSection>
      ) : null}

      {allows("cancel") ? (
        <PageSection title={t("support.features.supportRequests.ui.supportRequestDetailPage.cancel.sectionTitle")}>
          <CancelCaseForm />
        </PageSection>
      ) : null}

      <ResolutionSummary request={request} />

      <PageSection
        title={t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.title")}
        description={t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.description")}
      >
        <Timeline
          aria-label={t("support.features.supportRequests.ui.supportRequestDetailPage.timeline.ariaLabel")}
          items={timelineItems(request)}
        />
      </PageSection>
    </Page>
  );
}
