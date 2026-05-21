import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
import { useState } from "react";
import {
  Button,
  Combobox,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  Select,
  Stack,
  TextInput,
  Textarea,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import type { ReferenceRecord, ReferenceRelationship, ReferenceType } from "./contracts";
import {
  archiveReferenceRecord,
  deprecateReferenceRecord,
  publishReferenceRecord,
  reviseReferenceRecord,
  useReferenceRecord,
} from "./use-reference-data";
import { formatAttributesInput, formatAttributesSummary, parseAttributesInput } from "./reference-data-form";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [
        {
          label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.publish"),
          action: "publish",
          tone: "primary",
        },
      ];
    case "active":
      return [
        {
          label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.deprecate"),
          action: "deprecate",
          confirm: true,
          tone: "danger",
        },
      ];
    case "deprecated":
      return [
        {
          label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.archive"),
          action: "archive",
          confirm: true,
          tone: "danger",
        },
      ];
    default:
      return [];
  }
}

function lifecycleActionLabel(action: string) {
  switch (action) {
    case "publish":
      return t("catalog.features.referenceData.ui.referenceRecordDetailPage.published");
    case "deprecate":
      return t("catalog.features.referenceData.ui.referenceRecordDetailPage.deprecated");
    case "archive":
      return t("catalog.features.referenceData.ui.referenceRecordDetailPage.archived");
    default:
      return action;
  }
}

const relationshipColumns: DataColumn<ReferenceRelationship>[] = [
  {
    key: "relationshipType",
    header: t("catalog.features.referenceData.ui.referenceRecordDetailPage.relationship"),
    cell: (row) => row.relationshipType,
  },
  {
    key: "referenceId",
    header: t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.record.id"),
    cell: (row) => row.reference?.name ?? row.referenceId,
  },
];

function formatReferenceRecordOption(record: ReferenceRecord): string {
  return t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.record.option", {
    name: record.name,
    typeKey: record.type_key,
    key: record.key,
  });
}

