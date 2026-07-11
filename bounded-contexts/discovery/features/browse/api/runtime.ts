import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import { getDiscoveryBrowseSetPageBySlug, type DiscoveryBrowseSetPageRow } from "../read-model/queries";

export type DiscoveryBrowseServices = Readonly<{
  getSetBySlug: (slug: string) => Promise<DiscoveryBrowseSetPageRow | null>;
}>;

export function createDiscoveryBrowseRuntime(deps: DiscoveryRuntimeDeps): DiscoveryBrowseServices {
  return {
    getSetBySlug: (slug) => getDiscoveryBrowseSetPageBySlug(deps.db, slug),
  };
}
