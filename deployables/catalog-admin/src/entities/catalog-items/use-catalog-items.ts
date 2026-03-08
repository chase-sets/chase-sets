import { api } from "../../api/client";
import type { CatalogItemDetail, CatalogItemListItem, ListResponse, CommandResponse } from "../../api/types";
import { useFetch } from "../../shared/use-fetch";

export function useCatalogItemList(query: string) {
  return useFetch(() => api.get<ListResponse<CatalogItemListItem>>(`/catalog-items?${query}`), [query]);
}

export function useCatalogItem(id: string) {
  return useFetch(() => api.get<CatalogItemDetail>(`/catalog-items/${id}`), [id]);
}

export function createCatalogItem(body: { itemId: string; title: string; subtitle?: string; description?: string }) {
  return api.post<CommandResponse>("/catalog-items", body);
}

export function assignBlueprint(id: string, blueprintId: string) {
  return api.post<CommandResponse>(`/catalog-items/${id}/blueprint`, { blueprintId });
}

export function setFieldValue(id: string, fieldId: string, value: string) {
  return api.put<CommandResponse>(`/catalog-items/${id}/fields/${fieldId}`, { value });
}

export function clearFieldValue(id: string, fieldId: string) {
  return api.del<CommandResponse>(`/catalog-items/${id}/fields/${fieldId}`);
}

export function assignCategory(id: string, categoryId: string) {
  return api.post<CommandResponse>(`/catalog-items/${id}/categories/${categoryId}`);
}

export function removeCategory(id: string, categoryId: string) {
  return api.del<CommandResponse>(`/catalog-items/${id}/categories/${categoryId}`);
}

export function publishCatalogItem(id: string, blueprintIsActive: boolean, requiredFieldIds: string[]) {
  return api.post<CommandResponse>(`/catalog-items/${id}/publish`, { blueprintIsActive, requiredFieldIds });
}

export function reviseMetadata(id: string, body: { title: string; subtitle?: string | null; description?: string }) {
  return api.put<CommandResponse>(`/catalog-items/${id}/metadata`, body);
}

export function retireCatalogItem(id: string) {
  return api.post<CommandResponse>(`/catalog-items/${id}/retire`);
}

export function archiveCatalogItem(id: string) {
  return api.post<CommandResponse>(`/catalog-items/${id}/archive`);
}

export function setTags(id: string, tags: string[]) {
  return api.put<CommandResponse>(`/catalog-items/${id}/tags`, { tags });
}

export function setImageUrls(id: string, imageUrls: string[]) {
  return api.put<CommandResponse>(`/catalog-items/${id}/image-urls`, { imageUrls });
}
