import type { ChangeEvent, ReactNode } from "react";
import {
  Badge,
  BulkActionSurface,
  Button,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  Fieldset,
  LinkButton,
  MetricStrip,
  NativeSelect,
  OperationalStatusBanner,
  TextInput,
  WorkbenchActionRow,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchFormGrid,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import { WorkbenchReturnLink } from "./admin-control-plane/import-to-promotion/workbench-formatting";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { commandFeedbackDescription, commandSuccessTitle } from "./primary-workbench-command-feedback";
import {
  CATALOG_SOURCE_OPTION_ACTION_PARAM,
  CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM,
  catalogPrimaryWorkbenchSourceOptionHref,
} from "./primary-workbench-source-option-refresh";
import { catalogPrimaryWorkbenchScopeQueryKeys } from "./primary-workbench-scope-context";
import {
  guidedSourceScopeFields,
  sourceOptionPageStateTone,
  sourceOptionsStatusTone,
  type CatalogPrimaryWorkbenchGuidedScopeField,
} from "./primary-workbench-source-scope-fields";

export interface CatalogWorkbenchShellProps {
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  // The audience surface this shell wraps. Drives the single per-surface return
  // affordance: the supporting surfaces (providers, governance, release) render
  // one "Back to import workbench" link; the daily surface is the primary job and
  // renders none.
  surface: CatalogControlPlaneRouteSurfaceKey;
  // The composed surface body (one workspace for the daily route, the grouped
  // workspaces for the other three). The shell owns no per-surface logic.
  children: ReactNode;
}

// Shared chrome for every integrations surface route: the cross-surface header,
// metric strip, and surface body. Cross-surface navigation lives in the admin
// shell side nav (the nested "Integrations" manifest group), not in the page, so
// this shell renders only the active surface's content.
export function CatalogWorkbenchShell({
  readModel,
  commandFeedback = null,
  surface,
  children,
}: CatalogWorkbenchShellProps) {
  // The daily surface is the primary import-to-promotion job, so it carries no
  // return link; every supporting surface returns to it through the one link the
  // header renders (rather than each stacked workspace repeating it).
  const showReturnLink = surface !== "daily";

  return (
    <DenseAdminWorkbench data-catalog-primary-workbench="true">
      <DenseAdminWorkbenchHeader
        eyebrow={t("catalog.features.sourceObservations.ui.primaryWorkbench.eyebrow")}
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.description")}
        // The header carries only the per-surface return link. The primary
        // actions are NOT duplicated here: each stage owns its action exactly
        // once ("Pull provider data" in Run sync, "Preview promotion" in the
        // review selection surface and the Create / update stage), and the
        // three-stage stepper provides the at-a-glance wayfinding the header
        // copies used to duplicate.
        actions={showReturnLink ? <WorkbenchReturnLink routeContext={readModel.routeContext} /> : null}
      />

      {commandFeedback ? <CommandFeedbackBanner feedback={commandFeedback} /> : null}
      {surface === "daily" ? (
        <>
          <ProviderImportContextForm readModel={readModel} />
          <SourceOptionsStatusPanel readModel={readModel} />
        </>
      ) : null}

      <MetricStrip
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.observed"),
            value: String(readModel.sourceObservationReview.counts.observed),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.changed", {
              count: readModel.sourceObservationReview.counts.changed,
            }),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.ready.for.preview"),
            value: String(readModel.sourceObservationReview.promotionReadyCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.promotion.candidates"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.active.jobs"),
            value: String(readModel.importJobs.activeJobCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.job.view", {
              freshness: readModel.importJobs.freshness,
            }),
          },
          {
            // Blockers are no longer counted here: they live once in the
            // authoritative WorkspaceBlockerPanel (with the stepper's per-stage
            // blocked status as the structural cue). This slot instead surfaces
            // the promotion's write blast radius — the count of draft Catalog
            // Item updates the previewed promotion will make — a fail-closed fact
            // the stepper summaries do not restate.
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.catalogItemUpdates"),
            value: String(readModel.promotionPreview.destructiveCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.fail.closed"),
          },
        ]}
      />

      <BulkActionSurface>
        <WorkbenchStack>{children}</WorkbenchStack>
      </BulkActionSurface>
    </DenseAdminWorkbench>
  );
}

