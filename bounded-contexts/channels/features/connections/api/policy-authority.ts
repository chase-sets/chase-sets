import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { tcgplayerStagedImportPolicy } from "../../tcgplayer-csv/domain/policy";
import type { ChannelPolicyAuthorityResolver } from "../domain/contracts";

export function createConnectionPolicyAuthority(
  policies: Pick<PolicyRuntime, "resolvePolicy" | "getPolicyDocument">,
): ChannelPolicyAuthorityResolver {
  return {
    resolve: async ({ policyKey }) => {
      const incomplete = { policyKey, revision: 0, status: "incomplete" as const };
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
