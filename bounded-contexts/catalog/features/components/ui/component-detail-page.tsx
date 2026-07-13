import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
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
    return t("catalog.features.components.ui.componentDetailPage.always");
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
        {
          label: t("catalog.features.components.ui.componentDetailPage.activate"),
          action: "activate",
          tone: "primary",
        },
      ];
    case "active":
      return [
        {
          label: t("catalog.features.components.ui.componentDetailPage.deprecate"),
          action: "deprecate",
          confirm: true,
          tone: "danger",
        },
      ];
    case "deprecated":
      return [
        {
          label: t("catalog.features.components.ui.componentDetailPage.archive"),
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
    case "activate":
      return t("catalog.features.components.ui.componentDetailPage.activated");
    case "deprecate":
      return t("catalog.features.components.ui.componentDetailPage.deprecated");
    case "archive":
      return t("catalog.features.components.ui.componentDetailPage.archived");
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

export function ComponentDetailPage({
  id,
  initialData,
}: {
  id: string;
  initialData?: Parameters<typeof useComponent>[1];
}) {
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
    addToast(
      t("catalog.features.components.ui.componentDetailPage.lifecycle.completed", {
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

  async function handleConfigure() {
    await configureComponent(id, {
      key: editKey,
      name: localizedTextMapFromEnglish(editName),
      description: localizedTextMapFromEnglish(editDescription),
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
    addToast(t("catalog.features.components.ui.componentDetailPage.component.updated"), "success");
    setEditing(false);
    refresh();
  }

  async function handleAddFieldRule() {
    await addFieldRule(id, { fieldId, required: fieldRequired });
    addToast(t("catalog.features.components.ui.componentDetailPage.field.rule.added"), "success");
    setShowAddField(false);
    setFieldId("");
    setFieldRequired(false);
    refresh();
  }

  async function handleRemoveFieldRule(fId: string) {
    await removeFieldRule(id, fId);
    addToast(t("catalog.features.components.ui.componentDetailPage.field.rule.removed"), "success");
    refresh();
  }

  async function handleAddDimensionRule() {
    const allowedOptionIds = dimAllowedOptionIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await addDimensionRule(id, {
      dimensionId,
      required: dimRequired,
      allowedOptionIds: allowedOptionIds.length > 0 ? allowedOptionIds : undefined,
      appliesWhen: parseApplicabilityClauses(dimAppliesWhen),
    });
    addToast(t("catalog.features.components.ui.componentDetailPage.dimension.rule.added"), "success");
    setShowAddDimension(false);
    setDimensionId("");
    setDimRequired(false);
    setDimAllowedOptionIds("");
    setDimAppliesWhen("");
    refresh();
  }

  async function handleRemoveDimensionRule(dId: string) {
    await removeDimensionRule(id, dId);
    addToast(t("catalog.features.components.ui.componentDetailPage.dimension.rule.removed"), "success");
    refresh();
  }

  const fieldRules = (data?.field_rules ?? []) as FieldRule[];
  const dimensionRules = (data?.dimension_rules ?? []) as DimensionRule[];

  const fieldRuleColumns: DataColumn<FieldRule>[] = [
    {
      key: "fieldId",
      header: t("catalog.features.components.ui.componentDetailPage.field"),
      cell: (row) => row.fieldName,
    },
    {
      key: "required",
      header: t("catalog.features.components.ui.componentDetailPage.required"),
      cell: (row) =>
        row.required
          ? t("catalog.features.components.ui.componentDetailPage.yes")
          : t("catalog.features.components.ui.componentDetailPage.no"),
    },
    {
      key: "actions",
      header: "",
      cell: (row) =>
        data?.status === "draft" ? (
          <Button size="sm" tone="danger" onClick={() => handleRemoveFieldRule(row.fieldId)}>
            {t("catalog.features.components.ui.componentDetailPage.remove")}
          </Button>
        ) : null,
    },
  ];

  const dimensionRuleColumns: DataColumn<DimensionRule>[] = [
    {
      key: "dimensionId",
      header: t("catalog.features.components.ui.componentDetailPage.dimension"),
      cell: (row) => row.dimensionName,
    },
    {
      key: "required",
      header: t("catalog.features.components.ui.componentDetailPage.required.2"),
      cell: (row) =>
        row.required
          ? t("catalog.features.components.ui.componentDetailPage.yes.2")
          : t("catalog.features.components.ui.componentDetailPage.no.2"),
    },
    {
      key: "allowedOptions",
      header: t("catalog.features.components.ui.componentDetailPage.allowed.options"),
      cell: (row) =>
        row.allowedOptions.length > 0
          ? row.allowedOptions.map((option) => option.code).join(", ")
          : t("catalog.features.components.ui.componentDetailPage.all"),
    },
    {
      key: "appliesWhen",
      header: t("catalog.features.components.ui.componentDetailPage.applies.when"),
      cell: (row) => formatApplicability(row.appliesWhen),
    },
    {
      key: "actions",
      header: "",
      cell: (row) =>
        data?.status === "draft" ? (
          <Button size="sm" tone="danger" onClick={() => handleRemoveDimensionRule(row.dimensionId)}>
            {t("catalog.features.components.ui.componentDetailPage.remove.2")}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <EntityDetailPage
        title={data?.name ?? t("catalog.features.components.ui.componentDetailPage.component")}
        breadcrumbs={[
          { label: t("catalog.features.components.ui.componentDetailPage.components"), href: "/components" },
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
              {data.status === "draft" && (
                <Button tone="secondary" size="sm" onClick={startEditing}>
                  {t("catalog.features.components.ui.componentDetailPage.edit")}
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
                { key: t("catalog.features.components.ui.componentDetailPage.key"), value: data.key },
                { key: t("catalog.features.components.ui.componentDetailPage.name"), value: data.name },
                {
                  key: t("catalog.features.components.ui.componentDetailPage.description"),
                  value: data.description ?? "—",
                },
                { key: t("catalog.features.components.ui.componentDetailPage.status"), value: data.status },
                { key: t("catalog.features.components.ui.componentDetailPage.updated"), value: data.updated_at },
              ]}
            />

            <PageSection title={t("catalog.features.components.ui.componentDetailPage.field.rules")}>
              <Stack gap={3}>
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAddField(true)}>
                      {t("catalog.features.components.ui.componentDetailPage.add.field.rule")}
                    </Button>
                  </Inline>
                )}
                <DataTable
                  rows={fieldRules}
                  columns={fieldRuleColumns}
                  getRowId={(row) => row.fieldId}
                  emptyTitle={t("catalog.features.components.ui.componentDetailPage.no.field.rules")}
                />
              </Stack>
            </PageSection>

            <PageSection title={t("catalog.features.components.ui.componentDetailPage.dimension.rules")}>
              <Stack gap={3}>
                {data.status === "draft" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAddDimension(true)}>
                      {t("catalog.features.components.ui.componentDetailPage.add.dimension.rule")}
                    </Button>
                  </Inline>
                )}
                <DataTable
                  rows={dimensionRules}
                  columns={dimensionRuleColumns}
                  getRowId={(row) => row.dimensionId}
                  emptyTitle={t("catalog.features.components.ui.componentDetailPage.no.dimension.rules")}
                />
              </Stack>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t("catalog.features.components.ui.componentDetailPage.edit.component")}
        footer={
          <Button onClick={handleConfigure}>{t("catalog.features.components.ui.componentDetailPage.save")}</Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.components.ui.componentDetailPage.key")}
            value={editKey}
            onChange={(e) => setEditKey(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.components.ui.componentDetailPage.name")}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.components.ui.componentDetailPage.description")}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showAddField}
        onOpenChange={setShowAddField}
        title={t("catalog.features.components.ui.componentDetailPage.add.field.rule.2")}
        footer={
          <Button onClick={handleAddFieldRule}>{t("catalog.features.components.ui.componentDetailPage.add")}</Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.components.ui.componentDetailPage.field.id")}
            value={fieldId}
            onChange={(e) => setFieldId(e.target.value)}
          />
          <Checkbox
            label={t("catalog.features.components.ui.componentDetailPage.required.3")}
            checked={fieldRequired}
            onCheckedChange={(v) => setFieldRequired(v === true)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showAddDimension}
        onOpenChange={setShowAddDimension}
        title={t("catalog.features.components.ui.componentDetailPage.add.dimension.rule.2")}
        footer={
          <Button onClick={handleAddDimensionRule}>
            {t("catalog.features.components.ui.componentDetailPage.add.2")}
          </Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.components.ui.componentDetailPage.dimension.id")}
            value={dimensionId}
            onChange={(e) => setDimensionId(e.target.value)}
          />
          <Checkbox
            label={t("catalog.features.components.ui.componentDetailPage.required.4")}
            checked={dimRequired}
            onCheckedChange={(v) => setDimRequired(v === true)}
          />
          <TextInput
            label={t("catalog.features.components.ui.componentDetailPage.allowed.option.ids.comma.separated.leave")}
            value={dimAllowedOptionIds}
            onChange={(e) => setDimAllowedOptionIds(e.target.value)}
          />
          <TextInput
            label={t(
              "catalog.features.components.ui.componentDetailPage.applies.when.dimensionid.optionid.optionid.comma",
            )}
            value={dimAppliesWhen}
            onChange={(e) => setDimAppliesWhen(e.target.value)}
          />
        </Stack>
      </Dialog>
    </>
  );
}
