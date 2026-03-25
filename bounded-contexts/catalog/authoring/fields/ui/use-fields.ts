import { api } from "../../support/api/client";
import type { CommandResponse, ListResponse } from "../../../../../contracts/http/responses";
import type { Field } from "./contracts";
import { useFetch } from "../../support/ui/use-fetch";

export function useFieldList(query: string) {
  return useFetch(() => api.get<ListResponse<Field>>(`/fields?${query}`), [query]);
}

export function useField(id: string) {
  return useFetch(() => api.get<Field>(`/fields/${id}`), [id]);
}

export function createField(body: {
  fieldId: string;
  key: string;
  name: string;
  description?: string;
  valueType: string;
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
}) {
  return api.post<CommandResponse>("/fields", body);
}

export function configureField(id: string, body: {
  key: string;
  name: string;
  description?: string;
  valueType: string;
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
}) {
  return api.put<CommandResponse>(`/fields/${id}`, body);
}

export function activateField(id: string) {
  return api.post<CommandResponse>(`/fields/${id}/activate`);
}

export function deprecateField(id: string) {
  return api.post<CommandResponse>(`/fields/${id}/deprecate`);
}

export function archiveField(id: string) {
  return api.post<CommandResponse>(`/fields/${id}/archive`);
}





