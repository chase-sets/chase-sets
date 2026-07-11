import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import {
  AlertDialog,
  BulkActionBar,
  BulkActionPanel,
  Button,
  DataTable,
  Dialog,
  Inline,
  Select,
  Stack,
  StatusPill,
  Text,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import {
  BulkLifecycleProgressSummary,
  type BulkLifecycleCandidate,
  type BulkLifecycleProgress,
  type BulkLifecyclePreview,
  type BulkLifecycleResult,
  type BulkLifecycleSelection,
} from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import {
  confirmBulkPublishCatalogItems,
  confirmBulkCatalogItemEdit,
  confirmBulkCatalogItemLifecycle,
  createCatalogItem,
  localizedTextMapFromEnglish,
  previewBulkCatalogItemEdit,
  previewBulkCatalogItemLifecycle,
  previewBulkPublishCatalogItems,
  removeDraftCatalogItem,
} from "./use-catalog-items";
import type {
  BulkEditCatalogItemCandidate,
  BulkEditCatalogItemOperation,
  BulkEditCatalogItemPreview,
  BulkEditCatalogItemResult,
  BulkPublishCandidate,
  BulkPublishPreview,
  BulkPublishResult,
  CatalogItemListItem,
} from "./contracts";

function buildColumns(): DataColumn<CatalogItemListItem>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    {
      key: "subtitle",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.subtitle"),
      cell: (row) => row.subtitle ?? "—",
    },
    {
      key: "language",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.language"),
      cell: (row) => formatLanguageCodeLabel(row.language_code),
    },
    {
      key: "blueprint",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint"),
      cell: (row) => row.blueprint?.name ?? "—",
    },
    {
      key: "source",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.source"),
      cell: (row) => (row.source_providers.length > 0 ? row.source_providers.join(", ") : "—"),
    },
    {
      key: "status",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.status"),
      cell: (row) => <StatusPill>{row.status}</StatusPill>,
    },
  ];
}

function buildBulkPreviewColumns(): DataColumn<BulkPublishCandidate>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    {
      key: "source",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.source"),
      cell: (row) => row.source_providers.join(", ") || "—",
    },
    {
      key: "status",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.status"),
      cell: (row) => row.status,
    },
    {
      key: "outcome",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.result"),
      cell: (row) => <StatusPill>{row.outcome}</StatusPill>,
    },
    {
      key: "reason",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.reason"),
      cell: (row) => row.reason ?? "—",
    },
  ];
}

function buildBulkEditColumns(): DataColumn<BulkEditCatalogItemCandidate>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    {
      key: "status",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.status"),
      cell: (row) => row.status,
    },
    {
      key: "blueprint",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.id"),
      cell: (row) => row.blueprint_id ?? "—",
    },
    {
      key: "categories",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.category.ids"),
      cell: (row) => row.category_ids.join(", ") || "—",
    },
    {
      key: "tags",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.tags"),
      cell: (row) => row.tags.join(", ") || "—",
    },
    {
      key: "outcome",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.result"),
      cell: (row) => <StatusPill>{row.outcome}</StatusPill>,
    },
    {
      key: "reason",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.reason"),
      cell: (row) => row.reason ?? "—",
    },
  ];
}

function buildBulkLifecycleColumns(): DataColumn<BulkLifecycleCandidate>[] {
  return [
    {
      key: "label",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.record"),
      cell: (row) => row.label,
    },
    {
      key: "status",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.status"),
      cell: (row) => row.status,
    },
    {
      key: "outcome",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.outcome"),
      cell: (row) => <StatusPill>{row.outcome}</StatusPill>,
    },
    {
      key: "reason",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.reason"),
      cell: (row) => row.reason ?? "—",
    },
  ];
}

const statusOptions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.draft"), value: "draft" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.active"), value: "active" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.retired"), value: "retired" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.archived"), value: "archived" },
];

const ALL_LANGUAGES = "__all__";
const ALL_FILTER_VALUES = "__all__";

