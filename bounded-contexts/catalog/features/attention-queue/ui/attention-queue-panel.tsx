import { useMemo } from "react";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  HiddenInput,
  KeyValueList,
  MetricStrip,
  SideSheet,
  TextInput,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { CATALOG_ATTENTION_DEFER_INTENT, CATALOG_ATTENTION_DISMISS_INTENT } from "../read-model/attention-intents";
import type {
  CatalogAttentionItem,
  CatalogAttentionResolution,
  CatalogAttentionSeverity,
} from "../read-model/attention-item";
import type { CatalogAttentionQueueReadModel } from "../api/contracts";

// The attention queue — the unified "needs-you" inbox rendered at the top of the
// Catalog home. It reads only design-system components; every resolution acts on
// the daily surface (park/defer, or inline accept/reject for alias candidates) so
// acting on an item never navigates to a different surface. When the queue is
// empty the zero-state states the system is running itself.
export type CatalogAttentionQueuePanelProps = Readonly<{
  readModel: CatalogAttentionQueueReadModel;
  // Route the resolution forms POST to (the daily import-to-promotion action).
  actionHref: string;
  // Whether the operator may park / resolve items (catalog.manage).
  canManage?: boolean;
}>;

export function CatalogAttentionQueuePanel({
  readModel,
  actionHref,
  canManage = true,
}: CatalogAttentionQueuePanelProps) {
  const columns = useMemo<DataColumn<CatalogAttentionItem>[]>(
    () => [
      {
        key: "item",
        header: t("catalog.features.attentionQueue.table.item"),
        cell: (row) => (
          <WorkbenchDataCell
            title={t(row.titleKey, row.titleParams)}
            truncateTitle
            description={t(row.detailKey, row.detailParams)}
            badges={
              <WorkbenchActionRow>
                <Badge tone={severityTone(row.severity)}>{severityLabel(row.severity)}</Badge>
                <Badge tone="neutral">{kindLabel(row.kind)}</Badge>
              </WorkbenchActionRow>
            }
          />
        ),
      },
      {
        key: "scope",
        header: t("catalog.features.attentionQueue.table.scope"),
        mobileLabel: t("catalog.features.attentionQueue.table.scope"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <WorkbenchText size="sm">
              {row.providerKey ?? t("catalog.features.attentionQueue.scope.platform")}
            </WorkbenchText>
            {row.unitKey ? (
              <WorkbenchText size="xs" tone="secondary">
                {row.unitKey}
              </WorkbenchText>
            ) : null}
          </WorkbenchStack>
        ),
      },
      {
        key: "actions",
        header: t("catalog.features.attentionQueue.table.actions"),
        mobileLabel: t("catalog.features.attentionQueue.table.actions"),
        align: "right",
        cell: (row) => (
          <WorkbenchActionRow>
            {row.resolution.mode === "command" ? (
              <ResolutionCommandButton
                resolution={row.resolution}
                actionHref={actionHref}
                tone="primary"
                disabled={!canManage}
              />
            ) : null}
            {row.secondaryResolutions.map((resolution) => (
              <ResolutionCommandButton
                key={resolution.intent}
                resolution={resolution}
                actionHref={actionHref}
                tone="secondary"
                disabled={!canManage}
              />
            ))}
            <AttentionItemDrawer item={row} actionHref={actionHref} canManage={canManage} />
          </WorkbenchActionRow>
        ),
      },
    ],
    [actionHref, canManage],
  );

  return (
    <WorkflowModule
      title={t("catalog.features.attentionQueue.title")}
      description={t("catalog.features.attentionQueue.description")}
      status={
        <Badge tone={readModel.counts.total > 0 ? statusTone(readModel) : "success"}>
          {t("catalog.features.attentionQueue.status.count", { count: readModel.counts.total })}
        </Badge>
      }
      headingLevel={2}
      density="compact"
      data-catalog-attention-queue="true"
    >
      <MetricStrip
        items={[
          {
            label: t("catalog.features.attentionQueue.metric.critical"),
            value: String(readModel.counts.bySeverity.critical),
            trend: t("catalog.features.attentionQueue.metric.critical.trend"),
          },
          {
            label: t("catalog.features.attentionQueue.metric.warning"),
            value: String(readModel.counts.bySeverity.warning),
            trend: t("catalog.features.attentionQueue.metric.warning.trend"),
          },
          {
            label: t("catalog.features.attentionQueue.metric.info"),
            value: String(readModel.counts.bySeverity.info),
            trend: t("catalog.features.attentionQueue.metric.info.trend"),
          },
          {
            label: t("catalog.features.attentionQueue.metric.freshness"),
            value: t("catalog.features.attentionQueue.metric.freshness.value", {
              generatedAt: readModel.freshness.generatedAt,
            }),
            trend: t("catalog.features.attentionQueue.metric.freshness.trend"),
          },
        ]}
      />

      {readModel.empty ? (
        <EmptyState
          title={t("catalog.features.attentionQueue.empty.title")}
          description={t("catalog.features.attentionQueue.empty.description")}
        />
      ) : (
        <DataTable
          rows={[...readModel.items]}
          columns={columns}
          caption={t("catalog.features.attentionQueue.title")}
          getRowId={(row) => row.itemKey}
          density="compact"
          emptyTitle={t("catalog.features.attentionQueue.empty.title")}
          emptyDescription={t("catalog.features.attentionQueue.empty.description")}
        />
      )}
    </WorkflowModule>
  );
}

