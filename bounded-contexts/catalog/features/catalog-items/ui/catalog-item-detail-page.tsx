import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useState } from "react";
import {
  Button,
  Combobox,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  ProgressiveDisclosure,
  Stack,
  Text,
  TextInput,
  Textarea,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import {
  useCatalogItem,
  assignBlueprint,
  setFieldValue as apiSetFieldValue,
  clearFieldValue,
  assignCategory,
  removeCategory,
  publishCatalogItem,
  reviseMetadata,
  localizedTextMapFromEnglish,
  retireCatalogItem,
  archiveCatalogItem,
  setTags,
  setImageUrls,
  linkExternalProductReference,
  unlinkExternalProductReference,
} from "./use-catalog-items";
import { useFieldList } from "../../fields/ui/use-fields";
import type { ReferenceRecord } from "../../reference-data/ui/contracts";
import { useReferenceRecordList } from "../../reference-data/ui/use-reference-data";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [{ label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish"), action: "publish", tone: "primary" }];
    case "active":
      return [{ label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.retire"), action: "retire", confirm: true, tone: "danger" }];
    case "retired":
      return [{ label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.archive"), action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}

function lifecycleActionLabel(action: string) {
  switch (action) {
    case "publish":
      return t("catalog.features.catalogItems.ui.catalogItemDetailPage.published");
    case "retire":
      return t("catalog.features.catalogItems.ui.catalogItemDetailPage.retired");
    case "archive":
      return t("catalog.features.catalogItems.ui.catalogItemDetailPage.archived");
    default:
      return action;
  }
}

interface FieldValue {
  fieldId: string;
  fieldName: string;
  value: unknown;
  reference?: {
    referenceId: string;
    typeKey: string;
    key: string;
    name: string;
    attributes: unknown;
    relationships: Array<{
      relationshipType: string;
      referenceId: string;
      reference?: NonNullable<FieldValue["reference"]>;
    }>;
    status: string;
  } | null;
}

interface CategoryRef {
  categoryId: string;
  name: string;
}

type ExternalProductReference = NonNullable<
  ReturnType<typeof useCatalogItem>["data"]
>["external_product_references"][number];

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "object" && "values" in value) {
    const values = (value as { defaultLocale?: string; values?: Record<string, string> }).values ?? {};
    return values.en ?? Object.values(values)[0] ?? "—";
  }

  return JSON.stringify(value);
}

function formatFieldValueRow(row: FieldValue): string {
  if (!row.reference) {
    return formatFieldValue(row.value);
  }

  const attributeText = isRecord(row.reference.attributes)
    ? Object.entries(row.reference.attributes)
        .map(([key, value]) => `${key}: ${formatFieldValue(value)}`)
        .join(", ")
    : "";
  const relationshipText = row.reference.relationships
    .map((relationship) => {
      const target = relationship.reference?.name ?? relationship.referenceId;

      return `${relationship.relationshipType}: ${target}`;
    })
    .join(", ");
  const details = [attributeText, relationshipText].filter(Boolean).join("; ");

  return details.length > 0
    ? `${row.reference.name} (${row.reference.typeKey}) - ${details}`
    : `${row.reference.name} (${row.reference.typeKey})`;
}

function formatReferenceRecordLabel(record: ReferenceRecord): string {
  return t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.record.option", {
    name: record.name,
    typeKey: record.type_key,
    key: record.key,
  });
}

function parseFieldValueInput(value: string): unknown {
  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function CatalogItemDetailPage({ id, initialData }: { id: string; initialData?: Parameters<typeof useCatalogItem>[1] }) {
  const { data, loading, error, refresh } = useCatalogItem(id, initialData);
  const { addToast } = useToasts();

  // Blueprint assignment
  const [showAssignBlueprint, setShowAssignBlueprint] = useState(false);
  const [blueprintId, setBlueprintId] = useState("");

  // Field values
  const [showSetField, setShowSetField] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [referenceRecordId, setReferenceRecordId] = useState("");

  // Category assignment
  const [showAssignCategory, setShowAssignCategory] = useState(false);
  const [categoryId, setCategoryId] = useState("");

  // Metadata editing
  const [showEditMetadata, setShowEditMetadata] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editSubtitle, setEditSubtitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLanguageCode, setEditLanguageCode] = useState("");

  // Publish dialog
  const [showPublish, setShowPublish] = useState(false);
  const [publishBlueprintActive, setPublishBlueprintActive] = useState(true);
  const [publishRequiredFieldIds, setPublishRequiredFieldIds] = useState("");

  // Tags
  const [showSetTags, setShowSetTags] = useState(false);
  const [tagsInput, setTagsInput] = useState("");

  // Image URLs
  const [showSetImageUrls, setShowSetImageUrls] = useState(false);
  const [imageUrlsInput, setImageUrlsInput] = useState("");

  // External product references
  const [showLinkExternalReference, setShowLinkExternalReference] = useState(false);
  const [externalProviderKey, setExternalProviderKey] = useState("tcgplayer");
  const [externalKey, setExternalKey] = useState("");
  const [externalSelectedOptions, setExternalSelectedOptions] = useState("");
  const { data: fieldsData } = useFieldList("limit=500&status=active");
  const { data: referenceRecordsData } = useReferenceRecordList("limit=500&status=active");
  const fields = fieldsData?.items ?? [];
  const referenceRecords = referenceRecordsData?.items ?? [];
  const selectedField = fields.find((field) => field.field_id === fieldId) ?? null;
  const selectedFieldIsReference = selectedField?.value_type === "reference";
  const fieldOptions = fields.map((field) => ({
    value: field.field_id,
    label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.option", {
      name: field.name,
      key: field.key,
    }),
  }));
  const referenceRecordOptions = referenceRecords.map((record) => ({
    value: record.reference_record_id,
    label: formatReferenceRecordLabel(record),
  }));

  async function handleLifecycleAction(action: string) {
    if (action === "publish") {
      setShowPublish(true);
      return;
    }
    const actions: Record<string, () => Promise<unknown>> = {
      retire: () => retireCatalogItem(id),
      archive: () => archiveCatalogItem(id),
    };
    await actions[action]?.();
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.lifecycle.completed", {
      action: lifecycleActionLabel(action),
    }), "success");
    refresh();
  }

  async function handlePublish() {
    const requiredIds = publishRequiredFieldIds.split(",").map((s) => s.trim()).filter(Boolean);
    await publishCatalogItem(id, publishBlueprintActive, requiredIds);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.catalog.item.published"), "success");
    setShowPublish(false);
    refresh();
  }

  async function handleAssignBlueprint() {
    await assignBlueprint(id, blueprintId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint.assigned"), "success");
    setShowAssignBlueprint(false);
    setBlueprintId("");
    refresh();
  }

  async function handleSetFieldValue() {
    const value = selectedFieldIsReference && referenceRecordId
      ? { referenceId: referenceRecordId }
      : parseFieldValueInput(fieldValue);

    await apiSetFieldValue(id, fieldId, value);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.value.set"), "success");
    setShowSetField(false);
    setFieldId("");
    setFieldValue("");
    setReferenceRecordId("");
    refresh();
  }

  function handleFieldSelection(nextFieldId: string) {
    setFieldId(nextFieldId);
    setFieldValue("");
    setReferenceRecordId("");
  }

  async function handleClearFieldValue(fId: string) {
    await clearFieldValue(id, fId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.value.cleared"), "success");
    refresh();
  }

  async function handleAssignCategory() {
    await assignCategory(id, categoryId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.category.assigned"), "success");
    setShowAssignCategory(false);
    setCategoryId("");
    refresh();
  }

  async function handleRemoveCategory(catId: string) {
    await removeCategory(id, catId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.category.removed"), "success");
    refresh();
  }

  async function handleReviseMetadata() {
    await reviseMetadata(id, {
      title: localizedTextMapFromEnglish(editTitle),
      subtitle: editSubtitle ? localizedTextMapFromEnglish(editSubtitle) : null,
      description: localizedTextMapFromEnglish(editDescription),
      languageCode: editLanguageCode || "en",
    });
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.metadata.revised"), "success");
    setShowEditMetadata(false);
    refresh();
  }

  function startEditMetadata() {
    if (data) {
      setEditTitle(data.title);
      setEditSubtitle(data.subtitle ?? "");
      setEditDescription(data.description ?? "");
      setEditLanguageCode(data.language_code ?? "en");
      setShowEditMetadata(true);
    }
  }

  async function handleSetTags() {
    const tags = tagsInput.split(",").map((s) => s.trim()).filter(Boolean);
    await setTags(id, tags);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags.updated"), "success");
    setShowSetTags(false);
    refresh();
  }

  function startSetTags() {
    if (data) {
      setTagsInput((data.tags ?? []).join(", "));
      setShowSetTags(true);
    }
  }

  async function handleSetImageUrls() {
    const urls = imageUrlsInput.split("\n").map((s) => s.trim()).filter(Boolean);
    await setImageUrls(id, urls);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls.updated"), "success");
    setShowSetImageUrls(false);
    refresh();
  }

  function startSetImageUrls() {
    if (data) {
      setImageUrlsInput((data.image_urls ?? []).join("\n"));
      setShowSetImageUrls(true);
    }
  }

  async function handleLinkExternalReference() {
    const selectedOptions = externalSelectedOptions
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [dimensionId = "", optionId = ""] = entry.split(":");

        return {
          dimensionId: dimensionId.trim(),
          optionId: optionId.trim(),
        };
      })
      .filter((entry) => entry.dimensionId.length > 0 && entry.optionId.length > 0);

    await linkExternalProductReference(
      id,
      externalProviderKey,
      externalKey,
      selectedOptions,
    );
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.reference.linked"), "success");
    setShowLinkExternalReference(false);
    setExternalProviderKey("tcgplayer");
    setExternalKey("");
    setExternalSelectedOptions("");
    refresh();
  }

  async function handleUnlinkExternalReference(reference: ExternalProductReference) {
    await unlinkExternalProductReference(id, reference.providerKey, reference.externalKey);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.reference.unlinked"), "success");
    refresh();
  }

  const fieldValues = (data?.field_values ?? []) as FieldValue[];
  const categories = (data?.categories ?? []) as CategoryRef[];
  const externalReferences = data?.external_product_references ?? [];

  const fieldValueColumns: DataColumn<FieldValue>[] = [
    { key: "fieldId", header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.field"), cell: (row) => row.fieldName },
    { key: "value", header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.value"), cell: (row) => formatFieldValueRow(row) },
    {
      key: "actions",
      header: "",
      cell: (row) => data?.status !== "archived" ? (
        <Button size="sm" tone="danger" onClick={() => handleClearFieldValue(row.fieldId)}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.clear")}</Button>
      ) : null,
    },
  ];

  return (
    <>
      <EntityDetailPage
        title={data?.title ?? t("catalog.features.catalogItems.ui.catalogItemDetailPage.catalog.item")}
        breadcrumbs={[
          { label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.catalog.items"), href: "/catalog-items" },
          { label: data?.title ?? id },
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
                <Button tone="secondary" size="sm" onClick={startEditMetadata}>
                  {t("catalog.features.catalogItems.ui.catalogItemDetailPage.edit.metadata")}</Button>
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
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.title"), value: data.title },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.subtitle"), value: data.subtitle ?? "—" },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.language"), value: formatLanguageCodeLabel(data.language_code) },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.description"), value: data.description ?? "—" },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint"), value: data.blueprint?.name ?? t("catalog.features.catalogItems.ui.catalogItemDetailPage.none") },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.status"), value: data.status },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.updated"), value: data.updated_at },
              ]}
            />

            {data.status === "draft" && !data.blueprint && (
              <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint")}>
                <Button size="sm" onClick={() => setShowAssignBlueprint(true)}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.blueprint")}</Button>
              </PageSection>
            )}

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.values")}>
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowSetField(true)}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.field.value")}</Button>
                  </Inline>
                )}
                <DataTable
                  rows={fieldValues}
                  columns={fieldValueColumns}
                  getRowId={(row) => row.fieldId}
                  emptyTitle={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.field.values")}
                />
              </Stack>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.categories")}>
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAssignCategory(true)}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.category")}</Button>
                  </Inline>
                )}
                {categories.length === 0 ? (
                  <Text tone="secondary">{t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.categories.assigned")}</Text>
                ) : (
                  <DataTable
                    rows={categories}
                    columns={[
                      { key: "categoryId", header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.category"), cell: (row) => row.name },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) => data.status !== "archived" ? (
                          <Button size="sm" tone="danger" onClick={() => handleRemoveCategory(row.categoryId)}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.remove")}</Button>
                        ) : null,
                      },
                    ]}
                    getRowId={(row) => row.categoryId}
                  />
                )}
              </Stack>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags")}>
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags")}
                summary={(data.tags ?? []).length === 0
                  ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.tags")
                  : t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags.summary", {
                      count: (data.tags ?? []).length,
                    })}
                tone="info"
              >
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={startSetTags}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.tags")}</Button>
                  </Inline>
                )}
                {(data.tags ?? []).length === 0 ? (
                  <Text tone="secondary">{t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.tags")}</Text>
                ) : (
                  <Text>{(data.tags ?? []).join(", ")}</Text>
                )}
              </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls")}>
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls")}
                summary={(data.image_urls ?? []).length === 0
                  ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.image.urls")
                  : t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls.summary", {
                      count: (data.image_urls ?? []).length,
                    })}
                tone="info"
              >
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={startSetImageUrls}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.image.urls")}</Button>
                  </Inline>
                )}
                {(data.image_urls ?? []).length === 0 ? (
                  <Text tone="secondary">{t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.image.urls")}</Text>
                ) : (
                  <Stack gap={1}>
                    {(data.image_urls ?? []).map((url, i) => (
                      <Text key={i}>{url}</Text>
                    ))}
                  </Stack>
                )}
              </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.product.references")}>
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.product.references")}
                summary={externalReferences.length === 0
                  ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.external.references")
                  : t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.references.summary", {
                      count: externalReferences.length,
                    })}
                tone={externalReferences.length > 0 ? "info" : "neutral"}
              >
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowLinkExternalReference(true)}>
                      {t("catalog.features.catalogItems.ui.catalogItemDetailPage.link.external.reference")}</Button>
                  </Inline>
                )}
                <DataTable
                  rows={externalReferences}
                  columns={[
                    {
                      key: "provider",
                      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.provider"),
                      cell: (row) => row.providerKey,
                    },
                    {
                      key: "externalKey",
                      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.key"),
                      cell: (row) => row.externalKey,
                    },
                    {
                      key: "options",
                      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options"),
                      cell: (row) =>
                        row.selectedOptions.length > 0
                          ? row.selectedOptions
                              .map((option) =>
                                t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.option.reference", {
                                  dimensionId: option.dimensionId,
                                  optionId: option.optionId,
                                }),
                              )
                              .join(", ")
                          : t("catalog.features.catalogItems.ui.catalogItemDetailPage.none"),
                    },
                    {
                      key: "actions",
                      header: "",
                      cell: (row) => data.status !== "archived" ? (
                        <Button size="sm" tone="danger" onClick={() => handleUnlinkExternalReference(row)}>
                          {t("catalog.features.catalogItems.ui.catalogItemDetailPage.unlink")}</Button>
                      ) : null,
                    },
                  ]}
                  getRowId={(row) => `${row.providerKey}:${row.externalKey}`}
                  emptyTitle={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.external.references")}
                />
              </Stack>
              </ProgressiveDisclosure>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={showAssignBlueprint}
        onOpenChange={setShowAssignBlueprint}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.blueprint.2")}
        footer={<Button onClick={handleAssignBlueprint}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign")}</Button>}
      >
        <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint.id")} value={blueprintId} onChange={(e) => setBlueprintId(e.target.value)} />
      </Dialog>

      <Dialog
        open={showSetField}
        onOpenChange={setShowSetField}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.field.value.2")}
        footer={<Button onClick={handleSetFieldValue}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.set")}</Button>}
      >
        <Stack gap={3}>
          {fieldOptions.length > 0 ? (
            <Combobox
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.field")}
              items={fieldOptions}
              value={fieldId}
              onValueChange={handleFieldSelection}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.choose.field")}
              noMatchesLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.fields.match")}
            />
          ) : (
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.id")}
              value={fieldId}
              onChange={(event) => handleFieldSelection(event.target.value)}
            />
          )}
          {selectedFieldIsReference ? (
            <Combobox
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.record")}
              items={referenceRecordOptions}
              value={referenceRecordId}
              onValueChange={setReferenceRecordId}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.choose.reference.record")}
              noMatchesLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.reference.records.match")}
            />
          ) : (
            <Textarea
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.value.2")}
              description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.value.description")}
              value={fieldValue}
              onChange={(event) => setFieldValue(event.target.value)}
              rows={4}
            />
          )}
        </Stack>
      </Dialog>

      <Dialog
        open={showAssignCategory}
        onOpenChange={setShowAssignCategory}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.category.2")}
        footer={<Button onClick={handleAssignCategory}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.2")}</Button>}
      >
        <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.category.id")} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} />
      </Dialog>

      <Dialog
        open={showEditMetadata}
        onOpenChange={setShowEditMetadata}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.edit.metadata.2")}
        footer={<Button onClick={handleReviseMetadata}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.save")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.title")} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.subtitle")} value={editSubtitle} onChange={(e) => setEditSubtitle(e.target.value)} />
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.language.code")} value={editLanguageCode} onChange={(e) => setEditLanguageCode(e.target.value)} />
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.description")} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
        </Stack>
      </Dialog>

      <Dialog
        open={showPublish}
        onOpenChange={setShowPublish}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish.catalog.item")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.confirm.that.the.blueprint.is.active")}
        footer={<Button onClick={handlePublish}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish.2")}</Button>}
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.required.field.ids.comma.separated")}
            value={publishRequiredFieldIds}
            onChange={(e) => setPublishRequiredFieldIds(e.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showSetTags}
        onOpenChange={setShowSetTags}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.tags.2")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.enter.tags.separated.by.commas")}
        footer={<Button onClick={handleSetTags}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.save.2")}</Button>}
      >
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags.2")}
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetImageUrls}
        onOpenChange={setShowSetImageUrls}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.image.urls.2")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.enter.one.url.per.line")}
        footer={<Button onClick={handleSetImageUrls}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.save.3")}</Button>}
      >
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls.2")}
          value={imageUrlsInput}
          onChange={(e) => setImageUrlsInput(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showLinkExternalReference}
        onOpenChange={setShowLinkExternalReference}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.link.external.reference.2")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.reference.description")}
        footer={<Button onClick={handleLinkExternalReference}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.link")}</Button>}
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.provider")}
            value={externalProviderKey}
            onChange={(event) => setExternalProviderKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.key")}
            value={externalKey}
            onChange={(event) => setExternalKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options.2")}
            value={externalSelectedOptions}
            onChange={(event) => setExternalSelectedOptions(event.target.value)}
            placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options.placeholder")}
          />
        </Stack>
      </Dialog>
    </>
  );
}
