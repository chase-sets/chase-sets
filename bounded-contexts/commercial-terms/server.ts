import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createCommercialTermsResolver,
  createNoopCommercialTermsResolver,
} from "./features/resolutions/read-model/resolve";

export type { CommercialTermsResolver, ResolvedCommercialTerms } from "./features/resolutions/read-model/resolve";
export type { CommercialTermsAccountSource } from "./features/resolutions/read-model/resolve";

export function createCommercialTermsServer(deps: Readonly<{ db: PgQueryable }>) {
  return createCommercialTermsResolver(deps);
}

export { createCommercialTermsResolver, createNoopCommercialTermsResolver };