function ProviderImportContextForm({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
  const providerOptions = readModel.providerScope.providers.map((provider) => ({
    value: provider.providerKey,
    label: provider.displayName,
  }));
  const selectedProviderKey = readModel.routeContext.providerKey ?? providerOptions[0]?.value ?? "";
  const selectedProvider =
    readModel.providerScope.providers.find((provider) => provider.providerKey === selectedProviderKey) ??
    readModel.providerScope.providers[0] ??
    null;
  const units = selectedProvider?.units.map((unit) => ({ provider: selectedProvider, unit })) ?? [];
  const unitOptions = units.map(({ provider, unit }) => ({
    value: unit.unitKey,
    label: unit.unitKey,
    description: [provider.displayName, unit.productDomain, unit.productForm].filter(Boolean).join(" / "),
  }));
  const selectedUnit = units.find(({ unit }) => unit.unitKey === readModel.routeContext.unitKey)?.unit;
  const profileVersion = readModel.routeContext.profileVersion ?? selectedUnit?.activeProfile?.profileVersion ?? "";
  const scopeFields = guidedSourceScopeFields(readModel);

  return (
    <WorkbenchForm method="get" action="/catalog/integrations">
      <WorkbenchFormGrid columns="three">
        <NativeSelect
          name="providerKey"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.provider")}
          items={providerOptions}
          defaultValue={selectedProviderKey}
          required
          onChange={(event) => submitProviderFilter(event)}
        />
        <NativeSelect
          name="unitKey"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.unit")}
          items={unitOptions}
          defaultValue={readModel.routeContext.unitKey ?? unitOptions[0]?.value ?? ""}
          required
          onChange={(event) => submitUnitFilter(event)}
        />
        {/* The transitional raw importScope text box only survives for providers
            that declare no option queries (no guided controls to drive). Providers
            with option kinds get the structured selector below instead. */}
        {scopeFields.length === 0 ? (
          <TextInput
            name="importScope"
            label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.scope")}
            defaultValue={readModel.routeContext.importScope ?? ""}
          />
        ) : null}
      </WorkbenchFormGrid>
      {scopeFields.length > 0 ? <GuidedSourceScopeFields fields={scopeFields} /> : null}
      <WorkbenchActionRow align="between" stackOnMobile>
        <TextInput
          name="profileVersion"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.profileVersion")}
          defaultValue={profileVersion}
        />
        <Button type="submit" leadingIcon="check">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.apply")}
        </Button>
      </WorkbenchActionRow>
    </WorkbenchForm>
  );
}

function submitProviderFilter(event: ChangeEvent<HTMLSelectElement>): void {
  submitImportContextFilter(
    event,
    ["unitKey", "profileVersion", "importScope", ...catalogPrimaryWorkbenchScopeQueryKeys],
    {
      disableClearedFields: true,
      clearSourceOptionIntent: true,
    },
  );
}

function submitUnitFilter(event: ChangeEvent<HTMLSelectElement>): void {
  submitImportContextFilter(event, ["profileVersion", "importScope", ...catalogPrimaryWorkbenchScopeQueryKeys], {
    disableClearedFields: true,
    clearSourceOptionIntent: true,
  });
}

function submitImportContextFilter(
  event: ChangeEvent<HTMLSelectElement>,
  dependentFieldNames: readonly string[],
  options: { disableClearedFields?: boolean; clearSourceOptionIntent?: boolean } = {},
): void {
  const form = event.currentTarget.form;
  if (!form) {
    return;
  }

  if (options.clearSourceOptionIntent) {
    clearSourceOptionRefreshIntent(form);
  }

  for (const fieldName of dependentFieldNames) {
    const field = form.elements.namedItem(fieldName);
    if (field instanceof HTMLSelectElement || field instanceof HTMLInputElement) {
      field.value = "";
      if (options.disableClearedFields) {
        field.disabled = true;
      }
    }
  }

  form.requestSubmit();
}

function clearSourceOptionRefreshIntent(form: HTMLFormElement): void {
  for (const fieldName of [CATALOG_SOURCE_OPTION_ACTION_PARAM, CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM]) {
    const field = form.elements.namedItem(fieldName);
    if (field instanceof HTMLInputElement) {
      field.remove();
    }
  }
}

// The guided source-scope selector: one native select per provider option kind that
// maps to a structured route-context query field. Each select submits its scope id
// (languageCode / productLineId / seriesId / expansionId) on the existing GET form,
// so the route updates from real synced provider options instead of a hand-typed
// importScope string. A child whose parent is unselected renders disabled with the
// provider's own "select the parent first" diagnostic.
function GuidedSourceScopeFields({ fields }: { fields: readonly CatalogPrimaryWorkbenchGuidedScopeField[] }) {
  return (
    <Fieldset
      legend={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.scope.legend")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.scope.description")}
    >
      <WorkbenchFormGrid columns="three">
        {fields.map((field, index) => (
          <NativeSelect
            key={field.queryKind}
            name={field.fieldName}
            label={field.label}
            placeholder={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.scope.select", {
              label: field.label,
            })}
            description={field.parentMissing ? (field.parentDiagnostic ?? undefined) : undefined}
            items={field.options.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.description ?? undefined,
            }))}
            defaultValue={field.selectedValue || undefined}
            disabled={field.parentMissing}
            onChange={(event) =>
              submitSourceScopeFilter(
                event,
                fields.slice(0, index),
                field.options,
                fields.slice(index + 1).map((dependent) => dependent.fieldName),
              )
            }
          />
        ))}
      </WorkbenchFormGrid>
    </Fieldset>
  );
}

