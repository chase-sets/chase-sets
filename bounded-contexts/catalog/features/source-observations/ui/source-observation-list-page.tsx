import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import {
  BulkActionBar,
  Button,
  Dialog,
  Inline,
  Select,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import type { SourceObservationListItem } from "./contracts";
import {
  bulkPromoteSourceObservationsByScope,
  bulkPromoteSourceObservations,
  importTcgdexSet,
  previewBulkPromoteSourceObservations,
  useTcgdexExpansions,
  useTcgdexLanguages,
  useTcgdexSeries,
} from "./use-source-observations";
import type {
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
} from "./contracts";

function buildColumns(): DataColumn<SourceObservationListItem>[] {
  return [
    {
      key: "name",
      header: t("catalog.features.sourceObservations.ui.list.name"),
      cell: (row) => row.normalized.name,
    },
    {
      key: "expansion",
      header: t("catalog.features.sourceObservations.ui.list.expansion"),
      cell: (row) => row.normalized.expansionName ?? row.normalized.setName,
    },
    {
      key: "number",
      header: t("catalog.features.sourceObservations.ui.list.number"),
      cell: (row) => row.normalized.cardNumber,
    },
    {
      key: "language",
      header: t("catalog.features.sourceObservations.ui.list.language"),
      cell: (row) => formatLanguageCodeLabel(row.language_code),
    },
    {
      key: "status",
      header: t("catalog.features.sourceObservations.ui.list.status"),
      cell: (row) => <StatusPill>{row.status}</StatusPill>,
    },
  ];
}

const statusOptions = [
  { label: t("catalog.features.sourceObservations.ui.list.observed"), value: "observed" },
  { label: t("catalog.features.sourceObservations.ui.list.promoted"), value: "promoted" },
  { label: t("catalog.features.sourceObservations.ui.list.rejected"), value: "rejected" },
];

const ALL_LANGUAGES = "__all__";

export function SourceObservationListPage({
  data,
  query,
}: CatalogListRouteData<SourceObservationListItem>) {
  const listControls = useCatalogListQueryControls(query);
  const columns = useMemo(() => buildColumns(), []);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showImport, setShowImport] = useState(false);
  const [languageCode, setLanguageCode] = useState("en");
  const [seriesId, setSeriesId] = useState("");
  const [expansionId, setExpansionId] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkPromoting, setBulkPromoting] = useState(false);
  const [promoteAllScope, setPromoteAllScope] =
    useState<SourceObservationPromotionScope>({});
  const [promoteAllPreview, setPromoteAllPreview] =
    useState<SourceObservationPromotionPreview | null>(null);
  const [previewingPromoteAll, setPreviewingPromoteAll] = useState(false);
  const [promoteAllRunning, setPromoteAllRunning] = useState(false);
  const [showPromoteAll, setShowPromoteAll] = useState(false);
  const tcgdexLanguages = useTcgdexLanguages();
  const tcgdexSeries = useTcgdexSeries(languageCode);
  const tcgdexExpansions = useTcgdexExpansions(languageCode, seriesId);
  const importLanguageOptions = useMemo(
    () =>
      (tcgdexLanguages.data?.items ?? []).map((item) => ({
        label: formatLanguageCodeLabel(item.languageCode),
        value: item.languageCode,
      })),
    [tcgdexLanguages.data],
  );
  const seriesOptions = useMemo(
    () =>
      (tcgdexSeries.data?.items ?? []).map((item) => ({
        label: item.name,
        value: item.seriesId,
      })),
    [tcgdexSeries.data],
  );
  const expansionOptions = useMemo(
    () =>
      (tcgdexExpansions.data?.items ?? []).map((item) => ({
        label:
          item.officialCardCount === null
            ? item.name
            : `${item.name} (${item.officialCardCount})`,
        value: item.expansionId,
      })),
    [tcgdexExpansions.data],
  );
  const eligibleIds = useMemo(
    () =>
      new Set(
        (data.items ?? [])
          .filter((item) => item.status === "observed")
          .map((item) => item.observation_id),
      ),
    [data.items],
  );

  useEffect(() => {
    setSelectedKeys((current) =>
      new Set(Array.from(current).filter((key) => eligibleIds.has(key))),
    );
  }, [eligibleIds]);

  useEffect(() => {
    if (
      importLanguageOptions.length > 0 &&
      !importLanguageOptions.some((item) => item.value === languageCode)
    ) {
      setLanguageCode(importLanguageOptions[0].value);
    }
  }, [importLanguageOptions, languageCode]);

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

  function handleSelectionChange(keys: Set<string>) {
    setSelectedKeys(
      new Set(Array.from(keys).filter((key) => eligibleIds.has(key))),
    );
  }

  async function handleImport() {
    const result = await importTcgdexSet({ languageCode, setId: expansionId });
    addToast(
      t("catalog.features.sourceObservations.ui.list.import.completed", {
        count: String(result.observed),
      }),
      "success",
    );
    setShowImport(false);
    listControls.setFilters({
      language: result.languageCode,
      setId: result.expansionId ?? result.setId,
      status: "observed",
    });
    revalidator.revalidate();
  }

  async function handleBulkPromote() {
    const observationIds = Array.from(selectedKeys);
    setBulkPromoting(true);

    try {
      const result = await bulkPromoteSourceObservations(observationIds);
      addToast(
        t("catalog.features.sourceObservations.ui.list.bulk.promote.completed", {
          promoted: String(result.promoted),
          skipped: String(result.skipped),
          failed: String(result.failed),
        }),
        result.failed > 0 ? "warning" : "success",
      );
      setSelectedKeys(new Set());
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.list.bulk.promote.failed"),
        "danger",
      );
    } finally {
      setBulkPromoting(false);
    }
  }

  function currentPromotionScope(): SourceObservationPromotionScope {
    return {
      search: listControls.search,
      status: listControls.status,
      provider: listControls.source,
      language: listControls.language,
      setId: listControls.setId,
    };
  }

  async function handlePreviewPromoteAll() {
    const scope = currentPromotionScope();
    setPreviewingPromoteAll(true);

    try {
      const preview = await previewBulkPromoteSourceObservations(scope);
      setPromoteAllScope(scope);
      setPromoteAllPreview(preview);
      setShowPromoteAll(true);
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.list.bulk.promote.failed"),
        "danger",
      );
    } finally {
      setPreviewingPromoteAll(false);
    }
  }

  async function handlePromoteAllMatching() {
    setPromoteAllRunning(true);

    try {
      const result = await bulkPromoteSourceObservationsByScope(promoteAllScope);
      addToast(
        t("catalog.features.sourceObservations.ui.list.bulk.promote.completed", {
          promoted: String(result.promoted),
          skipped: String(result.skipped),
          failed: String(result.failed),
        }),
        result.failed > 0 ? "warning" : "success",
      );
      setShowPromoteAll(false);
      setPromoteAllPreview(null);
      setSelectedKeys(new Set());
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.list.bulk.promote.failed"),
        "danger",
      );
    } finally {
      setPromoteAllRunning(false);
    }
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.sourceObservations.ui.list.source.observations")}
        entityName={t("catalog.features.sourceObservations.ui.list.source.observation")}
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.observation_id}
        getHref={(row) => `/source-observations/${row.observation_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        selectedKeys={selectedKeys}
        onSelectionChange={handleSelectionChange}
        isRowSelectable={(row) => row.status === "observed"}
        bulkActionBar={
          selectedKeys.size > 0 ? (
            <BulkActionBar
              count={selectedKeys.size}
              formatSelectedLabel={(count) =>
                t("catalog.features.sourceObservations.ui.list.selected.count", {
                  count: String(count),
                })
              }
              actions={
                <>
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => setSelectedKeys(new Set())}
                    disabled={bulkPromoting}
                  >
                    {t("catalog.features.sourceObservations.ui.list.clear.selection")}
                  </Button>
                  <Button
                    size="sm"
                    leadingIcon="badgeCheck"
                    loading={bulkPromoting}
                    onClick={handleBulkPromote}
                  >
                    {t("catalog.features.sourceObservations.ui.list.bulk.promote")}
                  </Button>
                </>
              }
            />
          ) : null
        }
        extraFilters={
          <>
            <Select
              label={t("catalog.features.sourceObservations.ui.list.language")}
              value={listControls.language || ALL_LANGUAGES}
              onValueChange={(value) =>
                listControls.setLanguage(value === ALL_LANGUAGES ? "" : value)
              }
              items={[
                {
                  label: t("catalog.features.sourceObservations.ui.list.all.languages"),
                  value: ALL_LANGUAGES,
                },
                ...importLanguageOptions,
              ]}
            />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.list.tcgdex.expansion.id")}
              value={listControls.setId}
              onChange={(event) => listControls.setSetId(event.target.value)}
            />
            <Button
              tone="secondary"
              leadingIcon="badgeCheck"
              loading={previewingPromoteAll}
              disabled={previewingPromoteAll || promoteAllRunning}
              onClick={handlePreviewPromoteAll}
            >
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.matching")}
            </Button>
          </>
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button leadingIcon="plus" onClick={() => setShowImport(true)}>
            {t("catalog.features.sourceObservations.ui.list.import.tcgdex.expansion")}</Button>
        }
      />
      <Dialog
        open={showImport}
        onOpenChange={setShowImport}
        title={t("catalog.features.sourceObservations.ui.list.import.tcgdex.expansion")}
        footer={
          <Button
            onClick={handleImport}
            disabled={
              !languageCode ||
              !seriesId ||
              !expansionId ||
              tcgdexLanguages.loading ||
              tcgdexSeries.loading ||
              tcgdexExpansions.loading
            }
          >
            {t("catalog.features.sourceObservations.ui.list.import")}
          </Button>
        }
      >
        <Stack gap={3}>
          <Select
            label={t("catalog.features.sourceObservations.ui.list.language")}
            value={languageCode}
            onValueChange={setLanguageCode}
            items={importLanguageOptions}
            disabled={tcgdexLanguages.loading || importLanguageOptions.length === 0}
            error={tcgdexLanguages.error ?? undefined}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.series")}
            value={seriesId}
            onValueChange={(value) => {
              setSeriesId(value);
              setExpansionId("");
            }}
            items={seriesOptions}
            disabled={tcgdexSeries.loading || seriesOptions.length === 0}
            error={tcgdexSeries.error ?? undefined}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.expansion")}
            value={expansionId}
            onValueChange={setExpansionId}
            items={expansionOptions}
            disabled={!seriesId || tcgdexExpansions.loading || expansionOptions.length === 0}
            error={tcgdexExpansions.error ?? undefined}
          />
        </Stack>
      </Dialog>
      <Dialog
        open={showPromoteAll}
        onOpenChange={setShowPromoteAll}
        title={t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.title")}
        footer={
          <Inline gap={2} align="end">
            <Button
              tone="secondary"
              onClick={() => setShowPromoteAll(false)}
              disabled={promoteAllRunning}
            >
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              loading={promoteAllRunning}
              disabled={!promoteAllPreview || promoteAllPreview.eligible === 0}
              onClick={handlePromoteAllMatching}
            >
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm")}
            </Button>
          </Inline>
        }
      >
        {promoteAllPreview ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.body", {
                eligible: String(promoteAllPreview.eligible),
                terminal: String(promoteAllPreview.terminal),
                matched: String(promoteAllPreview.matched),
              })}
            </p>
            <p>
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.scope", {
                scope: formatPromotionScope(promoteAllPreview.scope),
              })}
            </p>
          </Stack>
        ) : null}
      </Dialog>
    </>
  );
}

function formatPromotionScope(scope: Required<SourceObservationPromotionScope>): string {
  const parts = [
    scope.search
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.search", {
          search: scope.search,
        })
      : "",
    scope.status
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.status", {
          status: scope.status,
        })
      : "",
    scope.language
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.language", {
          language: formatLanguageCodeLabel(scope.language),
        })
      : "",
    scope.provider
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.provider", {
          provider: scope.provider,
        })
      : "",
    scope.setId
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.expansion", {
          setId: scope.setId,
        })
      : "",
  ].filter(Boolean);

  return parts.length > 0
    ? parts.join(", ")
    : t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.all");
}
