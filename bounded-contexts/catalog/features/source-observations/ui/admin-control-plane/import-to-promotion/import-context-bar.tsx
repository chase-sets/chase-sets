import { Fragment, Suspense, useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Await, useSubmit, type SubmitFunction } from "react-router";
import {
  Badge,
  Button,
  Fieldset,
  HiddenInput,
  NativeSelect,
  ProgressiveDisclosure,
  TextInput,
  WorkbenchActionRow,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchFormGrid,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { DeferredSupplementaryPanel } from "../../deferred-supplementary-panel";
import {
  CATALOG_SOURCE_OPTION_ACTION_PARAM,
  CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM,
  catalogPrimaryWorkbenchSourceOptionHref,
} from "../../primary-workbench-source-option-refresh";
import { catalogPrimaryWorkbenchScopeQueryKeys } from "../../primary-workbench-scope-context";
import {
  guidedSourceScopeFields,
  sourceOptionPageStateTone,
  sourceOptionsStatusTone,
  type CatalogPrimaryWorkbenchGuidedScopeField,
} from "../../primary-workbench-source-scope-fields";

// The import-context bar: "Step 0 / Choose import scope". The act of *choosing
// what to import* (provider / unit / guided scope / profile selection + the
// synced source-options status) is a distinct concern from the import -> promote
// flow that follows, so it is extracted out of the shell into one cohesive,
// collapsible component that decongests the top of the daily surface. It is
// deliberately self-contained and prop-driven (`readModel` + the deferred
// source-options promise) so the providers / governance / release surfaces — which
// also need provider/unit context — could adopt it later without reaching back
// into the shell.
//
// Collapse policy: the bar opens when no scope is chosen yet (the operator must
// pick one to do anything) and collapses to a one-line summary once a scope is set
// (provider · unit · scope · profile), with an edit affordance that re-expands it.
// Open/close is pure CLIENT state (`useState`) — it never navigates, so it never
// full-reloads. Editing the context (provider/unit/scope/profile selects, the
// source-option refresh controls) rides on the shared fetcher submit: a
// client GET navigation that revalidates the loader and re-resolves the deferred
// source-options slice in place, keeping the page mounted.
export function CatalogImportContextBar({
  readModel,
  deferredSourceOptions = null,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  deferredSourceOptions?: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
}>) {
  const summary = importContextSummary(readModel);
  // Open by default until a scope is chosen; once one is, the operator lands on the
  // collapsed summary and expands deliberately to edit. State, not navigation, so
  // toggling never reloads.
  const [open, setOpen] = useState(() => summary === null);

  return (
    <ProgressiveDisclosure
      data-catalog-import-context-bar="true"
      icon="filter"
      open={open}
      onOpenChange={setOpen}
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.step.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.step.description")}
      // The collapsed one-line summary (provider · unit · scope · profile). The
      // disclosure trigger is the edit affordance — its label names the action so
      // the operator knows the row reopens to edit; an empty summary keeps the bar
      // open (nothing to collapse to yet).
      summary={
        summary
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.step.summary", { summary })
          : undefined
      }
    >
      <WorkbenchStack>
        <ProviderImportContextForm readModel={readModel} deferredSourceOptions={deferredSourceOptions} />
        <DeferredSourceOptionsStatusPanel readModel={readModel} deferredSourceOptions={deferredSourceOptions} />
      </WorkbenchStack>
    </ProgressiveDisclosure>
  );
}

// Build the collapsed one-line import-context summary from the route context:
// "provider · unit · scope · profile" (e.g. "tcgdex · pokemon:card:import ·
// en/base/base1 · profile 2026.06.04"). Returns null when no scope is chosen yet —
// the signal the bar uses to stay open. "Chosen" means at least one structured
// scope level (or the transitional importScope string) is set, so picking only a
// provider/unit does not prematurely collapse the bar before a scope exists.
export function importContextSummary(readModel: CatalogPrimaryWorkbenchReadModel): string | null {
  const { providerKey, unitKey, profileVersion, importScope, scope } = readModel.routeContext;
  const scopeLabel = importContextScopeLabel(scope, importScope);
  if (!scopeLabel) {
    return null;
  }

  const parts = [
    providerKey,
    unitKey,
    scopeLabel,
    profileVersion
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.step.profile", { profileVersion })
      : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join(" · ");
}

// Join the structured scope levels (language / product line / series / expansion)
// the route context carries into a compact "en/base/base1" string, falling back to
// a name-based set scope when a provider exposes set names instead of set ids, and
// finally to the transitional free-text importScope for providers that declare no
// guided scope. Returns null when no scope level is set at all.
function importContextScopeLabel(
  scope: CatalogPrimaryWorkbenchReadModel["routeContext"]["scope"],
  importScope: string | null,
): string | null {
  const levels = [
    scope?.languageCode,
    scope?.productLineId,
    scope?.seriesId,
    scope?.expansionId ?? scope?.expansionName,
  ].filter((level): level is string => Boolean(level));
  if (levels.length > 0) {
    return levels.join("/");
  }

  return importScope && importScope.length > 0 ? importScope : null;
}

// A context change submits the URL-backed import context as a CLIENT navigation
// (`useSubmit`, method="get") rather than a full-document GET. The page stays
// mounted, so the operator's open stage / scroll / selection survive, and the
// loader revalidates IN PLACE — refreshing `useLoaderData` and the deferred
// source-options promise — instead of remounting the whole route. Every
// submit replaces the history entry (`replace`) so live-on-change selects do not
// stack a history frame per change, and preserves scroll (`preventScrollReset`).
const importContextSubmitOptions = {
  method: "get",
  replace: true,
  preventScrollReset: true,
} as const;
const staleImportContextHiddenFieldNames = new Set([
  "importScope",
  "selectedObservationIds",
  "reviewOffset",
  "reviewLimit",
  "jobId",
  "promotionPreviewId",
]);

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
  // in behind the same deferred slice the status panel awaits.
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
  clearStaleImportContextHiddenState(form);

  const disabledFields: Array<HTMLInputElement | HTMLSelectElement> = [];
  for (const fieldName of dependentFieldNames) {
    const field = form.elements.namedItem(fieldName);
    if (field instanceof HTMLSelectElement || field instanceof HTMLInputElement) {
      field.value = "";
      if (options.disableClearedFields) {
        field.disabled = true;
        disabledFields.push(field);
      }
    }
  }

  // A client GET navigation (not form.requestSubmit()): revalidates the loader in
  // place so the page stays mounted and the changed select keeps focus, instead of
  // a full-document reload that strands keyboard focus mid-navigation.
  submit(form, importContextSubmitOptions);
  for (const field of disabledFields) {
    field.disabled = false;
  }
}

function clearSourceOptionRefreshIntent(form: HTMLFormElement): void {
  for (const fieldName of [CATALOG_SOURCE_OPTION_ACTION_PARAM, CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM]) {
    const field = form.elements.namedItem(fieldName);
    if (field instanceof HTMLInputElement) {
      field.remove();
    }
  }
}

function clearStaleImportContextHiddenState(form: HTMLFormElement): void {
  for (const field of Array.from(form.elements)) {
    if (!(field instanceof HTMLInputElement) || field.type !== "hidden") {
      continue;
    }
    if (staleImportContextHiddenFieldNames.has(field.name) || field.name.startsWith("filter.")) {
      field.remove();
    }
  }
}

// Stream the guided scope selects' full option lists. The fields render
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
      <Await
        resolve={deferredSourceOptions}
        errorElement={<GuidedSourceScopeFields fields={skeletonScopeFields} submit={submit} />}
      >
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
//
// The select is rendered CONTROLLED (`value`, not `defaultValue`) via
// `RouteControlledGuidedScopeSelect` below: the surrounding
// `Fragment key={field.queryKind}` is intentionally stable across a streamed
// options revalidation (see `DeferredGuidedSourceScopeFields`) so focus/scroll
// survive the fallback -> resolved swap, but a stable key means `defaultValue`
// only ever applies once, at first mount. After a route/deferred-option
// revalidation the DOM would then keep showing whatever was selected at that
// first mount forever, even though `field.selectedValue` (route-derived) moved on
// — the exact blank-control defect this fixes.
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
          <Fragment key={field.queryKind}>
            <RouteControlledGuidedScopeSelect
              field={field}
              onChange={(event) =>
                submitSourceScopeFilter(event, submit, fields.slice(0, index), field, fields.slice(index + 1))
              }
            />
            {field.labelFieldName ? <HiddenInput name={field.labelFieldName} value={field.selectedLabel} /> : null}
          </Fragment>
        ))}
      </WorkbenchFormGrid>
    </Fieldset>
  );
}