function submitSourceScopeFilter(
  event: ChangeEvent<HTMLSelectElement>,
  parentFields: readonly CatalogPrimaryWorkbenchGuidedScopeField[],
  currentOptions: CatalogPrimaryWorkbenchGuidedScopeField["options"],
  dependentFieldNames: readonly string[],
): void {
  const form = event.currentTarget.form;
  if (!form) {
    return;
  }

  hydrateParentScopeFields(form, event.currentTarget.value, parentFields, currentOptions);

  for (const fieldName of dependentFieldNames) {
    const field = form.elements.namedItem(fieldName);
    if (field instanceof HTMLSelectElement || field instanceof HTMLInputElement) {
      field.value = "";
    }
  }

  forceRefreshAllSourceOptions(form);

  form.requestSubmit();
}

function hydrateParentScopeFields(
  form: HTMLFormElement,
  selectedValue: string,
  parentFields: readonly CatalogPrimaryWorkbenchGuidedScopeField[],
  currentOptions: CatalogPrimaryWorkbenchGuidedScopeField["options"],
): void {
  let parentValue = currentOptions.find((option) => option.value === selectedValue)?.parentValue ?? null;
  if (!parentValue) {
    return;
  }

  for (let index = parentFields.length - 1; index >= 0; index -= 1) {
    const parentField = parentFields[index];
    if (!parentField) {
      continue;
    }

    const formField = form.elements.namedItem(parentField.fieldName);
    if (formField instanceof HTMLSelectElement || formField instanceof HTMLInputElement) {
      formField.value = parentValue;
    }

    parentValue = findSourceScopeOption(parentField.options, parentValue)?.parentValue ?? null;
    if (!parentValue) {
      return;
    }
  }
}

function findSourceScopeOption(
  options: CatalogPrimaryWorkbenchGuidedScopeField["options"],
  value: string,
): CatalogPrimaryWorkbenchGuidedScopeField["options"][number] | undefined {
  const exact = options.find((option) => option.value === value);
  if (exact) {
    return exact;
  }
  const comparableValue = value.trim().toLowerCase();
  return options.find((option) => option.value.trim().toLowerCase() === comparableValue);
}

// Stamp the GET form with the refresh-all source-option intent so the workbench
// loader force-refreshes every option group. Any stale per-group query-kind hint
// (left from a prior reload/force-refresh link the operator followed) is dropped,
// since refresh-all fans across every group and carries no single query kind.
function forceRefreshAllSourceOptions(form: HTMLFormElement): void {
  const staleQueryKind = form.elements.namedItem(CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM);
  if (staleQueryKind instanceof HTMLInputElement) {
    staleQueryKind.remove();
  }

  const existingAction = form.elements.namedItem(CATALOG_SOURCE_OPTION_ACTION_PARAM);
  if (existingAction instanceof HTMLInputElement) {
    existingAction.value = "force-refresh-all";
    return;
  }

  const action = document.createElement("input");
  action.type = "hidden";
  action.name = CATALOG_SOURCE_OPTION_ACTION_PARAM;
  action.value = "force-refresh-all";
  form.appendChild(action);
}

