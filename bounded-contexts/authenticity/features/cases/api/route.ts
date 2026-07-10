import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { AuthenticityApiEnv } from "../../../api";
import { AuthenticityDomainError } from "../../../support/runtime-support/common";
import type { AuthenticityCaseServices } from "./runtime";

function domainErrorResponse(error: unknown) {
  if (error instanceof AuthenticityDomainError) {
    return {
      status: 409 as const,
      body: { error: { code: "authenticity_case_invalid_transition", message: error.message } },
    };
  }

  return {
    status: 400 as const,
    body: {
      error: {
        code: "validation_failed",
        message: error instanceof Error ? error.message : t("authenticity.api.request.failed"),
      },
    },
  };
}

export function authenticityCaseRoutes(services: AuthenticityCaseServices) {
  const app = new Hono<AuthenticityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.openCase(
        {
          caseId: body.caseId ?? null,
          orderId: String(body.orderId ?? ""),
          sellerAccountId: body.sellerAccountId,
          buyerAccountId: body.buyerAccountId,
          orderSnapshot: body.orderSnapshot,
          authenticityPlan: body.authenticityPlan,
        },
        c.get("context"),
      );
      const state = await services.getCase(result.caseId);
      return c.json({ case: state }, 201);
    } catch (error) {
      const response = domainErrorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get("/", async (c) => {
    const status = c.req.query("status") ?? null;
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const items = await services.listOperatorQueue({ status, limit, offset });
    return c.json({ items, count: items.length });
  });

  app.get("/by-order/:orderId", async (c) => {
    const item = await services.getCaseByOrderId(c.req.param("orderId"));
    if (!item) {
      return c.json(
        { error: { code: "authenticity_case_not_found", message: t("authenticity.api.case.not.found") } },
        404,
      );
    }
    return c.json({ case: item });
  });

  app.get("/:id", async (c) => {
    const item = await services.getCase(c.req.param("id"));
    if (!item) {
      return c.json(
        { error: { code: "authenticity_case_not_found", message: t("authenticity.api.case.not.found") } },
        404,
      );
    }
    return c.json({ case: item });
  });

  app.post("/:id/inbound-tracking", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.recordInboundTracking(
        { caseId: c.req.param("id"), inboundTrackingIdentifier: String(body.inboundTrackingIdentifier ?? "") },
        c.get("context"),
      );
      const state = await services.getCase(result.caseId);
      return c.json({ case: state });
    } catch (error) {
      const response = domainErrorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/:id/receive", async (c) => {
    try {
      const result = await services.receiveCase({ caseId: c.req.param("id") }, c.get("context"));
      const state = await services.getCase(result.caseId);
      return c.json({ case: state });
    } catch (error) {
      const response = domainErrorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/:id/inspection/start", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.beginInspection(
        { caseId: c.req.param("id"), inspectorAccountId: String(body.inspectorAccountId ?? c.get("actor").accountId) },
        c.get("context"),
      );
      const state = await services.getCase(result.caseId);
      return c.json({ case: state });
    } catch (error) {
      const response = domainErrorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/:id/verdict", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.recordVerdict(
        {
          caseId: c.req.param("id"),
          verdict: body.verdict,
          reasonCodes: body.reasonCodes ?? [],
          checklistResults: body.checklistResults ?? [],
          evidencePhotoRefs: body.evidencePhotoRefs ?? [],
          lineNotes: body.lineNotes ?? [],
          inspectorAccountId: String(body.inspectorAccountId ?? c.get("actor").accountId),
        },
        c.get("context"),
      );
      const state = await services.getCase(result.caseId);
      return c.json({ case: state });
    } catch (error) {
      const response = domainErrorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/:id/forward", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.forwardCase(
        { caseId: c.req.param("id"), outboundTrackingIdentifier: body.outboundTrackingIdentifier ?? null },
        c.get("context"),
      );
      const state = await services.getCase(result.caseId);
      return c.json({ case: state });
    } catch (error) {
      const response = domainErrorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/:id/return", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await services.returnCase(
        { caseId: c.req.param("id"), returnReason: body.returnReason ?? null },
        c.get("context"),
      );
      const state = await services.getCase(result.caseId);
      return c.json({ case: state });
    } catch (error) {
      const response = domainErrorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  return app;
}
