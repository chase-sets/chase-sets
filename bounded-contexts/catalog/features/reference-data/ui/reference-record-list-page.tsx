import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  Combobox,
  Dialog,
  Inline,
  LinkButton,
  Select,
  Stack,
  StatusPill,
  DataTable,
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
  confirmBulkReferenceRecordLifecycle,
  createReferenceRecord,
  previewBulkReferenceRecordLifecycle,
} from "./use-reference-data";
import type { ReferenceRecord, ReferenceRelationship, ReferenceType } from "./contracts";
import { parseAttributesInput } from "./reference-data-form";

const ALL_TYPES = "__all__";

const columns: DataColumn<ReferenceRecord>[] = [
  {
    key: "type",
    header: t("catalog.features.referenceData.ui.referenceRecordListPage.type"),
    cell: (row) => row.type_key,
  },
  { key: "key", header: t("catalog.features.referenceData.ui.referenceRecordListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.referenceData.ui.referenceRecordListPage.name"), cell: (row) => row.name },
  {
    key: "status",
    header: t("catalog.features.referenceData.ui.referenceRecordListPage.status"),
    cell: (row) => <StatusPill>{row.status}</StatusPill>,
  },
];

const statusOptions = [
  { label: t("catalog.features.referenceData.ui.referenceRecordListPage.draft"), value: "draft" },
  { label: t("catalog.features.referenceData.ui.referenceRecordListPage.active"), value: "active" },
  { label: t("catalog.features.referenceData.ui.referenceRecordListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.referenceData.ui.referenceRecordListPage.archived"), value: "archived" },
];
const lifecycleActions = [
  { value: "publish", label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.publish") },
  { value: "deprecate", label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.deprecate") },
  { value: "archive", label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.archive") },
];

const relationshipColumns: DataColumn<ReferenceRelationship>[] = [
  {
    key: "relationshipType",
    header: t("catalog.features.referenceData.ui.referenceRecordListPage.relationship"),
    cell: (row) => row.relationshipType,
  },
  {
    key: "referenceId",
    header: t("catalog.features.referenceData.ui.referenceRecordListPage.reference.record"),
    cell: (row) => row.referenceId,
  },
];

function formatReferenceRecordOption(record: ReferenceRecord): string {
  return t("catalog.features.referenceData.ui.referenceRecordListPage.reference.record.option", {
    name: record.name,
    typeKey: record.type_key,
    key: record.key,
  });
}

export function ReferenceRecordListPage({
  data,
  query,
  referenceTypes,
  referenceRecords = [],
}: CatalogListRouteData<ReferenceRecord> & {
  referenceTypes: ReferenceType[];
  referenceRecords?: ReferenceRecord[];
}) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [typeKey, setTypeKey] = useState(referenceTypes[0]?.key ?? "");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [attributes, setAttributes] = useState("");
  const [relationships, setRelationships] = useState<ReferenceRelationship[]>([]);
  const [relationshipType, setRelationshipType] = useState("");
  const [relationshipReferenceId, setRelationshipReferenceId] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const typeOptions = useMemo(
    () =>
      referenceTypes.map((type) => ({
        label: t("catalog.features.referenceData.ui.referenceRecordListPage.reference.type.option", {
          name: type.name,
          key: type.key,
        }),
        value: type.key,
      })),
    [referenceTypes],
  );
  const referenceRecordOptions = useMemo(
    () =>
      referenceRecords.map((record) => ({
        label: formatReferenceRecordOption(record),
        value: record.reference_record_id,
      })),
    [referenceRecords],
  );

  async function handleCreate() {
    const referenceRecordId = createId("ref");
    await createReferenceRecord({
      referenceRecordId,
      typeKey,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
      attributes: parseAttributesInput(attributes),
      relationships,
    });
    addToast(t("catalog.features.referenceData.ui.referenceRecordListPage.reference.record.created"), "success");
    setShowCreate(false);
    setTypeKey(referenceTypes[0]?.key ?? "");
    setKey("");
    setName("");
    setDescription("");
    setAttributes("");
    setRelationships([]);
    setRelationshipType("");
    setRelationshipReferenceId("");
    revalidator.revalidate();
  }

  function handleAddRelationship() {
    const nextRelationship = {
      relationshipType: relationshipType.trim(),
      referenceId: relationshipReferenceId.trim(),
    };

    if (!nextRelationship.relationshipType || !nextRelationship.referenceId) {
      return;
    }

    setRelationships((current) => [
      ...current.filter(
        (relationship) =>
          relationship.relationshipType !== nextRelationship.relationshipType ||
          relationship.referenceId !== nextRelationship.referenceId,
      ),
      nextRelationship,
    ]);
    setRelationshipType("");
    setRelationshipReferenceId("");
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.referenceData.ui.referenceRecordListPage.reference.records")}
        entityName={t("catalog.features.referenceData.ui.referenceRecordListPage.reference.record")}
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.reference_record_id}
        getHref={(row) => `/reference-records/${row.reference_record_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <>
            <Select
              label={t("catalog.features.referenceData.ui.referenceRecordListPage.reference.type")}
              value={listControls.typeKey || ALL_TYPES}
              onValueChange={(value) => listControls.setTypeKey(value === ALL_TYPES ? "" : value)}
              items={[
                {
                  label: t("catalog.features.referenceData.ui.referenceRecordListPage.all.reference.types"),
                  value: ALL_TYPES,
                },
                ...typeOptions,
              ]}
            />
            <TextInput
              label={t("catalog.features.referenceData.ui.referenceRecordListPage.relationship")}
              value={listControls.relationshipType}
              onChange={(event) => listControls.setRelationshipType(event.target.value)}
            />
            <TextInput
              label={t("catalog.features.referenceData.ui.referenceTypeListPage.attribute.key")}
              value={listControls.attributeKey}
              onChange={(event) => listControls.setAttributeKey(event.target.value)}
            />
            <TextInput
              label={t("catalog.features.referenceData.ui.referenceRecordListPage.attribute.value")}
              value={listControls.attributeValue}
              onChange={(event) => listControls.setAttributeValue(event.target.value)}
            />
          </>
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          <BulkLifecycleActionBar
            entityName="Reference Records"
            selectedKeys={selectedKeys}
            filterSelection={{ mode: "filter", query }}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkReferenceRecordLifecycle}
            confirm={confirmBulkReferenceRecordLifecycle}
            onCompleted={revalidator.revalidate}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>
            {t("catalog.features.referenceData.ui.referenceRecordListPage.new.reference.record")}
          </Button>
        }
        headerActions={
          <LinkButton href={toCatalogAdminHref("/reference-types")} tone="secondary">
            {t("catalog.features.referenceData.ui.referenceRecordListPage.manage.reference.types")}
          </LinkButton>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.referenceData.ui.referenceRecordListPage.create.reference.record")}
        footer={
          <Button onClick={handleCreate}>
            {t("catalog.features.referenceData.ui.referenceRecordListPage.create")}
          </Button>
        }
      >
        <Stack gap={3}>
          {typeOptions.length > 0 ? (
            <Select
              label={t("catalog.features.referenceData.ui.referenceRecordListPage.reference.type")}
              items={typeOptions}
              value={typeKey}
              onValueChange={setTypeKey}
            />
          ) : (
            <TextInput
              label={t("catalog.features.referenceData.ui.referenceRecordListPage.type.key")}
              value={typeKey}
              onChange={(event) => setTypeKey(event.target.value)}
            />
          )}
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceRecordListPage.key.2")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceRecordListPage.name.2")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceRecordListPage.description")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Textarea
            label={t("catalog.features.referenceData.ui.referenceRecordListPage.attributes")}
            description={t("catalog.features.referenceData.ui.referenceRecordListPage.attributes.description")}
            value={attributes}
            onChange={(event) => setAttributes(event.target.value)}
            rows={7}
          />
          <Stack gap={2}>
            <Inline gap={2} align="end">
              <TextInput
                label={t("catalog.features.referenceData.ui.referenceRecordListPage.relationship")}
                value={relationshipType}
                onChange={(event) => setRelationshipType(event.target.value)}
              />
              <Combobox
                label={t("catalog.features.referenceData.ui.referenceRecordListPage.reference.record")}
                items={referenceRecordOptions}
                value={relationshipReferenceId}
                onValueChange={setRelationshipReferenceId}
                placeholder={t("catalog.features.referenceData.ui.referenceRecordListPage.choose.reference.record")}
                noMatchesLabel={t(
                  "catalog.features.referenceData.ui.referenceRecordListPage.no.reference.records.match",
                )}
              />
              <Button tone="secondary" onClick={handleAddRelationship}>
                {t("catalog.features.referenceData.ui.referenceRecordListPage.add.relationship")}
              </Button>
            </Inline>
            <DataTable
              rows={relationships}
              columns={[
                ...relationshipColumns,
                {
                  key: "actions",
                  header: "",
                  cell: (row) => (
                    <Button
                      tone="danger"
                      size="sm"
                      onClick={() =>
                        setRelationships((current) =>
                          current.filter(
                            (relationship) =>
                              relationship.relationshipType !== row.relationshipType ||
                              relationship.referenceId !== row.referenceId,
                          ),
                        )
                      }
                    >
                      {t("catalog.features.referenceData.ui.referenceRecordListPage.remove")}
                    </Button>
                  ),
                },
              ]}
              getRowId={(row) => `${row.relationshipType}:${row.referenceId}`}
              emptyTitle={t("catalog.features.referenceData.ui.referenceRecordListPage.no.relationships")}
            />
          </Stack>
        </Stack>
      </Dialog>
    </>
  );
}
