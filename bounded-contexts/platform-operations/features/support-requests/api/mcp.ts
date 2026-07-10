import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { SupportRequestServices } from "./runtime";

export type SupportRequestMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type SupportSide = "buyer" | "seller";

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function readOptionalPositiveInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return value;
}

function readOptionalNonNegativeInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }

  return value;
}

function readSide(args: Readonly<Record<string, unknown>>, fallback: SupportSide): SupportSide {
  const side = readMcpStringArgument(args, "side") ?? fallback;
  if (side !== "buyer" && side !== "seller") {
    throw new Error("side must be buyer or seller.");
  }

  return side;
}

function requirePermission(actor: Readonly<{ permissions: readonly string[] }>, permission: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
}

function supportRequestUriParts(uri: string): Readonly<{ accountId: string; supportRequestId: string }> | null {
  const match = /^chase-sets:\/\/platform-operations\/([^/]+)\/support-requests\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    supportRequestId: decodeURIComponent(match[2] ?? ""),
  };
}

async function readSupportRequest(
  services: Pick<SupportRequestServices, "getAccountSupportRequest">,
  accountId: string,
  supportRequestId: string,
  actor: Parameters<typeof ensureMcpActorAccount>[0],
) {
  const scopedActor = ensureMcpActorAccount(actor, accountId);
  requirePermission(scopedActor, "support.view");
  const supportRequest = await services.getAccountSupportRequest(supportRequestId, scopedActor.accountId);
  if (!supportRequest) {
    throw new Error("Support request not found.");
  }

  return {
    accountId: scopedActor.accountId,
    supportRequest,
    status: {
      supportRequestId: supportRequest.support_request_id,
      orderId: supportRequest.order_id,
      flowType: supportRequest.flow_type,
      status: supportRequest.status,
      priority: supportRequest.priority,
      pendingOffer: supportRequest.pending_offer,
      resolution: supportRequest.resolution,
      closedAt: supportRequest.closed_at,
      cancellationReason: supportRequest.cancellation_reason,
    },
  };
}

export function createSupportRequestMcpHandlers(
  services: Pick<
    SupportRequestServices,
    "listBuyerSupportRequests" | "listSellerSupportRequests" | "getAccountSupportRequest"
  >,
): SupportRequestMcpHandlers {
  const listSupportRequests: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "support.view");
    const side = readSide(args, "buyer");
    const params = {
      limit: readOptionalPositiveInteger(args, "limit", 50),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
    };
    const result =
      side === "seller"
        ? await services.listSellerSupportRequests({ sellerAccountId: scopedActor.accountId, ...params })
        : await services.listBuyerSupportRequests({ buyerAccountId: scopedActor.accountId, ...params });

    return {
      accountId: scopedActor.accountId,
      side,
      items: result.items,
      total: result.total,
      count: result.items.length,
    };
  };

  const getSupportRequest: McpToolHandler = ({ actor, arguments: args }) =>
    readSupportRequest(
      services,
      readRequiredString(args, "accountId"),
      readMcpTypedIdArgument(args, "supportRequestId", "sup"),
      actor,
    );

  const readSupportRequestResource: McpResourceHandler = ({ actor, uri }) => {
    const parts = supportRequestUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported support request resource URI.");
    }

    return readSupportRequest(services, parts.accountId, parts.supportRequestId, actor);
  };

  return {
    toolHandlers: {
      "platform-operations.list-support-requests": listSupportRequests,
      "platform-operations.get-support-request": getSupportRequest,
    },
    resourceHandlers: {
      "chase-sets://platform-operations/{accountId}/support-requests/{supportRequestId}": readSupportRequestResource,
    },
  };
}
