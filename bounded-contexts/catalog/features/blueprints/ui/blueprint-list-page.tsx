import { t } from "@chase-sets/localization";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState } from "react";
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
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { BulkLifecycleActionBar } from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { confirmBulkBlueprintLifecycle, createBlueprint, previewBulkBlueprintLifecycle } from "./use-blueprints";
import type { Blueprint } from "./contracts";

const columns: DataColumn<Blueprint>[] = [
  { key: "key", header: t("catalog.features.blueprints.ui.blueprintListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.blueprints.ui.blueprintListPage.name"), cell: (row) => row.name },
  { key: "status", header: t("catalog.features.blueprints.ui.blueprintListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const statusOptions = [
  { label: t("catalog.features.blueprints.ui.blueprintListPage.draft"), value: "draft" },
  { label: t("catalog.features.blueprints.ui.blueprintListPage.active"), value: "active" },
  { label: t("catalog.features.blueprints.ui.blueprintListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.blueprints.ui.blueprintListPage.archived"), value: "archived" },
];
const ALL_FLAGS = "__all__";
const booleanOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_FLAGS },
  { label: t("catalog.support.shellSupport.ui.entityListPage.yes"), value: "true" },
  { label: t("catalog.support.shellSupport.ui.entityListPage.no"), value: "false" },
];
const lifecycleActions = [
  { value: "publish", label: t("catalog.features.blueprints.ui.blueprintDetailPage.publish") },
  { value: "deprecate", label: t("catalog.features.blueprints.ui.blueprintDetailPage.deprecate") },
  { value: "archive", label: t("catalog.features.blueprints.ui.blueprintDetailPage.archive") },
];

export function BlueprintListPage({ data, query }: CatalogListRouteData<Blueprint>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  async function handleCreate() {
    const blueprintId = createId("bpr");
    await createBlueprint({
      blueprintId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
    });
    addToast(t("catalog.features.blueprints.ui.blueprintListPage.blueprint.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    revalidator.revalidate();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.blueprints.ui.blueprintListPage.blueprints")}
        entityName="blueprint"
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.blueprint_id}
        getHref={(row) => `/blueprints/${row.blueprint_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <>
            <Select
              label={t("catalog.features.blueprints.ui.blueprintDetailPage.components")}
              value={listControls.hasComponents || ALL_FLAGS}
              onValueChange={(value) => listControls.setHasComponents(value === ALL_FLAGS ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.blueprints.ui.blueprintDetailPage.field.rules")}
              value={listControls.hasFieldRules || ALL_FLAGS}
              onValueChange={(value) => listControls.setHasFieldRules(value === ALL_FLAGS ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.blueprints.ui.blueprintDetailPage.dimension.rules")}
              value={listControls.hasDimensionRules || ALL_FLAGS}
              onValueChange={(value) => listControls.setHasDimensionRules(value === ALL_FLAGS ? "" : value)}
              items={booleanOptions}
            />
          </>
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          <BulkLifecycleActionBar
            entityName="Blueprints"
            selectedKeys={selectedKeys}
            filterSelection={{ mode: "filter", query }}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkBlueprintLifecycle}
            confirm={confirmBulkBlueprintLifecycle}
            onCompleted={revalidator.revalidate}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>{t("catalog.features.blueprints.ui.blueprintListPage.new.blueprint")}</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.blueprints.ui.blueprintListPage.create.blueprint")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.blueprints.ui.blueprintListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.blueprints.ui.blueprintListPage.key.2")} value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label={t("catalog.features.blueprints.ui.blueprintListPage.name.2")} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t("catalog.features.blueprints.ui.blueprintListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}

