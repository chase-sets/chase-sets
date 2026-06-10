import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { SellListLineId } from "../../../support/runtime-support/common";
import type { CheckoutApiEnv } from "../../../api";
import type { SellListExecutionSummary } from "../domain/domain";
import { parseSellListReadinessDecisionInput } from "../domain/readiness";
import type { CheckoutSellListServices } from "./runtime";

const MAX_ANONYMOUS_SELL_LIST_LINES = 50;

function requireSellListAccess(c: { get(key: "actor"): CheckoutApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (actor.permissions.includes("guest-checkout.manage")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("checkout.features.sellList.api.route.sell.list.review.requires.seller.account"),
          },
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

function createGuestSellListContext() {
  return {
    tenantId: "tnt_identity",
    audit: {
      performedByUserId: "usr_anonymous_sell_list",
      forAccountId: "acc_anonymous_sell_list",
    },
    trace: {},
  } as never;
}

function requireAnonymousSellListId(c: { req: { header: (name: string) => string | undefined } }) {
  const ownerId = c.req.header("x-checkout-anonymous-sell-list-id")?.trim() ?? "";
  if (!ownerId.startsWith("anon_")) {
    return null;
  }

  return ownerId;
}

function parseVersionSelection(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((selection): selection is { dimensionId: string; optionId: string } =>
          Boolean(selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.sellList.api.route.sell.list.request.failed");
}

function parseSellListLineBody(body: Record<string, unknown>) {
  return {
    lineType: body.lineType === "selected-offer" ? ("selected-offer" as const) : ("product" as const),
    offerId: body.offerId === null || body.offerId === undefined ? null : String(body.offerId),
    buyerAccountId:
      body.buyerAccountId === null || body.buyerAccountId === undefined ? null : String(body.buyerAccountId),
    buyerDisplayName:
      body.buyerDisplayName === null || body.buyerDisplayName === undefined ? null : String(body.buyerDisplayName),
    offerPriceAmount:
      body.offerPriceAmount === null || body.offerPriceAmount === undefined ? null : String(body.offerPriceAmount),
    catalogItemId: String(body.catalogItemId ?? ""),
    productId: String(body.productId ?? ""),
    itemTitle: String(body.itemTitle ?? ""),
    itemSubtitle: body.itemSubtitle === null || body.itemSubtitle === undefined ? null : String(body.itemSubtitle),
    selectedOptions: parseVersionSelection(body.selectedOptions),
    productSummary:
      body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
    quantity: Number(body.quantity ?? 0),
    fallbackMode: body.fallbackMode === "create-listing" ? ("create-listing" as const) : ("none" as const),
    minimumListingPriceAmount:
      body.minimumListingPriceAmount === null || body.minimumListingPriceAmount === undefined
        ? null
        : String(body.minimumListingPriceAmount),
  };
}

function isExistingSellListLine(
  line: Awaited<ReturnType<CheckoutSellListServices["listLines"]>>[number],
  body: ReturnType<typeof parseSellListLineBody>,
) {
  if (body.lineType === "selected-offer" && body.offerId) {
    return line.offer_id === body.offerId;
  }

  return (
    line.line_type === "product" &&
    line.product_id === body.productId &&
    line.fallback_mode === body.fallbackMode &&
    (line.minimum_listing_price_amount ?? null) === (body.minimumListingPriceAmount ?? null)
  );
}

function parseLineOutcomeStatus(value: unknown): "completed" | "partial" | "skipped" {
  return value === "completed" || value === "partial" || value === "skipped" ? value : "skipped";
}

function parseLineOutcomeAction(
  value: unknown,
): "accepted-offer" | "accepted-smart-match" | "created-listing" | "mixed" | "kept-in-sell-list" {
  return value === "accepted-offer" ||
    value === "accepted-smart-match" ||
    value === "created-listing" ||
    value === "mixed" ||
    value === "kept-in-sell-list"
    ? value
    : "kept-in-sell-list";
}

function parseSellListCheckoutBody(body: Record<string, unknown>) {
  const executionId = String(body.executionId ?? "").trim();
  const readinessSnapshotId = String(body.readinessSnapshotId ?? body.readiness_snapshot_id ?? "").trim();
  const readinessSourceRevision = String(body.readinessSourceRevision ?? body.readiness_source_revision ?? "").trim();
  const readinessDecisions = parseSellListReadinessDecisionInput(body.readinessDecisions ?? body.readiness_decisions);
  const completedLineIds = Array.isArray(body.completedLineIds)
    ? body.completedLineIds.map(String).filter(Boolean)
    : [];
  const remainingLineQuantities = Array.isArray(body.remainingLineQuantities)
    ? body.remainingLineQuantities
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
        .map((entry) => ({
          lineId: String(entry.lineId ?? ""),
          quantity: Number(entry.quantity ?? 0),
        }))
        .filter((entry) => entry.lineId && Number.isFinite(entry.quantity) && entry.quantity > 0)
    : [];
  const executionSummary =
    body.executionSummary && typeof body.executionSummary === "object"
      ? (body.executionSummary as Record<string, unknown>)
      : null;
  const lineOutcomes: NonNullable<SellListExecutionSummary["lineOutcomes"]> =
    executionSummary && Array.isArray(executionSummary.lineOutcomes)
      ? executionSummary.lineOutcomes
          .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
          .map((entry) => ({
            lineId: String(entry.lineId ?? "") as SellListLineId,
            itemTitle: String(entry.itemTitle ?? ""),
            status: parseLineOutcomeStatus(entry.status),
            action: parseLineOutcomeAction(entry.action),
            quantity: Number(entry.quantity ?? 0),
            remainingQuantity: Number(entry.remainingQuantity ?? 0),
            detail: String(entry.detail ?? ""),
          }))
          .filter((entry) => entry.lineId && entry.itemTitle)
      : [];

  return {
    executionId,
    readinessSnapshotId,
    readinessSourceRevision,
    readinessDecisions,
    completedLineIds,
    remainingLineQuantities,
    executionSummary: executionSummary
      ? {
          acceptedOfferCount: Number(executionSummary.acceptedOfferCount ?? 0),
          createdListingCount: Number(executionSummary.createdListingCount ?? 0),
          skippedLineCount: Number(executionSummary.skippedLineCount ?? 0),
          skippedReasons: Array.isArray(executionSummary.skippedReasons)
            ? executionSummary.skippedReasons.map(String).filter(Boolean)
            : [],
          lineOutcomes,
        }
      : null,
  };
}

function hasSellListReadinessEvidence(body: ReturnType<typeof parseSellListCheckoutBody>) {
  return Boolean(body.readinessSnapshotId && body.readinessSourceRevision);
}

function parseSellListExecutionBody(body: Record<string, unknown>) {
  return {
    executionId: String(body.executionId ?? "").trim(),
    executionPlan:
      body.executionPlan && typeof body.executionPlan === "object"
        ? (body.executionPlan as Record<string, unknown>)
        : {},
  };
}

export function createAccountSellListRoutes(services: CheckoutSellListServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/sell-list", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const [items, latestReceipt, latestPendingExecution] = await Promise.all([
      services.listLines(access.actor.accountId),
      services.getLatestReceipt(access.actor.accountId),
      services.getLatestPendingExecution(access.actor.accountId),
    ]);
    return c.json({
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
      latestReceipt,
      latestPendingExecution,
    });
  });

  app.post("/sell-list/readiness", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json().catch(() => ({}));
    const snapshot = await services.createReadinessSnapshot({
      sellerAccountId: access.actor.accountId,
      decisions: parseSellListReadinessDecisionInput(body),
    });

    return c.json({ readiness: snapshot });
  });

  app.post("/sell-list", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json<Record<string, unknown>>();

    try {
      const result = await services.addLine(
        {
          sellerAccountId: access.actor.accountId as never,
          ...parseSellListLineBody(body),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: result.status }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/sell-list/executions/latest-pending", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const execution = await services.getLatestPendingExecution(access.actor.accountId);
    if (!execution) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("checkout.features.sellList.api.route.sell.list.execution.pending.not.found"),
          },
        },
        404,
      );
    }

    return c.json(execution);
  });

  app.get("/sell-list/executions/:executionId", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const receipt = await services.getReceiptByExecutionId(access.actor.accountId, c.req.param("executionId"));
    if (!receipt) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("checkout.features.sellList.api.route.sell.list.execution.receipt.not.found"),
          },
        },
        404,
      );
    }

    return c.json(receipt);
  });

  app.post("/sell-list/executions", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const body = parseSellListExecutionBody(await c.req.json<Record<string, unknown>>().catch(() => ({})));
    if (!body.executionId) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("checkout.features.sellList.api.route.sell.list.execution.id.required"),
          },
        },
        400,
      );
    }

    try {
      const execution = await services.startSellListExecution({
        sellerAccountId: access.actor.accountId as never,
        executionId: body.executionId,
        executionPlan: body.executionPlan,
      });

      return c.json({
        id: access.actor.accountId,
        executionId: execution.execution_id,
        status: execution.status,
        executionPlan: execution.execution_plan,
        executionProgress: execution.execution_progress,
        executionSummary: execution.execution_summary,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/executions/:executionId/progress", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const completedActionKey = String(body.completedActionKey ?? "").trim();
    if (!completedActionKey) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("checkout.features.sellList.api.route.sell.list.execution.action.key.required"),
          },
        },
        400,
      );
    }

    try {
      const execution = await services.recordSellListExecutionProgress({
        sellerAccountId: access.actor.accountId as never,
        executionId: c.req.param("executionId"),
        completedActionKey,
      });

      return c.json({
        id: access.actor.accountId,
        executionId: execution.execution_id,
        status: execution.status,
        executionProgress: execution.execution_progress,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/:lineId/remove", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.removeLine(
        {
          sellerAccountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/checkout", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const checkoutBody = parseSellListCheckoutBody(body);

    try {
      const executionId = checkoutBody.executionId || createId("sle");
      if (!hasSellListReadinessEvidence(checkoutBody)) {
        return c.json(
          {
            error: {
              code: "validation_failed",
              message: t("checkout.features.sellList.api.route.sell.list.readiness.snapshot.required"),
            },
          },
          400,
        );
      }

      const existingReceipt =
        typeof services.getReceiptByExecutionId === "function"
          ? await services.getReceiptByExecutionId(access.actor.accountId, executionId)
          : null;
      if (existingReceipt) {
        return c.json({
          id: access.actor.accountId,
          executionId,
          version: 0,
          status: "reviewed",
          completedLineIds: [],
          receipt: existingReceipt,
        });
      }

      const existingExecution =
        typeof services.getExecution === "function"
          ? await services.getExecution(access.actor.accountId, executionId)
          : null;
      if (!existingExecution) {
        return c.json(
          {
            error: {
              code: "execution_not_started",
              message: t("checkout.features.sellList.api.route.sell.list.execution.not.started"),
            },
          },
          409,
        );
      }

      const result = await services.checkoutSellList(
        {
          sellerAccountId: access.actor.accountId as never,
          executionId,
          readinessSnapshotId: checkoutBody.readinessSnapshotId,
          readinessSourceRevision: checkoutBody.readinessSourceRevision,
          readinessDecisions: checkoutBody.readinessDecisions,
          completedLineIds: checkoutBody.completedLineIds as never,
          remainingLineQuantities: checkoutBody.remainingLineQuantities as never,
          executionSummary: checkoutBody.executionSummary,
        },
        context,
      );

      return c.json({
        id: result.sellerAccountId,
        executionId,
        version: result.version,
        status: result.status,
        completedLineIds: result.completedLineIds,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

export function createGuestSellListRoutes(services: CheckoutSellListServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/sell-list", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json({ items: [], count: 0 });
    }

    const items = await services.listLines(ownerId);
    return c.json({
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
    });
  });

  app.post("/sell-list/readiness", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const snapshot = await services.createReadinessSnapshot({
      sellerAccountId: ownerId,
      decisions: parseSellListReadinessDecisionInput(body),
    });

    return c.json({ readiness: snapshot });
  });

  app.post("/sell-list", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestSellListContext();
    const body = await c.req.json<Record<string, unknown>>();
    const line = parseSellListLineBody(body);

    try {
      const existingLines = await services.listLines(ownerId);
      if (
        existingLines.length >= MAX_ANONYMOUS_SELL_LIST_LINES &&
        !existingLines.some((existingLine) => isExistingSellListLine(existingLine, line))
      ) {
        return c.json(
          {
            error: {
              code: "anonymous_sell_list_limit_exceeded",
              message: t("checkout.features.sellList.api.route.anonymous.sell.list.limit.exceeded", {
                limit: MAX_ANONYMOUS_SELL_LIST_LINES,
              }),
            },
          },
          400,
        );
      }

      const result = await services.addLine(
        {
          sellerAccountId: ownerId as never,
          ...line,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: result.status }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/:lineId/remove", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestSellListContext();

    try {
      const result = await services.removeLine(
        {
          sellerAccountId: ownerId as never,
          lineId: c.req.param("lineId") as never,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/merge-to-account", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json({ mergedLineCount: 0 });
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "context_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const result = await services.mergeSellListIntoAccount(
      {
        sourceOwnerId: ownerId,
        targetAccountId: access.actor.accountId as never,
      },
      context,
    );

    return c.json(result);
  });

  return app;
}
