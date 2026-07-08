import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { PostageAddress, PostagePackage } from "@chase-sets/postage-labels";
import type { FulfillmentShipmentServices } from "./runtime";

export type FulfillmentShipmentMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type ShipmentSide = "buyer" | "seller";

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for fulfillment shipment MCP writes yet.");
  }
}

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

function readSide(args: Readonly<Record<string, unknown>>, fallback: ShipmentSide): ShipmentSide {
  const side = readMcpStringArgument(args, "side") ?? fallback;
  if (side === "purchase") {
    return "buyer";
  }
  if (side === "sale") {
    return "seller";
  }
  if (side !== "buyer" && side !== "seller") {
    throw new Error("side must be purchase or sale.");
  }

  return side;
}

function requirePermission(actor: Readonly<{ permissions: readonly string[] }>, permission: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
}

function readAddressValue(source: Readonly<Record<string, unknown>>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readAddress(source: unknown, key: string): PostageAddress | null {
  if (source === null || source === undefined) {
    return null;
  }
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${key} must be an object.`);
  }

  const address = source as Readonly<Record<string, unknown>>;
  return {
    name: String(address.name ?? ""),
    company: readAddressValue(address, "company"),
    street1: String(address.street1 ?? address.line1 ?? ""),
    street2: readAddressValue(address, "street2") ?? readAddressValue(address, "line2"),
    city: String(address.city ?? ""),
    state: String(address.state ?? ""),
    postalCode: String(address.postalCode ?? ""),
    country: String(address.country ?? "US"),
    phone: readAddressValue(address, "phone"),
    email: readAddressValue(address, "email"),
  };
}

function readPackage(source: unknown): PostagePackage | null {
  if (source === null || source === undefined) {
    return null;
  }
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error("package must be an object.");
  }

  const packageInput = source as Readonly<Record<string, unknown>>;
  return {
    lengthInches: Number(packageInput.lengthInches),
    widthInches: Number(packageInput.widthInches),
    heightInches: Number(packageInput.heightInches),
    weightOunces: Number(packageInput.weightOunces),
  };
}

function shipmentUriParts(uri: string): Readonly<{ accountId: string; shipmentId: string }> | null {
  const match = /^chase-sets:\/\/fulfillment\/([^/]+)\/shipments\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    shipmentId: decodeURIComponent(match[2] ?? ""),
  };
}

function shipmentResourceUri(accountId: string, shipmentId: string) {
  return `chase-sets://fulfillment/${encodeURIComponent(accountId)}/shipments/${encodeURIComponent(shipmentId)}`;
}

function shipmentReceipt(
  accountId: string,
  result: Readonly<{ shipmentId: string; version: number }>,
  status: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    accountId,
    id: result.shipmentId,
    shipmentId: result.shipmentId,
    version: result.version,
    status,
    resourceUri: shipmentResourceUri(accountId, result.shipmentId),
    ...extra,
  };
}

export function createFulfillmentShipmentMcpHandlers(
  services: FulfillmentShipmentServices,
): FulfillmentShipmentMcpHandlers {
  const listShipments: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "fulfillment.view");
    const side = readSide(args, "buyer");
    const params = {
      limit: readOptionalPositiveInteger(args, "limit", 50),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
    };
    const result =
      side === "seller"
        ? await services.listSellerShipments({ sellerAccountId: scopedActor.accountId, ...params })
        : await services.listBuyerShipments({ buyerAccountId: scopedActor.accountId, ...params });

    return {
      accountId: scopedActor.accountId,
      side: side === "seller" ? "sale" : "purchase",
      items: result.items,
      total: result.total,
      count: result.items.length,
    };
  };

  const purchaseLabel: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "fulfillment.manage");
    const result = await services.purchaseUspsLabel(
      {
        shipmentId: readRequiredString(args, "shipmentId"),
        sellerAccountId: scopedActor.accountId,
        serviceLevel: readMcpStringArgument(args, "serviceLevel") ?? "USPS_GROUND_ADVANTAGE",
        sender: readAddress(args.sender, "sender"),
        recipient: readAddress(args.recipient, "recipient"),
        overrideReason: readMcpStringArgument(args, "overrideReason"),
        package: readPackage(args.package),
      },
      createActorEventStoreContext(scopedActor),
    );

    return shipmentReceipt(scopedActor.accountId, result, "label-attached", {
      trackingIdentifier: result.trackingIdentifier,
    });
  };

  const voidLabel: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "fulfillment.manage");
    const result = await services.voidLabel(
      {
        shipmentId: readRequiredString(args, "shipmentId"),
        sellerAccountId: scopedActor.accountId,
      },
      createActorEventStoreContext(scopedActor),
    );

    return shipmentReceipt(scopedActor.accountId, result, "label-voided");
  };

  const readShipmentResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = shipmentUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported fulfillment shipment resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    requirePermission(scopedActor, "fulfillment.view");
    const buyerShipment = await services.getBuyerShipment(parts.shipmentId, scopedActor.accountId);
    if (buyerShipment) {
      return buyerShipment;
    }

    const sellerShipment = await services.getSellerShipment(parts.shipmentId, scopedActor.accountId);
    if (sellerShipment) {
      return sellerShipment;
    }

    throw new Error("Shipment not found.");
  };

  return {
    toolHandlers: {
      "fulfillment.list-shipments": listShipments,
      "fulfillment.purchase-label": purchaseLabel,
      "fulfillment.void-label": voidLabel,
    },
    resourceHandlers: {
      "chase-sets://fulfillment/{accountId}/shipments/{shipmentId}": readShipmentResource,
    },
  };
}
