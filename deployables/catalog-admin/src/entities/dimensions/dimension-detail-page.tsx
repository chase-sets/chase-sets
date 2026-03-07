import { useState } from "react";
import {
  Button,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  Stack,
  StatusPill,
  TextInput,
  NumberInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../toasts";
import { EntityDetailPage } from "../../shared/entity-detail-page";
import { LifecycleControls, type Transition } from "../../shared/lifecycle-controls";
import {
  useDimension,
  reviseDimension,
  activateDimension,
  deprecateDimension,
  archiveDimension,
  addChoice,
  reviseChoice,
  deprecateChoice,
  reactivateChoice,
} from "./use-dimensions";
import type { DimensionChoice } from "../../api/types";

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

const choiceColumns: DataColumn<DimensionChoice>[] = [
  { key: "code", header: "Code", cell: (row) => row.code },
  { key: "numeric_value", header: "Numeric Value", cell: (row) => row.numeric_value ?? "—" },
  { key: "display_order", header: "Order", cell: (row) => row.display_order },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

export function DimensionDetailPage({ id }: { id: string }) {
  const { data, loading, error, refresh } = useDimension(id);
  const { addToast } = useToasts();
  const [showAddChoice, setShowAddChoice] = useState(false);
  const [choiceCode, setChoiceCode] = useState("");
  const [choiceNumericValue, setChoiceNumericValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");

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
    await reviseDimension(id, { key: editKey, name: editName });
    addToast("Dimension revised", "success");
    setEditing(false);
    refresh();
  }

  async function handleAddChoice() {
    const choiceId = crypto.randomUUID();
    await addChoice(id, {
      choiceId,
      code: choiceCode,
      numericValue: choiceNumericValue ? Number(choiceNumericValue) : undefined,
    });
    addToast("Choice added", "success");
    setShowAddChoice(false);
    setChoiceCode("");
    setChoiceNumericValue("");
    refresh();
  }

  async function handleDeprecateChoice(choiceId: string) {
    await deprecateChoice(id, choiceId);
    addToast("Choice deprecated", "success");
    refresh();
  }

  async function handleReactivateChoice(choiceId: string) {
    await reactivateChoice(id, choiceId);
    addToast("Choice reactivated", "success");
    refresh();
  }

  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditing(true);
    }
  }

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? "Dimension"}
        breadcrumbs={[
          { label: "Dimensions", href: "#/dimensions" },
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
                { key: "ID", value: data.dimension_id },
                { key: "Key", value: data.key },
                { key: "Name", value: data.name },
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at },
              ]}
            />

            <PageSection
              title="Choices"
              description={`${data.choices.length} choice(s)`}
            >
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline gap={2}>
                    <Button size="sm" onClick={() => setShowAddChoice(true)}>Add Choice</Button>
                  </Inline>
                )}
                <DataTable
                  rows={data.choices}
                  columns={[
                    ...choiceColumns,
                    {
                      key: "actions",
                      header: "Actions",
                      cell: (row) => (
                        <Inline gap={1}>
                          {row.status === "active" && (
                            <Button size="sm" tone="secondary" onClick={() => handleDeprecateChoice(row.choice_id)}>
                              Deprecate
                            </Button>
                          )}
                          {row.status === "deprecated" && (
                            <Button size="sm" tone="secondary" onClick={() => handleReactivateChoice(row.choice_id)}>
                              Reactivate
                            </Button>
                          )}
                        </Inline>
                      ),
                    },
                  ]}
                  getRowId={(row) => row.choice_id}
                  emptyTitle="No choices"
                  emptyDescription="Add a choice to this dimension."
                />
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={showAddChoice}
        onOpenChange={setShowAddChoice}
        title="Add Choice"
        footer={<Button onClick={handleAddChoice}>Add</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Code" value={choiceCode} onChange={(e) => setChoiceCode(e.target.value)} />
          <TextInput label="Numeric Value (optional)" value={choiceNumericValue} onChange={(e) => setChoiceNumericValue(e.target.value)} />
        </Stack>
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
        </Stack>
      </Dialog>
    </>
  );
}
