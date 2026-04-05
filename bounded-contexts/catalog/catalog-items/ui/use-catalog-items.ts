import { api } from "../../shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { CatalogItemDetail, CatalogItemListItem } from "./contracts";
import { useFetch } from "../../shell-support/ui/use-fetch";

export function useCatalogItemList(query: string, initialData?: ListResponse<CatalogItemListItem> | null) {
  return useFetch(() => api.listCatalogItems<ListResponse<CatalogItemListItem>>(query), [query], initialData);
}

export function useCatalogItem(id: string, initialData?: CatalogItemDetail | null) {
  return useFetch(() => api.getCatalogItem<CatalogItemDetail>(id), [id], initialData);
}

export function createCatalogItem(body: { itemId: string; title: string; subtitle?: string; description?: string }) {
  return api.createCatalogItem<CommandResponse>(body);
}

export function assignBlueprint(id: string, blueprintId: string) {
  return api.assignBlueprint<CommandResponse>(id, blueprintId);
}

export function setFieldValue(id: string, fieldId: string, value: string) {
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

export function reviseMetadata(id: string, body: { title: string; subtitle?: string | null; description?: string }) {
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






