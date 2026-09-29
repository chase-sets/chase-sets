import { MarketplaceListingRequestError } from "./listing-request-error";
import { listingErrorResponse } from "./listing-errors";
import { t } from "@chase-sets/localization";
import {
  createPolicyBackedRateLimiter,
  rateLimitExceededJsonResponse,
  type RateLimitRuleResolver,
} from "@chase-sets/http/rate-limit";
import { parseOptionalTypedIdBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { Hono } from "hono";
import { parseStrictTypedUlid, type AccountId, type ListingId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceApiEnv } from "../../../api";
import {
  type MarketplaceBulkListingPriceUpdateInput,
  type MarketplaceListingPhotoUpload,
  type MarketplaceListingServices,
} from "./runtime";
import { parseGradedCardSnapshot, parseShipFromAddressSnapshot } from "./listing-snapshot-parsers";

const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX = 30;
const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_SURFACE = "marketplace.anonymous-listing-draft.capture";
const PUBLIC_STANDARD_TERMS_PREVIEW_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_STANDARD_TERMS_PREVIEW_RATE_LIMIT_MAX = 120;
const PUBLIC_STANDARD_TERMS_PREVIEW_RATE_LIMIT_SURFACE = "marketplace.public-standard-terms-preview";
const LISTING_PHOTO_JPEG_RATE_LIMIT_SURFACE = "marketplace.listing-photo.jpeg-download.account";

function requireListingAccess(
  c: {
    get(key: "actor"): MarketplaceApiEnv["Variables"]["actor"];
  },
  permission: "listings.view" | "listings.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("marketplace.features.listings.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authorization_forbidden", message: t("marketplace.features.listings.api.route.forbidden") },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function requireAnonymousListingDraftOwnerId(c: { req: { header(name: string): string | undefined } }) {
  const ownerId = c.req.header("x-marketplace-anonymous-listing-draft-id")?.trim() ?? "";
  return ownerId.startsWith("anon_") ? ownerId : null;
}

function assertClosedObject(value: Record<string, unknown>, allowedKeys: readonly string[], label: string) {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey) {
    throw new MarketplaceListingRequestError("unknown-field", `${label} contains unknown field '${unknownKey}'.`);
  }
}

function assertClosedPurchaseLimits(body: Record<string, unknown>) {
  if (body.purchaseLimits && typeof body.purchaseLimits === "object" && !Array.isArray(body.purchaseLimits)) {
    assertClosedObject(
      body.purchaseLimits as Record<string, unknown>,
      ["maxUnitsPerOrder", "maxUnitsPerDay", "maxUnitsPerCustomerAccount"],
      "Listing purchase limits",
    );
  }
}

function assertPriceCurrencyInput(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new MarketplaceListingRequestError(
      "price-currency-invalid",
      "Price currency code must be a three-letter ISO-4217 code.",
    );
  }
}

