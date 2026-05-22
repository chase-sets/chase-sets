import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { accountBadgeKeys, type AccountBadgeKey } from "../domain/domain";
import type { AccountServices } from "./runtime";

function readAccountBadgeKey(value: unknown): AccountBadgeKey | null {
  return typeof value === "string" && accountBadgeKeys.includes(value as AccountBadgeKey)
    ? (value as AccountBadgeKey)
    : null;
}

function canManageAccount(actor: IdentityApiEnv["Variables"]["actor"], accountId: string) {
  return !actor || actor.roleKey === "platform-admin" || actor.accountId === accountId;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.accounts.api.route.forbidden"),
    },
  };
}

export function accountRoutes(services: AccountServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const accountId = body.accountId as AccountId;
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
    const accountId = c.req.param("id");
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
    const accountId = c.req.param("id");
    if (!canManageAccount(c.var.actor, accountId)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "SuspendAccount" },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/reactivate", async (c) => {
    const accountId = c.req.param("id");
    if (!canManageAccount(c.var.actor, accountId)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "ReactivateAccount" },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/close", async (c) => {
    const accountId = c.req.param("id");
    if (!canManageAccount(c.var.actor, accountId)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "CloseAccount" },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/badges", async (c) => {
    const accountId = c.req.param("id");
    if (!canManageAccount(c.var.actor, accountId)) {
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
    const accountId = c.req.param("id");
    if (!canManageAccount(c.var.actor, accountId)) {
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
    if (actor && actor.roleKey !== "platform-admin") {
      const account = await services.getAccount(actor.accountId);
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
    const accountId = c.req.param("id");
    if (actor && !canManageAccount(actor, accountId)) {
      return c.json(forbidden(), 403);
    }

    const account = await services.getAccount(accountId);
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
