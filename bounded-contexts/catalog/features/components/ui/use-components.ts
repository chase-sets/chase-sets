import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { Component, ComponentDetail } from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";

export function useComponentList(query: string, initialData?: ListResponse<Component> | null) {
  return useFetch(() => api.listComponents<ListResponse<Component>>(query), [query], initialData);
}

export function useComponent(id: string, initialData?: ComponentDetail | null) {
  return useFetch(() => api.getComponent<ComponentDetail>(id), [id], initialData);
}

export function createComponent(body: { componentId: string; key: string; name: string; description?: string }) {
  return api.createComponent<CommandResponse>(body);
}

export function configureComponent(id: string, body: {
  key: string;
  name: string;
  description?: string;
  fieldRules: { fieldId: string; required: boolean }[];
  dimensionRules: { dimensionId: string; required: boolean; allowedChoiceIds: string[]; appliesWhen: Array<{ dimensionId: string; choiceIds: string[] }> }[];
}) {
  return api.reviseComponent<CommandResponse>(id, body);
}

export function addFieldRule(id: string, body: { fieldId: string; required: boolean }) {
  return api.addFieldRule<CommandResponse>(id, body);
}

export function removeFieldRule(id: string, fieldId: string) {
  return api.removeFieldRule<CommandResponse>(id, fieldId);
}

export function addDimensionRule(id: string, body: { dimensionId: string; required: boolean; allowedChoiceIds?: string[]; appliesWhen?: Array<{ dimensionId: string; choiceIds: string[] }> }) {
  return api.addDimensionRule<CommandResponse>(id, body);
}

export function removeDimensionRule(id: string, dimensionId: string) {
  return api.removeDimensionRule<CommandResponse>(id, dimensionId);
}

export function activateComponent(id: string) {
  return api.activateComponent<CommandResponse>(id);
}

export function deprecateComponent(id: string) {
  return api.deprecateComponent<CommandResponse>(id);
}

export function archiveComponent(id: string) {
  return api.archiveComponent<CommandResponse>(id);
}







