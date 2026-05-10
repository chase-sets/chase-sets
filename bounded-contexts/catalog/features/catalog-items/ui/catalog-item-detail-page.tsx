import { t } from "@chase-sets/localization";
import { useState } from "react";
import {
  Button,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  Stack,
  Text,
  TextInput,
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
  retireCatalogItem,
  archiveCatalogItem,
  setTags,
  setImageUrls,
  linkExternalProductReference,
  unlinkExternalProductReference,
} from "./use-catalog-items";

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

  return JSON.stringify(value);
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
    await apiSetFieldValue(id, fieldId, fieldValue);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.value.set"), "success");
    setShowSetField(false);
    setFieldId("");
    setFieldValue("");
    refresh();
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
      title: editTitle,
      subtitle: editSubtitle || null,
      description: editDescription || undefined,
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
    { key: "value", header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.value"), cell: (row) => formatFieldValue(row.value) },
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
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.language"), value: data.language_code },
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
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls")}>
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
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.product.references")}>
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
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.id")} value={fieldId} onChange={(e) => setFieldId(e.target.value)} />
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.value.2")} value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} />
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

