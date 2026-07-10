import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  readOptionalMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { AccountId, ShippingAddressId } from "@chase-sets/primitives/typed-ids";
import type { CartLineId } from "../../../support/runtime-support/common";
import type { CheckoutSelectedListingSnapshotInput } from "../domain/domain";
import type { CheckoutShipFromAddressRow } from "../integrations/identity/identity-queries";
import type { CheckoutCartServices } from "./runtime";
import type { CheckoutSessionServices } from "../../sessions/api/runtime";
import { releaseCheckoutInventoryReservations } from "../../../support/request-support/checkout-confirmation";

export type CheckoutCartMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

export type CheckoutCartMcpServices = Readonly<{
  cart: Pick<
    CheckoutCartServices,
    "addLine" | "listCartLines" | "removeLine" | "setLineFulfillment" | "setLineQuantity"
  >;
  sessions: Pick<CheckoutSessionServices, "cancelSession" | "getSession" | "setShippingAddress">;
  listSavedShippingAddresses: (accountId: string) => Promise<readonly CheckoutShipFromAddressRow[]>;
}>;

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for checkout cart MCP writes yet.");
  }
}

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key)?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function readOptionalString(args: Readonly<Record<string, unknown>>, key: string) {
  return readMcpStringArgument(args, key)?.trim() || null;
}

function readPositiveInteger(args: Readonly<Record<string, unknown>>, key: string) {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return value;
}

function readOptionalPositiveInteger(args: Readonly<Record<string, unknown>>, key: string) {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }

  return readPositiveInteger(args, key);
}

function readSelectedOptions(args: Readonly<Record<string, unknown>>) {
  const raw = args.selectedOptions;
  if (raw === null || raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("selectedOptions must be an array.");
  }

  return raw.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("selectedOptions entries must be objects.");
    }
    const source = entry as Record<string, unknown>;
    return {
      dimensionId: String(source.dimensionId ?? "").trim(),
      optionId: String(source.optionId ?? "").trim(),
    };
  });
}

function readFulfillmentMode(args: Readonly<Record<string, unknown>>) {
  const lockedListingId = readOptionalMcpTypedIdArgument(args, "lockedListingId", "lst");
  const rawMode = readOptionalString(args, "fulfillmentMode");
  if (rawMode && rawMode !== "optimize" && rawMode !== "locked-listing") {
    throw new Error("fulfillmentMode must be optimize or locked-listing.");
  }

  return {
    fulfillmentMode:
      rawMode === "locked-listing" || lockedListingId ? ("locked-listing" as const) : ("optimize" as const),
    lockedListingId,
    sellerPreferenceId: readOptionalString(args, "sellerPreferenceId"),
  };
}

function readAvailabilityState(args: Readonly<Record<string, unknown>>) {
  const availabilityState = readOptionalString(args, "availabilityState");
  if (!availabilityState) {
    return undefined;
  }
  if (
    availabilityState !== "available" &&
    availabilityState !== "unavailable" &&
    availabilityState !== "changed" &&
    availabilityState !== "waiting-for-supply"
  ) {
    throw new Error("availabilityState must be available, unavailable, changed, or waiting-for-supply.");
  }

  return availabilityState;
}

function readSelectedListingSnapshot(
  args: Readonly<Record<string, unknown>>,
): CheckoutSelectedListingSnapshotInput | null {
  const raw = args.selectedListingSnapshot;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const listingIdText = String(source.listingId ?? "").trim();
  if (!listingIdText) {
    return null;
  }
  const listingId = parseTypedIdBoundary(listingIdText, "lst", "selectedListingSnapshot.listingId");

  return {
    listingId,
    sellerAccountId:
      source.sellerAccountId === null || source.sellerAccountId === undefined ? null : String(source.sellerAccountId),
    sellerDisplayName:
      source.sellerDisplayName === null || source.sellerDisplayName === undefined
        ? null
        : String(source.sellerDisplayName),
    sellerSlug: source.sellerSlug === null || source.sellerSlug === undefined ? null : String(source.sellerSlug),
    priceAmount: source.priceAmount === null || source.priceAmount === undefined ? null : String(source.priceAmount),
    source: source.source === null || source.source === undefined ? null : String(source.source),
  };
}

