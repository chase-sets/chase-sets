import { formatDateTime, t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  DataTable,
  DetailPanel,
  FilterBar,
  Form,
  Grid,
  Inset,
  KeyValueList,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type {
  ReportedContentQueueDetail,
  ReportedContentQueueItem,
  ReportedContentQueueMetrics,
} from "../api/contracts";

type ListResponse<T> = Readonly<{
  items: readonly T[];
  total: number;
  count: number;
}>;

const statusItems = [
  { value: "all", label: t("platformOperations.reportedContent.allStatuses") },
  { value: "needs-review", label: t("platformOperations.reportedContent.status.needsReview") },
  { value: "auto-unlisted", label: t("platformOperations.reportedContent.status.autoUnlisted") },
  { value: "dismissed", label: t("platformOperations.reportedContent.status.dismissed") },
  {
    value: "seller-contact-requested",
    label: t("platformOperations.reportedContent.status.sellerContactRequested"),
  },
  { value: "manually-unlisted", label: t("platformOperations.reportedContent.status.manuallyUnlisted") },
  {
    value: "suspension-escalated",
    label: t("platformOperations.reportedContent.status.suspensionEscalated"),
  },
  { value: "review-withdrawn", label: t("platformOperations.reportedContent.status.reviewWithdrawn") },
  {
    value: "review-feedback-redacted",
    label: t("platformOperations.reportedContent.status.reviewFeedbackRedacted"),
  },
  {
    value: "review-reply-withdrawn",
    label: t("platformOperations.reportedContent.status.reviewReplyWithdrawn"),
  },
];

const targetTypeItems = [
  { value: "all", label: t("platformOperations.reportedContent.allTargets") },
  { value: "listing", label: t("platformOperations.reportedContent.target.listing") },
  { value: "review", label: t("platformOperations.reportedContent.target.review") },
];

function statusLabel(status: string) {
  return statusItems.find((item) => item.value === status)?.label ?? status;
}

function statusTone(status: string) {
  if (status === "dismissed") {
    return "neutral";
  }
  if (
    status === "manually-unlisted" ||
    status === "suspension-escalated" ||
    status === "review-withdrawn" ||
    status === "review-feedback-redacted" ||
    status === "review-reply-withdrawn"
  ) {
    return "danger";
  }
  return status === "auto-unlisted" ? "warning" : "accent";
}

function targetTypeLabel(targetType: string) {
  return targetTypeItems.find((item) => item.value === targetType)?.label ?? targetType;
}

function actionLabel(action: string) {
  switch (action) {
    case "dismiss":
      return t("platformOperations.reportedContent.actionLabel.dismiss");
    case "contact-seller":
      return t("platformOperations.reportedContent.actionLabel.contactSeller");
    case "unlist":
      return t("platformOperations.reportedContent.actionLabel.unlist");
    case "escalate-account-suspension":
      return t("platformOperations.reportedContent.actionLabel.escalate");
    case "withdraw-review":
      return t("platformOperations.reportedContent.actionLabel.withdrawReview");
    case "redact-review-feedback":
      return t("platformOperations.reportedContent.actionLabel.redactReviewFeedback");
    case "withdraw-review-reply":
      return t("platformOperations.reportedContent.actionLabel.withdrawReviewReply");
    default:
      return action;
  }
}

function formatReportDateTime(value: string | null) {
  return value ? formatDateTime(value) : t("platformOperations.reportedContent.notSet");
}

function reasonSummary(item: Pick<ReportedContentQueueItem, "reasons">) {
  return item.reasons.map((reason) => `${reason.reason} (${reason.count})`).join(", ");
}

function marketplaceHref(
  item: Pick<ReportedContentQueueItem, "target_type" | "target_id">,
  marketplaceOrigin?: string | null,
) {
  if (item.target_type !== "listing" || !marketplaceOrigin) {
    return null;
  }

  return new URL(`/account/listings/${item.target_id}`, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
}

export function ReportedContentAdminListPage({
  queue,
  metrics,
  filters,
}: {
  queue: ListResponse<ReportedContentQueueItem>;
  metrics: ReportedContentQueueMetrics;
  filters: Readonly<{ status: string; targetType: string }>;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("platformOperations.reportedContent.eyebrow")}
        title={t("platformOperations.reportedContent.title")}
        description={t("platformOperations.reportedContent.description")}
      />
      <StatGrid columns={{ base: 1, md: 3 }}>
        <Stat label={t("platformOperations.reportedContent.total")} value={metrics.total_count} />
        <Stat label={t("platformOperations.reportedContent.needsReview")} value={metrics.needs_review_count} />
        <Stat label={t("platformOperations.reportedContent.autoUnlisted")} value={metrics.auto_unlisted_count} />
      </StatGrid>
      <PageSection title={t("platformOperations.reportedContent.filters")}>
        <Form spacing="none" method="get">
          <FilterBar sticky={false}>
            <NativeSelect
              label={t("platformOperations.reportedContent.status")}
              name="status"
              defaultValue={filters.status}
              items={statusItems}
            />
            <NativeSelect
              label={t("platformOperations.reportedContent.targetType")}
              name="targetType"
              defaultValue={filters.targetType}
              items={targetTypeItems}
            />
          </FilterBar>
          <Button type="submit" leadingIcon="filter">
            {t("platformOperations.reportedContent.applyFilters")}
          </Button>
        </Form>
      </PageSection>
      <PageSection title={t("platformOperations.reportedContent.queue")}>
        <DataTable<ReportedContentQueueItem>
          columns={[
            {
              key: "status",
              header: t("platformOperations.reportedContent.status"),
              cell: (item) => <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>,
            },
            {
              key: "target",
              header: t("platformOperations.reportedContent.target"),
              cell: (item) => `${targetTypeLabel(item.target_type)} ${item.target_id}`,
            },
            {
              key: "reports",
              header: t("platformOperations.reportedContent.reports"),
              cell: (item) => item.report_count,
            },
            {
              key: "reasons",
              header: t("platformOperations.reportedContent.reasons"),
              cell: reasonSummary,
            },
            {
              key: "last_reported_at",
              header: t("platformOperations.reportedContent.lastReported"),
              cell: (item) => formatReportDateTime(item.last_reported_at),
            },
            {
              key: "action",
              header: t("platformOperations.reportedContent.action"),
              cell: (item) => (
                <LinkButton href={`/support/reported-content/${item.target_type}/${item.target_id}`} size="sm">
                  {t("platformOperations.reportedContent.open")}
                </LinkButton>
              ),
            },
          ]}
          rows={[...queue.items]}
          getRowId={(item) => `${item.target_type}:${item.target_id}`}
          emptyTitle={t("platformOperations.reportedContent.emptyTitle")}
          emptyDescription={t("platformOperations.reportedContent.emptyDescription")}
        />
        <Text tone="secondary" size="sm">
          {t("platformOperations.reportedContent.countSummary", { count: queue.count, total: queue.total })}
        </Text>
      </PageSection>
    </Page>
  );
}

export function ReportedContentAdminDetailPage({
  item,
  marketplaceOrigin,
}: {
  item: ReportedContentQueueDetail;
  marketplaceOrigin?: string | null;
}) {
  const href = marketplaceHref(item, marketplaceOrigin);

  return (
    <Page>
      <PageHeader
        eyebrow={t("platformOperations.reportedContent.eyebrow")}
        title={t("platformOperations.reportedContent.detailTitle", {
          targetType: targetTypeLabel(item.target_type),
          targetId: item.target_id,
        })}
        description={t("platformOperations.reportedContent.detailDescription")}
      />
      <Stack gap={3}>
        <LinkButton href="/support/reported-content" tone="secondary">
          {t("platformOperations.reportedContent.back")}
        </LinkButton>
        {href ? (
          <LinkButton href={href} target="_blank" rel="noreferrer" trailingIcon="externalLink">
            {t("platformOperations.reportedContent.openMarketplaceTarget")}
          </LinkButton>
        ) : null}
      </Stack>
      <Grid columns={{ base: 1, xl: 2 }} gap={4}>
        <DetailPanel title={t("platformOperations.reportedContent.queueItem")}>
          <KeyValueList
            items={[
              { key: t("platformOperations.reportedContent.status"), value: statusLabel(item.status) },
              { key: t("platformOperations.reportedContent.targetType"), value: targetTypeLabel(item.target_type) },
              { key: t("platformOperations.reportedContent.targetId"), value: item.target_id },
              {
                key: t("platformOperations.reportedContent.ownerAccount"),
                value: item.target_owner_account_id ?? t("platformOperations.reportedContent.notSet"),
              },
              { key: t("platformOperations.reportedContent.reports"), value: item.report_count },
              {
                key: t("platformOperations.reportedContent.firstReported"),
                value: formatReportDateTime(item.first_reported_at),
              },
              {
                key: t("platformOperations.reportedContent.lastReported"),
                value: formatReportDateTime(item.last_reported_at),
              },
              {
                key: t("platformOperations.reportedContent.autoUnlistedAt"),
                value: formatReportDateTime(item.auto_unlisted_at),
              },
            ]}
          />
          <Form spacing="md" method="post">
            <Textarea
              name="note"
              label={t("platformOperations.reportedContent.actionNote")}
              rows={3}
              maxLength={1000}
            />
            <Stack direction={{ base: "column", md: "row" }} gap={2}>
              <Button type="submit" name="action" value="dismiss" tone="secondary" leadingIcon="check">
                {t("platformOperations.reportedContent.action.dismiss")}
              </Button>
              <Button type="submit" name="action" value="contact-seller" tone="secondary" leadingIcon="message">
                {t("platformOperations.reportedContent.action.contactSeller")}
              </Button>
              {item.target_type === "listing" ? (
                <Button type="submit" name="action" value="unlist" tone="danger" leadingIcon="warning">
                  {t("platformOperations.reportedContent.action.unlist")}
                </Button>
              ) : null}
              {item.target_type === "review" ? (
                <>
                  <Button type="submit" name="action" value="withdraw-review" tone="danger" leadingIcon="warning">
                    {t("platformOperations.reportedContent.action.withdrawReview")}
                  </Button>
                  <Button
                    type="submit"
                    name="action"
                    value="redact-review-feedback"
                    tone="danger"
                    leadingIcon="warning"
                  >
                    {t("platformOperations.reportedContent.action.redactReviewFeedback")}
                  </Button>
                  <Button type="submit" name="action" value="withdraw-review-reply" tone="danger" leadingIcon="warning">
                    {t("platformOperations.reportedContent.action.withdrawReviewReply")}
                  </Button>
                </>
              ) : null}
              <Button
                type="submit"
                name="action"
                value="escalate-account-suspension"
                tone="danger"
                leadingIcon="shield"
              >
                {t("platformOperations.reportedContent.action.escalate")}
              </Button>
            </Stack>
            <Text size="sm" tone="secondary">
              {t("platformOperations.reportedContent.reviewActionsRequireNote")}
            </Text>
          </Form>
          {item.last_action ? (
            <Text size="sm" tone="secondary">
              {t("platformOperations.reportedContent.lastAction", {
                action: actionLabel(item.last_action),
                timestamp: formatReportDateTime(item.last_action_at),
              })}
            </Text>
          ) : null}
        </DetailPanel>
        <DetailPanel title={t("platformOperations.reportedContent.reportHistory")}>
          <Stack gap={3}>
            {item.reports.map((report) => (
              <Inset key={report.reportId}>
                <Stack gap={2}>
                  <Text weight="semibold">{report.reason}</Text>
                  <Text>{report.details ?? t("platformOperations.reportedContent.noDetails")}</Text>
                  <Text size="sm" tone="secondary">
                    {t("platformOperations.reportedContent.reportAttribution", {
                      reporter: report.reporterAccountId ?? report.reporterKey,
                      timestamp: formatReportDateTime(report.submittedAt),
                    })}
                  </Text>
                </Stack>
              </Inset>
            ))}
          </Stack>
        </DetailPanel>
      </Grid>
    </Page>
  );
}
