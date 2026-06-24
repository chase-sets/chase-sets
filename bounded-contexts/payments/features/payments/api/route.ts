import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PaymentServices } from "./runtime";
import { normalizeRequestedBalanceCreditAmount } from "./balance-credit-request";
import type { AccountId, OrderId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";

export type PaymentsApiEnv = AuthenticatedApiEnv;

function requirePaymentAccess(
  c: {
    get(key: "actor"): PaymentsApiEnv["Variables"]["actor"];
  },
  permission: "orders.view" | "orders.manage",
  options: Readonly<{ allowGuestCheckout?: boolean }> = {},
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("payments.features.payments.api.route.authentication.required"),
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
    if (options.allowGuestCheckout && actor.permissions.includes("guest-checkout.manage")) {
      return { actor, response: null };
    }

    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authorization_forbidden", message: t("payments.features.payments.api.route.forbidden") },
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("payments.features.payments.api.route.request.failed");
}

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code.trim()
    ? error.code
    : "validation_failed";
}

function staleFeeQuoteResponse(c: { json: (body: unknown, status?: number) => Response }, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (!message.startsWith("fee_quote_stale:")) {
    return null;
  }
  const quote = JSON.parse(message.slice("fee_quote_stale:".length));
  return c.json(
    {
      error: {
        code: "fee_quote_stale",
        message: t("payments.features.payments.api.route.marketplace.checkout.fee.quote.stale"),
      },
      marketplace_checkout_fee: quote,
    },
    409,
  );
}

function resolvePublicOrigin(requestUrl: string, headers: Headers) {
  const parsed = new URL(requestUrl);
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? parsed.host;
  const protocol = headers.get("x-forwarded-proto") ?? parsed.protocol.replace(":", "") ?? "https";

  return `${protocol}://${host}`;
}

function readAgenticPayment(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const token = typeof source.sharedPaymentGrantedToken === "string" ? source.sharedPaymentGrantedToken.trim() : "";
  if (source.kind !== "stripe-shared-payment-token" || !token) {
    return null;
  }
  return {
    kind: "stripe-shared-payment-token" as const,
    sharedPaymentGrantedToken: token,
    ap2CheckoutMandateId: typeof source.ap2CheckoutMandateId === "string" ? source.ap2CheckoutMandateId : null,
    ap2PaymentMandateId: typeof source.ap2PaymentMandateId === "string" ? source.ap2PaymentMandateId : null,
  };
}

function canStorePaymentMethod(actor: NonNullable<PaymentsApiEnv["Variables"]["actor"]>) {
  return !actor.permissions.includes("guest-checkout.manage");
}

type SavedCheckoutInstrumentForApi = Awaited<ReturnType<PaymentServices["listSavedCheckoutInstruments"]>>[number];
type SavedCheckoutSetupSessionForApi = Awaited<ReturnType<PaymentServices["createSavedCheckoutSetupSession"]>>;

function savedCheckoutSetupSessionSnapshot(setup: SavedCheckoutSetupSessionForApi) {
  return {
    setup_reference_id: setup.setup_reference_id,
    processor_setup_reference: setup.processor_setup_reference,
    processor_client_secret: setup.processor_client_secret,
    processor_redirect_url: setup.processor_redirect_url,
    processor_status: setup.processor_status,
  };
}

function savedCheckoutInstrumentSnapshot(
  instrument: SavedCheckoutInstrumentForApi,
  options: Readonly<{ includeManagementFields?: boolean }> = {},
) {
  const snapshot = {
    instrument_id: instrument.instrument_id,
    account_id: instrument.account_id,
    payment_method_category: instrument.payment_method_category,
    provider: instrument.provider,
    display_label: instrument.display_label,
    confirmation_experience: instrument.confirmation_experience,
    readiness: instrument.readiness,
    is_default: instrument.is_default,
    created_at: instrument.created_at,
    updated_at: instrument.updated_at,
  };

  if (!options.includeManagementFields) {
    return snapshot;
  }

  return {
    ...snapshot,
    allow_redisplay: instrument.allow_redisplay,
    consent_id: instrument.consent_id,
    removed_at: instrument.removed_at,
  };
}

