import { Hono } from "hono";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, LedgerEntryId, PaymentId } from "@chase-sets/primitives/typed-ids";
import type { SettlementApiEnv } from "../../../api";
import type { WalletServices } from "./runtime";
import { normalizeCurrencyCode } from "../../../support/runtime-support/common";

function requireWalletAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission: "payouts.view" | "payouts.manage",
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

async function postOperatorWalletEntry(
  services: WalletServices,
  params: Readonly<{
    body: Record<string, unknown>;
    accountId: string;
    kind: "refund" | "adjustment";
    direction: "credit" | "debit";
    defaultDescription: string;
    context: NonNullable<SettlementApiEnv["Variables"]["context"]>;
  }>,
) {
  return services.postEntry(
    {
      accountId: String(params.body.accountId ?? params.accountId) as AccountId,
      ledgerEntryId: createId("led") as LedgerEntryId,
      kind: params.kind,
      direction: params.direction,
      amount: String(params.body.amount ?? ""),
      currencyCode: normalizeCurrencyCode(String(params.body.currencyCode ?? "usd")),
      fundsStatus: "available",
      paymentId: params.body.paymentId
        ? String(params.body.paymentId) as PaymentId
        : null,
      description: String(params.body.description ?? params.defaultDescription),
      postedAt: new Date().toISOString(),
    },
    params.context,
  );
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

  app.post("/wallet/adjustments", async (c) => {
    const access = requireWalletAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();
    const workflow = String(body.workflow ?? "");
    const direction = workflow === "dispute-release" ? "credit" : "debit";
    const kind = workflow === "seller-refund-debit" ? "refund" : "adjustment";
    const description = String(
      body.description ??
        (workflow === "seller-refund-debit"
          ? "Seller refund adjustment"
          : workflow === "dispute-release"
            ? "Dispute hold released"
            : "Dispute hold"),
    );

    try {
      const result = await postOperatorWalletEntry(services, {
        body,
        accountId: access.actor.accountId,
        kind,
        direction,
        defaultDescription: description,
        context,
      });

      return c.json(result, 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Adjustment failed." },
        400,
      );
    }
  });

  app.post("/wallet/refund-debits", async (c) => {
    const access = requireWalletAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }
    const body = await c.req.json();

    try {
      return c.json(
        await postOperatorWalletEntry(services, {
          body,
          accountId: access.actor.accountId,
          kind: "refund",
          direction: "debit",
          defaultDescription: "Seller refund debit",
          context,
        }),
        201,
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Refund debit failed." },
        400,
      );
    }
  });

  app.post("/wallet/dispute-holds", async (c) => {
    const access = requireWalletAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }
    const body = await c.req.json();

    try {
      return c.json(
        await postOperatorWalletEntry(services, {
          body,
          accountId: access.actor.accountId,
          kind: "adjustment",
          direction: "debit",
          defaultDescription: "Dispute hold",
          context,
        }),
        201,
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Dispute hold failed." },
        400,
      );
    }
  });

  app.post("/wallet/dispute-releases", async (c) => {
    const access = requireWalletAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }
    const body = await c.req.json();

    try {
      return c.json(
        await postOperatorWalletEntry(services, {
          body,
          accountId: access.actor.accountId,
          kind: "adjustment",
          direction: "credit",
          defaultDescription: "Dispute hold released",
          context,
        }),
        201,
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Dispute release failed." },
        400,
      );
    }
  });

  return app;
}
