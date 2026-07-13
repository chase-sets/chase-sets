import type { ReactElement } from "react";
import {
  Badge,
  Button,
  EmptyState,
  HiddenInput,
  WorkbenchActionRow,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";

// Serializable schedule row the providers surface loader hands the panel.
// Mirrors ProviderRefreshScheduleRecord from the API read model.
export type ProviderRefreshSchedulePanelItem = Readonly<{
  providerKey: string;
  scheduleEnabled: boolean;
  manualOnly: boolean;
  creditAware: boolean;
  intervalMs: number;
  paused: boolean;
  pausedBy: string | null;
  nextRunAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunStatus: "succeeded" | "failed" | "skipped-no-targets" | null;
  lastRunError: string | null;
}>;

export const PROVIDER_REFRESH_INTENTS = {
  pause: "pause-provider-refresh",
  resume: "resume-provider-refresh",
  run: "run-provider-refresh",
} as const;

// Scheduled source-option refresh schedule: visible and pausable from the
// providers surface. Each row shows the provider's config-driven
// cadence, the pause state, and the last/next run; the pause, resume, and
// run-now forms post back to the providers surface action.
export function ProviderRefreshSchedulePanel({
  items,
  actionHref,
  canManageCatalog,
}: Readonly<{
  items: readonly ProviderRefreshSchedulePanelItem[];
  actionHref: string;
  canManageCatalog: boolean;
}>): ReactElement {
  return (
    <WorkbenchDetailPanel data-catalog-provider-refresh-schedule="panel">
      <WorkbenchStack gap="sm">
        <WorkbenchText tone="foreground" weight="semibold">
          {t("catalog.features.providerScopeDiscovery.ui.schedulePanel.title")}
        </WorkbenchText>
        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.providerScopeDiscovery.ui.schedulePanel.description")}
        </WorkbenchText>
        {items.length === 0 ? (
          <EmptyState title={t("catalog.features.providerScopeDiscovery.ui.schedulePanel.empty")} />
        ) : (
          items.map((item) => (
            <ScheduleRow
              key={item.providerKey}
              item={item}
              actionHref={actionHref}
              canManageCatalog={canManageCatalog}
            />
          ))
        )}
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

function ScheduleRow({
  item,
  actionHref,
  canManageCatalog,
}: Readonly<{
  item: ProviderRefreshSchedulePanelItem;
  actionHref: string;
  canManageCatalog: boolean;
}>): ReactElement {
  const scheduledActive = item.scheduleEnabled && !item.manualOnly && !item.paused;

  return (
    <WorkbenchStack gap="sm" data-catalog-provider-refresh-schedule-row={item.providerKey}>
      <WorkbenchActionRow>
        <WorkbenchText tone="foreground" weight="semibold">
          {item.providerKey}
        </WorkbenchText>
        <Badge tone={scheduleBadgeTone(item)}>{scheduleBadgeLabel(item)}</Badge>
        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.providerScopeDiscovery.ui.schedulePanel.cadence.hours", {
            hours: String(Math.round(item.intervalMs / 3_600_000)),
          })}
        </WorkbenchText>
      </WorkbenchActionRow>
      <WorkbenchActionRow>
        <WorkbenchText size="xs" tone="secondary">
          {`${t("catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run")}: ${lastRunLabel(item)}`}
        </WorkbenchText>
        {item.lastRunStatus === "failed" ? (
          <Badge tone="danger">{t("catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.failed")}</Badge>
        ) : null}
      </WorkbenchActionRow>
      {scheduledActive && item.nextRunAt ? (
        <WorkbenchText size="xs" tone="secondary">
          {`${t("catalog.features.providerScopeDiscovery.ui.schedulePanel.next.run")}: ${formatTimestamp(item.nextRunAt)}`}
        </WorkbenchText>
      ) : null}
      {canManageCatalog ? (
        <WorkbenchActionRow>
          {item.manualOnly || !item.scheduleEnabled ? null : (
            <WorkbenchForm variant="button" method="post" action={actionHref}>
              <HiddenInput
                name="_intent"
                value={item.paused ? PROVIDER_REFRESH_INTENTS.resume : PROVIDER_REFRESH_INTENTS.pause}
              />
              <HiddenInput name="providerKey" value={item.providerKey} />
              <Button type="submit" size="sm" tone={item.paused ? "primary" : "secondary"}>
                {item.paused
                  ? t("catalog.features.providerScopeDiscovery.ui.schedulePanel.resume")
                  : t("catalog.features.providerScopeDiscovery.ui.schedulePanel.pause")}
              </Button>
            </WorkbenchForm>
          )}
          <WorkbenchForm variant="button" method="post" action={actionHref}>
            <HiddenInput name="_intent" value={PROVIDER_REFRESH_INTENTS.run} />
            <HiddenInput name="providerKey" value={item.providerKey} />
            <Button type="submit" size="sm" tone="ghost">
              {t("catalog.features.providerScopeDiscovery.ui.schedulePanel.run.now")}
            </Button>
          </WorkbenchForm>
        </WorkbenchActionRow>
      ) : null}
    </WorkbenchStack>
  );
}

function scheduleBadgeTone(item: ProviderRefreshSchedulePanelItem): "success" | "warning" | "neutral" {
  if (item.paused) {
    return "warning";
  }
  if (item.manualOnly || !item.scheduleEnabled) {
    return "neutral";
  }
  return "success";
}

function scheduleBadgeLabel(item: ProviderRefreshSchedulePanelItem): string {
  if (item.paused) {
    return t("catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.paused");
  }
  if (item.manualOnly) {
    return t("catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.manual.only");
  }
  if (!item.scheduleEnabled) {
    return t("catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.disabled");
  }
  return t("catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.scheduled");
}

function lastRunLabel(item: ProviderRefreshSchedulePanelItem): string {
  if (!item.lastRunStatus || !item.lastRunCompletedAt) {
    return t("catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.never");
  }
  const statusLabel =
    item.lastRunStatus === "succeeded"
      ? t("catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.succeeded")
      : item.lastRunStatus === "failed"
        ? t("catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.failed")
        : t("catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.skipped.no.targets");
  return `${statusLabel} (${formatTimestamp(item.lastRunCompletedAt)})`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace("T", " ").slice(0, 16);
}
