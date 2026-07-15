import { useNavigate, useSearchParams } from "react-router";
import { t } from "@chase-sets/localization";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  AppliedFilterChips,
  Badge,
  Button,
  Cluster,
  DataTable,
  EmptyState,
  FilterArea,
  Form,
  HiddenInput,
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
  TextInput,
  ToggleGroup,
} from "@chase-sets/design-system";
import type {
  PlatformRemedyProposalInput,
  PlatformRemedyProposalPreview,
  SupportOperationsQueueFilters,
  SupportRequestDetail,
  SupportRequestListItem,
} from "./contracts";
import { EntityDetailDrawer } from "./support-request-detail-drawer";
import {
  nextSupportDeadline,
  SupportDeadlineCountdown,
  SupportOrderMarketplaceLinks,
  supportChecklistSummary,
} from "./support-request-presentation";

type SupportOperationsPageProps = Readonly<{
  queue: Readonly<{ items: readonly SupportRequestListItem[]; total: number; count: number }>;
  filters?: SupportOperationsQueueFilters;
  pagination?: Readonly<{ limit: number; offset: number }>;
  selectedRequest?: SupportRequestDetail | null;
  queueNow?: string;
  unavailableMessage?: string | null;
  drawerUnavailableMessage?: string | null;
  escalationResult?: Readonly<{ escalated: number; skipped: number; capped: boolean; total: number }> | null;
  actionError?: string | null;
  actionResult?: string | null;
  marketplaceOrigin?: string | null;
  actorPermissions?: readonly string[];
  remedyPreview?: PlatformRemedyProposalPreview | null;
  remedyProposalInput?: PlatformRemedyProposalInput | null;
}>;

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

function buildQueueAppliedFilters(filters: SupportOperationsQueueFilters) {
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
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String((page - 1) * pageSize));
  url.searchParams.delete("requestId");
  url.searchParams.delete("action");
  url.searchParams.delete("actionError");
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function queueHref(searchParams: URLSearchParams, requestId?: string) {
  const next = new URLSearchParams(searchParams);
  next.delete("action");
  next.delete("actionError");
  if (requestId) next.set("requestId", requestId);
  else next.delete("requestId");
  const query = next.toString();
  return `/support/requests${query ? `?${query}` : ""}`;
}

function SupportOperationsQueue({
  requests,
  now,
  marketplaceOrigin,
  searchParams,
}: Readonly<{
  requests: readonly SupportRequestListItem[];
  now: string;
  marketplaceOrigin?: string | null;
  searchParams: URLSearchParams;
}>) {
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
          key: "request",
          header: t("support.features.supportRequests.ui.supportOperationsPage.reference"),
          cell: (request) => (
            <Stack gap={1}>
              <Text element="span" weight="semibold">
                {request.display_reference || request.support_request_id}
              </Text>
              <Text element="span" size="xs" tone="secondary">
                {request.flow_type}
              </Text>
            </Stack>
          ),
        },
        {
          key: "order",
          header: t("support.features.supportRequests.ui.supportOperationsPage.order"),
          cell: (request) => (
            <SupportOrderMarketplaceLinks orderId={request.order_id} marketplaceOrigin={marketplaceOrigin} />
          ),
        },
        {
          key: "status",
          header: t("support.features.supportRequests.ui.supportOperationsPage.status"),
          cell: (request) => (
            <Stack gap={1}>
              <Badge tone={request.status === "ready-for-support" ? "warning" : "neutral"}>{request.status}</Badge>
              {request.priority === "urgent" ? <Badge tone="danger">{request.priority}</Badge> : null}
            </Stack>
          ),
        },
        {
          key: "deadline",
          header: t("support.features.supportRequests.ui.supportOperationsPage.next.deadline"),
          cell: (request) => <SupportDeadlineCountdown dueAt={nextSupportDeadline(request)} now={now} />,
        },
        {
          key: "checklist",
          header: t("support.features.supportRequests.ui.supportOperationsPage.checklist"),
          cell: (request) => supportChecklistSummary(request),
        },
        {
          key: "action",
          header: t("support.features.supportRequests.ui.supportOperationsPage.action"),
          align: "right",
          cell: (request) => (
            <LinkButton
              href={queueHref(searchParams, request.support_request_id)}
              size="sm"
              tone="secondary"
              trailingIcon="chevronRight"
            >
              {t("support.features.supportRequests.ui.supportOperationsPage.open")}
            </LinkButton>
          ),
        },
      ]}
    />
  );
}

