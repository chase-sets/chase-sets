import { formatDateTime, t } from "@chase-sets/localization";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  HiddenInput,
  AppliedFilterChips,
  Badge,
  Button,
  Cluster,
  DataTable,
  EmptyState,
  FilterArea,
  Form,
  Grid,
  Inline,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Pagination,
  Stack,
  Surface,
  Text,
  Textarea,
  TextInput,
} from "@chase-sets/design-system";
import type {
  PlatformRemedyProposalInput,
  PlatformRemedyProposalPreview,
  SupportOperationsQueueFilters,
  SupportRequestDetail,
  SupportRequestListItem,
} from "./contracts";
import { normalizeFlowType } from "../domain/common";
import { getSupportResponsibilityReasonDefinitions } from "../domain/responsibility";
import { PLATFORM_REMEDY_LAUNCH_POLICY_VALUE, platformRemedyCapabilities } from "../domain/platform-remedy-policy";

type SupportOperationsPageProps = Readonly<{
  queue: Readonly<{ items: readonly SupportRequestListItem[]; total: number; count: number }>;
  filters?: SupportOperationsQueueFilters;
  pagination?: Readonly<{ limit: number; offset: number }>;
  unavailableMessage?: string | null;
  escalationResult?: Readonly<{ escalated: number; skipped: number; capped: boolean; total: number }> | null;
  actionError?: string | null;
  marketplaceOrigin?: string | null;
}>;

type SupportTone = "neutral" | "warning" | "danger";

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
  { value: "full-refund", label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.fullRefund") },
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
  { value: "no-action", label: t("support.features.supportRequests.ui.supportOperationsPage.resolution.noAction") },
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

function statusTone(status: string) {
  return (
    status === "ready-for-support" ? "warning" : status === "escalated" ? "danger" : "neutral"
  ) satisfies SupportTone;
}

function priorityTone(priority: string) {
  return (priority === "urgent" ? "danger" : "neutral") satisfies SupportTone;
}

function formatOperationsDateTime(value: string | null) {
  if (!value) {
    return t("support.features.supportRequests.ui.supportOperationsPage.not.applicable");
  }

  return formatDateTime(value, { preset: "short" });
}

function nextDeadline(request: SupportRequestListItem) {
  return request.seller_response_due_at ?? request.support_review_due_at ?? request.seller_condition_attestation_due_at;
}

function checklistSummary(request: SupportRequestListItem) {
  const required = request.checklist.filter((item) => item.required);
  const satisfied = required.filter((item) => item.satisfiedAt !== null);
  return t("support.features.supportRequests.ui.supportOperationsPage.checklist.summary", {
    satisfied: satisfied.length,
    required: required.length,
  });
}

function isTerminalStatus(status: string) {
  return status === "resolved" || status === "closed" || status === "cancelled";
}

const SUPPORT_OPERATIONS_QUEUE_STATUS_FILTERS = [
  "all",
  "open",
  "waiting-on-buyer",
  "waiting-on-seller",
  "ready-for-support",
  "resolved",
  "closed",
  "cancelled",
] as const;

const SUPPORT_OPERATIONS_QUEUE_PRIORITY_FILTERS = ["all", "normal", "urgent"] as const;

function queueStatusFilterLabel(status: string) {
  switch (status) {
    case "open":
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.open");
    case "waiting-on-buyer":
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.waitingOnBuyer");
    case "waiting-on-seller":
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.waitingOnSeller");
    case "ready-for-support":
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.readyForSupport");
    case "resolved":
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.resolved");
    case "closed":
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.closed");
    case "cancelled":
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.cancelled");
    default:
      return t("support.features.supportRequests.ui.supportOperationsPage.status.filter.all");
  }
}

function queuePriorityFilterLabel(priority: string) {
  switch (priority) {
    case "normal":
      return t("support.features.supportRequests.ui.supportOperationsPage.priority.filter.normal");
    case "urgent":
      return t("support.features.supportRequests.ui.supportOperationsPage.priority.filter.urgent");
    default:
      return t("support.features.supportRequests.ui.supportOperationsPage.priority.filter.all");
  }
}

function queueStatusFilterItems() {
  return SUPPORT_OPERATIONS_QUEUE_STATUS_FILTERS.map((status) => ({
    value: status,
    label: queueStatusFilterLabel(status),
  }));
}

function queuePriorityFilterItems() {
  return SUPPORT_OPERATIONS_QUEUE_PRIORITY_FILTERS.map((priority) => ({
    value: priority,
    label: queuePriorityFilterLabel(priority),
  }));
}

function buildQueueAppliedFilters(filters: Readonly<{ status: string; priority: string; search: string }>) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("support.features.supportRequests.ui.supportOperationsPage.search.filter.chip", {
        search: filters.search,
      }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("support.features.supportRequests.ui.supportOperationsPage.status.filter.chip", {
        status: queueStatusFilterLabel(filters.status),
      }),
    });
  }
  if (filters.priority !== "all") {
    applied.push({
      id: "priority",
      label: t("support.features.supportRequests.ui.supportOperationsPage.priority.filter.chip", {
        priority: queuePriorityFilterLabel(filters.priority),
      }),
    });
  }

  return applied;
}

