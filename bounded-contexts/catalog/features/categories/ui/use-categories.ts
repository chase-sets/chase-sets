import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { CategoryDetail, CategoryListItem } from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";

export function useCategoryList(query: string, initialData?: ListResponse<CategoryListItem> | null) {
  return useFetch(() => api.listCategories<ListResponse<CategoryListItem>>(query), [query], initialData);
}

export function useCategory(id: string, initialData?: CategoryDetail | null) {
  return useFetch(() => api.getCategory<CategoryDetail>(id), [id], initialData);
}

export function createCategory(body: {
  categoryId: string;
  key: string;
  name: string;
  description?: string;
  parentCategoryId?: string;
  displayOrder?: number;
}) {
  return api.createCategory<CommandResponse>(body);
}

export function reviseCategory(id: string, body: {
  key: string;
  name: string;
  description?: string;
  parentCategoryId?: string | null;
  displayOrder?: number;
}) {
  return api.reviseCategory<CommandResponse>(id, body);
}

export function publishCategory(id: string) {
  return api.publishCategory<CommandResponse>(id);
}

export function deprecateCategory(id: string) {
  return api.deprecateCategory<CommandResponse>(id);
}

export function archiveCategory(id: string) {
  return api.archiveCategory<CommandResponse>(id);
}






