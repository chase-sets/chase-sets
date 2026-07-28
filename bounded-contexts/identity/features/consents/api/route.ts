import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { IdentityApiEnv } from "../../../api";
import { hasPermission } from "../../../support/request-support/permissions";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import { authorizeConsentForActor } from "../domain/consent-recording-authorization";
import type { ConsentServices } from "./runtime";

function authenticationRequired() {
  return {
    error: {
      code: "authentication_required",
      message: t("identity.features.consents.api.route.authentication.required"),
    },
  };
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.consents.api.route.withdraw.forbidden"),
    },
  };
}

export function consentRoutes(services: ConsentServices) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(authenticationRequired(), 401);
    }

    const canManageSecurity = hasPermission(actor, "security.manage");
    const { search, status, limit, offset, userId, accountId } = c.req.query();
    const result = await services.listConsents({
      search,
      status,
      userId: canManageSecurity ? userId : actor.userId,
      accountId: canManageSecurity ? accountId : actor.accountId,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.post("/:id/withdraw", async (c) => {
    const actor = c.var.actor;
    const context = c.var.context;
    if (!actor || !context) {
      return c.json(authenticationRequired(), 401);
    }

    const consentId = parseTypedIdBoundary(c.req.param("id"), "cns", "consentId");
    const consent = await services.getConsent(consentId);
    if (!consent) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.consents.api.route.consent.not.found") } },
        404,
      );
    }

    const canWithdrawOwnUserConsent = consent.subject_type === "user" && consent.user_id === actor.userId;
    const canWithdrawAccountConsent =
      consent.subject_type === "account" &&
      consent.account_id === actor.accountId &&
      hasPermission(actor, "accounts.manage");
    const canManageConsent =
      actor.roleKey === PLATFORM_ADMIN_ROLE_KEY ||
      (consent.account_id === actor.accountId && hasPermission(actor, "security.manage"));
    if (!canWithdrawOwnUserConsent && !canWithdrawAccountConsent && !canManageConsent) {
      return c.json(forbidden(), 403);
    }
    if (!consent.is_current) {
      return c.json(
        {
          error: {
            code: "consent_superseded",
            message: t("identity.features.consents.api.route.consent.superseded"),
          },
        },
        409,
      );
    }
    if (consent.status === "withdrawn") {
      return c.json({ id: consentId, status: consent.status, withdrawnAt: consent.withdrawn_at });
    }

    const result = await services.commandHandler({
      streamId: `identity.consent-${consentId}`,
      command: { type: "WithdrawConsent", withdrawnAt: new Date().toISOString() },
      context,
      authorization: authorizeConsentForActor(context),
    });
    return c.json({
      id: consentId,
      version: result.version,
      status: result.state.status,
      withdrawnAt: result.state.withdrawnAt,
    });
  });

  return app;
}
