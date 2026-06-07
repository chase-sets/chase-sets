import { t } from "@chase-sets/localization";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Badge,
  Button,
  Cluster,
  DataTable,
  EmptyState,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { SupportRequestDetail, SupportRequestListItem } from "./contracts";

type SupportOperationsPageProps = Readonly<{
  queue: Readonly<{ items: readonly SupportRequestListItem[]; total: number; count: number }>;
  unavailableMessage?: string | null;
  escalationResult?: Readonly<{ escalated: number; skipped: number }> | null;
  actionError?: string | null;
}>;

type SupportTone = "neutral" | "warning" | "danger";

function statusTone(status: string) {
  return (
    status === "ready-for-support" ? "warning" : status === "escalated" ? "danger" : "neutral"
  ) satisfies SupportTone;
}

function priorityTone(priority: string) {
  return (priority === "urgent" ? "danger" : "neutral") satisfies SupportTone;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return t("support.features.supportRequests.ui.supportOperationsPage.not.applicable");
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function nextDeadline(request: SupportRequestListItem) {
  return request.seller_response_due_at ?? request.support_review_due_at;
}

function checklistSummary(request: SupportRequestListItem) {
  const required = request.checklist.filter((item) => item.required);
  const satisfied = required.filter((item) => item.satisfiedAt !== null);
  return t("support.features.supportRequests.ui.supportOperationsPage.checklist.summary", {
    satisfied: satisfied.length,
    required: required.length,
  });
}

function SupportOperationsQueue({ requests }: Readonly<{ requests: readonly SupportRequestListItem[] }>) {
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
          key: "issue",
          header: t("support.features.supportRequests.ui.supportOperationsPage.issue"),
          cell: (request) => (
            <Stack gap={1}>
              <span className="font-semibold">{request.flow_type}</span>
              <span className="text-xs text-secondary">{request.support_request_id}</span>
            </Stack>
          ),
        },
        {
          key: "order",
          header: t("support.features.supportRequests.ui.supportOperationsPage.order"),
          cell: (request) => request.order_id,
        },
        {
          key: "accounts",
          header: t("support.features.supportRequests.ui.supportOperationsPage.accounts"),
          cell: (request) => (
            <Stack gap={1}>
              <span>{request.buyer_account_id}</span>
              <span className="text-xs text-secondary">{request.seller_account_id}</span>
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
          cell: (request) => formatDateTime(nextDeadline(request)),
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
            <LinkButton href={`/operations/support-requests/${request.support_request_id}`} size="sm" tone="secondary">
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
    [t("support.features.supportRequests.ui.supportOperationsPage.issue"), request.flow_type],
    [t("support.features.supportRequests.ui.supportOperationsPage.order"), request.order_id],
    [t("support.features.supportRequests.ui.supportOperationsPage.status"), request.status],
    [t("support.features.supportRequests.ui.supportOperationsPage.priority"), request.priority],
    [
      t("support.features.supportRequests.ui.supportOperationsPage.next.deadline"),
      formatDateTime(nextDeadline(request)),
    ],
  ] as const;
}

export function SupportOperationsDetailPage({ request }: Readonly<{ request: SupportRequestDetail }>) {
  return (
    <Page>
      <PageHeader
        title={t("support.features.supportRequests.ui.supportOperationsPage.detail.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.detail.description", {
          id: request.support_request_id,
        })}
        actions={
          <LinkButton href="/operations/support-requests" tone="secondary">
            {t("support.features.supportRequests.ui.supportOperationsPage.back")}
          </LinkButton>
        }
      />

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.detail.summary")}>
        <Surface>
          <Stack gap={3}>
            {detailRows(request).map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <Text size="sm" weight="semibold">
                  {label}
                </Text>
                <span className="max-w-full break-words text-left text-sm text-secondary [overflow-wrap:anywhere] sm:text-right">
                  {value}
                </span>
              </div>
            ))}
          </Stack>
        </Surface>
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportOperationsPage.accounts")}>
        <Surface>
          <Stack>
            <span className="break-words [overflow-wrap:anywhere]">{request.buyer_account_id}</span>
            <span className="break-words [overflow-wrap:anywhere]">{request.seller_account_id}</span>
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
              cell: (item) => <span className="break-words [overflow-wrap:anywhere]">{item.label}</span>,
            },
            {
              key: "status",
              header: t("support.features.supportRequests.ui.supportOperationsPage.status"),
              cell: (item) => (
                <span className="break-words [overflow-wrap:anywhere]">
                  {item.satisfiedAt ?? t("support.features.supportRequests.ui.supportOperationsPage.not.applicable")}
                </span>
              ),
            },
          ]}
        />
      </PageSection>
    </Page>
  );
}

export function SupportOperationsPage({
  queue,
  unavailableMessage,
  escalationResult,
  actionError,
}: SupportOperationsPageProps) {
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
          <Inline gap={2}>
            <Badge tone="success">{t("support.features.supportRequests.ui.supportOperationsPage.success")}</Badge>
            <Text size="sm" weight="semibold">
              {t("support.features.supportRequests.ui.supportOperationsPage.escalation.result", escalationResult)}
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

      <PageSection
        title={t("support.features.supportRequests.ui.supportOperationsPage.queue.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.queue.description")}
      >
        <Surface>
          <Cluster>
            <Text size="sm" weight="semibold">
              {t("support.features.supportRequests.ui.supportOperationsPage.queue.count", {
                count: queue.count,
                total: queue.total,
              })}
            </Text>
            <RouterForm method="post" spacing="none">
              <input type="hidden" name="intent" value="escalate-overdue" />
              <Button type="submit" disabled={Boolean(unavailableMessage)}>
                {t("support.features.supportRequests.ui.supportOperationsPage.escalate.overdue")}
              </Button>
            </RouterForm>
          </Cluster>
        </Surface>
        <SupportOperationsQueue requests={queue.items} />
      </PageSection>
    </Page>
  );
}
