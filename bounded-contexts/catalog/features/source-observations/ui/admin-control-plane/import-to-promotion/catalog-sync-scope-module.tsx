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
        header: "Sync",
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
        header: "Provider unit",
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
        header: "Readiness",
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
        header: "Child scope",
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
      title="Catalog scope sync"
      description="Select provider participation inside this Catalog scope, preview the fan-out, and start one parent sync run."
      status={
        <BadgeCluster
          items={[
            { key: "status", label: stateLabel(catalogSync.status), tone: syncStatusTone(catalogSync.status) },
            {
              key: "units",
              label: `${selectedEligibleCount} selected`,
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
          density="compact"
          emptyTitle="No provider units"
          emptyDescription="Select a Catalog scope that can be planned by active provider units."
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
            .filter((unit) => unit.unitKey && !selectedUnitKeys.has(unit.unitKey))
            .map((unit) => (
              <HiddenInput key={unit.unitKey} name="excludedUnitKeys" value={unit.unitKey ?? ""} />
            ))}
          <Button type="submit" leadingIcon="refreshCcw" disabled={disabled || selectedEligibleCount === 0}>
            Start Catalog sync
          </Button>
        </WorkbenchForm>

        <DeferredCatalogSyncRunProgress deferredCatalogSyncRun={deferredCatalogSyncRun} />
      </WorkbenchStack>
    </WorkflowModule>
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
          <WorkbenchText>Loading Catalog sync progress...</WorkbenchText>
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
              Parent sync run {run.syncRunId}
            </WorkbenchText>
            <WorkbenchText size="sm" tone="secondary">
              Child retry, resume, and cancel remain delegated to provider import jobs.
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
              header: "Provider child",
              cell: (child) => (
                <WorkbenchDataCell title={child.displayName} description={child.childJobId ?? "No child job"} />
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (child) => <Badge tone={syncRunTone(child.status)}>{stateLabel(child.status)}</Badge>,
            },
            {
              key: "link",
              header: "Link",
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
