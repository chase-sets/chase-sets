import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { t } from "@chase-sets/localization";
import { Hono, type Context, type TypedResponse } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { resolveClientAddress, resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { paymentWebhookErrorFromUnknown } from "./webhook-errors";
import { PaymentDeclineLimitUnavailableError, PaymentsRateLimitExceededError, type PaymentServices } from "./runtime";
import { normalizeRequestedBalanceCreditAmount } from "./balance-credit-request";
import type { AccountId, OrderId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { AgenticProcessorPaymentInput, PaymentProcessorPublicConfig } from "@chase-sets/payment-processing";
import { parseProviderModeObservation, type ProviderModeObservation } from "./contracts";

export type PaymentsApiEnv = AuthenticatedApiEnv;

export type CreateAccountPaymentRequest = Readonly<{
  orderIds: readonly string[];
  currencyCode?: string;
  sourceContext?: string | null;
  sourceReferenceId?: string | null;
  requestedBalanceCreditAmount?: string | null;
  paymentMethodCategory?: string | null;
  marketplaceCheckoutFeeQuoteFingerprint?: string | null;
  savedCheckoutInstrumentId?: string | null;
  savePaymentMethodForFuture?: boolean;
  returnUrlPath?: string | null;
  agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null;
}>;

export type CreateSavedPaymentSetupSessionRequest = Readonly<{ returnUrlPath?: string | null }>;

/**
 * Declares the JSON body a client sends so the route-typed payments client checks it, and returns the handler
 * unchanged. Nothing is validated: handlers still parse `c.req.json()` leniently, after their access checks. It
 * wraps the handler rather than adding a middleware, because a second handler on a route is a collision in the
 * platform API route-table census.
 */
function jsonInput<T>() {
  return <R>(handler: (c: Context<PaymentsApiEnv, string, { in: { json: T }; out: {} }>) => R) => handler;
}

type PaymentsActor = NonNullable<PaymentsApiEnv["Variables"]["actor"]>;
type PaymentPermission = "orders.view" | "orders.manage";
type PaymentAccessOptions = Readonly<{ allowGuestCheckout?: boolean }>;
type PaymentAccessDenial = Readonly<{
  status: 401 | 403;
  body: Readonly<{ error: Readonly<{ code: "authentication_required" | "authorization_forbidden"; message: string }> }>;
}>;

function paymentAccessDecision(
  actor: PaymentsApiEnv["Variables"]["actor"],
  permission: PaymentPermission,
  options: PaymentAccessOptions,
): Readonly<{ actor: PaymentsActor; denial: null }> | Readonly<{ actor: null; denial: PaymentAccessDenial }> {
  if (!actor) {
    return {
      actor: null,
      denial: {
        status: 401,
        body: {
          error: {
            code: "authentication_required",
            message: t("payments.features.payments.api.route.authentication.required"),
          },
        },
      },
    };
  }

  if (!actor.permissions.includes(permission)) {
    if (options.allowGuestCheckout && actor.permissions.includes("guest-checkout.manage")) {
      return { actor, denial: null };
    }

    return {
      actor: null,
      denial: {
        status: 403,
        body: {
          error: { code: "authorization_forbidden", message: t("payments.features.payments.api.route.forbidden") },
        },
      },
    };
  }

  return { actor, denial: null };
}

function requirePaymentAccess(
  c: {
    get(key: "actor"): PaymentsApiEnv["Variables"]["actor"];
  },
  permission: PaymentPermission,
  options: PaymentAccessOptions = {},
) {
  const access = paymentAccessDecision(c.get("actor"), permission, options);
  if (access.denial) {
    return {
      actor: null,
      response: new Response(JSON.stringify(access.denial.body), {
        status: access.denial.status,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor: access.actor, response: null };
}

/** The handler form of `requirePaymentAccess`: a denial is a typed reply, so it keeps the route's response types. */
function paymentAccess(c: Context<PaymentsApiEnv>, permission: PaymentPermission, options: PaymentAccessOptions = {}) {
  const access = paymentAccessDecision(c.get("actor"), permission, options);
  return access.denial
    ? { actor: null, reply: c.json(access.denial.body, access.denial.status) }
    : { actor: access.actor, reply: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("payments.features.payments.api.route.request.failed");
}

function providerWebhookFailureResponse(c: { json: (body: unknown, status?: number) => Response }, error: unknown) {
  const classified = paymentWebhookErrorFromUnknown(error);
  const ignored =
    classified.failureClass === "unknown-event" ||
    classified.failureClass === "schema-mismatch" ||
    classified.failureClass === "inbox-conflict";
  const status = ignored ? 200 : 400;
  if (ignored) {
    return c.json(
      {
        received: true,
        ignored: true,
        failure_class: classified.failureClass,
      },
      status,
    );
  }

  return c.json(
    {
      error: {
        code: `provider_webhook_${classified.failureClass.replaceAll("-", "_")}`,
        message:
          classified.failureClass === "handler-failure" ? "Provider webhook handler failed." : classified.message,
        failure_class: classified.failureClass,
        retryable: classified.retryable,
      },
    },
    status,
  );
}

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code.trim()
    ? error.code
    : "validation_failed";
}

function requireEventStoreContext(c: { get(key: "context"): EventStoreContext | null | undefined }) {
  const context = c.get("context");
  if (!context) {
    throw new Error(t("payments.features.payments.api.route.authentication.context.missing"));
  }
  return context;
}

function staleFeeQuoteResponse(c: Context<PaymentsApiEnv>, error: unknown) {
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

function paymentRateLimitResponse(c: Context<PaymentsApiEnv>, error: unknown) {
  if (error instanceof PaymentDeclineLimitUnavailableError) {
    return c.json({ error: { code: error.code, message: error.message } }, 503);
  }
  if (!(error instanceof PaymentsRateLimitExceededError)) {
    return null;
  }
  return c.json(
    {
      error: {
        code: "rate_limited",
        message: error.message,
        surface: error.surface,
        retryAfterSeconds: error.retryAfterSeconds,
      },
    },
    429,
    { "Retry-After": String(error.retryAfterSeconds) },
  );
}

function resolvePublicOrigin(request: Request) {
  return resolvePublicRequestOrigin(request);
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
  };
}

function canStorePaymentMethod(actor: NonNullable<PaymentsApiEnv["Variables"]["actor"]>) {
  return !actor.permissions.includes("guest-checkout.manage");
}

const paymentCreationAccountRateLimiter = createConfiguredInMemoryRateLimiter("payments.payment.create.account", {
  max: 10,
  windowMs: 10 * 60 * 1000,
});

const paymentCreationIpRateLimiter = createConfiguredInMemoryRateLimiter("payments.payment.create.ip", {
  max: 20,
  windowMs: 10 * 60 * 1000,
});

function enforcePaymentCreationLimit(request: Request, accountId: string) {
  const accountDecision = paymentCreationAccountRateLimiter.check(`account:${accountId}`);
  if (accountDecision.limited) {
    return rateLimitExceededJsonResponse("payments.payment.create.account", accountDecision);
  }
  const ipDecision = paymentCreationIpRateLimiter.check(publicClientRequestKey(request));
  if (ipDecision.limited) {
    return rateLimitExceededJsonResponse("payments.payment.create.ip", ipDecision);
  }
  return null;
}

export function preflightPaymentStart(
  c: Parameters<typeof requirePaymentAccess>[0],
  request: Request,
): ReturnType<typeof requirePaymentAccess> {
  const access = requirePaymentAccess(c, "orders.manage", { allowGuestCheckout: true });
  if (access.response) return access;
  const response = enforcePaymentCreationLimit(request, access.actor.accountId);
  return response ? { actor: null, response } : access;
}

type PaymentCreationRateLimitedBody = Readonly<{
  error: Readonly<{ code: "rate_limited"; message: string; surface: string; retryAfterSeconds: number }>;
}>;

/** The handler form of `preflightPaymentStart`, in the same check order, with every refusal a typed reply. */
function paymentStartAccess(c: Context<PaymentsApiEnv>) {
  const access = paymentAccess(c, "orders.manage", { allowGuestCheckout: true });
  if (access.reply) return access;
  const limited = enforcePaymentCreationLimit(c.req.raw, access.actor.accountId);
  return limited
    ? {
        actor: null,
        // The shared rate-limit helper owns this 429 body; naming its shape keeps the route's success type.
        reply: limited as Response & TypedResponse<PaymentCreationRateLimitedBody, 429, "json">,
      }
    : access;
}

type SavedCheckoutInstrumentForApi = Awaited<ReturnType<PaymentServices["listSavedCheckoutInstruments"]>>[number];
type SavedCheckoutSetupSessionForApi = Awaited<ReturnType<PaymentServices["createSavedCheckoutSetupSession"]>>;
type AccountOrderInputForApi = Awaited<ReturnType<PaymentServices["listAccountOrderInputs"]>>[number];

function savedCheckoutSetupSessionSnapshot(
  setup: SavedCheckoutSetupSessionForApi,
  publicConfig?: PaymentProcessorPublicConfig,
) {
  return {
    setup_reference_id: setup.setup_reference_id,
    processor_setup_reference: setup.processor_setup_reference,
    processor_client_secret: setup.processor_client_secret,
    processor_redirect_url: setup.processor_redirect_url,
    processor_status: setup.processor_status,
    ...(publicConfig?.publishableKey ? { processor_publishable_key: publicConfig.publishableKey } : {}),
  };
}

function accountOrderInputSnapshot(order: AccountOrderInputForApi) {
  return {
    order_id: order.order_id,
    buyer_account_id: order.buyer_account_id,
    buyer_email: order.buyer_email,
    shipping_destination_snapshot: order.shipping_destination_snapshot,
    seller_account_id: order.seller_account_id,
    sales_tax_amount: order.sales_tax_amount,
    total_amount: order.total_amount,
    marketplace_sales_fee_amount: order.marketplace_sales_fee_amount,
    marketplace_checkout_fee_amount: order.marketplace_checkout_fee_amount,
    seller_net_amount: order.seller_net_amount,
    seller_item_net_amount: order.seller_item_net_amount,
    shipping_allowance_amount: order.shipping_allowance_amount,
    shipping_overage_amount: order.shipping_overage_amount,
    seller_shipping_payout_amount: order.seller_shipping_payout_amount,
    seller_payout_amount: order.seller_payout_amount,
    shipping_allowance_percentage_bps: order.shipping_allowance_percentage_bps,
    terms_schedule_id: order.terms_schedule_id,
    terms_agreement_id: order.terms_agreement_id,
    terms_resolved_at: order.terms_resolved_at,
    status: order.status,
    listing_evidence: order.listing_evidence,
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

export function createAccountPaymentRoutes(services: PaymentServices, publicConfig?: PaymentProcessorPublicConfig) {
  return new Hono<PaymentsApiEnv>()
    .post(
      "/payments",
      jsonInput<CreateAccountPaymentRequest>()(async (c) => {
        const access = paymentStartAccess(c);
        if (access.reply) {
          return access.reply;
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
          body.sourceReferenceId === null || body.sourceReferenceId === undefined
            ? null
            : String(body.sourceReferenceId);

        try {
          const payment = await services.createAccountPayment(
            {
              accountId: access.actor.accountId as AccountId,
              isGuestCheckout: access.actor.permissions.includes("guest-checkout.manage"),
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
              returnUrlBase: resolvePublicOrigin(c.req.raw),
              returnUrlPath:
                body.returnUrlPath === null || body.returnUrlPath === undefined ? null : String(body.returnUrlPath),
              clientRiskContext: {
                ipAddress: resolveClientAddress(c.req.raw),
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
          const rateLimited = paymentRateLimitResponse(c, error);
          if (rateLimited) {
            return rateLimited;
          }
          const stale = staleFeeQuoteResponse(c, error);
          if (stale) {
            return stale;
          }
          return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
        }
      }),
    )
    .get("/checkout/status", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
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
    })
    .get("/order-inputs", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
      }

      try {
        const orderIds =
          c.req.queries("orderId") ??
          c.req
            .query("orderIds")
            ?.split(",")
            .map((value) => value.trim()) ??
          [];
        const orders = await services.listAccountOrderInputs({
          accountId: access.actor.accountId as AccountId,
          orderIds: orderIds.filter(Boolean) as OrderId[],
        });

        return c.json({ orders: orders.map(accountOrderInputSnapshot) });
      } catch (error) {
        return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 404);
      }
    })
    .get("/checkout/preview-status", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
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
    })
    .get("/checkout/saved-instruments", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
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
    })
    .get("/payment-methods", async (c) => {
      const access = paymentAccess(c, "orders.view");
      if (access.reply) {
        return access.reply;
      }

      const instruments = await services.listSavedCheckoutInstruments(access.actor.accountId as AccountId);
      return c.json({
        items: instruments.map((instrument) =>
          savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true }),
        ),
      });
    })
    .post(
      "/payment-methods/setup-sessions",
      jsonInput<CreateSavedPaymentSetupSessionRequest>()(async (c) => {
        const access = paymentAccess(c, "orders.manage");
        if (access.reply) {
          return access.reply;
        }
        const body = await c.req.json().catch(() => ({}));
        try {
          const setup = await services.createSavedCheckoutSetupSession({
            accountId: access.actor.accountId as AccountId,
            returnUrlBase: resolvePublicOrigin(c.req.raw),
            returnUrlPath:
              body.returnUrlPath === null || body.returnUrlPath === undefined
                ? "/account/payment-methods"
                : String(body.returnUrlPath),
            // The authenticated account page always uses the embedded SetupIntent
            // surface. Hosted setup remains available through the agent URL-
            // elicitation MCP tool, which calls the runtime directly.
            uiMode: "embedded",
          });
          return c.json(savedCheckoutSetupSessionSnapshot(setup, publicConfig), 201);
        } catch (error) {
          return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
        }
      }),
    )
    .post("/payment-methods/setup-sessions/:processorSetupReference/reconcile", async (c) => {
      const access = paymentAccess(c, "orders.manage");
      if (access.reply) {
        return access.reply;
      }
      try {
        const instrument = await services.reconcileSavedCheckoutSetupSession(
          {
            accountId: access.actor.accountId as AccountId,
            setupReference: c.req.param("processorSetupReference"),
          },
          requireEventStoreContext(c),
        );
        return c.json({
          instrument: instrument
            ? savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true })
            : null,
        });
      } catch (error) {
        return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
      }
    })
    .post("/payment-methods/:instrumentId/default", async (c) => {
      const access = paymentAccess(c, "orders.manage");
      if (access.reply) {
        return access.reply;
      }
      const instrument = await services.setSavedCheckoutInstrumentDefault(
        {
          accountId: access.actor.accountId as AccountId,
          instrumentId: c.req.param("instrumentId"),
        },
        requireEventStoreContext(c),
      );
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
    })
    .post("/payment-methods/:instrumentId/remove", async (c) => {
      const access = paymentAccess(c, "orders.manage");
      if (access.reply) {
        return access.reply;
      }
      const instrument = await services.removeSavedCheckoutInstrument(
        {
          accountId: access.actor.accountId as AccountId,
          instrumentId: c.req.param("instrumentId"),
        },
        requireEventStoreContext(c),
      );
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
    })
    .post("/payment-methods/reconcile", async (c) => {
      const access = paymentAccess(c, "orders.manage");
      if (access.reply) {
        return access.reply;
      }
      const accountId = access.actor.accountId as AccountId;
      const result = await services.reconcileSavedCheckoutInstruments(
        {
          accountId,
        },
        requireEventStoreContext(c),
      );
      const instruments = await services.listSavedCheckoutInstruments(accountId);
      return c.json({
        ...result,
        items: instruments.map((instrument) =>
          savedCheckoutInstrumentSnapshot(instrument, { includeManagementFields: true }),
        ),
      });
    })
    .get("/marketplace-checkout-fee-policy", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
      }

      return c.json(await services.getMarketplaceCheckoutFeePolicy());
    })
    .post(
      "/checkout/recover",
      jsonInput<CreateAccountPaymentRequest>()(async (c) => {
        const access = paymentStartAccess(c);
        if (access.reply) {
          return access.reply;
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
              isGuestCheckout: access.actor.permissions.includes("guest-checkout.manage"),
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
              returnUrlBase: resolvePublicOrigin(c.req.raw),
              returnUrlPath:
                body.returnUrlPath === null || body.returnUrlPath === undefined ? null : String(body.returnUrlPath),
              clientRiskContext: {
                ipAddress: resolveClientAddress(c.req.raw),
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
          const rateLimited = paymentRateLimitResponse(c, error);
          if (rateLimited) {
            return rateLimited;
          }
          const stale = staleFeeQuoteResponse(c, error);
          if (stale) {
            return stale;
          }
          return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
        }
      }),
    )
    .get("/checkout/recovery", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
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
    })
    .get("/payments/:id", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
      }

      const payment = await services.getAccountPayment(c.req.param("id"), access.actor.accountId);
      if (!payment) {
        return c.json(
          { error: { code: "not_found", message: t("payments.features.payments.api.route.payment.not.found") } },
          404,
        );
      }

      return c.json(payment);
    })
    .get("/payments/:id/timeline", async (c) => {
      const access = paymentAccess(c, "orders.view", {
        allowGuestCheckout: true,
      });
      if (access.reply) {
        return access.reply;
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
}

/**
 * The read-only payment provider mode observation. It reports the locally loaded platform
 * configuration and is never the payment provider's own opinion: the handler performs no provider
 * call, reads no storage, and derives nothing beyond the one request-time instant it stamps.
 *
 * A missing or malformed observation fails closed with a bounded server error rather than defaulting
 * to any mode, gateway kind or deployment environment.
 */
export function createPaymentProviderModeRoutes(observation: ProviderModeObservation | undefined) {
  return new Hono<PaymentsApiEnv>().get("/payment-provider-mode", (c) => {
    const observed = parseProviderModeObservation(observation);
    if (!observed) {
      return c.json(
        {
          error: {
            code: "payment_provider_mode_observation_unavailable",
            message: t("payments.features.payments.api.route.request.failed"),
          },
        },
        500,
      );
    }

    return c.json({ ...observed, observedAt: new Date(Date.now()).toISOString() });
  });
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
      return providerWebhookFailureResponse(c, error);
    }
  });

  return app;
}