// A compact sync/status panel for the synced provider option groups, rendered next
// to the context form on the daily surface. It names each option group with its
// natural label, surfaces freshness/degraded/missing-parent state per group, and
// exposes reload (cache) and force-refresh (live) controls. The controls navigate
// back to the Catalog Integrations workbench with a source-option intent — never to
// the raw provider-options API hrefs — so the operator stays in the workbench and
// the loader re-fetches the option pages. Renders nothing when the selected
// provider declares no option kinds.
function SourceOptionsStatusPanel({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
  const sourceOptions = readModel.sourceOptions;
  if (sourceOptions.optionKinds.length === 0) {
    return null;
  }
  const { routeContext } = readModel;
  const { refresh, summary } = sourceOptions;
  const canRefreshAll =
    refresh.refreshAllHref !== null && (refresh.state === "available" || refresh.state === "degraded");

  return (
    <WorkbenchDetailPanel data-catalog-source-options-status={sourceOptions.status}>
      <WorkbenchStack gap="sm">
        <WorkbenchActionRow align="between" stackOnMobile>
          <WorkbenchStack gap="sm">
            <WorkbenchText tone="foreground" weight="semibold">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.title")}
            </WorkbenchText>
            <WorkbenchText size="xs" tone="secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.summary", {
                available: summary.availableOptions,
                loaded: summary.loadedPages,
                declared: summary.declaredKinds,
              })}
            </WorkbenchText>
          </WorkbenchStack>
          <WorkbenchStack gap="sm" element="div">
            <Badge tone={sourceOptionsStatusTone(sourceOptions.status)}>
              {t(
                `catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.status.${sourceOptions.status}`,
              )}
            </Badge>
            {canRefreshAll ? (
              <LinkButton
                size="sm"
                tone="secondary"
                leadingIcon="refreshCcw"
                href={catalogPrimaryWorkbenchSourceOptionHref(routeContext, {
                  action: "force-refresh-all",
                  queryKind: null,
                })}
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.refreshAll")}
              </LinkButton>
            ) : null}
          </WorkbenchStack>
        </WorkbenchActionRow>

        {sourceOptions.pages.map((page) => (
          <WorkbenchStack
            key={page.queryKind}
            gap="sm"
            data-source-option-page={page.queryKind}
            data-source-option-state={page.state}
          >
            <WorkbenchActionRow align="between" stackOnMobile>
              <WorkbenchStack gap="sm">
                <WorkbenchText size="sm" tone="foreground" weight="semibold">
                  {page.displayName}
                </WorkbenchText>
                <WorkbenchText size="xs" tone="secondary">
                  {page.state === "not-requested"
                    ? (page.cache.diagnostics[0]?.message ??
                      t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.parentRequired", {
                        parent: page.scope,
                      }))
                    : t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.optionCount", {
                        count: page.page.count,
                      })}
                </WorkbenchText>
              </WorkbenchStack>
              <WorkbenchStack gap="sm" element="div">
                <Badge tone={sourceOptionPageStateTone(page.state)}>
                  {t(`catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.state.${page.state}`)}
                </Badge>
                {page.degraded ? (
                  <Badge tone="warning">
                    {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.degradedNote")}
                  </Badge>
                ) : null}
              </WorkbenchStack>
            </WorkbenchActionRow>
            <WorkbenchActionRow align="start" stackOnMobile>
              <LinkButton
                size="sm"
                tone="ghost"
                leadingIcon="refreshCcw"
                href={catalogPrimaryWorkbenchSourceOptionHref(routeContext, {
                  action: "reload",
                  queryKind: page.queryKind,
                })}
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.reload")}
              </LinkButton>
              {page.refreshHref ? (
                <LinkButton
                  size="sm"
                  tone="ghost"
                  leadingIcon="spark"
                  href={catalogPrimaryWorkbenchSourceOptionHref(routeContext, {
                    action: "force-refresh",
                    queryKind: page.queryKind,
                  })}
                >
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.forceRefresh")}
                </LinkButton>
              ) : null}
            </WorkbenchActionRow>
          </WorkbenchStack>
        ))}
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

function CommandFeedbackBanner({ feedback }: { feedback: CatalogPrimaryWorkbenchCommandFeedback }) {
  return (
    <OperationalStatusBanner
      tone={feedback.status === "success" ? "success" : "warning"}
      title={
        feedback.status === "success"
          ? commandSuccessTitle(feedback.result)
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.error.title")
      }
      description={commandFeedbackDescription(feedback)}
    />
  );
}
