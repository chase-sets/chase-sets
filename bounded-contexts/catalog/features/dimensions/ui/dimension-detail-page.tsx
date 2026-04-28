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
      return [{ label: "Activate", action: "activate", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}

const optionColumns: DataColumn<DimensionOption>[] = [
  { key: "code", header: "Code", cell: (row) => row.code },
  {
    key: "labels",
    header: "Labels",
    cell: (row) =>
      row.labels && row.labels.length > 0
        ? row.labels.map((l) => `${l.locale}: ${l.value}`).join(", ")
        : "—",
  },
  { key: "numeric_value", header: "Numeric Value", cell: (row) => row.numeric_value ?? "—" },
  { key: "display_order", header: "Order", cell: (row) => row.display_order },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const valueKindOptions = [
  { label: "Unordered", value: "unordered" },
  { label: "Ordered", value: "ordered" },
  { label: "Numeric", value: "numeric" },
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
    addToast(`Dimension ${action}d`, "success");
    refresh();
  }

  async function handleRevise() {
    await reviseDimension(id, { key: editKey, name: editName, description: editDescription || undefined, valueKind: editValueKind });
    addToast("Dimension revised", "success");
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
    addToast("Option added", "success");
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
    addToast("Option revised", "success");
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
    addToast("Option deprecated", "success");
    refresh();
  }

  async function handleReactivateOption(optionId: string) {
    await reactivateOption(id, optionId);
    addToast("Option reactivated", "success");
    refresh();
  }

  async function handleReorderOptions() {
    const optionIds = reorderInput.split(",").map((s) => s.trim()).filter(Boolean);
    await reorderOptions(id, optionIds);
    addToast("Options reordered", "success");
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
              label={i === 0 ? "Locale" : undefined}
              value={label.locale}
              onChange={(e) => updateLabel(labels, setLabels, i, "locale", e.target.value)}
            />
            <TextInput
              label={i === 0 ? "Label" : undefined}
              value={label.value}
              onChange={(e) => updateLabel(labels, setLabels, i, "value", e.target.value)}
            />
            <Button size="sm" tone="danger" onClick={() => setLabels(labels.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </Inline>
        ))}
        <Inline>
          <Button size="sm" tone="secondary" onClick={() => setLabels([...labels, { locale: "", value: "" }])}>
            Add Label
          </Button>
        </Inline>
      </Stack>
    );
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? "Dimension"}
        breadcrumbs={[
          { label: "Dimensions", href: "/dimensions" },
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
          <Stack gap={6}>
            <KeyValueList
              items={[
                { key: "Key", value: data.key },
                { key: "Name", value: data.name },
                { key: "Description", value: data.description ?? "—" },
                { key: "Value Kind", value: data.value_kind },
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at },
              ]}
            />

            <PageSection
              title="Options"
              description={`${data.options.length} option(s)`}
            >
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline gap={2}>
                    <Button size="sm" onClick={() => setShowAddOption(true)}>Add Option</Button>
                    {data.options.length > 1 && (
                      <Button size="sm" tone="secondary" onClick={startReorder}>Reorder</Button>
                    )}
                  </Inline>
                )}
                <DataTable
                  rows={data.options}
                  columns={[
                    ...optionColumns,
                    {
                      key: "actions",
                      header: "Actions",
                      cell: (row) => (
                        <Inline gap={1}>
                          {data.status !== "archived" && (
                            <Button size="sm" tone="secondary" onClick={() => startEditOption(row)}>
                              Edit
                            </Button>
                          )}
                          {row.status === "active" && (
                            <Button size="sm" tone="secondary" onClick={() => handleDeprecateOption(row.option_id)}>
                              Deprecate
                            </Button>
                          )}
                          {row.status === "deprecated" && (
                            <Button size="sm" tone="secondary" onClick={() => handleReactivateOption(row.option_id)}>
                              Reactivate
                            </Button>
                          )}
                        </Inline>
                      ),
                    },
                  ]}
                  getRowId={(row) => row.option_id}
                  emptyTitle="No options"
                  emptyDescription="Add an option to this dimension."
                />
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={showAddOption}
        onOpenChange={setShowAddOption}
        title="Add Option"
        footer={<Button onClick={handleAddOption}>Add</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Code" value={optionCode} onChange={(e) => setOptionCode(e.target.value)} />
          <TextInput label="Numeric Value (optional)" value={optionNumericValue} onChange={(e) => setOptionNumericValue(e.target.value)} />
          {renderLabelsEditor(optionLabels, setOptionLabels)}
        </Stack>
      </Dialog>

      <Dialog
        open={editingOption !== null}
        onOpenChange={(open) => { if (!open) setEditingOption(null); }}
        title="Edit Option"
        footer={<Button onClick={handleReviseOption}>Save</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Code" value={editOptionCode} onChange={(e) => setEditOptionCode(e.target.value)} />
          <TextInput label="Numeric Value (optional)" value={editOptionNumericValue} onChange={(e) => setEditOptionNumericValue(e.target.value)} />
          {renderLabelsEditor(editOptionLabels, setEditOptionLabels)}
        </Stack>
      </Dialog>

      <Dialog
        open={showReorder}
        onOpenChange={setShowReorder}
        title="Reorder Options"
        description="Enter option IDs separated by commas in the desired order."
        footer={<Button onClick={handleReorderOptions}>Save</Button>}
      >
        <TextInput
          label="Option IDs"
          value={reorderInput}
          onChange={(e) => setReorderInput(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit Dimension"
        footer={<Button onClick={handleRevise}>Save</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label="Description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          <Select
            label="Value Kind"
            items={valueKindOptions}
            value={editValueKind}
            onValueChange={setEditValueKind}
          />
        </Stack>
      </Dialog>
    </>
  );
}



