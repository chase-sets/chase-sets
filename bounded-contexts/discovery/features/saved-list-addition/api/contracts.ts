import type { DiscoveryRecentSavedList } from "../read-model/queries";

/** Discovery-local picker response projected from Collections facts. */
export type DiscoveryRecentSavedListsResponse = Readonly<{
  items: readonly DiscoveryRecentSavedList[];
  total: number;
  count: number;
}>;
