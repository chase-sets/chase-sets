import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  getPublicMarketPageData,
  listPublicMarketPageSlugs,
  type PublicMarketPageData,
  type PublicMarketPageSitemapEntry,
} from "../read-model/queries";

type PublicMarketPagesRuntimeDeps = Readonly<{
  db: PgQueryable;
}>;

export type PublicMarketPagesServices = Readonly<{
  getPublicMarketPage: (slugOrId: string) => Promise<PublicMarketPageData | null>;
  listPublicMarketPageSlugs: (
    params?: Readonly<{ limit?: number }>,
  ) => Promise<readonly PublicMarketPageSitemapEntry[]>;
}>;

export function createPublicMarketPagesRuntime(deps: PublicMarketPagesRuntimeDeps): PublicMarketPagesServices {
  return {
    getPublicMarketPage: (slugOrId) => getPublicMarketPageData(deps.db, slugOrId),
    listPublicMarketPageSlugs: (params) => listPublicMarketPageSlugs(deps.db, params),
  };
}
