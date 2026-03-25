import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  Inline,
  KeyValueList,
  Select,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { useToasts } from "../../shared/ui/toasts";
import { EntityDetailPage } from "../../shared/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../shared/ui/lifecycle-controls";
import { useField, configureField, activateField, deprecateField, archiveField } from "./use-fields";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [{ label: "Activate", action: "activate", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}

const valueTypeOptions = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
];

export function FieldDetailPage({ id }: { id: string }) {
  const { data, loading, error, refresh } = useField(id);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editValueType, setEditValueType] = useState("string");
  const [editFilterable, setEditFilterable] = useState(false);
  const [editSearchable, setEditSearchable] = useState(false);
  const [editSortable, setEditSortable] = useState(false);

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      activate: () => activateField(id),
      deprecate: () => deprecateField(id),
      archive: () => archiveField(id),
    };
    await actions[action]?.();
    addToast(`Field ${action}d`, "success");
    refresh();
  }

  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditValueType(data.value_type);
      setEditFilterable(data.filterable);
      setEditSearchable(data.searchable);
      setEditSortable(data.sortable);
      setEditing(true);
    }
  }

  async function handleConfigure() {
    await configureField(id, {
      key: editKey,
      name: editName,
      description: editDescription || undefined,
      valueType: editValueType,
      behavior: { filterable: editFilterable, searchable: editSearchable, sortable: editSortable },
    });
    addToast("Field configured", "success");
    setEditing(false);
    refresh();
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? "Field"}
        breadcrumbs={[
          { label: "Fields", href: "#/fields" },
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
                  Configure
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
              { key: "Value Type", value: data.value_type },
              { key: "Filterable", value: data.filterable ? "Yes" : "No" },
              { key: "Searchable", value: data.searchable ? "Yes" : "No" },
              { key: "Sortable", value: data.sortable ? "Yes" : "No" },
              { key: "Status", value: data.status },
              { key: "Updated", value: data.updated_at },
            ]}
          />
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Configure Field"
        footer={<Button onClick={handleConfigure}>Save</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label="Description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          <Select label="Value Type" items={valueTypeOptions} value={editValueType} onValueChange={setEditValueType} />
          <Checkbox label="Filterable" checked={editFilterable} onCheckedChange={(v) => setEditFilterable(v === true)} />
          <Checkbox label="Searchable" checked={editSearchable} onCheckedChange={(v) => setEditSearchable(v === true)} />
          <Checkbox label="Sortable" checked={editSortable} onCheckedChange={(v) => setEditSortable(v === true)} />
        </Stack>
      </Dialog>
    </>
  );
}

