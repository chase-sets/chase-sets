import { useState } from "react";
import {
  Button,
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
import { useToasts } from "../../toasts";
import { EntityDetailPage } from "../../shared/entity-detail-page";
import { LifecycleControls, type Transition } from "../../shared/lifecycle-controls";
import {
  useBlueprint,
  attachComponent,
  detachComponent,
  setBlueprintDimensions,
  setBlueprintVersionRules,
  publishBlueprint,
  deprecateBlueprint,
  archiveBlueprint,
} from "./use-blueprints";

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
  required: boolean;
}

interface DimensionRule {
  dimensionId: string;
  required: boolean;
  allowedChoiceIds: string[];
}

export function BlueprintDetailPage({ id }: { id: string }) {
  const { data, loading, error, refresh } = useBlueprint(id);
  const { addToast } = useToasts();
  const [showAttachComponent, setShowAttachComponent] = useState(false);
  const [componentId, setComponentId] = useState("");
  const [showSetVersionRules, setShowSetVersionRules] = useState(false);
  const [canonicalOrder, setCanonicalOrder] = useState("");

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

  async function handleSetVersionRules() {
    const order = canonicalOrder.split(",").map((s) => s.trim()).filter(Boolean);
    await setBlueprintVersionRules(id, order);
    addToast("Version rules set", "success");
    setShowSetVersionRules(false);
    setCanonicalOrder("");
    refresh();
  }

  const componentIds = (data?.component_ids ?? []) as string[];
  const fieldRules = (data?.field_rules ?? []) as FieldRule[];
  const dimensionRules = (data?.dimension_rules ?? []) as DimensionRule[];
  const canonicalDimensionOrder = (data?.canonical_dimension_order ?? []) as string[];

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? "Blueprint"}
        breadcrumbs={[
          { label: "Blueprints", href: "#/blueprints" },
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
                { key: "ID", value: data.blueprint_id },
                { key: "Key", value: data.key },
                { key: "Name", value: data.name },
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
                {componentIds.length === 0 ? (
                  <Text tone="secondary">No components attached.</Text>
                ) : (
                  <DataTable
                    rows={componentIds.map((cId) => ({ id: cId }))}
                    columns={[
                      { key: "id", header: "Component ID", cell: (row) => row.id },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) => data.status === "draft" ? (
                          <Button size="sm" tone="danger" onClick={() => handleDetachComponent(row.id)}>Detach</Button>
                        ) : null,
                      },
                    ]}
                    getRowId={(row) => row.id}
                  />
                )}
              </Stack>
            </PageSection>

            <PageSection title="Field Rules">
              <DataTable
                rows={fieldRules}
                columns={[
                  { key: "fieldId", header: "Field ID", cell: (row) => row.fieldId },
                  { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
                ] as DataColumn<FieldRule>[]}
                getRowId={(row) => row.fieldId}
                emptyTitle="No field rules"
              />
            </PageSection>

            <PageSection title="Dimension Rules">
              <DataTable
                rows={dimensionRules}
                columns={[
                  { key: "dimensionId", header: "Dimension ID", cell: (row) => row.dimensionId },
                  { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
                ] as DataColumn<DimensionRule>[]}
                getRowId={(row) => row.dimensionId}
                emptyTitle="No dimension rules"
              />
            </PageSection>

            <PageSection title="Version Rules">
              <Stack gap={3}>
                <KeyValueList
                  items={[
                    { key: "Canonical Dimension Order", value: canonicalDimensionOrder.length > 0 ? canonicalDimensionOrder.join(", ") : "Not set" },
                  ]}
                />
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={() => {
                      setCanonicalOrder(canonicalDimensionOrder.join(", "));
                      setShowSetVersionRules(true);
                    }}>
                      Set Version Rules
                    </Button>
                  </Inline>
                )}
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={showAttachComponent}
        onOpenChange={setShowAttachComponent}
        title="Attach Component"
        footer={<Button onClick={handleAttachComponent}>Attach</Button>}
      >
        <TextInput label="Component ID" value={componentId} onChange={(e) => setComponentId(e.target.value)} />
      </Dialog>

      <Dialog
        open={showSetVersionRules}
        onOpenChange={setShowSetVersionRules}
        title="Set Version Rules"
        description="Enter dimension IDs separated by commas in the canonical order."
        footer={<Button onClick={handleSetVersionRules}>Save</Button>}
      >
        <TextInput
          label="Canonical Dimension Order"
          value={canonicalOrder}
          onChange={(e) => setCanonicalOrder(e.target.value)}
        />
      </Dialog>
    </>
  );
}