function rateLimitedResponse(message: string, retryAfterSeconds: number) {
  return {
    body: {
      error: {
        code: "anonymous_request_rate_limited",
        message,
      },
    },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

function parseLimitValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parsePurchaseLimits(body: Record<string, unknown>) {
  const source =
    body.purchaseLimits && typeof body.purchaseLimits === "object"
      ? (body.purchaseLimits as Record<string, unknown>)
      : body;

  return {
    maxUnitsPerOrder: parseLimitValue(source.maxUnitsPerOrder ?? source.max_units_per_order),
    maxUnitsPerDay: parseLimitValue(source.maxUnitsPerDay ?? source.max_units_per_day),
    maxUnitsPerCustomerAccount: parseLimitValue(
      source.maxUnitsPerCustomerAccount ?? source.max_units_per_customer_account,
    ),
  };
}

function parseOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseSelectedOptions(value: unknown) {
  if (Array.isArray(value)) {
    for (const option of value) {
      if (option && typeof option === "object" && !Array.isArray(option)) {
        assertClosedObject(option as Record<string, unknown>, ["dimensionId", "optionId"], "Selected option");
      }
    }
  }

  return Array.isArray(value)
    ? value
        .map((entry) =>
          entry && typeof entry === "object"
            ? {
                dimensionId: String((entry as Record<string, unknown>).dimensionId ?? ""),
                optionId: String((entry as Record<string, unknown>).optionId ?? ""),
              }
            : null,
        )
        .filter((entry): entry is { dimensionId: string; optionId: string } =>
          Boolean(entry?.dimensionId && entry.optionId),
        )
    : [];
}

function parseListingGradedCardSnapshot(value: unknown) {
  try {
    return parseGradedCardSnapshot(value);
  } catch {
    throw new MarketplaceListingRequestError("inventory-snapshot-invalid", "Graded card snapshot is invalid.");
  }
}

function parseListingPhotoId<Prefix extends string>(value: string, prefix: Prefix) {
  try {
    return parseStrictTypedUlid(value, prefix);
  } catch {
    throw new MarketplaceListingRequestError("id-invalid", "Listing photo ID is invalid.");
  }
}

function parseInventorySnapshot(body: Record<string, unknown>) {
  const snapshot =
    typeof body.inventorySnapshot === "string" ? parseJsonObject(body.inventorySnapshot) : body.inventorySnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const source = snapshot as Record<string, unknown>;
  assertClosedObject(
    source,
    [
      "inventoryItemId",
      "catalogItemId",
      "productId",
      "selectedOptions",
      "gradedCard",
      "storageLocationId",
      "storageLocationName",
      "shipFromCode",
      "shipFromAddress",
      "totalQuantity",
      "availableQuantity",
      "acquisitionCostAmount",
    ],
    "Inventory snapshot",
  );
  if (source.shipFromAddress && typeof source.shipFromAddress === "object" && !Array.isArray(source.shipFromAddress)) {
    assertClosedObject(
      source.shipFromAddress as Record<string, unknown>,
      ["name", "company", "line1", "line2", "city", "state", "postalCode", "country", "phone", "email"],
      "Ship-from address snapshot",
    );
  }
  if (source.gradedCard && typeof source.gradedCard === "object" && !Array.isArray(source.gradedCard)) {
    const gradedCard = source.gradedCard as Record<string, unknown>;
    assertClosedObject(
      gradedCard,
      ["gradingCompany", "grade", "certificationNumber", "population", "conditionDescriptors"],
      "Graded card snapshot",
    );
    if (gradedCard.population && typeof gradedCard.population === "object" && !Array.isArray(gradedCard.population)) {
      assertClosedObject(
        gradedCard.population as Record<string, unknown>,
        ["populationAtGrade", "populationHigher", "source", "asOf"],
        "Graded card population snapshot",
      );
    }
  }
  const shipFromAddress = parseShipFromAddressSnapshot(source.shipFromAddress);

  if (!shipFromAddress) {
    return null;
  }

  return {
    inventoryItemId: String(source.inventoryItemId ?? ""),
    catalogItemId: String(source.catalogItemId ?? ""),
    productId: String(source.productId ?? ""),
    selectedOptions: parseSelectedOptions(source.selectedOptions),
    gradedCard: parseListingGradedCardSnapshot(source.gradedCard),
    storageLocationId: String(source.storageLocationId ?? ""),
    storageLocationName: String(source.storageLocationName ?? ""),
    shipFromCode: String(source.shipFromCode ?? ""),
    shipFromAddress,
    totalQuantity: Number(source.totalQuantity ?? 0),
    availableQuantity: Number(source.availableQuantity ?? source.totalQuantity ?? 0),
    acquisitionCostAmount: source.acquisitionCostAmount == null ? null : String(source.acquisitionCostAmount),
  };
}

function parseAnonymousListingDraftBody(body: Record<string, unknown>) {
  assertClosedObject(
    body,
    [
      "sourcePath",
      "source_path",
      "catalogItemId",
      "catalog_item_id",
      "productId",
      "product_id",
      "selectedOptions",
      "selected_options",
      "productSummary",
      "product_summary",
      "priceAmount",
      "price_amount",
      "priceCurrencyCode",
      "price_currency_code",
      "quantityCap",
      "quantity_cap",
      "purchaseLimits",
      "maxUnitsPerOrder",
      "max_units_per_order",
      "maxUnitsPerDay",
      "max_units_per_day",
      "maxUnitsPerCustomerAccount",
      "max_units_per_customer_account",
    ],
    "Anonymous listing draft",
  );
  assertClosedPurchaseLimits(body);
  assertPriceCurrencyInput(body.priceCurrencyCode ?? body.price_currency_code);
  const productSummary = body.productSummary ?? body.product_summary;

  return {
    sourcePath: String(body.sourcePath ?? body.source_path ?? ""),
    catalogItemId: String(body.catalogItemId ?? body.catalog_item_id ?? ""),
    productId: String(body.productId ?? body.product_id ?? ""),
    selectedOptions: parseSelectedOptions(body.selectedOptions ?? body.selected_options),
    productSummary: productSummary === null || productSummary === undefined ? null : String(productSummary),
    priceAmount: String(body.priceAmount ?? body.price_amount ?? ""),
    priceCurrencyCode: String(body.priceCurrencyCode ?? body.price_currency_code ?? ""),
    quantityCap: Number(body.quantityCap ?? body.quantity_cap ?? 0),
    purchaseLimits: parsePurchaseLimits(body),
  };
}

function parseBulkListingPriceUpdates(body: Record<string, unknown>): MarketplaceBulkListingPriceUpdateInput[] {
  assertClosedObject(body, ["updates"], "Bulk listing price update request");
  const rawUpdates = Array.isArray(body.updates) ? body.updates : [];

  return rawUpdates.flatMap((entry): MarketplaceBulkListingPriceUpdateInput[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    assertClosedObject(
      record,
      [
        "listingId",
        "listing_id",
        "priceAmount",
        "price_amount",
        "priceCurrencyCode",
        "price_currency_code",
        "feeQuoteFingerprint",
        "fee_quote_fingerprint",
      ],
      "Bulk listing price update",
    );
    const listingId = String(record.listingId ?? record.listing_id ?? "").trim();
    const priceAmount = String(record.priceAmount ?? record.price_amount ?? "");
    const priceCurrencyCode = String(record.priceCurrencyCode ?? record.price_currency_code ?? "");
    const rawFingerprint = record.feeQuoteFingerprint ?? record.fee_quote_fingerprint;

    if (!listingId) {
      return [];
    }
    assertPriceCurrencyInput(priceCurrencyCode);

    return [
      {
        listingId,
        priceAmount,
        priceCurrencyCode,
        feeQuoteFingerprint: typeof rawFingerprint === "string" ? rawFingerprint : null,
      },
    ];
  });
}

function parseJsonObject(value: string): unknown {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return null;
  }
}

function parseSellerListingAvailabilityReason(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!normalized) {
    return null;
  }

  if (normalized === "travel" || normalized === "audit" || normalized === "operations" || normalized === "other") {
    return normalized;
  }

  throw new MarketplaceListingRequestError(
    "availability-reason-invalid",
    "Seller listing availability reason is invalid.",
  );
}

