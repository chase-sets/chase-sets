import { t } from "@chase-sets/localization";
import { Form } from "react-router";
import {
  UiBadge,
  UiButton,
  UiEmptyState,
  UiInline,
  UiPage,
  UiPageHeader,
  UiPageSection,
  UiStack,
  UiSurface,
  UiTable,
  UiTableBody,
  UiTableCell,
  UiTableHead,
  UiTableHeader,
  UiTableRow,
} from "@chase-sets/design-system";
import type { SupportRequestListItem } from "./contracts";

type SupportOperationsPageProps = Readonly<{
  queue: Readonly<{ items: readonly SupportRequestListItem[]; total: number; count: number }>;
  unavailableMessage?: string | null;
  escalationResult?: Readonly<{ escalated: number; skipped: number }> | null;
  actionError?: string | null;
}>;

function statusTone(status: string) {
  return status === "ready-for-support" ? "warning" : status === "escalated" ? "destructive" : "secondary";
}

function priorityTone(priority: string) {
  return priority === "urgent" ? "destructive" : "secondary";
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
      <UiEmptyState
        title={t("support.features.supportRequests.ui.supportOperationsPage.no.requests")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.no.requests.description")}
      />
    );
  }

  return (
    <UiTable>
      <UiTableHeader>
        <UiTableRow>
          <UiTableHead>{t("support.features.supportRequests.ui.supportOperationsPage.issue")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportOperationsPage.order")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportOperationsPage.accounts")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportOperationsPage.status")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportOperationsPage.priority")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportOperationsPage.next.deadline")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportOperationsPage.checklist")}</UiTableHead>
        </UiTableRow>
      </UiTableHeader>
      <UiTableBody>
        {requests.map((request) => (
          <UiTableRow key={request.support_request_id}>
            <UiTableCell>
              <UiStack>
                <span className="font-semibold">{request.flow_type}</span>
                <span className="text-xs text-[var(--muted-foreground)]">{request.support_request_id}</span>
              </UiStack>
            </UiTableCell>
            <UiTableCell>{request.order_id}</UiTableCell>
            <UiTableCell>
              <UiStack>
                <span>{request.buyer_account_id}</span>
                <span className="text-xs text-[var(--muted-foreground)]">{request.seller_account_id}</span>
              </UiStack>
            </UiTableCell>
            <UiTableCell>
              <UiBadge variant={statusTone(request.status)}>{request.status}</UiBadge>
            </UiTableCell>
            <UiTableCell>
              <UiBadge variant={priorityTone(request.priority)}>{request.priority}</UiBadge>
            </UiTableCell>
            <UiTableCell>{formatDateTime(nextDeadline(request))}</UiTableCell>
            <UiTableCell>{checklistSummary(request)}</UiTableCell>
          </UiTableRow>
        ))}
      </UiTableBody>
    </UiTable>
  );
}

export function SupportOperationsPage({
  queue,
  unavailableMessage,
  escalationResult,
  actionError,
}: SupportOperationsPageProps) {
  return (
    <UiPage>
      <UiPageHeader
        title={t("support.features.supportRequests.ui.supportOperationsPage.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.description")}
      />

      {unavailableMessage ? (
        <UiSurface className="border-[var(--warning)]">
          <UiStack>
            <span className="text-sm font-semibold">
              {t("support.features.supportRequests.ui.supportOperationsPage.unavailable")}
            </span>
            <span className="text-sm text-[var(--muted-foreground)]">{unavailableMessage}</span>
          </UiStack>
        </UiSurface>
      ) : null}

      {escalationResult ? (
        <UiSurface className="border-[var(--success)]">
          <span className="text-sm font-semibold">
            {t("support.features.supportRequests.ui.supportOperationsPage.escalation.result", escalationResult)}
          </span>
        </UiSurface>
      ) : null}

      {actionError ? (
        <UiSurface className="border-[var(--destructive)]">
          <span className="text-sm font-semibold">{actionError}</span>
        </UiSurface>
      ) : null}

      <UiPageSection
        title={t("support.features.supportRequests.ui.supportOperationsPage.queue.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.queue.description")}
      >
        <UiSurface>
          <UiInline className="justify-between">
            <span className="text-sm font-semibold">
              {t("support.features.supportRequests.ui.supportOperationsPage.queue.count", {
                count: queue.count,
                total: queue.total,
              })}
            </span>
            <Form method="post">
              <input type="hidden" name="intent" value="escalate-overdue" />
              <UiButton type="submit" disabled={Boolean(unavailableMessage)}>
                {t("support.features.supportRequests.ui.supportOperationsPage.escalate.overdue")}
              </UiButton>
            </Form>
          </UiInline>
        </UiSurface>
        <SupportOperationsQueue requests={queue.items} />
      </UiPageSection>
    </UiPage>
  );
}
