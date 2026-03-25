import { api } from "../../shared/ui/api/client";
import type { ListResponse, CommandResponse } from "../../shared/ui/api/contracts";
import type { CatalogItemDetail, CatalogItemListItem } from "./contracts";
import { useFetch } from "../../shared/ui/use-fetch";

export function useCatalogItemList(query: string) {
  return useFetch(() => api.get<ListResponse<CatalogItemListItem>>(`/items?${query}`), [query]);
}

export function useCatalogItem(id: string) {
  return useFetch(() => api.get<CatalogItemDetail>(`/items/${id}`), [id]);
}

export function createCatalogItem(body: { itemId: string; title: string; subtitle?: string; description?: string }) {
  return api.post<CommandResponse>("/items", body);
}

export function assignBlueprint(id: string, blueprintId: string) {
  return api.post<CommandResponse>(`/items/${id}/blueprint`, { blueprintId });
}

export function setFieldValue(id: string, fieldId: string, value: string) {
  return api.put<CommandResponse>(`/items/${id}/fields/${fieldId}`, { value });
}

export function clearFieldValue(id: string, fieldId: string) {
  return api.del<CommandResponse>(`/items/${id}/fields/${fieldId}`);
}

export function assignCategory(id: string, categoryId: string) {
  return api.post<CommandResponse>(`/items/${id}/categories/${categoryId}`);
}

export function removeCategory(id: string, categoryId: string) {
  return api.del<CommandResponse>(`/items/${id}/categories/${categoryId}`);
}

export function publishCatalogItem(id: string, blueprintIsActive: boolean, requiredFieldIds: string[]) {
  return api.post<CommandResponse>(`/items/${id}/publish`, { blueprintIsActive, requiredFieldIds });
}

export function reviseMetadata(id: string, body: { title: string; subtitle?: string | null; description?: string }) {
  return api.put<CommandResponse>(`/items/${id}/metadata`, body);
}

export function retireCatalogItem(id: string) {
  return api.post<CommandResponse>(`/items/${id}/retire`);
}

export function archiveCatalogItem(id: string) {
  return api.post<CommandResponse>(`/items/${id}/archive`);
}

export function setTags(id: string, tags: string[]) {
  return api.put<CommandResponse>(`/items/${id}/tags`, { tags });
}

export function setImageUrls(id: string, imageUrls: string[]) {
  return api.put<CommandResponse>(`/items/${id}/image-urls`, { imageUrls });
}



