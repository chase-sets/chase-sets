import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { SupportApiEnv } from "./http";
import type { SupportRequestServices } from "./runtime";

function requireSupportAccess(
  c: {
    get(key: "actor"): SupportApiEnv["Variables"]["actor"];
  },
  permission: "support.view" | "support.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.required"),
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
          error: {
            code: "authorization_forbidden",
            message: t("support.features.support_requests.api.route.forbidden"),
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("support.features.support_requests.api.route.request.failed");
}

function requireCommandContext(c: { get(key: "context"): SupportApiEnv["Variables"]["context"] }, messageKey: string) {
  const context = c.get("context");
  if (!context) {
    return {
      context: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t(messageKey),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { context, response: null };
}

export function createAccountSupportRequestRoutes(services: SupportRequestServices) {
  const app = new Hono<SupportApiEnv>();

  app.get("/flows", async (c) => {
    const access = requireSupportAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }

    return c.json({ items: await services.listFlowDefinitions() });
  });

  app.get("/purchases", async (c) => {
    const access = requireSupportAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }

    const result = await services.listBuyerSupportRequests({
      buyerAccountId: access.actor.accountId,
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/sales", async (c) => {
    const access = requireSupportAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }

    const result = await services.listSellerSupportRequests({
      sellerAccountId: access.actor.accountId,
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/orders/:orderId", async (c) => {
    const access = requireSupportAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }

    try {
      const result = await services.getSupportOrderContext({
        orderId: c.req.param("orderId"),
        accountId: access.actor.accountId,
        openedByRole: c.req.query("role") ?? null,
      });
      return c.json(result);
    } catch (error) {
      return c.json({ error: { code: "not_found", message: errorMessage(error) } }, 404);
    }
  });

  app.get("/ops", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const result = await services.listSupportOperationsQueue({
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
      status: c.req.query("status") || undefined,
      priority: c.req.query("priority") || undefined,
      search: c.req.query("search") || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/ops/:id", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const supportRequest = await services.getSupportOperationsRequest(c.req.param("id"));
    if (!supportRequest) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("support.features.support_requests.api.route.support_request.not.found"),
          },
        },
        404,
      );
    }

    return c.json(supportRequest);
  });

  app.post("/ops/escalate-overdue", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    const body = await c.req.json().catch(() => ({}));
    const result = await services.escalateOverdueSupportRequests(
      {
        limit: Number(body.limit ?? 100),
      },
      contextResult.context,
    );
    return c.json(result);
  });

  app.post("/ops/:id/evidence", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.2",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    const body = await c.req.json();
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as readonly unknown[]).map((entry) => String(entry))
      : [];
    try {
      const result = await services.submitEvidence(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          submittedByRole: "support",
          evidenceType: String(body.evidenceType ?? "support-note"),
          summary: String(body.summary ?? ""),
          occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : null,
          attachments,
          scope: "operations",
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "evidence-submitted" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/responses", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.3",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    const body = await c.req.json();
    try {
      const result = await services.recordResponse(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          submittedByRole: "support",
          responseType: String(body.responseType ?? ""),
          summary: String(body.summary ?? ""),
          offerResolutionType: typeof body.offerResolutionType === "string" ? body.offerResolutionType : null,
          refundAmount: typeof body.refundAmount === "string" ? body.refundAmount : null,
          ...(Array.isArray(body.affectedLineIds)
            ? { affectedLineIds: (body.affectedLineIds as readonly unknown[]).map((entry) => String(entry)) }
            : {}),
          ...(typeof body.refundCurrencyCode === "string" ? { refundCurrencyCode: body.refundCurrencyCode } : {}),
          scope: "operations",
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "response-recorded" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/escalate", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.4",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    const body = await c.req.json();
    try {
      const result = await services.escalateSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          reason: String(body.reason ?? ""),
          scope: "operations",
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "escalated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/resolve", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.5",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    const body = await c.req.json();
    try {
      const result = await services.resolveSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          resolutionType: String(body.resolutionType ?? ""),
          summary: String(body.summary ?? ""),
          refundAmount: typeof body.refundAmount === "string" ? body.refundAmount : null,
          ...(Array.isArray(body.affectedLineIds)
            ? { affectedLineIds: (body.affectedLineIds as readonly unknown[]).map((entry) => String(entry)) }
            : {}),
          ...(typeof body.refundCurrencyCode === "string" ? { refundCurrencyCode: body.refundCurrencyCode } : {}),
          responsibility: String(body.responsibility ?? ""),
          evidenceBasis: {
            type: String(body.evidenceBasis?.type ?? ""),
            reference: String(body.evidenceBasis?.reference ?? ""),
          },
          responsibilityReasonCode: String(body.responsibilityReasonCode ?? ""),
          scope: "operations",
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "resolved" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/return-delivery", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.8",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.recordReturnDelivery(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          deliveredAt: typeof body.deliveredAt === "string" ? body.deliveredAt : undefined,
          scope: "operations",
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "return-delivered" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/return-refund/release", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.9",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    try {
      const result = await services.releaseReturnRefund(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "return-refund-released" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/close", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.6",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    try {
      const result = await services.closeSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          scope: "operations",
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "closed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/cancel", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.7",
    );
    if (contextResult.response) {
      return contextResult.response;
    }

    const body = await c.req.json();
    try {
      const result = await services.cancelSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          reason: String(body.reason ?? ""),
          scope: "operations",
        },
        contextResult.context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "cancelled" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/:id", async (c) => {
    const access = requireSupportAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }

    const supportRequest = await services.getAccountSupportRequest(c.req.param("id"), access.actor.accountId);
    if (!supportRequest) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("support.features.support_requests.api.route.support_request.not.found"),
          },
        },
        404,
      );
    }

    return c.json(supportRequest);
  });

  app.post("/", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const affectedLineIds = Array.isArray(body.affectedLineIds)
        ? (body.affectedLineIds as readonly unknown[]).map((entry) => String(entry))
        : null;
      const result = await services.openSupportRequest(
        {
          orderId: String(body.orderId ?? ""),
          accountId: access.actor.accountId,
          flowType: String(body.flowType ?? ""),
          openedByRole: String(body.openedByRole ?? ""),
          ...(affectedLineIds !== null ? { affectedLineIds } : {}),
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "opened" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/evidence", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as readonly unknown[]).map((entry) => String(entry))
      : [];
    try {
      const result = await services.submitEvidence(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          submittedByRole: String(body.submittedByRole ?? ""),
          evidenceType: String(body.evidenceType ?? ""),
          summary: String(body.summary ?? ""),
          occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : null,
          attachments,
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "evidence-submitted" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/responses", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.recordResponse(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          submittedByRole: String(body.submittedByRole ?? ""),
          responseType: String(body.responseType ?? ""),
          summary: String(body.summary ?? ""),
          offerResolutionType: typeof body.offerResolutionType === "string" ? body.offerResolutionType : null,
          refundAmount: typeof body.refundAmount === "string" ? body.refundAmount : null,
          ...(Array.isArray(body.affectedLineIds)
            ? { affectedLineIds: (body.affectedLineIds as readonly unknown[]).map((entry) => String(entry)) }
            : {}),
          ...(typeof body.refundCurrencyCode === "string" ? { refundCurrencyCode: body.refundCurrencyCode } : {}),
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "response-recorded" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/offers/:offerId/accept", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.acceptOffer(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          offerId: c.req.param("offerId"),
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "offer-accepted" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/offers/:offerId/decline", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.declineOffer(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          offerId: c.req.param("offerId"),
          summary: typeof body.summary === "string" ? body.summary : null,
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "offer-declined" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/escalate", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.4"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.escalateSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          reason: String(body.reason ?? ""),
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "escalated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/return-condition-dispute", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.8"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.disputeReturnCondition(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          reason: String(body.reason ?? ""),
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "return-condition-disputed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/resolve", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.5"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.resolveSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          resolutionType: String(body.resolutionType ?? ""),
          summary: String(body.summary ?? ""),
          refundAmount: typeof body.refundAmount === "string" ? body.refundAmount : null,
          ...(Array.isArray(body.affectedLineIds)
            ? { affectedLineIds: (body.affectedLineIds as readonly unknown[]).map((entry) => String(entry)) }
            : {}),
          ...(typeof body.refundCurrencyCode === "string" ? { refundCurrencyCode: body.refundCurrencyCode } : {}),
          responsibility: String(body.responsibility ?? ""),
          evidenceBasis: {
            type: String(body.evidenceBasis?.type ?? ""),
            reference: String(body.evidenceBasis?.reference ?? ""),
          },
          responsibilityReasonCode: String(body.responsibilityReasonCode ?? ""),
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "resolved" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/close", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.6"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.closeSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "closed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/cancel", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.support_requests.api.route.authentication.context.missing.7"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.cancelSupportRequest(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          reason: String(body.reason ?? ""),
        },
        context,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "cancelled" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