const languageOptions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.english"), value: "en" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.japanese"), value: "ja" },
];
const booleanOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_FILTER_VALUES },
  { label: t("catalog.support.shellSupport.ui.entityListPage.yes"), value: "true" },
  { label: t("catalog.support.shellSupport.ui.entityListPage.no"), value: "false" },
];
const blueprintStateOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_FILTER_VALUES },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.assigned"), value: "assigned" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.missing"), value: "missing" },
];
const lifecycleActions = [
  { value: "archive", label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.archive") },
];
const bulkEditActions = [
  {
    label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.assign.blueprint"),
    value: "assignBlueprint",
  },
  {
    label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.assign.category"),
    value: "assignCategory",
  },
  {
    label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.remove.category"),
    value: "removeCategory",
  },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.set.tags"), value: "setTags" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.merge.tags"), value: "mergeTags" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.clear.tags"), value: "clearTags" },
];

type CatalogItemBulkOperation = "publish" | "archive" | BulkEditCatalogItemOperation["action"];

const catalogItemBulkOperationOptions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.operation.publish"), value: "publish" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.operation.archive"), value: "archive" },
  ...bulkEditActions,
];

function isBulkEditOperation(action: CatalogItemBulkOperation): action is BulkEditCatalogItemOperation["action"] {
  return (
    action === "assignBlueprint" ||
    action === "assignCategory" ||
    action === "removeCategory" ||
    action === "setTags" ||
    action === "mergeTags" ||
    action === "clearTags"
  );
}

function isLifecycleOperation(action: CatalogItemBulkOperation): action is "archive" {
  return action === "archive";
}

type CatalogItemListPageProps = CatalogListRouteData<CatalogItemListItem> &
  Readonly<{
    realtimeReloadActionBar?: ReactNode;
    connectionStatus?: ReactNode;
  }>;

