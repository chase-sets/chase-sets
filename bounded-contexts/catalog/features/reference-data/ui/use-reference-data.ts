import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { LocalizedTextMap } from "@chase-sets/localization";
import type { ReferenceRecord, ReferenceRelationship, ReferenceType } from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkLifecyclePreview,
  BulkLifecycleResult,
} from "../../../support/shell-support/ui/bulk-lifecycle-actions";

export function useReferenceTypeList(query: string, initialData?: ListResponse<ReferenceType> | null) {
  return useFetch(() => api.listReferenceTypes<ListResponse<ReferenceType>>(query), [query], initialData);
}

export function useReferenceType(id: string, initialData?: ReferenceType | null) {
  return useFetch(() => api.getReferenceType<ReferenceType>(id), [id], initialData);
}

export function useReferenceRecordList(query: string, initialData?: ListResponse<ReferenceRecord> | null) {
  return useFetch(() => api.listReferenceRecords<ListResponse<ReferenceRecord>>(query), [query], initialData);
}

export function useReferenceRecord(id: string, initialData?: ReferenceRecord | null) {
  return useFetch(() => api.getReferenceRecord<ReferenceRecord>(id), [id], initialData);
}

export function createReferenceType(body: {
  referenceTypeId: string;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  attributeKeys: string[];
}) {
  return api.createReferenceType<CommandResponse>(body);
}

export function reviseReferenceType(
  id: string,
  body: {
    key: string;
    name: LocalizedTextMap;
    description?: LocalizedTextMap;
    attributeKeys: string[];
  },
) {
  return api.reviseReferenceType<CommandResponse>(id, body);
}

export function publishReferenceType(id: string) {
  return api.publishReferenceType<CommandResponse>(id);
}

export function deprecateReferenceType(id: string) {
  return api.deprecateReferenceType<CommandResponse>(id);
}

export function archiveReferenceType(id: string) {
  return api.archiveReferenceType<CommandResponse>(id);
}

export function previewBulkReferenceTypeLifecycle(action: string, selection: unknown) {
  return api.previewBulkReferenceTypeLifecycle<BulkLifecyclePreview>(action, selection);
}

export function confirmBulkReferenceTypeLifecycle(action: string, selection: unknown) {
  return api.confirmBulkReferenceTypeLifecycle<BulkLifecycleResult>(action, selection);
}

export function createReferenceRecord(body: {
  referenceRecordId: string;
  typeKey: string;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  attributes: Record<string, unknown>;
  relationships: ReferenceRelationship[];
}) {
  return api.createReferenceRecord<CommandResponse>(body);
}

export function reviseReferenceRecord(
  id: string,
  body: {
    typeKey: string;
    key: string;
    name: LocalizedTextMap;
    description?: LocalizedTextMap;
    attributes: Record<string, unknown>;
    relationships: ReferenceRelationship[];
  },
) {
  return api.reviseReferenceRecord<CommandResponse>(id, body);
}

export function publishReferenceRecord(id: string) {
  return api.publishReferenceRecord<CommandResponse>(id);
}

export function deprecateReferenceRecord(id: string) {
  return api.deprecateReferenceRecord<CommandResponse>(id);
}

export function archiveReferenceRecord(id: string) {
  return api.archiveReferenceRecord<CommandResponse>(id);
}

export function previewBulkReferenceRecordLifecycle(action: string, selection: unknown) {
  return api.previewBulkReferenceRecordLifecycle<BulkLifecyclePreview>(action, selection);
}

export function confirmBulkReferenceRecordLifecycle(action: string, selection: unknown) {
  return api.confirmBulkReferenceRecordLifecycle<BulkLifecycleResult>(action, selection);
}
