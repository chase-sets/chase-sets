import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
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
import { confirmBulkComponentLifecycle, createComponent, previewBulkComponentLifecycle } from "./use-components";
import type { Component } from "./contracts";

const columns: DataColumn<Component>[] = [
  { key: "key", header: t("catalog.features.components.ui.componentListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.components.ui.componentListPage.name"), cell: (row) => row.name },
  { key: "status", header: t("catalog.features.components.ui.componentListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const statusOptions = [
  { label: t("catalog.features.components.ui.componentListPage.draft"), value: "draft" },
  { label: t("catalog.features.components.ui.componentListPage.active"), value: "active" },
  { label: t("catalog.features.components.ui.componentListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.components.ui.componentListPage.archived"), value: "archived" },
];
const ALL_FLAGS = "__all__";
const booleanOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_FLAGS },
  { label: t("catalog.support.shellSupport.ui.entityListPage.yes"), value: "true" },
  { label: t("catalog.support.shellSupport.ui.entityListPage.no"), value: "false" },
];
const lifecycleActions = [
  { value: "activate", label: t("catalog.features.components.ui.componentDetailPage.activate") },
  { value: "deprecate", label: t("catalog.features.components.ui.componentDetailPage.deprecate") },
  { value: "archive", label: t("catalog.features.components.ui.componentDetailPage.archive") },
];

export function ComponentListPage({ data, query }: CatalogListRouteData<Component>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  async function handleCreate() {
    const componentId = createId("cmp");
    await createComponent({
      componentId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
    });
    addToast(t("catalog.features.components.ui.componentListPage.component.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    revalidator.revalidate();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.components.ui.componentListPage.components")}
        entityName="component"
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.component_id}
        getHref={(row) => `/components/${row.component_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <>
            <Select
              label={t("catalog.features.components.ui.componentDetailPage.field.rules")}
              value={listControls.hasFieldRules || ALL_FLAGS}
              onValueChange={(value) => listControls.setHasFieldRules(value === ALL_FLAGS ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.components.ui.componentDetailPage.dimension.rules")}
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
            entityName="Components"
            selectedKeys={selectedKeys}
            filterSelection={{ mode: "filter", query }}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkComponentLifecycle}
            confirm={confirmBulkComponentLifecycle}
            onCompleted={revalidator.revalidate}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>{t("catalog.features.components.ui.componentListPage.new.component")}</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.components.ui.componentListPage.create.component")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.components.ui.componentListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.components.ui.componentListPage.key.2")} value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label={t("catalog.features.components.ui.componentListPage.name.2")} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t("catalog.features.components.ui.componentListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}

