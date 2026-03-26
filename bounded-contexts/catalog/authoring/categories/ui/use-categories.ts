import { api } from "../../shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { CategoryDetail, CategoryListItem } from "./contracts";
import { useFetch } from "../../shell-support/ui/use-fetch";

export function useCategoryList(query: string) {
  return useFetch(() => api.get<ListResponse<CategoryListItem>>(`/categories?${query}`), [query]);
}

export function useCategory(id: string) {
  return useFetch(() => api.get<CategoryDetail>(`/categories/${id}`), [id]);
}

export function createCategory(body: {
  categoryId: string;
  key: string;
  name: string;
  description?: string;
  parentCategoryId?: string;
  displayOrder?: number;
}) {
  return api.post<CommandResponse>("/categories", body);
}

export function reviseCategory(id: string, body: {
  key: string;
  name: string;
  description?: string;
  parentCategoryId?: string | null;
  displayOrder?: number;
}) {
  return api.put<CommandResponse>(`/categories/${id}`, body);
}

export function publishCategory(id: string) {
  return api.post<CommandResponse>(`/categories/${id}/publish`);
}

export function deprecateCategory(id: string) {
  return api.post<CommandResponse>(`/categories/${id}/deprecate`);
}

export function archiveCategory(id: string) {
  return api.post<CommandResponse>(`/categories/${id}/archive`);
}