export function ReferenceRecordDetailPage({
  id,
  initialData,
  referenceTypes,
  referenceRecords = [],
}: {
  id: string;
  initialData?: Parameters<typeof useReferenceRecord>[1];
  referenceTypes: ReferenceType[];
  referenceRecords?: ReferenceRecord[];
}) {
  const { data, loading, error, refresh } = useReferenceRecord(id, initialData);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [editTypeKey, setEditTypeKey] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAttributes, setEditAttributes] = useState("");
  const [editRelationships, setEditRelationships] = useState<ReferenceRelationship[]>([]);
  const [relationshipType, setRelationshipType] = useState("");
  const [relationshipReferenceId, setRelationshipReferenceId] = useState("");

  const typeOptions = referenceTypes.map((type) => ({
    label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.type.option", {
      name: type.name,
      key: type.key,
    }),
    value: type.key,
  }));
  const referenceRecordOptions = referenceRecords
    .filter((record) => record.reference_record_id !== id)
    .map((record) => ({
      label: formatReferenceRecordOption(record),
      value: record.reference_record_id,
    }));

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      publish: () => publishReferenceRecord(id),
      deprecate: () => deprecateReferenceRecord(id),
      archive: () => archiveReferenceRecord(id),
    };
    await actions[action]?.();
    addToast(
      t("catalog.features.referenceData.ui.referenceRecordDetailPage.lifecycle.completed", {
        action: lifecycleActionLabel(action),
      }),
      "success",
    );
    refresh();
  }

  function startEditing() {
    if (!data) {
      return;
    }

    setEditTypeKey(data.type_key);
    setEditKey(data.key);
    setEditName(data.name);
    setEditDescription(data.description ?? "");
    setEditAttributes(formatAttributesInput(data.attributes));
    setEditRelationships(data.relationships);
    setRelationshipType("");
    setRelationshipReferenceId("");
    setEditing(true);
  }

  async function handleRevise() {
    await reviseReferenceRecord(id, {
      typeKey: editTypeKey,
      key: editKey,
      name: localizedTextMapFromEnglish(editName),
      description: localizedTextMapFromEnglish(editDescription),
      attributes: parseAttributesInput(editAttributes),
      relationships: editRelationships,
    });
    addToast(t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.record.revised"), "success");
    setEditing(false);
    refresh();
  }

  const relationships = data?.relationships ?? [];

  function handleAddRelationship() {
    const nextRelationship = {
      relationshipType: relationshipType.trim(),
      referenceId: relationshipReferenceId.trim(),
    };

    if (!nextRelationship.relationshipType || !nextRelationship.referenceId) {
      return;
    }

    setEditRelationships((current) => [
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
      <EntityDetailPage
        title={data?.name ?? t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.record")}
        breadcrumbs={[
          {
            label: t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.records"),
            href: "/reference-records",
          },
          { label: data?.name ?? id },
        ]}
        actions={
          data ? (
            <Inline gap={2}>
              <LifecycleControls
                status={data.status}
                transitions={getTransitions(data.status)}
                onAction={handleLifecycleAction}
              />
              {data.status !== "archived" && (
                <Button tone="secondary" size="sm" onClick={startEditing}>
                  {t("catalog.features.referenceData.ui.referenceRecordDetailPage.edit")}
                </Button>
              )}
            </Inline>
          ) : undefined
        }
        loading={loading}
        notFound={!loading && !data}
        error={error}
      >
        {data && (
          <Stack gap={6}>
            <KeyValueList
              items={[
                { key: t("catalog.features.referenceData.ui.referenceRecordDetailPage.type"), value: data.type_key },
                { key: t("catalog.features.referenceData.ui.referenceRecordDetailPage.key"), value: data.key },
                { key: t("catalog.features.referenceData.ui.referenceRecordDetailPage.name"), value: data.name },
                {
                  key: t("catalog.features.referenceData.ui.referenceRecordDetailPage.description"),
                  value: data.description ?? "—",
                },
                {
                  key: t("catalog.features.referenceData.ui.referenceRecordDetailPage.attributes"),
                  value: formatAttributesSummary(data.attributes),
                },
                { key: t("catalog.features.referenceData.ui.referenceRecordDetailPage.status"), value: data.status },
                {
                  key: t("catalog.features.referenceData.ui.referenceRecordDetailPage.updated"),
                  value: data.updated_at,
                },
              ]}
            />

            <PageSection title={t("catalog.features.referenceData.ui.referenceRecordDetailPage.relationships")}>
              <DataTable
                rows={relationships}
                columns={relationshipColumns}
                getRowId={(row) => `${row.relationshipType}:${row.referenceId}`}
                emptyTitle={t("catalog.features.referenceData.ui.referenceRecordDetailPage.no.relationships")}
              />
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.referenceData.ui.referenceRecordDetailPage.edit.reference.record")}
        footer={
          <Button onClick={handleRevise}>
            {t("catalog.features.referenceData.ui.referenceRecordDetailPage.save")}
          </Button>
        }
      >
        <Stack gap={3}>
          {typeOptions.length > 0 ? (
            <Select
              label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.type")}
              items={typeOptions}
              value={editTypeKey}
              onValueChange={setEditTypeKey}
            />
          ) : (
            <TextInput
              label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.type.key")}
              value={editTypeKey}
              onChange={(event) => setEditTypeKey(event.target.value)}
            />
          )}
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.key")}
            value={editKey}
            onChange={(event) => setEditKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.name")}
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.description")}
            value={editDescription}
            onChange={(event) => setEditDescription(event.target.value)}
          />
          <Textarea
            label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.attributes")}
            description={t("catalog.features.referenceData.ui.referenceRecordDetailPage.attributes.description")}
            value={editAttributes}
            onChange={(event) => setEditAttributes(event.target.value)}
            rows={7}
          />
          <Stack gap={2}>
            <Inline gap={2} align="end">
              <TextInput
                label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.relationship")}
                value={relationshipType}
                onChange={(event) => setRelationshipType(event.target.value)}
              />
              <Combobox
                label={t("catalog.features.referenceData.ui.referenceRecordDetailPage.reference.record")}
                items={referenceRecordOptions}
                value={relationshipReferenceId}
                onValueChange={setRelationshipReferenceId}
                placeholder={t("catalog.features.referenceData.ui.referenceRecordDetailPage.choose.reference.record")}
                noMatchesLabel={t(
                  "catalog.features.referenceData.ui.referenceRecordDetailPage.no.reference.records.match",
                )}
              />
              <Button tone="secondary" onClick={handleAddRelationship}>
                {t("catalog.features.referenceData.ui.referenceRecordDetailPage.add.relationship")}
              </Button>
            </Inline>
            <DataTable
              rows={editRelationships}
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
                        setEditRelationships((current) =>
                          current.filter(
                            (relationship) =>
                              relationship.relationshipType !== row.relationshipType ||
                              relationship.referenceId !== row.referenceId,
                          ),
                        )
                      }
                    >
                      {t("catalog.features.referenceData.ui.referenceRecordDetailPage.remove")}
                    </Button>
                  ),
                },
              ]}
              getRowId={(row) => `${row.relationshipType}:${row.referenceId}`}
              emptyTitle={t("catalog.features.referenceData.ui.referenceRecordDetailPage.no.relationships")}
            />
          </Stack>
        </Stack>
      </Dialog>
    </>
  );
}
