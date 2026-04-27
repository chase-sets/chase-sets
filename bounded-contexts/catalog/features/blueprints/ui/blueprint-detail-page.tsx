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
  Text,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import {
  useBlueprint,
  reviseBlueprint,
  attachComponent,
  detachComponent,
  setBlueprintFields,
  setBlueprintDimensions,
  setBlueprintProductResolutionRules,
  publishBlueprint,
  deprecateBlueprint,
  archiveBlueprint,
} from "./use-blueprints";

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

function serializeApplicabilityClauses(
  clauses: Array<{ dimensionId: string; optionIds?: string[] }>,
): string {
  return clauses
    .map((clause) => `${clause.dimensionId}=${(clause.optionIds ?? []).join("|")}`)
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
      return [{ label: "Publish", action: "publish", tone: "primary" }];
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

interface EditFieldRule {
  fieldId: string;
  required: boolean;
}

interface EditDimensionRule {
  dimensionId: string;
  required: boolean;
  allowedOptionIds: string;
  appliesWhen: string;
}

export function BlueprintDetailPage({ id, initialData }: { id: string; initialData?: Parameters<typeof useBlueprint>[1] }) {
  const { data, loading, error, refresh } = useBlueprint(id, initialData);
  const { addToast } = useToasts();
  const [showAttachComponent, setShowAttachComponent] = useState(false);
  const [componentId, setComponentId] = useState("");
  const [showSetProductResolutionRules, setShowSetProductResolutionRules] = useState(false);
  const [canonicalOrder, setCanonicalOrder] = useState("");
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // Set field rules
  const [showSetFieldRules, setShowSetFieldRules] = useState(false);
  const [editFieldRules, setEditFieldRules] = useState<EditFieldRule[]>([]);

  // Set dimension rules
  const [showSetDimRules, setShowSetDimRules] = useState(false);
  const [editDimRules, setEditDimRules] = useState<EditDimensionRule[]>([]);

  async function handleLifecycleAction(action: string) {
    const actions: Record<string, () => Promise<unknown>> = {
      publish: () => publishBlueprint(id),
      deprecate: () => deprecateBlueprint(id),
      archive: () => archiveBlueprint(id),
    };
    await actions[action]?.();
    addToast(`Blueprint ${action}ed`, "success");
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

  async function handleRevise() {
    await reviseBlueprint(id, { key: editKey, name: editName, description: editDescription || undefined });
    addToast("Blueprint revised", "success");
    setEditing(false);
    refresh();
  }

  async function handleAttachComponent() {
    await attachComponent(id, componentId);
    addToast("Component attached", "success");
    setShowAttachComponent(false);
    setComponentId("");
    refresh();
  }

  async function handleDetachComponent(compId: string) {
    await detachComponent(id, compId);
    addToast("Component detached", "success");
    refresh();
  }

  async function handleSetProductResolutionRules() {
    const order = canonicalOrder.split(",").map((s) => s.trim()).filter(Boolean);
    await setBlueprintProductResolutionRules(id, order);
    addToast("Product resolution rules set", "success");
    setShowSetProductResolutionRules(false);
    setCanonicalOrder("");
    refresh();
  }

  function startSetFieldRules() {
    setEditFieldRules(
      fieldRules.length > 0
        ? fieldRules.map((r) => ({ fieldId: r.fieldId, required: r.required }))
        : [{ fieldId: "", required: false }],
    );
    setShowSetFieldRules(true);
  }

  async function handleSetFieldRules() {
    const rules = editFieldRules.filter((r) => r.fieldId.trim());
    await setBlueprintFields(id, rules);
    addToast("Field rules set", "success");
    setShowSetFieldRules(false);
    refresh();
  }

  function startSetDimRules() {
    setEditDimRules(
      dimensionRules.length > 0
        ? dimensionRules.map((r) => ({
            dimensionId: r.dimensionId,
            required: r.required,
            allowedOptionIds: r.allowedOptions.map((option) => option.optionId).join(", "),
            appliesWhen: serializeApplicabilityClauses(r.appliesWhen),
          }))
        : [{ dimensionId: "", required: false, allowedOptionIds: "", appliesWhen: "" }],
    );
    setShowSetDimRules(true);
  }

  async function handleSetDimRules() {
    const rules = editDimRules
      .filter((r) => r.dimensionId.trim())
      .map((r) => ({
        dimensionId: r.dimensionId,
        required: r.required,
        allowedOptionIds: r.allowedOptionIds.split(",").map((s) => s.trim()).filter(Boolean),
        appliesWhen: parseApplicabilityClauses(r.appliesWhen),
      }));
    await setBlueprintDimensions(id, rules);
    addToast("Dimension rules set", "success");
    setShowSetDimRules(false);
    refresh();
  }

  const fieldRules = (data?.field_rules ?? []) as FieldRule[];
  const dimensionRules = (data?.dimension_rules ?? []) as DimensionRule[];
  const components = data?.components ?? [];
  const canonicalDimensionOrder = data?.canonical_dimension_order ?? [];

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? "Blueprint"}
        breadcrumbs={[
          { label: "Blueprints", href: "/blueprints" },
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

            <PageSection title="Components">
              <Stack gap={3}>
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAttachComponent(true)}>Attach Component</Button>
                  </Inline>
                )}
                {components.length === 0 ? (
                  <Text tone="secondary">No components attached.</Text>
                ) : (
                  <DataTable
                    rows={components}
                    columns={[
                      { key: "componentId", header: "Component", cell: (row) => row.name },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) => data.status === "draft" ? (
                          <Button size="sm" tone="danger" onClick={() => handleDetachComponent(row.componentId)}>Detach</Button>
                        ) : null,
                      },
                    ]}
                    getRowId={(row) => row.componentId}
                  />
                )}
              </Stack>
            </PageSection>

            <PageSection title="Field Rules">
              <Stack gap={3}>
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={startSetFieldRules}>Set Field Rules</Button>
                  </Inline>
                )}
                <DataTable
                  rows={fieldRules}
                  columns={[
                    { key: "fieldId", header: "Field", cell: (row) => row.fieldName },
                    { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
                  ] as DataColumn<FieldRule>[]}
                  getRowId={(row) => row.fieldId}
                  emptyTitle="No field rules"
                />
              </Stack>
            </PageSection>

            <PageSection title="Dimension Rules">
              <Stack gap={3}>
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={startSetDimRules}>Set Dimension Rules</Button>
                  </Inline>
                )}
                <DataTable
                  rows={dimensionRules}
                  columns={[
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
                  ] as DataColumn<DimensionRule>[]}
                  getRowId={(row) => row.dimensionId}
                  emptyTitle="No dimension rules"
                />
              </Stack>
            </PageSection>

            <PageSection title="Product Resolution Rules">
              <Stack gap={3}>
                <KeyValueList
                  items={[
                    { key: "Canonical Dimension Order", value: canonicalDimensionOrder.length > 0 ? canonicalDimensionOrder.map((dimension) => dimension.dimensionName).join(", ") : "Not set" },
                  ]}
                />
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={() => {
                      setCanonicalOrder(canonicalDimensionOrder.map((dimension) => dimension.dimensionId).join(", "));
                      setShowSetProductResolutionRules(true);
                    }}>
                      Set Product Resolution Rules
                    </Button>
                  </Inline>
                )}
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit Blueprint"
        footer={<Button onClick={handleRevise}>Save</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <TextInput label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <TextInput label="Description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
        </Stack>
      </Dialog>

      <Dialog
        open={showAttachComponent}
        onOpenChange={setShowAttachComponent}
        title="Attach Component"
        footer={<Button onClick={handleAttachComponent}>Attach</Button>}
      >
        <TextInput label="Component ID" value={componentId} onChange={(e) => setComponentId(e.target.value)} />
      </Dialog>

      <Dialog
        open={showSetProductResolutionRules}
        onOpenChange={setShowSetProductResolutionRules}
        title="Set Product Resolution Rules"
        description="Enter dimension IDs separated by commas in the canonical order."
        footer={<Button onClick={handleSetProductResolutionRules}>Save</Button>}
      >
        <TextInput
          label="Canonical Dimension Order"
          value={canonicalOrder}
          onChange={(e) => setCanonicalOrder(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetFieldRules}
        onOpenChange={setShowSetFieldRules}
        title="Set Field Rules"
        description="Configure which fields apply to this blueprint."
        footer={<Button onClick={handleSetFieldRules}>Save</Button>}
      >
        <Stack gap={3}>
          {editFieldRules.map((rule, i) => (
            <Inline key={i} gap={2}>
              <TextInput
                label={i === 0 ? "Field ID" : undefined}
                value={rule.fieldId}
                onChange={(e) =>
                  setEditFieldRules((prev) => prev.map((r, j) => (j === i ? { ...r, fieldId: e.target.value } : r)))
                }
              />
              <Checkbox
                label="Required"
                checked={rule.required}
                onCheckedChange={(v) =>
                  setEditFieldRules((prev) => prev.map((r, j) => (j === i ? { ...r, required: v === true } : r)))
                }
              />
              <Button size="sm" tone="danger" onClick={() => setEditFieldRules((prev) => prev.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </Inline>
          ))}
          <Inline>
            <Button size="sm" tone="secondary" onClick={() => setEditFieldRules((prev) => [...prev, { fieldId: "", required: false }])}>
              Add Rule
            </Button>
          </Inline>
        </Stack>
      </Dialog>

      <Dialog
        open={showSetDimRules}
        onOpenChange={setShowSetDimRules}
        title="Set Dimension Rules"
        description="Configure which dimensions apply to this blueprint."
        footer={<Button onClick={handleSetDimRules}>Save</Button>}
      >
        <Stack gap={3}>
          {editDimRules.map((rule, i) => (
            <Stack key={i} gap={2}>
              <Inline gap={2}>
                <TextInput
                  label={i === 0 ? "Dimension ID" : undefined}
                  value={rule.dimensionId}
                  onChange={(e) =>
                    setEditDimRules((prev) => prev.map((r, j) => (j === i ? { ...r, dimensionId: e.target.value } : r)))
                  }
                />
                <Checkbox
                  label="Required"
                  checked={rule.required}
                  onCheckedChange={(v) =>
                    setEditDimRules((prev) => prev.map((r, j) => (j === i ? { ...r, required: v === true } : r)))
                  }
                />
                <Button size="sm" tone="danger" onClick={() => setEditDimRules((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </Inline>
              <TextInput
                label="Allowed Option IDs (comma-separated, leave empty for all)"
                value={rule.allowedOptionIds}
                onChange={(e) =>
                  setEditDimRules((prev) => prev.map((r, j) => (j === i ? { ...r, allowedOptionIds: e.target.value } : r)))
                }
              />
              <TextInput
                label="Applies When (dimensionId=optionId|optionId, comma-separated)"
                value={rule.appliesWhen}
                onChange={(e) =>
                  setEditDimRules((prev) => prev.map((r, j) => (j === i ? { ...r, appliesWhen: e.target.value } : r)))
                }
              />
            </Stack>
          ))}
          <Inline>
            <Button size="sm" tone="secondary" onClick={() => setEditDimRules((prev) => [...prev, { dimensionId: "", required: false, allowedOptionIds: "", appliesWhen: "" }])}>
              Add Rule
            </Button>
          </Inline>
        </Stack>
      </Dialog>
    </>
  );
}


