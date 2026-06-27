import { Suspense, useMemo, useState } from "react";
import { Await } from "react-router";
import {
  Badge,
  BadgeCluster,
  Button,
  Checkbox,
  DataTable,
  HiddenInput,
  KeyValueList,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import type { CatalogSyncRun } from "../../contracts";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";
import { BlockerList, stateLabel } from "./workbench-formatting";

type CatalogSyncUnitRow = CatalogPrimaryWorkbenchCatalogSyncUnitReadModel;

export function CatalogSyncScopeModule({
  readModel,
  deferredCatalogSyncRun = null,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  deferredCatalogSyncRun?: Promise<CatalogSyncRun | null> | null;
}>) {
  const catalogSync = readModel.catalogSync;
  const defaultSelectedUnitKeys = catalogSync.preview.units
    .filter((unit) => unit.selected && unit.unitKey)
    .map((unit) => unit.unitKey as string);
  const [selectedUnitKeys, setSelectedUnitKeys] = useState<ReadonlySet<string>>(() => new Set(defaultSelectedUnitKeys));
  const columns = useMemo<DataColumn<CatalogSyncUnitRow>[]>(
    () => [
      {
        key: "selection",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.table.sync"),
        cell: (unit) => {
          const unitKey = unit.unitKey ?? "";
          const checked = Boolean(unit.unitKey && selectedUnitKeys.has(unit.unitKey));
          return (
            <Checkbox
              name={`catalog-sync-selected-${unitKey || unit.providerKey}`}
              checked={checked}
              disabled={unit.eligibility !== "eligible" || !unit.unitKey}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedUnitKeys);
                if (nextChecked === true && unit.unitKey) {
                  next.add(unit.unitKey);
                } else if (unit.unitKey) {
                  next.delete(unit.unitKey);
                }
                setSelectedUnitKeys(next);
              }}
              label={checked ? "Selected" : "Not selected"}
            />
          );
        },
      },
      {
        key: "unit",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.table.providerUnit"),
        cell: (unit) => (
          <WorkbenchDataCell
            title={unit.displayName}
            description={unit.unitKey ?? "No active unit"}
            detail={unit.profileVersion ? `Profile ${unit.profileVersion}` : "No active profile"}
          />
        ),
      },
      {
        key: "readiness",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.table.readiness"),
        cell: (unit) => (
          <WorkbenchStack gap="sm">
            <Badge tone={unit.eligibility === "eligible" ? "success" : "danger"}>{stateLabel(unit.eligibility)}</Badge>
            <BadgeCluster
              items={[
                { key: "role", label: stateLabel(unit.role), tone: "neutral" },
                { key: "requirement", label: stateLabel(unit.requirement), tone: "neutral" },
              ]}
            />
          </WorkbenchStack>
        ),
      },
      {
        key: "child",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.table.childScope"),
        cell: (unit) => (
          <WorkbenchText size="xs" tone="secondary">
            {unit.childExecutionScope
              ? Object.entries(unit.childExecutionScope)
                  .map(([key, value]) => `${key}:${value}`)
                  .join(" / ")
              : "No child scope"}
          </WorkbenchText>
        ),
      },
    ],
    [selectedUnitKeys],
  );
  const selectedEligibleCount = catalogSync.preview.units.filter(
    (unit) => unit.unitKey && selectedUnitKeys.has(unit.unitKey) && unit.eligibility === "eligible",
  ).length;
  const disabled = catalogSync.action.state !== "available" && catalogSync.action.state !== "degraded";

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.description")}
      status={
        <BadgeCluster
          items={[
            { key: "status", label: stateLabel(catalogSync.status), tone: syncStatusTone(catalogSync.status) },
            {
              key: "units",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.selected", {
                value: selectedEligibleCount,
              }),
              tone: selectedEligibleCount > 0 ? "info" : "warning",
            },
          ]}
        />
      }
      headingLevel={2}
      density="compact"
    >
      <WorkbenchStack>
        <WorkbenchGrid columns="equalDetail">
          <KeyValueList
            items={[
              { key: "Scope", value: catalogSync.scope.label },
              { key: "Domain", value: catalogSync.scope.productDomain ?? "Not selected" },
              { key: "Form", value: catalogSync.scope.productForm ?? "Not selected" },
              { key: "Language", value: catalogSync.scope.languageCode ?? "Not selected" },
            ]}
          />
          <KeyValueList
            items={[
              { key: "Reference", value: catalogSync.scope.reference.id ?? "Not selected" },
              { key: "Reference kind", value: catalogSync.scope.reference.kind ?? "Not selected" },
              { key: "Plan", value: catalogSync.preview.explanation },
              { key: "Start", value: catalogSync.preview.startAllowed ? "Allowed" : "Blocked" },
            ]}
          />
        </WorkbenchGrid>

        <BlockerList blockers={catalogSync.action.blockers} compact hideWhenEmpty />

        <DataTable
          rows={[...catalogSync.preview.units]}
          columns={columns}
          caption="Catalog sync provider participation"
          getRowId={(unit) => unit.unitKey ?? unit.providerKey}
          getRowProps={(unit) => ({
            "data-catalog-sync-participation-row": "true",
            "data-catalog-sync-participation-provider": unit.providerKey,
            "data-catalog-sync-participation-unit": unit.unitKey ?? "",
            "data-catalog-sync-participation-eligibility": unit.eligibility,
            "data-catalog-sync-participation-child-scope": unit.childExecutionScope
              ? Object.entries(unit.childExecutionScope)
                  .map(([key, value]) => `${key}:${value}`)
                  .join("|")
              : "",
          })}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.empty.title")}
          emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.empty.description")}
        />

        <WorkbenchForm
          variant="button"
          method="post"
          action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
          data-catalog-primary-workbench-command="start-catalog-sync"
        >
          <HiddenInput name="_intent" value="start-catalog-sync" />
          <HiddenInput name="productDomain" value={catalogSync.scope.productDomain ?? ""} />
          <HiddenInput name="productForm" value={catalogSync.scope.productForm ?? ""} />
          <HiddenInput name="languageCode" value={catalogSync.scope.languageCode ?? ""} />
          <HiddenInput name="referenceKind" value={catalogSync.scope.reference.kind ?? ""} />
          <HiddenInput name="referenceId" value={catalogSync.scope.reference.id ?? ""} />
          <HiddenInput name="referenceName" value={catalogSync.scope.reference.name ?? ""} />
          <HiddenInput name="seriesId" value={catalogSync.scope.reference.seriesId ?? ""} />
          <HiddenInput name="seriesName" value={catalogSync.scope.reference.seriesName ?? ""} />
          {catalogSync.scope.reference.kind === "expansion" ? (
            <>
              <HiddenInput name="expansionId" value={catalogSync.scope.reference.id ?? ""} />
              <HiddenInput name="expansionName" value={catalogSync.scope.reference.name ?? ""} />
            </>
          ) : null}
          {[...selectedUnitKeys].map((unitKey) => (
            <HiddenInput key={unitKey} name="selectedUnitKeys" value={unitKey} />
          ))}
          {catalogSync.preview.units
            .filter((unit) => unit.unitKey && selectedUnitKeys.has(unit.unitKey))
            .map((unit) => {
              const providerHint = providerHintValueForUnit(unit);
              return providerHint ? (
                <HiddenInput key={`${unit.unitKey}:provider-hint`} name="providerHints" value={providerHint} />
              ) : null;
            })}
          {catalogSync.preview.units
            .filter((unit) => unit.unitKey && !selectedUnitKeys.has(unit.unitKey))
            .map((unit) => (
              <HiddenInput key={unit.unitKey} name="excludedUnitKeys" value={unit.unitKey ?? ""} />
            ))}
          <Button type="submit" leadingIcon="refreshCcw" disabled={disabled || selectedEligibleCount === 0}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.start")}
          </Button>
        </WorkbenchForm>

        <DeferredCatalogSyncRunProgress deferredCatalogSyncRun={deferredCatalogSyncRun} />
      </WorkbenchStack>
    </WorkflowModule>
  );
}

