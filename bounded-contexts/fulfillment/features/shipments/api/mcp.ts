import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { PostageAddress, PostagePackage } from "@chase-sets/postage-labels";
import type { EventStoreContext } from "@chase-sets/event-core";
import type { PostageLabelStatus, ShipmentStatus } from "../domain/common";
import {
  assertShipmentActionAllowed,
  executeShipmentAction,
  resolveShipmentActionPlan,
  SHIPMENT_ACTION_RULES,
  type ShipmentActionName,
  type ShipmentLifecycleDispatcher,
} from "../domain/shipment-action";
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

type SellerShipmentActionInput = Readonly<{
  action: ShipmentActionName | "advance";
  shipmentId: string;
  sellerAccountId: string;
  packageCount?: number;
  serviceLevel?: string;
  sender?: PostageAddress | null;
  recipient?: PostageAddress | null;
  overrideReason?: string | null;
  package?: PostagePackage | null;
  exceptionType?: string;
  notes?: string | null;
  mutationAttemptId: string;
}>;

type SellerShipmentActionResult = Readonly<{
  action: ShipmentActionName;
  shipmentId: string;
  version: number;
  status: ShipmentStatus;
  trackingIdentifier?: string;
}>;

async function runSellerShipmentAction(
  services: FulfillmentShipmentServices,
  input: SellerShipmentActionInput,
  context: EventStoreContext,
): Promise<SellerShipmentActionResult> {
  const shipment = await services.getSellerShipment(input.shipmentId, input.sellerAccountId);
  if (!shipment) {
    throw new Error("Shipment not found.");
  }

  const current = {
    status: shipment.status as ShipmentStatus,
    labelStatus: shipment.label_status as PostageLabelStatus,
  };
  const action = input.action === "advance" ? resolveShipmentActionPlan(current).primary : input.action;
  if (!action) {
    throw new Error(`Shipment status ${current.status} has no seller next action.`);
  }
  const resultStatus = SHIPMENT_ACTION_RULES[action].resultsIn;
  const status = resultStatus === "unchanged" ? current.status : resultStatus;

  if (action === "buy-label") {
    assertShipmentActionAllowed(action, current);
    const result = await services.purchaseUspsLabel(
      {
        shipmentId: input.shipmentId,
        sellerAccountId: input.sellerAccountId,
        serviceLevel: input.serviceLevel ?? "USPS_GROUND_ADVANTAGE",
        sender: input.sender,
        recipient: input.recipient,
        overrideReason: input.overrideReason,
        package: input.package,
        mutationAttemptId: input.mutationAttemptId,
      },
      context,
    );
    return { action, status, ...result };
  }

  if (action === "void-label") {
    assertShipmentActionAllowed(action, current);
    return {
      action,
      status,
      ...(await services.voidLabel(
        {
          shipmentId: input.shipmentId,
          sellerAccountId: input.sellerAccountId,
          mutationAttemptId: input.mutationAttemptId,
        },
        context,
      )),
    };
  }

  const dispatcher: ShipmentLifecycleDispatcher = {
    startPacking: () =>
      services.startPackingShipment(
        {
          shipmentId: input.shipmentId,
          sellerAccountId: input.sellerAccountId,
          mutationAttemptId: input.mutationAttemptId,
        },
        context,
      ),
    completePacking: () =>
      services.packShipment(
        {
          shipmentId: input.shipmentId,
          sellerAccountId: input.sellerAccountId,
          packageCount: input.packageCount ?? 1,
          mutationAttemptId: input.mutationAttemptId,
        },
        context,
      ),
    dispatch: () =>
      services.dispatchShipment(
        {
          shipmentId: input.shipmentId,
          sellerAccountId: input.sellerAccountId,
          mutationAttemptId: input.mutationAttemptId,
        },
        context,
      ),
    recordDelivery: () =>
      services.deliverShipment(
        {
          shipmentId: input.shipmentId,
          sellerAccountId: input.sellerAccountId,
          mutationAttemptId: input.mutationAttemptId,
        },
        context,
      ),
    returnShipment: () =>
      services.returnShipment(
        {
          shipmentId: input.shipmentId,
          sellerAccountId: input.sellerAccountId,
          mutationAttemptId: input.mutationAttemptId,
        },
        context,
      ),
    raiseException: () =>
      services.raiseShipmentException(
        {
          shipmentId: input.shipmentId,
          sellerAccountId: input.sellerAccountId,
          exceptionType: input.exceptionType ?? "other",
          notes: input.notes,
          mutationAttemptId: input.mutationAttemptId,
        },
        context,
      ),
  };
  const result = await executeShipmentAction(dispatcher, { action, current });
  return { action, status, ...result };
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
    const result = await runSellerShipmentAction(
      services,
      {
        action: "buy-label",
        shipmentId: readMcpTypedIdArgument(args, "shipmentId", "shp"),
        sellerAccountId: scopedActor.accountId,
        serviceLevel: readMcpStringArgument(args, "serviceLevel") ?? "USPS_GROUND_ADVANTAGE",
        sender: readAddress(args.sender, "sender"),
        recipient: readAddress(args.recipient, "recipient"),
        overrideReason: readMcpStringArgument(args, "overrideReason"),
        package: readPackage(args.package),
        mutationAttemptId: readRequiredString(args, "idempotencyKey"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return shipmentReceipt(scopedActor.accountId, result, result.status, {
      action: result.action,
      trackingIdentifier: result.trackingIdentifier,
    });
  };

  const voidLabel: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "fulfillment.manage");
    const result = await runSellerShipmentAction(
      services,
      {
        action: "void-label",
        shipmentId: readMcpTypedIdArgument(args, "shipmentId", "shp"),
        sellerAccountId: scopedActor.accountId,
        mutationAttemptId: readRequiredString(args, "idempotencyKey"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return shipmentReceipt(scopedActor.accountId, result, result.status, { action: result.action });
  };

  const runSellerAction =
    (action: "advance" | "dispatch" | "raise-exception"): McpToolHandler =>
    async ({ actor, arguments: args }) => {
      rejectDryRun(args);
      const accountId = readRequiredString(args, "accountId");
      const scopedActor = ensureMcpActorAccount(actor, accountId);
      requirePermission(scopedActor, "fulfillment.manage");
      const result = await runSellerShipmentAction(
        services,
        {
          action,
          shipmentId: readMcpTypedIdArgument(args, "shipmentId", "shp"),
          sellerAccountId: scopedActor.accountId,
          packageCount: readOptionalPositiveInteger(args, "packageCount", 1),
          serviceLevel: readMcpStringArgument(args, "serviceLevel") ?? "USPS_GROUND_ADVANTAGE",
          sender: readAddress(args.sender, "sender"),
          recipient: readAddress(args.recipient, "recipient"),
          overrideReason: readMcpStringArgument(args, "overrideReason"),
          package: readPackage(args.package),
          exceptionType: readMcpStringArgument(args, "exceptionType") ?? undefined,
          notes: readMcpStringArgument(args, "notes"),
          mutationAttemptId: readRequiredString(args, "idempotencyKey"),
        },
        createActorEventStoreContext(scopedActor),
      );

      return shipmentReceipt(scopedActor.accountId, result, result.status, {
        action: result.action,
        ...(result.trackingIdentifier ? { trackingIdentifier: result.trackingIdentifier } : {}),
      });
    };

  const getTracking: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "fulfillment.view");
    const shipmentId = readMcpTypedIdArgument(args, "shipmentId", "shp");
    const buyerShipment = await services.getBuyerShipment(shipmentId, scopedActor.accountId);
    const shipment = buyerShipment ?? (await services.getSellerShipment(shipmentId, scopedActor.accountId));
    if (!shipment) {
      throw new Error("Shipment not found.");
    }

    return {
      accountId: scopedActor.accountId,
      shipmentId,
      status: shipment.status,
      carrierName: shipment.carrier_name,
      trackingIdentifier: shipment.tracking_identifier,
      labelStatus: shipment.label_status,
      dispatchedAt: shipment.dispatched_at,
      deliveredAt: shipment.delivered_at,
      returnedAt: shipment.returned_at,
      exceptionRaisedAt: shipment.exception_raised_at,
      currentExceptionType: shipment.current_exception_type,
      currentExceptionNotes: shipment.current_exception_notes,
      providerEvents: shipment.postage_provider_events,
      resourceUri: shipmentResourceUri(scopedActor.accountId, shipmentId),
    };
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
      "fulfillment.get-tracking": getTracking,
      "fulfillment.purchase-label": purchaseLabel,
      "fulfillment.void-label": voidLabel,
      "fulfillment.advance-shipment": runSellerAction("advance"),
      "fulfillment.dispatch-shipment": runSellerAction("dispatch"),
      "fulfillment.raise-shipment-exception": runSellerAction("raise-exception"),
    },
    resourceHandlers: {
      "chase-sets://fulfillment/{accountId}/shipments/{shipmentId}": readShipmentResource,
    },
  };
}
