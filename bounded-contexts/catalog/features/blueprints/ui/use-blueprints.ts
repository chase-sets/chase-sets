import { api } from "../../../support/shell-support/api/client";
import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type { LocalizedTextMap } from "@chase-sets/localization";
import type { Blueprint, BlueprintDetail } from "./contracts";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkLifecycleProgressOptions,
  BulkLifecyclePreview,
  BulkLifecycleResult,
} from "../../../support/shell-support/ui/bulk-lifecycle-actions";

export function useBlueprintList(query: string, initialData?: ListResponse<Blueprint> | null) {
  return useFetch(() => api.listBlueprints<ListResponse<Blueprint>>(query), [query], initialData);
}

export function useBlueprint(id: string, initialData?: BlueprintDetail | null) {
  return useFetch(() => api.getBlueprint<BlueprintDetail>(id), [id], initialData);
}

export function createBlueprint(body: {
  blueprintId: string;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
}) {
  return api.createBlueprint<CommandResponse>(body);
}

export function reviseBlueprint(
  id: string,
  body: { key: string; name: LocalizedTextMap; description?: LocalizedTextMap },
) {
  return api.reviseBlueprint<CommandResponse>(id, body);
}

export function attachComponent(id: string, componentId: string) {
  return api.attachComponent<CommandResponse>(id, componentId);
}

export function detachComponent(id: string, componentId: string) {
  return api.detachComponent<CommandResponse>(id, componentId);
}

export function setBlueprintFields(id: string, fieldRules: { fieldId: string; required: boolean }[]) {
  return api.setBlueprintFields<CommandResponse>(id, fieldRules);
}

export function setBlueprintDimensions(
  id: string,
  dimensionRules: {
    dimensionId: string;
    required: boolean;
    allowedOptionIds: string[];
    appliesWhen: Array<{ dimensionId: string; optionIds: string[] }>;
  }[],
) {
  return api.setBlueprintDimensions<CommandResponse>(id, dimensionRules);
}

export function setBlueprintProductResolutionRules(id: string, canonicalDimensionOrder: string[]) {
  return api.setBlueprintProductResolutionRules<CommandResponse>(id, canonicalDimensionOrder);
}

export function publishBlueprint(id: string) {
  return api.publishBlueprint<CommandResponse>(id);
}

export function deprecateBlueprint(id: string) {
  return api.deprecateBlueprint<CommandResponse>(id);
}

export function archiveBlueprint(id: string) {
  return api.archiveBlueprint<CommandResponse>(id);
}

export function previewBulkBlueprintLifecycle(action: string, selection: unknown) {
  return api.previewBulkBlueprintLifecycle<BulkLifecyclePreview>(action, selection);
}

export function confirmBulkBlueprintLifecycle(
  action: string,
  selection: unknown,
  options: BulkLifecycleProgressOptions = {},
) {
  return api.confirmBulkBlueprintLifecycle<BulkLifecycleResult>(action, selection, options);
}