// Away Window scheduling requires a reason -- unlike a manual disable,
// where a reason is optional.
function parseRequiredSellerListingAvailabilityReason(value: unknown) {
  const reason = parseSellerListingAvailabilityReason(value);
  if (reason === null) {
    throw new MarketplaceListingRequestError("away-window-reason-required", "Away window reason is required.");
  }

  return reason;
}

function parseAwayWindowInstant(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new MarketplaceListingRequestError("away-window-instant-required", "Away window instant is required.");
  }

  return normalized;
}

function parseAwayWindowEndInstant(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function parseAvailableAgainOn(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

// The instant is captured client-side (seller-local start-of-day for the
// chosen date); the API accepts it verbatim and never guesses a timezone
// server-side.
function parseAvailableAgainAt(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function parseMaxOpenOrders(value: unknown) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new MarketplaceListingRequestError(
      "order-capacity-invalid",
      "Order capacity must be a whole number of at least 1.",
    );
  }
  return numeric;
}

function isMultipartRequest(c: { req: { header(name: string): string | undefined } }) {
  return (c.req.header("content-type") ?? "").includes("multipart/form-data");
}

async function fileToPhotoUpload(file: File, altText?: string | null): Promise<MarketplaceListingPhotoUpload | null> {
  if (file.size <= 0) {
    return null;
  }

  return {
    body: new Uint8Array(await file.arrayBuffer()),
    contentType: file.type,
    originalFilename: file.name.trim() || null,
    altText: altText?.trim() || null,
  };
}

async function parseListingPhotoUploads(formData: FormData) {
  const files = formData.getAll("evidence").filter((entry): entry is File => entry instanceof File);
  const altTexts = formData.getAll("listingPhotoAltText").map((entry) => String(entry ?? ""));
  const uploads: MarketplaceListingPhotoUpload[] = [];

  for (const [index, file] of files.entries()) {
    const upload = await fileToPhotoUpload(file, altTexts[index]);
    if (upload) {
      uploads.push(upload);
    }
  }

  return uploads;
}

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function orderedPhotoIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0) : [];
}

