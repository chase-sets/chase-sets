import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { SupportApiEnv } from "./http";
import { accountRoleForSupportRequest, type SupportRequestServices } from "./runtime";
import { normalizeFlowType } from "../domain/common";
import { projectSupportFlow, projectSupportParticipantPolicy } from "./support-flow-projection";
import { platformRemedyCapabilities, type PlatformRemedyCapability } from "../domain/platform-remedy-policy";
import { SupportEvidenceAttachmentError } from "./attachments";
import { EvidenceAccessError } from "./evidence-access-audit";
import { SupportDomainError } from "../domain/common";
import {
  participantActions,
  participantAction,
  parseParticipantAttempt,
  ParticipantAttemptError,
  type ParticipantAction,
} from "../domain/participant-attempt";
import {
  readSupportAttachmentFormData,
  SupportAttachmentIntakeError,
  SUPPORT_ATTACHMENT_OPERATION_HEADER,
  validateSupportAttachmentOperationId,
} from "./attachment-intake";

function evidenceAccessResponse(error: EvidenceAccessError) {
  const code =
    error.status === 401
      ? "authentication_required"
      : error.status === 403
        ? "authorization_forbidden"
        : error.status === 404
          ? "not_found"
          : "evidence_unavailable";
  return new Response(
    JSON.stringify({ error: { code, message: t("support.features.support_requests.api.route.evidence.unavailable") } }),
    {
      status: error.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    },
  );
}

