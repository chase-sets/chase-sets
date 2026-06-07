import { t } from "@chase-sets/localization";
import { useMemo, useState } from "react";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Form,
  Button,
  Select,
  TextInput,
  UiBadge,
  UiEmptyState,
  UiGrid,
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
import type { SupportFlowSummary, SupportRequestListItem } from "./contracts";

type SupportRequestListPageProps = Readonly<{
  buyerRequests: readonly SupportRequestListItem[];
  sellerRequests: readonly SupportRequestListItem[];
  flows: readonly SupportFlowSummary[];
  actionError?: string | null;
  openedSupportRequestId?: string | null;
}>;

function statusTone(status: string) {
  return status === "resolved" || status === "closed"
    ? "success"
    : status === "ready-for-support"
      ? "warning"
      : "secondary";
}

function priorityTone(priority: string) {
  return priority === "urgent" ? "destructive" : "secondary";
}

function formatDateTime(value: string | null) {
  if (!value) {
    return t("support.features.supportRequests.ui.supportRequestListPage.not.applicable");
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
  return t("support.features.supportRequests.ui.supportRequestListPage.checklist.summary", {
    satisfied: satisfied.length,
    required: required.length,
  });
}

function SupportRequestTable({ requests }: Readonly<{ requests: readonly SupportRequestListItem[] }>) {
  if (requests.length === 0) {
    return (
      <UiEmptyState
        title={t("support.features.supportRequests.ui.supportRequestListPage.no.requests")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.no.requests.description")}
      />
    );
  }

  return (
    <UiTable>
      <UiTableHeader>
        <UiTableRow>
          <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.issue")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.order")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.status")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.priority")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.next.deadline")}</UiTableHead>
          <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.checklist")}</UiTableHead>
        </UiTableRow>
      </UiTableHeader>
      <UiTableBody>
        {requests.map((request) => (
          <UiTableRow key={request.support_request_id}>
            <UiTableCell>{request.flow_type}</UiTableCell>
            <UiTableCell>{request.order_id}</UiTableCell>
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

function SupportRequestOpenPanel({ flows }: Readonly<{ flows: readonly SupportFlowSummary[] }>) {
  type OpenedByRole = SupportFlowSummary["openedBy"][number];
  const [openedByRole, setOpenedByRole] = useState<OpenedByRole>("buyer");
  const visibleFlows = useMemo(
    () => flows.filter((flow) => flow.openedBy.includes(openedByRole)),
    [flows, openedByRole],
  );
  const [selectedFlowType, setSelectedFlowType] = useState(visibleFlows[0]?.flowType ?? "");
  const selectedFlow = visibleFlows.find((flow) => flow.flowType === selectedFlowType) ?? visibleFlows[0];
  const flowItems = visibleFlows.map((flow) => ({
    value: flow.flowType,
    label: flow.title,
    description: flow.automationSummary,
  }));

  function changeRole(nextRole: string) {
    const role = nextRole as OpenedByRole;
    const nextFlows = flows.filter((flow) => flow.openedBy.includes(role));
    setOpenedByRole(role);
    setSelectedFlowType(nextFlows[0]?.flowType ?? "");
  }

  return (
    <UiSurface>
      <RouterForm method="post" spacing="none" className="grid gap-4">
        <input type="hidden" name="openedByRole" value={openedByRole} />
        <input type="hidden" name="flowType" value={selectedFlowType} />
        <UiGrid className="md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)]">
          <TextInput
            label={t("support.features.supportRequests.ui.supportRequestListPage.open.order")}
            name="orderId"
            placeholder={t("support.features.supportRequests.ui.supportRequestListPage.open.order.placeholder")}
            required
          />
          <Select
            label={t("support.features.supportRequests.ui.supportRequestListPage.open.role")}
            value={openedByRole}
            onValueChange={changeRole}
            items={[
              {
                value: "buyer",
                label: t("support.features.supportRequests.ui.supportRequestListPage.open.role.buyer"),
              },
              {
                value: "seller",
                label: t("support.features.supportRequests.ui.supportRequestListPage.open.role.seller"),
              },
            ]}
          />
          <Select
            label={t("support.features.supportRequests.ui.supportRequestListPage.open.issue")}
            value={selectedFlowType}
            onValueChange={(nextValue) => setSelectedFlowType(nextValue as typeof selectedFlowType)}
            items={flowItems}
          />
        </UiGrid>
        {selectedFlow ? (
          <div className="grid gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--secondary)] p-4">
            <UiStack>
              <UiInline>
                <UiBadge variant={priorityTone(selectedFlow.priority)}>{selectedFlow.priority}</UiBadge>
                <span className="text-sm font-semibold">{selectedFlow.title}</span>
              </UiInline>
              <p className="m-0 text-sm leading-6 text-[var(--muted-foreground)]">{selectedFlow.automationSummary}</p>
              <UiInline>
                <span className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">
                  {t("support.features.supportRequests.ui.supportRequestListPage.response.window")}
                </span>
                <span className="text-sm">
                  {selectedFlow.sellerResponseHours === null
                    ? t("support.features.supportRequests.ui.supportRequestListPage.support.owned")
                    : t("support.features.supportRequests.ui.supportRequestListPage.hours", {
                        hours: selectedFlow.sellerResponseHours,
                      })}
                </span>
              </UiInline>
            </UiStack>
          </div>
        ) : null}
        <UiInline className="justify-end">
          <Button type="submit">{t("support.features.supportRequests.ui.supportRequestListPage.open.submit")}</Button>
        </UiInline>
      </RouterForm>
    </UiSurface>
  );
}

export function SupportRequestListPage({
  buyerRequests,
  sellerRequests,
  flows,
  actionError,
  openedSupportRequestId,
}: SupportRequestListPageProps) {
  return (
    <UiPage>
      <UiPageHeader
        title={t("support.features.supportRequests.ui.supportRequestListPage.title")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.description")}
      />

      {openedSupportRequestId ? (
        <UiSurface className="border-[var(--success)]">
          <UiInline>
            <span className="text-sm font-semibold">
              {t("support.features.supportRequests.ui.supportRequestListPage.open.success", {
                id: openedSupportRequestId,
              })}
            </span>
          </UiInline>
        </UiSurface>
      ) : null}

      {actionError ? (
        <UiSurface className="border-[var(--destructive)]">
          <UiInline>
            <span className="text-sm font-semibold">{actionError}</span>
          </UiInline>
        </UiSurface>
      ) : null}

      <UiPageSection
        title={t("support.features.supportRequests.ui.supportRequestListPage.open.title")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.open.description")}
      >
        <SupportRequestOpenPanel flows={flows} />
      </UiPageSection>

      <UiPageSection title={t("support.features.supportRequests.ui.supportRequestListPage.buyer.requests")}>
        <SupportRequestTable requests={buyerRequests} />
      </UiPageSection>

      <UiPageSection title={t("support.features.supportRequests.ui.supportRequestListPage.seller.requests")}>
        <SupportRequestTable requests={sellerRequests} />
      </UiPageSection>

      <UiPageSection
        title={t("support.features.supportRequests.ui.supportRequestListPage.available.flows")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.available.flows.description")}
      >
        <UiTable>
          <UiTableHeader>
            <UiTableRow>
              <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.flow")}</UiTableHead>
              <UiTableHead>
                {t("support.features.supportRequests.ui.supportRequestListPage.default.outcome")}
              </UiTableHead>
              <UiTableHead>
                {t("support.features.supportRequests.ui.supportRequestListPage.response.window")}
              </UiTableHead>
            </UiTableRow>
          </UiTableHeader>
          <UiTableBody>
            {flows.map((flow) => (
              <UiTableRow key={flow.flowType}>
                <UiTableCell>{flow.title}</UiTableCell>
                <UiTableCell>{flow.defaultResolution}</UiTableCell>
                <UiTableCell>
                  {flow.sellerResponseHours === null
                    ? t("support.features.supportRequests.ui.supportRequestListPage.support.owned")
                    : t("support.features.supportRequests.ui.supportRequestListPage.hours", {
                        hours: flow.sellerResponseHours,
                      })}
                </UiTableCell>
              </UiTableRow>
            ))}
          </UiTableBody>
        </UiTable>
      </UiPageSection>
    </UiPage>
  );
}