export function createAccountListingRoutes(
  services: MarketplaceListingServices,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<MarketplaceApiEnv>();
  const jpegRateLimiter = createPolicyBackedRateLimiter(
    LISTING_PHOTO_JPEG_RATE_LIMIT_SURFACE,
    { max: 30, windowMs: 600_000 },
    resolveRateLimitRule ?? (async (_surface, defaults) => defaults),
  );

  app.get("/listings/:id/photos/:photoId/jpeg", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) return access.response;
    let listingId: ListingId;
    let photoId: string;
    try {
      listingId = parseListingPhotoId(c.req.param("id"), "lst");
      photoId = parseListingPhotoId(c.req.param("photoId"), "lpho");
    } catch (error) {
      return listingErrorResponse(error, ["id-invalid"]);
    }
    const rateLimit = await jpegRateLimiter.check(access.actor.accountId);
    if (rateLimit.limited) return rateLimitExceededJsonResponse(LISTING_PHOTO_JPEG_RATE_LIMIT_SURFACE, rateLimit);
    const jpeg = await services.getListingPhotoJpeg({ accountId: access.actor.accountId, listingId, photoId });
    if (!jpeg) {
      return c.json(
        { error: { code: "not_found", message: t("marketplace.features.listings.api.route.listing.not.found") } },
        404,
      );
    }
    return new Response(new Uint8Array(jpeg.body), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpeg.body.byteLength),
        ETag: jpeg.etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  });

  app.get("/listings", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      const limit = Number(c.req.query("limit") ?? 50);
      const offset = Number(c.req.query("offset") ?? 0);
      const status = c.req.query("status")?.trim();
      const search = c.req.query("search")?.trim();
      const [result, statusCounts] = await Promise.all([
        services.listSellerListings({
          accountId: access.actor.accountId,
          limit,
          offset,
          status: status && status !== "all" ? status : undefined,
          search: search ? search : undefined,
        }),
        services.getSellerListingStatusCounts(access.actor.accountId),
      ]);

      return c.json({
        items: result.items,
        total: result.total,
        count: result.items.length,
        limit,
        offset,
        statusCounts,
      });
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  app.get("/listing-inventory", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      const limit = Number(c.req.query("limit") ?? 50);
      const offset = Number(c.req.query("offset") ?? 0);
      const catalogItemId = c.req.query("catalogItemId");
      const inventoryItemId = c.req.query("inventoryItemId")?.trim();
      if (inventoryItemId) {
        const item = await services.getInventoryItemSupply(inventoryItemId, access.actor.accountId);
        const items = item && item.available_quantity > 0 ? [item] : [];
        return c.json({
          items,
          total: items.length,
          count: items.length,
        });
      }

      const result = await services.listSellerInventoryItemSupply({
        accountId: access.actor.accountId,
        catalogItemId: catalogItemId && catalogItemId.trim() ? catalogItemId : undefined,
        limit,
        offset,
      });

      return c.json({
        items: result.items,
        total: result.total,
        count: result.items.length,
      });
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  app.get("/supply-locations/exists", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      const name = String(c.req.query("name") ?? "").trim();
      const exists = name
        ? await services.hasSellerSupplyLocationNamed({
            accountId: access.actor.accountId,
            name,
          })
        : false;

      return c.json({ exists });
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  app.get("/listing-availability", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      return c.json(await services.getSellerListingAvailability(access.actor.accountId));
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  app.post("/listing-availability/disable", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const body = await c.req.json().catch(() => ({}));

      const result = await services.disableSellerListingAvailability(
        {
          accountId: access.actor.accountId,
          reasonCategory: parseSellerListingAvailabilityReason(body.reasonCategory),
          availableAgainOn: parseAvailableAgainOn(body.availableAgainOn),
          availableAgainAt: parseAvailableAgainAt(body.availableAgainAt),
        },
        context,
      );

      return c.json(result);
    } catch (error) {
      return listingErrorResponse(error, ["availability-reason-invalid", "command-rejected"]);
    }
  });

  app.post("/listing-availability/enable", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const result = await services.enableSellerListingAvailability({ accountId: access.actor.accountId }, context);

      return c.json(result);
    } catch (error) {
      return listingErrorResponse(error, ["command-rejected"]);
    }
  });

  // Order Capacity is inert in this slice: the setting and its events
  // publish, but nothing enforces them yet (no new order intake is
  // refused). Enforcement is a later slice.
  app.get("/order-capacity", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      return c.json(await services.getSellerOrderCapacity(access.actor.accountId));
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  app.post("/order-capacity", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const body = await c.req.json().catch(() => ({}));

      const result = await services.setSellerOrderCapacity(
        {
          accountId: access.actor.accountId,
          maxOpenOrders: parseMaxOpenOrders(body.maxOpenOrders ?? body.max_open_orders),
        },
        context,
      );

      return c.json(result);
    } catch (error) {
      return listingErrorResponse(error, ["order-capacity-invalid", "command-rejected"]);
    }
  });

  app.delete("/order-capacity", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const result = await services.clearSellerOrderCapacity({ accountId: access.actor.accountId }, context);

      return c.json(result);
    } catch (error) {
      return listingErrorResponse(error, ["command-rejected"]);
    }
  });

  app.post("/listing-availability/away-window", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const body = await c.req.json().catch(() => ({}));

      const result = await services.scheduleSellerAwayWindow(
        {
          accountId: access.actor.accountId,
          startsAt: parseAwayWindowInstant(body.startsAt),
          endsAt: parseAwayWindowEndInstant(body.endsAt),
          reasonCategory: parseRequiredSellerListingAvailabilityReason(body.reasonCategory),
        },
        context,
      );

      return c.json(result);
    } catch (error) {
      return listingErrorResponse(error, [
        "availability-reason-invalid",
        "away-window-reason-required",
        "away-window-instant-required",
        "command-rejected",
      ]);
    }
  });

  app.delete("/listing-availability/away-window", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const result = await services.cancelScheduledAwayWindow({ accountId: access.actor.accountId }, context);

      return c.json(result);
    } catch (error) {
      return listingErrorResponse(error, ["command-rejected"]);
    }
  });

  app.post("/listings/preview", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const body = await c.req.json().catch(() => ({}));

      const preview = await services.previewListingTerms({
        accountId: access.actor.accountId,
        priceAmount: String(body.priceAmount ?? ""),
      });

      return c.json(preview);
    } catch (error) {
      return listingErrorResponse(error, ["command-rejected"]);
    }
  });

  app.post("/listings/evidence-readiness/preview", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) return access.response;
      const body = await c.req.json().catch(() => ({}));

      return c.json(
        await services.previewListingEvidenceReadiness({
          accountId: access.actor.accountId,
          inventoryItemId: parseTypedIdBoundary(body.inventoryItemId, "inv", "inventoryItemId"),
          priceAmount: String(body.priceAmount ?? "0"),
          now: new Date().toISOString(),
        }),
      );
    } catch (error) {
      return listingErrorResponse(error, ["id-invalid", "inventory-item-not-found", "command-rejected"]);
    }
  });

  app.get("/listings/fee-lock-report", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      const limit = Number(c.req.query("limit") ?? 100);
      const offset = Number(c.req.query("offset") ?? 0);
      const result = await services.listSellerListingFeeLockReport({
        accountId: access.actor.accountId,
        limit,
        offset,
      });

      return c.json({
        items: result.items,
        total: result.total,
        count: result.items.length,
      });
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  app.post("/listing-draft-intents/:id/claim", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const anonymousOwnerId = requireAnonymousListingDraftOwnerId(c);
      if (!anonymousOwnerId) {
        return c.json(
          {
            error: {
              code: "anonymous_listing_draft_required",
              message: t("marketplace.features.listings.api.route.anonymous.listing.draft.required"),
            },
          },
          400,
        );
      }

      return c.json(
        await services.claimAnonymousListingDraftIntent({
          anonymousOwnerId,
          intentId: c.req.param("id"),
          accountId: access.actor.accountId,
        }),
      );
    } catch (error) {
      return listingErrorResponse(error, ["command-rejected"]);
    }
  });

  app.get("/listings/:id", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      const listing = await services.getSellerListing(c.req.param("id"), access.actor.accountId);

      if (!listing) {
        return c.json(
          { error: { code: "not_found", message: t("marketplace.features.listings.api.route.listing.not.found") } },
          404,
        );
      }

      return c.json({
        ...listing,
        evidence_readiness: await services.getListingEvidenceReadiness({
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          now: new Date().toISOString(),
        }),
      });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found"]);
    }
  });

  app.get("/listings/:id/evidence-coverage", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      return c.json(
        await services.getListingEvidenceCoverage({
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          now: c.req.query("now") || undefined,
        }),
      );
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found"]);
    }
  });

  app.get("/listings/:id/fee-history", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.view");
      if (access.response) {
        return access.response;
      }

      const items = await services.listSellerListingFeeHistory({
        listingId: c.req.param("id"),
        accountId: access.actor.accountId,
      });

      return c.json({
        items,
        total: items.length,
        count: items.length,
      });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found"]);
    }
  });

  app.post("/listings", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const formData = isMultipartRequest(c) ? await c.req.formData() : null;
      if (formData) {
        const allowedFormKeys = new Set([
          "inventoryItemId",
          "priceAmount",
          "priceCurrencyCode",
          "quantityCap",
          "maxUnitsPerOrder",
          "maxUnitsPerDay",
          "maxUnitsPerCustomerAccount",
          "inventorySnapshot",
          "listingIdOverride",
          "evidence",
          "listingPhotoAltText",
        ]);
        const unknownKey = [...formData.keys()].find((key) => !allowedFormKeys.has(key));
        if (unknownKey)
          throw new MarketplaceListingRequestError(
            "unknown-field",
            `Listing create contains unknown field '${unknownKey}'.`,
          );
      }
      const body = formData
        ? {
            inventoryItemId: formValue(formData, "inventoryItemId"),
            priceAmount: formValue(formData, "priceAmount"),
            priceCurrencyCode: formValue(formData, "priceCurrencyCode"),
            quantityCap: formValue(formData, "quantityCap"),
            maxUnitsPerOrder: formValue(formData, "maxUnitsPerOrder"),
            maxUnitsPerDay: formValue(formData, "maxUnitsPerDay"),
            maxUnitsPerCustomerAccount: formValue(formData, "maxUnitsPerCustomerAccount"),
            inventorySnapshot: formValue(formData, "inventorySnapshot"),
            listingIdOverride: formValue(formData, "listingIdOverride"),
          }
        : await c.req.json();
      const listingPhotoUploads = formData ? await parseListingPhotoUploads(formData) : [];

      assertClosedObject(
        body,
        [
          "inventoryItemId",
          "priceAmount",
          "priceCurrencyCode",
          "quantityCap",
          "maxUnitsPerOrder",
          "maxUnitsPerDay",
          "maxUnitsPerCustomerAccount",
          "purchaseLimits",
          "inventorySnapshot",
          "listingIdOverride",
        ],
        "Listing create",
      );
      assertClosedPurchaseLimits(body);
      assertPriceCurrencyInput(body.priceCurrencyCode);
      const inventorySnapshot = parseInventorySnapshot(body);
      const result = inventorySnapshot
        ? await services.createListingFromInventorySnapshot(
            {
              accountId: access.actor.accountId,
              ...inventorySnapshot,
              priceAmount: String(body.priceAmount ?? ""),
              priceCurrencyCode: String(body.priceCurrencyCode ?? ""),
              quantityCap: Number(body.quantityCap ?? 0),
              purchaseLimits: parsePurchaseLimits(body),
              listingPhotoUploads,
              listingIdOverride: parseOptionalTypedIdBoundary(body.listingIdOverride, "lst", "listingIdOverride"),
            },
            context,
          )
        : await services.createListing(
            {
              accountId: access.actor.accountId as AccountId,
              inventoryItemId: parseTypedIdBoundary(body.inventoryItemId, "inv", "inventoryItemId"),
              priceAmount: String(body.priceAmount ?? ""),
              priceCurrencyCode: String(body.priceCurrencyCode ?? ""),
              quantityCap: Number(body.quantityCap ?? 0),
              purchaseLimits: parsePurchaseLimits(body),
              listingPhotoUploads,
              listingIdOverride: parseOptionalTypedIdBoundary(body.listingIdOverride, "lst", "listingIdOverride"),
            },
            context,
          );

      return c.json(
        {
          id: result.listingId,
          version: result.version,
          status: "draft",
          feeQuoteFingerprint: result.feeQuoteFingerprint,
        },
        201,
      );
    } catch (error) {
      return listingErrorResponse(error, [
        "unknown-field",
        "price-currency-invalid",
        "id-invalid",
        "inventory-snapshot-invalid",
        "listing-not-found",
        "inventory-item-not-found",
        "command-rejected",
        "evidence-invalid",
      ]);
    }
  });

  app.post("/listings/:id/photos", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      if (!isMultipartRequest(c)) {
        throw new MarketplaceListingRequestError(
          "photo-multipart-required",
          t("marketplace.features.listings.api.route.listing.photo.multipart"),
        );
      }
      const formData = await c.req.formData();
      const result = await services.addListingPhotos(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          listingPhotoUploads: await parseListingPhotoUploads(formData),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "photos-added" });
    } catch (error) {
      return listingErrorResponse(error, [
        "photo-multipart-required",
        "listing-not-found",
        "command-rejected",
        "evidence-invalid",
      ]);
    }
  });

  app.post("/listings/:id/photos/reorder", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) return access.response;
      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const body = await c.req.json().catch(() => ({}));
      const result = await services.reorderListingPhotos(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          orderedPhotoIds: orderedPhotoIds(body.orderedPhotoIds ?? body.ordered_photo_ids),
        },
        context,
      );
      return c.json({ id: result.listingId, version: result.version, status: "photos-reordered" });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found", "command-rejected"]);
    }
  });

  app.post("/listings/:id/photos/:photoId/classify", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) return access.response;
      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const body = await c.req.json<Record<string, unknown>>();
      const result = await services.classifyListingPhoto(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          photoId: c.req.param("photoId"),
          slotId: parseOptionalString(body.slotId),
          viewKind: parseOptionalString(body.viewKind),
          altText: parseOptionalString(body.altText),
          capturedAt: parseOptionalString(body.capturedAt),
        },
        context,
      );
      return c.json({ id: result.listingId, version: result.version, status: "photo-classified" });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found", "command-rejected"]);
    }
  });

  app.post("/listings/:id/photos/:photoId/replace", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      if (!isMultipartRequest(c)) {
        throw new MarketplaceListingRequestError(
          "photo-multipart-required",
          t("marketplace.features.listings.api.route.listing.photo.replacement.multipart"),
        );
      }
      const formData = await c.req.formData();
      const file = formData.get("listingPhoto");
      if (!(file instanceof File)) {
        throw new MarketplaceListingRequestError(
          "photo-replacement-required",
          t("marketplace.features.listings.api.route.listing.photo.replacement.required"),
        );
      }
      const upload = await fileToPhotoUpload(file, formValue(formData, "listingPhotoAltText"));
      if (!upload) {
        throw new MarketplaceListingRequestError(
          "photo-replacement-required",
          t("marketplace.features.listings.api.route.listing.photo.replacement.required"),
        );
      }
      const result = await services.replaceListingPhoto(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          replacedPhotoId: c.req.param("photoId"),
          upload,
          slotId: parseOptionalString(formValue(formData, "slotId")),
          viewKind: parseOptionalString(formValue(formData, "viewKind")),
          capturedAt: parseOptionalString(formValue(formData, "capturedAt")),
        },
        context,
      );
      return c.json({ id: result.listingId, version: result.version, status: "photo-replaced" });
    } catch (error) {
      return listingErrorResponse(error, [
        "photo-multipart-required",
        "photo-replacement-required",
        "listing-not-found",
        "command-rejected",
        "evidence-invalid",
      ]);
    }
  });

  app.delete("/listings/:id/photos/:photoId", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) return access.response;
      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing"),
            },
          },
          401,
        );
      }

      const result = await services.removeListingPhoto(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          photoId: c.req.param("photoId"),
        },
        context,
      );
      return c.json({ id: result.listingId, version: result.version, status: "photo-removed" });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found", "command-rejected"]);
    }
  });

  app.post("/listings/:id/price", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing.2"),
            },
          },
          401,
        );
      }

      const body = await c.req.json();

      assertClosedObject(body, ["priceAmount", "priceCurrencyCode", "feeQuoteFingerprint"], "Listing price update");
      assertPriceCurrencyInput(body.priceCurrencyCode);
      const result = await services.updateListingPrice(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          priceAmount: String(body.priceAmount ?? ""),
          priceCurrencyCode: String(body.priceCurrencyCode ?? ""),
          feeQuoteFingerprint: typeof body.feeQuoteFingerprint === "string" ? body.feeQuoteFingerprint : null,
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "price-updated" });
    } catch (error) {
      return listingErrorResponse(error, [
        "unknown-field",
        "price-currency-invalid",
        "listing-not-found",
        "command-rejected",
        "fee-quote-stale",
      ]);
    }
  });

  app.post("/listings/prices/bulk", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing.7"),
            },
          },
          401,
        );
      }

      const body = await c.req.json().catch(() => ({}));

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: access.actor.accountId,
          updates: parseBulkListingPriceUpdates(body),
        },
        context,
      );

      const items = outcomes.map(({ message, ...outcome }) => ({
        ...outcome,
        ...(message === undefined ? {} : { message: t("marketplace.features.listings.api.route.request.failed") }),
      }));
      return c.json({ items, total: items.length, count: items.length });
    } catch (error) {
      return listingErrorResponse(error, ["unknown-field", "price-currency-invalid", "bulk-price-update-invalid"]);
    }
  });

  app.post("/listings/:id/quantity-cap", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing.3"),
            },
          },
          401,
        );
      }

      const body = await c.req.json();

      const result = await services.updateListingQuantityCap(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          quantityCap: Number(body.quantityCap ?? 0),
          purchaseLimits:
            body.purchaseLimits && typeof body.purchaseLimits === "object" ? parsePurchaseLimits(body) : undefined,
          feeQuoteFingerprint: typeof body.feeQuoteFingerprint === "string" ? body.feeQuoteFingerprint : null,
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "quantity-cap-updated" });
    } catch (error) {
      return listingErrorResponse(error, [
        "listing-not-found",
        "inventory-item-not-found",
        "command-rejected",
        "fee-quote-stale",
      ]);
    }
  });

  app.post("/listings/:id/purchase-limits", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing.3"),
            },
          },
          401,
        );
      }

      const body = await c.req.json();

      const result = await services.updateListingPurchaseLimits(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          purchaseLimits: parsePurchaseLimits(body),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "purchase-limits-updated" });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found", "command-rejected"]);
    }
  });

  app.post("/listings/:id/publish", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing.4"),
            },
          },
          401,
        );
      }

      const body = await c.req.json().catch(() => ({}));

      const result = await services.publishListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          feeQuoteFingerprint: typeof body.feeQuoteFingerprint === "string" ? body.feeQuoteFingerprint : null,
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "published" });
    } catch (error) {
      return listingErrorResponse(error, [
        "listing-not-found",
        "inventory-item-not-found",
        "command-rejected",
        "evidence-incomplete",
        "fee-quote-stale",
      ]);
    }
  });

  app.post("/listings/:id/pause", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing.5"),
            },
          },
          401,
        );
      }

      const result = await services.pauseListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "paused" });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found", "command-rejected"]);
    }
  });

  app.post("/listings/:id/withdraw", async (c) => {
    try {
      const access = requireListingAccess(c, "listings.manage");
      if (access.response) {
        return access.response;
      }

      const context = c.get("context");
      if (!context) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: t("marketplace.features.listings.api.route.authentication.context.missing.6"),
            },
          },
          401,
        );
      }

      const result = await services.withdrawListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "withdrawn" });
    } catch (error) {
      return listingErrorResponse(error, ["listing-not-found", "command-rejected"]);
    }
  });

  return app;
}

