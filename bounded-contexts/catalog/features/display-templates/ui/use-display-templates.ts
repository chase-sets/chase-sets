import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { api } from "../../../support/shell-support/api/client";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type { DisplayTemplate, DisplayTemplateDetail, DisplayTemplateInput } from "./contracts";

export { localizedTextMapFromEnglish };

export function useDisplayTemplateList(query: string, initialData?: ListResponse<DisplayTemplate> | null) {
  return useFetch(() => api.listDisplayTemplates<ListResponse<DisplayTemplate>>(query), [query], initialData);
}

export function useDisplayTemplate(id: string, initialData?: DisplayTemplateDetail | null) {
  return useFetch(() => api.getDisplayTemplate<DisplayTemplateDetail>(id), [id], initialData);
}

export function createDisplayTemplate(body: DisplayTemplateInput & { displayTemplateId: string }) {
  return api.createDisplayTemplate<CommandResponse>(body);
}

export function reviseDisplayTemplate(id: string, body: DisplayTemplateInput) {
  return api.reviseDisplayTemplate<CommandResponse>(id, body);
}

export function publishDisplayTemplate(id: string) {
  return api.publishDisplayTemplate<CommandResponse>(id);
}

export function deprecateDisplayTemplate(id: string) {
  return api.deprecateDisplayTemplate<CommandResponse>(id);
}

export function archiveDisplayTemplate(id: string) {
  return api.archiveDisplayTemplate<CommandResponse>(id);
}

export function parseRequiredFieldKeys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
