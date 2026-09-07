import { useMemo } from "react";
import {
  Badge,
  DataTable,
  EmptyState,
  MetricStrip,
  OperationalStatusBanner,
  Pagination,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  OutboundOperationLogItem,
  OutboundOperationLogPage,
  OutboundOperationSummary,
} from "../domain/contracts";

export type OutboundOperationLogPanelProps = Readonly<{
  state:
    | Readonly<{ kind: "loaded"; log: OutboundOperationLogPage; summary: OutboundOperationSummary }>
    | Readonly<{ kind: "read-error" }>;
  page: number;
  onPageChange?: (page: number) => void;
}>;

export function OutboundOperationLogPanel({ state, page, onPageChange }: OutboundOperationLogPanelProps) {
  const columns = useMemo<DataColumn<OutboundOperationLogItem>[]>(
    () => [
      {
        key: "operation",
        header: t("channels.outboundSync.operationLog.column.operation"),
        cell: (row) => row.operationKind,
      },
      {
        key: "listing",
        header: t("channels.outboundSync.operationLog.column.listing"),
        cell: (row) => row.listingId,
      },
      {
        key: "status",
        header: t("channels.outboundSync.operationLog.column.status"),
        cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
      },
      {
        key: "attempts",
        header: t("channels.outboundSync.operationLog.column.attempts"),
        align: "right",
        cell: (row) => String(row.attemptCount),
      },
      {
        key: "latency",
        header: t("channels.outboundSync.operationLog.column.latency"),
        align: "right",
        cell: (row) =>
          row.eventToProviderAckMs === null
            ? t("channels.outboundSync.operationLog.latency.pending")
            : t("channels.outboundSync.operationLog.latency.value", { milliseconds: row.eventToProviderAckMs }),
      },
    ],
    [],
  );

  if (state.kind === "read-error") {
    return (
      <WorkflowModule
        title={t("channels.outboundSync.operationLog.title")}
        description={t("channels.outboundSync.operationLog.description")}
        headingLevel={2}
      >
        <OperationalStatusBanner
          tone="danger"
          title={t("channels.outboundSync.operationLog.error.title")}
          description={t("channels.outboundSync.operationLog.error.description")}
        />
      </WorkflowModule>
    );
  }

  const total = state.summary.completeness.kind === "complete" ? state.summary.completeness.total : 0;
  const totalPages = Math.max(page + (state.log.nextCursor ? 1 : 0), Math.ceil(total / 50), 1);
  return (
    <WorkflowModule
      title={t("channels.outboundSync.operationLog.title")}
      description={t("channels.outboundSync.operationLog.description")}
      headingLevel={2}
      status={<Badge tone={state.summary.failed > 0 || state.summary.blocked > 0 ? "warning" : "success"}>{total}</Badge>}
      data-channels-outbound-operation-log="true"
    >
      <MetricStrip
        items={[
          { label: t("channels.outboundSync.operationLog.metric.total"), value: String(total) },
          { label: t("channels.outboundSync.operationLog.metric.succeeded"), value: String(state.summary.succeeded) },
          { label: t("channels.outboundSync.operationLog.metric.failed"), value: String(state.summary.failed) },
          { label: t("channels.outboundSync.operationLog.metric.blocked"), value: String(state.summary.blocked) },
        ]}
      />
      {state.log.completeness.kind === "bounded-incomplete" || state.summary.completeness.kind === "bounded-incomplete" ? (
        <OperationalStatusBanner
          tone="warning"
          title={t("channels.outboundSync.operationLog.incomplete.title")}
          description={t("channels.outboundSync.operationLog.incomplete.description")}
        />
      ) : null}
      {state.log.items.length === 0 ? (
        <EmptyState
          title={t("channels.outboundSync.operationLog.empty.title")}
          description={t("channels.outboundSync.operationLog.empty.description")}
        />
      ) : (
        <DataTable
          rows={[...state.log.items]}
          columns={columns}
          caption={t("channels.outboundSync.operationLog.title")}
          getRowId={(row) => row.operationId}
          density="compact"
          emptyTitle={t("channels.outboundSync.operationLog.empty.title")}
          emptyDescription={t("channels.outboundSync.operationLog.empty.description")}
        />
      )}
      {totalPages > 1 ? (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={onPageChange}
          previousLabel={t("channels.outboundSync.operationLog.pagination.previous")}
          nextLabel={t("channels.outboundSync.operationLog.pagination.next")}
        />
      ) : null}
    </WorkflowModule>
  );
}

function statusTone(status: OutboundOperationLogItem["status"]): "info" | "warning" | "success" | "danger" {
  switch (status) {
    case "pending":
      return "info";
    case "in-flight":
      return "warning";
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
  }
}
