import { t } from "@chase-sets/localization";
import {
  UiBadge,
  UiEmptyState,
  UiPage,
  UiPageHeader,
  UiPageSection,
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
}>;

function statusTone(status: string) {
  return status === "resolved" || status === "closed"
    ? "success"
    : status === "ready-for-support"
      ? "warning"
      : "secondary";
}

function SupportRequestTable({
  requests,
}: Readonly<{ requests: readonly SupportRequestListItem[] }>) {
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
          <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.updated")}</UiTableHead>
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
            <UiTableCell>{request.updated_at}</UiTableCell>
          </UiTableRow>
        ))}
      </UiTableBody>
    </UiTable>
  );
}

export function SupportRequestListPage({
  buyerRequests,
  sellerRequests,
  flows,
}: SupportRequestListPageProps) {
  return (
    <UiPage>
      <UiPageHeader
        title={t("support.features.supportRequests.ui.supportRequestListPage.title")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.description")}
      />

      <UiPageSection
        title={t("support.features.supportRequests.ui.supportRequestListPage.buyer.requests")}
      >
        <SupportRequestTable requests={buyerRequests} />
      </UiPageSection>

      <UiPageSection
        title={t("support.features.supportRequests.ui.supportRequestListPage.seller.requests")}
      >
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
              <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.default.outcome")}</UiTableHead>
              <UiTableHead>{t("support.features.supportRequests.ui.supportRequestListPage.response.window")}</UiTableHead>
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
