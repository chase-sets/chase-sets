import { Suspense, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Await, useSubmit, type SubmitFunction } from "react-router";
import {
  Badge,
  BulkActionSurface,
  Button,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  Fieldset,
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
import { DeferredSupplementaryPanel } from "./deferred-supplementary-panel";
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
  // Streamed source-options slice (#1970). When the daily loader defers the
  // option fan-out it passes the promise here and the status panel renders behind
  // a Suspense boundary; when absent (the other surfaces, or a test that supplies
  // a fully-populated read model), the panel reads the synchronous slice on
  // `readModel.sourceOptions` directly.
  deferredSourceOptions?: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
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
  deferredSourceOptions = null,
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
          <ProviderImportContextForm readModel={readModel} deferredSourceOptions={deferredSourceOptions} />
          <DeferredSourceOptionsStatusPanel readModel={readModel} deferredSourceOptions={deferredSourceOptions} />
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

// A context change submits the URL-backed import context as a CLIENT navigation
// (`useSubmit`, method="get") rather than a full-document GET. The page stays
// mounted, so the operator's open stage / scroll / selection survive, and the
// loader revalidates IN PLACE — refreshing `useLoaderData` and the deferred
// source-options promise (#1970) — instead of remounting the whole route. Every
// submit replaces the history entry (`replace`) so live-on-change selects do not
// stack a history frame per change, and preserves scroll (`preventScrollReset`).
const importContextSubmitOptions = {
  method: "get",
  replace: true,
  preventScrollReset: true,
} as const;

function ProviderImportContextForm({
  readModel,
  deferredSourceOptions,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  deferredSourceOptions: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
}) {
  const submit = useSubmit();
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
  // Build the guided scope fields from the synchronous (skeleton) slice: the
  // declared option kinds and the operator's current scope selection are present
  // immediately (they derive from the active profile + route context, not the
  // fan-out), so the raw-importScope-vs-guided gate is decided at first paint and
  // each guided select renders preselected. The full per-group option lists stream
  // in behind the same deferred slice the status panel awaits (#1970).
  const skeletonScopeFields = guidedSourceScopeFields(readModel);

  return (
    <WorkbenchForm method="get" action="/catalog/integrations" onSubmit={(event) => submitImportContext(event, submit)}>
      <WorkbenchFormGrid columns="three">
        <NativeSelect
          name="providerKey"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.provider")}
          items={providerOptions}
          defaultValue={selectedProviderKey}
          required
          onChange={(event) => submitProviderFilter(event, submit)}
        />
        <NativeSelect
          name="unitKey"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.unit")}
          items={unitOptions}
          defaultValue={readModel.routeContext.unitKey ?? unitOptions[0]?.value ?? ""}
          required
          onChange={(event) => submitUnitFilter(event, submit)}
        />
        {/* The transitional raw importScope text box only survives for providers
            that declare no option queries (no guided controls to drive). Providers
            with option kinds get the structured selector below instead. As a
            free-text field it stays on the single confirming "Apply" path — the
            form's submit — rather than submitting per keystroke. */}
        {skeletonScopeFields.length === 0 ? (
          <TextInput
            name="importScope"
            label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.scope")}
            defaultValue={readModel.routeContext.importScope ?? ""}
          />
        ) : null}
      </WorkbenchFormGrid>
      {skeletonScopeFields.length > 0 ? (
        <DeferredGuidedSourceScopeFields
          readModel={readModel}
          skeletonScopeFields={skeletonScopeFields}
          deferredSourceOptions={deferredSourceOptions}
          submit={submit}
        />
      ) : null}
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

// Free-text apply (profileVersion / transitional importScope) and any explicit
// form submit. Intercept the native GET so it never full-reloads: submit the form
// as a client navigation that revalidates the loader in place.
function submitImportContext(event: FormEvent<HTMLFormElement>, submit: SubmitFunction): void {
  event.preventDefault();
  submit(event.currentTarget, importContextSubmitOptions);
}

function submitProviderFilter(event: ChangeEvent<HTMLSelectElement>, submit: SubmitFunction): void {
  submitImportContextFilter(
    event,
    submit,
    ["unitKey", "profileVersion", "importScope", ...catalogPrimaryWorkbenchScopeQueryKeys],
    {
      disableClearedFields: true,
      clearSourceOptionIntent: true,
    },
  );
}

function submitUnitFilter(event: ChangeEvent<HTMLSelectElement>, submit: SubmitFunction): void {
  submitImportContextFilter(
    event,
    submit,
    ["profileVersion", "importScope", ...catalogPrimaryWorkbenchScopeQueryKeys],
    {
      disableClearedFields: true,
      clearSourceOptionIntent: true,
    },
  );
}

function submitImportContextFilter(
  event: ChangeEvent<HTMLSelectElement>,
  submit: SubmitFunction,
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

  // A client GET navigation (not form.requestSubmit()): revalidates the loader in
  // place so the page stays mounted and the changed select keeps focus, instead of
  // a full-document reload that strands keyboard focus mid-navigation.
  submit(form, importContextSubmitOptions);
}

function clearSourceOptionRefreshIntent(form: HTMLFormElement): void {
  for (const fieldName of [CATALOG_SOURCE_OPTION_ACTION_PARAM, CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM]) {
    const field = form.elements.namedItem(fieldName);
    if (field instanceof HTMLInputElement) {
      field.remove();
    }
  }
}

// Stream the guided scope selects' full option lists (#1970). The fields render
// immediately from the skeleton slice — gated, labelled, and preselected to the
// route's current scope — and the resolved deferred slice repopulates each select
// with its full per-group option list once the fan-out streams in. When no promise
// is supplied (the other surfaces, or a test with a fully-populated read model),
// the fields render synchronously from the read model's own slice.
function DeferredGuidedSourceScopeFields({
  readModel,
  skeletonScopeFields,
  deferredSourceOptions,
  submit,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  skeletonScopeFields: readonly CatalogPrimaryWorkbenchGuidedScopeField[];
  deferredSourceOptions: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
  submit: SubmitFunction;
}) {
  if (!deferredSourceOptions) {
    return <GuidedSourceScopeFields fields={skeletonScopeFields} submit={submit} />;
  }

  return (
    <Suspense fallback={<GuidedSourceScopeFields fields={skeletonScopeFields} submit={submit} />}>
      <Await resolve={deferredSourceOptions}>
        {(sourceOptions) => (
          <GuidedSourceScopeFields fields={guidedSourceScopeFields({ ...readModel, sourceOptions })} submit={submit} />
        )}
      </Await>
    </Suspense>
  );
}

// The guided source-scope selector: one native select per provider option kind that
// maps to a structured route-context query field. Each select submits its scope id
// (languageCode / productLineId / seriesId / expansionId) on the existing GET form,
// so the route updates from real synced provider options instead of a hand-typed
// importScope string. A child whose parent is unselected renders disabled with the
// provider's own "select the parent first" diagnostic.
function GuidedSourceScopeFields({
  fields,
  submit,
}: {
  fields: readonly CatalogPrimaryWorkbenchGuidedScopeField[];
  submit: SubmitFunction;
}) {
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
                submit,
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
  submit: SubmitFunction,
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

  // Client GET navigation (not form.requestSubmit()): a parent scope change
  // refreshes the streamed source-options slice in place without reloading the
  // page or stranding focus on the just-changed select.
  submit(form, importContextSubmitOptions);
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

// Stream the source-options status panel (#1970). The option fan-out only feeds
// this secondary panel, so the daily loader defers it: the shell paints first and
// the populated panel streams in behind a Suspense/Await boundary. The skeleton
// read model still carries the declared `optionKinds` (derived from the active
// profile, not the fetched pages), so the gate "does this provider declare any
// option groups?" and the loading fallback both resolve before the fan-out does.
// When no promise is supplied (the back-compat path used by tests that build a
// fully-populated read model), the panel renders synchronously from the read
// model's own slice.
function DeferredSourceOptionsStatusPanel({
  readModel,
  deferredSourceOptions,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  deferredSourceOptions: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
}) {
  // No option groups for this provider → no panel at all (and nothing to stream).
  if (readModel.sourceOptions.optionKinds.length === 0) {
    return null;
  }
  if (!deferredSourceOptions) {
    return <SourceOptionsStatusPanel sourceOptions={readModel.sourceOptions} routeContext={readModel.routeContext} />;
  }

  return (
    <Suspense
      fallback={
        <DeferredSupplementaryPanel
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.title")}
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.deferred.sourceOptions.loading")}
        />
      }
    >
      <Await resolve={deferredSourceOptions}>
        {(sourceOptions) => (
          <SourceOptionsStatusPanel sourceOptions={sourceOptions} routeContext={readModel.routeContext} />
        )}
      </Await>
    </Suspense>
  );
}

// Refresh a source-option group in place. The intent (reload / force-refresh /
// force-refresh-all) and the full route context already live in the workbench
// href; submitting it as a client GET navigation (rather than following it as a
// document link) revalidates the loader, which re-fetches the option pages with
// the requested freshness and re-resolves the deferred source-options slice
// (#1970) WITHOUT reloading the whole page or resetting scroll/stage.
function SourceOptionRefreshButton({
  href,
  size,
  tone,
  leadingIcon,
  children,
}: {
  href: string;
  size: "sm";
  tone: "secondary" | "ghost";
  leadingIcon: "refreshCcw" | "spark";
  children: ReactNode;
}) {
  const submit = useSubmit();

  return (
    <Button
      type="button"
      size={size}
      tone={tone}
      leadingIcon={leadingIcon}
      onClick={() => submit(null, { ...importContextSubmitOptions, action: href })}
    >
      {children}
    </Button>
  );
}

// A compact sync/status panel for the synced provider option groups, rendered next
// to the context form on the daily surface. It names each option group with its
// natural label, surfaces freshness/degraded/missing-parent state per group, and
// exposes reload (cache) and force-refresh (live) controls. The controls navigate
// back to the Catalog Integrations workbench with a source-option intent — never to
// the raw provider-options API hrefs — so the operator stays in the workbench and
// the loader re-fetches the option pages. Renders nothing when the selected
// provider declares no option kinds.
function SourceOptionsStatusPanel({
  sourceOptions,
  routeContext,
}: {
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"];
  routeContext: CatalogPrimaryWorkbenchReadModel["routeContext"];
}) {
  if (sourceOptions.optionKinds.length === 0) {
    return null;
  }
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
              <SourceOptionRefreshButton
                size="sm"
                tone="secondary"
                leadingIcon="refreshCcw"
                href={catalogPrimaryWorkbenchSourceOptionHref(routeContext, {
                  action: "force-refresh-all",
                  queryKind: null,
                })}
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.refreshAll")}
              </SourceOptionRefreshButton>
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
              <SourceOptionRefreshButton
                size="sm"
                tone="ghost"
                leadingIcon="refreshCcw"
                href={catalogPrimaryWorkbenchSourceOptionHref(routeContext, {
                  action: "reload",
                  queryKind: page.queryKind,
                })}
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.reload")}
              </SourceOptionRefreshButton>
              {page.refreshHref ? (
                <SourceOptionRefreshButton
                  size="sm"
                  tone="ghost"
                  leadingIcon="spark"
                  href={catalogPrimaryWorkbenchSourceOptionHref(routeContext, {
                    action: "force-refresh",
                    queryKind: page.queryKind,
                  })}
                >
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.forceRefresh")}
                </SourceOptionRefreshButton>
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
