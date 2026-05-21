import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { LocalizedTextMap } from "@chase-sets/localization";
import type { Field } from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkLifecyclePreview,
  BulkLifecycleResult,
} from "../../../support/shell-support/ui/bulk-lifecycle-actions";

export function useFieldList(query: string, initialData?: ListResponse<Field> | null) {
  return useFetch(() => api.listFields<ListResponse<Field>>(query), [query], initialData);
}

export function useField(id: string, initialData?: Field | null) {
  return useFetch(() => api.getField<Field>(id), [id], initialData);
}

export function createField(body: {
  fieldId: string;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  valueType: string;
  behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
}) {
  return api.createField<CommandResponse>(body);
}

export function configureField(
  id: string,
  body: {
    key: string;
    name: LocalizedTextMap;
    description?: LocalizedTextMap;
    valueType: string;
    behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
  },
) {
  return api.reviseField<CommandResponse>(id, body);
}

export function activateField(id: string) {
  return api.activateField<CommandResponse>(id);
}

export function deprecateField(id: string) {
  return api.deprecateField<CommandResponse>(id);
}

export function archiveField(id: string) {
  return api.archiveField<CommandResponse>(id);
}

export function previewBulkFieldLifecycle(action: string, selection: unknown) {
  return api.previewBulkFieldLifecycle<BulkLifecyclePreview>(action, selection);
}

export function confirmBulkFieldLifecycle(action: string, selection: unknown) {
  return api.confirmBulkFieldLifecycle<BulkLifecycleResult>(action, selection);
}
