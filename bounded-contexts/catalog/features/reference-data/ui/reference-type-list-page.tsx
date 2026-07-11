import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  Dialog,
  LinkButton,
  Stack,
  StatusPill,
  TextInput,
  Textarea,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { BulkLifecycleActionBar } from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import { toCatalogAdminHref } from "../../../support/shell-support/ui/catalog-admin-hrefs";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import {
  confirmBulkReferenceTypeLifecycle,
  createReferenceType,
  previewBulkReferenceTypeLifecycle,
} from "./use-reference-data";
import type { ReferenceType } from "./contracts";
import { parseKeyList } from "./reference-data-form";

const columns: DataColumn<ReferenceType>[] = [
  { key: "key", header: t("catalog.features.referenceData.ui.referenceTypeListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.referenceData.ui.referenceTypeListPage.name"), cell: (row) => row.name },
  {
    key: "attributes",
    header: t("catalog.features.referenceData.ui.referenceTypeListPage.attributes"),
    cell: (row) => row.attribute_keys.length,
    align: "right",
  },
  {
    key: "status",
    header: t("catalog.features.referenceData.ui.referenceTypeListPage.status"),
    cell: (row) => <StatusPill>{row.status}</StatusPill>,
  },
];

const statusOptions = [
  { label: t("catalog.features.referenceData.ui.referenceTypeListPage.draft"), value: "draft" },
  { label: t("catalog.features.referenceData.ui.referenceTypeListPage.active"), value: "active" },
  { label: t("catalog.features.referenceData.ui.referenceTypeListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.referenceData.ui.referenceTypeListPage.archived"), value: "archived" },
];
const lifecycleActions = [
  { value: "publish", label: t("catalog.features.referenceData.ui.referenceTypeDetailPage.publish") },
  { value: "deprecate", label: t("catalog.features.referenceData.ui.referenceTypeDetailPage.deprecate") },
  { value: "archive", label: t("catalog.features.referenceData.ui.referenceTypeDetailPage.archive") },
];

export function ReferenceTypeListPage({ data, query }: CatalogListRouteData<ReferenceType>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [attributeKeys, setAttributeKeys] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  async function handleCreate() {
    const referenceTypeId = createId("rft");
    await createReferenceType({
      referenceTypeId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
      attributeKeys: parseKeyList(attributeKeys),
    });
    addToast(t("catalog.features.referenceData.ui.referenceTypeListPage.reference.type.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setAttributeKeys("");
    revalidator.revalidate();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.referenceData.ui.referenceTypeListPage.reference.types")}
        entityName={t("catalog.features.referenceData.ui.referenceTypeListPage.reference.type")}
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.reference_type_id}
        getHref={(row) => `/reference-types/${row.reference_type_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceTypeListPage.attribute.key")}
            value={listControls.attributeKey}
            onChange={(event) => listControls.setAttributeKey(event.target.value)}
          />
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          <BulkLifecycleActionBar
            entityName="Reference Types"
            selectedKeys={selectedKeys}
            filterSelection={{ mode: "filter", query }}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkReferenceTypeLifecycle}
            confirm={confirmBulkReferenceTypeLifecycle}
            onCompleted={revalidator.revalidate}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>
            {t("catalog.features.referenceData.ui.referenceTypeListPage.new.reference.type")}
          </Button>
        }
        headerActions={
          <LinkButton href={toCatalogAdminHref("/reference-records")} tone="secondary">
            {t("catalog.features.referenceData.ui.referenceTypeListPage.manage.reference.records")}
          </LinkButton>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.referenceData.ui.referenceTypeListPage.create.reference.type")}
        footer={
          <Button onClick={handleCreate}>{t("catalog.features.referenceData.ui.referenceTypeListPage.create")}</Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceTypeListPage.key.2")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceTypeListPage.name.2")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceTypeListPage.description")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Textarea
            label={t("catalog.features.referenceData.ui.referenceTypeListPage.attribute.keys")}
            description={t("catalog.features.referenceData.ui.referenceTypeListPage.attribute.keys.description")}
            value={attributeKeys}
            onChange={(event) => setAttributeKeys(event.target.value)}
            rows={5}
          />
        </Stack>
      </Dialog>
    </>
  );
}
