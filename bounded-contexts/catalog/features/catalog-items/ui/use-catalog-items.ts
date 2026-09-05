import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { LocalizedTextMap } from "@chase-sets/localization";
import type {
  BulkEditCatalogItemOperation,
  BulkEditCatalogItemPreview,
  BulkEditCatalogItemResult,
  BulkPublishPreview,
  BulkPublishResult,
  CatalogItemDetail,
  CatalogItemImageFallback,
  CatalogItemListItem,
  ProductContentInclusionPolicyRef,
  ProductContentLineDetail,
  ProductContentsResolvedSnapshot,
  ProductContentTypeRef,
  ReplaceProductContentsInput,
} from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkLifecycleProgressOptions,
  BulkLifecyclePreview,
  BulkLifecycleResult,
} from "../../../support/shell-support/ui/bulk-lifecycle-actions";

export type CatalogItemMetadataInput = {
  languageCode?: string;
  title: LocalizedTextMap;
  subtitle?: LocalizedTextMap | null;
  description?: LocalizedTextMap;
};

export function localizedTextMapFromEnglish(value: string): LocalizedTextMap {
  const trimmed = value.trim();

  return {
    defaultLocale: "en",
    values: trimmed ? { en: trimmed } : {},
  };
}

export function localizedTextMapFromUnknown(value: unknown, fallback: string): LocalizedTextMap {
  if (
    value &&
    typeof value === "object" &&
    "defaultLocale" in value &&
    "values" in value &&
    typeof value.defaultLocale === "string" &&
    value.values &&
    typeof value.values === "object" &&
    !Array.isArray(value.values)
  ) {
    return value as LocalizedTextMap;
  }

  return localizedTextMapFromEnglish(fallback);
}

export function useCatalogItemList(query: string, initialData?: ListResponse<CatalogItemListItem> | null) {
  return useFetch(() => api.listCatalogItems<ListResponse<CatalogItemListItem>>(query), [query], initialData);
}

export function useCatalogItem(id: string, initialData?: CatalogItemDetail | null) {
  return useFetch(() => api.getCatalogItem<CatalogItemDetail>(id), [id], initialData);
}

export function recheckCatalogItemPublication(id: string) {
  return api.getCatalogItem<CatalogItemDetail>(id);
}

export function useProductContentTypes() {
  return useFetch(() => api.listProductContentTypes<ListResponse<ProductContentTypeRef>>(), []);
}

export function useProductContentInclusionPolicies() {
  return useFetch(() => api.listProductContentInclusionPolicies<ListResponse<ProductContentInclusionPolicyRef>>(), []);
}

export function useProductContentsForContainer(id: string) {
  return useFetch(() => api.listProductContentsForContainer<ListResponse<ProductContentLineDetail>>(id), [id]);
}

export function useProductContainersForContained(id: string) {
  return useFetch(() => api.listProductContainersForContained<ListResponse<ProductContentLineDetail>>(id), [id]);
}

export function replaceProductContents(id: string, body: ReplaceProductContentsInput) {
  return api.replaceProductContents<ProductContentsResolvedSnapshot>(id, body);
}

export function removeProductContents(id: string, body: Pick<ReplaceProductContentsInput, "containerSelectedOptions">) {
  return api.removeProductContents<ProductContentsResolvedSnapshot>(id, body);
}

export function createCatalogItem(body: CatalogItemMetadataInput & { itemId: string }) {
  return api.createCatalogItem<CommandResponse>(body);
}

export function assignBlueprint(id: string, blueprintId: string) {
  return api.assignBlueprint<CommandResponse>(id, blueprintId);
}

export function setFieldValue(id: string, fieldId: string, value: unknown) {
  return api.setFieldValue<CommandResponse>(id, fieldId, value);
}

export function clearFieldValue(id: string, fieldId: string) {
  return api.clearFieldValue<CommandResponse>(id, fieldId);
}

export function assignCategory(id: string, categoryId: string) {
  return api.assignCategory<CommandResponse>(id, categoryId);
}

export function removeCategory(id: string, categoryId: string) {
  return api.removeCategory<CommandResponse>(id, categoryId);
}

export function publishCatalogItem(id: string, blueprintIsActive: boolean, requiredFieldIds: string[]) {
  return api.publishCatalogItem<CommandResponse>(id, blueprintIsActive, requiredFieldIds);
}

export function previewBulkPublishCatalogItems(selection: unknown) {
  return api.previewBulkPublishCatalogItems<BulkPublishPreview>(selection);
}

export function confirmBulkPublishCatalogItems(itemIds: readonly string[], options: BulkLifecycleProgressOptions = {}) {
  return api.confirmBulkPublishCatalogItems<BulkPublishResult>(itemIds, options);
}

export function reviseMetadata(id: string, body: CatalogItemMetadataInput) {
  return api.reviseMetadata<CommandResponse>(id, body);
}

export function archiveCatalogItem(id: string) {
  return api.archiveCatalogItem<CommandResponse>(id);
}

export function previewBulkCatalogItemLifecycle(action: string, selection: unknown) {
  return api.previewBulkCatalogItemLifecycle<BulkLifecyclePreview>(action, selection);
}

export function confirmBulkCatalogItemLifecycle(
  action: string,
  selection: unknown,
  options: BulkLifecycleProgressOptions = {},
) {
  return api.confirmBulkCatalogItemLifecycle<BulkLifecycleResult>(action, selection, options);
}

export function previewBulkCatalogItemEdit(operation: BulkEditCatalogItemOperation, selection: unknown) {
  return api.previewBulkCatalogItemEdit<BulkEditCatalogItemPreview>(operation, selection);
}

export function confirmBulkCatalogItemEdit(
  operation: BulkEditCatalogItemOperation,
  selection: unknown,
  options: BulkLifecycleProgressOptions = {},
) {
  return api.confirmBulkCatalogItemEdit<BulkEditCatalogItemResult>(operation, selection, options);
}

export function removeDraftCatalogItem(id: string) {
  return api.removeDraftCatalogItem<CommandResponse>(id);
}

export function setTags(id: string, tags: string[]) {
  return api.setTags<CommandResponse>(id, tags);
}

export function setImageUrls(id: string, imageUrls: string[]) {
  return api.setImageUrls<CommandResponse>(id, imageUrls);
}

export function setImageFallback(id: string, imageFallback: CatalogItemImageFallback) {
  return api.setImageFallback<CommandResponse>(id, imageFallback);
}

export function clearImageFallback(id: string) {
  return api.clearImageFallback<CommandResponse>(id);
}

export function linkExternalProductReference(
  id: string,
  providerKey: string,
  externalKey: string,
  selectedOptions: Array<{ dimensionId: string; optionId: string }>,
) {
  return api.linkExternalProductReference<CommandResponse>(id, providerKey, externalKey, selectedOptions);
}

export function unlinkExternalProductReference(id: string, providerKey: string, externalKey: string) {
  return api.unlinkExternalProductReference<CommandResponse>(id, providerKey, externalKey);
}

export function linkExternalCatalogItemReference(id: string, providerKey: string, externalKey: string) {
  return api.linkExternalCatalogItemReference<CommandResponse>(id, providerKey, externalKey);
}

export function unlinkExternalCatalogItemReference(id: string, providerKey: string, externalKey: string) {
  return api.unlinkExternalCatalogItemReference<CommandResponse>(id, providerKey, externalKey);
}
