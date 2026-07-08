import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { PricingRecommendationServices } from "./runtime";

export type PricingRecommendationMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

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

function recommendationUriParts(uri: string): Readonly<{ catalogItemId: string }> | null {
  const match = /^chase-sets:\/\/pricing\/catalog-items\/([^/]+)\/recommendations$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    catalogItemId: decodeURIComponent(match[1] ?? ""),
  };
}

export function createPricingRecommendationMcpHandlers(
  services: PricingRecommendationServices,
): PricingRecommendationMcpHandlers {
  const recommendPrice: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const catalogItemId = readRequiredString(args, "catalogItemId");
    const result = await services.recommendAccountPrice({
      accountId: scopedActor.accountId,
      catalogItemId,
      limit: readOptionalPositiveInteger(args, "limit", 10),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
    });

    return {
      accountId: scopedActor.accountId,
      catalogItemId,
      items: result.items,
      total: result.total,
      count: result.items.length,
      recommendedPriceAmount: result.items[0]?.recommended_list_amount ?? null,
      recommendationId: result.items[0]?.recommendation_id ?? null,
      resourceUri: `chase-sets://pricing/catalog-items/${encodeURIComponent(catalogItemId)}/recommendations`,
    };
  };

  const explainSignals: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readMcpStringArgument(args, "accountId") ?? actor?.accountId ?? null;
    const scopedActor = ensureMcpActorAccount(actor, accountId);

    return services.explainAccountPricingSignals({
      accountId: scopedActor.accountId,
      catalogItemId: readRequiredString(args, "catalogItemId"),
      productId: readMcpStringArgument(args, "productId"),
    });
  };

  const readRecommendationResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = recommendationUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported pricing recommendation resource URI.");
    }
    if (!actor?.accountId) {
      throw new Error("An account-scoped actor is required.");
    }

    return services.recommendAccountPrice({
      accountId: actor.accountId,
      catalogItemId: parts.catalogItemId,
      limit: 10,
      offset: 0,
    });
  };

  return {
    toolHandlers: {
      "pricing.recommend-price": recommendPrice,
      "pricing.explain-signals": explainSignals,
    },
    resourceHandlers: {
      "chase-sets://pricing/catalog-items/{catalogItemId}/recommendations": readRecommendationResource,
    },
  };
}
