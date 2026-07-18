import { t } from "@chase-sets/localization";
import { useState } from "react";
import { Button, Dialog, Inline, KeyValueList, Select, Stack, TextInput, Textarea } from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import {
  archiveDisplayTemplate,
  deprecateDisplayTemplate,
  localizedTextMapFromEnglish,
  parseRequiredFieldKeys,
  publishDisplayTemplate,
  reviseDisplayTemplate,
  useDisplayTemplate,
} from "./use-display-templates";
import type { DisplayTemplateTargetKind } from "./contracts";
import { formatTarget } from "./display-template-list-page";

const targetKindOptions: Array<{ label: string; value: DisplayTemplateTargetKind }> = [
  { label: t("catalog.features.displayTemplates.ui.target.global"), value: "global" },
  { label: t("catalog.features.displayTemplates.ui.target.blueprint"), value: "blueprint" },
  { label: t("catalog.features.displayTemplates.ui.target.category"), value: "category" },
  { label: t("catalog.features.displayTemplates.ui.target.reference.record"), value: "reference-record" },
  { label: t("catalog.features.displayTemplates.ui.target.catalog.item"), value: "catalog-item" },
];

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [
        {
          label: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.publish"),
          action: "publish",
          tone: "primary",
        },
      ];
    case "active":
      return [
        {
          label: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.deprecate"),
          action: "deprecate",
          confirm: true,
          tone: "danger",
        },
      ];
    case "deprecated":
      return [
        {
          label: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.archive"),
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
      return t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.published");
    case "deprecate":
      return t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.deprecated");
    case "archive":
      return t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.archived");
    default:
      return action;
  }
}

export function DisplayTemplateDetailPage({
  id,
  initialData,
}: {
  id: string;
  initialData?: Parameters<typeof useDisplayTemplate>[1];
}) {
  const { data, loading, error, refresh } = useDisplayTemplate(id, initialData);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetKind, setTargetKind] = useState<DisplayTemplateTargetKind>("global");
  const [targetId, setTargetId] = useState("");
  const [priority, setPriority] = useState("0");
  const [titleTemplate, setTitleTemplate] = useState("");
  const [subtitleTemplate, setSubtitleTemplate] = useState("");

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      publish: () => publishDisplayTemplate(id),
      deprecate: () => deprecateDisplayTemplate(id),
      archive: () => archiveDisplayTemplate(id),
    };
    await actions[action]?.();
    addToast(
      t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.lifecycle.completed", {
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

    setKey(data.key);
    setName(data.name);
    setDescription(data.description ?? "");
    setTargetKind(data.target_kind);
    setTargetId(data.target_id ?? "");
    setPriority(String(data.priority));
    setTitleTemplate(data.title_template);
    setSubtitleTemplate(data.subtitle_template ?? "");
    setEditing(true);
  }

  async function handleRevise() {
    await reviseDisplayTemplate(id, {
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
      target: targetKind === "global" ? { kind: "global" } : { kind: targetKind, id: targetId },
      priority: Number.parseInt(priority, 10) || 0,
      titleTemplate,
      subtitleTemplate: subtitleTemplate.trim() || null,
    });
    addToast(t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.display.template.revised"), "success");
    setEditing(false);
    refresh();
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.display.template")}
        breadcrumbs={[
          {
            label: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.display.templates"),
            href: "/display-templates",
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
              {data.status !== "archived" ? (
                <Button tone="secondary" size="sm" onClick={startEditing}>
                  {t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.edit")}
                </Button>
              ) : null}
            </Inline>
          ) : undefined
        }
        loading={loading}
        notFound={!loading && !data}
        error={error}
      >
        {data ? (
          <Stack gap={6}>
            <KeyValueList
              items={[
                { key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.key"), value: data.key },
                { key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.name"), value: data.name },
                {
                  key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.description"),
                  value: data.description || "—",
                },
                {
                  key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.target"),
                  value: formatTarget(data.target_kind, data.target_id),
                },
                {
                  key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.priority"),
                  value: data.priority,
                },
                {
                  key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.title.template"),
                  value: data.title_template,
                },
                {
                  key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.subtitle.template"),
                  value: data.subtitle_template ?? "—",
                },
                {
                  key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.required.field.keys"),
                  value: parseRequiredFieldKeys(data.required_field_keys).join(", ") || "—",
                },
                { key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.status"), value: data.status },
                {
                  key: t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.updated"),
                  value: data.updated_at,
                },
              ]}
            />
          </Stack>
        ) : null}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.edit.display.template")}
        footer={
          <Button onClick={handleRevise}>
            {t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.save")}
          </Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.key")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.description")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Select
            label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.target.kind")}
            value={targetKind}
            onValueChange={(value) => setTargetKind(value as DisplayTemplateTargetKind)}
            items={targetKindOptions}
          />
          {targetKind !== "global" ? (
            <TextInput
              label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.target.id")}
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            />
          ) : null}
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.priority")}
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          />
          <Textarea
            label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.title.template")}
            value={titleTemplate}
            onChange={(event) => setTitleTemplate(event.target.value)}
            rows={3}
          />
          <Textarea
            label={t("catalog.features.displayTemplates.ui.displayTemplateDetailPage.subtitle.template")}
            value={subtitleTemplate}
            onChange={(event) => setSubtitleTemplate(event.target.value)}
            rows={3}
          />
        </Stack>
      </Dialog>
    </>
  );
}
