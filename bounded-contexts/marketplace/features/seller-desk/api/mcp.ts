import { ensureMcpActorAccount, readMcpStringArgument, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { SellerAttentionQueuePort } from "../read-model/runtime";

const SELLER_ATTENTION_PERMISSIONS = [
  "inventory.view",
  "listings.view",
  "offers.view",
  "fulfillment.view",
  "payouts.view",
] as const;

export type SellerDeskMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
}>;

function requireSellerAttentionPermissions(actor: Readonly<{ permissions: readonly string[] }>) {
  const missing = SELLER_ATTENTION_PERMISSIONS.filter((permission) => !actor.permissions.includes(permission));
  if (missing.length > 0) {
    throw new Error(`Missing required permissions: ${missing.join(", ")}.`);
  }
}

export function createSellerDeskMcpHandlers(
  queue: SellerAttentionQueuePort,
  now: () => string = () => new Date().toISOString(),
): SellerDeskMcpHandlers {
  const getSellerAttentionQueue: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readMcpStringArgument(args, "accountId");
    if (!accountId) {
      throw new Error("accountId is required.");
    }

    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requireSellerAttentionPermissions(scopedActor);
    return queue.loadQueue({ accountId: scopedActor.accountId, now: now() });
  };

  return {
    toolHandlers: {
      "marketplace.get-seller-attention-queue": getSellerAttentionQueue,
    },
  };
}
