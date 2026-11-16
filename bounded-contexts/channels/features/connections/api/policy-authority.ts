import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { tcgplayerStagedImportPolicy } from "../../tcgplayer-csv/domain/policy";
import type { ChannelPolicyAuthorityResolver } from "../domain/contracts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { resolveEbaySetupPolicy } from "../../ebay-connection/read-model/setup-selection";

export function createConnectionPolicyAuthority(
  policies: Pick<PolicyRuntime, "resolvePolicy" | "getPolicyDocument">,
  db?: PgQueryable,
): ChannelPolicyAuthorityResolver {
  return {
    resolve: async (input) => {
      const { policyKey } = input;
      const incomplete = { policyKey, revision: 0, status: "incomplete" as const };
      if (["ebay.fulfillment", "ebay.payment", "ebay.return"].includes(policyKey) && db) {
        try {
          return await resolveEbaySetupPolicy(db, input);
        } catch {
          return incomplete;
        }
      }
      if (policyKey !== tcgplayerStagedImportPolicy.policyKey) return incomplete;
      try {
        const resolved = await policies.resolvePolicy(tcgplayerStagedImportPolicy);
        if (resolved.documentId === null) return { policyKey, revision: 0, status: "complete" };
        const document = await policies.getPolicyDocument(resolved.documentId);
        if (!document?.history) return incomplete;
        return { policyKey, revision: document.history.length, status: "complete" };
      } catch {
        return incomplete;
      }
    },
  };
}