export function createAccountPaymentRoutes(services: PaymentServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.post("/payments", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("payments.features.payments.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    const sourceContext =
      body.sourceContext === null || body.sourceContext === undefined ? null : String(body.sourceContext);
    const sourceReferenceId =
      body.sourceReferenceId === null || body.sourceReferenceId === undefined ? null : String(body.sourceReferenceId);

    try {
      const payment = await services.createAccountPayment(
        {
          accountId: access.actor.accountId as AccountId,
          orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [],
          currencyCode: String(body.currencyCode ?? "usd"),
          requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(body.requestedBalanceCreditAmount),
          paymentMethodCategory:
            body.paymentMethodCategory === null || body.paymentMethodCategory === undefined
              ? null
              : String(body.paymentMethodCategory),
          marketplaceCheckoutFeeQuoteFingerprint:
            body.marketplaceCheckoutFeeQuoteFingerprint === null ||
            body.marketplaceCheckoutFeeQuoteFingerprint === undefined
              ? null
              : String(body.marketplaceCheckoutFeeQuoteFingerprint),
          savedCheckoutInstrumentId:
            body.savedCheckoutInstrumentId === null || body.savedCheckoutInstrumentId === undefined
              ? null
              : String(body.savedCheckoutInstrumentId),
          savePaymentMethodForFuture: canStorePaymentMethod(access.actor)
            ? Boolean(body.savePaymentMethodForFuture)
            : false,
          returnUrlBase: resolvePublicOrigin(c.req.url, c.req.raw.headers),
          returnUrlPath:
            body.returnUrlPath === null || body.returnUrlPath === undefined ? null : String(body.returnUrlPath),
          clientRiskContext: {
            ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null,
            userAgent: c.req.header("user-agent") ?? null,
          },
          ...(readAgenticPayment(body.agenticPayment)
            ? { agenticPayment: readAgenticPayment(body.agenticPayment) }
            : {}),
          ...(sourceContext && sourceReferenceId ? { sourceContext, sourceReferenceId } : {}),
        },
        context,
      );

      return c.json(payment, 201);
    } catch (error) {
      const stale = staleFeeQuoteResponse(c, error);
      if (stale) {
        return stale;
      }
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout/status", async (c) => {
    const access = requirePaymentAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    try {
      const orderIds =
        c.req.queries("orderId") ??
        c.req
          .query("orderIds")
          ?.split(",")
          .map((value) => value.trim()) ??
        [];
      const status = await services.getCheckoutStatus({
        accountId: access.actor.accountId as AccountId,
        orderIds: orderIds.filter(Boolean) as OrderId[],
        currencyCode: c.req.query("currencyCode") ?? "usd",
        requestedBalanceCreditAmount: c.req.query("requestedBalanceCreditAmount") ?? null,
        paymentMethodCategory: c.req.query("paymentMethodCategory") ?? null,
      });

      return c.json(status);
    } catch (error) {
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout/preview-status", async (c) => {
    const access = requirePaymentAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    try {
      const status = await services.previewCheckoutStatus({
        accountId: access.actor.accountId as AccountId,
        amount: String(c.req.query("amount") ?? "0.00"),
        currencyCode: c.req.query("currencyCode") ?? "usd",
        requestedBalanceCreditAmount: c.req.query("requestedBalanceCreditAmount") ?? null,
        paymentMethodCategory: c.req.query("paymentMethodCategory") ?? null,
      });

      return c.json(status);
    } catch (error) {
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout/saved-instruments", async (c) => {
    const access = requirePaymentAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const instruments = await services.listSavedCheckoutInstruments(access.actor.accountId as AccountId);

    return c.json({
      items: instruments
        .filter(
          (instrument) =>
            instrument.readiness === "ready" &&
            Boolean(instrument.provider_customer_reference?.trim()) &&
            Boolean(instrument.provider_reference?.trim()),
        )
        .map((instrument) => savedCheckoutInstrumentSnapshot(instrument)),
    });
  });

  app.get("/payment-methods", async (c) => {
    const access = requirePaymentAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const instruments = await services.listSavedCheckoutInstruments(access.actor.accountId as AccountId);
    return c.json({
      items: instruments.map((instrument) =>
        savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true }),
      ),
    });
  });

  app.post("/payment-methods/setup-sessions", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const setup = await services.createSavedCheckoutSetupSession({
        accountId: access.actor.accountId as AccountId,
        returnUrlBase: resolvePublicOrigin(c.req.url, c.req.raw.headers),
        returnUrlPath:
          body.returnUrlPath === null || body.returnUrlPath === undefined
            ? "/account/payment-methods"
            : String(body.returnUrlPath),
      });
      return c.json(savedCheckoutSetupSessionSnapshot(setup), 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/payment-methods/setup-sessions/:processorSetupReference/reconcile", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }
    try {
      const instrument = await services.reconcileSavedCheckoutSetupSession({
        accountId: access.actor.accountId as AccountId,
        setupReference: c.req.param("processorSetupReference"),
      });
      return c.json({
        instrument: instrument ? savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true }) : null,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/payment-methods/:instrumentId/default", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }
    const instrument = await services.setSavedCheckoutInstrumentDefault({
      accountId: access.actor.accountId as AccountId,
      instrumentId: c.req.param("instrumentId"),
    });
    if (!instrument) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("payments.features.payments.api.route.saved.payment.method.not.found"),
          },
        },
        404,
      );
    }
    return c.json(savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true }));
  });

  app.post("/payment-methods/:instrumentId/remove", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }
    const instrument = await services.removeSavedCheckoutInstrument({
      accountId: access.actor.accountId as AccountId,
      instrumentId: c.req.param("instrumentId"),
    });
    if (!instrument) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("payments.features.payments.api.route.saved.payment.method.not.found.2"),
          },
        },
        404,
      );
    }
    return c.json(savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true }));
  });

  app.post("/payment-methods/reconcile", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }
    const accountId = access.actor.accountId as AccountId;
    const result = await services.reconcileSavedCheckoutInstruments({
      accountId,
    });
    const instruments = await services.listSavedCheckoutInstruments(accountId);
    return c.json({
      ...result,
      items: instruments.map((instrument) =>
        savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true }),
      ),
    });
  });

  app.get("/marketplace-checkout-fee-policy", async (c) => {
    const access = requirePaymentAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getMarketplaceCheckoutFeePolicy());
  });

  app.post("/checkout/recover", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("payments.features.payments.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const payment = await services.recoverCheckoutPayment(
        {
          accountId: access.actor.accountId as AccountId,
          orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [],
          currencyCode: String(body.currencyCode ?? "usd"),
          requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(body.requestedBalanceCreditAmount),
          paymentMethodCategory:
            body.paymentMethodCategory === null || body.paymentMethodCategory === undefined
              ? null
              : String(body.paymentMethodCategory),
          marketplaceCheckoutFeeQuoteFingerprint:
            body.marketplaceCheckoutFeeQuoteFingerprint === null ||
            body.marketplaceCheckoutFeeQuoteFingerprint === undefined
              ? null
              : String(body.marketplaceCheckoutFeeQuoteFingerprint),
          savedCheckoutInstrumentId:
            body.savedCheckoutInstrumentId === null || body.savedCheckoutInstrumentId === undefined
              ? null
              : String(body.savedCheckoutInstrumentId),
          savePaymentMethodForFuture: canStorePaymentMethod(access.actor)
            ? Boolean(body.savePaymentMethodForFuture)
            : false,
          returnUrlBase: resolvePublicOrigin(c.req.url, c.req.raw.headers),
          returnUrlPath:
            body.returnUrlPath === null || body.returnUrlPath === undefined ? null : String(body.returnUrlPath),
          clientRiskContext: {
            ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null,
            userAgent: c.req.header("user-agent") ?? null,
          },
          ...(readAgenticPayment(body.agenticPayment)
            ? { agenticPayment: readAgenticPayment(body.agenticPayment) }
            : {}),
        },
        context,
      );

      return c.json(payment, 201);
    } catch (error) {
      const stale = staleFeeQuoteResponse(c, error);
      if (stale) {
        return stale;
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout/recovery", async (c) => {
    const access = requirePaymentAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    try {
      const orderIds =
        c.req.queries("orderId") ??
        c.req
          .query("orderIds")
          ?.split(",")
          .map((value) => value.trim()) ??
        [];
      const recovery = await services.getCheckoutRecoveryOptions({
        accountId: access.actor.accountId as AccountId,
        orderIds: orderIds.filter(Boolean) as OrderId[],
        currencyCode: c.req.query("currencyCode") ?? "usd",
        requestedBalanceCreditAmount: c.req.query("requestedBalanceCreditAmount") ?? null,
        paymentMethodCategory: c.req.query("paymentMethodCategory") ?? null,
      });

      return c.json(recovery);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/payments/:id", async (c) => {
    const access = requirePaymentAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const payment = await services.getAccountPayment(c.req.param("id"), access.actor.accountId);
    if (!payment) {
      return c.json(
        { error: { code: "not_found", message: t("payments.features.payments.api.route.payment.not.found") } },
        404,
      );
    }

    return c.json(payment);
  });

  app.get("/payments/:id/timeline", async (c) => {
    const access = requirePaymentAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const timeline = await services.getPaymentMoneyTimeline({
      paymentId: c.req.param("id"),
      accountId: access.actor.accountId,
    });
    if (!timeline) {
      return c.json(
        { error: { code: "not_found", message: t("payments.features.payments.api.route.payment.not.found.2") } },
        404,
      );
    }

    return c.json(timeline);
  });

  return app;
}

export function createPaymentProcessorWebhookRoutes(services: PaymentServices) {
  const app = new Hono();

  app.post("/webhooks", async (c) => {
    try {
      const rawBody = await c.req.raw.text();
      const signatureHeader = c.req.header("Stripe-Signature") ?? null;
      const result = await services.processWebhook(
        {
          rawBody,
          signatureHeader,
        },
        {
          tenantId: "tnt_identity" as TenantId,
          audit: {
            performedByUserId: "usr_identity_system" as UserId,
            forAccountId: "acc_identity_system" as AccountId,
          },
        } as EventStoreContext,
      );

      return c.json(result, 200);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
