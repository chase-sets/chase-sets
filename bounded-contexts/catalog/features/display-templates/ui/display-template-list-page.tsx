import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  Dialog,
  Inline,
  Select,
  Stack,
  StatusPill,
  TextInput,
  Textarea,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { createDisplayTemplate, localizedTextMapFromEnglish } from "./use-display-templates";
import type { DisplayTemplate, DisplayTemplateTargetKind } from "./contracts";

const ALL_TARGET_KINDS = "__all__";

const statusOptions = [
  { label: t("catalog.features.displayTemplates.ui.displayTemplateListPage.draft"), value: "draft" },
  { label: t("catalog.features.displayTemplates.ui.displayTemplateListPage.active"), value: "active" },
  { label: t("catalog.features.displayTemplates.ui.displayTemplateListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.displayTemplates.ui.displayTemplateListPage.archived"), value: "archived" },
];

const targetKindOptions: Array<{ label: string; value: DisplayTemplateTargetKind }> = [
  { label: t("catalog.features.displayTemplates.ui.target.global"), value: "global" },
  { label: t("catalog.features.displayTemplates.ui.target.blueprint"), value: "blueprint" },
  { label: t("catalog.features.displayTemplates.ui.target.category"), value: "category" },
  { label: t("catalog.features.displayTemplates.ui.target.reference.record"), value: "reference-record" },
  { label: t("catalog.features.displayTemplates.ui.target.catalog.item"), value: "catalog-item" },
];

const columns: DataColumn<DisplayTemplate>[] = [
  { key: "key", header: t("catalog.features.displayTemplates.ui.displayTemplateListPage.key"), cell: (row) => row.key },
  {
    key: "name",
    header: t("catalog.features.displayTemplates.ui.displayTemplateListPage.name"),
    cell: (row) => row.name,
  },
  {
    key: "target",
    header: t("catalog.features.displayTemplates.ui.displayTemplateListPage.target"),
    cell: (row) => formatTarget(row.target_kind, row.target_id),
  },
  {
    key: "priority",
    header: t("catalog.features.displayTemplates.ui.displayTemplateListPage.priority"),
    cell: (row) => row.priority,
  },
  {
    key: "title_template",
    header: t("catalog.features.displayTemplates.ui.displayTemplateListPage.title.template"),
    cell: (row) => row.title_template,
  },
  {
    key: "status",
    header: t("catalog.features.displayTemplates.ui.displayTemplateListPage.status"),
    cell: (row) => <StatusPill>{row.status}</StatusPill>,
  },
];

export function DisplayTemplateListPage({ data, query }: CatalogListRouteData<DisplayTemplate>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetKind, setTargetKind] = useState<DisplayTemplateTargetKind>("blueprint");
  const [targetId, setTargetId] = useState("");
  const [priority, setPriority] = useState("10");
  const [titleTemplate, setTitleTemplate] = useState("");
  const [subtitleTemplate, setSubtitleTemplate] = useState("");

  async function handleCreate() {
    const displayTemplateId = createId("dtp");
    await createDisplayTemplate({
      displayTemplateId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
      target: targetKind === "global" ? { kind: "global" } : { kind: targetKind, id: targetId },
      priority: Number.parseInt(priority, 10) || 0,
      titleTemplate,
      subtitleTemplate: subtitleTemplate.trim() || null,
    });
    addToast(t("catalog.features.displayTemplates.ui.displayTemplateListPage.display.template.created"), "success");
    resetCreateForm();
    revalidator.revalidate();
  }

  function resetCreateForm() {
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setTargetKind("blueprint");
    setTargetId("");
    setPriority("10");
    setTitleTemplate("");
    setSubtitleTemplate("");
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.displayTemplates.ui.displayTemplateListPage.display.templates")}
        entityName={t("catalog.features.displayTemplates.ui.displayTemplateListPage.display.template")}
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.display_template_id}
        getHref={(row) => `/display-templates/${row.display_template_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <Select
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.target.kind")}
            value={listControls.targetKind || ALL_TARGET_KINDS}
            onValueChange={(value) => listControls.setTargetKind(value === ALL_TARGET_KINDS ? "" : value)}
            items={[
              {
                label: t("catalog.features.displayTemplates.ui.displayTemplateListPage.all.target.kinds"),
                value: ALL_TARGET_KINDS,
              },
              ...targetKindOptions,
            ]}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>
            {t("catalog.features.displayTemplates.ui.displayTemplateListPage.new.display.template")}
          </Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.displayTemplates.ui.displayTemplateListPage.create.display.template")}
        footer={
          <Inline gap={2}>
            <Button onClick={handleCreate}>
              {t("catalog.features.displayTemplates.ui.displayTemplateListPage.create")}
            </Button>
            <Button tone="secondary" onClick={resetCreateForm}>
              {t("catalog.features.displayTemplates.ui.displayTemplateListPage.cancel")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.key.2")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.name.2")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.description")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Select
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.target.kind")}
            value={targetKind}
            onValueChange={(value) => setTargetKind(value as DisplayTemplateTargetKind)}
            items={targetKindOptions}
          />
          {targetKind !== "global" ? (
            <TextInput
              label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.target.id")}
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            />
          ) : null}
          <TextInput
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.priority")}
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          />
          <Textarea
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.title.template")}
            value={titleTemplate}
            onChange={(event) => setTitleTemplate(event.target.value)}
            rows={3}
          />
          <Textarea
            label={t("catalog.features.displayTemplates.ui.displayTemplateListPage.subtitle.template")}
            value={subtitleTemplate}
            onChange={(event) => setSubtitleTemplate(event.target.value)}
            rows={3}
          />
        </Stack>
      </Dialog>
    </>
  );
}

export function formatTarget(kind: DisplayTemplateTargetKind, id: string | null): string {
  const label = targetKindOptions.find((option) => option.value === kind)?.label ?? kind;
  return kind === "global" ? label : `${label}: ${id ?? "—"}`;
}
