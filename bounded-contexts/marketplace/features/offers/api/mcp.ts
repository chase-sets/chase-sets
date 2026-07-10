import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  readOptionalMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, OfferId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceOfferServices } from "./runtime";
import { omitPrivateOfferResponseFields, publicOfferListResponse } from "./response-shape";

export type MarketplaceOfferMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for marketplace offer MCP writes yet.");
  }
}

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function readRequiredPositiveInteger(args: Readonly<Record<string, unknown>>, key: string) {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
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

function readVersionSelection(args: Readonly<Record<string, unknown>>) {
  const value = args.selectedOptions;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((selection): selection is Readonly<Record<string, unknown>> =>
      Boolean(selection && typeof selection === "object" && !Array.isArray(selection)),
    )
    .map((selection) => ({
      dimensionId: String(selection.dimensionId ?? ""),
      optionId: String(selection.optionId ?? ""),
    }));
}

function readShippingDestination(args: Readonly<Record<string, unknown>>): AddressSnapshot {
  const source =
    args.shippingDestinationSnapshot && typeof args.shippingDestinationSnapshot === "object"
      ? (args.shippingDestinationSnapshot as Readonly<Record<string, unknown>>)
      : {};

  return {
    name: String(source.name ?? ""),
    company: source.company == null ? null : String(source.company),
    line1: String(source.line1 ?? ""),
    line2: source.line2 == null ? null : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
    phone: source.phone == null ? null : String(source.phone),
    email: source.email == null ? null : String(source.email),
  };
}

function requirePermission(actor: Readonly<{ permissions: readonly string[] }>, permission: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
}

function offerUriParts(uri: string): Readonly<{ accountId: string; offerId: string }> | null {
  const match = /^chase-sets:\/\/marketplace\/([^/]+)\/offers\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    offerId: decodeURIComponent(match[2] ?? ""),
  };
}

function offerReceipt(
  accountId: string,
  result: Readonly<{ offerId: string; version: number }>,
  status: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    accountId,
    id: result.offerId,
    offerId: result.offerId,
    version: result.version,
    status,
    resourceUri: `chase-sets://marketplace/${encodeURIComponent(accountId)}/offers/${encodeURIComponent(
      result.offerId,
    )}`,
    ...extra,
  };
}

export function createMarketplaceOfferMcpHandlers(services: MarketplaceOfferServices): MarketplaceOfferMcpHandlers {
  const writeSubmittedOffer = async (
    actor: Parameters<typeof ensureMcpActorAccount>[0],
    args: Readonly<Record<string, unknown>>,
  ) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.submitOffer(
      {
        offerId: readOptionalMcpTypedIdArgument(args, "offerIdOverride", "off") ?? undefined,
        buyerAccountId: scopedActor.accountId as AccountId,
        catalogItemId: readMcpTypedIdArgument(args, "catalogItemId", "cat"),
        productId: readRequiredString(args, "productId"),
        itemTitle: readRequiredString(args, "itemTitle"),
        itemSubtitle: readMcpStringArgument(args, "itemSubtitle"),
        selectedOptions: readVersionSelection(args),
        productSummary: readMcpStringArgument(args, "productSummary"),
        shippingDestinationSnapshot: readShippingDestination(args),
        priceAmount: readRequiredString(args, "priceAmount"),
        quantityRequested: readRequiredPositiveInteger(args, "quantityRequested"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return offerReceipt(scopedActor.accountId, result, "submitted", {
      catalogItemId: readMcpTypedIdArgument(args, "catalogItemId", "cat"),
      productId: readRequiredString(args, "productId"),
    });
  };

  const submitOffer: McpToolHandler = async ({ actor, arguments: args }) => writeSubmittedOffer(actor, args);

  const counterOffer: McpToolHandler = async ({ actor, arguments: args }) => {
    const counteredOfferId = readMcpTypedIdArgument(args, "counteredOfferId", "off");
    const result = await writeSubmittedOffer(actor, args);

    return {
      ...(result as Record<string, unknown>),
      status: "countered",
      counteredOfferId,
    };
  };

  const acceptOffer: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "listings.view");
    const result = await services.acceptOffer(
      {
        offerId: readMcpTypedIdArgument(args, "offerId", "off"),
        sellerAccountId: scopedActor.accountId as AccountId,
        feeQuoteFingerprint: readMcpStringArgument(args, "feeQuoteFingerprint"),
        sourceActionKey: readMcpStringArgument(args, "sourceActionKey"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return offerReceipt(scopedActor.accountId, result, "accepted");
  };

  const declineOffer: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "listings.view");
    const result = await services.declineOfferMatch(
      {
        offerId: readMcpTypedIdArgument(args, "offerId", "off"),
        sellerAccountId: scopedActor.accountId as AccountId,
      },
      createActorEventStoreContext(scopedActor),
    );

    return offerReceipt(scopedActor.accountId, result, "declined");
  };

  const listOffers: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const side = readMcpStringArgument(args, "side") ?? "submitted";
    const limit = readOptionalPositiveInteger(args, "limit", 50);
    const offset = readOptionalNonNegativeInteger(args, "offset", 0);

    if (side === "matched") {
      requirePermission(scopedActor, "listings.view");
      const productIds = String(args.productIds ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const response = publicOfferListResponse(
        await services.listOfferMatches({
          sellerAccountId: scopedActor.accountId,
          limit,
          offset,
          productIds,
          status: readMcpStringArgument(args, "status") === "submitted" ? "submitted" : undefined,
          canFulfill: args.canFulfill === true ? true : undefined,
        }),
      );

      return {
        accountId: scopedActor.accountId,
        side,
        ...response,
        count: response.items.length,
      };
    }

    if (side !== "submitted") {
      throw new Error("side must be submitted or matched.");
    }

    const response = publicOfferListResponse(
      await services.listSubmittedOffers({
        buyerAccountId: scopedActor.accountId,
        limit,
        offset,
      }),
    );

    return {
      accountId: scopedActor.accountId,
      side,
      ...response,
      count: response.items.length,
    };
  };

  const readOfferResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = offerUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported marketplace offer resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    const submittedOffer = await services.getSubmittedOffer(parts.offerId, scopedActor.accountId);
    if (submittedOffer) {
      return omitPrivateOfferResponseFields(submittedOffer);
    }

    if (scopedActor.permissions.includes("listings.view")) {
      const matchedOffer = await services.getOfferMatch(parts.offerId, scopedActor.accountId);
      if (matchedOffer) {
        return omitPrivateOfferResponseFields(matchedOffer);
      }
    }

    throw new Error("Offer not found.");
  };

  return {
    toolHandlers: {
      "marketplace.submit-offer": submitOffer,
      "marketplace.counter-offer": counterOffer,
      "marketplace.accept-offer": acceptOffer,
      "marketplace.decline-offer": declineOffer,
      "marketplace.list-offers": listOffers,
    },
    resourceHandlers: {
      "chase-sets://marketplace/{accountId}/offers/{offerId}": readOfferResource,
    },
  };
}
