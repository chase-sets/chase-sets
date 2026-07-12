import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  marketAnalyticsDisplayPolicy,
  type MarketAnalyticsDisplayPolicyValue,
} from "../../market-rollups/domain/display-policy";
import { marketStatHygienePolicy } from "../../market-trades/domain/stat-hygiene-policy";
import {
  getPublicMarketPageData,
  listPublicMarketPageSlugs,
  type PublicMarketPageData,
  type PublicMarketPageSitemapEntry,
} from "../read-model/queries";

type PublicMarketPagesRuntimeDeps = Readonly<{
  db: PgQueryable;
  /** Pricing's mounted platform-policy runtime -- resolves the display and stat-hygiene policies. */
  policies: PolicyRuntime;
}>;

export type PublicMarketPagesServices = Readonly<{
  getPublicMarketPage: (slugOrId: string) => Promise<PublicMarketPageData | null>;
  listPublicMarketPageSlugs: (
    params?: Readonly<{ limit?: number }>,
  ) => Promise<readonly PublicMarketPageSitemapEntry[]>;
  /** Resolves the display policy directly -- used by the API route to set the public page's Cache-Control TTL. */
  resolveDisplayPolicy: () => Promise<MarketAnalyticsDisplayPolicyValue>;
}>;

export function createPublicMarketPagesRuntime(deps: PublicMarketPagesRuntimeDeps): PublicMarketPagesServices {
  async function resolveDisplayPolicy() {
    return (await deps.policies.resolvePolicy(marketAnalyticsDisplayPolicy)).value;
  }

  return {
    getPublicMarketPage: async (slugOrId) => {
      const [display, statHygiene] = await Promise.all([
        resolveDisplayPolicy(),
        deps.policies.resolvePolicy(marketStatHygienePolicy),
      ]);
      return getPublicMarketPageData(deps.db, slugOrId, {
        historyWindowDays: display.publicPageHistoryWindowDays,
        minimumTradeSample: statHygiene.value.minimumTradeSample,
      });
    },
    listPublicMarketPageSlugs: (params) => listPublicMarketPageSlugs(deps.db, params),
    resolveDisplayPolicy,
  };
}
