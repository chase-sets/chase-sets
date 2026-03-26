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
import { useToasts } from "../../shell-support/ui/toasts";
import { EntityDetailPage } from "../../shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../shell-support/ui/lifecycle-controls";
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
  allowedChoices: { choiceId: string; code: string }[];
}

export function ComponentDetailPage({ id }: { id: string }) {
  const { data, loading, error, refresh } = useComponent(id);
  const { addToast } = useToasts();

  // Add field rule
  const [showAddField, setShowAddField] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [fieldRequired, setFieldRequired] = useState(false);

  // Add dimension rule
  const [showAddDimension, setShowAddDimension] = useState(false);
  const [dimensionId, setDimensionId] = useState("");
  const [dimRequired, setDimRequired] = useState(false);
  const [dimAllowedChoiceIds, setDimAllowedChoiceIds] = useState("");

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
        allowedChoiceIds: rule.allowedChoices.map((choice) => choice.choiceId),
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
    const allowedChoiceIds = dimAllowedChoiceIds.split(",").map((s) => s.trim()).filter(Boolean);
    await addDimensionRule(id, {
      dimensionId,
      required: dimRequired,
      allowedChoiceIds: allowedChoiceIds.length > 0 ? allowedChoiceIds : undefined,
    });
    addToast("Dimension rule added", "success");
    setShowAddDimension(false);
    setDimensionId("");
    setDimRequired(false);
    setDimAllowedChoiceIds("");
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
      key: "allowedChoices",
      header: "Allowed Choices",
      cell: (row) => row.allowedChoices.length > 0 ? row.allowedChoices.map((choice) => choice.code).join(", ") : "All",
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
          { label: "Components", href: "#/components" },
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
            label="Allowed Choice IDs (comma-separated, leave empty for all)"
            value={dimAllowedChoiceIds}
            onChange={(e) => setDimAllowedChoiceIds(e.target.value)}
          />
        </Stack>
      </Dialog>
    </>
  );
}




