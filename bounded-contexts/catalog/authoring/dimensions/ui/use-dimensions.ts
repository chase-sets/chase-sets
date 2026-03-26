import { api } from "../../shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { Dimension, DimensionDetail } from "./contracts";
import { useFetch } from "../../shell-support/ui/use-fetch";

export function useDimensionList(query: string, initialData?: ListResponse<Dimension> | null) {
  return useFetch(() => api.listDimensions<ListResponse<Dimension>>(query), [query], initialData);
}

export function useDimension(id: string, initialData?: DimensionDetail | null) {
  return useFetch(() => api.getDimension<DimensionDetail>(id), [id], initialData);
}

export function createDimension(body: { dimensionId: string; key: string; name: string; description?: string }) {
  return api.createDimension<CommandResponse>(body);
}

export function reviseDimension(id: string, body: { key: string; name: string; description?: string }) {
  return api.reviseDimension<CommandResponse>(id, body);
}

export function activateDimension(id: string) {
  return api.activateDimension<CommandResponse>(id);
}

export function deprecateDimension(id: string) {
  return api.deprecateDimension<CommandResponse>(id);
}

export function archiveDimension(id: string) {
  return api.archiveDimension<CommandResponse>(id);
}

export function addChoice(dimensionId: string, body: { choiceId: string; code: string; labels?: { locale: string; value: string }[]; numericValue?: number }) {
  return api.addChoice<CommandResponse>(dimensionId, body);
}

export function reviseChoice(dimensionId: string, choiceId: string, body: { code: string; labels?: { locale: string; value: string }[]; numericValue?: number }) {
  return api.reviseChoice<CommandResponse>(dimensionId, choiceId, body);
}

export function deprecateChoice(dimensionId: string, choiceId: string) {
  return api.deprecateChoice<CommandResponse>(dimensionId, choiceId);
}

export function reactivateChoice(dimensionId: string, choiceId: string) {
  return api.reactivateChoice<CommandResponse>(dimensionId, choiceId);
}

export function reorderChoices(dimensionId: string, choiceIds: string[]) {
  return api.reorderChoices<CommandResponse>(dimensionId, choiceIds);
}






