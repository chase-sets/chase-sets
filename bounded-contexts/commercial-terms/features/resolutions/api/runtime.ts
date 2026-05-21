import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createCommercialTermsResolver, type ResolvedCommercialTerms } from "../read-model/resolve";

type ResolutionRuntimeDeps = Readonly<{
  db: PgQueryable;
}>;

export type ResolutionServices = Readonly<{
  previewListingTerms: (
    params: Readonly<{
      accountId: string;
      amount: string;
      effectiveAt?: string;
    }>,
  ) => Promise<ResolvedCommercialTerms>;
  previewOrderTerms: (
    params: Readonly<{
      accountId: string;
      amount: string;
      effectiveAt?: string;
    }>,
  ) => Promise<ResolvedCommercialTerms>;
}>;

export function createResolutionRuntime(deps: ResolutionRuntimeDeps): ResolutionServices {
  const resolver = createCommercialTermsResolver({ db: deps.db });

  return {
    previewListingTerms: (params) => resolver.resolveListingTerms(params),
    previewOrderTerms: (params) => resolver.resolveOrderTerms(params),
  };
}
