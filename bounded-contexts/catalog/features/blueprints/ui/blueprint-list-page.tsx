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
import { createBlueprint } from "./use-blueprints";
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

export function BlueprintListPage({ data, query }: CatalogListRouteData<Blueprint>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    const blueprintId = createId("bpr");
    await createBlueprint({ blueprintId, key, name, description: description || undefined });
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




