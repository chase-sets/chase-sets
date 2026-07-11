import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readOptionalMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { ReviewServices } from "./runtime";

export type MarketplaceReviewMcpHandlers = Readonly<{
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

/**
 * Resolves the subject account for a reputation read: `subjectAccountId`
 * (ULID) wins when both are given so existing agent integrations keep
 * working unchanged; `subjectAccountSlug` is the natural-key alternative
 * resolved through the reviews context's own slug mirror
 * (`services.resolveAccountIdBySlug`). Falls back to `fallbackAccountId`
 * (the actor's own account) when neither is supplied.
 */
async function resolveSubjectAccountId(
  services: ReviewServices,
  args: Readonly<Record<string, unknown>>,
  fallbackAccountId: string,
): Promise<string> {
  const subjectAccountId = readOptionalMcpTypedIdArgument(args, "subjectAccountId", "acc");
  if (subjectAccountId) {
    return subjectAccountId;
  }

  const subjectAccountSlug = readMcpStringArgument(args, "subjectAccountSlug");
  if (subjectAccountSlug) {
    const resolvedAccountId = await services.resolveAccountIdBySlug(subjectAccountSlug);
    if (!resolvedAccountId) {
      throw new Error(`No account found for subjectAccountSlug "${subjectAccountSlug}".`);
    }
    return resolvedAccountId;
  }

  return fallbackAccountId;
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

function reputationSummaryUriParts(uri: string): Readonly<{ accountId: string; subjectAccountId: string }> | null {
  const match = /^chase-sets:\/\/marketplace\/([^/]+)\/reputation\/summaries\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    subjectAccountId: decodeURIComponent(match[2] ?? ""),
  };
}

function reviewUriParts(uri: string): Readonly<{ accountId: string; reviewId: string }> | null {
  const match = /^chase-sets:\/\/marketplace\/([^/]+)\/reviews\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    reviewId: decodeURIComponent(match[2] ?? ""),
  };
}

export function createMarketplaceReviewMcpHandlers(services: ReviewServices): MarketplaceReviewMcpHandlers {
  const getReputationSummary: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    ensureMcpActorAccount(actor, accountId);
    const subjectAccountId = await resolveSubjectAccountId(services, args, accountId);
    // `summary` carries both the as-seller and as-buyer dimensions (m108
    // role-split) in one payload; callers pick the role-appropriate fields.
    const summary = await services.getPublicAccountSummary(subjectAccountId);

    return {
      accountId,
      subjectAccountId,
      summary,
    };
  };

  const readRoleArgument = (args: Readonly<Record<string, unknown>>) => {
    const role = readMcpStringArgument(args, "role");
    return role === "seller" || role === "buyer" ? role : undefined;
  };

  const listReviews: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    ensureMcpActorAccount(actor, accountId);
    const side = readMcpStringArgument(args, "side") ?? "received";
    const role = readRoleArgument(args);
    const limit = readOptionalPositiveInteger(args, "limit", 50);
    const offset = readOptionalNonNegativeInteger(args, "offset", 0);

    if (side === "written") {
      const response = await services.listWrittenReviews({ authorAccountId: accountId, role, limit, offset });
      return { accountId, side, ...response, count: response.items.length };
    }

    if (side === "received") {
      const response = await services.listReceivedReviews({ subjectAccountId: accountId, role, limit, offset });
      return { accountId, side, ...response, count: response.items.length };
    }

    if (side === "public") {
      const subjectAccountId = await resolveSubjectAccountId(services, args, accountId);
      const response = await services.listPublicAccountReviews({ accountId: subjectAccountId, role, limit, offset });
      return { accountId, subjectAccountId, side, ...response, count: response.items.length };
    }

    throw new Error("side must be written, received, or public.");
  };

  const readReputationSummaryResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = reputationSummaryUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported marketplace reputation summary resource URI.");
    }

    ensureMcpActorAccount(actor, parts.accountId);
    return services.getPublicAccountSummary(parts.subjectAccountId);
  };

  const readReviewResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = reviewUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported marketplace review resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    const review = await services.getAccountReview(parts.reviewId, scopedActor.accountId);
    if (!review) {
      throw new Error("Review not found.");
    }

    return review;
  };

  return {
    toolHandlers: {
      "marketplace.get-reputation-summary": getReputationSummary,
      "marketplace.list-reviews": listReviews,
    },
    resourceHandlers: {
      "chase-sets://marketplace/{accountId}/reputation/summaries/{subjectAccountId}": readReputationSummaryResource,
      "chase-sets://marketplace/{accountId}/reviews/{reviewId}": readReviewResource,
    },
  };
}