function navigateSupportOperationsQueue(page: number, pageSize: number) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String((page - 1) * pageSize));
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
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

function orderMarketplacePathnames(orderId: string) {
  return {
    purchase: `/account/purchases/${orderId}`,
    sale: `/account/sales/${orderId}`,
  };
}

function resolveOrderMarketplaceHref(pathname: string, marketplaceOrigin: string | null | undefined) {
  if (!marketplaceOrigin) {
    return null;
  }

  return new URL(pathname, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
}

function OrderMarketplaceLinks({
  orderId,
  marketplaceOrigin,
}: Readonly<{ orderId: string; marketplaceOrigin?: string | null }>) {
  const pathnames = orderMarketplacePathnames(orderId);
  const purchaseHref = resolveOrderMarketplaceHref(pathnames.purchase, marketplaceOrigin);
  const saleHref = resolveOrderMarketplaceHref(pathnames.sale, marketplaceOrigin);

  return (
    <Stack gap={1}>
      <Text element="span" size="sm" wrap="anywhere">
        {orderId}
      </Text>
      {purchaseHref && saleHref ? (
        <Inline gap={1}>
          <LinkButton
            href={purchaseHref}
            size="sm"
            tone="secondary"
            target="_blank"
            rel="noreferrer"
            trailingIcon="externalLink"
          >
            {t("support.features.supportRequests.ui.supportOperationsPage.order.viewPurchase")}
          </LinkButton>
          <LinkButton
            href={saleHref}
            size="sm"
            tone="secondary"
            target="_blank"
            rel="noreferrer"
            trailingIcon="externalLink"
          >
            {t("support.features.supportRequests.ui.supportOperationsPage.order.viewSale")}
          </LinkButton>
        </Inline>
      ) : (
        <Badge tone="warning">
          {t("support.features.supportRequests.ui.supportOperationsPage.order.marketplaceLinkUnavailable")}
        </Badge>
      )}
    </Stack>
  );
}

function SupportOperationsQueue({
  requests,
  marketplaceOrigin,
}: Readonly<{ requests: readonly SupportRequestListItem[]; marketplaceOrigin?: string | null }>) {
  if (requests.length === 0) {
    return (
      <EmptyState
        title={t("support.features.supportRequests.ui.supportOperationsPage.no.requests")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.no.requests.description")}
      />
    );
  }

  return (
    <DataTable
      density="compact"
      rows={[...requests]}
      getRowId={(request) => request.support_request_id}
      emptyTitle={t("support.features.supportRequests.ui.supportOperationsPage.no.requests")}
      emptyDescription={t("support.features.supportRequests.ui.supportOperationsPage.no.requests.description")}
      columns={[
        {
          key: "reference",
          header: t("support.features.supportRequests.ui.supportOperationsPage.reference"),
          cell: (request) => request.display_reference || request.support_request_id,
        },
        {
          key: "issue",
          header: t("support.features.supportRequests.ui.supportOperationsPage.issue"),
          cell: (request) => (
            <Stack gap={1}>
              <Text element="span" weight="semibold">
                {request.flow_type}
              </Text>
              <Text element="span" size="xs" tone="secondary">
                {request.display_reference || request.support_request_id}
              </Text>
            </Stack>
          ),
        },
        {
          key: "order",
          header: t("support.features.supportRequests.ui.supportOperationsPage.order"),
          cell: (request) => <OrderMarketplaceLinks orderId={request.order_id} marketplaceOrigin={marketplaceOrigin} />,
        },
        {
          key: "accounts",
          header: t("support.features.supportRequests.ui.supportOperationsPage.accounts"),
          cell: (request) => (
            <Stack gap={1}>
              <Text element="span">{request.buyer_account_id}</Text>
              <Text element="span" size="xs" tone="secondary">
                {request.seller_account_id}
              </Text>
            </Stack>
          ),
        },
        {
          key: "status",
          header: t("support.features.supportRequests.ui.supportOperationsPage.status"),
          cell: (request) => <Badge tone={statusTone(request.status)}>{request.status}</Badge>,
        },
        {
          key: "priority",
          header: t("support.features.supportRequests.ui.supportOperationsPage.priority"),
          cell: (request) => <Badge tone={priorityTone(request.priority)}>{request.priority}</Badge>,
        },
        {
          key: "deadline",
          header: t("support.features.supportRequests.ui.supportOperationsPage.next.deadline"),
          cell: (request) => formatOperationsDateTime(nextDeadline(request)),
        },
        {
          key: "checklist",
          header: t("support.features.supportRequests.ui.supportOperationsPage.checklist"),
          cell: (request) => checklistSummary(request),
        },
        {
          key: "action",
          header: t("support.features.supportRequests.ui.supportOperationsPage.action"),
          align: "right",
          cell: (request) => (
            <LinkButton href={`/support/requests/${request.support_request_id}`} size="sm" tone="secondary">
              {t("support.features.supportRequests.ui.supportOperationsPage.open")}
            </LinkButton>
          ),
        },
      ]}
    />
  );
}

function detailRows(request: SupportRequestDetail) {
  return [
    [
      t("support.features.supportRequests.ui.supportOperationsPage.reference"),
      request.display_reference || request.support_request_id,
    ],
    [t("support.features.supportRequests.ui.supportOperationsPage.issue"), request.flow_type],
    [t("support.features.supportRequests.ui.supportOperationsPage.status"), request.status],
    [t("support.features.supportRequests.ui.supportOperationsPage.priority"), request.priority],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.next.deadline"),
      formatOperationsDateTime(nextDeadline(request)),
    ],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.seller.condition.attestation.due"),
      formatOperationsDateTime(request.seller_condition_attestation_due_at),
    ],
  ] as const;
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

function remedyCurrency(request: SupportRequestDetail) {
  const affected = Array.isArray(request.affected_line_items) ? request.affected_line_items : [];
  const first = affected.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  return String(first?.currencyCode ?? "usd").toLowerCase();
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
      formatOperationsDateTime(preview.reservationExpiresAt),
    ],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.approvals"),
      String(preview.requiredApprovalCount),
    ],
    [t("support.features.supportRequests.ui.supportOperationsPage.remedy.policyVersion"), preview.policyVersion],
  ] as const;
  return (
    <Surface tone="muted">
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

function PlatformRemedyWorkflowPanel({
  request,
  actorPermissions,
  preview,
  proposalInput,
}: Readonly<{
  request: SupportRequestDetail;
  actorPermissions: readonly string[];
  preview?: PlatformRemedyProposalPreview | null;
  proposalInput?: PlatformRemedyProposalInput | null;
}>) {
  const workflow = request.remedy_approval;
  const remedy = request.remedy;
  const decidedAmount = request.resolution?.refundAmount ?? "";
  const currencyCode = remedyCurrency(request);
  const canPropose = actorPermissions.includes(platformRemedyCapabilities.propose);
  const canApprove =
    actorPermissions.includes(platformRemedyCapabilities.approve) ||
    actorPermissions.includes(platformRemedyCapabilities.approveElevated);
  const canRetry = actorPermissions.includes(platformRemedyCapabilities.retry);
  const canWaive = actorPermissions.includes(platformRemedyCapabilities.waive);
  const canCorrect = actorPermissions.includes(platformRemedyCapabilities.correct);
  const canOverrideReturn = actorPermissions.includes(platformRemedyCapabilities.overrideReturn);

  if (!workflow) {
    if (!request.resolution?.refundAmount) {
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
              defaultValue={proposalNestedValue(proposalInput, "remedy", "currencyCode", currencyCode)}
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
                {
                  value: "split",
                  label: t("support.features.supportRequests.ui.supportOperationsPage.remedy.funding.split"),
                },
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
              items={PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.allowableRefundTriggers.map((value) => ({
                value,
                label: value,
              }))}
              defaultValue={proposalValue(proposalInput, "refundTrigger", "immediate")}
              required
            />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.reason")}
              name="reasonCode"
              items={PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.eligibleReasonCodes.map((value) => ({ value, label: value }))}
              defaultValue={proposalValue(
                proposalInput,
                "reasonCode",
                PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.eligibleReasonCodes[0] ?? "",
              )}
              required
            />
            <NativeSelect
              label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.returnException")}
              name="returnExceptionReasonCode"
              items={PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.returnExceptionReasonCodes.map((value) => ({
                value,
                label: value,
              }))}
              defaultValue={proposalValue(
                proposalInput,
                "returnExceptionReasonCode",
                PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.returnExceptionReasonCodes[0] ?? "",
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
          <HiddenInput
            type="hidden"
            name="idempotencyKey"
            value={`${request.support_request_id}:platform-remedy-proposal`}
            readOnly
          />
          <Cluster justify="end">
            <Button type="submit" name="intent" value="preview-remedy" tone="secondary" disabled={!canPropose}>
              {t("support.features.supportRequests.ui.supportOperationsPage.remedy.preview.submit")}
            </Button>
            <Button type="submit" name="intent" value="propose-remedy" disabled={!canPropose || !preview}>
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
      <Surface>
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

      {workflow.status === "approval-pending" ? (
        <Surface>
          <RouterForm method="post" spacing="md">
            <HiddenInput type="hidden" name="idempotencyKey" value={`${workflow.terms.remedyId}:approval`} readOnly />
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
              <Button type="submit" name="intent" value="approve-remedy" disabled={!canApprove}>
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
            const waivable = !["coverage-reservation", "refund-completion", "settlement-reconciliation"].includes(
              effect.effect,
            );
            return (
              <Surface
                key={effect.effect}
                tone={retryable || effect.status === "failed-terminal" ? "muted" : undefined}
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
                      {latest.reasonCode} · {formatOperationsDateTime(latest.occurredAt)}
                    </Text>
                  ) : null}
                  {retryable ? (
                    <RouterForm method="post" spacing="sm">
                      <HiddenInput type="hidden" name="remedyId" value={remedy.remedyId} readOnly />
                      <HiddenInput type="hidden" name="effect" value={effect.effect} readOnly />
                      <HiddenInput
                        type="hidden"
                        name="idempotencyKey"
                        value={`${remedy.remedyId}:${effect.effect}:${latest?.idempotencyKey ?? "pending"}:retry`}
                        readOnly
                      />
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
                      <Button type="submit" name="intent" value="retry-remedy-effect" disabled={!canRetry}>
                        {t("support.features.supportRequests.ui.supportOperationsPage.remedy.retry.submit")}
                      </Button>
                    </RouterForm>
                  ) : null}
                  {effect.status === "failed-terminal" && waivable ? (
                    <RouterForm method="post" spacing="sm">
                      <HiddenInput type="hidden" name="remedyId" value={remedy.remedyId} readOnly />
                      <HiddenInput type="hidden" name="effect" value={effect.effect} readOnly />
                      <HiddenInput
                        type="hidden"
                        name="idempotencyKey"
                        value={`${remedy.remedyId}:${effect.effect}:${latest?.idempotencyKey ?? "pending"}:waive`}
                        readOnly
                      />
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
                        disabled={!canWaive}
                        tone="secondary"
                      >
                        {t("support.features.supportRequests.ui.supportOperationsPage.remedy.waive.submit")}
                      </Button>
                    </RouterForm>
                  ) : null}
                  {effect.effect === "operator-release" && effect.status === "pending" ? (
                    <RouterForm method="post" spacing="sm">
                      <HiddenInput type="hidden" name="remedyId" value={remedy.remedyId} readOnly />
                      <HiddenInput
                        type="hidden"
                        name="idempotencyKey"
                        value={`${remedy.remedyId}:operator-release`}
                        readOnly
                      />
                      <TextInput
                        label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.recovery.reason")}
                        name="reasonCode"
                        required
                      />
                      <Button type="submit" name="intent" value="release-remedy-refund" disabled={!canOverrideReturn}>
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

      <Surface>
        <RouterForm method="post" spacing="md">
          <HiddenInput type="hidden" name="idempotencyKey" value={`${workflow.terms.remedyId}:correction`} readOnly />
          <NativeSelect
            label={t("support.features.supportRequests.ui.supportOperationsPage.remedy.correction.reason")}
            name="reasonCode"
            items={PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.escalationReasonCodes.map((value) => ({ value, label: value }))}
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
              disabled={!canCorrect}
            >
              {t("support.features.supportRequests.ui.supportOperationsPage.remedy.correction.submit")}
            </Button>
          </Cluster>
        </RouterForm>
      </Surface>

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
            cell: (entry) => formatOperationsDateTime(entry.occurredAt),
          },
        ]}
      />
    </Stack>
  );
}

export function SupportOperationsDetailPage({
  request,
  actionError,
  actionResult,
  marketplaceOrigin,
  actorPermissions = [],
  remedyPreview,
  remedyProposalInput,
}: Readonly<{
  request: SupportRequestDetail;
  actionError?: string | null;
  actionResult?: string | null;
  marketplaceOrigin?: string | null;
  actorPermissions?: readonly string[];
  remedyPreview?: PlatformRemedyProposalPreview | null;
  remedyProposalInput?: PlatformRemedyProposalInput | null;
}>) {
  const successMessage = actionResultMessage(actionResult);
  const canMutate = !isTerminalStatus(request.status);
  const canClose = request.status === "resolved" && request.closure_eligible;
  const responsibilityReasonItems = getSupportResponsibilityReasonDefinitions(normalizeFlowType(request.flow_type))
    .filter(({ operatorSelectable }) => operatorSelectable)
    .map(({ code, responsibility, operatorLabel }) => ({
      value: `${responsibility}|${code}`,
      label: t("support.features.supportRequests.ui.supportOperationsPage.resolve.responsibilityReasonOption", {
        reason: operatorLabel,
        responsibility,
      }),
    }));

  return (
    <Page>
      <PageHeader
        title={t("support.features.supportRequests.ui.supportOperationsPage.detail.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.detail.description", {
          id: request.display_reference || request.support_request_id,
        })}
        actions={
          <LinkButton href="/support/requests" tone="secondary">
            {t("support.features.supportRequests.ui.supportOperationsPage.back")}
          </LinkButton>
        }
      />

      {successMessage ? (
        <Surface tone="muted">
          <Inline gap={2}>
            <Badge tone="success">{t("support.features.supportRequests.ui.supportOperationsPage.success")}</Badge>
            <Text size="sm" weight="semibold">
              {successMessage}
            </Text>
          </Inline>
        </Surface>
      ) : null}

      {actionError ? (
        <Surface tone="muted">
          <Inline gap={2}>
            <Badge tone="danger">{t("support.features.supportRequests.ui.supportOperationsPage.error")}</Badge>
            <Text size="sm" weight="semibold">
              {actionError}
            </Text>
          </Inline>
        </Surface>
      ) : null}

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.detail.summary")}>
        <Surface>
          <Stack gap={3}>
            <Cluster align="start" justify="between" gap={1}>
              <Text size="sm" weight="semibold">
                {t("support.features.supportRequests.ui.supportOperationsPage.order")}
              </Text>
              <OrderMarketplaceLinks orderId={request.order_id} marketplaceOrigin={marketplaceOrigin} />
            </Cluster>
            {detailRows(request).map(([label, value]) => (
              <Cluster key={label} align="start" justify="between" gap={1}>
                <Text size="sm" weight="semibold">
                  {label}
                </Text>
                <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                  {value}
                </Text>
              </Cluster>
            ))}
          </Stack>
        </Surface>
      </PageSection>

      <PageSection
        title={t("support.features.supportRequests.ui.supportOperationsPage.remedy.section.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.remedy.section.description")}
      >
        <PlatformRemedyWorkflowPanel
          request={request}
          actorPermissions={actorPermissions}
          preview={remedyPreview}
          proposalInput={remedyProposalInput}
        />
      </PageSection>

      <PageSection
        title={t("support.features.supportRequests.ui.supportOperationsPage.detail.operatorActions")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.detail.operatorActions.description")}
      >
        <Grid columns={{ base: 1, lg: 2 }}>
          <Surface>
            <RouterForm method="post" spacing="md">
              <HiddenInput type="hidden" name="intent" value="note" readOnly />
              <Textarea
                label={t("support.features.supportRequests.ui.supportOperationsPage.note.summary")}
                name="summary"
                required
                rows={4}
              />
              <Cluster justify="end">
                <Button type="submit" disabled={!canMutate}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.note.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>

          <Surface>
            <RouterForm method="post" spacing="md">
              <HiddenInput type="hidden" name="intent" value="response" readOnly />
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
                rows={4}
              />
              <Cluster justify="end">
                <Button type="submit" disabled={!canMutate}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.response.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>

          <Surface>
            <RouterForm method="post" spacing="md">
              <HiddenInput type="hidden" name="intent" value="escalate" readOnly />
              <Textarea
                label={t("support.features.supportRequests.ui.supportOperationsPage.escalate.reason")}
                name="reason"
                required
                rows={3}
              />
              <Cluster justify="end">
                <Button type="submit" tone="secondary" disabled={!canMutate}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.escalate.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>

          <Surface>
            <RouterForm method="post" spacing="md">
              <HiddenInput type="hidden" name="intent" value="resolve" readOnly />
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
                items={responsibilityReasonItems}
                defaultValue={responsibilityReasonItems[0]?.value}
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
                <Button type="submit" disabled={!canMutate}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.resolve.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>

          <Surface>
            <RouterForm method="post" spacing="md">
              <HiddenInput type="hidden" name="intent" value="close" readOnly />
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
                <Button type="submit" tone="secondary" disabled={!canClose}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.close.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>

          <Surface>
            <RouterForm method="post" spacing="md">
              <HiddenInput type="hidden" name="intent" value="cancel" readOnly />
              <Textarea
                label={t("support.features.supportRequests.ui.supportOperationsPage.cancel.reason")}
                name="reason"
                required
                rows={3}
              />
              <Cluster justify="end">
                <Button type="submit" tone="danger" disabled={!canMutate}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.cancel.submit")}
                </Button>
              </Cluster>
            </RouterForm>
          </Surface>
        </Grid>
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.accounts")}>
        <Surface>
          <Stack>
            <Text element="span" wrap="anywhere">
              {request.buyer_account_id}
            </Text>
            <Text element="span" wrap="anywhere">
              {request.seller_account_id}
            </Text>
          </Stack>
        </Surface>
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.checklist")}>
        <DataTable
          density="compact"
          rows={[...request.checklist]}
          getRowId={(item) => item.key}
          columns={[
            {
              key: "requirement",
              header: t("support.features.supportRequests.ui.supportOperationsPage.detail.requirement"),
              cell: (item) => (
                <Text element="span" wrap="anywhere">
                  {item.label}
                </Text>
              ),
            },
            {
              key: "status",
              header: t("support.features.supportRequests.ui.supportOperationsPage.status"),
              cell: (item) => (
                <Text element="span" wrap="anywhere">
                  {item.satisfiedAt ?? t("support.features.supportRequests.ui.supportOperationsPage.not.applicable")}
                </Text>
              ),
            },
          ]}
        />
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.return.context")}>
        <DataTable
          density="compact"
          rows={returnContextRows(request)}
          getRowId={(item) => String(item.lineId)}
          emptyTitle={t("support.features.supportRequests.ui.supportOperationsPage.no.return.context")}
          emptyDescription={t(
            "support.features.supportRequests.ui.supportOperationsPage.no.return.context.description",
          )}
          columns={[
            {
              key: "item",
              header: t("support.features.supportRequests.ui.supportOperationsPage.item"),
              cell: (item) => (
                <Text element="span" wrap="anywhere">
                  {String(item.itemTitle ?? "")}
                </Text>
              ),
            },
            {
              key: "listing",
              header: t("support.features.supportRequests.ui.supportOperationsPage.listing"),
              cell: (item) => String(item.listingId ?? ""),
            },
            {
              key: "gradedCard",
              header: t("support.features.supportRequests.ui.supportOperationsPage.graded.card"),
              cell: (item) => (
                <Text element="span" wrap="anywhere">
                  {gradedCardSummary(item)}
                </Text>
              ),
            },
          ]}
        />
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.evidence")}>
        <DataTable
          density="compact"
          rows={[...request.evidence]}
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
              key: "role",
              header: t("support.features.supportRequests.ui.supportOperationsPage.role"),
              cell: (item) => item.submittedByRole,
            },
            {
              key: "summary",
              header: t("support.features.supportRequests.ui.supportOperationsPage.summary"),
              cell: (item) => (
                <Text element="span" wrap="anywhere">
                  {item.summary}
                </Text>
              ),
            },
            {
              key: "submitted",
              header: t("support.features.supportRequests.ui.supportOperationsPage.submitted"),
              cell: (item) => formatOperationsDateTime(item.submittedAt),
            },
          ]}
        />
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.responses")}>
        <DataTable
          density="compact"
          rows={[...request.responses]}
          getRowId={(item) => item.responseId}
          emptyTitle={t("support.features.supportRequests.ui.supportOperationsPage.no.responses")}
          emptyDescription={t("support.features.supportRequests.ui.supportOperationsPage.no.responses.description")}
          columns={[
            {
              key: "type",
              header: t("support.features.supportRequests.ui.supportOperationsPage.type"),
              cell: (item) => item.responseType,
            },
            {
              key: "role",
              header: t("support.features.supportRequests.ui.supportOperationsPage.role"),
              cell: (item) => item.submittedByRole,
            },
            {
              key: "summary",
              header: t("support.features.supportRequests.ui.supportOperationsPage.summary"),
              cell: (item) => (
                <Text element="span" wrap="anywhere">
                  {item.summary}
                </Text>
              ),
            },
            {
              key: "submitted",
              header: t("support.features.supportRequests.ui.supportOperationsPage.submitted"),
              cell: (item) => formatOperationsDateTime(item.submittedAt),
            },
          ]}
        />
      </PageSection>

      {request.resolution ? (
        <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.resolution")}>
          <Surface>
            <Stack gap={3}>
              <Cluster align="start" justify="between" gap={1}>
                <Text size="sm" weight="semibold">
                  {t("support.features.supportRequests.ui.supportOperationsPage.type")}
                </Text>
                <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                  {request.resolution.resolutionType}
                </Text>
              </Cluster>
              <Cluster align="start" justify="between" gap={1}>
                <Text size="sm" weight="semibold">
                  {t("support.features.supportRequests.ui.supportOperationsPage.resolve.responsibility")}
                </Text>
                <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                  {request.resolution.responsibility}
                </Text>
              </Cluster>
              <Cluster align="start" justify="between" gap={1}>
                <Text size="sm" weight="semibold">
                  {t("support.features.supportRequests.ui.supportOperationsPage.resolve.responsibilityReason")}
                </Text>
                <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                  {request.resolution.responsibilityReasonCode}
                </Text>
              </Cluster>
              <Cluster align="start" justify="between" gap={1}>
                <Text size="sm" weight="semibold">
                  {t("support.features.supportRequests.ui.supportOperationsPage.resolve.evidenceBasis")}
                </Text>
                <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                  {t("support.features.supportRequests.ui.supportOperationsPage.resolve.evidenceBasisValue", {
                    type: request.resolution.evidenceBasis.type,
                    reference: request.resolution.evidenceBasis.reference,
                  })}
                </Text>
              </Cluster>
              <Cluster align="start" justify="between" gap={1}>
                <Text size="sm" weight="semibold">
                  {t("support.features.supportRequests.ui.supportOperationsPage.summary")}
                </Text>
                <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                  {request.resolution.summary}
                </Text>
              </Cluster>
              <Cluster align="start" justify="between" gap={1}>
                <Text size="sm" weight="semibold">
                  {t("support.features.supportRequests.ui.supportOperationsPage.resolve.refundAmount")}
                </Text>
                <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                  {request.resolution.refundAmount ??
                    t("support.features.supportRequests.ui.supportOperationsPage.not.applicable")}
                </Text>
              </Cluster>
            </Stack>
          </Surface>
        </PageSection>
      ) : null}
    </Page>
  );
}

export function SupportOperationsPage({
  queue,
  filters = { status: "all", priority: "all", search: "" },
  pagination,
  unavailableMessage,
  escalationResult,
  actionError,
  marketplaceOrigin,
}: SupportOperationsPageProps) {
  const pageSize = pagination?.limit ?? queue.items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(queue.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (queue.total > pageSize || pagination.offset > 0));
  const appliedFilters = buildQueueAppliedFilters(filters);

  return (
    <Page>
      <PageHeader
        title={t("support.features.supportRequests.ui.supportOperationsPage.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.description")}
      />

      {unavailableMessage ? (
        <Surface tone="muted">
          <Stack gap={2}>
            <Inline gap={2}>
              <Badge tone="warning">{t("support.features.supportRequests.ui.supportOperationsPage.unavailable")}</Badge>
            </Inline>
            <Text size="sm" weight="semibold">
              {t("support.features.supportRequests.ui.supportOperationsPage.unavailable")}
            </Text>
            <Text size="sm" tone="secondary">
              {unavailableMessage}
            </Text>
          </Stack>
        </Surface>
      ) : null}

      {escalationResult ? (
        <Surface tone="muted">
          <Stack gap={2}>
            <Inline gap={2}>
              <Badge tone={escalationResult.capped ? "warning" : "success"}>
                {escalationResult.capped
                  ? t("support.features.supportRequests.ui.supportOperationsPage.partial")
                  : t("support.features.supportRequests.ui.supportOperationsPage.success")}
              </Badge>
              <Text size="sm" weight="semibold">
                {t("support.features.supportRequests.ui.supportOperationsPage.escalation.result", escalationResult)}
              </Text>
            </Inline>
            {escalationResult.capped ? (
              <Text size="sm" tone="secondary">
                {t("support.features.supportRequests.ui.supportOperationsPage.escalation.capped", {
                  total: escalationResult.total,
                })}
              </Text>
            ) : null}
          </Stack>
        </Surface>
      ) : null}

      {actionError ? (
        <Surface tone="muted">
          <Inline gap={2}>
            <Badge tone="danger">{t("support.features.supportRequests.ui.supportOperationsPage.error")}</Badge>
            <Text size="sm" weight="semibold">
              {actionError}
            </Text>
          </Inline>
        </Surface>
      ) : null}

      <PageSection
        title={t("support.features.supportRequests.ui.supportOperationsPage.queue.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.queue.description")}
      >
        <Stack gap={3}>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={3}
              panelTitle={t("support.features.supportRequests.ui.supportOperationsPage.filters")}
              overflowTriggerLabel={t("support.features.supportRequests.ui.supportOperationsPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("support.features.supportRequests.ui.supportOperationsPage.search")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("support.features.supportRequests.ui.supportOperationsPage.search.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("support.features.supportRequests.ui.supportOperationsPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={queueStatusFilterItems()}
                />,
                <NativeSelect
                  key="priority"
                  label={t("support.features.supportRequests.ui.supportOperationsPage.priority")}
                  name="priority"
                  defaultValue={filters.priority}
                  items={queuePriorityFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("support.features.supportRequests.ui.supportOperationsPage.apply.filters")}
                  </Button>
                  <LinkButton href="/support/requests" tone="secondary">
                    {t("support.features.supportRequests.ui.supportOperationsPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href="/support/requests" size="sm" tone="secondary">
                  {t("support.features.supportRequests.ui.supportOperationsPage.clear.filters")}
                </LinkButton>
              ) : null
            }
          />

          <Surface>
            <Cluster>
              <Text size="sm" weight="semibold">
                {t("support.features.supportRequests.ui.supportOperationsPage.queue.count", {
                  count: queue.count,
                  total: queue.total,
                })}
              </Text>
              <RouterForm method="post" spacing="none">
                <HiddenInput type="hidden" name="intent" value="escalate-overdue" />
                <Button type="submit" disabled={Boolean(unavailableMessage)}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.escalate.overdue")}
                </Button>
              </RouterForm>
            </Cluster>
          </Surface>
          <SupportOperationsQueue requests={queue.items} marketplaceOrigin={marketplaceOrigin} />
          {showPagination ? (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              onPageChange={(page) => navigateSupportOperationsQueue(page, pageSize)}
            />
          ) : null}
        </Stack>
      </PageSection>
    </Page>
  );
}