export function CatalogItemListPage({
  data,
  query,
  realtimeReloadActionBar,
  connectionStatus,
}: CatalogItemListPageProps) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const columns = useMemo(() => buildColumns(), []);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [description, setDescription] = useState("");
  const [languageCode, setLanguageCode] = useState("en");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkPreview, setBulkPreview] = useState<BulkPublishPreview | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkPublishResult | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkLifecycleProgress | null>(null);
  const [bulkScopeLabel, setBulkScopeLabel] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showRemoveDrafts, setShowRemoveDrafts] = useState(false);
  const bulkColumns = useMemo(() => buildBulkPreviewColumns(), []);
  const bulkRows = (bulkResult?.candidates ?? bulkPreview?.candidates ?? []).slice(0, 20);
  const selectedItems = useMemo(
    () => data.items.filter((item) => selectedKeys.has(item.catalog_item_id)),
    [data.items, selectedKeys],
  );
  const selectedDraftIds = selectedItems.filter((item) => item.status === "draft").map((item) => item.catalog_item_id);
  const canRemoveSelectedDrafts = selectedKeys.size > 0 && selectedDraftIds.length === selectedKeys.size;
  const [bulkOperation, setBulkOperation] = useState<CatalogItemBulkOperation>("publish");
  const [bulkLifecycleSelection, setBulkLifecycleSelection] = useState<BulkLifecycleSelection | null>(null);
  const [bulkLifecyclePreview, setBulkLifecyclePreview] = useState<BulkLifecyclePreview | null>(null);
  const [bulkLifecycleResult, setBulkLifecycleResult] = useState<BulkLifecycleResult | null>(null);
  const [bulkLifecycleProgress, setBulkLifecycleProgress] = useState<BulkLifecycleProgress | null>(null);
  const [bulkLifecycleBusy, setBulkLifecycleBusy] = useState(false);
  const bulkLifecycleColumns = useMemo(() => buildBulkLifecycleColumns(), []);
  const bulkLifecycleRows = (bulkLifecycleResult?.candidates ?? bulkLifecyclePreview?.candidates ?? []).slice(0, 20);
  const [bulkEditBlueprintId, setBulkEditBlueprintId] = useState("");
  const [bulkEditCategoryId, setBulkEditCategoryId] = useState("");
  const [bulkEditTags, setBulkEditTags] = useState("");
  const [bulkEditSelection, setBulkEditSelection] = useState<unknown | null>(null);
  const [bulkEditOperation, setBulkEditOperation] = useState<BulkEditCatalogItemOperation | null>(null);
  const [bulkEditPreview, setBulkEditPreview] = useState<BulkEditCatalogItemPreview | null>(null);
  const [bulkEditResult, setBulkEditResult] = useState<BulkEditCatalogItemResult | null>(null);
  const [bulkEditProgress, setBulkEditProgress] = useState<BulkLifecycleProgress | null>(null);
  const [bulkEditBusy, setBulkEditBusy] = useState(false);
  const bulkEditColumns = useMemo(() => buildBulkEditColumns(), []);
  const bulkEditRows = (bulkEditResult?.candidates ?? bulkEditPreview?.candidates ?? []).slice(0, 20);
  const dialogBulkEditAction =
    bulkEditResult?.action ?? bulkEditPreview?.action ?? bulkEditOperation?.action ?? "assignBlueprint";
  const bulkEditActionLabel = getBulkEditActionLabel(dialogBulkEditAction);
  const canPreviewBulkOperation =
    bulkOperation === "publish" ||
    isLifecycleOperation(bulkOperation) ||
    (isBulkEditOperation(bulkOperation) && canPreviewBulkEditAction(bulkOperation));
  const bulkOperationBusy = bulkBusy || bulkLifecycleBusy || bulkEditBusy;
  const bulkLifecycleActionLabel =
    lifecycleActions.find((action) => action.value === (bulkLifecycleResult?.action ?? bulkLifecyclePreview?.action))
      ?.label ??
    bulkLifecyclePreview?.action ??
    bulkOperation;
  const activeFilterCount = [
    listControls.search,
    listControls.status,
    listControls.language,
    listControls.source,
    listControls.blueprintId,
    listControls.tag,
    listControls.blueprintState,
    listControls.hasImages,
    listControls.hasSourceReferences,
    listControls.missingRequiredFields,
  ].filter(Boolean).length;

  function getBulkEditActionLabel(action: BulkEditCatalogItemOperation["action"]) {
    return bulkEditActions.find((option) => option.value === action)?.label ?? action;
  }

  function canPreviewBulkEditAction(action: BulkEditCatalogItemOperation["action"]) {
    return (
      action === "clearTags" ||
      (action === "assignBlueprint" && bulkEditBlueprintId.trim().length > 0) ||
      ((action === "assignCategory" || action === "removeCategory") && bulkEditCategoryId.trim().length > 0) ||
      ((action === "setTags" || action === "mergeTags") && tagsFromInput(bulkEditTags).length > 0)
    );
  }

  function getBulkOperationPreviewLabel(action: CatalogItemBulkOperation) {
    if (action === "publish") {
      return t("catalog.features.catalogItems.ui.catalogItemListPage.preview.publish");
    }

    if (action === "archive") {
      return t("catalog.features.catalogItems.ui.catalogItemListPage.preview.archive");
    }

    if (action === "assignBlueprint") {
      return t("catalog.features.catalogItems.ui.catalogItemListPage.preview.blueprint.assignment");
    }

    if (action === "assignCategory") {
      return t("catalog.features.catalogItems.ui.catalogItemListPage.preview.category.assignment");
    }

    if (action === "removeCategory") {
      return t("catalog.features.catalogItems.ui.catalogItemListPage.preview.category.removal");
    }

    if (action === "clearTags") {
      return t("catalog.features.catalogItems.ui.catalogItemListPage.preview.tag.clear");
    }

    return t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.preview.selected", {
      action: getBulkEditActionLabel(action).toLowerCase(),
    });
  }

  async function handleCreate() {
    const itemId = createId("cat");
    await createCatalogItem({
      itemId,
      languageCode,
      title: localizedTextMapFromEnglish(itemId),
      subtitle: null,
      description: localizedTextMapFromEnglish(description),
    });
    addToast(t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.item.created"), "success");
    setShowCreate(false);
    setDescription("");
    setLanguageCode("en");
    revalidator.revalidate();
  }

  async function handlePreviewBulkPublish(selection: unknown, scopeLabel: string) {
    setBulkBusy(true);
    setBulkProgress(null);
    setBulkResult(null);
    try {
      const preview = await previewBulkPublishCatalogItems(selection);
      setBulkPreview(preview);
      setBulkScopeLabel(scopeLabel);
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleConfirmBulkPublish() {
    if (!bulkPreview) {
      return;
    }

    setBulkBusy(true);
    setBulkProgress(null);
    try {
      const result = await confirmBulkPublishCatalogItems(bulkPreview.item_ids, { onProgress: setBulkProgress });
      setBulkResult(result);
      addToast(t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.publish.completed"), "success");
      setSelectedKeys(new Set());
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleRemoveSelectedDrafts() {
    setBulkBusy(true);
    try {
      for (const itemId of selectedDraftIds) {
        await removeDraftCatalogItem(itemId);
      }

      addToast(
        t("catalog.features.catalogItems.ui.catalogItemListPage.draft.catalog.items.removed", {
          count: selectedDraftIds.length,
        }),
        "success",
      );
      setSelectedKeys(new Set());
      setShowRemoveDrafts(false);
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkBusy(false);
    }
  }

  function buildBulkEditOperation(action: BulkEditCatalogItemOperation["action"]): BulkEditCatalogItemOperation {
    if (action === "assignBlueprint") {
      return { action, blueprintId: bulkEditBlueprintId.trim() };
    }

    if (action === "assignCategory" || action === "removeCategory") {
      return { action, categoryId: bulkEditCategoryId.trim() };
    }

    if (action === "setTags" || action === "mergeTags") {
      return { action, tags: tagsFromInput(bulkEditTags) };
    }

    return { action: "clearTags" };
  }

  async function handlePreviewBulkEdit(selection: unknown, action: BulkEditCatalogItemOperation["action"]) {
    const operation = buildBulkEditOperation(action);
    setBulkEditBusy(true);
    setBulkEditProgress(null);
    setBulkEditResult(null);

    try {
      const preview = await previewBulkCatalogItemEdit(operation, selection);
      setBulkEditSelection(selection);
      setBulkEditOperation(operation);
      setBulkEditPreview(preview);
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkEditBusy(false);
    }
  }

  async function handleConfirmBulkEdit() {
    if (!bulkEditSelection || !bulkEditOperation) {
      return;
    }

    setBulkEditBusy(true);
    setBulkEditProgress(null);
    try {
      const result = await confirmBulkCatalogItemEdit(bulkEditOperation, bulkEditSelection, {
        onProgress: setBulkEditProgress,
      });
      setBulkEditResult(result);
      addToast(t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.completed"), "success");
      setSelectedKeys(new Set());
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkEditBusy(false);
    }
  }

  function resetBulkEditDialog() {
    setBulkEditSelection(null);
    setBulkEditOperation(null);
    setBulkEditPreview(null);
    setBulkEditResult(null);
    setBulkEditProgress(null);
  }

  async function handlePreviewBulkLifecycle(action: "archive", selection: BulkLifecycleSelection) {
    setBulkLifecycleBusy(true);
    setBulkLifecycleProgress(null);
    setBulkLifecycleResult(null);

    try {
      const preview = await previewBulkCatalogItemLifecycle(action, selection);
      setBulkLifecycleSelection(selection);
      setBulkLifecyclePreview(preview);
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkLifecycleBusy(false);
    }
  }

  async function handleConfirmBulkLifecycle() {
    if (!bulkLifecycleSelection || !bulkLifecyclePreview) {
      return;
    }

    setBulkLifecycleBusy(true);
    setBulkLifecycleProgress(null);
    try {
      const result = await confirmBulkCatalogItemLifecycle(bulkLifecyclePreview.action, bulkLifecycleSelection, {
        onProgress: setBulkLifecycleProgress,
      });
      setBulkLifecycleResult(result);
      setSelectedKeys(new Set());
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkLifecycleBusy(false);
    }
  }

  function resetBulkLifecycleDialog() {
    setBulkLifecycleSelection(null);
    setBulkLifecyclePreview(null);
    setBulkLifecycleResult(null);
    setBulkLifecycleProgress(null);
  }

  async function handlePreviewBulkOperation(scope: "selected" | "matching") {
    const selection =
      scope === "selected" ? { mode: "ids" as const, ids: [...selectedKeys] } : { mode: "filter" as const, query };

    if (bulkOperation === "publish") {
      await handlePreviewBulkPublish(
        selection,
        scope === "selected"
          ? t("catalog.features.catalogItems.ui.catalogItemListPage.selected.items")
          : t("catalog.features.catalogItems.ui.catalogItemListPage.matching.drafts"),
      );
      return;
    }

    if (isLifecycleOperation(bulkOperation)) {
      await handlePreviewBulkLifecycle(bulkOperation, selection);
      return;
    }

    await handlePreviewBulkEdit(selection, bulkOperation);
  }

  function renderBulkEditFields(action: BulkEditCatalogItemOperation["action"]) {
    if (action === "assignBlueprint") {
      return (
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.id.or.slug")}
          value={bulkEditBlueprintId}
          onChange={(event) => setBulkEditBlueprintId(event.target.value)}
        />
      );
    }

    if (action === "assignCategory" || action === "removeCategory") {
      return (
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemListPage.category.id")}
          value={bulkEditCategoryId}
          onChange={(event) => setBulkEditCategoryId(event.target.value)}
        />
      );
    }

    if (action === "setTags" || action === "mergeTags") {
      return (
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemListPage.tags")}
          value={bulkEditTags}
          onChange={(event) => setBulkEditTags(event.target.value)}
          placeholder={t("catalog.features.catalogItems.ui.catalogItemListPage.tags.placeholder")}
        />
      );
    }

    return null;
  }

  function renderBulkActionPanel(scope: "selected" | "matching") {
    const fields = isBulkEditOperation(bulkOperation) ? renderBulkEditFields(bulkOperation) : null;
    const disabled =
      scope === "selected"
        ? selectedKeys.size === 0 || !canPreviewBulkOperation
        : data.total === 0 || !canPreviewBulkOperation;
    const scopeDescription =
      scope === "selected"
        ? t("catalog.features.catalogItems.ui.catalogItemListPage.items.selected", { count: selectedKeys.size })
        : t("catalog.features.catalogItems.ui.catalogItemListPage.matching.items", { count: data.total });

    return (
      <BulkActionPanel
        title={t("catalog.features.catalogItems.ui.catalogItemListPage.actions")}
        description={scopeDescription}
        triggerLabel={t("catalog.features.catalogItems.ui.catalogItemListPage.actions")}
        footer={
          <Button
            block
            tone={bulkOperation === "archive" ? "danger" : "primary"}
            onClick={() => handlePreviewBulkOperation(scope)}
            loading={bulkOperationBusy}
            disabled={disabled}
          >
            {getBulkOperationPreviewLabel(bulkOperation)}
          </Button>
        }
      >
        <Select
          label={t("catalog.support.shellSupport.ui.bulkLifecycleActions.action")}
          value={bulkOperation}
          onValueChange={(value) => setBulkOperation(value as CatalogItemBulkOperation)}
          items={catalogItemBulkOperationOptions}
        />
        {fields}
      </BulkActionPanel>
    );
  }

  function renderSelectedBulkActionBar() {
    return (
      <BulkActionBar
        count={selectedKeys.size}
        formatSelectedLabel={(count) =>
          t("catalog.features.catalogItems.ui.catalogItemListPage.items.selected", { count })
        }
        primaryActions={renderBulkActionPanel("selected")}
        secondaryActions={
          <>
            <AlertDialog
              open={showRemoveDrafts}
              onOpenChange={setShowRemoveDrafts}
              title={t("catalog.features.catalogItems.ui.catalogItemListPage.remove.draft.catalog.items")}
              description={t(
                "catalog.features.catalogItems.ui.catalogItemListPage.remove.draft.catalog.items.description",
                {
                  count: selectedDraftIds.length,
                },
              )}
              confirmLabel={t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts.from.selected")}
              cancelLabel={t("catalog.features.catalogItems.ui.catalogItemListPage.cancel")}
              tone="danger"
              onConfirm={handleRemoveSelectedDrafts}
              trigger={
                <Button
                  size="sm"
                  tone="danger"
                  loading={bulkBusy}
                  disabled={!canRemoveSelectedDrafts || bulkOperationBusy}
                >
                  {t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts.from.selected")}
                </Button>
              }
            />
            <Button size="sm" tone="secondary" onClick={() => setSelectedKeys(new Set())} disabled={bulkOperationBusy}>
              {t("catalog.features.catalogItems.ui.catalogItemListPage.clear.selection")}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.items")}
        entityName={t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.item")}
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.catalog_item_id}
        getHref={(row) => `/catalog-items/${row.catalog_item_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        activeFilterCount={activeFilterCount}
        extraFilters={
          <>
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.language")}
              value={listControls.language || ALL_LANGUAGES}
              onValueChange={(value) => listControls.setLanguage(value === ALL_LANGUAGES ? "" : value)}
              items={[
                {
                  label: t("catalog.features.catalogItems.ui.catalogItemListPage.all.languages"),
                  value: ALL_LANGUAGES,
                },
                ...languageOptions,
              ]}
            />
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.source")}
              value={listControls.source}
              onChange={(event) => listControls.setSource(event.target.value)}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemListPage.source.placeholder")}
            />
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.id")}
              value={listControls.blueprintId}
              onChange={(event) => listControls.setBlueprintId(event.target.value)}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.id.placeholder")}
            />
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.tag")}
              value={listControls.tag}
              onChange={(event) => listControls.setTag(event.target.value)}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemListPage.tag.placeholder")}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint")}
              value={listControls.blueprintState || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setBlueprintState(value === ALL_FILTER_VALUES ? "" : value)}
              items={blueprintStateOptions}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.has.images")}
              value={listControls.hasImages || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setHasImages(value === ALL_FILTER_VALUES ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.has.source.references")}
              value={listControls.hasSourceReferences || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setHasSourceReferences(value === ALL_FILTER_VALUES ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.missing.required.fields")}
              value={listControls.missingRequiredFields || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setMissingRequiredFields(value === ALL_FILTER_VALUES ? "" : value)}
              items={booleanOptions}
            />
          </>
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          selectedKeys.size > 0 ? (
            renderSelectedBulkActionBar()
          ) : data.total > 0 ? (
            <BulkActionBar
              count={data.total}
              formatSelectedLabel={(count) =>
                t("catalog.features.catalogItems.ui.catalogItemListPage.matching.items", { count })
              }
              primaryActions={renderBulkActionPanel("matching")}
            />
          ) : null
        }
        realtimeReloadActionBar={realtimeReloadActionBar}
        connectionStatus={connectionStatus}
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>
            {t("catalog.features.catalogItems.ui.catalogItemListPage.new.catalog.item")}
          </Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.catalogItems.ui.catalogItemListPage.create.catalog.item")}
        footer={
          <Button onClick={handleCreate}>{t("catalog.features.catalogItems.ui.catalogItemListPage.create")}</Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemListPage.language.code")}
            value={languageCode}
            onChange={(e) => setLanguageCode(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemListPage.description")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Stack>
      </Dialog>
      <Dialog
        open={bulkPreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBulkPreview(null);
            setBulkResult(null);
            setBulkProgress(null);
            setBulkScopeLabel("");
          }
        }}
        title={
          bulkResult
            ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.publish.result")
            : t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.publish.preview")
        }
        description={
          bulkResult
            ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.result.description", {
                published: bulkResult.published_count,
                failed: bulkResult.failed_count,
                skipped: bulkResult.skipped_count,
              })
            : bulkPreview
              ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.preview.description", {
                  scope: bulkScopeLabel,
                  ready: bulkPreview.ready_count,
                  blocked: bulkPreview.blocked_count,
                })
              : undefined
        }
        footer={
          bulkResult ? (
            <Button
              onClick={() => {
                setBulkPreview(null);
                setBulkResult(null);
                setBulkProgress(null);
                setBulkScopeLabel("");
              }}
            >
              {t("catalog.features.catalogItems.ui.catalogItemListPage.close")}
            </Button>
          ) : (
            <Inline gap={2}>
              <Button
                onClick={handleConfirmBulkPublish}
                disabled={bulkBusy || !bulkPreview || bulkPreview.ready_count === 0}
              >
                {t("catalog.features.catalogItems.ui.catalogItemListPage.publish.ready.items")}
              </Button>
              <Button
                tone="secondary"
                onClick={() => {
                  setBulkPreview(null);
                  setBulkProgress(null);
                  setBulkScopeLabel("");
                }}
              >
                {t("catalog.features.catalogItems.ui.catalogItemListPage.cancel")}
              </Button>
            </Inline>
          )
        }
      >
        <Stack gap={3}>
          {bulkPreview && (
            <Text tone="secondary">
              {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.partial.success.note")}
            </Text>
          )}
          {bulkProgress && <BulkLifecycleProgressSummary progress={bulkProgress} />}
          <DataTable
            rows={bulkRows}
            columns={bulkColumns}
            getRowId={(row) => row.catalog_item_id}
            emptyTitle={t("catalog.features.catalogItems.ui.catalogItemListPage.no.items.to.publish")}
            density="compact"
          />
          {(bulkResult?.candidates.length ?? bulkPreview?.candidates.length ?? 0) > bulkRows.length && (
            <Text tone="secondary">
              {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.preview.truncated", {
                shown: bulkRows.length,
                total: bulkResult?.candidates.length ?? bulkPreview?.candidates.length ?? 0,
              })}
            </Text>
          )}
        </Stack>
      </Dialog>
      <Dialog
        open={bulkLifecyclePreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            resetBulkLifecycleDialog();
          }
        }}
        title={
          bulkLifecycleResult
            ? t("catalog.support.shellSupport.ui.bulkLifecycleActions.result.title", {
                action: bulkLifecycleActionLabel,
              })
            : t("catalog.support.shellSupport.ui.bulkLifecycleActions.preview.title", {
                action: bulkLifecycleActionLabel,
              })
        }
        description={
          bulkLifecycleResult
            ? t("catalog.support.shellSupport.ui.bulkLifecycleActions.result.description", {
                succeeded: bulkLifecycleResult.succeeded_count,
                skipped: bulkLifecycleResult.skipped_count,
                failed: bulkLifecycleResult.failed_count,
              })
            : bulkLifecyclePreview
              ? t("catalog.support.shellSupport.ui.bulkLifecycleActions.preview.description", {
                  ready: bulkLifecyclePreview.ready_count,
                  blocked: bulkLifecyclePreview.blocked_count,
                })
              : undefined
        }
        footer={
          bulkLifecycleResult ? (
            <Button onClick={resetBulkLifecycleDialog}>
              {t("catalog.support.shellSupport.ui.bulkLifecycleActions.close")}
            </Button>
          ) : (
            <Inline gap={2}>
              <Button
                onClick={handleConfirmBulkLifecycle}
                loading={bulkLifecycleBusy}
                disabled={!bulkLifecyclePreview || bulkLifecyclePreview.ready_count === 0}
              >
                {t("catalog.support.shellSupport.ui.bulkLifecycleActions.confirm")}
              </Button>
              <Button tone="secondary" onClick={resetBulkLifecycleDialog} disabled={bulkLifecycleBusy}>
                {t("catalog.support.shellSupport.ui.bulkLifecycleActions.cancel")}
              </Button>
            </Inline>
          )
        }
      >
        <Stack gap={3}>
          <DataTable
            rows={bulkLifecycleRows}
            columns={bulkLifecycleColumns}
            getRowId={(row) => row.id}
            density="compact"
            emptyTitle={t("catalog.support.shellSupport.ui.bulkLifecycleActions.no.records")}
          />
          {bulkLifecycleProgress && <BulkLifecycleProgressSummary progress={bulkLifecycleProgress} />}
          {(bulkLifecycleResult?.candidates.length ?? bulkLifecyclePreview?.candidates.length ?? 0) >
            bulkLifecycleRows.length && (
            <Text tone="secondary">
              {t("catalog.support.shellSupport.ui.bulkLifecycleActions.truncated", {
                shown: bulkLifecycleRows.length,
                total: bulkLifecycleResult?.candidates.length ?? bulkLifecyclePreview?.candidates.length ?? 0,
              })}
            </Text>
          )}
        </Stack>
      </Dialog>
      <Dialog
        open={bulkEditPreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            resetBulkEditDialog();
          }
        }}
        title={
          bulkEditResult
            ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.result.title", {
                action: bulkEditActionLabel,
              })
            : t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.preview.title", {
                action: bulkEditActionLabel,
              })
        }
        description={
          bulkEditResult
            ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.result.description", {
                succeeded: bulkEditResult.succeeded_count,
                skipped: bulkEditResult.skipped_count,
                failed: bulkEditResult.failed_count,
              })
            : bulkEditPreview
              ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.preview.description", {
                  ready: bulkEditPreview.ready_count,
                  blocked: bulkEditPreview.blocked_count,
                })
              : undefined
        }
        footer={
          bulkEditResult ? (
            <Button onClick={resetBulkEditDialog}>
              {t("catalog.features.catalogItems.ui.catalogItemListPage.close")}
            </Button>
          ) : (
            <Inline gap={2}>
              <Button
                onClick={handleConfirmBulkEdit}
                loading={bulkEditBusy}
                disabled={!bulkEditPreview || bulkEditPreview.ready_count === 0}
              >
                {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.confirm")}
              </Button>
              <Button tone="secondary" onClick={resetBulkEditDialog} disabled={bulkEditBusy}>
                {t("catalog.features.catalogItems.ui.catalogItemListPage.cancel")}
              </Button>
            </Inline>
          )
        }
      >
        <Stack gap={3}>
          <Text tone="secondary">
            {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.partial.success.note")}
          </Text>
          {bulkEditProgress && <BulkLifecycleProgressSummary progress={bulkEditProgress} />}
          <DataTable
            rows={bulkEditRows}
            columns={bulkEditColumns}
            getRowId={(row) => row.catalog_item_id}
            emptyTitle={t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.no.items")}
            density="compact"
          />
          {(bulkEditResult?.candidates.length ?? bulkEditPreview?.candidates.length ?? 0) > bulkEditRows.length && (
            <Text tone="secondary">
              {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.preview.truncated", {
                shown: bulkEditRows.length,
                total: bulkEditResult?.candidates.length ?? bulkEditPreview?.candidates.length ?? 0,
              })}
            </Text>
          )}
        </Stack>
      </Dialog>
    </>
  );
}

function tagsFromInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}
