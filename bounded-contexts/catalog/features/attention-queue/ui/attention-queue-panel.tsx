import { useMemo } from "react";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  HiddenInput,
  KeyValueList,
  LinkButton,
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
import { defaultLocale, t } from "@chase-sets/localization";
import { CATALOG_ATTENTION_DEFER_INTENT, CATALOG_ATTENTION_DISMISS_INTENT } from "../read-model/attention-intents";
import {
  CATALOG_ATTENTION_ITEM_KINDS,
  type CatalogAttentionItem,
  type CatalogAttentionItemKind,
  type CatalogAttentionResolution,
  type CatalogAttentionSeverity,
  type CatalogAttentionTotalKind,
} from "../read-model/attention-item";
import type {
  CatalogAttentionKindCoverage,
  CatalogAttentionQueueNavigation,
  CatalogAttentionQueueReadModel,
} from "../api/contracts";
import { catalogAttentionQueuePageHref } from "./attention-queue-navigation";

// The attention queue — the unified "needs-you" inbox rendered at the top of the
// Catalog home. It reads only design-system components; every resolution acts on
// the daily surface (park/defer, or inline accept/reject for alias candidates) so
// acting on an item never navigates to a different surface. Counts cover each
// source's whole eligible cohort, labelled "at least" when a source could not be
// fully checked; only a complete zero shows the "running itself" empty state.
export type CatalogAttentionQueuePanelProps = Readonly<{
  readModel: CatalogAttentionQueueReadModel;
  // Route the resolution forms POST to (the daily import-to-promotion action).
  actionHref: string;
  // Whether the operator may park / resolve items (catalog.manage).
  canManage?: boolean;
  // Where page links point. A mount without it shows the window without page links.
  navigation?: CatalogAttentionQueueNavigation;
}>;

const countFormat = new Intl.NumberFormat(defaultLocale);

function formatCount(count: number): string {
  return countFormat.format(count);
}

export function CatalogAttentionQueuePanel({
  readModel,
  actionHref,
  canManage = true,
  navigation,
}: CatalogAttentionQueuePanelProps) {
  // Zero counted items while a source could not be fully checked: unknown work,
  // never the empty state.
  const incompleteZero = readModel.counts.total === 0 && readModel.countBasis.total === "lower-bound";
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
                disabled={!canManage || row.resolution.unavailable === true}
              />
            ) : null}
            {row.secondaryResolutions.map((resolution) => (
              <ResolutionCommandButton
                key={resolution.intent}
                resolution={resolution}
                actionHref={actionHref}
                tone="secondary"
                disabled={!canManage || resolution.unavailable === true}
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
        <Badge tone={readModel.empty ? "success" : incompleteZero ? "warning" : statusTone(readModel)}>
          {readModel.countBasis.total === "lower-bound"
            ? t("catalog.features.attentionQueue.status.countAtLeast", { count: formatCount(readModel.counts.total) })
            : t("catalog.features.attentionQueue.status.count", { count: formatCount(readModel.counts.total) })}
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
            value: countValue(readModel.counts.bySeverity.critical, readModel.countBasis.bySeverity.critical),
            trend: t("catalog.features.attentionQueue.metric.critical.trend"),
          },
          {
            label: t("catalog.features.attentionQueue.metric.warning"),
            value: countValue(readModel.counts.bySeverity.warning, readModel.countBasis.bySeverity.warning),
            trend: t("catalog.features.attentionQueue.metric.warning.trend"),
          },
          {
            label: t("catalog.features.attentionQueue.metric.info"),
            value: countValue(readModel.counts.bySeverity.info, readModel.countBasis.bySeverity.info),
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
      ) : incompleteZero ? (
        <EmptyState
          data-attention-incomplete="true"
          title={t("catalog.features.attentionQueue.coverage.importJobsIncomplete")}
          description={t("catalog.features.attentionQueue.incomplete.description")}
        />
      ) : (
        <>
          <AttentionQueueCoverage readModel={readModel} navigation={navigation} />
          <DataTable
            rows={[...readModel.items]}
            columns={columns}
            caption={t("catalog.features.attentionQueue.title")}
            getRowId={(row) => row.itemKey}
            density="compact"
            emptyTitle={t("catalog.features.attentionQueue.page.emptyTitle")}
            emptyDescription={t("catalog.features.attentionQueue.page.emptyDescription")}
          />
        </>
      )}
    </WorkflowModule>
  );
}

