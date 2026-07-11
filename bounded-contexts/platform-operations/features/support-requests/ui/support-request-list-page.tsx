import { formatDateTime, t } from "@chase-sets/localization";
import { useMemo, useState } from "react";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  HiddenInput,
  Badge,
  Banner,
  Button,
  Cluster,
  DataTable,
  Grid,
  Inset,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Select,
  Stack,
  Surface,
  Text,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import type { SupportFlowSummary, SupportOrderLookup, SupportRequestListItem } from "./contracts";

type SupportRequestListPageProps = Readonly<{
  buyerRequests: readonly SupportRequestListItem[];
  sellerRequests: readonly SupportRequestListItem[];
  flows: readonly SupportFlowSummary[];
  actionError?: string | null;
  lookupError?: string | null;
  openedSupportRequestId?: string | null;
  supportOrder?: SupportOrderLookup | null;
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
  if (!value) {
    return t("support.features.supportRequests.ui.supportRequestListPage.not.applicable");
  }

  return formatDateTime(value, { preset: "short" });
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

function SupportRequestTable({ requests }: Readonly<{ requests: readonly SupportRequestListItem[] }>) {
  const columns: DataColumn<SupportRequestListItem>[] = [
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
      cell: (flow) => flow.defaultResolution,
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

function SupportRequestOpenPanel({
  flows,
  supportOrder,
}: Readonly<{ flows: readonly SupportFlowSummary[]; supportOrder?: SupportOrderLookup | null }>) {
  type OpenedByRole = SupportFlowSummary["openedBy"][number];
  const [lookupRole, setLookupRole] = useState<OpenedByRole>("buyer");
  const openedByRole = supportOrder?.openedByRole ?? lookupRole;
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
    setLookupRole(role);
    setSelectedFlowType(nextFlows[0]?.flowType ?? "");
  }

  if (!supportOrder) {
    return (
      <Surface>
        <RouterForm method="get" spacing="md">
          <HiddenInput type="hidden" name="role" value={lookupRole} readOnly />
          <Grid columns={{ base: 1, md: 3 }}>
            <TextInput
              label={t("support.features.supportRequests.ui.supportRequestListPage.lookup.order")}
              name="orderId"
              pattern="ord_.+"
              placeholder={t("support.features.supportRequests.ui.supportRequestListPage.open.order.placeholder")}
              required
              title={t("support.features.supportRequests.ui.supportRequestListPage.open.order.hint")}
            />
            <Select
              label={t("support.features.supportRequests.ui.supportRequestListPage.lookup.role")}
              value={lookupRole}
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
          </Grid>
          <Cluster justify="end">
            <Button type="submit">
              {t("support.features.supportRequests.ui.supportRequestListPage.lookup.submit")}
            </Button>
          </Cluster>
        </RouterForm>
      </Surface>
    );
  }

  return (
    <Surface>
      <RouterForm method="post" spacing="md">
        <HiddenInput type="hidden" name="orderId" value={supportOrder.orderId} readOnly />
        <HiddenInput type="hidden" name="openedByRole" value={supportOrder.openedByRole} readOnly />
        <HiddenInput type="hidden" name="flowType" value={selectedFlowType} readOnly />
        <Inset>
          <Stack>
            <Inline>
              <Badge tone="neutral">{supportOrder.openedByRole}</Badge>
              <Text element="span" size="sm" weight="semibold">
                {supportOrder.orderId}
              </Text>
            </Inline>
            <Inline>
              <Text element="span" size="xs" tone="secondary" weight="semibold">
                {t("support.features.supportRequests.ui.supportRequestListPage.lookup.status")}
              </Text>
              <Text element="span" size="sm">
                {supportOrder.status}
              </Text>
              <Text element="span" size="xs" tone="secondary" weight="semibold">
                {t("support.features.supportRequests.ui.supportRequestListPage.lookup.total")}
              </Text>
              <Text element="span" size="sm">
                {supportOrder.totalAmount}
              </Text>
            </Inline>
          </Stack>
        </Inset>
        <Grid columns={{ base: 1, md: 2 }}>
          <Select
            label={t("support.features.supportRequests.ui.supportRequestListPage.open.issue")}
            value={selectedFlowType}
            onValueChange={(nextValue) => setSelectedFlowType(nextValue as typeof selectedFlowType)}
            items={flowItems}
          />
        </Grid>
        {selectedFlow ? (
          <Inset>
            <Stack>
              <Inline>
                <Badge tone={priorityTone(selectedFlow.priority)}>{selectedFlow.priority}</Badge>
                <Text element="span" size="sm" weight="semibold">
                  {selectedFlow.title}
                </Text>
              </Inline>
              <Text size="sm" tone="secondary">
                {selectedFlow.automationSummary}
              </Text>
              <Inline>
                <Text element="span" size="xs" tone="secondary" weight="semibold">
                  {t("support.features.supportRequests.ui.supportRequestListPage.response.window")}
                </Text>
                <Text element="span" size="sm">
                  {selectedFlow.sellerResponseHours === null
                    ? t("support.features.supportRequests.ui.supportRequestListPage.support.owned")
                    : t("support.features.supportRequests.ui.supportRequestListPage.hours", {
                        hours: selectedFlow.sellerResponseHours,
                      })}
                </Text>
              </Inline>
              <Stack gap={1}>
                <Text element="span" size="xs" tone="secondary" weight="semibold">
                  {t("support.features.supportRequests.ui.supportRequestListPage.checklist")}
                </Text>
                {selectedFlow.checklist.map((item) => (
                  <Text key={item.key} size="sm" tone="secondary">
                    {item.label}
                  </Text>
                ))}
              </Stack>
            </Stack>
          </Inset>
        ) : null}
        <Cluster justify="end">
          <LinkButton href="/account/support" tone="secondary">
            {t("support.features.supportRequests.ui.supportRequestListPage.lookup.change")}
          </LinkButton>
          <Button type="submit">{t("support.features.supportRequests.ui.supportRequestListPage.open.submit")}</Button>
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
            id: openedSupportRequestId,
          })}
        />
      ) : null}

      {actionError ? <Banner tone="danger" title={actionError} /> : null}
      {lookupError ? <Banner tone="danger" title={lookupError} /> : null}

      <PageSection
        title={t("support.features.supportRequests.ui.supportRequestListPage.open.title")}
        description={t("support.features.supportRequests.ui.supportRequestListPage.open.description")}
      >
        <SupportRequestOpenPanel flows={flows} supportOrder={supportOrder} />
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportRequestListPage.buyer.requests")}>
        <SupportRequestTable requests={buyerRequests} />
      </PageSection>

      <PageSection title={t("support.features.supportRequests.ui.supportRequestListPage.seller.requests")}>
        <SupportRequestTable requests={sellerRequests} />
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
