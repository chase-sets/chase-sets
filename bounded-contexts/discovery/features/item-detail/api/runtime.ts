import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import {
  getDiscoveryItemDetail,
  getDiscoveryItemDetailSellerOverlay,
  type DiscoveryItemDetailRow,
} from "../read-model/queries";
import type { DiscoveryItemDetailSellerOverlay } from "../../../support/client-support/contracts";
import { buildDiscoveryItemDetailProjectionHandlers } from "../read-model/projection";

export type DiscoveryItemDetailServices = Readonly<{
  getItemDetail: (itemId: string) => Promise<DiscoveryItemDetailRow | null>;
  getSellerOverlay: (params: {
    accountId: string;
    catalogItemId: string;
    selectedListingId?: string | null;
  }) => Promise<DiscoveryItemDetailSellerOverlay>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemDetailRuntime(deps: DiscoveryRuntimeDeps): DiscoveryItemDetailServices {
  return {
    getItemDetail: (itemId) => getDiscoveryItemDetail(deps.db, itemId),
    getSellerOverlay: (params) => getDiscoveryItemDetailSellerOverlay(deps.db, params),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-item-detail-projection",
        handlers: buildDiscoveryItemDetailProjectionHandlers(deps.db),
      }),
    ],
  };
}