// How much of each kind the window shows, with page links when the mount allows
// them. Kinds with no counted work are omitted unless they are being paged or
// could not be fully checked.
function AttentionQueueCoverage({
  readModel,
  navigation,
}: {
  readModel: CatalogAttentionQueueReadModel;
  navigation: CatalogAttentionQueueNavigation | undefined;
}) {
  const kinds = CATALOG_ATTENTION_ITEM_KINDS.filter((kind) => {
    const coverage = readModel.coverage[kind];
    return coverage.total > 0 || coverage.totalKind === "lower-bound" || readModel.window.kind === kind;
  });

  return (
    <WorkbenchStack gap="sm" data-attention-coverage="true">
      <KeyValueList
        layout="split"
        density="compact"
        items={kinds.map((kind) => ({
          key: kindLabel(kind),
          value: <AttentionKindCoverage kind={kind} coverage={readModel.coverage[kind]} navigation={navigation} />,
        }))}
      />
      {navigation && readModel.window.kind ? (
        <WorkbenchActionRow align="start">
          <LinkButton
            href={catalogAttentionQueuePageHref(navigation, { kind: null, offset: 0 })}
            size="sm"
            tone="secondary"
            data-attention-page="summary"
          >
            {t("catalog.features.attentionQueue.page.allKinds")}
          </LinkButton>
        </WorkbenchActionRow>
      ) : null}
    </WorkbenchStack>
  );
}

function AttentionKindCoverage({
  kind,
  coverage,
  navigation,
}: {
  kind: CatalogAttentionItemKind;
  coverage: CatalogAttentionKindCoverage;
  navigation: CatalogAttentionQueueNavigation | undefined;
}) {
  const total =
    coverage.totalKind === "lower-bound"
      ? t("catalog.features.attentionQueue.coverage.totalAtLeast", { count: formatCount(coverage.total) })
      : formatCount(coverage.total);
  // A kind with nothing counted but an unchecked tail shows only the incomplete note.
  const label =
    coverage.returned === 0
      ? coverage.total === 0 && coverage.totalKind === "lower-bound"
        ? null
        : t("catalog.features.attentionQueue.coverage.noneShown", { total })
      : coverage.offset === 0
        ? t("catalog.features.attentionQueue.coverage.showing", { returned: formatCount(coverage.returned), total })
        : t("catalog.features.attentionQueue.coverage.showingRange", {
            from: formatCount(coverage.offset + 1),
            to: formatCount(coverage.offset + coverage.returned),
            total,
          });
  const previousOffset =
    coverage.limit > 0 && coverage.offset > 0 ? Math.max(0, coverage.offset - coverage.limit) : null;
  // A zero-length window belongs to a kind another page is not showing; its link opens that kind.
  const opensKind = coverage.limit === 0;

  return (
    <WorkbenchActionRow align="start" data-attention-coverage-kind={kind}>
      {label ? <WorkbenchText size="sm">{label}</WorkbenchText> : null}
      {coverage.totalKind === "lower-bound" ? (
        <WorkbenchText size="sm" tone="secondary" data-attention-incomplete="true">
          {t("catalog.features.attentionQueue.coverage.importJobsIncomplete")}
        </WorkbenchText>
      ) : null}
      {navigation && previousOffset !== null ? (
        <LinkButton
          href={catalogAttentionQueuePageHref(navigation, { kind, offset: previousOffset })}
          size="sm"
          tone="secondary"
          data-attention-page="previous"
        >
          {t("catalog.features.attentionQueue.page.previous")}
        </LinkButton>
      ) : null}
      {navigation && coverage.nextOffset !== null ? (
        <LinkButton
          href={catalogAttentionQueuePageHref(navigation, { kind, offset: coverage.nextOffset })}
          size="sm"
          tone="secondary"
          data-attention-page={opensKind ? "show" : "next"}
        >
          {opensKind ? t("catalog.features.attentionQueue.page.show") : t("catalog.features.attentionQueue.page.next")}
        </LinkButton>
      ) : null}
    </WorkbenchActionRow>
  );
}

function countValue(count: number, totalKind: CatalogAttentionTotalKind): string {
  return totalKind === "lower-bound"
    ? t("catalog.features.attentionQueue.count.atLeast", { count: formatCount(count) })
    : formatCount(count);
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

        {item.resolution.href ? (
          <LinkButton href={item.resolution.href} size="sm" tone="secondary" data-attention-destination="true">
            {t("catalog.features.attentionQueue.action.openDestination")}
          </LinkButton>
        ) : item.resolution.unavailable || item.resolution.mode === "drawer" ? (
          <WorkbenchText size="sm" tone="secondary" data-attention-destination="unavailable">
            {t("catalog.features.attentionQueue.resolution.unavailable")}
          </WorkbenchText>
        ) : null}

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
