import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  Dialog,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { createComponent } from "./use-components";
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

export function ComponentListPage({ data, query }: CatalogListRouteData<Component>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    const componentId = createId("cmp");
    await createComponent({ componentId, key, name, description: description || undefined });
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




