import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { createId, parseStrictTypedUlid, parseTypedId } from "@chase-sets/primitives/typed-ids";
import { PaymentsDomainError } from "../../../support/runtime-support/common";
import type { WalletFundingServices } from "./runtime";

export function createWalletFundingRoutes(services: WalletFundingServices) {
  const app = new Hono<AuthenticatedApiEnv>();
  const requireAccess = createMiddleware<AuthenticatedApiEnv>(async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    if (!actor.permissions.includes(c.req.method === "GET" ? "orders.view" : "orders.manage"))
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    return next();
  });
  app.use("/wallet-fundings", requireAccess);
  app.use("/wallet-fundings/*", requireAccess);
  app.get("/wallet-fundings", async (c) => {
    const items = await services.list(parseTypedId(c.get("actor")!.accountId, "acc"));
    return c.json({
      items: items.map(({ funding_id, state }) => ({
        fundingId: funding_id,
        ...state.quote,
        status: state.status,
        refundedAmount: state.refundedAmount,
        capturedAt: state.capturedAt,
        refundAttention: state.refundAttention ?? [],
        refunds: Object.values(state.refunds).map((refund) => ({
          refundId: refund.refundId,
          amount: refund.amount,
          status: refund.status,
          exception: refund.exception,
          updatedAt: refund.updatedAt,
        })),
      })),
    });
  });
  app.post("/wallet-fundings", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const context = c.get("context");
      if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
      const fundingId =
        typeof body.fundingId === "string"
          ? parseStrictTypedUlid(body.fundingId, "wfp")
          : body.quoteFingerprint
            ? null
            : createId("wfp");
      if (
        !fundingId ||
        typeof body.requestedAmount !== "string" ||
        typeof body.currencyCode !== "string" ||
        typeof body.paymentMethodCategory !== "string"
      )
        return c.json({ error: { code: "funding_input_invalid" } }, 400);
      const result = await services.create(
        {
          fundingId,
          accountId: parseTypedId(c.get("actor")!.accountId, "acc"),
          requestedAmount: body.requestedAmount,
          currencyCode: body.currencyCode,
          paymentMethodCategory: body.paymentMethodCategory,
          quoteFingerprint: typeof body.quoteFingerprint === "string" ? body.quoteFingerprint : undefined,
          savedInstrumentId: typeof body.savedInstrumentId === "string" ? body.savedInstrumentId : null,
        },
        context,
      );
      return c.json(
        { fundingId, ...result },
        result.outcome === "fee_quote_stale" ? 409 : result.outcome === "quoted" ? 200 : 201,
      );
    } catch (error) {
      return c.json(
        { error: { code: error instanceof PaymentsDomainError ? error.code : "funding_request_failed" } },
        400,
      );
    }
  });
  app.post("/wallet-fundings/:fundingId/refunds", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const context = c.get("context");
      if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
      if (typeof body.refundId !== "string" || typeof body.amount !== "string")
        return c.json({ error: { code: "refund_input_invalid" } }, 400);
      const result = await services.refund(
        {
          fundingId: parseStrictTypedUlid(c.req.param("fundingId"), "wfp"),
          accountId: parseTypedId(c.get("actor")!.accountId, "acc"),
          refundId: parseStrictTypedUlid(body.refundId, "wfr"),
          amount: body.amount,
        },
        context,
      );
      return c.json({ refund: result }, result.status === "refused" ? 409 : 202);
    } catch (error) {
      return c.json(
        { error: { code: error instanceof PaymentsDomainError ? error.code : "refund_request_failed" } },
        400,
      );
    }
  });
  return app;
}
