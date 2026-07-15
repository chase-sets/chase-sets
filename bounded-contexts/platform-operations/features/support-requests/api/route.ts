import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { SupportApiEnv } from "./http";
import type { SupportRequestServices } from "./runtime";
import { platformRemedyCapabilities, type PlatformRemedyCapability } from "../domain/platform-remedy-policy";
import { SupportEvidenceAttachmentError } from "./attachments";

function requireSupportAccess(
  c: {
    get(key: "actor"): SupportApiEnv["Variables"]["actor"];
  },
  permission: "support.view" | "support.manage" | PlatformRemedyCapability,
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

function isUploadedFile(value: FormDataEntryValue): value is File {
  return typeof value !== "string" && typeof value.arrayBuffer === "function";
}

function remedyTerms(body: Record<string, unknown>) {
  const remedy = (body.remedy ?? {}) as Record<string, unknown>;
  const allocation = (body.allocation ?? {}) as Record<string, unknown>;
  return {
    remedy: {
      kind: String(remedy.kind ?? "") as "full-refund" | "partial-refund",
      amount: String(remedy.amount ?? ""),
      currencyCode: String(remedy.currencyCode ?? ""),
    },
    allocation: {
      sellerFundedAmount: String(allocation.sellerFundedAmount ?? ""),
      platformFundedAmount: String(allocation.platformFundedAmount ?? ""),
      currencyCode: String(allocation.currencyCode ?? ""),
      fundingKind: String(allocation.fundingKind ?? "") as "seller-funded" | "platform-funded" | "split",
    },
    returnDirective: String(body.returnDirective ?? ""),
    refundTrigger: String(body.refundTrigger ?? ""),
    reasonCode: String(body.reasonCode ?? ""),
    returnExceptionReasonCode: body.returnExceptionReasonCode == null ? null : String(body.returnExceptionReasonCode),
  };
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(String) : String(value ?? "").split("\n");
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

  app.post("/ops/:id/remedy-proposals/preview", async (c) => {
    const access = requireSupportAccess(c, platformRemedyCapabilities.propose);
    if (access.response) {
      return access.response;
    }
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      return c.json(
        await services.previewRemedyProposal({
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          permissions: access.actor.permissions,
          terms: remedyTerms(body),
        }),
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/remedy-proposals", async (c) => {
    const access = requireSupportAccess(c, platformRemedyCapabilities.propose);
    if (access.response) return access.response;
    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.10",
    );
    if (contextResult.response) return contextResult.response;
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      const result = await services.proposeRemedy(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          permissions: access.actor.permissions,
          terms: remedyTerms(body),
          rationale: String(body.rationale ?? ""),
          evidenceReferences: stringList(body.evidenceReferences),
          idempotencyKey: `${String(body.idempotencyKey ?? "")}:${access.actor.accountId}`,
        },
        contextResult.context,
      );
      return c.json({
        id: result.supportRequestId,
        remedyId: result.remedyId,
        version: result.version,
        status: result.status,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/remedy-proposals/approve", async (c) => {
    const actor = c.get("actor");
    const permission = actor?.permissions.includes(platformRemedyCapabilities.approveElevated)
      ? platformRemedyCapabilities.approveElevated
      : platformRemedyCapabilities.approve;
    const access = requireSupportAccess(c, permission);
    if (access.response) return access.response;
    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.13",
    );
    if (contextResult.response) return contextResult.response;
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      const result = await services.approveRemedy(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          permissions: access.actor.permissions,
          reasonCode: String(body.reasonCode ?? ""),
          rationale: String(body.rationale ?? ""),
          evidenceReferences: stringList(body.evidenceReferences),
          idempotencyKey: `${String(body.idempotencyKey ?? "")}:${access.actor.accountId}`,
        },
        contextResult.context,
      );
      return c.json({
        id: result.supportRequestId,
        remedyId: result.remedyId,
        version: result.version,
        status: result.status,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/remedies/:remedyId/effects/:effect/retry", async (c) => {
    const access = requireSupportAccess(c, platformRemedyCapabilities.retry);
    if (access.response) return access.response;
    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.14",
    );
    if (contextResult.response) return contextResult.response;
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      const result = await services.retryRemedyEffect(
        {
          supportRequestId: c.req.param("id"),
          remedyId: parseTypedIdBoundary(c.req.param("remedyId"), "rmd", "remedyId"),
          accountId: access.actor.accountId,
          effect: c.req.param("effect"),
          reasonCode: String(body.reasonCode ?? ""),
          rationale: String(body.rationale ?? ""),
          idempotencyKey: `${String(body.idempotencyKey ?? "")}:${access.actor.accountId}`,
        },
        contextResult.context,
      );
      return c.json({
        id: result.supportRequestId,
        remedyId: result.remedyId,
        version: result.version,
        status: "retry-requested",
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/remedy-corrections", async (c) => {
    const access = requireSupportAccess(c, platformRemedyCapabilities.correct);
    if (access.response) return access.response;
    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.15",
    );
    if (contextResult.response) return contextResult.response;
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      const result = await services.requestRemedyCorrection(
        {
          supportRequestId: c.req.param("id"),
          accountId: access.actor.accountId,
          reasonCode: String(body.reasonCode ?? ""),
          rationale: String(body.rationale ?? ""),
          evidenceReferences: stringList(body.evidenceReferences),
          idempotencyKey: `${String(body.idempotencyKey ?? "")}:${access.actor.accountId}`,
        },
        contextResult.context,
      );
      return c.json({
        id: result.supportRequestId,
        remedyId: result.remedyId,
        version: result.version,
        status: "correction-requested",
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/remedies/:remedyId/effects", async (c) => {
    const access = requireSupportAccess(c, platformRemedyCapabilities.overrideReturn);
    if (access.response) {
      return access.response;
    }
    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.11",
    );
    if (contextResult.response) {
      return contextResult.response;
    }
    const body = await c.req.json();
    try {
      const effect = String(body.effect ?? "");
      if (effect !== "operator-release") {
        throw new Error(
          "Owning-context effects must arrive as correlated facts; operators may only record an operator release.",
        );
      }
      const idempotencyKey = String(body.idempotencyKey ?? "");
      const result = await services.recordRemedyEffect(
        {
          supportRequestId: c.req.param("id"),
          remedyId: parseTypedIdBoundary(c.req.param("remedyId"), "rmd", "remedyId"),
          coverageId: null,
          effect,
          outcome: "satisfied",
          sourceFactType: "support.support-request.operator-release-recorded",
          sourceFactId: idempotencyKey,
          idempotencyKey,
          occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : new Date().toISOString(),
          reasonCode: String(body.reasonCode ?? ""),
          refundId: null,
          amount: null,
          currencyCode: null,
          allocation: null,
        },
        contextResult.context,
      );
      return c.json({
        id: result.supportRequestId,
        remedyId: result.remedyId,
        version: result.version,
        status: "effect-recorded",
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/ops/:id/remedies/:remedyId/effects/:effect/override", async (c) => {
    const access = requireSupportAccess(c, platformRemedyCapabilities.waive);
    if (access.response) {
      return access.response;
    }
    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.12",
    );
    if (contextResult.response) {
      return contextResult.response;
    }
    const body = await c.req.json();
    try {
      const result = await services.overrideRemedyEffect(
        {
          supportRequestId: c.req.param("id"),
          remedyId: parseTypedIdBoundary(c.req.param("remedyId"), "rmd", "remedyId"),
          accountId: access.actor.accountId,
          effect: c.req.param("effect"),
          reasonCode: String(body.reasonCode ?? ""),
          rationale: String(body.rationale ?? ""),
          evidenceReferences: stringList(body.evidenceReferences),
          idempotencyKey: String(body.idempotencyKey ?? ""),
        },
        contextResult.context,
      );
      return c.json({
        id: result.supportRequestId,
        remedyId: result.remedyId,
        version: result.version,
        status: "effect-waived",
      });
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

  app.post("/:id/attachments", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }
    try {
      const formData = await c.req.formData();
      const files = formData.getAll("attachments").filter(isUploadedFile);
      const attachments = await services.uploadAttachments({
        supportRequestId: c.req.param("id"),
        accountId: access.actor.accountId,
        roleKey: access.actor.roleKey,
        uploads: await Promise.all(
          files.map(async (file) => ({
            body: new Uint8Array(await file.arrayBuffer()),
            contentType: file.type,
            filename: file.name || null,
          })),
        ),
      });
      if (!attachments) {
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
      return c.json({ attachments }, 201);
    } catch (error) {
      const code = error instanceof SupportEvidenceAttachmentError ? error.code : "attachment_upload_failed";
      return c.json(
        { error: { code, message: errorMessage(error) } },
        error instanceof SupportEvidenceAttachmentError && error.code === "storage-unavailable" ? 503 : 400,
      );
    }
  });

  app.get("/:id/attachments/:attachmentId", async (c) => {
    const access = requireSupportAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }
    try {
      const attachment = await services.getAttachment({
        supportRequestId: c.req.param("id"),
        attachmentId: c.req.param("attachmentId"),
        accountId: access.actor.accountId,
        roleKey: access.actor.roleKey,
      });
      if (!attachment) {
        return c.json(
          {
            error: {
              code: "not_found",
              message: t("support.features.support_requests.api.route.attachment.not.found"),
            },
          },
          404,
        );
      }
      return new Response(
        attachment.body.buffer.slice(
          attachment.body.byteOffset,
          attachment.body.byteOffset + attachment.body.byteLength,
        ) as ArrayBuffer,
        {
          headers: {
            "cache-control": "private, no-store",
            "content-type": attachment.contentType,
            "content-length": String(attachment.body.byteLength),
            "content-disposition": "inline",
            "x-content-type-options": "nosniff",
          },
        },
      );
    } catch (error) {
      const unavailable = error instanceof SupportEvidenceAttachmentError && error.code === "storage-unavailable";
      return c.json(
        {
          error: {
            code: unavailable ? error.code : "not_found",
            message: unavailable
              ? error.message
              : t("support.features.support_requests.api.route.attachment.not.found"),
          },
        },
        unavailable ? 503 : 404,
      );
    }
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
