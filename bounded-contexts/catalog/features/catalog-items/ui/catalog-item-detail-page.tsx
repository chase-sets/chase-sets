import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useState, type MouseEvent } from "react";
import {
  Button,
  Combobox,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  LinkButton,
  PageSection,
  ProgressiveDisclosure,
  ReferenceInfoDialog,
  ReferenceInfoTrigger,
  Stack,
  Text,
  TextInput,
  Textarea,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { CatalogItemPublicationApiError } from "../../../support/shell-support/api/client";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { toCatalogAdminHref } from "../../../support/shell-support/ui/catalog-admin-hrefs";
import { sourceObservationsForProviderHref } from "./catalog-item-provenance-links";
import { LifecycleControls, type Transition } from "../../../support/shell-support/ui/lifecycle-controls";
import {
  useCatalogItem,
  useCatalogItemList,
  useProductContentInclusionPolicies,
  useProductContentTypes,
  useProductContainersForContained,
  useProductContentsForContainer,
  assignBlueprint,
  setFieldValue as apiSetFieldValue,
  clearFieldValue,
  assignCategory,
  removeCategory,
  publishCatalogItem,
  recheckCatalogItemPublication,
  reviseMetadata,
  localizedTextMapFromEnglish,
  localizedTextMapFromUnknown,
  archiveCatalogItem,
  setTags,
  setImageUrls,
  setImageFallback,
  clearImageFallback,
  linkExternalCatalogItemReference,
  linkExternalProductReference,
  unlinkExternalCatalogItemReference,
  unlinkExternalProductReference,
  replaceProductContents,
} from "./use-catalog-items";
import { useFieldList } from "../../fields/ui/use-fields";
import type { ReferenceRecord } from "../../reference-data/ui/contracts";
import { useReferenceRecordList } from "../../reference-data/ui/use-reference-data";
import type {
  CatalogItemImageFallback,
  CatalogItemListItem,
  CatalogReferenceRecordRef,
  ProductContentLineDetail,
  ProductContentLineInput,
  ProductContentSelectedOption,
  ProductContentsResolvedSnapshot,
  DisplayIdentityPublicationReadiness,
} from "./contracts";
import { buildReferenceDetailRows, formatReferenceTypeLabel, type ReferenceDetailRow } from "./reference-detail-rows";

function getTransitions(status: string): Transition[] {
  switch (status) {
    case "draft":
      return [
        {
          label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish"),
          action: "publish",
          tone: "primary",
        },
      ];
    case "active":
      return [
        {
          label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.archive"),
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
      return t("catalog.features.catalogItems.ui.catalogItemDetailPage.published");
    case "archive":
      return t("catalog.features.catalogItems.ui.catalogItemDetailPage.archived");
    default:
      return action;
  }
}

interface FieldValue {
  fieldId: string;
  fieldName: string;
  value: unknown;
  reference?: {
    referenceId: string;
    typeKey: string;
    key: string;
    name: string;
    attributes: unknown;
    relationships: Array<{
      relationshipType: string;
      referenceId: string;
      reference?: NonNullable<FieldValue["reference"]>;
    }>;
    status: string;
  } | null;
}

interface CategoryRef {
  categoryId: string;
  name: string;
}

type ExternalProductReference = NonNullable<
  ReturnType<typeof useCatalogItem>["data"]
>["external_product_references"][number];
type ExternalCatalogItemReference = NonNullable<
  ReturnType<typeof useCatalogItem>["data"]
>["external_catalog_item_references"][number];

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "object" && "values" in value) {
    const values = (value as { defaultLocale?: string; values?: Record<string, string> }).values ?? {};
    return values.en ?? Object.values(values)[0] ?? "—";
  }

  return JSON.stringify(value);
}

function formatReferenceRecordLabel(record: ReferenceRecord): string {
  return t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.record.option", {
    name: record.name,
    typeKey: record.type_key,
    key: record.key,
  });
}

function formatCatalogItemOption(item: CatalogItemListItem): string {
  return t("catalog.features.catalogItems.ui.catalogItemDetailPage.catalog.item.option", {
    title: item.title,
    id: item.catalog_item_id,
  });
}

function parseFieldValueInput(value: string): unknown {
  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localizedDisplayName(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const values = isRecord(value.values) ? value.values : {};
  const defaultLocale = typeof value.defaultLocale === "string" ? value.defaultLocale : "en";
  return String(values.en ?? values[defaultLocale] ?? Object.values(values)[0] ?? "");
}

function formatSelectedOptions(options: readonly ProductContentSelectedOption[] | null | undefined): string {
  if (!options || options.length === 0) {
    return t("catalog.features.catalogItems.ui.catalogItemDetailPage.all.product.options");
  }

  return options
    .map((option) =>
      t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.option.reference", {
        dimensionId: option.dimensionId,
        optionId: option.optionId,
      }),
    )
    .join(", ");
}

export function parseSelectedOptionsInput(value: string): ProductContentSelectedOption[] | undefined {
  const selectedOptions = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [dimensionId = "", optionId = ""] = entry.split(":");
      return { dimensionId: dimensionId.trim(), optionId: optionId.trim() };
    })
    .filter((entry) => entry.dimensionId.length > 0 && entry.optionId.length > 0);

  return selectedOptions.length > 0 ? selectedOptions : undefined;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.contents.update.failed");
}

function productContentLineToInput(line: ProductContentLineDetail): ProductContentLineInput {
  return {
    containedCatalogItemId: line.containedCatalogItemId,
    containedSelectedOptions: line.containedSelectedOptions ?? undefined,
    quantity: line.quantity,
    contentTypeId: line.contentTypeId,
    inclusionPolicyId: line.inclusionPolicyId,
    provenance: line.provenance,
  };
}

function formatReferenceAttributes(attributes: unknown): Array<{ key: string; value: string }> {
  if (!isRecord(attributes)) {
    return [];
  }

  return Object.entries(attributes).map(([key, value]) => ({ key, value: formatFieldValue(value) }));
}

