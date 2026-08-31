import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import {
  accountEnforcementReasonCodes,
  accountEnforcementReversalReasonCodes,
  type AccountEnforcementReference,
} from "@chase-sets/event-core";
import { createId, parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import { accountBadgeKeys, type AccountBadgeKey } from "../domain/domain";
import type { AccountServices } from "./runtime";
import type { AccountEnforcementRequest } from "./contracts";

function readAccountBadgeKey(value: unknown): AccountBadgeKey | null {
  return typeof value === "string" && accountBadgeKeys.includes(value as AccountBadgeKey)
    ? (value as AccountBadgeKey)
    : null;
}

function canManageAccount(actor: IdentityApiEnv["Variables"]["actor"], accountId: string) {
  return !actor || actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.accountId === accountId;
}

function canManageAccountBadges(actor: IdentityApiEnv["Variables"]["actor"]) {
  return actor?.roleKey === PLATFORM_ADMIN_ROLE_KEY;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.accounts.api.route.forbidden"),
    },
  };
}

function validationFailed(error: unknown) {
  return {
    error: {
      code: "validation_failed",
      message: error instanceof Error ? error.message : "Account enforcement request is invalid.",
    },
  };
}

async function readAccountEnforcementRequest<Reason extends string>(
  request: Request,
  allowedReasons: readonly Reason[],
): Promise<AccountEnforcementRequest<Reason>> {
  const rawBody = await request.text();
  if (rawBody.length === 0) {
    return { reason: "operator-other" as Reason, reference: null };
  }

  const value: unknown = JSON.parse(rawBody);
  if (!isRecord(value)) {
    throw new Error("Account enforcement request must be a JSON object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    return { reason: "operator-other" as Reason, reference: null };
  }
  if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "reference") {
    throw new Error("Account enforcement request must contain exactly reason and reference.");
  }
  if (typeof value.reason !== "string" || !allowedReasons.includes(value.reason as Reason)) {
    throw new Error("Account enforcement reason is invalid for this action.");
  }

  return {
    reason: value.reason as Reason,
    reference: readAccountEnforcementReference(value.reference),
  };
}

function readAccountEnforcementReference(value: unknown): AccountEnforcementReference | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("Account enforcement reference is invalid.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "supportRequestId") {
    throw new Error("Account enforcement reference is invalid.");
  }
  if (value.kind !== "support-request" || typeof value.supportRequestId !== "string") {
    throw new Error("Account enforcement reference is invalid.");
  }
  return {
    kind: "support-request",
    supportRequestId: parseStrictTypedUlid(value.supportRequestId, "sup"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function accountRoutes(services: AccountServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const accountId = parseTypedIdBoundary(body.accountId, "acc", "accountId");
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "CreateAccount",
        accountId,
        name: body.name,
        accountType: body.accountType,
        displayName: body.displayName,
      },
      context,
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const body = await c.req.json();
    const accountId = parseTypedIdBoundary(c.req.param("id"), "acc", "accountId");
    if (!canManageAccount(c.var.actor, accountId)) {
      return c.json(forbidden(), 403);
    }
    const context = c.get("context");
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "UpdateAccountProfile",
        name: body.name,
        displayName: body.displayName,
      },
      context,
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/suspend", async (c) => {
    const accountId = parseTypedIdBoundary(c.req.param("id"), "acc", "accountId");
    if (!canManageAccount(c.var.actor, accountId)) {
      return c.json(forbidden(), 403);
    }
    let request: AccountEnforcementRequest<(typeof accountEnforcementReasonCodes)[number]>;
    try {
      request = await readAccountEnforcementRequest(c.req.raw, accountEnforcementReasonCodes);
    } catch (error) {
      return c.json(validationFailed(error), 400);
    }
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "SuspendAccount",
        enforcement: { version: 1, enforcementActionId: createId("enf"), ...request },
      },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/reactivate", async (c) => {
    const accountId = parseTypedIdBoundary(c.req.param("id"), "acc", "accountId");
    if (!canManageAccount(c.var.actor, accountId)) {
      return c.json(forbidden(), 403);
    }
    let request: AccountEnforcementRequest<(typeof accountEnforcementReversalReasonCodes)[number]>;
    try {
      request = await readAccountEnforcementRequest(c.req.raw, accountEnforcementReversalReasonCodes);
    } catch (error) {
      return c.json(validationFailed(error), 400);
    }
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "ReactivateAccount",
        enforcement: { version: 1, enforcementActionId: createId("enf"), ...request },
      },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/close", async (c) => {
    const accountId = parseTypedIdBoundary(c.req.param("id"), "acc", "accountId");
    if (!canManageAccount(c.var.actor, accountId)) {
      return c.json(forbidden(), 403);
    }
    let request: AccountEnforcementRequest<(typeof accountEnforcementReasonCodes)[number]>;
    try {
      request = await readAccountEnforcementRequest(c.req.raw, accountEnforcementReasonCodes);
    } catch (error) {
      return c.json(validationFailed(error), 400);
    }
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "CloseAccount",
        enforcement: { version: 1, enforcementActionId: createId("enf"), ...request },
      },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/badges", async (c) => {
    const accountId = parseTypedIdBoundary(c.req.param("id"), "acc", "accountId");
    if (!canManageAccountBadges(c.var.actor)) {
      return c.json(forbidden(), 403);
    }
    const body = await c.req.json();
    const badgeKey = readAccountBadgeKey(body.badgeKey);
    if (!badgeKey) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("identity.features.accounts.api.route.account.badge.not.supported"),
          },
        },
        400,
      );
    }

    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "AssignAccountBadge",
        badgeKey,
      },
      context: c.get("context"),
    });
    return c.json({
      id: accountId,
      version: result.version,
      status: result.state.status,
      badges: result.state.badges,
    });
  });

  app.delete("/:id/badges/:badgeKey", async (c) => {
    const accountId = parseTypedIdBoundary(c.req.param("id"), "acc", "accountId");
    if (!canManageAccountBadges(c.var.actor)) {
      return c.json(forbidden(), 403);
    }
    const badgeKey = readAccountBadgeKey(c.req.param("badgeKey"));
    if (!badgeKey) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("identity.features.accounts.api.route.account.badge.not.supported"),
          },
        },
        400,
      );
    }

    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "RemoveAccountBadge",
        badgeKey,
      },
      context: c.get("context"),
    });
    return c.json({
      id: accountId,
      version: result.version,
      status: result.state.status,
      badges: result.state.badges,
    });
  });

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset } = c.req.query();
    if (actor && actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY) {
      const account = await services.getAccountForRead(actor.accountId);
      const items = account ? [account] : [];
      return c.json({ items, total: items.length, count: items.length });
    }

    const result = await services.listAccounts({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const actor = c.var.actor;
    const accountId = parseTypedIdBoundary(c.req.param("id"), "acc", "accountId");
    if (actor && !canManageAccount(actor, accountId)) {
      return c.json(forbidden(), 403);
    }

    const account = await services.getAccountForRead(accountId);
    if (!account) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.accounts.api.route.account.not.found") } },
        404,
      );
    }
    return c.json(account);
  });

  return app;
}
