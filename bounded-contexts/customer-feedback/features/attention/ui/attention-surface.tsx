import { formatDateTime, t } from "@chase-sets/localization";
import {
  Badge,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stat,
  StatGrid,
  Text,
} from "@chase-sets/design-system";
import type { FeedbackAttentionItem } from "../domain";
import { feedbackCaseSlaState } from "../domain";

export type FeedbackAttentionMetrics = Readonly<{
  activeCount: number;
  overdueCount: number;
  medianTimeToTriageMs: number | null;
  deliveryFailures: number;
}>;

function priorityTone(priority: FeedbackAttentionItem["priority"]) {
  return priority === "urgent" ? "danger" : priority === "high" ? "warning" : "neutral";
}

export function FeedbackAttentionSurface({
  items,
  metrics,
  now = new Date().toISOString(),
}: Readonly<{
  items: readonly FeedbackAttentionItem[];
  metrics: FeedbackAttentionMetrics;
  now?: string;
}>) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("customer-feedback.attention.title")}
        title={t("customer-feedback.attention.title")}
        description={t("customer-feedback.attention.description")}
      />
      <StatGrid columns={{ base: 1, md: 4 }}>
        <Stat label={t("customer-feedback.attention.metrics.active")} value={metrics.activeCount} />
        <Stat label={t("customer-feedback.attention.metrics.overdue")} value={metrics.overdueCount} />
        <Stat
          label={t("customer-feedback.attention.metrics.timeToTriage")}
          value={formatDuration(metrics.medianTimeToTriageMs)}
        />
        <Stat label={t("customer-feedback.attention.metrics.deliveryFailures")} value={metrics.deliveryFailures} />
      </StatGrid>
      <PageSection title={t("customer-feedback.attention.queue")}>
        <DataTable
          rows={[...items]}
          getRowId={(item) => item.attentionId}
          columns={[
            {
              key: "case",
              header: t("customer-feedback.attention.case"),
              cell: (item) => (
                <LinkButton href="/support/customer-feedback/attention" tone="ghost" size="sm">
                  {item.caseId}
                </LinkButton>
              ),
            },
            {
              key: "priority",
              header: t("customer-feedback.attention.priority"),
              cell: (item) => <Badge tone={priorityTone(item.priority)}>{item.priority}</Badge>,
            },
            {
              key: "rating",
              header: t("customer-feedback.attention.rating"),
              cell: (item) => <Text>{item.rating}/5</Text>,
            },
            {
              key: "sla",
              header: t("customer-feedback.attention.sla"),
              cell: (item) => {
                const sla = feedbackCaseSlaState(
                  {
                    openedAt: item.openedAt,
                    priority: item.priority,
                    triagedAt: item.triagedAt,
                    dueAt: item.dueAt,
                    status: item.closedAt ? "closed" : "new",
                    closedAt: item.closedAt,
                  },
                  now,
                );
                return (
                  <Badge tone={sla.overdue ? "danger" : "neutral"}>
                    {sla.overdue
                      ? t("customer-feedback.attention.sla.breached")
                      : formatDateTime(sla.effectiveDueAt ?? sla.triageDueAt)}
                  </Badge>
                );
              },
            },
            {
              key: "owner",
              header: t("customer-feedback.attention.owner"),
              cell: (item) => <Text>{item.ownerId ?? t("customer-feedback.attention.unassigned")}</Text>,
            },
          ]}
          emptyTitle={t("customer-feedback.attention.empty")}
          emptyDescription={t("customer-feedback.attention.description")}
        />
      </PageSection>
    </Page>
  );
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return t("customer-feedback.attention.notAvailable");
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return t("customer-feedback.attention.duration.minutes", { count: minutes });
  return t("customer-feedback.attention.duration.hours", { count: Math.round(minutes / 60) });
}
