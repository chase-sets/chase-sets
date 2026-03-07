import { api } from "../../api/client";
import type { Component, ListResponse, CommandResponse } from "../../api/types";
import { useFetch } from "../../shared/use-fetch";

export function useComponentList() {
  return useFetch(() => api.get<ListResponse<Component>>("/components"));
}

export function useComponent(id: string) {
  return useFetch(() => api.get<Component>(`/components/${id}`), [id]);
}

export function createComponent(body: { componentId: string; key: string; name: string }) {
  return api.post<CommandResponse>("/components", body);
}

export function configureComponent(id: string, body: {
  key: string;
  name: string;
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

export function addDimensionRule(id: string, body: { dimensionId: string; required: boolean }) {
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