function formatRelationshipType(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function ReferenceValueCue({
  row,
  onSelectReference,
}: {
  row: ReferenceDetailRow;
  onSelectReference: (reference: CatalogReferenceRecordRef) => void;
}) {
  if (!row.reference) {
    return <>{formatFieldValue(row.value)}</>;
  }

  const reference = row.reference;

  return (
    <ReferenceInfoTrigger
      href={toCatalogAdminHref(`/reference-records/${reference.referenceId}`)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onSelectReference(reference);
      }}
      aria-label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.value.aria", {
        label: row.label,
        value: reference.name,
      })}
      aria-haspopup="dialog"
    >
      {reference.name}
    </ReferenceInfoTrigger>
  );
}

function ReferenceDetailDialog({
  reference,
  onOpenChange,
}: {
  reference: CatalogReferenceRecordRef | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!reference) {
    return null;
  }

  const attributes = formatReferenceAttributes(reference.attributes);
  const relationships = reference.relationships.map((relationship) => ({
    key: formatRelationshipType(relationship.relationshipType),
    value: relationship.reference?.name ?? relationship.referenceId,
  }));

  return (
    <ReferenceInfoDialog
      open
      onOpenChange={onOpenChange}
      title={reference.name}
      description={formatReferenceTypeLabel(reference.typeKey)}
      closeLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.close.reference.detail")}
      sections={[
        {
          items: [
            {
              key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.type"),
              value: formatReferenceTypeLabel(reference.typeKey),
            },
            {
              key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.status"),
              value: reference.status,
            },
            {
              key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.key"),
              value: reference.key,
            },
          ],
        },
        {
          title: t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.attributes"),
          items: attributes,
          emptyState: t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.no.attributes"),
        },
        {
          title: t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.relationships"),
          items: relationships,
          emptyState: t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.no.relationships"),
        },
      ]}
    />
  );
}

