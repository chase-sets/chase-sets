import { Hono } from "hono";
import type { SettlementApiEnv } from "../api";
import type { WalletServices } from "./runtime";

function requireWalletAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission: "payouts.view",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: "Authentication required." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: "Forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

export function createWalletRoutes(services: WalletServices) {
  const app = new Hono<SettlementApiEnv>();

  app.get("/wallet", async (c) => {
    const access = requireWalletAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const wallet = await services.getWallet(access.actor.accountId);
    return c.json(wallet);
  });

  app.get("/wallet/entries", async (c) => {
    const access = requireWalletAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listWalletEntries({
      accountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  return app;
}
