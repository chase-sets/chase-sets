import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState } from "react";
import {
  Button,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  Select,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import {
  useDimension,
  reviseDimension,
  activateDimension,
  deprecateDimension,
  archiveDimension,
  addOption,
  reviseOption,
  deprecateOption,
  reactivateOption,
  reorderOptions,
} from "./use-dimensions";
import type { DimensionOption } from "./contracts";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [{ label: t("catalog.features.dimensions.ui.dimensionDetailPage.activate"), action: "activate", tone: "primary" }];
    case "active":
      return [{ label: t("catalog.features.dimensions.ui.dimensionDetailPage.deprecate"), action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: t("catalog.features.dimensions.ui.dimensionDetailPage.archive"), action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}

function lifecycleActionLabel(action: string) {
  switch (action) {
    case "activate":
      return t("catalog.features.dimensions.ui.dimensionDetailPage.activated");
    case "deprecate":
      return t("catalog.features.dimensions.ui.dimensionDetailPage.deprecated");
    case "archive":
      return t("catalog.features.dimensions.ui.dimensionDetailPage.archived");
    default:
      return action;
  }
}

const optionColumns: DataColumn<DimensionOption>[] = [
  { key: "code", header: t("catalog.features.dimensions.ui.dimensionDetailPage.code"), cell: (row) => row.code },
  {
    key: "labels",
    header: t("catalog.features.dimensions.ui.dimensionDetailPage.labels"),
    cell: (row) =>
      row.labels && row.labels.length > 0
        ? row.labels.map((l) => `${l.locale}: ${l.value}`).join(", ")
        : "—",
  },
  { key: "numeric_value", header: t("catalog.features.dimensions.ui.dimensionDetailPage.numeric.value"), cell: (row) => row.numeric_value ?? "—" },
  { key: "display_order", header: t("catalog.features.dimensions.ui.dimensionDetailPage.order"), cell: (row) => row.display_order },
  { key: "status", header: t("catalog.features.dimensions.ui.dimensionDetailPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const valueKindOptions = [
  { label: t("catalog.features.dimensions.ui.dimensionDetailPage.unordered"), value: "unordered" },
  { label: t("catalog.features.dimensions.ui.dimensionDetailPage.ordered"), value: "ordered" },
  { label: t("catalog.features.dimensions.ui.dimensionDetailPage.numeric"), value: "numeric" },
];

interface LabelEntry {
  locale: string;
  value: string;
}

export function DimensionDetailPage({ id, initialData }: { id: string; initialData?: Parameters<typeof useDimension>[1] }) {
  const { data, loading, error, refresh } = useDimension(id, initialData);
  const { addToast } = useToasts();

  // Edit dimension
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editValueKind, setEditValueKind] = useState("unordered");

  // Add option
  const [showAddOption, setShowAddOption] = useState(false);
  const [optionCode, setOptionCode] = useState("");
  const [optionNumericValue, setOptionNumericValue] = useState("");
  const [optionLabels, setOptionLabels] = useState<LabelEntry[]>([{ locale: "en", value: "" }]);

  // Edit option
  const [editingOption, setEditingOption] = useState<DimensionOption | null>(null);
  const [editOptionCode, setEditOptionCode] = useState("");
  const [editOptionNumericValue, setEditOptionNumericValue] = useState("");
  const [editOptionLabels, setEditOptionLabels] = useState<LabelEntry[]>([]);

  // Reorder options
  const [showReorder, setShowReorder] = useState(false);
  const [reorderInput, setReorderInput] = useState("");

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      activate: () => activateDimension(id),
      deprecate: () => deprecateDimension(id),
      archive: () => archiveDimension(id),
    };
    await actions[action]?.();
    addToast(t("catalog.features.dimensions.ui.dimensionDetailPage.lifecycle.completed", {
      action: lifecycleActionLabel(action),
    }), "success");
    refresh();
  }

  async function handleRevise() {
    await reviseDimension(id, { key: editKey, name: editName, description: editDescription || undefined, valueKind: editValueKind });
    addToast(t("catalog.features.dimensions.ui.dimensionDetailPage.dimension.revised"), "success");
    setEditing(false);
    refresh();
  }

  async function handleAddOption() {
    const optionId = createId("chc");
    const labels = optionLabels.filter((l) => l.value.trim());
    await addOption(id, {
      optionId,
      code: optionCode,
      labels: labels.length > 0 ? labels : undefined,
      numericValue: optionNumericValue ? Number(optionNumericValue) : undefined,
    });
    addToast(t("catalog.features.dimensions.ui.dimensionDetailPage.option.added"), "success");
    setShowAddOption(false);
    setOptionCode("");
    setOptionNumericValue("");
    setOptionLabels([{ locale: "en", value: "" }]);
    refresh();
  }

  async function handleReviseOption() {
    if (!editingOption) return;
    const labels = editOptionLabels.filter((l) => l.value.trim());
    await reviseOption(id, editingOption.option_id, {
      code: editOptionCode,
      labels: labels.length > 0 ? labels : undefined,
      numericValue: editOptionNumericValue ? Number(editOptionNumericValue) : undefined,
    });
    addToast(t("catalog.features.dimensions.ui.dimensionDetailPage.option.revised"), "success");
    setEditingOption(null);
    refresh();
  }

  function startEditOption(option: DimensionOption) {
    setEditOptionCode(option.code);
    setEditOptionNumericValue(option.numeric_value?.toString() ?? "");
    setEditOptionLabels(
      option.labels && option.labels.length > 0
        ? option.labels.map((l) => ({ locale: l.locale, value: l.value }))
        : [{ locale: "en", value: "" }],
    );
    setEditingOption(option);
  }

  async function handleDeprecateOption(optionId: string) {
    await deprecateOption(id, optionId);
    addToast(t("catalog.features.dimensions.ui.dimensionDetailPage.option.deprecated"), "success");
    refresh();
  }

  async function handleReactivateOption(optionId: string) {
    await reactivateOption(id, optionId);
    addToast(t("catalog.features.dimensions.ui.dimensionDetailPage.option.reactivated"), "success");
    refresh();
  }

  async function handleReorderOptions() {
    const optionIds = reorderInput.split(",").map((s) => s.trim()).filter(Boolean);
    await reorderOptions(id, optionIds);
    addToast(t("catalog.features.dimensions.ui.dimensionDetailPage.options.reordered"), "success");
    setShowReorder(false);
    refresh();
  }

  function startReorder() {
    if (data) {
      setReorderInput(data.options.map((option) => option.option_id).join(", "));
      setShowReorder(true);
    }
  }

  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditValueKind(data.value_kind);
      setEditing(true);
    }
  }

  function updateLabel(labels: LabelEntry[], setLabels: (l: LabelEntry[]) => void, index: number, field: keyof LabelEntry, value: string) {
    setLabels(labels.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  function renderLabelsEditor(labels: LabelEntry[], setLabels: (l: LabelEntry[]) => void) {
    return (
      <Stack gap={2}>
        {labels.map((label, i) => (
          <Inline key={i} gap={2}>
            <TextInput
              label={i === 0 ? t("catalog.features.dimensions.ui.dimensionDetailPage.locale") : undefined}
              value={label.locale}
              onChange={(e) => updateLabel(labels, setLabels, i, "locale", e.target.value)}
            />
            <TextInput
              label={i === 0 ? t("catalog.features.dimensions.ui.dimensionDetailPage.label") : undefined}
              value={label.value}
              onChange={(e) => updateLabel(labels, setLabels, i, "value", e.target.value)}
            />
            <Button size="sm" tone="danger" onClick={() => setLabels(labels.filter((_, j) => j !== i))}>
              {t("catalog.features.dimensions.ui.dimensionDetailPage.remove")}</Button>
          </Inline>
        ))}
        <Inline>
          <Button size="sm" tone="secondary" onClick={() => setLabels([...labels, { locale: "", value: "" }])}>
            {t("catalog.features.dimensions.ui.dimensionDetailPage.add.label")}</Button>
        </Inline>
      </Stack>
    );
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? t("catalog.features.dimensions.ui.dimensionDetailPage.dimension")}
        breadcrumbs={[
          { label: t("catalog.features.dimensions.ui.dimensionDetailPage.dimensions"), href: "/dimensions" },
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
                  {t("catalog.features.dimensions.ui.dimensionDetailPage.edit")}</Button>
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
                { key: t("catalog.features.dimensions.ui.dimensionDetailPage.key"), value: data.key },
                { key: t("catalog.features.dimensions.ui.dimensionDetailPage.name"), value: data.name },
                { key: t("catalog.features.dimensions.ui.dimensionDetailPage.description"), value: data.description ?? "—" },
                { key: t("catalog.features.dimensions.ui.dimensionDetailPage.value.kind"), value: data.value_kind },
                { key: t("catalog.features.dimensions.ui.dimensionDetailPage.status"), value: data.status },
                { key: t("catalog.features.dimensions.ui.dimensionDetailPage.updated"), value: data.updated_at },
              ]}
            />

            <PageSection
              title={t("catalog.features.dimensions.ui.dimensionDetailPage.options")}
              description={t("catalog.features.dimensions.ui.dimensionDetailPage.option.count", {
                count: data.options.length,
              })}
            >
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline gap={2}>
                    <Button size="sm" onClick={() => setShowAddOption(true)}>{t("catalog.features.dimensions.ui.dimensionDetailPage.add.option")}</Button>
                    {data.options.length > 1 && (
                      <Button size="sm" tone="secondary" onClick={startReorder}>{t("catalog.features.dimensions.ui.dimensionDetailPage.reorder")}</Button>
                    )}
                  </Inline>
                )}
                <DataTable
                  rows={data.options}
                  columns={[
                    ...optionColumns,
                    {
                      key: "actions",
                      header: t("catalog.features.dimensions.ui.dimensionDetailPage.actions"),
                      cell: (row) => (
                        <Inline gap={1}>
                          {data.status !== "archived" && (
                            <Button size="sm" tone="secondary" onClick={() => startEditOption(row)}>
                              {t("catalog.features.dimensions.ui.dimensionDetailPage.edit.2")}</Button>
                          )}
                          {row.status === "active" && (
                            <Button size="sm" tone="secondary" onClick={() => handleDeprecateOption(row.option_id)}>
                              {t("catalog.features.dimensions.ui.dimensionDetailPage.deprecate.2")}</Button>
                          )}
                          {row.status === "deprecated" && (
                            <Button size="sm" tone="secondary" onClick={() => handleReactivateOption(row.option_id)}>
                              {t("catalog.features.dimensions.ui.dimensionDetailPage.reactivate")}</Button>
                          )}
                        </Inline>
                      ),
                    },
                  ]}
                  getRowId={(row) => row.option_id}
                  emptyTitle={t("catalog.features.dimensions.ui.dimensionDetailPage.no.options")}
                  emptyDescription={t("catalog.features.dimensions.ui.dimensionDetailPage.add.an.option.to.this.dimension")}
                />
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={showAddOption}
        onOpenChange={setShowAddOption}
        title={t("catalog.features.dimensions.ui.dimensionDetailPage.add.option.2")}
        footer={<Button onClick={handleAddOption}>{t("catalog.features.dimensions.ui.dimensionDetailPage.add")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.dimensions.ui.dimensionDetailPage.code.2")} value={optionCode} onChange={(e) => setOptionCode(e.target.value)} />
          <TextInput label={t("catalog.features.dimensions.ui.dimensionDetailPage.numeric.value.optional")} value={optionNumericValue} onChange={(e) => setOptionNumericValue(e.target.value)} />
          {renderLabelsEditor(optionLabels, setOptionLabels)}
        </Stack>
      </Dialog>

      <Dialog
        open={editingOption !== null}
        onOpenChange={(open) => { if (!open) setEditingOption(null); }}
        title={t("catalog.features.dimensions.ui.dimensionDetailPage.edit.option")}
        footer={<Button onClick={handleReviseOption}>{t("catalog.features.dimensions.ui.dimensionDetailPage.save")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.dimensions.ui.dimensionDetailPage.code.3")} value={editOptionCode} onChange={(e) => setEditOptionCode(e.target.value)} />
          <TextInput label={t("catalog.features.dimensions.ui.dimensionDetailPage.numeric.value.optional.2")} value={editOptionNumericValue} onChange={(e) => setEditOptionNumericValue(e.target.value)} />
          {renderLabelsEditor(editOptionLabels, setEditOptionLabels)}
        </Stack>
      </Dialog>

      <Dialog
        open={showReorder}
        onOpenChange={setShowReorder}
        title={t("catalog.features.dimensions.ui.dimensionDetailPage.reorder.options")}
        description={t("catalog.features.dimensions.ui.dimensionDetailPage.enter.option.ids.separated.by.commas")}
        footer={<Button onClick={handleReorderOptions}>{t("catalog.features.dimensions.ui.dimensionDetailPage.save.2")}</Button>}
      >
        <TextInput
          label={t("catalog.features.dimensions.ui.dimensionDetailPage.option.ids")}
          value={reorderInput}
          onChange={(e) => setReorderInput(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.dimensions.ui.dimensionDetailPage.edit.dimension")}
        footer={<Button onClick={handleRevise}>{t("catalog.features.dimensions.ui.dimensionDetailPage.save.3")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.dimensions.ui.dimensionDetailPage.key")} value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label={t("catalog.features.dimensions.ui.dimensionDetailPage.name")} value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label={t("catalog.features.dimensions.ui.dimensionDetailPage.description")} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          <Select
            label={t("catalog.features.dimensions.ui.dimensionDetailPage.value.kind")}
            items={valueKindOptions}
            value={editValueKind}
            onValueChange={setEditValueKind}
          />
        </Stack>
      </Dialog>
    </>
  );
}

