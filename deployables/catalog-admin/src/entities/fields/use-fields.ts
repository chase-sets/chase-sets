import { api } from "../../api/client";
import type { Field, ListResponse, CommandResponse } from "../../api/types";
import { useFetch } from "../../shared/use-fetch";

export function useFieldList() {
  return useFetch(() => api.get<ListResponse<Field>>("/fields"));
}

export function useField(id: string) {
  return useFetch(() => api.get<Field>(`/fields/${id}`), [id]);
}

export function createField(body: {
  fieldId: string;
  key: string;
  name: string;
  valueType: string;
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
}) {
  return api.post<CommandResponse>("/fields", body);
}

export function configureField(id: string, body: {
  key: string;
  name: string;
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
