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
import { useToasts } from "../../toasts";
import { EntityDetailPage } from "../../shared/entity-detail-page";
import { LifecycleControls, type Transition } from "../../shared/lifecycle-controls";
import {
  useComponent,
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
  required: boolean;
}

interface DimensionRule {
  dimensionId: string;
  required: boolean;
  allowedChoiceIds: string[];
}

export function ComponentDetailPage({ id }: { id: string }) {
  const { data, loading, error, refresh } = useComponent(id);
  const { addToast } = useToasts();
  const [showAddField, setShowAddField] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [fieldRequired, setFieldRequired] = useState(false);
  const [showAddDimension, setShowAddDimension] = useState(false);
  const [dimensionId, setDimensionId] = useState("");
  const [dimRequired, setDimRequired] = useState(false);

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
    await addDimensionRule(id, { dimensionId, required: dimRequired });
    addToast("Dimension rule added", "success");
    setShowAddDimension(false);
    setDimensionId("");
    setDimRequired(false);
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
    { key: "fieldId", header: "Field ID", cell: (row) => row.fieldId },
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
    { key: "dimensionId", header: "Dimension ID", cell: (row) => row.dimensionId },
    { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
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
            <LifecycleControls
              status={data.status}
              transitions={getTransitions(data.status)}
              onAction={handleLifecycleAction}
            />
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
                { key: "ID", value: data.component_id },
                { key: "Key", value: data.key },
                { key: "Name", value: data.name },
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
        </Stack>
      </Dialog>
    </>
  );
}
