import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  ActionBar,
  DataTable,
  Dialog,
  FilterBar,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  ProgressBar,
  Select,
  Stack,
  Stat,
  StatGrid,
  type DataColumn,
  type SelectItem,
} from "@chase-sets/design-system";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import type { SourceObservationIntegrationOption, SourceObservationIntegrationScope } from "./contracts";
import { importTcgdexSet, useSourceObservationIntegrationOptions } from "./use-source-observations";

const ALL_PROVIDERS = "__all__";
const ALL_LANGUAGES = "__all__";
const ALL_EXPANSIONS = "__all__";

const providerOptions = [
  { label: t("catalog.features.sourceObservations.ui.integrations.provider.tcgdex"), value: "tcgdex" },
];

export function IntegrationManagementPage({ data, query }: CatalogListRouteData<SourceObservationIntegrationScope>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showImport, setShowImport] = useState(false);
  const [languageCode, setLanguageCode] = useState("en");
  const [seriesId, setSeriesId] = useState("");
  const [expansionId, setExpansionId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const summary = useMemo(() => summarizeScopes(data.items ?? []), [data.items]);
  const columns = useMemo(() => buildColumns(), []);
  const importLanguages = useSourceObservationIntegrationOptions({
    providerKey: "tcgdex",
    queryKind: "languages",
  });
  const importSeries = useSourceObservationIntegrationOptions({
    providerKey: "tcgdex",
    queryKind: "series",
    languageCode,
  });
  const importExpansions = useSourceObservationIntegrationOptions({
    providerKey: "tcgdex",
    queryKind: "expansions",
    languageCode,
    parentValue: seriesId,
    enabled: !!seriesId,
  });
  const filterExpansionLanguage = listControls.language || languageCode || "en";
  const filterExpansions = useSourceObservationIntegrationOptions({
    providerKey: listControls.source || "tcgdex",
    queryKind: "expansions",
    languageCode: filterExpansionLanguage,
    enabled: !listControls.source || listControls.source === "tcgdex",
  });
  const languageOptions = useMemo(
    () =>
      (importLanguages.data?.items ?? []).map((item) => ({
        label: formatLanguageCodeLabel(metadataString(item.metadata.languageCode) ?? item.value),
        value: item.value,
      })),
    [importLanguages.data],
  );
  const seriesOptions = useMemo(() => toSelectItems(importSeries.data?.items ?? []), [importSeries.data]);
  const expansionOptions = useMemo(() => toSelectItems(importExpansions.data?.items ?? []), [importExpansions.data]);
  const filterExpansionOptions = useMemo(
    () => toSelectItems(filterExpansions.data?.items ?? []),
    [filterExpansions.data],
  );

  useEffect(() => {
    if (languageOptions.length > 0 && !languageOptions.some((item) => item.value === languageCode)) {
      setLanguageCode(languageOptions[0].value);
    }
  }, [languageOptions, languageCode]);

  useEffect(() => {
    setSeriesId("");
    setExpansionId("");
  }, [languageCode]);

  useEffect(() => {
    if (seriesOptions.length === 0) {
      setSeriesId("");
      return;
    }

    if (!seriesOptions.some((item) => item.value === seriesId)) {
      setSeriesId(seriesOptions[0].value);
    }
  }, [seriesOptions, seriesId]);

  useEffect(() => {
    if (expansionOptions.length === 0) {
      setExpansionId("");
      return;
    }

    if (!expansionOptions.some((item) => item.value === expansionId)) {
      setExpansionId(expansionOptions[0].value);
    }
  }, [expansionOptions, expansionId]);

  async function handleImport() {
    if (!expansionId) {
      return;
    }

    setImporting(true);
    setImportProgress(0);

    try {
      const result = await importTcgdexSet(
        { languageCode, setId: expansionId },
        { onProgress: (progress) => setImportProgress(importProgressPercent(progress)) },
      );
      addToast(
        t("catalog.features.sourceObservations.ui.list.import.completed", {
          count: String(result.observed),
        }),
        "success",
      );
      setShowImport(false);
      setExpansionId("");
      listControls.setFilters({
        source: "tcgdex",
        language: result.languageCode,
        setId: result.expansionId ?? result.setId,
      });
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : t("catalog.features.sourceObservations.ui.integrations.import.failed"),
        "danger",
      );
    } finally {
      setImporting(false);
      setImportProgress(0);
    }
  }

  return (
    <Page>
      <PageHeader title={t("catalog.features.sourceObservations.ui.integrations.title")} />
      <Stack gap={4}>
        <ActionBar>
          <Button leadingIcon="plus" onClick={() => setShowImport(true)}>
            {t("catalog.features.sourceObservations.ui.list.import.tcgdex.expansion")}
          </Button>
        </ActionBar>
        <StatGrid columns={{ base: 1, md: 4 }}>
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.scopes")}
            value={formatCount(summary.scopes)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.observations")}
            value={formatCount(summary.total)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.needs.review")}
            value={formatCount(summary.observed + summary.changed)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.promoted")}
            value={formatCount(summary.promoted)}
          />
        </StatGrid>

        <FilterBar sticky={false}>
          <Select
            label={t("catalog.features.sourceObservations.ui.integrations.provider")}
            value={listControls.source || ALL_PROVIDERS}
            onValueChange={(value) =>
              listControls.setFilters({
                source: value === ALL_PROVIDERS ? "" : value,
                setId: "",
              })
            }
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.integrations.all.providers"),
                value: ALL_PROVIDERS,
              },
              ...providerOptions,
            ]}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.language")}
            value={listControls.language || ALL_LANGUAGES}
            onValueChange={(value) =>
              listControls.setFilters({
                language: value === ALL_LANGUAGES ? "" : value,
                setId: "",
              })
            }
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.list.all.languages"),
                value: ALL_LANGUAGES,
              },
              ...languageOptions,
            ]}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.expansion")}
            value={listControls.setId || ALL_EXPANSIONS}
            onValueChange={(value) => listControls.setSetId(value === ALL_EXPANSIONS ? "" : value)}
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.integrations.all.expansions"),
                value: ALL_EXPANSIONS,
              },
              ...withSelectedFallback(filterExpansionOptions, listControls.setId),
            ]}
            disabled={(!!listControls.source && listControls.source !== "tcgdex") || filterExpansions.loading}
            error={filterExpansions.error ?? undefined}
          />
        </FilterBar>

        <DataTable
          rows={data.items ?? []}
          columns={columns}
          getRowId={(row) => [row.provider_key, row.language_code, row.expansion_id, row.series_id].join(":")}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrations.none.found")}
        />
      </Stack>

      <Dialog
        open={showImport}
        onOpenChange={setShowImport}
        title={t("catalog.features.sourceObservations.ui.list.import.tcgdex.expansion")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setShowImport(false)} disabled={importing}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              onClick={handleImport}
              loading={importing}
              disabled={
                !languageCode ||
                !seriesId ||
                !expansionId ||
                importing ||
                importLanguages.loading ||
                importSeries.loading ||
                importExpansions.loading
              }
            >
              {t("catalog.features.sourceObservations.ui.list.import")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          <Select
            label={t("catalog.features.sourceObservations.ui.list.language")}
            value={languageCode}
            onValueChange={setLanguageCode}
            items={languageOptions}
            disabled={importLanguages.loading || languageOptions.length === 0}
            error={importLanguages.error ?? undefined}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.series")}
            value={seriesId}
            onValueChange={(value) => {
              setSeriesId(value);
              setExpansionId("");
            }}
            items={seriesOptions}
            disabled={importSeries.loading || seriesOptions.length === 0}
            error={importSeries.error ?? undefined}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.expansion")}
            value={expansionId}
            onValueChange={setExpansionId}
            items={expansionOptions}
            disabled={!seriesId || importExpansions.loading || expansionOptions.length === 0}
            error={importExpansions.error ?? undefined}
          />
          {importing ? <ProgressBar value={importProgress} /> : null}
        </Stack>
      </Dialog>
    </Page>
  );
}

