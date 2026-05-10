import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
import { useState } from "react";
import {
  Button,
  Dialog,
  Inline,
  KeyValueList,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
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
      return [{ label: t("catalog.features.categories.ui.categoryDetailPage.publish"), action: "publish", tone: "primary" }];
    case "active":
      return [{ label: t("catalog.features.categories.ui.categoryDetailPage.deprecate"), action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: t("catalog.features.categories.ui.categoryDetailPage.archive"), action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}

function lifecycleActionLabel(action: string) {
  switch (action) {
    case "publish":
      return t("catalog.features.categories.ui.categoryDetailPage.published");
    case "deprecate":
      return t("catalog.features.categories.ui.categoryDetailPage.deprecated");
    case "archive":
      return t("catalog.features.categories.ui.categoryDetailPage.archived");
    default:
      return action;
  }
}

export function CategoryDetailPage({ id, initialData }: { id: string; initialData?: Parameters<typeof useCategory>[1] }) {
  const { data, loading, error, refresh } = useCategory(id, initialData);
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
    addToast(t("catalog.features.categories.ui.categoryDetailPage.lifecycle.completed", {
      action: lifecycleActionLabel(action),
    }), "success");
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
      name: localizedTextMapFromEnglish(editName),
      description: localizedTextMapFromEnglish(editDescription),
      parentCategoryId: editParentId || null,
      displayOrder: Number(editDisplayOrder) || 0,
    });
    addToast(t("catalog.features.categories.ui.categoryDetailPage.category.revised"), "success");
    setEditing(false);
    refresh();
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? t("catalog.features.categories.ui.categoryDetailPage.category")}
        breadcrumbs={[
          { label: t("catalog.features.categories.ui.categoryDetailPage.categories"), href: "/categories" },
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
                  {t("catalog.features.categories.ui.categoryDetailPage.edit")}</Button>
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
              { key: t("catalog.features.categories.ui.categoryDetailPage.key"), value: data.key },
              { key: t("catalog.features.categories.ui.categoryDetailPage.name"), value: data.name },
              { key: t("catalog.features.categories.ui.categoryDetailPage.description"), value: data.description ?? "—" },
              { key: t("catalog.features.categories.ui.categoryDetailPage.parent.category"), value: data.parent_category?.name ?? t("catalog.features.categories.ui.categoryDetailPage.none.root") },
              { key: t("catalog.features.categories.ui.categoryDetailPage.display.order"), value: String(data.display_order) },
              { key: t("catalog.features.categories.ui.categoryDetailPage.status"), value: data.status },
              { key: t("catalog.features.categories.ui.categoryDetailPage.updated"), value: data.updated_at },
            ]}
          />
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.categories.ui.categoryDetailPage.edit.category")}
        footer={<Button onClick={handleRevise}>{t("catalog.features.categories.ui.categoryDetailPage.save")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.categories.ui.categoryDetailPage.key")} value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryDetailPage.name")} value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryDetailPage.description")} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryDetailPage.parent.category.id")} value={editParentId} onChange={(e) => setEditParentId(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryDetailPage.display.order")} value={editDisplayOrder} onChange={(e) => setEditDisplayOrder(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}