export function createPublicListingRoutes(
  services: MarketplaceListingServices,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<MarketplaceApiEnv>();
  const resolveRule = resolveRateLimitRule ?? (async (_surface: string, defaults) => defaults);
  const anonymousListingDraftCaptureRateLimiter = createPolicyBackedRateLimiter(
    ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_SURFACE,
    { max: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX, windowMs: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS },
    resolveRule,
    { keyPrefix: "marketplace:anonymous-listing-draft-capture" },
  );
  const publicStandardTermsPreviewRateLimiter = createPolicyBackedRateLimiter(
    PUBLIC_STANDARD_TERMS_PREVIEW_RATE_LIMIT_SURFACE,
    { max: PUBLIC_STANDARD_TERMS_PREVIEW_RATE_LIMIT_MAX, windowMs: PUBLIC_STANDARD_TERMS_PREVIEW_RATE_LIMIT_WINDOW_MS },
    resolveRule,
    { keyPrefix: "marketplace:public-standard-terms-preview" },
  );

  app.post("/guest/listing-draft-intents", async (c) => {
    try {
      const anonymousOwnerId = requireAnonymousListingDraftOwnerId(c);
      if (!anonymousOwnerId) {
        return c.json(
          {
            error: {
              code: "anonymous_listing_draft_required",
              message: t("marketplace.features.listings.api.route.anonymous.listing.draft.required"),
            },
          },
          400,
        );
      }

      const rateLimit = await anonymousListingDraftCaptureRateLimiter.check(c.req.raw);
      if (rateLimit.limited) {
        const response = rateLimitedResponse(
          t("marketplace.features.listings.api.route.anonymous.request.rate.limited"),
          rateLimit.retryAfterSeconds,
        );
        return c.json(response.body, 429, response.headers);
      }

      const body = await c.req.json().catch(() => ({}));

      return c.json(
        await services.createAnonymousListingDraftIntent({
          anonymousOwnerId,
          ...parseAnonymousListingDraftBody(body),
        }),
        201,
      );
    } catch (error) {
      return listingErrorResponse(error, ["unknown-field", "price-currency-invalid", "command-rejected"]);
    }
  });

  app.post("/terms/public-standard/listing-preview", async (c) => {
    try {
      const rateLimit = await publicStandardTermsPreviewRateLimiter.check(c.req.raw);
      if (rateLimit.limited) {
        const response = rateLimitedResponse(
          t("marketplace.features.listings.api.route.public.standard.terms.preview.rate.limited"),
          rateLimit.retryAfterSeconds,
        );
        return c.json(response.body, 429, response.headers);
      }

      const body = await c.req.json().catch(() => ({}));

      return c.json(
        await services.previewPublicStandardListingTerms({
          priceAmount: String(body.priceAmount ?? ""),
        }),
      );
    } catch (error) {
      return listingErrorResponse(error, ["command-rejected"]);
    }
  });

  app.get("/products/:productId/market-summary", async (c) => {
    try {
      const summary = await services.getMarketSummaryForItem(c.req.param("productId"));
      return c.json(summary);
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  app.get("/products/:productId/listings", async (c) => {
    try {
      const items = await services.listItemListings(c.req.param("productId"));
      return c.json({
        items,
        total: items.length,
        count: items.length,
      });
    } catch (error) {
      return listingErrorResponse(error, []);
    }
  });

  return app;
}
