import { useMemo, type Dispatch, type SetStateAction } from "react";
import {
  Badge,
  BulkActionBar,
  BulkActionPanel,
  Button,
  DataTable,
  EmptyState,
  FilterArea,
  KeyValueList,
  LinkButton,
  SideSheet,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchStack,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";
import {
  CommandFormButton,
  actionBlockers,
  actionState,
  type CatalogPrimaryWorkbenchSubmitIntent,
} from "./command-controls";
import { BlockerList, actionTone, stateLabel } from "./workbench-formatting";

type PrimaryWorkbenchStepKey = "provider" | "import" | "review" | "preview" | "promote";

export type PrimaryWorkbenchStep = Readonly<{
  key: PrimaryWorkbenchStepKey;
  label: string;
  evidence: string;
  action: string;
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}>;

export function buildSteps(readModel: CatalogPrimaryWorkbenchReadModel): readonly PrimaryWorkbenchStep[] {
  return [
    {
      key: "provider",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.provider.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.provider.evidence", {
        count: readModel.providerScope.providers.length,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.context"),
      state: actionState(readModel, "select-provider-scope"),
      blockers: actionBlockers(readModel, "select-provider-scope"),
    },
    {
      key: "import",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.import.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.import.evidence", {
        count: readModel.importJobs.jobs.length,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data"),
      state: actionState(readModel, "start-provider-import"),
      blockers: actionBlockers(readModel, "start-provider-import"),
    },
    {
      key: "review",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.review.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.review.evidence", {
        changed: readModel.sourceObservationReview.counts.changed,
        rejected: readModel.sourceObservationReview.counts.rejected,
        promoted: readModel.sourceObservationReview.counts.promoted,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.observations"),
      state: actionState(readModel, "select-source-observations"),
      blockers: actionBlockers(readModel, "select-source-observations"),
    },
    {
      key: "preview",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.preview.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.preview.evidence", {
        eligible: readModel.promotionPreview.dispositions.eligible,
        blocked: readModel.promotionPreview.dispositions.blocked,
        destructive: readModel.promotionPreview.destructiveCount,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion"),
      state: actionState(readModel, "preview-promotion"),
      blockers: actionBlockers(readModel, "preview-promotion"),
    },
    {
      key: "promote",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.promote.label"),
      evidence: readModel.promotionResult
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.step.promote.evidence.done", {
            count: readModel.promotionResult.promotedCatalogItemIds.length,
          })
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.step.promote.evidence.pending"),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.promote.catalog.facts"),
      state: actionState(readModel, "execute-promotion"),
      blockers: actionBlockers(readModel, "execute-promotion"),
    },
  ];
}