export function CatalogItemDetailPage({
  id,
  initialData,
}: {
  id: string;
  initialData?: Parameters<typeof useCatalogItem>[1];
}) {
  const { data, loading, error, refresh } = useCatalogItem(id, initialData);
  const { addToast } = useToasts();
  const [selectedReference, setSelectedReference] = useState<CatalogReferenceRecordRef | null>(null);

  // Blueprint assignment
  const [showAssignBlueprint, setShowAssignBlueprint] = useState(false);
  const [blueprintId, setBlueprintId] = useState("");

  // Field values
  const [showSetField, setShowSetField] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [referenceRecordId, setReferenceRecordId] = useState("");

  // Category assignment
  const [showAssignCategory, setShowAssignCategory] = useState(false);
  const [categoryId, setCategoryId] = useState("");

  // Metadata editing
  const [showEditMetadata, setShowEditMetadata] = useState(false);
  const [editDescription, setEditDescription] = useState("");
  const [editLanguageCode, setEditLanguageCode] = useState("");

  // Publish dialog
  const [showPublish, setShowPublish] = useState(false);
  const [publishBlueprintActive, setPublishBlueprintActive] = useState(true);
  const [publishRequiredFieldIds, setPublishRequiredFieldIds] = useState("");
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [recheckedPublication, setRecheckedPublication] = useState<DisplayIdentityPublicationReadiness | null>(null);

  // Tags
  const [showSetTags, setShowSetTags] = useState(false);
  const [tagsInput, setTagsInput] = useState("");

  // Image URLs
  const [showSetImageUrls, setShowSetImageUrls] = useState(false);
  const [imageUrlsInput, setImageUrlsInput] = useState("");

  // Image fallback
  const [showSetImageFallback, setShowSetImageFallback] = useState(false);
  const [imageFallbackUrl, setImageFallbackUrl] = useState("");
  const [imageFallbackAlt, setImageFallbackAlt] = useState("");
  const [imageFallbackUsage, setImageFallbackUsage] = useState<"permanent" | "loading-only">("permanent");
  const [imageFallbackVariants, setImageFallbackVariants] = useState("{}");

  // External product references
  const [showLinkExternalCatalogItemReference, setShowLinkExternalCatalogItemReference] = useState(false);
  const [externalCatalogItemProviderKey, setExternalCatalogItemProviderKey] = useState("tcgplayer");
  const [externalCatalogItemKey, setExternalCatalogItemKey] = useState("");
  const [showLinkExternalReference, setShowLinkExternalReference] = useState(false);
  const [externalProviderKey, setExternalProviderKey] = useState("tcgplayer");
  const [externalKey, setExternalKey] = useState("");
  const [externalSelectedOptions, setExternalSelectedOptions] = useState("");
  const [showAddProductContent, setShowAddProductContent] = useState(false);
  const [productContentTypeId, setProductContentTypeId] = useState("");
  const [productContentPolicyId, setProductContentPolicyId] = useState("");
  const [productContentTargetItemId, setProductContentTargetItemId] = useState("");
  const [productContentTargetOptions, setProductContentTargetOptions] = useState("");
  const [productContentQuantity, setProductContentQuantity] = useState("1");
  const [productContentError, setProductContentError] = useState<string | null>(null);
  const [authoritativeProductContents, setAuthoritativeProductContents] =
    useState<ProductContentsResolvedSnapshot | null>(null);
  const { data: fieldsData } = useFieldList("limit=500&status=active");
  const { data: referenceRecordsData } = useReferenceRecordList("limit=500&status=active");
  const { data: productContentTypesData } = useProductContentTypes();
  const { data: productContentPoliciesData } = useProductContentInclusionPolicies();
  const { data: productContentItemsData } = useCatalogItemList("limit=500&status=active");
  const { data: productContentsData, refresh: refreshProductContents } = useProductContentsForContainer(id);
  const { data: productContainersData, refresh: refreshProductContainers } = useProductContainersForContained(id);
  const fields = fieldsData?.items ?? [];
  const referenceRecords = referenceRecordsData?.items ?? [];
  const productContentTypes = (productContentTypesData?.items ?? []).filter((type) => type.status === "active");
  const productContentPolicies = (productContentPoliciesData?.items ?? []).filter(
    (policy) => policy.status === "active",
  );
  const productContentCatalogItems = productContentItemsData?.items ?? [];
  useEffect(() => {
    setAuthoritativeProductContents(null);
  }, [id]);

  const productContents = authoritativeProductContents?.lines ?? productContentsData?.items ?? [];
  const productContainers = productContainersData?.items ?? [];
  const resolvedProductContents = productContents.filter((line) => line.resolutionStatus === "resolved");
  const unresolvedProductContentEvidence = productContents.filter((line) => line.resolutionStatus === "unresolved");
  const selectedField = fields.find((field) => field.field_id === fieldId) ?? null;
  const selectedFieldIsReference = selectedField?.value_type === "reference";
  const fieldOptions = fields.map((field) => ({
    value: field.field_id,
    label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.option", {
      name: field.name,
      key: field.key,
    }),
  }));
  const referenceRecordOptions = referenceRecords.map((record) => ({
    value: record.reference_record_id,
    label: formatReferenceRecordLabel(record),
  }));
  const productContentTypeOptions = productContentTypes.map((type) => ({
    value: type.content_type_id,
    label: localizedDisplayName(type.display_name) || type.key,
  }));
  const productContentPolicyOptions = productContentPolicies.map((policy) => ({
    value: policy.inclusion_policy_id,
    label: localizedDisplayName(policy.display_name) || policy.key,
  }));
  const productContentItemOptions = productContentCatalogItems.map((item) => ({
    value: item.catalog_item_id,
    label: formatCatalogItemOption(item),
  }));

  async function handleLifecycleAction(action: string) {
    if (action === "publish") {
      setShowPublish(true);
      return;
    }
    const actions: Record<string, () => Promise<unknown>> = {
      archive: () => archiveCatalogItem(id),
    };
    await actions[action]?.();
    addToast(
      t("catalog.features.catalogItems.ui.catalogItemDetailPage.lifecycle.completed", {
        action: lifecycleActionLabel(action),
      }),
      "success",
    );
    refresh();
  }

  async function handlePublish() {
    const requiredIds = publishRequiredFieldIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setPublishBusy(true);
    setPublishError(null);
    try {
      await publishCatalogItem(id, publishBlueprintActive, requiredIds);
      addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.catalog.item.published"), "success");
      setShowPublish(false);
      setRecheckedPublication(null);
      refresh();
    } catch (error) {
      const message =
        error instanceof CatalogItemPublicationApiError
          ? error.message
          : t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish.failed");
      setPublishError(message);
      addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish.failed"), "danger", message);
    } finally {
      setPublishBusy(false);
    }
  }

  async function handleRecheckPublication() {
    if (publishBusy) {
      return;
    }
    setPublishBusy(true);
    setPublishError(null);
    try {
      const current = await recheckCatalogItemPublication(id);
      setRecheckedPublication(current.display_identity_publication);
    } catch {
      setRecheckedPublication({
        status: "unavailable",
        reason_code: "display-identity-unavailable",
        missing_tokens: [],
        retryable: true,
      });
    } finally {
      setPublishBusy(false);
    }
  }

  async function handleAssignBlueprint() {
    await assignBlueprint(id, blueprintId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint.assigned"), "success");
    setShowAssignBlueprint(false);
    setBlueprintId("");
    refresh();
  }

  async function handleSetFieldValue() {
    const value =
      selectedFieldIsReference && referenceRecordId
        ? { referenceId: referenceRecordId }
        : parseFieldValueInput(fieldValue);

    await apiSetFieldValue(id, fieldId, value);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.value.set"), "success");
    setShowSetField(false);
    setFieldId("");
    setFieldValue("");
    setReferenceRecordId("");
    refresh();
  }

  function handleFieldSelection(nextFieldId: string) {
    setFieldId(nextFieldId);
    setFieldValue("");
    setReferenceRecordId("");
  }

  async function handleClearFieldValue(fId: string) {
    await clearFieldValue(id, fId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.value.cleared"), "success");
    refresh();
  }

  async function handleAssignCategory() {
    await assignCategory(id, categoryId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.category.assigned"), "success");
    setShowAssignCategory(false);
    setCategoryId("");
    refresh();
  }

  async function handleRemoveCategory(catId: string) {
    await removeCategory(id, catId);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.category.removed"), "success");
    refresh();
  }

  async function handleReviseMetadata() {
    await reviseMetadata(id, {
      title: localizedTextMapFromUnknown(data?.title_i18n, id),
      subtitle: data?.subtitle_i18n ? localizedTextMapFromUnknown(data.subtitle_i18n, "") : null,
      description: localizedTextMapFromEnglish(editDescription),
      languageCode: editLanguageCode || "en",
    });
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.metadata.revised"), "success");
    setShowEditMetadata(false);
    refresh();
  }

  function startEditMetadata() {
    if (data) {
      setEditDescription(data.description ?? "");
      setEditLanguageCode(data.language_code ?? "en");
      setShowEditMetadata(true);
    }
  }

  async function handleSetTags() {
    const tags = tagsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await setTags(id, tags);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags.updated"), "success");
    setShowSetTags(false);
    refresh();
  }

  function startSetTags() {
    if (data) {
      setTagsInput((data.tags ?? []).join(", "));
      setShowSetTags(true);
    }
  }

  async function handleSetImageUrls() {
    const urls = imageUrlsInput
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await setImageUrls(id, urls);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls.updated"), "success");
    setShowSetImageUrls(false);
    refresh();
  }

  function startSetImageUrls() {
    if (data) {
      setImageUrlsInput((data.image_urls ?? []).join("\n"));
      setShowSetImageUrls(true);
    }
  }

  async function handleSetImageFallback() {
    await setImageFallback(id, {
      url: imageFallbackUrl,
      alt: imageFallbackAlt,
      usage: imageFallbackUsage,
      variants: parseImageFallbackVariants(imageFallbackVariants),
    });
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.fallback.updated"), "success");
    setShowSetImageFallback(false);
    refresh();
  }

  async function handleClearImageFallback() {
    await clearImageFallback(id);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.fallback.cleared"), "success");
    refresh();
  }

  function startSetImageFallback() {
    if (data) {
      setImageFallbackUrl(data.image_fallback?.url ?? "");
      setImageFallbackAlt(data.image_fallback?.alt ?? data.title);
      setImageFallbackUsage(data.image_fallback?.usage ?? "permanent");
      setImageFallbackVariants(JSON.stringify(data.image_fallback?.variants ?? {}, null, 2));
      setShowSetImageFallback(true);
    }
  }

  async function handleLinkExternalReference() {
    const selectedOptions = externalSelectedOptions
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [dimensionId = "", optionId = ""] = entry.split(":");

        return {
          dimensionId: dimensionId.trim(),
          optionId: optionId.trim(),
        };
      })
      .filter((entry) => entry.dimensionId.length > 0 && entry.optionId.length > 0);

    await linkExternalProductReference(id, externalProviderKey, externalKey, selectedOptions);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.reference.linked"), "success");
    setShowLinkExternalReference(false);
    setExternalProviderKey("tcgplayer");
    setExternalKey("");
    setExternalSelectedOptions("");
    refresh();
  }

  async function handleLinkExternalCatalogItemReference() {
    await linkExternalCatalogItemReference(id, externalCatalogItemProviderKey, externalCatalogItemKey);
    addToast(
      t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.catalog.item.reference.linked"),
      "success",
    );
    setShowLinkExternalCatalogItemReference(false);
    setExternalCatalogItemProviderKey("tcgplayer");
    setExternalCatalogItemKey("");
    refresh();
  }

  async function handleUnlinkExternalReference(reference: ExternalProductReference) {
    await unlinkExternalProductReference(id, reference.providerKey, reference.externalKey);
    addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.reference.unlinked"), "success");
    refresh();
  }

  async function handleUnlinkExternalCatalogItemReference(reference: ExternalCatalogItemReference) {
    await unlinkExternalCatalogItemReference(id, reference.providerKey, reference.externalKey);
    addToast(
      t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.catalog.item.reference.unlinked"),
      "success",
    );
    refresh();
  }

  async function handleAddProductContentLine() {
    const nextLine: ProductContentLineInput = {
      containedCatalogItemId: productContentTargetItemId || null,
      containedSelectedOptions: parseSelectedOptionsInput(productContentTargetOptions),
      quantity: productContentQuantity.trim() ? Number(productContentQuantity) : null,
      contentTypeId: productContentTypeId,
      inclusionPolicyId: productContentPolicyId || null,
      provenance: { source: "operator" },
    };

    setProductContentError(null);
    try {
      const result = await replaceProductContents(id, {
        lines: [...productContents.map(productContentLineToInput), nextLine],
      });
      setAuthoritativeProductContents(result);
      addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.contents.updated"), "success");
      setShowAddProductContent(false);
      setProductContentTypeId("");
      setProductContentPolicyId("");
      setProductContentTargetItemId("");
      setProductContentTargetOptions("");
      setProductContentQuantity("1");
      refreshProductContents();
      refreshProductContainers();
    } catch (error) {
      const message = messageFromError(error);
      setProductContentError(message);
      addToast(
        t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.contents.update.failed"),
        "danger",
        message,
      );
    }
  }

  function startAddProductContentLine() {
    setProductContentTypeId((current) => current || productContentTypeOptions[0]?.value || "");
    setProductContentPolicyId((current) => current || productContentPolicyOptions[0]?.value || "");
    setProductContentError(null);
    setShowAddProductContent(true);
  }

  async function handleRemoveProductContentLine(line: ProductContentLineDetail) {
    setProductContentError(null);
    try {
      const result = await replaceProductContents(id, {
        lines: productContents.filter((entry) => entry.lineId !== line.lineId).map(productContentLineToInput),
      });
      setAuthoritativeProductContents(result);
      addToast(t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.contents.updated"), "success");
      refreshProductContents();
      refreshProductContainers();
    } catch (error) {
      const message = messageFromError(error);
      setProductContentError(message);
      addToast(
        t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.contents.update.failed"),
        "danger",
        message,
      );
    }
  }

  const fieldValues = (data?.field_values ?? []) as FieldValue[];
  const referenceDetailRows = buildReferenceDetailRows(fieldValues);
  const categories = (data?.categories ?? []) as CategoryRef[];
  const externalCatalogItemReferences = data?.external_catalog_item_references ?? [];
  const externalReferences = data?.external_product_references ?? [];
  // The provider keys that link this Catalog Item back to the integration imports
  // that created or updated it. Promotion writes these external references, so they
  // are the item's recorded origin — dedupe and sort for a stable back-reference.
  const originProviderKeys = Array.from(
    new Set(
      [...externalReferences, ...externalCatalogItemReferences]
        .map((reference) => reference.providerKey.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const fieldValueColumns: DataColumn<ReferenceDetailRow>[] = [
    {
      key: "fieldId",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.field"),
      cell: (row) => row.label,
    },
    {
      key: "value",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.value"),
      cell: (row) => <ReferenceValueCue row={row} onSelectReference={setSelectedReference} />,
    },
    {
      key: "actions",
      header: "",
      cell: (row) => {
        const fieldId = row.id.startsWith("field:") ? row.id.slice("field:".length) : null;

        return data?.status !== "archived" && fieldId ? (
          <Button size="sm" tone="danger" onClick={() => handleClearFieldValue(fieldId)}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.clear")}
          </Button>
        ) : null;
      },
    },
  ];
  const contentTypeLabelById = new Map(
    productContentTypes.map((type) => [type.content_type_id, localizedDisplayName(type.display_name) || type.key]),
  );
  const inclusionPolicyLabelById = new Map(
    productContentPolicies.map((policy) => [
      policy.inclusion_policy_id,
      localizedDisplayName(policy.display_name) || policy.key,
    ]),
  );
  const catalogItemLabelById = new Map(
    productContentCatalogItems.map((item) => [item.catalog_item_id, item.title || item.catalog_item_id]),
  );
  const productContentColumns: DataColumn<ProductContentLineDetail>[] = [
    {
      key: "containedCatalogItemId",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.contained.catalog.item"),
      cell: (row) =>
        row.containedCatalogItemId
          ? (catalogItemLabelById.get(row.containedCatalogItemId) ?? row.containedCatalogItemId)
          : t("catalog.features.catalogItems.ui.catalogItemDetailPage.unresolved.provider.evidence"),
    },
    {
      key: "contentTypeId",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.content.type"),
      cell: (row) => contentTypeLabelById.get(row.contentTypeId) ?? row.contentTypeId,
    },
    {
      key: "quantity",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.quantity"),
      cell: (row) => row.quantity ?? t("catalog.features.catalogItems.ui.catalogItemDetailPage.unspecified"),
    },
    {
      key: "selectedOptions",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options"),
      cell: (row) => formatSelectedOptions(row.containedSelectedOptions),
    },
    {
      key: "policy",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.inclusion.policy"),
      cell: (row) =>
        row.inclusionPolicyId
          ? (inclusionPolicyLabelById.get(row.inclusionPolicyId) ?? row.inclusionPolicyId)
          : t("catalog.features.catalogItems.ui.catalogItemDetailPage.none"),
    },
    {
      key: "actions",
      header: "",
      cell: (row) =>
        data?.status !== "archived" ? (
          <Button size="sm" tone="danger" onClick={() => handleRemoveProductContentLine(row)}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.remove")}
          </Button>
        ) : null,
    },
  ];
  const productContainerColumns: DataColumn<ProductContentLineDetail>[] = [
    {
      key: "containerCatalogItemId",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.container.catalog.item"),
      cell: (row) => catalogItemLabelById.get(row.containerCatalogItemId) ?? row.containerCatalogItemId,
    },
    {
      key: "contentTypeId",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.content.type"),
      cell: (row) => contentTypeLabelById.get(row.contentTypeId) ?? row.contentTypeId,
    },
    {
      key: "quantity",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.quantity"),
      cell: (row) => row.quantity ?? t("catalog.features.catalogItems.ui.catalogItemDetailPage.unspecified"),
    },
    {
      key: "selectedOptions",
      header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options"),
      cell: (row) => formatSelectedOptions(row.containerSelectedOptions),
    },
  ];

  return (
    <>
      <EntityDetailPage
        title={data?.title ?? t("catalog.features.catalogItems.ui.catalogItemDetailPage.catalog.item")}
        breadcrumbs={[
          { label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.catalog.items"), href: "/catalog-items" },
          { label: data?.title ?? id },
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
                <Button tone="secondary" size="sm" onClick={startEditMetadata}>
                  {t("catalog.features.catalogItems.ui.catalogItemDetailPage.edit.description")}
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
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.title"), value: data.title },
                {
                  key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.subtitle"),
                  value: data.subtitle ?? "—",
                },
                {
                  key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.language"),
                  value: formatLanguageCodeLabel(data.language_code),
                },
                {
                  key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.description"),
                  value: data.description ?? "—",
                },
                {
                  key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint"),
                  value: data.blueprint?.name ?? t("catalog.features.catalogItems.ui.catalogItemDetailPage.none"),
                },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.status"), value: data.status },
                { key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.updated"), value: data.updated_at },
              ]}
            />

            {originProviderKeys.length > 0 && (
              <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.origin.title")}>
                <Stack gap={3}>
                  <Text tone="secondary">
                    {t("catalog.features.catalogItems.ui.catalogItemDetailPage.origin.description")}
                  </Text>
                  <Inline gap={2}>
                    {originProviderKeys.map((providerKey) => (
                      <LinkButton
                        key={providerKey}
                        size="sm"
                        tone="secondary"
                        leadingIcon="externalLink"
                        href={sourceObservationsForProviderHref(providerKey)}
                      >
                        {t("catalog.features.catalogItems.ui.catalogItemDetailPage.view.source.observations")} (
                        {providerKey})
                      </LinkButton>
                    ))}
                  </Inline>
                </Stack>
              </PageSection>
            )}

            {data.status === "draft" && !data.blueprint && (
              <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint")}>
                <Button size="sm" onClick={() => setShowAssignBlueprint(true)}>
                  {t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.blueprint")}
                </Button>
              </PageSection>
            )}

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.values")}>
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowSetField(true)}>
                      {t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.field.value")}
                    </Button>
                  </Inline>
                )}
                <DataTable
                  rows={referenceDetailRows}
                  columns={fieldValueColumns}
                  getRowId={(row) => row.id}
                  emptyTitle={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.field.values")}
                />
              </Stack>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.categories")}>
              <Stack gap={3}>
                {data.status !== "archived" && (
                  <Inline>
                    <Button size="sm" onClick={() => setShowAssignCategory(true)}>
                      {t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.category")}
                    </Button>
                  </Inline>
                )}
                {categories.length === 0 ? (
                  <Text tone="secondary">
                    {t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.categories.assigned")}
                  </Text>
                ) : (
                  <DataTable
                    rows={categories}
                    columns={[
                      {
                        key: "categoryId",
                        header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.category"),
                        cell: (row) => row.name,
                      },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) =>
                          data.status !== "archived" ? (
                            <Button size="sm" tone="danger" onClick={() => handleRemoveCategory(row.categoryId)}>
                              {t("catalog.features.catalogItems.ui.catalogItemDetailPage.remove")}
                            </Button>
                          ) : null,
                      },
                    ]}
                    getRowId={(row) => row.categoryId}
                  />
                )}
              </Stack>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.contents")}>
              <Stack gap={4}>
                {productContentError ? (
                  <Text tone="danger" role="alert">
                    {productContentError}
                  </Text>
                ) : null}
                <ProgressiveDisclosure
                  title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.contents")}
                  summary={
                    productContents.length === 0
                      ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.product.contents")
                      : t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.contents.summary", {
                          count: productContents.length,
                        })
                  }
                  tone={productContents.length > 0 ? "info" : "neutral"}
                >
                  <Stack gap={3}>
                    {data.status !== "archived" && (
                      <Inline>
                        <Button size="sm" onClick={startAddProductContentLine}>
                          {t("catalog.features.catalogItems.ui.catalogItemDetailPage.add.content.line")}
                        </Button>
                      </Inline>
                    )}
                    <DataTable
                      rows={resolvedProductContents}
                      columns={productContentColumns}
                      getRowId={(row) => row.lineId}
                      emptyTitle={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.resolved.contents")}
                    />
                  </Stack>
                </ProgressiveDisclosure>

                <ProgressiveDisclosure
                  title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.unresolved.provider.evidence")}
                  summary={
                    unresolvedProductContentEvidence.length === 0
                      ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.unresolved.provider.evidence")
                      : t(
                          "catalog.features.catalogItems.ui.catalogItemDetailPage.unresolved.provider.evidence.summary",
                          {
                            count: unresolvedProductContentEvidence.length,
                          },
                        )
                  }
                  tone={unresolvedProductContentEvidence.length > 0 ? "warning" : "neutral"}
                >
                  <DataTable
                    rows={unresolvedProductContentEvidence}
                    columns={productContentColumns}
                    getRowId={(row) => row.lineId}
                    emptyTitle={t(
                      "catalog.features.catalogItems.ui.catalogItemDetailPage.no.unresolved.provider.evidence",
                    )}
                  />
                </ProgressiveDisclosure>

                <ProgressiveDisclosure
                  title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.included.in")}
                  summary={
                    productContainers.length === 0
                      ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.product.containers")
                      : t("catalog.features.catalogItems.ui.catalogItemDetailPage.product.containers.summary", {
                          count: productContainers.length,
                        })
                  }
                  tone={productContainers.length > 0 ? "info" : "neutral"}
                >
                  <DataTable
                    rows={productContainers}
                    columns={productContainerColumns}
                    getRowId={(row) => row.lineId}
                    emptyTitle={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.product.containers")}
                  />
                </ProgressiveDisclosure>
              </Stack>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags")}>
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags")}
                summary={
                  (data.tags ?? []).length === 0
                    ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.tags")
                    : t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags.summary", {
                        count: (data.tags ?? []).length,
                      })
                }
                tone="info"
              >
                <Stack gap={3}>
                  {data.status !== "archived" && (
                    <Inline>
                      <Button size="sm" onClick={startSetTags}>
                        {t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.tags")}
                      </Button>
                    </Inline>
                  )}
                  {(data.tags ?? []).length === 0 ? (
                    <Text tone="secondary">{t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.tags")}</Text>
                  ) : (
                    <Text>{(data.tags ?? []).join(", ")}</Text>
                  )}
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls")}>
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls")}
                summary={
                  (data.image_urls ?? []).length === 0
                    ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.image.urls")
                    : t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls.summary", {
                        count: (data.image_urls ?? []).length,
                      })
                }
                tone="info"
              >
                <Stack gap={3}>
                  {data.status !== "archived" && (
                    <Inline>
                      <Button size="sm" onClick={startSetImageUrls}>
                        {t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.image.urls")}
                      </Button>
                    </Inline>
                  )}
                  {(data.image_urls ?? []).length === 0 ? (
                    <Text tone="secondary">
                      {t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.image.urls")}
                    </Text>
                  ) : (
                    <Stack gap={1}>
                      {(data.image_urls ?? []).map((url, i) => (
                        <Text key={i}>{url}</Text>
                      ))}
                    </Stack>
                  )}
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.fallback")}>
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.fallback")}
                summary={
                  data.image_fallback
                    ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.fallback.summary", {
                        usage: data.image_fallback.usage,
                      })
                    : t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.image.fallback")
                }
                tone="info"
              >
                <Stack gap={3}>
                  {data.status !== "archived" && (
                    <Inline>
                      <Button size="sm" onClick={startSetImageFallback}>
                        {t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.image.fallback")}
                      </Button>
                      {data.image_fallback ? (
                        <Button size="sm" tone="danger" onClick={handleClearImageFallback}>
                          {t("catalog.features.catalogItems.ui.catalogItemDetailPage.clear.image.fallback")}
                        </Button>
                      ) : null}
                    </Inline>
                  )}
                  {data.image_fallback ? (
                    <KeyValueList
                      items={[
                        {
                          key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.url"),
                          value: data.image_fallback.url,
                        },
                        {
                          key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.alt.text"),
                          value: data.image_fallback.alt,
                        },
                        {
                          key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.usage"),
                          value: data.image_fallback.usage,
                        },
                        {
                          key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.variants"),
                          value: JSON.stringify(data.image_fallback.variants),
                        },
                      ]}
                    />
                  ) : (
                    <Text tone="secondary">
                      {t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.image.fallback")}
                    </Text>
                  )}
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection
              title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.catalog.item.references")}
            >
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.catalog.item.references")}
                summary={
                  externalCatalogItemReferences.length === 0
                    ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.external.catalog.item.references")
                    : t(
                        "catalog.features.catalogItems.ui.catalogItemDetailPage.external.catalog.item.references.summary",
                        {
                          count: externalCatalogItemReferences.length,
                        },
                      )
                }
                tone={externalCatalogItemReferences.length > 0 ? "info" : "neutral"}
              >
                <Stack gap={3}>
                  {data.status !== "archived" && (
                    <Inline>
                      <Button size="sm" onClick={() => setShowLinkExternalCatalogItemReference(true)}>
                        {t(
                          "catalog.features.catalogItems.ui.catalogItemDetailPage.link.external.catalog.item.reference",
                        )}
                      </Button>
                    </Inline>
                  )}
                  <DataTable
                    rows={externalCatalogItemReferences}
                    columns={[
                      {
                        key: "provider",
                        header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.provider"),
                        cell: (row) => row.providerKey,
                      },
                      {
                        key: "externalKey",
                        header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.key"),
                        cell: (row) => row.externalKey,
                      },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) =>
                          data.status !== "archived" ? (
                            <Button
                              size="sm"
                              tone="danger"
                              onClick={() => handleUnlinkExternalCatalogItemReference(row)}
                            >
                              {t("catalog.features.catalogItems.ui.catalogItemDetailPage.unlink")}
                            </Button>
                          ) : null,
                      },
                    ]}
                    getRowId={(row) => `${row.providerKey}:${row.externalKey}`}
                    emptyTitle={t(
                      "catalog.features.catalogItems.ui.catalogItemDetailPage.no.external.catalog.item.references",
                    )}
                  />
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>

            <PageSection
              title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.product.references")}
            >
              <ProgressiveDisclosure
                title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.product.references")}
                summary={
                  externalReferences.length === 0
                    ? t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.external.references")
                    : t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.references.summary", {
                        count: externalReferences.length,
                      })
                }
                tone={externalReferences.length > 0 ? "info" : "neutral"}
              >
                <Stack gap={3}>
                  {data.status !== "archived" && (
                    <Inline>
                      <Button size="sm" onClick={() => setShowLinkExternalReference(true)}>
                        {t("catalog.features.catalogItems.ui.catalogItemDetailPage.link.external.reference")}
                      </Button>
                    </Inline>
                  )}
                  <DataTable
                    rows={externalReferences}
                    columns={[
                      {
                        key: "provider",
                        header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.provider"),
                        cell: (row) => row.providerKey,
                      },
                      {
                        key: "externalKey",
                        header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.key"),
                        cell: (row) => row.externalKey,
                      },
                      {
                        key: "options",
                        header: t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options"),
                        cell: (row) =>
                          row.selectedOptions.length > 0
                            ? row.selectedOptions
                                .map((option) =>
                                  t(
                                    "catalog.features.catalogItems.ui.catalogItemDetailPage.selected.option.reference",
                                    {
                                      dimensionId: option.dimensionId,
                                      optionId: option.optionId,
                                    },
                                  ),
                                )
                                .join(", ")
                            : t("catalog.features.catalogItems.ui.catalogItemDetailPage.none"),
                      },
                      {
                        key: "actions",
                        header: "",
                        cell: (row) =>
                          data.status !== "archived" ? (
                            <Button size="sm" tone="danger" onClick={() => handleUnlinkExternalReference(row)}>
                              {t("catalog.features.catalogItems.ui.catalogItemDetailPage.unlink")}
                            </Button>
                          ) : null,
                      },
                    ]}
                    getRowId={(row) => `${row.providerKey}:${row.externalKey}`}
                    emptyTitle={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.external.references")}
                  />
                </Stack>
              </ProgressiveDisclosure>
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={showAssignBlueprint}
        onOpenChange={setShowAssignBlueprint}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.blueprint.2")}
        footer={
          <Button onClick={handleAssignBlueprint}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign")}
          </Button>
        }
      >
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.blueprint.id")}
          value={blueprintId}
          onChange={(e) => setBlueprintId(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetField}
        onOpenChange={setShowSetField}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.field.value.2")}
        footer={
          <Button onClick={handleSetFieldValue}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.set")}
          </Button>
        }
      >
        <Stack gap={3}>
          {fieldOptions.length > 0 ? (
            <Combobox
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.field")}
              items={fieldOptions}
              value={fieldId}
              onValueChange={handleFieldSelection}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.choose.field")}
              noMatchesLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.fields.match")}
            />
          ) : (
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.field.id")}
              value={fieldId}
              onChange={(event) => handleFieldSelection(event.target.value)}
            />
          )}
          {selectedFieldIsReference ? (
            <Combobox
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.reference.record")}
              items={referenceRecordOptions}
              value={referenceRecordId}
              onValueChange={setReferenceRecordId}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.choose.reference.record")}
              noMatchesLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.reference.records.match")}
            />
          ) : (
            <Textarea
              label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.value.2")}
              description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.value.description")}
              value={fieldValue}
              onChange={(event) => setFieldValue(event.target.value)}
              rows={4}
            />
          )}
        </Stack>
      </Dialog>

      <Dialog
        open={showAssignCategory}
        onOpenChange={setShowAssignCategory}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.category.2")}
        footer={
          <Button onClick={handleAssignCategory}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.assign.2")}
          </Button>
        }
      >
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.category.id")}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showEditMetadata}
        onOpenChange={setShowEditMetadata}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.edit.description.2")}
        footer={
          <Button onClick={handleReviseMetadata}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.save")}
          </Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.language.code")}
            value={editLanguageCode}
            onChange={(e) => setEditLanguageCode(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.description")}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showPublish}
        onOpenChange={(open) => {
          setShowPublish(open);
          if (!open) {
            setPublishError(null);
            setRecheckedPublication(null);
          }
        }}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish.catalog.item")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.confirm.that.the.blueprint.is.active")}
        footer={
          <Inline gap={2}>
            {((recheckedPublication ?? data?.display_identity_publication)?.retryable || publishError) && (
              <Button tone="secondary" onClick={handleRecheckPublication} loading={publishBusy} disabled={publishBusy}>
                {t("catalog.features.catalogItems.ui.catalogItemDetailPage.recheck.display.identity")}
              </Button>
            )}
            <Button onClick={handlePublish} loading={publishBusy} disabled={publishBusy}>
              {t("catalog.features.catalogItems.ui.catalogItemDetailPage.publish.2")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          <KeyValueList
            items={[
              {
                key: t("catalog.features.catalogItems.ui.catalogItemDetailPage.display.identity.readiness"),
                value: (recheckedPublication ?? data?.display_identity_publication)?.status ?? "unavailable",
              },
            ]}
          />
          {(recheckedPublication ?? data?.display_identity_publication)?.missing_tokens.length ? (
            <Text tone="danger">
              {t("catalog.features.catalogItems.ui.catalogItemDetailPage.display.identity.missing.tokens", {
                tokens: (recheckedPublication ?? data?.display_identity_publication)?.missing_tokens.join(", ") ?? "",
              })}
            </Text>
          ) : null}
          {publishError ? (
            <Text tone="danger" role="alert">
              {publishError}
            </Text>
          ) : null}
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.required.field.ids.comma.separated")}
            value={publishRequiredFieldIds}
            onChange={(e) => setPublishRequiredFieldIds(e.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showSetTags}
        onOpenChange={setShowSetTags}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.tags.2")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.enter.tags.separated.by.commas")}
        footer={
          <Button onClick={handleSetTags}>{t("catalog.features.catalogItems.ui.catalogItemDetailPage.save.2")}</Button>
        }
      >
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.tags.2")}
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetImageUrls}
        onOpenChange={setShowSetImageUrls}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.image.urls.2")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.enter.one.url.per.line")}
        footer={
          <Button onClick={handleSetImageUrls}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.save.3")}
          </Button>
        }
      >
        <TextInput
          label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.urls.2")}
          value={imageUrlsInput}
          onChange={(e) => setImageUrlsInput(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={showSetImageFallback}
        onOpenChange={setShowSetImageFallback}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.set.image.fallback.2")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.image.fallback.description")}
        footer={
          <Button onClick={handleSetImageFallback}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.save.4")}
          </Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.url")}
            value={imageFallbackUrl}
            onChange={(event) => setImageFallbackUrl(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.alt.text")}
            value={imageFallbackAlt}
            onChange={(event) => setImageFallbackAlt(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.usage")}
            value={imageFallbackUsage}
            onChange={(event) =>
              setImageFallbackUsage(event.target.value === "loading-only" ? "loading-only" : "permanent")
            }
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.variants.json")}
            value={imageFallbackVariants}
            onChange={(event) => setImageFallbackVariants(event.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showLinkExternalCatalogItemReference}
        onOpenChange={setShowLinkExternalCatalogItemReference}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.link.external.catalog.item.reference.2")}
        description={t(
          "catalog.features.catalogItems.ui.catalogItemDetailPage.external.catalog.item.reference.description",
        )}
        footer={
          <Button onClick={handleLinkExternalCatalogItemReference}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.link")}
          </Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.provider")}
            value={externalCatalogItemProviderKey}
            onChange={(event) => setExternalCatalogItemProviderKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.key")}
            value={externalCatalogItemKey}
            onChange={(event) => setExternalCatalogItemKey(event.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showLinkExternalReference}
        onOpenChange={setShowLinkExternalReference}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.link.external.reference.2")}
        description={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.reference.description")}
        footer={
          <Button onClick={handleLinkExternalReference}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.link")}
          </Button>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.provider")}
            value={externalProviderKey}
            onChange={(event) => setExternalProviderKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.external.key")}
            value={externalKey}
            onChange={(event) => setExternalKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options.2")}
            value={externalSelectedOptions}
            onChange={(event) => setExternalSelectedOptions(event.target.value)}
            placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options.placeholder")}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showAddProductContent}
        onOpenChange={setShowAddProductContent}
        title={t("catalog.features.catalogItems.ui.catalogItemDetailPage.add.content.line")}
        footer={
          <Button onClick={handleAddProductContentLine} disabled={!productContentTypeId || !productContentTargetItemId}>
            {t("catalog.features.catalogItems.ui.catalogItemDetailPage.add.content.line")}
          </Button>
        }
      >
        <Stack gap={3}>
          {productContentError ? (
            <Text tone="danger" role="alert">
              {productContentError}
            </Text>
          ) : null}
          <Combobox
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.content.type")}
            items={productContentTypeOptions}
            value={productContentTypeId}
            onValueChange={setProductContentTypeId}
            placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.choose.content.type")}
            noMatchesLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.content.types.match")}
          />
          <Combobox
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.inclusion.policy")}
            items={productContentPolicyOptions}
            value={productContentPolicyId}
            onValueChange={setProductContentPolicyId}
            placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.choose.inclusion.policy")}
            noMatchesLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.inclusion.policies.match")}
          />
          <Combobox
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.contained.catalog.item")}
            items={productContentItemOptions}
            value={productContentTargetItemId}
            onValueChange={setProductContentTargetItemId}
            placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.choose.catalog.item")}
            noMatchesLabel={t("catalog.features.catalogItems.ui.catalogItemDetailPage.no.catalog.items.match")}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options.2")}
            value={productContentTargetOptions}
            onChange={(event) => setProductContentTargetOptions(event.target.value)}
            placeholder={t("catalog.features.catalogItems.ui.catalogItemDetailPage.selected.options.placeholder")}
          />
          <TextInput
            label={t("catalog.features.catalogItems.ui.catalogItemDetailPage.quantity")}
            value={productContentQuantity}
            onChange={(event) => setProductContentQuantity(event.target.value)}
          />
        </Stack>
      </Dialog>

      <ReferenceDetailDialog
        reference={selectedReference}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedReference(null);
          }
        }}
      />
    </>
  );
}

function parseImageFallbackVariants(value: string): CatalogItemImageFallback["variants"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as CatalogItemImageFallback["variants"];
  } catch {
    return {};
  }
}