export function SupportOperationsPage({
  queue,
  filters = { status: "all", priority: "all", search: "" },
  pagination,
  selectedRequest = null,
  queueNow = new Date().toISOString(),
  unavailableMessage,
  drawerUnavailableMessage,
  escalationResult,
  actionError,
  actionResult,
  marketplaceOrigin,
  actorPermissions = [],
  remedyPreview,
  remedyProposalInput,
}: SupportOperationsPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pageSize = pagination?.limit ?? queue.items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(queue.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (queue.total > pageSize || pagination.offset > 0));
  const appliedFilters = buildQueueAppliedFilters(filters);
  const selectedHref = selectedRequest ? queueHref(searchParams, selectedRequest.support_request_id) : null;
  const drawerActionHref =
    selectedRequest && selectedHref
      ? `/support/requests/${selectedRequest.support_request_id}?returnTo=${encodeURIComponent(selectedHref)}`
      : "";

  function selectStatus(values: string[]) {
    const next = new URLSearchParams(searchParams);
    const status = values[0] ?? "all";
    if (status === "all") next.delete("status");
    else next.set("status", status);
    next.set("offset", "0");
    next.delete("requestId");
    next.delete("action");
    next.delete("actionError");
    navigate(`/support/requests?${next.toString()}`);
  }

  return (
    <Page>
      <PageHeader
        title={t("support.features.supportRequests.ui.supportOperationsPage.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.description")}
      />

      {unavailableMessage ? (
        <Surface tone="muted">
          <Stack gap={2}>
            <Badge tone="warning">{t("support.features.supportRequests.ui.supportOperationsPage.unavailable")}</Badge>
            <Text size="sm" tone="secondary">
              {unavailableMessage}
            </Text>
          </Stack>
        </Surface>
      ) : null}

      {drawerUnavailableMessage ? (
        <Surface tone="muted">
          <Inline gap={2}>
            <Badge tone="danger">{t("support.features.supportRequests.ui.supportOperationsPage.error")}</Badge>
            <Text size="sm" weight="semibold">
              {drawerUnavailableMessage}
            </Text>
          </Inline>
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

      <PageSection
        title={t("support.features.supportRequests.ui.supportOperationsPage.queue.title")}
        description={t("support.features.supportRequests.ui.supportOperationsPage.queue.description")}
      >
        <Stack gap={3}>
          <ToggleGroup
            label={t("support.features.supportRequests.ui.supportOperationsPage.status")}
            items={SUPPORT_OPERATIONS_QUEUE_STATUS_FILTERS.map((status) => ({
              value: status,
              label: queueStatusFilterLabel(status),
            }))}
            value={[filters.status]}
            onValueChange={selectStatus}
          />

          <Form method="get" spacing="none">
            {filters.status !== "all" ? <HiddenInput name="status" value={filters.status} /> : null}
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={2}
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
                  key="priority"
                  label={t("support.features.supportRequests.ui.supportOperationsPage.priority")}
                  name="priority"
                  defaultValue={filters.priority}
                  items={SUPPORT_OPERATIONS_QUEUE_PRIORITY_FILTERS.map((priority) => ({
                    value: priority,
                    label: queuePriorityFilterLabel(priority),
                  }))}
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
                <HiddenInput name="intent" value="escalate-overdue" />
                <Button type="submit" disabled={Boolean(unavailableMessage)}>
                  {t("support.features.supportRequests.ui.supportOperationsPage.escalate.overdue")}
                </Button>
              </RouterForm>
            </Cluster>
          </Surface>

          <SupportOperationsQueue
            requests={queue.items}
            now={queueNow}
            marketplaceOrigin={marketplaceOrigin}
            searchParams={searchParams}
          />
          {showPagination ? (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              onPageChange={(page) => navigateSupportOperationsQueue(page, pageSize)}
            />
          ) : null}
        </Stack>
      </PageSection>

      {selectedRequest ? (
        <EntityDetailDrawer
          request={selectedRequest}
          now={queueNow}
          actionHref={drawerActionHref}
          marketplaceOrigin={marketplaceOrigin}
          actionError={actionError}
          actionResult={actionResult}
          actorPermissions={actorPermissions}
          remedyPreview={remedyPreview}
          remedyProposalInput={remedyProposalInput}
          onClose={() => navigate(queueHref(searchParams))}
        />
      ) : null}
    </Page>
  );
}
