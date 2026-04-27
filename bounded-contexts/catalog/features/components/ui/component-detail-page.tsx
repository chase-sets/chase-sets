import { useState } from "react";
import {
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  Stack,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import {
  useComponent,
  configureComponent,
  activateComponent,
  deprecateComponent,
  archiveComponent,
  addFieldRule,
  removeFieldRule,
  addDimensionRule,
  removeDimensionRule,
} from "./use-components";

function formatApplicability(
  clauses: Array<{
    dimensionName?: string;
    dimensionId: string;
    options?: { code: string }[];
    optionIds?: string[];
  }>,
): string {
  if (clauses.length === 0) {
    return "Always";
  }

  return clauses
    .map((clause) => {
      const options =
        clause.options && clause.options.length > 0
          ? clause.options.map((option) => option.code).join(" | ")
          : (clause.optionIds ?? []).join(" | ");
      return `${clause.dimensionName ?? clause.dimensionId} = ${options}`;
    })
    .join(", ");
}


function parseApplicabilityClauses(
  value: string,
): Array<{ dimensionId: string; optionIds: string[] }> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [dimensionId, optionIds = ""] = entry.split("=");
      return {
        dimensionId: dimensionId.trim(),
        optionIds: optionIds
          .split("|")
          .map((optionId) => optionId.trim())
          .filter(Boolean),
      };
    })
    .filter((clause) => clause.dimensionId.length > 0 && clause.optionIds.length > 0);
}

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

interface FieldRule {
  fieldId: string;
  fieldName: string;
  required: boolean;
}

interface DimensionRule {
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  allowedOptions: { optionId: string; code: string }[];
  appliesWhen: Array<{
    dimensionId: string;
    dimensionName: string;
    optionIds: string[];
    options: { optionId: string; code: string }[];
  }>;
}