function buildColumns(): DataColumn<SourceObservationIntegrationScope>[] {
  return [
    {
      key: "provider",
      header: t("catalog.features.sourceObservations.ui.integrations.provider"),
      cell: (row) => row.provider_key,
    },
    {
      key: "language",
      header: t("catalog.features.sourceObservations.ui.list.language"),
      cell: (row) => formatLanguageCodeLabel(row.language_code),
    },
    {
      key: "expansion",
      header: t("catalog.features.sourceObservations.ui.list.expansion"),
      cell: (row) => row.expansion_name || row.expansion_id,
    },
    {
      key: "series",
      header: t("catalog.features.sourceObservations.ui.integrations.series"),
      cell: (row) => row.series_name || row.series_id || "",
    },
    {
      key: "observed",
      header: t("catalog.features.sourceObservations.ui.integrations.needs.review"),
      cell: (row) => formatCount(reviewableObservationCount(row)),
    },
    {
      key: "promoted",
      header: t("catalog.features.sourceObservations.ui.integrations.promoted"),
      cell: (row) => formatCount(row.promoted_observations),
    },
    {
      key: "rejected",
      header: t("catalog.features.sourceObservations.ui.integrations.rejected"),
      cell: (row) => formatCount(row.rejected_observations),
    },
    {
      key: "latest",
      header: t("catalog.features.sourceObservations.ui.integrations.last.observed"),
      cell: (row) => formatDateTime(row.latest_observed_at),
    },
    {
      key: "review",
      header: "",
      cell: (row) => (
        <LinkButton href={sourceObservationScopeHref(row)} size="sm" tone="secondary">
          {t("catalog.features.sourceObservations.ui.integrations.review")}
        </LinkButton>
      ),
    },
  ];
}