function providerHintValueForUnit(unit: CatalogSyncUnitRow): string | null {
  if (!unit.unitKey || !unit.childExecutionScope) {
    return null;
  }

  return JSON.stringify(
    compactProviderHint({
      providerKey: unit.childExecutionScope.provider ?? unit.providerKey,
      unitKey: unit.unitKey,
      productLineId: unit.childExecutionScope.productLineId,
      seriesId: unit.childExecutionScope.seriesId,
      setId: unit.childExecutionScope.setId,
      setName: unit.childExecutionScope.setName,
      productId: unit.childExecutionScope.productId,
    }),
  );
}

function compactProviderHint(input: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );
}

function DeferredCatalogSyncRunProgress({
  deferredCatalogSyncRun,
}: Readonly<{
  deferredCatalogSyncRun: Promise<CatalogSyncRun | null> | null;
}>) {
  if (!deferredCatalogSyncRun) {
    return null;
  }

  return (
    <Suspense
      fallback={
        <WorkbenchDetailPanel>
          <WorkbenchText>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.progress.loading")}
          </WorkbenchText>
        </WorkbenchDetailPanel>
      }
    >
      <Await resolve={deferredCatalogSyncRun}>{(run) => (run ? <CatalogSyncRunProgress run={run} /> : null)}</Await>
    </Suspense>
  );
}

