import { api } from "../../shared/ui/api/client";
import type { Dimension, DimensionDetail, ListResponse, CommandResponse } from "../../shared/ui/api/types";
import { useFetch } from "../../shared/ui/use-fetch";

export function useDimensionList(query: string) {
  return useFetch(() => api.get<ListResponse<Dimension>>(`/dimensions?${query}`), [query]);
}

export function useDimension(id: string) {
  return useFetch(() => api.get<DimensionDetail>(`/dimensions/${id}`), [id]);
}

export function createDimension(body: { dimensionId: string; key: string; name: string; description?: string }) {
  return api.post<CommandResponse>("/dimensions", body);
}

export function reviseDimension(id: string, body: { key: string; name: string; description?: string }) {
  return api.put<CommandResponse>(`/dimensions/${id}`, body);
}

export function activateDimension(id: string) {
  return api.post<CommandResponse>(`/dimensions/${id}/activate`);
}

export function deprecateDimension(id: string) {
  return api.post<CommandResponse>(`/dimensions/${id}/deprecate`);
}

export function archiveDimension(id: string) {
  return api.post<CommandResponse>(`/dimensions/${id}/archive`);
}

export function addChoice(dimensionId: string, body: { choiceId: string; code: string; labels?: { locale: string; value: string }[]; numericValue?: number }) {
  return api.post<CommandResponse>(`/dimensions/${dimensionId}/choices`, body);
}

export function reviseChoice(dimensionId: string, choiceId: string, body: { code: string; labels?: { locale: string; value: string }[]; numericValue?: number }) {
  return api.put<CommandResponse>(`/dimensions/${dimensionId}/choices/${choiceId}`, body);
}

export function deprecateChoice(dimensionId: string, choiceId: string) {
  return api.post<CommandResponse>(`/dimensions/${dimensionId}/choices/${choiceId}/deprecate`);
}

export function reactivateChoice(dimensionId: string, choiceId: string) {
  return api.post<CommandResponse>(`/dimensions/${dimensionId}/choices/${choiceId}/reactivate`);
}

export function reorderChoices(dimensionId: string, choiceIds: string[]) {
  return api.put<CommandResponse>(`/dimensions/${dimensionId}/choices/order`, { choiceIds });
}

