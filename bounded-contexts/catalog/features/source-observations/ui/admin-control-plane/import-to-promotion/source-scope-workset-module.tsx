import type { ReactNode } from "react";
import {
  Badge,
  Button,
  DataTable,
  HiddenInput,
  LinkButton,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { useCatalogIntegrationHrefRebase } from "./command-action-context";

type SourceScopeUnitRow = CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel;

// A unit's link and commands carry its full working-set query; the owning page's
// path receives them, so choosing or acting on a unit never leaves that page.
export function CatalogSourceScopeWorksetModule({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const rebase = useCatalogIntegrationHrefRebase();
  const workset = readModel.sourceScopeWorkset;
  if (workset.units.length === 0) {
    return null;
  }

  return (
    <WorkbenchDetailPanel data-catalog-source-scope-workset={workset.status}>
      <WorkbenchStack>
        <WorkbenchActionRow align="between" stackOnMobile>
          <WorkbenchStack gap="sm">
            <WorkbenchText tone="foreground" weight="semibold">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.title")}
            </WorkbenchText>
            <WorkbenchText size="sm" tone="secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.description")}
            </WorkbenchText>
          </WorkbenchStack>
          <Badge tone={worksetStatusTone(workset.status)}>{workset.status}</Badge>
        </WorkbenchActionRow>

        <WorkbenchActionRow align="start" stackOnMobile>
          <WorkbenchDataCell
            title={workset.selectedScope.label}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.selectedScope")}
          />
          <WorkbenchDataCell
            title={String(workset.summary.changedObservationCount)}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.changed")}
          />
          <WorkbenchDataCell
            title={String(workset.summary.promotedObservationCount)}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.promoted")}
          />
          <WorkbenchDataCell
            title={String(workset.summary.activeImportCount)}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.activeImports")}
          />
        </WorkbenchActionRow>

        <DataTable
          rows={[...workset.units]}
          columns={[...sourceScopeUnitColumns(readModel, rebase)]}
          density="compact"
        />
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

function sourceScopeUnitColumns(
  readModel: CatalogPrimaryWorkbenchReadModel,
  rebase: (href: string) => string,
): readonly DataColumn<SourceScopeUnitRow>[] {
  return [
    {
      key: "unit",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.unit"),
      cell: (row) => (
        <WorkbenchDataCell
          title={row.displayName}
          description={
            row.unitKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.noActiveUnit")
          }
          detail={
            row.profileVersion
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.profileVersion", {
                  profileVersion: row.profileVersion,
                })
              : t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.noActiveProfile")
          }
        />
      ),
    },
    {
      key: "state",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.state"),
      cell: (row) => (
        <WorkbenchStack gap="sm">
          <Badge tone={unitStateTone(row.state)}>{row.state}</Badge>
          <WorkbenchText size="xs" tone="secondary">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.counts", {
              observed: row.counts.observed,
              changed: row.counts.changed,
              promoted: row.counts.promoted,
            })}
          </WorkbenchText>
        </WorkbenchStack>
      ),
    },
    {
      key: "actions",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.actions"),
      cell: (row) => {
        const unitHref = rebase(row.currentWorkbenchHref);
        return (
          <WorkbenchActionRow align="start" stackOnMobile>
            <LinkButton size="sm" tone="secondary" leadingIcon="externalLink" href={unitHref}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.openUnitScope")}
            </LinkButton>
            <SourceScopeCommandButton row={row} href={unitHref} action={row.actions.import}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.syncUnit", {
                unit: row.displayName,
              })}
            </SourceScopeCommandButton>
            <SourceScopeCommandButton row={row} href={unitHref} action={row.actions.previewPromotion}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.previewUnit", {
                unit: row.displayName,
              })}
            </SourceScopeCommandButton>
            <SourceScopeCommandButton row={row} href={unitHref} action={row.actions.reapply}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceScopeWorkset.reapplyUnit", {
                unit: row.displayName,
              })}
            </SourceScopeCommandButton>
          </WorkbenchActionRow>
        );
      },
    },
  ];
}

function SourceScopeCommandButton({
  row,
  href,
  action,
  children,
}: {
  row: SourceScopeUnitRow;
  href: string;
  action: CatalogPrimaryWorkbenchActionReadModel;
  children: ReactNode;
}) {
  const available = action.state === "available" || action.state === "degraded";

  return (
    <WorkbenchForm
      variant="button"
      method="post"
      action={href}
      data-catalog-primary-workbench-command={action.key}
      data-catalog-source-scope-unit={row.unitKey ?? row.providerKey}
    >
      <HiddenInput name="_intent" value={action.key} />
      <HiddenInput name="providerKey" value={row.commandContext.providerKey} />
      <HiddenInput name="unitKey" value={row.commandContext.unitKey ?? ""} />
      <HiddenInput name="importScope" value={row.commandContext.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={row.commandContext.profileVersion ?? ""} />
      <HiddenInput name="languageCode" value={row.commandContext.languageCode ?? ""} />
      <HiddenInput name="productLineId" value={row.commandContext.productLineId ?? ""} />
      <HiddenInput name="productLineName" value={row.commandContext.productLineName ?? ""} />
      <HiddenInput name="seriesId" value={row.commandContext.seriesId ?? ""} />
      <HiddenInput name="seriesName" value={row.commandContext.seriesName ?? ""} />
      <HiddenInput name="expansionId" value={row.commandContext.expansionId ?? ""} />
      <HiddenInput name="expansionName" value={row.commandContext.expansionName ?? ""} />
      <HiddenInput name="productId" value={row.commandContext.productId ?? ""} />
      <HiddenInput name="selectedObservationIds" value="" />
      <HiddenInput name="promotionPreviewId" value="" />
      <Button type="submit" size="sm" tone="ghost" disabled={!available}>
        {children}
      </Button>
    </WorkbenchForm>
  );
}

function worksetStatusTone(
  status: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["status"],
): "success" | "warning" | "danger" | "neutral" | "info" {
  switch (status) {
    case "ready":
      return "success";
    case "degraded":
    case "scope-required":
      return "warning";
    case "blocked":
      return "danger";
    case "not-configured":
      return "neutral";
  }
}

function unitStateTone(
  state: CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel["state"],
): "success" | "warning" | "danger" | "neutral" | "info" {
  switch (state) {
    case "promoted":
      return "success";
    case "changed":
      return "warning";
    case "blocked":
      return "danger";
    case "imported":
      return "info";
    case "not-imported":
      return "neutral";
  }
}