function CatalogSyncRunProgress({ run }: Readonly<{ run: CatalogSyncRun }>) {
  return (
    <WorkbenchDetailPanel data-catalog-sync-run={run.status} data-catalog-sync-run-id={run.syncRunId}>
      <WorkbenchStack>
        <WorkbenchActionRow align="between" stackOnMobile>
          <WorkbenchStack gap="sm">
            <WorkbenchText tone="foreground" weight="semibold">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.progress.parentRun", {
                value: run.syncRunId,
              })}
            </WorkbenchText>
            <WorkbenchText size="sm" tone="secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.progress.delegatedChildren")}
            </WorkbenchText>
          </WorkbenchStack>
          <Badge tone={syncRunTone(run.status)}>{stateLabel(run.status)}</Badge>
        </WorkbenchActionRow>
        <KeyValueList
          items={[
            { key: "Child jobs", value: `${run.progress.childJobs.completed}/${run.progress.childJobs.total}` },
            { key: "Running", value: run.progress.childJobs.running },
            { key: "Queued", value: run.progress.childJobs.queued },
            { key: "Partial", value: run.progress.childJobs.partial },
            { key: "Failed", value: run.progress.childJobs.failed },
            {
              key: "Provider targets",
              value: `${run.progress.providerTargets.completed}/${run.progress.providerTargets.total}`,
            },
          ]}
        />
        <DataTable
          rows={[...run.childJobs]}
          columns={[
            {
              key: "provider",
              header: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.progress.providerChild"),
              cell: (child) => (
                <WorkbenchDataCell title={child.displayName} description={child.childJobId ?? "No child job"} />
              ),
            },
            {
              key: "status",
              header: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.progress.status"),
              cell: (child) => <Badge tone={syncRunTone(child.status)}>{stateLabel(child.status)}</Badge>,
            },
            {
              key: "link",
              header: t("catalog.features.sourceObservations.ui.primaryWorkbench.catalogSync.progress.link"),
              cell: (child) => (
                <WorkbenchText size="xs" tone="secondary">
                  {stateLabel(child.syncRunLinkState)}
                </WorkbenchText>
              ),
            },
          ]}
          caption="Catalog sync child jobs"
          density="compact"
          getRowId={(child) => child.childJobId ?? child.unitKey}
        />
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

function syncStatusTone(status: CatalogPrimaryWorkbenchReadModel["catalogSync"]["status"]) {
  if (status === "ready") {
    return "success";
  }
  if (status === "blocked") {
    return "danger";
  }
  return "warning";
}

function syncRunTone(status: string) {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "danger";
  }
  if (status === "partial") {
    return "warning";
  }
  return "info";
}
