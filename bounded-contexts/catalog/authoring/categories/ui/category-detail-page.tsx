import { useState } from "react";
import {
  Button,
  Dialog,
  Inline,
  KeyValueList,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { useToasts } from "../../support/ui/toasts";
import { EntityDetailPage } from "../../support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../support/ui/lifecycle-controls";
import {
  useCategory,
  reviseCategory,
  publishCategory,
  deprecateCategory,
  archiveCategory,
} from "./use-categories";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [{ label: "Publish", action: "publish", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}

export function CategoryDetailPage({ id }: { id: string }) {
  const { data, loading, error, refresh } = useCategory(id);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editParentId, setEditParentId] = useState("");
  const [editDisplayOrder, setEditDisplayOrder] = useState("0");

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      publish: () => publishCategory(id),
      deprecate: () => deprecateCategory(id),
      archive: () => archiveCategory(id),
    };
    await actions[action]?.();
    addToast(`Category ${action}ed`, "success");
    refresh();
  }

  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditParentId(data.parent_category?.categoryId ?? "");
      setEditDisplayOrder(String(data.display_order));
      setEditing(true);
    }
  }

  async function handleRevise() {
    await reviseCategory(id, {
      key: editKey,
      name: editName,
      description: editDescription || undefined,
      parentCategoryId: editParentId || null,
      displayOrder: Number(editDisplayOrder) || 0,
    });
    addToast("Category revised", "success");
    setEditing(false);
    refresh();
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? "Category"}
        breadcrumbs={[
          { label: "Categories", href: "#/categories" },
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
                  Edit
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
          <KeyValueList
            items={[
              { key: "Key", value: data.key },
              { key: "Name", value: data.name },
              { key: "Description", value: data.description ?? "—" },
              { key: "Parent Category", value: data.parent_category?.name ?? "None (root)" },
              { key: "Display Order", value: String(data.display_order) },
              { key: "Status", value: data.status },
              { key: "Updated", value: data.updated_at },
            ]}
          />
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit Category"
        footer={<Button onClick={handleRevise}>Save</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label="Description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          <TextInput label="Parent Category ID" value={editParentId} onChange={(e) => setEditParentId(e.target.value)} />
          <TextInput label="Display Order" value={editDisplayOrder} onChange={(e) => setEditDisplayOrder(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}




