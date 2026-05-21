import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
import { useState } from "react";
import { Button, Dialog, Inline, KeyValueList, Stack, TextInput, Textarea } from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import {
  archiveReferenceType,
  deprecateReferenceType,
  publishReferenceType,
  reviseReferenceType,
  useReferenceType,
} from "./use-reference-data";
import { formatKeyList, parseKeyList } from "./reference-data-form";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [
        {
          label: t("catalog.features.referenceData.ui.referenceTypeDetailPage.publish"),
          action: "publish",
          tone: "primary",
        },
      ];
    case "active":
      return [
        {
          label: t("catalog.features.referenceData.ui.referenceTypeDetailPage.deprecate"),
          action: "deprecate",
          confirm: true,
          tone: "danger",
        },
      ];
    case "deprecated":
      return [
        {
          label: t("catalog.features.referenceData.ui.referenceTypeDetailPage.archive"),
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
      return t("catalog.features.referenceData.ui.referenceTypeDetailPage.published");
    case "deprecate":
      return t("catalog.features.referenceData.ui.referenceTypeDetailPage.deprecated");
    case "archive":
      return t("catalog.features.referenceData.ui.referenceTypeDetailPage.archived");
    default:
      return action;
  }
}

export function ReferenceTypeDetailPage({
  id,
  initialData,
}: {
  id: string;
  initialData?: Parameters<typeof useReferenceType>[1];
}) {
  const { data, loading, error, refresh } = useReferenceType(id, initialData);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAttributeKeys, setEditAttributeKeys] = useState("");

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      publish: () => publishReferenceType(id),
      deprecate: () => deprecateReferenceType(id),
      archive: () => archiveReferenceType(id),
    };
    await actions[action]?.();
    addToast(
      t("catalog.features.referenceData.ui.referenceTypeDetailPage.lifecycle.completed", {
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

    setEditKey(data.key);
    setEditName(data.name);
    setEditDescription(data.description ?? "");
    setEditAttributeKeys(formatKeyList(data.attribute_keys));
    setEditing(true);
  }

  async function handleRevise() {
    await reviseReferenceType(id, {
      key: editKey,
      name: localizedTextMapFromEnglish(editName),
      description: localizedTextMapFromEnglish(editDescription),
      attributeKeys: parseKeyList(editAttributeKeys),
    });
    addToast(t("catalog.features.referenceData.ui.referenceTypeDetailPage.reference.type.revised"), "success");
    setEditing(false);
    refresh();
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? t("catalog.features.referenceData.ui.referenceTypeDetailPage.reference.type")}
        breadcrumbs={[
          {
            label: t("catalog.features.referenceData.ui.referenceTypeDetailPage.reference.types"),
            href: "/reference-types",
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
                  {t("catalog.features.referenceData.ui.referenceTypeDetailPage.edit")}
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
              { key: t("catalog.features.referenceData.ui.referenceTypeDetailPage.key"), value: data.key },
              { key: t("catalog.features.referenceData.ui.referenceTypeDetailPage.name"), value: data.name },
              {
                key: t("catalog.features.referenceData.ui.referenceTypeDetailPage.description"),
                value: data.description ?? "—",
              },
              {
                key: t("catalog.features.referenceData.ui.referenceTypeDetailPage.attribute.keys"),
                value: data.attribute_keys.length > 0 ? data.attribute_keys.join(", ") : "—",
              },
              { key: t("catalog.features.referenceData.ui.referenceTypeDetailPage.status"), value: data.status },
              { key: t("catalog.features.referenceData.ui.referenceTypeDetailPage.updated"), value: data.updated_at },
            ]}
          />
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.referenceData.ui.referenceTypeDetailPage.edit.reference.type")}
        footer={
          <Button onClick={handleRevise}>{t("catalog.features.referenceData.ui.referenceTypeDetailPage.save")}</Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceTypeDetailPage.key")}
            value={editKey}
            onChange={(event) => setEditKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceTypeDetailPage.name")}
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.referenceData.ui.referenceTypeDetailPage.description")}
            value={editDescription}
            onChange={(event) => setEditDescription(event.target.value)}
          />
          <Textarea
            label={t("catalog.features.referenceData.ui.referenceTypeDetailPage.attribute.keys")}
            description={t("catalog.features.referenceData.ui.referenceTypeDetailPage.attribute.keys.description")}
            value={editAttributeKeys}
            onChange={(event) => setEditAttributeKeys(event.target.value)}
            rows={5}
          />
        </Stack>
      </Dialog>
    </>
  );
}
