import { t } from "@chase-sets/localization";
import { createPolicyBackedRateLimiter, type RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { Hono } from "hono";
import type { CollectionsApiEnv } from "../../../api";
import type {
  AddProductToSavedListRequest,
  CreateAnonymousSavedListIntentRequest,
  SavedListDestination,
  SavedListDiscoverySurface,
} from "./discovery-contracts";
import { SavedListDiscoveryError, type SavedListDiscoveryServices } from "./discovery-runtime";
import type { SavedListProductSelection } from "../domain/contracts";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

const CAPTURE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const CAPTURE_RATE_LIMIT_MAX = 30;
const CAPTURE_RATE_LIMIT_SURFACE = "collections.saved-list.anonymous-capture";

export function createSavedListRoutes(
  services: SavedListDiscoveryServices,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<CollectionsApiEnv>();
  const captureRateLimiter = createPolicyBackedRateLimiter(
    CAPTURE_RATE_LIMIT_SURFACE,
    { max: CAPTURE_RATE_LIMIT_MAX, windowMs: CAPTURE_RATE_LIMIT_WINDOW_MS },
    resolveRateLimitRule ?? (async (_surface, defaults) => defaults),
    { keyPrefix: "collections:anonymous-saved-list-capture" },
  );

  app.get("/account/lists/recent", async (c) => {
    const access = requireAccess(c);
    if (access.response) return access.response;
    const items = await services.listRecent(access.actor.accountId as AccountId);
    return c.json({ items, count: items.length });
  });

  app.post("/account/list-additions", async (c) => {
    const access = requireAccess(c);
    if (access.response) return access.response;
    const context = c.get("context");
    if (!context) return missingContextResponse();
    const body = await c.req.json().catch(() => ({}));
    try {
      const request = parseAdditionRequest(body);
      return c.json(
        await services.addProduct({ ...request, ownerAccountId: access.actor.accountId as AccountId }, context),
      );
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.post("/guest/saved-list-intents", async (c) => {
    const anonymousOwnerId = readAnonymousOwnerId(c.req.header("x-collections-anonymous-saved-list-id"));
    if (!anonymousOwnerId) {
      return c.json(
        {
          error: {
            code: "anonymous_saved_list_required",
            message: t("collections.features.savedLists.api.route.anonymous.owner.required"),
          },
        },
        400,
      );
    }
    const rateLimit = await captureRateLimiter.check(c.req.raw);
    if (rateLimit.limited) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: t("collections.features.savedLists.api.route.rate.limited"),
          },
        },
        429,
        { "Retry-After": String(rateLimit.retryAfterSeconds) },
      );
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const request: CreateAnonymousSavedListIntentRequest = {
        sourcePath: String(body.sourcePath ?? ""),
        sourceSurface: parseSurface(body.sourceSurface),
        product: parseProduct(body.product),
        productSummary: body.productSummary == null ? null : String(body.productSummary),
      };
      return c.json(
        {
          intent: await services.createAnonymousIntent({ ...request, anonymousOwnerId }),
          analyticsLabel: "saved-list.guest-intent-created" as const,
        },
        201,
      );
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get("/account/saved-list-intents/:id", async (c) => {
    const access = requireAccess(c);
    if (access.response) return access.response;
    const anonymousOwnerId = readAnonymousOwnerId(c.req.header("x-collections-anonymous-saved-list-id"));
    if (!anonymousOwnerId) {
      return c.json(
        {
          error: {
            code: "anonymous_saved_list_required",
            message: t("collections.features.savedLists.api.route.anonymous.owner.required"),
          },
        },
        400,
      );
    }
    try {
      return c.json(
        await services.prepareAnonymousClaim({
          anonymousOwnerId,
          intentId: c.req.param("id"),
          accountId: access.actor.accountId as AccountId,
        }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.post("/account/saved-list-intents/:id/claim", async (c) => {
    const access = requireAccess(c);
    if (access.response) return access.response;
    const context = c.get("context");
    if (!context) return missingContextResponse();
    const anonymousOwnerId = readAnonymousOwnerId(c.req.header("x-collections-anonymous-saved-list-id"));
    if (!anonymousOwnerId) {
      return c.json(
        {
          error: {
            code: "anonymous_saved_list_required",
            message: t("collections.features.savedLists.api.route.anonymous.owner.required"),
          },
        },
        400,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(
        await services.claimAnonymousIntent(
          {
            anonymousOwnerId,
            intentId: c.req.param("id"),
            accountId: access.actor.accountId as AccountId,
            destination: parseDestination(body.destination),
            trackedQuantity: Number(body.trackedQuantity),
            sourceSurface: parseSurface(body.sourceSurface),
          },
          context,
        ),
      );
    } catch (error) {
      return errorResponse(error);
    }
  });

  return app;
}

function requireAccess(c: { get(key: "actor"): CollectionsApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: Response.json(
        {
          error: {
            code: "authentication_required",
            message: t("collections.features.savedLists.api.route.sign.in.required"),
          },
        },
        { status: 401 },
      ),
    };
  }
  if (!actor.permissions.includes("accounts.view")) {
    return {
      actor: null,
      response: Response.json(
        {
          error: {
            code: "authorization_forbidden",
            message: t("collections.features.savedLists.api.route.account.forbidden"),
          },
        },
        { status: 403 },
      ),
    };
  }
  return { actor, response: null };
}

function missingContextResponse() {
  return Response.json(
    {
      error: {
        code: "authentication_required",
        message: t("collections.features.savedLists.api.route.authentication.context.missing"),
      },
    },
    { status: 401 },
  );
}

function parseAdditionRequest(value: Record<string, unknown>): AddProductToSavedListRequest {
  return {
    destination: parseDestination(value.destination),
    addCommandId: String(value.addCommandId ?? "") as AddProductToSavedListRequest["addCommandId"],
    lineId: String(value.lineId ?? "") as AddProductToSavedListRequest["lineId"],
    product: parseProduct(value.product),
    trackedQuantity: Number(value.trackedQuantity),
    sourceSurface: parseSurface(value.sourceSurface),
  };
}

function parseDestination(value: unknown): SavedListDestination {
  const destination = asRecord(value);
  if (destination.kind === "new") {
    return {
      kind: "new",
      listId: String(destination.listId ?? "") as SavedListDestination["listId"],
      createCommandId: String(destination.createCommandId ?? "") as AddProductToSavedListRequest["addCommandId"],
      title: String(destination.title ?? ""),
    };
  }
  return {
    kind: "existing",
    listId: String(destination.listId ?? "") as SavedListDestination["listId"],
  };
}

function parseProduct(value: unknown): SavedListProductSelection {
  const product = asRecord(value);
  const options = Array.isArray(product.selectedOptions) ? product.selectedOptions : [];
  return {
    catalogItemId: String(product.catalogItemId ?? "") as SavedListProductSelection["catalogItemId"],
    productId: String(product.productId ?? "") as SavedListProductSelection["productId"],
    selectedOptions: options.map((entry) => {
      const option = asRecord(entry);
      return { dimensionId: String(option.dimensionId ?? ""), optionId: String(option.optionId ?? "") };
    }),
  };
}

function parseSurface(value: unknown): SavedListDiscoverySurface {
  if (value === "search" || value === "item-detail") return value;
  throw new SavedListDiscoveryError("invalid-request", "Saved List source surface is invalid.");
}

function readAnonymousOwnerId(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized.startsWith("anon_") ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorResponse(error: unknown) {
  const detail = localizedError(error);
  return Response.json({ error: { code: detail.code, message: detail.message } }, { status: detail.status });
}

function localizedError(error: unknown) {
  const code = error instanceof SavedListDiscoveryError ? error.code : "invalid-request";
  switch (code) {
    case "product-retired":
      return { code, status: 409, message: t("collections.features.savedLists.api.route.product.retired") };
    case "product-not-found":
      return { code, status: 404, message: t("collections.features.savedLists.api.route.product.not.found") };
    case "catalog-unavailable":
      return { code, status: 503, message: t("collections.features.savedLists.api.route.catalog.unavailable") };
    case "list-not-found":
      return { code, status: 404, message: t("collections.features.savedLists.api.route.list.not.found") };
    case "list-unavailable":
      return { code, status: 409, message: t("collections.features.savedLists.api.route.list.unavailable") };
    case "intent-not-found":
      return { code, status: 404, message: t("collections.features.savedLists.api.route.intent.not.found") };
    case "intent-expired":
      return { code, status: 410, message: t("collections.features.savedLists.api.route.intent.expired") };
    case "intent-already-claimed":
      return { code, status: 409, message: t("collections.features.savedLists.api.route.intent.claimed") };
    case "intent-limit-reached":
      return { code, status: 409, message: t("collections.features.savedLists.api.route.intent.limit") };
    case "invalid-product":
      return { code, status: 400, message: t("collections.features.savedLists.api.route.product.invalid") };
    default:
      return {
        code: "invalid-request",
        status: 400,
        message: t("collections.features.savedLists.api.route.request.invalid"),
      };
  }
}
