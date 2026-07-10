import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import {
  getDiscoveryItemDetail,
  getDiscoveryItemDetailSellerOverlay,
  type DiscoveryItemDetailRow,
} from "../read-model/queries";
import type { DiscoveryItemDetailSellerOverlay } from "../../../support/client-support/contracts";
import { buildDiscoveryItemDetailProjectionHandlers } from "../read-model/projection";
import {
  findSimilarDiscoveryItems,
  type FindSimilarDiscoveryItemsOptions,
} from "../../search/read-model/similar-items";

export type DiscoveryItemDetailServices = Readonly<{
  getItemDetail: (itemId: string) => Promise<DiscoveryItemDetailRow | null>;
  getSellerOverlay: (params: {
    accountId: string;
    catalogItemId: string;
    selectedListingId?: string | null;
  }) => Promise<DiscoveryItemDetailSellerOverlay>;
  findSimilarItems: (
    itemId: string,
    options?: Omit<FindSimilarDiscoveryItemsOptions, "semanticEnabled">,
  ) => ReturnType<typeof findSimilarDiscoveryItems>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemDetailRuntime(
  deps: DiscoveryRuntimeDeps,
  options: Readonly<{ semanticSimilarItemsEnabled?: boolean }> = {},
): DiscoveryItemDetailServices {
  return {
    getItemDetail: (itemId) => getDiscoveryItemDetail(deps.db, itemId),
    getSellerOverlay: (params) => getDiscoveryItemDetailSellerOverlay(deps.db, params),
    findSimilarItems: (itemId, queryOptions = {}) =>
      findSimilarDiscoveryItems(deps.db, itemId, {
        ...queryOptions,
        semanticEnabled: options.semanticSimilarItemsEnabled ?? false,
      }),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-item-detail-projection",
        handlers: buildDiscoveryItemDetailProjectionHandlers(deps.db),
      }),
    ],
  };
}