// One guided scope select, kept route-controlled without losing instant feedback
// on the operator's own change. `field.selectedValue` is the route/loader's
// canonical value, but it only actually MOVES after the client-GET navigation
// this select's `onChange` kicks off resolves (`submitSourceScopeFilter` ->
// `submit`) — a later render, not this tick. A plain `value={field.selectedValue}`
// select would work for revalidation but would visibly snap the just-picked
// option back to the stale route value the instant the change event finishes,
// because React restores a controlled element's DOM to its last-rendered value
// after any native event unless the state it is controlled by was updated
// synchronously in the handler. Local state fixes that: `onChange` updates it
// synchronously (so the pick sticks immediately, matching the pre-existing
// optimistic cascade-clear/parent-hydration DOM writes elsewhere in this file),
// and the effect resyncs that same local state to `field.selectedValue` whenever
// a real revalidation changes the route out from under this still-mounted
// instance (the retry-1 defect this component exists to close).
function RouteControlledGuidedScopeSelect({
  field,
  onChange,
}: {
  field: CatalogPrimaryWorkbenchGuidedScopeField;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  const [value, setValue] = useState(field.selectedValue);
  useEffect(() => {
    setValue(field.selectedValue);
  }, [field.selectedValue]);

  return (
    <NativeSelect
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
      value={value}
      disabled={field.parentMissing}
      onChange={(event) => {
        setValue(event.currentTarget.value);
        onChange(event);
      }}
    />
  );
}

function submitSourceScopeFilter(
  event: ChangeEvent<HTMLSelectElement>,
  submit: SubmitFunction,
  parentFields: readonly CatalogPrimaryWorkbenchGuidedScopeField[],
  currentField: CatalogPrimaryWorkbenchGuidedScopeField,
  dependentFields: readonly CatalogPrimaryWorkbenchGuidedScopeField[],
): void {
  const form = event.currentTarget.form;
  if (!form) {
    return;
  }

  const selectedOption = findSourceScopeOption(currentField.options, event.currentTarget.value);
  setScopeLabelFieldValue(form, currentField, selectedOption?.label ?? "");
  hydrateParentScopeFields(form, event.currentTarget.value, parentFields, currentField.options);
  clearStaleImportContextHiddenState(form);

  for (const field of dependentFields) {
    setFormFieldValue(form, field.fieldName, "");
    setScopeLabelFieldValue(form, field, "");
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

    const parentOption = findSourceScopeOption(parentField.options, parentValue);
    setScopeLabelFieldValue(form, parentField, parentOption?.label ?? "");

    parentValue = parentOption?.parentValue ?? null;
    if (!parentValue) {
      return;
    }
  }
}

function setScopeLabelFieldValue(
  form: HTMLFormElement,
  field: CatalogPrimaryWorkbenchGuidedScopeField,
  value: string,
): void {
  if (field.labelFieldName) {
    setFormFieldValue(form, field.labelFieldName, value);
  }
}

function setFormFieldValue(form: HTMLFormElement, fieldName: string, value: string): void {
  const field = form.elements.namedItem(fieldName);
  if (field instanceof HTMLSelectElement || field instanceof HTMLInputElement) {
    field.value = value;
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

// Stream the source-options status panel. The option fan-out only feeds
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
      <Await
        resolve={deferredSourceOptions}
        errorElement={
          <SourceOptionsStatusPanel sourceOptions={readModel.sourceOptions} routeContext={readModel.routeContext} />
        }
      >
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
// WITHOUT reloading the whole page or resetting scroll/stage.
function SourceOptionRefreshButton({
  href,
  size,
  tone,
  leadingIcon,
  disabled = false,
  children,
}: {
  href: string;
  size: "sm";
  tone: "secondary" | "ghost";
  leadingIcon: "refreshCcw" | "spark";
  disabled?: boolean;
  children: ReactNode;
}) {
  const submit = useSubmit();

  return (
    <Button
      type="button"
      size={size}
      tone={tone}
      leadingIcon={leadingIcon}
      disabled={disabled}
      onClick={() => submitSourceOptionRefresh(href, submit)}
    >
      {children}
    </Button>
  );
}

function submitSourceOptionRefresh(href: string, submit: SubmitFunction): void {
  const target = new URL(href, window.location.origin);
  submit(target.searchParams, { ...importContextSubmitOptions, action: target.pathname });
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
                disabled={page.actionState === "disabled"}
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
                  disabled={page.actionState === "disabled"}
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