export function CatalogIntegrationPrimaryStepsModule({
  readModel,
  steps,
  selectableStepKeys,
  selectedKeys,
  onSelectedKeysChange,
  selectedCount,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  steps: readonly PrimaryWorkbenchStep[];
  selectableStepKeys: Set<string>;
  selectedKeys: Set<string>;
  onSelectedKeysChange: Dispatch<SetStateAction<Set<string>>>;
  selectedCount: number;
}>) {
  const columns = useMemo<DataColumn<PrimaryWorkbenchStep>[]>(
    () => [
      {
        key: "step",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.primary.step"),
        sortable: true,
        cell: (step) => (
          <WorkbenchDataCell title={step.label} description={step.evidence} descriptionTone="secondary" />
        ),
      },
      {
        key: "state",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.state"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.state"),
        cell: (step) => <Badge tone={actionTone(step.state)}>{stateLabel(step.state)}</Badge>,
      },
      {
        key: "blockers",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers"),
        cell: (step) => <BlockerList blockers={step.blockers} />,
      },
      {
        key: "action",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        align: "right",
        cell: (step) => (
          <WorkbenchActionRow>
            <StepEvidenceSheet step={step} readModel={readModel} />
            <PrimaryStepAction readModel={readModel} step={step} />
          </WorkbenchActionRow>
        ),
      },
    ],
    [readModel],
  );

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.module.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.module.description")}
      status={
        <Badge tone="accent">{t("catalog.features.sourceObservations.ui.primaryWorkbench.default.workspace")}</Badge>
      }
      actions={
        <>
          <LinkButton
            size="sm"
            tone="secondary"
            leadingIcon="filter"
            href={catalogPrimaryWorkbenchHref(readModel.routeContext, "source-observation-review")}
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.save.context")}
          </LinkButton>
          <CommandFormButton readModel={readModel} intent="start-provider-import" size="sm" leadingIcon="refreshCcw">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
          </CommandFormButton>
        </>
      }
      headingLevel={2}
      density="compact"
    >
      <FilterArea
        sticky={false}
        activeFilterCount={activeFilterCount(readModel)}
        panelTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.title")}
        panelDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.description")}
        actions={
          <LinkButton
            size="sm"
            tone="secondary"
            href={catalogPrimaryWorkbenchHref(
              {
                ...readModel.routeContext,
                sourceObservationFilters: {},
                selectedObservationIds: [],
                promotionPreviewId: null,
              },
              "import-to-promotion",
            )}
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.reset.view")}
          </LinkButton>
        }
      >
        <Badge tone="info">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.provider", {
            value:
              readModel.routeContext.providerKey ??
              t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.provider"),
          })}
        </Badge>
        <Badge tone="info">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.unit", {
            value:
              readModel.routeContext.unitKey ??
              t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.unit"),
          })}
        </Badge>
        <Badge tone="neutral">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.scope", {
            value:
              readModel.routeContext.importScope ??
              t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.scope"),
          })}
        </Badge>
        <Badge tone="neutral">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.profile", {
            value:
              readModel.routeContext.profileVersion ??
              t("catalog.features.sourceObservations.ui.primaryWorkbench.no.active.profile"),
          })}
        </Badge>
      </FilterArea>

      {readModel.providerScope.providers.length === 0 ? (
        <EmptyState
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.empty.provider.scopes.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.empty.provider.scopes.description")}
          actions={
            <Button tone="secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.open.profile.authoring")}
            </Button>
          }
        />
      ) : null}

      <DataTable
        rows={[...steps]}
        columns={columns}
        getRowId={(step) => step.key}
        selectedKeys={selectedKeys}
        onSelectionChange={onSelectedKeysChange}
        isRowSelectable={(step) => selectableStepKeys.has(step.key)}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.empty.steps.title")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.empty.steps.description")}
      />

      {selectedCount > 0 ? (
        <BulkActionBar
          count={selectedCount}
          formatSelectedLabel={(count) => `${count} primary step${count === 1 ? "" : "s"} selected`}
          primaryActions={
            <BulkActionPanel
              title={t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.panel.title")}
              description={t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.panel.description")}
              triggerLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.configure.preview")}
              footer={
                <CommandFormButton readModel={readModel} intent="preview-promotion" size="sm">
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.queue.preview")}
                </CommandFormButton>
              }
            >
              <KeyValueList
                items={[
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.eligible.observations"),
                    value: readModel.sourceObservationReview.promotionReadyCount,
                  },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan"),
                    value:
                      readModel.promotionPreview.commandPlanHash ??
                      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
                  },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.failure.mode"),
                    value: t("catalog.features.sourceObservations.ui.primaryWorkbench.failure.mode.value"),
                  },
                ]}
              />
            </BulkActionPanel>
          }
          secondaryActions={
            <Button size="sm" tone="secondary" onClick={() => onSelectedKeysChange(new Set())}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.clear.selection")}
            </Button>
          }
          overflowActions={[
            {
              key: "copy-context",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.route.context"),
              icon: "copy",
            },
            {
              key: "audit-evidence",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.open.audit.evidence"),
              icon: "externalLink",
            },
          ]}
        />
      ) : null}
    </WorkflowModule>
  );
}

function PrimaryStepAction({
  readModel,
  step,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  step: PrimaryWorkbenchStep;
}) {
  if (step.key === "provider" || step.key === "review") {
    return (
      <LinkButton
        size="sm"
        tone="secondary"
        href={catalogPrimaryWorkbenchHref(
          readModel.routeContext,
          step.key === "provider" ? "provider-scope-selection" : "source-observation-review",
        )}
      >
        {step.action}
      </LinkButton>
    );
  }

  const intentByStep: Record<
    Exclude<PrimaryWorkbenchStepKey, "provider" | "review">,
    CatalogPrimaryWorkbenchSubmitIntent
  > = {
    import: "start-provider-import",
    preview: "preview-promotion",
    promote: "execute-promotion",
  };

  return (
    <CommandFormButton
      readModel={readModel}
      intent={intentByStep[step.key]}
      size="sm"
      tone={step.key === "import" || step.key === "promote" ? "primary" : "secondary"}
      disabled={step.state !== "available" && step.state !== "degraded"}
    >
      {step.action}
    </CommandFormButton>
  );
}

function StepEvidenceSheet({
  step,
  readModel,
}: {
  step: PrimaryWorkbenchStep;
  readModel: CatalogPrimaryWorkbenchReadModel;
}) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence.sheet.title", { label: step.label })}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence.sheet.description")}
      closeLabel="Close evidence"
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence")}
        </Button>
      }
      footer={
        <Button size="sm" tone="secondary" disabled={step.blockers.length > 0}>
          {step.blockers.length > 0
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.use.evidence")}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
              value:
                readModel.routeContext.providerKey ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.unit"),
              value:
                readModel.routeContext.unitKey ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.scope"),
              value:
                readModel.routeContext.importScope ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.profile"),
              value:
                readModel.routeContext.profileVersion ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.state"),
              value: stateLabel(step.state),
            },
          ]}
        />
        <BlockerList blockers={step.blockers} />
      </WorkbenchStack>
    </SideSheet>
  );
}

function activeFilterCount(readModel: CatalogPrimaryWorkbenchReadModel): number {
  return [
    readModel.routeContext.providerKey,
    readModel.routeContext.unitKey,
    readModel.routeContext.importScope,
    readModel.routeContext.profileVersion,
    ...Object.values(readModel.routeContext.sourceObservationFilters),
  ].filter(Boolean).length;
}
