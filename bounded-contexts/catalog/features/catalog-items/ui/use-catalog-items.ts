import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { LocalizedTextMap } from "@chase-sets/localization";
import type { BulkPublishPreview, BulkPublishResult, CatalogItemDetail, CatalogItemImageFallback, CatalogItemListItem } from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";

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

export function useCatalogItemList(query: string, initialData?: ListResponse<CatalogItemListItem> | null) {
  return useFetch(() => api.listCatalogItems<ListResponse<CatalogItemListItem>>(query), [query], initialData);
}

export function useCatalogItem(id: string, initialData?: CatalogItemDetail | null) {
  return useFetch(() => api.getCatalogItem<CatalogItemDetail>(id), [id], initialData);
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

export function confirmBulkPublishCatalogItems(itemIds: readonly string[]) {
  return api.confirmBulkPublishCatalogItems<BulkPublishResult>(itemIds);
}

export function reviseMetadata(id: string, body: CatalogItemMetadataInput) {
  return api.reviseMetadata<CommandResponse>(id, body);
}

export function retireCatalogItem(id: string) {
  return api.retireCatalogItem<CommandResponse>(id);
}

export function archiveCatalogItem(id: string) {
  return api.archiveCatalogItem<CommandResponse>(id);
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
  return api.linkExternalProductReference<CommandResponse>(
    id,
    providerKey,
    externalKey,
    selectedOptions,
  );
}

export function unlinkExternalProductReference(
  id: string,
  providerKey: string,
  externalKey: string,
) {
  return api.unlinkExternalProductReference<CommandResponse>(
    id,
    providerKey,
    externalKey,
  );
}