function cartLineReceipt(
  accountId: string,
  result: Readonly<{ lineId: string; version: number }>,
  status: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    accountId,
    id: result.lineId,
    cartLineId: result.lineId,
    version: result.version,
    status,
    resourceUri: `chase-sets://checkout/${encodeURIComponent(accountId)}/cart`,
    ...extra,
  };
}

function shippingAddressFromSavedAddress(address: CheckoutShipFromAddressRow) {
  return {
    shippingAddressId: address.shipping_address_id as ShippingAddressId,
    name: address.recipient_name,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postal_code,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
}

function cartUriParts(uri: string): Readonly<{ accountId: string }> | null {
  const match = /^chase-sets:\/\/checkout\/([^/]+)\/cart$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
  };
}

export function createCheckoutCartMcpHandlers(services: CheckoutCartMcpServices): CheckoutCartMcpHandlers {
  const readCart = async (actor: Parameters<typeof ensureMcpActorAccount>[0], accountId: string | null) => {
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const items = await services.cart.listCartLines(scopedActor.accountId);

    return {
      accountId: scopedActor.accountId,
      items,
      total: items.length,
    };
  };

  const getCart: McpToolHandler = ({ actor, arguments: args }) =>
    readCart(actor, readMcpStringArgument(args, "accountId"));

  const addCartLine: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const fulfillment = readFulfillmentMode(args);
    const result = await services.cart.addLine(
      {
        accountId: scopedActor.accountId as AccountId,
        catalogItemId: readMcpTypedIdArgument(args, "catalogItemId", "cat"),
        productId: readRequiredString(args, "productId"),
        itemTitle: readRequiredString(args, "itemTitle"),
        itemSubtitle: readOptionalString(args, "itemSubtitle"),
        itemImageUrl: readOptionalString(args, "itemImageUrl"),
        itemImageSrcSet: readOptionalString(args, "itemImageSrcSet"),
        itemImageLoadingUrl: readOptionalString(args, "itemImageLoadingUrl"),
        itemImageLoadingAlt: readOptionalString(args, "itemImageLoadingAlt"),
        itemImageLoadingSrcSet: readOptionalString(args, "itemImageLoadingSrcSet"),
        selectedOptions: readSelectedOptions(args),
        productSummary: readOptionalString(args, "productSummary"),
        quantity: readPositiveInteger(args, "quantity"),
        ...fulfillment,
        selectedListingSnapshot: readSelectedListingSnapshot(args),
      },
      createActorEventStoreContext(scopedActor),
    );

    return cartLineReceipt(scopedActor.accountId, result, result.status);
  };

  const updateCartLine: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const lineId = readMcpTypedIdArgument(args, "cartLineId", "cli");
    const quantity = readOptionalPositiveInteger(args, "quantity");
    const updatesFulfillment =
      readOptionalString(args, "fulfillmentMode") !== null ||
      readOptionalString(args, "lockedListingId") !== null ||
      readOptionalString(args, "sellerPreferenceId") !== null ||
      (args.selectedListingSnapshot !== null && args.selectedListingSnapshot !== undefined) ||
      readOptionalString(args, "availabilityState") !== null;

    if (quantity === null && !updatesFulfillment) {
      throw new Error("quantity or fulfillment fields are required.");
    }

    let latest: { lineId: CartLineId; version: number } | null = null;
    const context = createActorEventStoreContext(scopedActor);
    if (quantity !== null) {
      latest = await services.cart.setLineQuantity(
        {
          accountId: scopedActor.accountId as AccountId,
          lineId,
          quantity,
        },
        context,
      );
    }
    if (updatesFulfillment) {
      latest = await services.cart.setLineFulfillment(
        {
          accountId: scopedActor.accountId as AccountId,
          lineId,
          ...readFulfillmentMode(args),
          selectedListingSnapshot: readSelectedListingSnapshot(args),
          availabilityState: readAvailabilityState(args),
        },
        context,
      );
    }

    return cartLineReceipt(scopedActor.accountId, latest ?? { lineId, version: 0 }, "updated", {
      ...(quantity !== null ? { quantity } : {}),
    });
  };

  const removeCartLine: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.cart.removeLine(
      {
        accountId: scopedActor.accountId as AccountId,
        lineId: readMcpTypedIdArgument(args, "cartLineId", "cli"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return cartLineReceipt(scopedActor.accountId, result, "removed");
  };

  const selectSavedAddress: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const sessionId = readMcpTypedIdArgument(args, "sessionId", "chk");
    const shippingAddressId = readMcpTypedIdArgument(args, "shippingAddressId", "adr");
    const savedAddress = (await services.listSavedShippingAddresses(scopedActor.accountId)).find(
      (address) => address.shipping_address_id === shippingAddressId,
    );
    if (!savedAddress) {
      throw new Error("Saved shipping address not found.");
    }

    const result = await services.sessions.setShippingAddress(
      {
        sessionId,
        accountId: scopedActor.accountId as AccountId,
        shippingAddress: shippingAddressFromSavedAddress(savedAddress),
      },
      createActorEventStoreContext(scopedActor),
    );

    return {
      accountId: scopedActor.accountId,
      id: result.sessionId,
      sessionId: result.sessionId,
      shippingAddressId,
      status: "shipping-address-selected",
      resourceUri: `chase-sets://checkout/${encodeURIComponent(scopedActor.accountId)}/sessions/${encodeURIComponent(
        result.sessionId,
      )}`,
      ...(result.commitPosition ? { commitPosition: result.commitPosition } : {}),
      ...(result.commitEventIds ? { commitEventIds: result.commitEventIds } : {}),
      ...(result.commitPositions ? { commitPositions: result.commitPositions } : {}),
    };
  };

  const cancelSession: McpToolHandler = async ({ actor, arguments: args, request }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const sessionId = readMcpTypedIdArgument(args, "sessionId", "chk");
    const session = await services.sessions.getSession(sessionId, scopedActor.accountId);
    if (!session) {
      throw new Error("Checkout session not found.");
    }

    const releasedReservations = await releaseCheckoutInventoryReservations(request, session);
    const result = await services.sessions.cancelSession(
      {
        sessionId,
        accountId: scopedActor.accountId as AccountId,
      },
      createActorEventStoreContext(scopedActor),
    );

    return {
      accountId: scopedActor.accountId,
      id: result.sessionId,
      sessionId: result.sessionId,
      status: result.session.cancelled_at ? "cancelled" : "already-cancelled",
      cancelledAt: result.session.cancelled_at,
      releasedReservationIds: releasedReservations.map((reservation) => reservation.holdId),
      resourceUri: `chase-sets://checkout/${encodeURIComponent(scopedActor.accountId)}/sessions/${encodeURIComponent(
        result.sessionId,
      )}`,
      ...(result.commitPosition ? { commitPosition: result.commitPosition } : {}),
      ...(result.commitEventIds ? { commitEventIds: result.commitEventIds } : {}),
      ...(result.commitPositions ? { commitPositions: result.commitPositions } : {}),
    };
  };

  const readCartResource: McpResourceHandler = ({ actor, uri }) => {
    const parts = cartUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported checkout cart resource URI.");
    }

    return readCart(actor, parts.accountId);
  };

  return {
    toolHandlers: {
      "checkout.get-cart": getCart,
      "checkout.add-cart-line": addCartLine,
      "checkout.update-cart-line": updateCartLine,
      "checkout.remove-cart-line": removeCartLine,
      "checkout.select-saved-address": selectSavedAddress,
      "checkout.cancel-session": cancelSession,
    },
    resourceHandlers: {
      "chase-sets://checkout/{accountId}/cart": readCartResource,
    },
  };
}
