import { api } from "../../shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { Component, ComponentDetail } from "./contracts";
import { useFetch } from "../../shell-support/ui/use-fetch";

export function useComponentList(query: string) {
  return useFetch(() => api.get<ListResponse<Component>>(`/components?${query}`), [query]);
}

export function useComponent(id: string) {
  return useFetch(() => api.get<ComponentDetail>(`/components/${id}`), [id]);
}

export function createComponent(body: { componentId: string; key: string; name: string; description?: string }) {
  return api.post<CommandResponse>("/components", body);
}

export function configureComponent(id: string, body: {
  key: string;
  name: string;
  description?: string;
  fieldRules: { fieldId: string; required: boolean }[];
  dimensionRules: { dimensionId: string; required: boolean; allowedChoiceIds: string[] }[];
}) {
  return api.put<CommandResponse>(`/components/${id}`, body);
}

export function addFieldRule(id: string, body: { fieldId: string; required: boolean }) {
  return api.post<CommandResponse>(`/components/${id}/field-rules`, body);
}

export function removeFieldRule(id: string, fieldId: string) {
  return api.del<CommandResponse>(`/components/${id}/field-rules/${fieldId}`);
}

export function addDimensionRule(id: string, body: { dimensionId: string; required: boolean; allowedChoiceIds?: string[] }) {
  return api.post<CommandResponse>(`/components/${id}/dimension-rules`, body);
}

export function removeDimensionRule(id: string, dimensionId: string) {
  return api.del<CommandResponse>(`/components/${id}/dimension-rules/${dimensionId}`);
}

export function activateComponent(id: string) {
  return api.post<CommandResponse>(`/components/${id}/activate`);
}

export function deprecateComponent(id: string) {
  return api.post<CommandResponse>(`/components/${id}/deprecate`);
}

export function archiveComponent(id: string) {
  return api.post<CommandResponse>(`/components/${id}/archive`);
}