function evidenceValidationError(error: unknown) {
  return error instanceof SupportDomainError && error.message === "attachment_reference_unknown"
    ? {
        code: "attachment_reference_unknown",
        message: t("support.features.support_requests.api.route.attachment.reference.unknown"),
      }
    : { code: "validation_failed", message: errorMessage(error) };
}

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

  app.post("/participant-attempts/:attemptId/attachments", async (c) => {
    const access = requireSupportAccess(c, "support.manage");
    if (access.response) return access.response;
    const context = c.get("context");
    if (
      !context ||
      context.tenantId !== access.actor.tenantId ||
      context.audit.forAccountId !== access.actor.accountId ||
      context.audit.performedByUserId !== access.actor.userId
    )
      return new Response(null, { status: 403 });
    try {
      const operationId = c.req.header(SUPPORT_ATTACHMENT_OPERATION_HEADER) ?? "";
      validateSupportAttachmentOperationId(operationId);
      const form = await readSupportAttachmentFormData(c.req.raw);
      const attemptId = c.req.param("attemptId");
      if (form.get("attemptId") !== attemptId) throw new ParticipantAttemptError(400, "invalid-participant-attempt");
      const affectedLineIds = form.getAll("affectedLineIds").map(String);
      const attachments = await services.stageParticipantIntakeAttachments({
        attemptId,
        orderId: String(form.get("orderId") ?? ""),
        flowType: String(form.get("flowType") ?? ""),
        affectedLineIds: affectedLineIds.length ? affectedLineIds : null,
        operationId,
        actor: access.actor,
        uploads: async () => {
          const uploads = [];
          for (const file of form.getAll("attachments").filter(isUploadedFile))
            uploads.push({
              body: new Uint8Array(await file.arrayBuffer()),
              contentType: file.type,
              filename: file.name || null,
            });
          return uploads;
        },
      });
      return c.json({ attachments }, 201);
    } catch (error) {
      if (error instanceof EvidenceAccessError) return evidenceAccessResponse(error);
      if (error instanceof ParticipantAttemptError)
        return c.json({ error: { code: error.code, message: error.code } }, error.status);
      if (error instanceof SupportDomainError) return c.json({ error: evidenceValidationError(error) }, 400);
      if (error instanceof SupportAttachmentIntakeError)
        return c.json(
          {
            error: { code: error.code, message: t("support.features.support_requests.api.route.evidence.unavailable") },
          },
          error.status,
        );
      const code = error instanceof SupportEvidenceAttachmentError ? error.code : "attachment_upload_failed";
      return c.json(
        { error: { code, message: t("support.features.support_requests.api.route.evidence.unavailable") } },
        error instanceof SupportEvidenceAttachmentError && error.code !== "storage-unavailable" ? 400 : 503,
      );
    }
  });

  async function executeParticipantCommand(kind: ParticipantAction, c: Context<SupportApiEnv>) {
    const access = requireSupportAccess(c, "support.manage");
    const context = c.get("context");
    if (access.response || !context) {
      if (kind === "submit-evidence") {
        const body = await c.req.json().catch(() => null);
        if (body && Array.isArray(body.attachments) && body.attachments.length) {
          try {
            await services.submitEvidence(
              {
                supportRequestId: c.req.param("id") ?? "",
                actor: c.get("actor"),
                accountId: c.get("actor")?.accountId ?? "acc_support_evidence_anonymous",
                submittedByRole: "",
                evidenceType: "",
                summary: "",
                attachments: body.attachments,
              },
              context ?? undefined,
            );
          } catch (error) {
            if (error instanceof EvidenceAccessError) return evidenceAccessResponse(error);
            return evidenceAccessResponse(new EvidenceAccessError(503));
          }
        }
      }
      return access.response ?? new Response(null, { status: 401 });
    }
    if (
      context.tenantId !== access.actor.tenantId ||
      context.audit.forAccountId !== access.actor.accountId ||
      context.audit.performedByUserId !== access.actor.userId
    )
      return new Response(null, { status: 403 });
    let submittedBody: unknown;
    try {
      const attempt = parseParticipantAttempt({
        attemptId: c.req.header("Idempotency-Key"),
        requestHash: c.req.header("X-Support-Request-Hash"),
      });
      let body = await c.req.json();
      submittedBody = body;
      if (kind === "accept-offer" || kind === "decline-offer") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "offerId"))
          throw new ParticipantAttemptError(400, "invalid-participant-body");
        body = { ...body, offerId: c.req.param("offerId") };
      }
      const result = await services.executeParticipantAttempt(
        {
          actionKind: kind,
          attempt,
          accountId: access.actor.accountId,
          actor: access.actor,
          targetId: c.req.param("id"),
          body,
        },
        context,
      );
      return c.json(result, kind === "open-support-request" ? 201 : 200);
    } catch (error) {
      if (error instanceof EvidenceAccessError) return evidenceAccessResponse(error);
      if (error instanceof ParticipantAttemptError)
        return c.json(
          { error: { code: error.status === 400 ? "validation_failed" : error.code, message: error.code } },
          error.status,
        );
      if (error instanceof SupportDomainError || error instanceof SyntaxError)
        return c.json({ error: evidenceValidationError(error) }, 400);
      if (
        kind === "submit-evidence" &&
        submittedBody &&
        typeof submittedBody === "object" &&
        Array.isArray((submittedBody as Record<string, unknown>).attachments) &&
        ((submittedBody as Record<string, unknown>).attachments as unknown[]).length
      )
        return evidenceAccessResponse(new EvidenceAccessError(503));
      return c.json(
        { error: { code: "participant-authority-unavailable", message: "participant-authority-unavailable" } },
        503,
      );
    }
  }

  for (const path of ["/participant-attempts/:attemptId", "/:id/participant-attempts/:attemptId"]) {
    app.get(path, async (c) => {
      const access = requireSupportAccess(c, "support.view");
      if (access.response) return access.response;
      c.header("cache-control", "private, no-store");
      try {
        const query = new URL(c.req.url).searchParams;
        const isOpen = !c.req.param("id");
        const allowed = isOpen ? ["requestHash"] : ["requestHash", "actionKind"];
        if (
          [...query.keys()].some((key) => !allowed.includes(key)) ||
          allowed.some((key) => query.getAll(key).length !== 1)
        )
          throw new ParticipantAttemptError(400, "invalid-participant-query");
        const actionKind = isOpen ? "open-support-request" : participantAction(query.get("actionKind") ?? "");
        if (!isOpen && actionKind === "open-support-request")
          throw new ParticipantAttemptError(400, "invalid-participant-action");
        const attempt = parseParticipantAttempt({
          attemptId: c.req.param("attemptId"),
          requestHash: query.get("requestHash"),
        });
        return c.json(
          await services.getParticipantAttempt({
            actionKind,
            attempt,
            targetId: c.req.param("id"),
            accountId: access.actor.accountId,
            tenantId: access.actor.tenantId,
          }),
        );
      } catch (error) {
        if (error instanceof ParticipantAttemptError && error.status === 400)
          return c.json({ error: { code: error.code } }, 400);
        return c.json({ outcome: "unknown", reason: "authority-unavailable" });
      }
    });
  }

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
      flowType: c.req.query("flowType") || undefined,
      contested: c.req.query("contested") === "true" || undefined,
      overdue: c.req.query("overdue") === "true" || undefined,
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

    const definition = await services.resolveSupportFlowDefinition(normalizeFlowType(supportRequest.flow_type));
    return c.json({
      ...supportRequest,
      flow: projectSupportFlow(definition, "support", supportRequest),
    });
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
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return access.response ?? new Response(null, { status: 400 });
    const attachments = Array.isArray(body.attachments) ? (body.attachments as readonly unknown[]).map(String) : [];
    if (access.response && attachments.length === 0) {
      return access.response;
    }

    const contextResult = requireCommandContext(
      c,
      "support.features.support_requests.api.route.authentication.context.missing.2",
    );
    if (contextResult.response && attachments.length === 0) {
      return contextResult.response;
    }

    try {
      const result = await services.submitEvidence(
        {
          supportRequestId: c.req.param("id"),
          accountId: c.get("actor")?.accountId ?? "acc_support_evidence_anonymous",
          ...(attachments.length ? { actor: c.get("actor") } : {}),
          submittedByRole: "support",
          evidenceType: String(body.evidenceType ?? "support-note"),
          summary: String(body.summary ?? ""),
          occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : null,
          attachments,
          ...(typeof body.attachmentOperationId === "string"
            ? { attachmentOperationId: body.attachmentOperationId }
            : {}),
          scope: "operations",
        },
        contextResult.context ?? undefined,
      );
      return c.json({ id: result.supportRequestId, version: result.version, status: "evidence-submitted" });
    } catch (error) {
      if (error instanceof EvidenceAccessError) return evidenceAccessResponse(error);
      if (attachments.length && !(error instanceof SupportDomainError))
        return evidenceAccessResponse(new EvidenceAccessError(503));
      return c.json({ error: evidenceValidationError(error) }, 400);
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

    const role = accountRoleForSupportRequest(supportRequest, access.actor.accountId);
    const definition = await services.resolveSupportFlowDefinition(normalizeFlowType(supportRequest.flow_type));
    const flow = projectSupportFlow(definition, role, supportRequest);
    return c.json({
      ...supportRequest,
      flow,
      participantPolicy: projectSupportParticipantPolicy(
        supportRequest,
        { role, accountId: access.actor.accountId },
        flow,
      ),
    });
  });

  app.post("/:id/attachments", async (c) => {
    try {
      const attachments = await services.uploadAttachments({
        supportRequestId: c.req.param("id"),
        operationId: c.req.header(SUPPORT_ATTACHMENT_OPERATION_HEADER) ?? "",
        actor: c.get("actor"),
        uploads: async () => {
          const operationId = c.req.header(SUPPORT_ATTACHMENT_OPERATION_HEADER);
          validateSupportAttachmentOperationId(operationId ?? "");
          const formData = await readSupportAttachmentFormData(c.req.raw);
          const files = formData.getAll("attachments").filter(isUploadedFile);
          const uploads = [];
          for (const file of files) {
            uploads.push({
              body: new Uint8Array(await file.arrayBuffer()),
              contentType: file.type,
              filename: file.name || null,
            });
          }
          return uploads;
        },
      });
      return c.json({ attachments }, 201);
    } catch (error) {
      if (error instanceof EvidenceAccessError) return evidenceAccessResponse(error);
      if (error instanceof SupportAttachmentIntakeError)
        return c.json(
          {
            error: { code: error.code, message: t("support.features.support_requests.api.route.evidence.unavailable") },
          },
          error.status,
        );
      const code = error instanceof SupportEvidenceAttachmentError ? error.code : "attachment_upload_failed";
      return c.json(
        { error: { code, message: t("support.features.support_requests.api.route.evidence.unavailable") } },
        error instanceof SupportEvidenceAttachmentError && error.code !== "storage-unavailable" ? 400 : 503,
      );
    }
  });

  app.get("/:id/attachments/:attachmentId", async (c) => {
    try {
      const attachment = await services.getAttachment({
        supportRequestId: c.req.param("id"),
        attachmentId: c.req.param("attachmentId"),
        actor: c.get("actor"),
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
      if (error instanceof EvidenceAccessError) return evidenceAccessResponse(error);
      const unavailable = !(error instanceof SupportEvidenceAttachmentError) || error.code === "storage-unavailable";
      return c.json(
        {
          error: {
            code: unavailable ? "evidence_unavailable" : "not_found",
            message: unavailable
              ? t("support.features.support_requests.api.route.evidence.unavailable")
              : t("support.features.support_requests.api.route.attachment.not.found"),
          },
        },
        unavailable ? 503 : 404,
      );
    }
  });

  // Records CleanupRequired only; the worker's bound runner alone claims, deletes and confirms.
  app.post("/ops/:id/attachment-operations/:operationId/cleanup", async (c) => {
    c.header("cache-control", "private, no-store");
    try {
      const result = await services.requestAttachmentCleanup({
        supportRequestId: c.req.param("id"),
        operationId: c.req.param("operationId"),
        actor: c.get("actor"),
      });
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof EvidenceAccessError) return evidenceAccessResponse(error);
      if (
        error instanceof SupportAttachmentIntakeError ||
        (error instanceof SupportDomainError && error.message === "attachment_operation_unknown")
      )
        return evidenceAccessResponse(new EvidenceAccessError(404));
      if (error instanceof SupportDomainError && error.message === "attachment_operation_referenced")
        return c.json(
          {
            error: {
              code: "attachment_operation_referenced",
              message: t("support.features.support_requests.api.route.attachment.operation.referenced"),
            },
          },
          409,
        );
      return evidenceAccessResponse(new EvidenceAccessError(503));
    }
  });

  app.get("/ops/:id/attachments/access-audit", async (c) => {
    c.header("cache-control", "private, no-store");
    c.header("x-content-type-options", "nosniff");
    try {
      return c.json(
        await services.getEvidenceAccessAudit({
          supportRequestId: c.req.param("id"),
          actor: c.get("actor"),
          cursor: c.req.query("cursor"),
        }),
      );
    } catch (error) {
      return evidenceAccessResponse(error instanceof EvidenceAccessError ? error : new EvidenceAccessError(503));
    }
  });

  app.post("/", (c) => executeParticipantCommand("open-support-request", c));

  app.post("/:id/evidence", (c) => executeParticipantCommand("submit-evidence", c));

  app.post("/:id/responses", (c) => executeParticipantCommand("record-response", c));

  app.post("/:id/offers/:offerId/accept", (c) => executeParticipantCommand("accept-offer", c));

  app.post("/:id/offers/:offerId/decline", (c) => executeParticipantCommand("decline-offer", c));

  app.post("/:id/escalate", (c) => executeParticipantCommand("escalate", c));

  app.post("/:id/return-condition-dispute", (c) => executeParticipantCommand("return-condition-dispute", c));

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

  app.post("/:id/close", (c) => executeParticipantCommand("close", c));

  app.post("/:id/cancel", (c) => executeParticipantCommand("cancel", c));

  return app;
}
