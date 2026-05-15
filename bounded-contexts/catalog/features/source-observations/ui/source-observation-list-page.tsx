import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  Dialog,
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
import { importTcgdexSet } from "./use-source-observations";

function buildColumns(): DataColumn<SourceObservationListItem>[] {
  return [
    {
      key: "name",
      header: t("catalog.features.sourceObservations.ui.list.name"),
      cell: (row) => row.normalized.name,
    },
    {
      key: "set",
      header: t("catalog.features.sourceObservations.ui.list.set"),
      cell: (row) => row.normalized.setName,
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

const languageOptions = [
  { label: t("catalog.features.sourceObservations.ui.list.english"), value: "en" },
  { label: t("catalog.features.sourceObservations.ui.list.japanese"), value: "ja" },
  { label: t("catalog.features.sourceObservations.ui.list.korean"), value: "ko" },
  { label: t("catalog.features.sourceObservations.ui.list.chinese"), value: "zh" },
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
  const [setId, setSetId] = useState("");

  async function handleImport() {
    const result = await importTcgdexSet({ languageCode, setId });
    addToast(
      t("catalog.features.sourceObservations.ui.list.import.completed", {
        count: String(result.observed),
      }),
      "success",
    );
    setShowImport(false);
    setSetId("");
    revalidator.revalidate();
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
        extraFilters={
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
              ...languageOptions,
            ]}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowImport(true)}>
            {t("catalog.features.sourceObservations.ui.list.import.tcgdex.set")}</Button>
        }
      />
      <Dialog
        open={showImport}
        onOpenChange={setShowImport}
        title={t("catalog.features.sourceObservations.ui.list.import.tcgdex.set")}
        footer={<Button onClick={handleImport}>{t("catalog.features.sourceObservations.ui.list.import")}</Button>}
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.sourceObservations.ui.list.language.code")}
            value={languageCode}
            onChange={(event) => setLanguageCode(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.sourceObservations.ui.list.tcgdex.set.id")}
            value={setId}
            onChange={(event) => setSetId(event.target.value)}
          />
        </Stack>
      </Dialog>
    </>
  );
}
