import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listCommercialTermsEffectiveDateAttention } from "../read-model/queries";

export function createCommercialTermsAttentionRuntime(db: PgQueryable) {
  return {
    list: () => listCommercialTermsEffectiveDateAttention(db),
  };
}