export function ComponentDetailPage({ id, initialData }: { id: string; initialData?: Parameters<typeof useComponent>[1] }) {
  const { data, loading, error, refresh } = useComponent(id, initialData);
  const { addToast } = useToasts();

  // Add field rule
  const [showAddField, setShowAddField] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [fieldRequired, setFieldRequired] = useState(false);

  // Add dimension rule
  const [showAddDimension, setShowAddDimension] = useState(false);
  const [dimensionId, setDimensionId] = useState("");
  const [dimRequired, setDimRequired] = useState(false);
  const [dimAllowedOptionIds, setDimAllowedOptionIds] = useState("");
  const [dimAppliesWhen, setDimAppliesWhen] = useState("");

  // Edit component metadata
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      activate: () => activateComponent(id),
      deprecate: () => deprecateComponent(id),
      archive: () => archiveComponent(id),
    };
    await actions[action]?.();
    addToast(`Component ${action}d`, "success");
    refresh();
  }

  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditing(true);
    }
  }

  async function handleConfigure() {
    await configureComponent(id, {
      key: editKey,
      name: editName,
      description: editDescription || undefined,
      fieldRules: (data?.field_rules ?? []).map((rule) => ({
        fieldId: rule.fieldId,
        required: rule.required,
      })),
      dimensionRules: (data?.dimension_rules ?? []).map((rule) => ({
        dimensionId: rule.dimensionId,
        required: rule.required,
        allowedOptionIds: rule.allowedOptions.map((option) => option.optionId),
        appliesWhen: rule.appliesWhen.map((clause) => ({
          dimensionId: clause.dimensionId,
          optionIds: clause.optionIds,
        })),
      })),
    });
    addToast("Component updated", "success");
    setEditing(false);
    refresh();
  }

  async function handleAddFieldRule() {
    await addFieldRule(id, { fieldId, required: fieldRequired });
    addToast("Field rule added", "success");
    setShowAddField(false);
    setFieldId("");
    setFieldRequired(false);
    refresh();
  }

  async function handleRemoveFieldRule(fId: string) {
    await removeFieldRule(id, fId);
    addToast("Field rule removed", "success");
    refresh();
  }

  async function handleAddDimensionRule() {
    const allowedOptionIds = dimAllowedOptionIds.split(",").map((s) => s.trim()).filter(Boolean);
    await addDimensionRule(id, {
      dimensionId,
      required: dimRequired,
      allowedOptionIds: allowedOptionIds.length > 0 ? allowedOptionIds : undefined,
      appliesWhen: parseApplicabilityClauses(dimAppliesWhen),
    });
    addToast("Dimension rule added", "success");
    setShowAddDimension(false);
    setDimensionId("");
    setDimRequired(false);
    setDimAllowedOptionIds("");
    setDimAppliesWhen("");
    refresh();
  }

  async function handleRemoveDimensionRule(dId: string) {
    await removeDimensionRule(id, dId);
    addToast("Dimension rule removed", "success");
    refresh();
  }

  const fieldRules = (data?.field_rules ?? []) as FieldRule[];
  const dimensionRules = (data?.dimension_rules ?? []) as DimensionRule[];

  const fieldRuleColumns: DataColumn<FieldRule>[] = [
    { key: "fieldId", header: "Field", cell: (row) => row.fieldName },
    { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
    {
      key: "actions",
      header: "",
      cell: (row) => data?.status !== "archived" ? (
        <Button size="sm" tone="danger" onClick={() => handleRemoveFieldRule(row.fieldId)}>Remove</Button>
      ) : null,
    },
  ];

  const dimensionRuleColumns: DataColumn<DimensionRule>[] = [
    { key: "dimensionId", header: "Dimension", cell: (row) => row.dimensionName },
    { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
    {
      key: "allowedOptions",
      header: "Allowed Options",
      cell: (row) => row.allowedOptions.length > 0 ? row.allowedOptions.map((option) => option.code).join(", ") : "All",
    },
    {
      key: "appliesWhen",
      header: "Applies When",
      cell: (row) => formatApplicability(row.appliesWhen),
    },
    {
      key: "actions",
      header: "",
      cell: (row) => data?.status !== "archived" ? (
        <Button size="sm" tone="danger" onClick={() => handleRemoveDimensionRule(row.dimensionId)}>Remove</Button>
      ) : null,
    },
  ];

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? "Component"}
        breadcrumbs={[
          { label: "Components", href: "/components" },
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
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at },
              ]}
            />

            <PageSection title="Field Rules">
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAddField(true)}>Add Field Rule</Button>
                  </Inline>
                )}
                <DataTable
                  rows={fieldRules}
                  columns={fieldRuleColumns}
                  getRowId={(row) => row.fieldId}
                  emptyTitle="No field rules"
                />
              </Stack>
            </PageSection>

            <PageSection title="Dimension Rules">
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAddDimension(true)}>Add Dimension Rule</Button>
                  </Inline>
                )}
                <DataTable
                  rows={dimensionRules}
                  columns={dimensionRuleColumns}
                  getRowId={(row) => row.dimensionId}
                  emptyTitle="No dimension rules"
                />
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit Component"
        footer={<Button onClick={handleConfigure}>Save</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label="Description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
        </Stack>
      </Dialog>

      <Dialog
        open={showAddField}
        onOpenChange={setShowAddField}
        title="Add Field Rule"
        footer={<Button onClick={handleAddFieldRule}>Add</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Field ID" value={fieldId} onChange={(e) => setFieldId(e.target.value)} />
          <Checkbox label="Required" checked={fieldRequired} onCheckedChange={(v) => setFieldRequired(v === true)} />
        </Stack>
      </Dialog>

      <Dialog
        open={showAddDimension}
        onOpenChange={setShowAddDimension}
        title="Add Dimension Rule"
        footer={<Button onClick={handleAddDimensionRule}>Add</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Dimension ID" value={dimensionId} onChange={(e) => setDimensionId(e.target.value)} />
          <Checkbox label="Required" checked={dimRequired} onCheckedChange={(v) => setDimRequired(v === true)} />
          <TextInput
            label="Allowed Option IDs (comma-separated, leave empty for all)"
            value={dimAllowedOptionIds}
            onChange={(e) => setDimAllowedOptionIds(e.target.value)}
          />
          <TextInput
            label="Applies When (dimensionId=optionId|optionId, comma-separated)"
            value={dimAppliesWhen}
            onChange={(e) => setDimAppliesWhen(e.target.value)}
          />
        </Stack>
      </Dialog>
    </>
  );
}





