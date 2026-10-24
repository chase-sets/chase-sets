import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { getAccount } from "../read-model/queries";
import { createIdentityPaymentsTermsAcceptanceResolver } from "../../consents/api/terms-acceptance-resolver";

export function createIdentityWalletFundingEligibilityResolver(pool: PgTransactionalPool) {
  const terms = createIdentityPaymentsTermsAcceptanceResolver(pool);
  return {
    async resolve(accountId: AccountId) {
      const account = await getAccount(pool, accountId);
      const acceptance = await terms.resolvePaymentsTermsAcceptanceStatus({ accountId });
      return {
        goodStanding: account?.status === "active",
        paymentsTerms:
          acceptance.evaluation === "not-active"
            ? ("not-active" as const)
            : acceptance.acceptance?.accepted === true
              ? ("accepted" as const)
              : ("unaccepted" as const),
      };
    },
  };
}
