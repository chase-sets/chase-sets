import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { LocalizedTextMap } from "@chase-sets/localization";
import type { Dimension, DimensionDetail } from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkLifecycleProgressOptions,
  BulkLifecyclePreview,
  BulkLifecycleResult,
} from "../../../support/shell-support/ui/bulk-lifecycle-actions";

export function useDimensionList(query: string, initialData?: ListResponse<Dimension> | null) {
  return useFetch(() => api.listDimensions<ListResponse<Dimension>>(query), [query], initialData);
}

export function useDimension(id: string, initialData?: DimensionDetail | null) {
  return useFetch(() => api.getDimension<DimensionDetail>(id), [id], initialData);
}

export function createDimension(body: {
  dimensionId: string;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  valueKind?: string;
}) {
  return api.createDimension<CommandResponse>(body);
}

export function reviseDimension(
  id: string,
  body: { key: string; name: LocalizedTextMap; description?: LocalizedTextMap; valueKind?: string },
) {
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

export function previewBulkDimensionLifecycle(action: string, selection: unknown) {
  return api.previewBulkDimensionLifecycle<BulkLifecyclePreview>(action, selection);
}

export function confirmBulkDimensionLifecycle(
  action: string,
  selection: unknown,
  options: BulkLifecycleProgressOptions = {},
) {
  return api.confirmBulkDimensionLifecycle<BulkLifecycleResult>(action, selection, options);
}

export function addOption(
  dimensionId: string,
  body: { optionId: string; code: string; label: LocalizedTextMap; numericValue?: number },
) {
  return api.addOption<CommandResponse>(dimensionId, body);
}

export function reviseOption(
  dimensionId: string,
  optionId: string,
  body: { code: string; label: LocalizedTextMap; numericValue?: number },
) {
  return api.reviseOption<CommandResponse>(dimensionId, optionId, body);
}

export function deprecateOption(dimensionId: string, optionId: string) {
  return api.deprecateOption<CommandResponse>(dimensionId, optionId);
}

export function reactivateOption(dimensionId: string, optionId: string) {
  return api.reactivateOption<CommandResponse>(dimensionId, optionId);
}

export function reorderOptions(dimensionId: string, optionIds: string[]) {
  return api.reorderOptions<CommandResponse>(dimensionId, optionIds);
}
