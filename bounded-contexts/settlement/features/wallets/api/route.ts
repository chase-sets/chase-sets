import { createHash } from "node:crypto";
import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseOptionalTypedIdBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, LedgerEntryId, PaymentId } from "@chase-sets/primitives/typed-ids";
import type { SettlementApiEnv } from "../../../api";
import type { WalletServices } from "./runtime";
import { normalizeCurrencyCode } from "../../../support/runtime-support/common";

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

function normalizeRequiredBodyText(body: Record<string, unknown>, fieldName: string, message: string) {
  const value = body[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
  return value.trim();
}

function deterministicLedgerEntryId(idempotencyKey: string): LedgerEntryId {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 26);
  return parseTypedId(`led_${digest}`, "led");
}

function duplicateLedgerEntryResponse() {
  return new Response(JSON.stringify({ idempotent: true, duplicate: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function postOperatorWalletEntry(
  services: WalletServices,
  params: Readonly<{
    body: Record<string, unknown>;
    kind: "refund" | "adjustment";
    direction: "credit" | "debit";
    defaultDescription: string;
    context: NonNullable<SettlementApiEnv["Variables"]["context"]>;
  }>,
) {
  const accountId = parseTypedIdBoundary(
    normalizeRequiredBodyText(params.body, "accountId", "Target account is required for operator wallet commands."),
    "acc",
    "accountId",
  );
  const idempotencyKey = normalizeRequiredBodyText(
    params.body,
    "idempotencyKey",
    "Idempotency key is required for operator wallet commands.",
  );
  const auditReason = normalizeRequiredBodyText(
    params.body,
    "auditReason",
    "Audit reason is required for operator wallet commands.",
  );
  const description = String(params.body.description ?? params.defaultDescription);

  return services.postEntry(
    {
      accountId,
      ledgerEntryId: deterministicLedgerEntryId(idempotencyKey),
      kind: params.kind,
      direction: params.direction,
      amount: String(params.body.amount ?? ""),
      currencyCode: normalizeCurrencyCode(String(params.body.currencyCode ?? "usd")),
      fundsStatus: "available",
      paymentId: parseOptionalTypedIdBoundary(params.body.paymentId, "pay", "paymentId") ?? null,
      description: t("settlement.features.wallets.api.route.ledger.description.with.reason", {
        description,
        reason: auditReason,
      }),
      postedAt: new Date().toISOString(),
    },
    params.context,
  );
}

function isDuplicateLedgerEntryError(error: unknown) {
  return error instanceof Error && error.message === "Ledger entry has already been posted.";
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

  app.post("/wallet/refund-debits", async (c) => {
    const access = requireWalletAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }
    const body = await c.req.json();

    try {
      return c.json(
        await postOperatorWalletEntry(services, {
          body,
          kind: "refund",
          direction: "debit",
          defaultDescription: "Seller refund debit",
          context,
        }),
        201,
      );
    } catch (error) {
      if (isDuplicateLedgerEntryError(error)) {
        return duplicateLedgerEntryResponse();
      }
      return c.json(
        {
          error: {
            code: "validation_failed",
            message:
              error instanceof Error ? error.message : t("settlement.features.wallets.api.route.refund.debit.failed"),
          },
        },
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
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }
    const body = await c.req.json();

    try {
      return c.json(
        await postOperatorWalletEntry(services, {
          body,
          kind: "adjustment",
          direction: "debit",
          defaultDescription: "Dispute hold",
          context,
        }),
        201,
      );
    } catch (error) {
      if (isDuplicateLedgerEntryError(error)) {
        return duplicateLedgerEntryResponse();
      }
      return c.json(
        {
          error: {
            code: "validation_failed",
            message:
              error instanceof Error ? error.message : t("settlement.features.wallets.api.route.dispute.hold.failed"),
          },
        },
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
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.route.authentication.context.missing.4"),
          },
        },
        401,
      );
    }
    const body = await c.req.json();

    try {
      return c.json(
        await postOperatorWalletEntry(services, {
          body,
          kind: "adjustment",
          direction: "credit",
          defaultDescription: "Dispute hold released",
          context,
        }),
        201,
      );
    } catch (error) {
      if (isDuplicateLedgerEntryError(error)) {
        return duplicateLedgerEntryResponse();
      }
      return c.json(
        {
          error: {
            code: "validation_failed",
            message:
              error instanceof Error
                ? error.message
                : t("settlement.features.wallets.api.route.dispute.release.failed"),
          },
        },
        400,
      );
    }
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
