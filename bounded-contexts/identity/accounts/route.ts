import { Hono } from "hono";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../api";
import type { AccountServices } from "./runtime";

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
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "SuspendAccount" },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/reactivate", async (c) => {
    const accountId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "ReactivateAccount" },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.post("/:id/close", async (c) => {
    const accountId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "CloseAccount" },
      context: c.get("context"),
    });
    return c.json({ id: accountId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listAccounts({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const account = await services.getAccount(c.req.param("id"));
    if (!account) {
      return c.json({ error: "Account not found." }, 404);
    }
    return c.json(account);
  });

  return app;
}
