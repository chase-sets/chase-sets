import { api } from "../../api/client";
import type { Blueprint, BlueprintDetail, ListResponse, CommandResponse } from "../../api/types";
import { useFetch } from "../../shared/use-fetch";

export function useBlueprintList(query: string) {
  return useFetch(() => api.get<ListResponse<Blueprint>>(`/blueprints?${query}`), [query]);
}

export function useBlueprint(id: string) {
  return useFetch(() => api.get<BlueprintDetail>(`/blueprints/${id}`), [id]);
}

export function createBlueprint(body: { blueprintId: string; key: string; name: string; description?: string }) {
  return api.post<CommandResponse>("/blueprints", body);
}

export function reviseBlueprint(id: string, body: { key: string; name: string; description?: string }) {
  return api.put<CommandResponse>(`/blueprints/${id}`, body);
}

export function attachComponent(id: string, componentId: string) {
  return api.post<CommandResponse>(`/blueprints/${id}/components/${componentId}`);
}

export function detachComponent(id: string, componentId: string) {
  return api.del<CommandResponse>(`/blueprints/${id}/components/${componentId}`);
}

export function setBlueprintFields(id: string, fieldRules: { fieldId: string; required: boolean }[]) {
  return api.put<CommandResponse>(`/blueprints/${id}/fields`, { fieldRules });
}

export function setBlueprintDimensions(id: string, dimensionRules: { dimensionId: string; required: boolean; allowedChoiceIds: string[] }[]) {
  return api.put<CommandResponse>(`/blueprints/${id}/dimensions`, { dimensionRules });
}

export function setBlueprintVersionRules(id: string, canonicalDimensionOrder: string[]) {
  return api.put<CommandResponse>(`/blueprints/${id}/version-rules`, { canonicalDimensionOrder });
}

export function publishBlueprint(id: string) {
  return api.post<CommandResponse>(`/blueprints/${id}/publish`);
}

export function deprecateBlueprint(id: string) {
  return api.post<CommandResponse>(`/blueprints/${id}/deprecate`);
}

export function archiveBlueprint(id: string) {
  return api.post<CommandResponse>(`/blueprints/${id}/archive`);
}
