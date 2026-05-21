import { t } from "@chase-sets/localization";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { useState } from "react";
import {
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  ProgressiveDisclosure,
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
    return t("catalog.features.blueprints.ui.blueprintDetailPage.always");
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

function serializeApplicabilityClauses(clauses: Array<{ dimensionId: string; optionIds?: string[] }>): string {
  return clauses.map((clause) => `${clause.dimensionId}=${(clause.optionIds ?? []).join("|")}`).join(", ");
}

function parseApplicabilityClauses(value: string): Array<{ dimensionId: string; optionIds: string[] }> {
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
      return [
        { label: t("catalog.features.blueprints.ui.blueprintDetailPage.publish"), action: "publish", tone: "primary" },
      ];
    case "active":
      return [
        {
          label: t("catalog.features.blueprints.ui.blueprintDetailPage.deprecate"),
          action: "deprecate",
          confirm: true,
          tone: "danger",
        },
      ];
    case "deprecated":
      return [
        {
          label: t("catalog.features.blueprints.ui.blueprintDetailPage.archive"),
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
      return t("catalog.features.blueprints.ui.blueprintDetailPage.published");
    case "deprecate":
      return t("catalog.features.blueprints.ui.blueprintDetailPage.deprecated");
    case "archive":
      return t("catalog.features.blueprints.ui.blueprintDetailPage.archived");
    default:
      return action;
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

export function BlueprintDetailPage({
  id,
  initialData,
}: {
  id: string;
  initialData?: Parameters<typeof useBlueprint>[1];
}) {
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
    addToast(
      t("catalog.features.blueprints.ui.blueprintDetailPage.lifecycle.completed", {
        action: lifecycleActionLabel(action),
      }),
      "success",
    );
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
    await reviseBlueprint(id, {
      key: editKey,
      name: localizedTextMapFromEnglish(editName),
      description: localizedTextMapFromEnglish(editDescription),
    });
    addToast(t("catalog.features.blueprints.ui.blueprintDetailPage.blueprint.revised"), "success");
    setEditing(false);
    refresh();
  }

  async function handleAttachComponent() {
    await attachComponent(id, componentId);
    addToast(t("catalog.features.blueprints.ui.blueprintDetailPage.component.attached"), "success");
    setShowAttachComponent(false);
    setComponentId("");
    refresh();
  }

  async function handleDetachComponent(compId: string) {
    await detachComponent(id, compId);
    addToast(t("catalog.features.blueprints.ui.blueprintDetailPage.component.detached"), "success");
    refresh();
  }

  async function handleSetProductResolutionRules() {
    const order = canonicalOrder
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await setBlueprintProductResolutionRules(id, order);
    addToast(t("catalog.features.blueprints.ui.blueprintDetailPage.product.resolution.rules.set"), "success");
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
    addToast(t("catalog.features.blueprints.ui.blueprintDetailPage.field.rules.set"), "success");
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
        allowedOptionIds: r.allowedOptionIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        appliesWhen: parseApplicabilityClauses(r.appliesWhen),
      }));
    await setBlueprintDimensions(id, rules);
    addToast(t("catalog.features.blueprints.ui.blueprintDetailPage.dimension.rules.set"), "success");
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
        title={data?.name ?? t("catalog.features.blueprints.ui.blueprintDetailPage.blueprint")}
        breadcrumbs={[
          { label: t("catalog.features.blueprints.ui.blueprintDetailPage.blueprints"), href: "/blueprints" },
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
                  {t("catalog.features.blueprints.ui.blueprintDetailPage.edit")}
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
                { key: t("catalog.features.blueprints.ui.blueprintDetailPage.key"), value: data.key },
                { key: t("catalog.features.blueprints.ui.blueprintDetailPage.name"), value: data.name },
                {
                  key: t("catalog.features.blueprints.ui.blueprintDetailPage.description"),
                  value: data.description ?? "—",
                },
                { key: t("catalog.features.blueprints.ui.blueprintDetailPage.status"), value: data.status },
                { key: t("catalog.features.blueprints.ui.blueprintDetailPage.updated"), value: data.updated_at },
              ]}
            />

            <PageSection title={t("catalog.features.blueprints.ui.blueprintDetailPage.components")}>
              <Stack gap={3}>
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAttachComponent(true)}>
                      {t("catalog.features.blueprints.ui.blueprintDetailPage.attach.component")}
                    </Button>
                  </Inline>
                )}
                {components.length === 0 ? (
                  <Text tone="secondary">
                    {t("catalog.features.blueprints.ui.blueprintDetailPage.no.components.attached")}
                  </Text>
                ) : (
                  <DataTable
                    rows={components}
                    columns={[
                      {
                        key: "componentId",
                        header: t("catalog.features.blueprints.ui.blueprintDetailPage.component"),
                        cell: (row) => row.name,
                      },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) =>
                          data.status === "draft" ? (
                            <Button size="sm" tone="danger" onClick={() => handleDetachComponent(row.componentId)}>
                              {t("catalog.features.blueprints.ui.blueprintDetailPage.detach")}
                            </Button>
                          ) : null,
                      },
                    ]}
                    getRowId={(row) => row.componentId}
                  />
                )}
              </Stack>
            </PageSection>

            <PageSection title={t("catalog.features.blueprints.ui.blueprintDetailPage.field.rules")}>
              <ProgressiveDisclosure
                title={t("catalog.features.blueprints.ui.blueprintDetailPage.field.rules")}
                summary={t("catalog.features.blueprints.ui.blueprintDetailPage.field.rules.summary", {
                  count: fieldRules.length,
                })}
                tone={fieldRules.some((rule) => rule.required) ? "warning" : "info"}
              >
                <Stack gap={3}>
                  {data.status === "draft" && (
                    <Inline>
                      <Button size="sm" onClick={startSetFieldRules}>
                        {t("catalog.features.blueprints.ui.blueprintDetailPage.set.field.rules")}
                      </Button>
                    </Inline>
                  )}
                  <DataTable
                    rows={fieldRules}
                    columns={
                      [
                        {
                          key: "fieldId",
                          header: t("catalog.features.blueprints.ui.blueprintDetailPage.field"),
                          cell: (row) => row.fieldName,
                        },
                        {
                          key: "required",
                          header: t("catalog.features.blueprints.ui.blueprintDetailPage.required"),
                          cell: (row) =>
                            row.required
                              ? t("catalog.features.blueprints.ui.blueprintDetailPage.yes")
                              : t("catalog.features.blueprints.ui.blueprintDetailPage.no"),
                        },
                      ] as DataColumn<FieldRule>[]
                    }
                    getRowId={(row) => row.fieldId}
                    emptyTitle={t("catalog.features.blueprints.ui.blueprintDetailPage.no.field.rules")}
                  />
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection title={t("catalog.features.blueprints.ui.blueprintDetailPage.dimension.rules")}>
              <ProgressiveDisclosure
                title={t("catalog.features.blueprints.ui.blueprintDetailPage.dimension.rules")}
                summary={t("catalog.features.blueprints.ui.blueprintDetailPage.dimension.rules.summary", {
                  count: dimensionRules.length,
                })}
                tone={dimensionRules.some((rule) => rule.required) ? "warning" : "info"}
              >
                <Stack gap={3}>
                  {data.status === "draft" && (
                    <Inline>
                      <Button size="sm" onClick={startSetDimRules}>
                        {t("catalog.features.blueprints.ui.blueprintDetailPage.set.dimension.rules")}
                      </Button>
                    </Inline>
                  )}
                  <DataTable
                    rows={dimensionRules}
                    columns={
                      [
                        {
                          key: "dimensionId",
                          header: t("catalog.features.blueprints.ui.blueprintDetailPage.dimension"),
                          cell: (row) => row.dimensionName,
                        },
                        {
                          key: "required",
                          header: t("catalog.features.blueprints.ui.blueprintDetailPage.required.2"),
                          cell: (row) =>
                            row.required
                              ? t("catalog.features.blueprints.ui.blueprintDetailPage.yes.2")
                              : t("catalog.features.blueprints.ui.blueprintDetailPage.no.2"),
                        },
                        {
                          key: "allowedOptions",
                          header: t("catalog.features.blueprints.ui.blueprintDetailPage.allowed.options"),
                          cell: (row) =>
                            row.allowedOptions.length > 0
                              ? row.allowedOptions.map((option) => option.code).join(", ")
                              : t("catalog.features.blueprints.ui.blueprintDetailPage.all"),
                        },
                        {
                          key: "appliesWhen",
                          header: t("catalog.features.blueprints.ui.blueprintDetailPage.applies.when"),
                          cell: (row) => formatApplicability(row.appliesWhen),
                        },
                      ] as DataColumn<DimensionRule>[]
                    }
                    getRowId={(row) => row.dimensionId}
                    emptyTitle={t("catalog.features.blueprints.ui.blueprintDetailPage.no.dimension.rules")}
                  />
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection title={t("catalog.features.blueprints.ui.blueprintDetailPage.product.resolution.rules")}>
              <ProgressiveDisclosure
                title={t("catalog.features.blueprints.ui.blueprintDetailPage.product.resolution.rules")}
                summary={
                  canonicalDimensionOrder.length > 0
                    ? canonicalDimensionOrder.map((dimension) => dimension.dimensionName).join(", ")
                    : t("catalog.features.blueprints.ui.blueprintDetailPage.not.set")
                }
                tone={canonicalDimensionOrder.length > 0 ? "info" : "warning"}
              >
                <Stack gap={3}>
                  <KeyValueList
                    items={[
                      {
                        key: t("catalog.features.blueprints.ui.blueprintDetailPage.canonical.dimension.order"),
                        value:
                          canonicalDimensionOrder.length > 0
                            ? canonicalDimensionOrder.map((dimension) => dimension.dimensionName).join(", ")
                            : t("catalog.features.blueprints.ui.blueprintDetailPage.not.set"),
                      },
                    ]}
                  />
                  {data.status === "draft" && (
                    <Inline>
                      <Button
                        size="sm"
                        onClick={() => {
                          setCanonicalOrder(
                            canonicalDimensionOrder.map((dimension) => dimension.dimensionId).join(", "),
                          );
                          setShowSetProductResolutionRules(true);
                        }}
                      >
                        {t("catalog.features.blueprints.ui.blueprintDetailPage.set.product.resolution.rules")}
                      </Button>
                    </Inline>
                  )}
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.blueprints.ui.blueprintDetailPage.edit.blueprint")}
        footer={<Button onClick={handleRevise}>{t("catalog.features.blueprints.ui.blueprintDetailPage.save")}</Button>}
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.blueprints.ui.blueprintDetailPage.key")}
            value={editKey}
            onChange={(e) => setEditKey(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.blueprints.ui.blueprintDetailPage.name")}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.blueprints.ui.blueprintDetailPage.description")}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showAttachComponent}
        onOpenChange={setShowAttachComponent}
        title={t("catalog.features.blueprints.ui.blueprintDetailPage.attach.component.2")}
        footer={
          <Button onClick={handleAttachComponent}>
            {t("catalog.features.blueprints.ui.blueprintDetailPage.attach")}
          </Button>
        }
      >
        <TextInput
          label={t("catalog.features.blueprints.ui.blueprintDetailPage.component.id")}
          value={componentId}
          onChange={(e) => setComponentId(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetProductResolutionRules}
        onOpenChange={setShowSetProductResolutionRules}
        title={t("catalog.features.blueprints.ui.blueprintDetailPage.set.product.resolution.rules.2")}
        description={t("catalog.features.blueprints.ui.blueprintDetailPage.enter.dimension.ids.separated.by.commas")}
        footer={
          <Button onClick={handleSetProductResolutionRules}>
            {t("catalog.features.blueprints.ui.blueprintDetailPage.save.2")}
          </Button>
        }
      >
        <TextInput
          label={t("catalog.features.blueprints.ui.blueprintDetailPage.canonical.dimension.order")}
          value={canonicalOrder}
          onChange={(e) => setCanonicalOrder(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetFieldRules}
        onOpenChange={setShowSetFieldRules}
        title={t("catalog.features.blueprints.ui.blueprintDetailPage.set.field.rules.2")}
        description={t("catalog.features.blueprints.ui.blueprintDetailPage.configure.which.fields.apply.to.this")}
        footer={
          <Button onClick={handleSetFieldRules}>
            {t("catalog.features.blueprints.ui.blueprintDetailPage.save.3")}
          </Button>
        }
      >
        <Stack gap={3}>
          {editFieldRules.map((rule, i) => (
            <Inline key={i} gap={2}>
              <TextInput
                label={i === 0 ? t("catalog.features.blueprints.ui.blueprintDetailPage.field.id") : undefined}
                value={rule.fieldId}
                onChange={(e) =>
                  setEditFieldRules((prev) => prev.map((r, j) => (j === i ? { ...r, fieldId: e.target.value } : r)))
                }
              />
              <Checkbox
                label={t("catalog.features.blueprints.ui.blueprintDetailPage.required.3")}
                checked={rule.required}
                onCheckedChange={(v) =>
                  setEditFieldRules((prev) => prev.map((r, j) => (j === i ? { ...r, required: v === true } : r)))
                }
              />
              <Button
                size="sm"
                tone="danger"
                onClick={() => setEditFieldRules((prev) => prev.filter((_, j) => j !== i))}
              >
                {t("catalog.features.blueprints.ui.blueprintDetailPage.remove")}
              </Button>
            </Inline>
          ))}
          <Inline>
            <Button
              size="sm"
              tone="secondary"
              onClick={() => setEditFieldRules((prev) => [...prev, { fieldId: "", required: false }])}
            >
              {t("catalog.features.blueprints.ui.blueprintDetailPage.add.rule")}
            </Button>
          </Inline>
        </Stack>
      </Dialog>

      <Dialog
        open={showSetDimRules}
        onOpenChange={setShowSetDimRules}
        title={t("catalog.features.blueprints.ui.blueprintDetailPage.set.dimension.rules.2")}
        description={t("catalog.features.blueprints.ui.blueprintDetailPage.configure.which.dimensions.apply.to.this")}
        footer={
          <Button onClick={handleSetDimRules}>{t("catalog.features.blueprints.ui.blueprintDetailPage.save.4")}</Button>
        }
      >
        <Stack gap={3}>
          {editDimRules.map((rule, i) => (
            <Stack key={i} gap={2}>
              <Inline gap={2}>
                <TextInput
                  label={i === 0 ? t("catalog.features.blueprints.ui.blueprintDetailPage.dimension.id") : undefined}
                  value={rule.dimensionId}
                  onChange={(e) =>
                    setEditDimRules((prev) => prev.map((r, j) => (j === i ? { ...r, dimensionId: e.target.value } : r)))
                  }
                />
                <Checkbox
                  label={t("catalog.features.blueprints.ui.blueprintDetailPage.required.4")}
                  checked={rule.required}
                  onCheckedChange={(v) =>
                    setEditDimRules((prev) => prev.map((r, j) => (j === i ? { ...r, required: v === true } : r)))
                  }
                />
                <Button
                  size="sm"
                  tone="danger"
                  onClick={() => setEditDimRules((prev) => prev.filter((_, j) => j !== i))}
                >
                  {t("catalog.features.blueprints.ui.blueprintDetailPage.remove.2")}
                </Button>
              </Inline>
              <TextInput
                label={t("catalog.features.blueprints.ui.blueprintDetailPage.allowed.option.ids.comma.separated.leave")}
                value={rule.allowedOptionIds}
                onChange={(e) =>
                  setEditDimRules((prev) =>
                    prev.map((r, j) => (j === i ? { ...r, allowedOptionIds: e.target.value } : r)),
                  )
                }
              />
              <TextInput
                label={t(
                  "catalog.features.blueprints.ui.blueprintDetailPage.applies.when.dimensionid.optionid.optionid.comma",
                )}
                value={rule.appliesWhen}
                onChange={(e) =>
                  setEditDimRules((prev) => prev.map((r, j) => (j === i ? { ...r, appliesWhen: e.target.value } : r)))
                }
              />
            </Stack>
          ))}
          <Inline>
            <Button
              size="sm"
              tone="secondary"
              onClick={() =>
                setEditDimRules((prev) => [
                  ...prev,
                  { dimensionId: "", required: false, allowedOptionIds: "", appliesWhen: "" },
                ])
              }
            >
              {t("catalog.features.blueprints.ui.blueprintDetailPage.add.rule.2")}
            </Button>
          </Inline>
        </Stack>
      </Dialog>
    </>
  );
}
