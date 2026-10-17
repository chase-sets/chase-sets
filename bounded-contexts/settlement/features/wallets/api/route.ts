import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { SettlementApiEnv } from "../../../api";
import type { WalletServices } from "./runtime";

function requireWalletAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission: "payouts.view" | "payouts.manage" | "payouts.reconcile",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.route.authentication.required"),
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
          error: { code: "authorization_forbidden", message: t("settlement.features.wallets.api.route.forbidden") },
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

  /**
   * Account-facing Wallet Adjustment detail: the account holder's own
   * `payouts.view` self-scope, never the platform-admin `wallet-adjustments.view`
   * permission. `getWalletAdjustmentForAccount` returns null for any
   * adjustment that does not belong to the caller's own account, so an
   * adjustment on someone else's wallet is indistinguishable from "does not
   * exist" -- account holders never learn whether a reference belongs to
   * another account.
   */
  app.get("/wallet/adjustments/:reference", async (c) => {
    const access = requireWalletAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const reference = c.req.param("reference");
    const adjustment = await services.getWalletAdjustmentForAccount({
      reference,
      accountId: access.actor.accountId,
    });
    if (!adjustment) {
      return new Response(
        JSON.stringify({
          error: {
            code: "not_found",
            message: t("settlement.features.wallets.api.route.wallet.adjustment.not.found"),
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    return c.json(adjustment);
  });

  app.post("/wallet/negative-balances/evaluate-collections", async (c) => {
    const access = requireWalletAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const params = {
      ...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
      ...(typeof body.collectionsThresholdAmount === "string"
        ? { collectionsThresholdAmount: body.collectionsThresholdAmount }
        : {}),
      ...(body.collectionsGracePeriodDays === undefined
        ? {}
        : { collectionsGracePeriodDays: Number(body.collectionsGracePeriodDays) }),
    };
    try {
      return c.json(await services.evaluateNegativeBalanceCollections(params, context));
    } catch (error) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message:
              error instanceof Error ? error.message : t("settlement.features.wallets.api.route.adjustment.failed"),
          },
        },
        400,
      );
    }
  });

  return app;
}
