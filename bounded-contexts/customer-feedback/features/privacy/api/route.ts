import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import { Hono } from "hono";
import type { createCustomerFeedbackPrivacyRuntime } from "./runtime";
import {
  customerFeedbackRedactionScopes,
  normalizePrivacyReason,
  privacyPermission,
  type CustomerFeedbackPrivacyCapability,
  type CustomerFeedbackRedactionScope,
} from "../domain/policy";

type PrivacyRuntime = ReturnType<typeof createCustomerFeedbackPrivacyRuntime>;
type CustomerFeedbackPrivacyApiEnv = AuthenticatedApiEnv;

export function buildCustomerFeedbackPrivacyApi(runtime: PrivacyRuntime) {
  const app = new Hono<CustomerFeedbackPrivacyApiEnv>();

  app.get("/privacy/responses/:invitationId", async (c) => {
    const actor = requireCapability(c, "view-comments");
    if (actor instanceof Response) return actor;
    const response = await runtime.readSensitiveResponse(
      c.req.param("invitationId"),
      actor.userId,
      new Date().toISOString(),
    );
    return response
      ? c.json({ response }, 200, { "Cache-Control": "no-store" })
      : c.json({ error: { code: "not_found" } }, 404);
  });

  app.post("/privacy/responses/:invitationId/redactions", async (c) => {
    const actor = requireCapability(c, "redact-feedback");
    if (actor instanceof Response) return actor;
    const body = await c.req.json<{
      scope?: string;
      reason?: string;
      idempotencyKey?: string;
    }>();
    if (!customerFeedbackRedactionScopes.includes(body.scope as CustomerFeedbackRedactionScope)) {
      return c.json({ error: { code: "invalid_redaction_scope" } }, 400);
    }
    const reason = privacyReason(body.reason);
    if (!reason || !body.idempotencyKey?.trim()) {
      return c.json({ error: { code: "redaction_reason_and_idempotency_required" } }, 400);
    }
    const invitation = await runtime.redact(
      c.req.param("invitationId"),
      {
        scope: body.scope as CustomerFeedbackRedactionScope,
        reason,
        actorId: actor.userId,
        idempotencyKey: body.idempotencyKey,
        redactedAt: new Date().toISOString(),
      },
      eventContext(actor),
    );
    return c.json({ invitationId: invitation.invitationId, redactedScopes: invitation.redactedScopes });
  });

  app.post("/privacy/responses/:invitationId/holds", async (c) => {
    const actor = requireCapability(c, "manage-feedback-holds");
    if (actor instanceof Response) return actor;
    const body = await c.req.json<{ holdId?: string; reason?: string }>();
    const reason = privacyReason(body.reason);
    if (!reason) return c.json({ error: { code: "hold_reason_code_required" } }, 400);
    const holdId = body.holdId?.trim() || createId("cfhold");
    const invitation = await runtime.placeHold(
      c.req.param("invitationId"),
      { holdId, reason, actorId: actor.userId, placedAt: new Date().toISOString() },
      eventContext(actor),
    );
    return c.json({ invitationId: invitation.invitationId, hold: invitation.privacyHold }, 201);
  });

  app.post("/privacy/responses/:invitationId/holds/:holdId/release", async (c) => {
    const actor = requireCapability(c, "manage-feedback-holds");
    if (actor instanceof Response) return actor;
    const body = await c.req.json<{ reason?: string }>();
    const reason = privacyReason(body.reason);
    if (!reason) return c.json({ error: { code: "hold_release_reason_code_required" } }, 400);
    const invitation = await runtime.releaseHold(
      c.req.param("invitationId"),
      {
        holdId: c.req.param("holdId"),
        reason,
        actorId: actor.userId,
        releasedAt: new Date().toISOString(),
      },
      eventContext(actor),
    );
    return c.json({ invitationId: invitation.invitationId, hold: invitation.privacyHold });
  });

  app.get("/privacy/audit", async (c) => {
    const actor = requireCapability(c, "audit-feedback-privacy");
    if (actor instanceof Response) return actor;
    const items = await runtime.queryAudit({
      invitationId: c.req.query("invitationId"),
      action: c.req.query("action"),
      limit: Number(c.req.query("limit") ?? 100),
    });
    return c.json({ items }, 200, { "Cache-Control": "no-store" });
  });

  app.post("/privacy/retention/runs", async (c) => {
    const actor = requireCapability(c, "redact-feedback");
    if (actor instanceof Response) return actor;
    const body = await c.req.json<{ runId?: string; mode?: "preview" | "execute"; batchLimit?: number }>();
    if (body.mode !== "preview" && body.mode !== "execute") {
      return c.json({ error: { code: "retention_mode_required" } }, 400);
    }
    const result = await runtime.runRetentionBatch(
      { runId: body.runId, mode: body.mode, batchLimit: body.batchLimit },
      eventContext(actor),
    );
    return c.json(result, result.state === "completed" ? 200 : 202);
  });

  return app;
}

function requireCapability(
  c: { get(key: "actor"): CustomerFeedbackPrivacyApiEnv["Variables"]["actor"] },
  capability: CustomerFeedbackPrivacyCapability,
) {
  const actor = c.get("actor");
  if (!actor) return new Response(JSON.stringify({ error: { code: "authentication_required" } }), { status: 401 });
  if (!actor.permissions.includes(privacyPermission(capability))) {
    return new Response(JSON.stringify({ error: { code: "authorization_forbidden" } }), { status: 403 });
  }
  return actor;
}

function eventContext(actor: NonNullable<CustomerFeedbackPrivacyApiEnv["Variables"]["actor"]>): EventStoreContext {
  return {
    tenantId: actor.tenantId as TenantId,
    audit: {
      performedByUserId: actor.userId as UserId,
      forAccountId: actor.accountId as AccountId,
    },
  };
}

function privacyReason(value: string | undefined): string | null {
  try {
    return normalizePrivacyReason(value ?? "");
  } catch {
    return null;
  }
}
