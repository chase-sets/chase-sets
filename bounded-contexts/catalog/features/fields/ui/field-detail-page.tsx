import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
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
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import { useField, configureField, activateField, deprecateField, archiveField } from "./use-fields";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [{ label: t("catalog.features.fields.ui.fieldDetailPage.activate"), action: "activate", tone: "primary" }];
    case "active":
      return [{ label: t("catalog.features.fields.ui.fieldDetailPage.deprecate"), action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: t("catalog.features.fields.ui.fieldDetailPage.archive"), action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}

function lifecycleActionLabel(action: string) {
  switch (action) {
    case "activate":
      return t("catalog.features.fields.ui.fieldDetailPage.activated");
    case "deprecate":
      return t("catalog.features.fields.ui.fieldDetailPage.deprecated");
    case "archive":
      return t("catalog.features.fields.ui.fieldDetailPage.archived");
    default:
      return action;
  }
}

const valueTypeOptions = [
  { value: "string", label: t("catalog.features.fields.ui.fieldDetailPage.string") },
  { value: "number", label: t("catalog.features.fields.ui.fieldDetailPage.number") },
  { value: "boolean", label: t("catalog.features.fields.ui.fieldDetailPage.boolean") },
  { value: "date", label: t("catalog.features.fields.ui.fieldDetailPage.date") },
  { value: "json", label: t("catalog.features.fields.ui.fieldDetailPage.json") },
  { value: "localized_text", label: t("catalog.features.fields.ui.fieldDetailPage.localized.text") },
];

export function FieldDetailPage({ id, initialData }: { id: string; initialData?: Parameters<typeof useField>[1] }) {
  const { data, loading, error, refresh } = useField(id, initialData);
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
    addToast(t("catalog.features.fields.ui.fieldDetailPage.lifecycle.completed", {
      action: lifecycleActionLabel(action),
    }), "success");
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
      name: localizedTextMapFromEnglish(editName),
      description: localizedTextMapFromEnglish(editDescription),
      valueType: editValueType,
      behavior: { filterable: editFilterable, searchable: editSearchable, sortable: editSortable },
    });
    addToast(t("catalog.features.fields.ui.fieldDetailPage.field.configured"), "success");
    setEditing(false);
    refresh();
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? t("catalog.features.fields.ui.fieldDetailPage.field")}
        breadcrumbs={[
          { label: t("catalog.features.fields.ui.fieldDetailPage.fields"), href: "/fields" },
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
                  {t("catalog.features.fields.ui.fieldDetailPage.configure")}</Button>
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
              { key: t("catalog.features.fields.ui.fieldDetailPage.key"), value: data.key },
              { key: t("catalog.features.fields.ui.fieldDetailPage.name"), value: data.name },
              { key: t("catalog.features.fields.ui.fieldDetailPage.description"), value: data.description ?? "—" },
              { key: t("catalog.features.fields.ui.fieldDetailPage.value.type"), value: data.value_type },
              { key: t("catalog.features.fields.ui.fieldDetailPage.filterable"), value: data.filterable ? t("catalog.features.fields.ui.fieldDetailPage.yes") : t("catalog.features.fields.ui.fieldDetailPage.no") },
              { key: t("catalog.features.fields.ui.fieldDetailPage.searchable"), value: data.searchable ? t("catalog.features.fields.ui.fieldDetailPage.yes.2") : t("catalog.features.fields.ui.fieldDetailPage.no.2") },
              { key: t("catalog.features.fields.ui.fieldDetailPage.sortable"), value: data.sortable ? t("catalog.features.fields.ui.fieldDetailPage.yes.3") : t("catalog.features.fields.ui.fieldDetailPage.no.3") },
              { key: t("catalog.features.fields.ui.fieldDetailPage.status"), value: data.status },
              { key: t("catalog.features.fields.ui.fieldDetailPage.updated"), value: data.updated_at },
            ]}
          />
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.fields.ui.fieldDetailPage.configure.field")}
        footer={<Button onClick={handleConfigure}>{t("catalog.features.fields.ui.fieldDetailPage.save")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.fields.ui.fieldDetailPage.key")} value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label={t("catalog.features.fields.ui.fieldDetailPage.name")} value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label={t("catalog.features.fields.ui.fieldDetailPage.description")} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          <Select label={t("catalog.features.fields.ui.fieldDetailPage.value.type")} items={valueTypeOptions} value={editValueType} onValueChange={setEditValueType} />
          <Checkbox label={t("catalog.features.fields.ui.fieldDetailPage.filterable")} checked={editFilterable} onCheckedChange={(v) => setEditFilterable(v === true)} />
          <Checkbox label={t("catalog.features.fields.ui.fieldDetailPage.searchable")} checked={editSearchable} onCheckedChange={(v) => setEditSearchable(v === true)} />
          <Checkbox label={t("catalog.features.fields.ui.fieldDetailPage.sortable")} checked={editSortable} onCheckedChange={(v) => setEditSortable(v === true)} />
        </Stack>
      </Dialog>
    </>
  );
}