function summarizeScopes(scopes: readonly SourceObservationIntegrationScope[]) {
  return scopes.reduce(
    (summary, scope) => ({
      scopes: summary.scopes + 1,
      total: summary.total + scope.total_observations,
      observed: summary.observed + scope.observed_observations,
      changed: summary.changed + scope.changed_observations,
      promoted: summary.promoted + scope.promoted_observations,
    }),
    {
      scopes: 0,
      total: 0,
      observed: 0,
      changed: 0,
      promoted: 0,
    },
  );
}

function reviewableObservationCount(scope: SourceObservationIntegrationScope): number {
  return scope.observed_observations + scope.changed_observations;
}

function toSelectItems(options: readonly SourceObservationIntegrationOption[]): SelectItem[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description ?? undefined,
  }));
}

function withSelectedFallback(options: readonly SelectItem[], selectedValue: string): SelectItem[] {
  if (!selectedValue || options.some((option) => option.value === selectedValue)) {
    return [...options];
  }

  return [
    {
      label: selectedValue,
      value: selectedValue,
    },
    ...options,
  ];
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sourceObservationScopeHref(scope: SourceObservationIntegrationScope) {
  const params = new URLSearchParams();
  params.set("source", scope.provider_key);
  params.set("language", scope.language_code);

  if (scope.expansion_id) {
    params.set("setId", scope.expansion_id);
  }

  return `/catalog/source-observations?${params.toString()}`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function importProgressPercent(progress: { phase: string; completed: number; total: number }): number {
  if (progress.phase === "completed") {
    return 100;
  }

  if (progress.total <= 0) {
    return 5;
  }

  const base = progress.phase === "recording" ? 80 : 5;
  const span = progress.phase === "recording" ? 15 : 75;
  return base + (progress.completed / progress.total) * span;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
