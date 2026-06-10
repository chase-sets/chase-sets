import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import {
  MarketplaceSalesFeeQuoteStaleError,
  type MarketplaceListingPhotoUpload,
  type MarketplaceListingServices,
} from "./runtime";

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("marketplace.features.listings.api.route.request.failed");
}

function validationError(error: unknown) {
  if (error instanceof MarketplaceSalesFeeQuoteStaleError) {
    return new Response(
      JSON.stringify({
        error: {
          code: "fee_quote_stale",
          message: error.message,
          currentQuote: error.currentQuote,
        },
      }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return null;
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

function parseInventorySnapshot(body: Record<string, unknown>) {
  const snapshot =
    typeof body.inventorySnapshot === "string" ? parseJsonObject(body.inventorySnapshot) : body.inventorySnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const source = snapshot as Record<string, unknown>;
  const shipFromAddress =
    source.shipFromAddress && typeof source.shipFromAddress === "object" ? (source.shipFromAddress as never) : null;

  if (!shipFromAddress) {
    return null;
  }

  return {
    inventoryItemId: String(source.inventoryItemId ?? ""),
    catalogItemId: String(source.catalogItemId ?? ""),
    productId: String(source.productId ?? ""),
    selectedOptions: parseSelectedOptions(source.selectedOptions),
    gradedCard: source.gradedCard && typeof source.gradedCard === "object" ? (source.gradedCard as never) : null,
    storageLocationId: String(source.storageLocationId ?? ""),
    storageLocationName: String(source.storageLocationName ?? ""),
    shipFromCode: String(source.shipFromCode ?? ""),
    shipFromAddress,
    totalQuantity: Number(source.totalQuantity ?? 0),
    acquisitionCostAmount: source.acquisitionCostAmount == null ? null : String(source.acquisitionCostAmount),
  };
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

  throw new Error("Seller listing availability reason is invalid.");
}

function parseAvailableAgainOn(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
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
  const files = formData.getAll("listingPhotos").filter((entry): entry is File => entry instanceof File);
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

export function createAccountListingRoutes(services: MarketplaceListingServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/listings", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSellerListings({
      accountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/listing-inventory", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const catalogItemId = c.req.query("catalogItemId");
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
  });

  app.get("/listing-availability", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getSellerListingAvailability(access.actor.accountId));
  });

  app.post("/listing-availability/disable", async (c) => {
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

    try {
      const result = await services.disableSellerListingAvailability(
        {
          accountId: access.actor.accountId,
          reasonCategory: parseSellerListingAvailabilityReason(body.reasonCategory),
          availableAgainOn: parseAvailableAgainOn(body.availableAgainOn),
        },
        context,
      );

      return c.json(result);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listing-availability/enable", async (c) => {
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

    try {
      const result = await services.enableSellerListingAvailability({ accountId: access.actor.accountId }, context);

      return c.json(result);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/preview", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const preview = await services.previewListingTerms({
        accountId: access.actor.accountId,
        priceAmount: String(body.priceAmount ?? ""),
      });

      return c.json(preview);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/listings/fee-lock-report", async (c) => {
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
  });

  app.get("/listings/:id", async (c) => {
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

    return c.json(listing);
  });

  app.get("/listings/:id/fee-history", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    try {
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
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings", async (c) => {
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
    const body = formData
      ? {
          inventoryItemId: formValue(formData, "inventoryItemId"),
          priceAmount: formValue(formData, "priceAmount"),
          quantityCap: formValue(formData, "quantityCap"),
          maxUnitsPerOrder: formValue(formData, "maxUnitsPerOrder"),
          maxUnitsPerDay: formValue(formData, "maxUnitsPerDay"),
          maxUnitsPerCustomerAccount: formValue(formData, "maxUnitsPerCustomerAccount"),
          inventorySnapshot: formValue(formData, "inventorySnapshot"),
          listingIdOverride: formValue(formData, "listingIdOverride"),
        }
      : await c.req.json();
    const listingPhotoUploads = formData ? await parseListingPhotoUploads(formData) : [];

    try {
      const inventorySnapshot = parseInventorySnapshot(body);
      const result = inventorySnapshot
        ? await services.createListingFromInventorySnapshot(
            {
              accountId: access.actor.accountId,
              ...inventorySnapshot,
              priceAmount: String(body.priceAmount ?? ""),
              quantityCap: Number(body.quantityCap ?? 0),
              purchaseLimits: parsePurchaseLimits(body),
              listingPhotoUploads,
              listingIdOverride: parseOptionalString(body.listingIdOverride) as never,
            },
            context,
          )
        : await services.createListing(
            {
              accountId: access.actor.accountId as never,
              inventoryItemId: String(body.inventoryItemId ?? ""),
              priceAmount: String(body.priceAmount ?? ""),
              quantityCap: Number(body.quantityCap ?? 0),
              purchaseLimits: parsePurchaseLimits(body),
              listingPhotoUploads,
              listingIdOverride: parseOptionalString(body.listingIdOverride) as never,
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
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/photos", async (c) => {
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

    try {
      if (!isMultipartRequest(c)) {
        throw new Error("Listing photo uploads must use multipart/form-data.");
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
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/price", async (c) => {
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

    try {
      const result = await services.updateListingPrice(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          priceAmount: String(body.priceAmount ?? ""),
          feeQuoteFingerprint: typeof body.feeQuoteFingerprint === "string" ? body.feeQuoteFingerprint : null,
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "price-updated" });
    } catch (error) {
      const response = validationError(error);
      if (response) {
        return response;
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/quantity-cap", async (c) => {
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

    try {
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
      const response = validationError(error);
      if (response) {
        return response;
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/purchase-limits", async (c) => {
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

    try {
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
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/publish", async (c) => {
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

    try {
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
      const response = validationError(error);
      if (response) {
        return response;
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/pause", async (c) => {
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

    try {
      const result = await services.pauseListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "paused" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/withdraw", async (c) => {
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

    try {
      const result = await services.withdrawListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "withdrawn" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

export function createPublicListingRoutes(services: MarketplaceListingServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.post("/terms/public-standard/listing-preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    try {
      return c.json(
        await services.previewPublicStandardListingTerms({
          priceAmount: String(body.priceAmount ?? ""),
        }),
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/products/:productId/market-summary", async (c) => {
    const summary = await services.getMarketSummaryForItem(c.req.param("productId"));
    return c.json(summary);
  });

  app.get("/products/:productId/listings", async (c) => {
    const items = await services.listItemListings(c.req.param("productId"));
    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  return app;
}
