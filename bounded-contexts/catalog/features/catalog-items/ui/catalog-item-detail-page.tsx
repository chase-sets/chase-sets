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
} from "./use-catalog-items";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [{ label: "Publish", action: "publish", tone: "primary" }];
    case "active":
      return [{ label: "Retire", action: "retire", confirm: true, tone: "danger" }];
    case "retired":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
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
    addToast(`Catalog item ${action}d`, "success");
    refresh();
  }

  async function handlePublish() {
    const requiredIds = publishRequiredFieldIds.split(",").map((s) => s.trim()).filter(Boolean);
    await publishCatalogItem(id, publishBlueprintActive, requiredIds);
    addToast("Catalog item published", "success");
    setShowPublish(false);
    refresh();
  }

  async function handleAssignBlueprint() {
    await assignBlueprint(id, blueprintId);
    addToast("Blueprint assigned", "success");
    setShowAssignBlueprint(false);
    setBlueprintId("");
    refresh();
  }

  async function handleSetFieldValue() {
    await apiSetFieldValue(id, fieldId, fieldValue);
    addToast("Field value set", "success");
    setShowSetField(false);
    setFieldId("");
    setFieldValue("");
    refresh();
  }

  async function handleClearFieldValue(fId: string) {
    await clearFieldValue(id, fId);
    addToast("Field value cleared", "success");
    refresh();
  }

  async function handleAssignCategory() {
    await assignCategory(id, categoryId);
    addToast("Category assigned", "success");
    setShowAssignCategory(false);
    setCategoryId("");
    refresh();
  }

  async function handleRemoveCategory(catId: string) {
    await removeCategory(id, catId);
    addToast("Category removed", "success");
    refresh();
  }

  async function handleReviseMetadata() {
    await reviseMetadata(id, {
      title: editTitle,
      subtitle: editSubtitle || null,
      description: editDescription || undefined,
    });
    addToast("Metadata revised", "success");
    setShowEditMetadata(false);
    refresh();
  }

  function startEditMetadata() {
    if (data) {
      setEditTitle(data.title);
      setEditSubtitle(data.subtitle ?? "");
      setEditDescription(data.description ?? "");
      setShowEditMetadata(true);
    }
  }

  async function handleSetTags() {
    const tags = tagsInput.split(",").map((s) => s.trim()).filter(Boolean);
    await setTags(id, tags);
    addToast("Tags updated", "success");
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
    addToast("Image URLs updated", "success");
    setShowSetImageUrls(false);
    refresh();
  }

  function startSetImageUrls() {
    if (data) {
      setImageUrlsInput((data.image_urls ?? []).join("\n"));
      setShowSetImageUrls(true);
    }
  }

  const fieldValues = (data?.field_values ?? []) as FieldValue[];
  const categories = (data?.categories ?? []) as CategoryRef[];

  const fieldValueColumns: DataColumn<FieldValue>[] = [
    { key: "fieldId", header: "Field", cell: (row) => row.fieldName },
    { key: "value", header: "Value", cell: (row) => formatFieldValue(row.value) },
    {
      key: "actions",
      header: "",
      cell: (row) => data?.status !== "archived" ? (
        <Button size="sm" tone="danger" onClick={() => handleClearFieldValue(row.fieldId)}>Clear</Button>
      ) : null,
    },
  ];

  return (
    <>
      <EntityDetailPage
        title={data?.title ?? "Catalog Item"}
        breadcrumbs={[
          { label: "Catalog Items", href: "/catalog-items" },
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
                  Edit Metadata
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
                { key: "Title", value: data.title },
                { key: "Subtitle", value: data.subtitle ?? "—" },
                { key: "Description", value: data.description ?? "—" },
                { key: "Blueprint", value: data.blueprint?.name ?? "None" },
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at },
              ]}
            />

            {data.status === "draft" && !data.blueprint && (
              <PageSection title="Blueprint">
                <Button size="sm" onClick={() => setShowAssignBlueprint(true)}>Assign Blueprint</Button>
              </PageSection>
            )}

            <PageSection title="Field Values">
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowSetField(true)}>Set Field Value</Button>
                  </Inline>
                )}
                <DataTable
                  rows={fieldValues}
                  columns={fieldValueColumns}
                  getRowId={(row) => row.fieldId}
                  emptyTitle="No field values"
                />
              </Stack>
            </PageSection>

            <PageSection title="Categories">
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAssignCategory(true)}>Assign Category</Button>
                  </Inline>
                )}
                {categories.length === 0 ? (
                  <Text tone="secondary">No categories assigned.</Text>
                ) : (
                  <DataTable
                    rows={categories}
                    columns={[
                      { key: "categoryId", header: "Category", cell: (row) => row.name },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) => data.status !== "archived" ? (
                          <Button size="sm" tone="danger" onClick={() => handleRemoveCategory(row.categoryId)}>Remove</Button>
                        ) : null,
                      },
                    ]}
                    getRowId={(row) => row.categoryId}
                  />
                )}
              </Stack>
            </PageSection>

            <PageSection title="Tags">
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={startSetTags}>Set Tags</Button>
                  </Inline>
                )}
                {(data.tags ?? []).length === 0 ? (
                  <Text tone="secondary">No tags.</Text>
                ) : (
                  <Text>{(data.tags ?? []).join(", ")}</Text>
                )}
              </Stack>
            </PageSection>

            <PageSection title="Image URLs">
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={startSetImageUrls}>Set Image URLs</Button>
                  </Inline>
                )}
                {(data.image_urls ?? []).length === 0 ? (
                  <Text tone="secondary">No image URLs.</Text>
                ) : (
                  <Stack gap={1}>
                    {(data.image_urls ?? []).map((url, i) => (
                      <Text key={i}>{url}</Text>
                    ))}
                  </Stack>
                )}
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={showAssignBlueprint}
        onOpenChange={setShowAssignBlueprint}
        title="Assign Blueprint"
        footer={<Button onClick={handleAssignBlueprint}>Assign</Button>}
      >
        <TextInput label="Blueprint ID" value={blueprintId} onChange={(e) => setBlueprintId(e.target.value)} />
      </Dialog>

      <Dialog
        open={showSetField}
        onOpenChange={setShowSetField}
        title="Set Field Value"
        footer={<Button onClick={handleSetFieldValue}>Set</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Field ID" value={fieldId} onChange={(e) => setFieldId(e.target.value)} />
          <TextInput label="Value" value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} />
        </Stack>
      </Dialog>

      <Dialog
        open={showAssignCategory}
        onOpenChange={setShowAssignCategory}
        title="Assign Category"
        footer={<Button onClick={handleAssignCategory}>Assign</Button>}
      >
        <TextInput label="Category ID" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} />
      </Dialog>

      <Dialog
        open={showEditMetadata}
        onOpenChange={setShowEditMetadata}
        title="Edit Metadata"
        footer={<Button onClick={handleReviseMetadata}>Save</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          <TextInput label="Subtitle" value={editSubtitle} onChange={(e) => setEditSubtitle(e.target.value)} />
          <TextInput label="Description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
        </Stack>
      </Dialog>

      <Dialog
        open={showPublish}
        onOpenChange={setShowPublish}
        title="Publish Catalog Item"
        description="Confirm that the blueprint is active and provide required field IDs."
        footer={<Button onClick={handlePublish}>Publish</Button>}
      >
        <Stack gap={3}>
          <TextInput
            label="Required Field IDs (comma-separated)"
            value={publishRequiredFieldIds}
            onChange={(e) => setPublishRequiredFieldIds(e.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showSetTags}
        onOpenChange={setShowSetTags}
        title="Set Tags"
        description="Enter tags separated by commas."
        footer={<Button onClick={handleSetTags}>Save</Button>}
      >
        <TextInput
          label="Tags"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetImageUrls}
        onOpenChange={setShowSetImageUrls}
        title="Set Image URLs"
        description="Enter one URL per line."
        footer={<Button onClick={handleSetImageUrls}>Save</Button>}
      >
        <TextInput
          label="Image URLs"
          value={imageUrlsInput}
          onChange={(e) => setImageUrlsInput(e.target.value)}
        />
      </Dialog>
    </>
  );
}




