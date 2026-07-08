import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { AccountId, ListingId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceListingPurchaseLimits } from "../domain/domain";
import type { MarketplaceListingServices } from "./runtime";

export type MarketplaceListingMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for marketplace listing MCP writes yet.");
  }
}

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function readOptionalPositiveIntegerArgument(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
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

function readPositiveInteger(args: Readonly<Record<string, unknown>>, key: string) {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return value;
}

function readOptionalPositiveInteger(value: unknown, key: string) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return numeric;
}

function readPurchaseLimits(args: Readonly<Record<string, unknown>>): Partial<MarketplaceListingPurchaseLimits> | null {
  const raw = args.purchaseLimits;
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("purchaseLimits must be an object.");
  }

  const limits = raw as Readonly<Record<string, unknown>>;
  return {
    maxUnitsPerOrder: readOptionalPositiveInteger(limits.maxUnitsPerOrder, "purchaseLimits.maxUnitsPerOrder"),
    maxUnitsPerDay: readOptionalPositiveInteger(limits.maxUnitsPerDay, "purchaseLimits.maxUnitsPerDay"),
    maxUnitsPerCustomerAccount: readOptionalPositiveInteger(
      limits.maxUnitsPerCustomerAccount,
      "purchaseLimits.maxUnitsPerCustomerAccount",
    ),
  };
}

function listingUriParts(uri: string): Readonly<{ accountId: string; listingId: string }> | null {
  const match = /^chase-sets:\/\/marketplace\/([^/]+)\/listings\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    listingId: decodeURIComponent(match[2] ?? ""),
  };
}

function listingReceipt(
  accountId: string,
  result: Readonly<{ listingId: string; version: number }>,
  status: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    accountId,
    id: result.listingId,
    listingId: result.listingId,
    version: result.version,
    status,
    resourceUri: `chase-sets://marketplace/${encodeURIComponent(accountId)}/listings/${encodeURIComponent(
      result.listingId,
    )}`,
    ...extra,
  };
}

export function createMarketplaceListingMcpHandlers(
  services: MarketplaceListingServices,
): MarketplaceListingMcpHandlers {
  const listListings: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const response = await services.listSellerListings({
      accountId: scopedActor.accountId,
      limit: readOptionalPositiveIntegerArgument(args, "limit", 50),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
    });

    return {
      accountId: scopedActor.accountId,
      items: response.items,
      total: response.total,
      count: response.items.length,
    };
  };

  const getSellerInsights: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const limit = readOptionalPositiveIntegerArgument(args, "limit", 25);
    const offset = readOptionalNonNegativeInteger(args, "offset", 0);
    const [availability, listings, feeLockReport, supply] = await Promise.all([
      services.getSellerListingAvailability(scopedActor.accountId),
      services.listSellerListings({ accountId: scopedActor.accountId, limit, offset }),
      services.listSellerListingFeeLockReport({ accountId: scopedActor.accountId, limit, offset }),
      services.listSellerInventoryItemSupply({
        accountId: scopedActor.accountId,
        catalogItemId: readMcpStringArgument(args, "catalogItemId") ?? undefined,
        limit,
        offset,
      }),
    ]);

    return {
      accountId: scopedActor.accountId,
      availability,
      listings: {
        items: listings.items,
        total: listings.total,
        count: listings.items.length,
      },
      feeLockReport: {
        items: feeLockReport.items,
        total: feeLockReport.total,
        count: feeLockReport.items.length,
      },
      supply: {
        items: supply.items,
        total: supply.total,
        count: supply.items.length,
      },
    };
  };

  const createListing: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.createListing(
      {
        accountId: scopedActor.accountId as AccountId,
        inventoryItemId: readRequiredString(args, "inventoryItemId"),
        priceAmount: readRequiredString(args, "priceAmount"),
        quantityCap: readPositiveInteger(args, "quantityCap"),
        purchaseLimits: readPurchaseLimits(args),
        listingIdOverride: readMcpStringArgument(args, "listingIdOverride") as ListingId,
      },
      createActorEventStoreContext(scopedActor),
    );

    return listingReceipt(scopedActor.accountId, result, "draft", {
      inventoryItemId: readRequiredString(args, "inventoryItemId"),
      feeQuoteFingerprint: result.feeQuoteFingerprint,
    });
  };

  const updateListingPrice: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.updateListingPrice(
      {
        accountId: scopedActor.accountId,
        listingId: readRequiredString(args, "listingId"),
        priceAmount: readRequiredString(args, "priceAmount"),
        feeQuoteFingerprint: readMcpStringArgument(args, "feeQuoteFingerprint"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return listingReceipt(scopedActor.accountId, result, "price-updated");
  };

  const publishListing: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.publishListing(
      {
        accountId: scopedActor.accountId,
        listingId: readRequiredString(args, "listingId"),
        feeQuoteFingerprint: readMcpStringArgument(args, "feeQuoteFingerprint"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return listingReceipt(scopedActor.accountId, result, "published");
  };

  const unpublishListing: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.pauseListing(
      {
        accountId: scopedActor.accountId,
        listingId: readRequiredString(args, "listingId"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return listingReceipt(scopedActor.accountId, result, "unpublished");
  };

  const readListingResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = listingUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported marketplace listing resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    const listing = await services.getSellerListing(parts.listingId, scopedActor.accountId);
    if (!listing) {
      throw new Error("Listing not found.");
    }

    return listing;
  };

  return {
    toolHandlers: {
      "marketplace.list-listings": listListings,
      "marketplace.get-seller-insights": getSellerInsights,
      "marketplace.create-listing": createListing,
      "marketplace.update-listing-price": updateListingPrice,
      "marketplace.publish-listing": publishListing,
      "marketplace.unpublish-listing": unpublishListing,
    },
    resourceHandlers: {
      "chase-sets://marketplace/{accountId}/listings/{listingId}": readListingResource,
    },
  };
}