// A one-click resolution that POSTs a daily-surface intent (e.g. alias accept)
// and stays on the daily route. Reason-requiring resolutions carry a default
// reason so the single-click action remains valid without a separate page.
function ResolutionCommandButton({
  resolution,
  actionHref,
  tone,
  disabled,
}: {
  resolution: CatalogAttentionResolution;
  actionHref: string;
  tone: "primary" | "secondary";
  disabled: boolean;
}) {
  const label = t(resolution.labelKey);
  return (
    <WorkbenchForm variant="button" method="post" action={actionHref} data-attention-resolution={resolution.intent}>
      <HiddenInput name="_intent" value={resolution.intent} />
      {Object.entries(resolution.fields).map(([name, value]) => (
        <HiddenInput key={name} name={name} value={value} />
      ))}
      {resolution.requiresReason ? <HiddenInput name="reason" value={label} /> : null}
      <Button type="submit" size="sm" tone={tone} disabled={disabled} aria-label={label}>
        {label}
      </Button>
    </WorkbenchForm>
  );
}

// The inline drawer for an item: its evidence plus the universal park controls
// (dismiss / defer with a reason). Opening and acting stays on the daily surface.
function AttentionItemDrawer({
  item,
  actionHref,
  canManage,
}: {
  item: CatalogAttentionItem;
  actionHref: string;
  canManage: boolean;
}) {
  const evidence = [
    { key: t("catalog.features.attentionQueue.drawer.kind"), value: kindLabel(item.kind) },
    { key: t("catalog.features.attentionQueue.drawer.severity"), value: severityLabel(item.severity) },
    { key: t("catalog.features.attentionQueue.drawer.observedAt"), value: item.observedAt },
    ...(item.providerKey
      ? [{ key: t("catalog.features.attentionQueue.drawer.provider"), value: item.providerKey }]
      : []),
    ...(item.unitKey ? [{ key: t("catalog.features.attentionQueue.drawer.unit"), value: item.unitKey }] : []),
    ...Object.entries(item.resolution.fields).map(([key, value]) => ({ key, value })),
  ];

  return (
    <SideSheet
      title={t(item.titleKey, item.titleParams)}
      description={t("catalog.features.attentionQueue.drawer.description")}
      closeLabel={t("catalog.features.attentionQueue.drawer.close")}
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t(item.resolution.labelKey)}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList items={evidence} />

        <WorkbenchForm variant="inline" method="post" action={actionHref} data-attention-park="dismiss">
          <HiddenInput name="_intent" value={CATALOG_ATTENTION_DISMISS_INTENT} />
          <HiddenInput name="itemKey" value={item.itemKey} />
          <HiddenInput name="kind" value={item.kind} />
          <TextInput
            label={t("catalog.features.attentionQueue.park.reason")}
            name="reason"
            required
            disabled={!canManage}
          />
          <Button type="submit" size="sm" tone="secondary" disabled={!canManage}>
            {t("catalog.features.attentionQueue.action.dismiss")}
          </Button>
        </WorkbenchForm>

        <WorkbenchForm variant="inline" method="post" action={actionHref} data-attention-park="defer">
          <HiddenInput name="_intent" value={CATALOG_ATTENTION_DEFER_INTENT} />
          <HiddenInput name="itemKey" value={item.itemKey} />
          <HiddenInput name="kind" value={item.kind} />
          <HiddenInput name="deferHours" value="24" />
          <TextInput
            label={t("catalog.features.attentionQueue.park.reason")}
            name="reason"
            required
            disabled={!canManage}
          />
          <Button type="submit" size="sm" tone="secondary" disabled={!canManage}>
            {t("catalog.features.attentionQueue.action.defer")}
          </Button>
        </WorkbenchForm>
      </WorkbenchStack>
    </SideSheet>
  );
}

function statusTone(readModel: CatalogAttentionQueueReadModel): "danger" | "warning" | "info" {
  if (readModel.counts.bySeverity.critical > 0) {
    return "danger";
  }
  if (readModel.counts.bySeverity.warning > 0) {
    return "warning";
  }
  return "info";
}

function severityTone(severity: CatalogAttentionSeverity): "danger" | "warning" | "info" {
  switch (severity) {
    case "critical":
      return "danger";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

function severityLabel(severity: CatalogAttentionSeverity): string {
  switch (severity) {
    case "critical":
      return t("catalog.features.attentionQueue.severity.critical");
    case "warning":
      return t("catalog.features.attentionQueue.severity.warning");
    case "info":
      return t("catalog.features.attentionQueue.severity.info");
  }
}

function kindLabel(kind: CatalogAttentionItem["kind"]): string {
  switch (kind) {
    case "unmapped-scope":
      return t("catalog.features.attentionQueue.kind.unmappedScope");
    case "merge-conflict":
      return t("catalog.features.attentionQueue.kind.mergeConflict");
    case "provider-health":
      return t("catalog.features.attentionQueue.kind.providerHealth");
    case "import-job":
      return t("catalog.features.attentionQueue.kind.importJob");
    case "alias-candidate":
      return t("catalog.features.attentionQueue.kind.aliasCandidate");
    case "stale-scope-sync":
      return t("catalog.features.attentionQueue.kind.staleScopeSync");
  }
}
