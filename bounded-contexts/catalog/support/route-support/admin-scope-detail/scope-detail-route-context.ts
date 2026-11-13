import type { CatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import { serializeCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";

// Scope Detail's forms land back on Scope Detail with the command's checkpoints.
export function scopeDetailCommandHref(scopeRecordId: string, context: CatalogPrimaryWorkbenchRouteContext): string {
  const query = serializeCatalogPrimaryWorkbenchRouteContext(context).toString();
  const path = `/catalog/scopes/${encodeURIComponent(scopeRecordId)}`;
  return query ? `${path}?${query}` : path;
}
