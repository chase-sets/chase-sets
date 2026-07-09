import { createUcpEnvelope, type UcpEnvelope } from "@chase-sets/platform-runtime/ucp";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import {
  agentGrantIdFromActor,
  type AgentGrantRail,
  type AgentGrantSpendPolicy,
} from "@chase-sets/platform-runtime/agent-guardrails";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  createCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments,
  getCheckoutPaymentStatusThroughPayments,
  releaseCheckoutInventoryReservations,
} from "../request-support/checkout-confirmation";
import type { CheckoutServices } from "../runtime-support/services";
import { CheckoutDomainError } from "../runtime-support/common";
import type { CheckoutSessionRow } from "../../features/sessions/read-model/queries";
import type { CheckoutOptimizationGoal, CheckoutShippingAddress } from "../../features/sessions/domain/domain";
import { parseCartReadinessDecisionInput, type CartReadinessDecisionInput } from "../../features/cart/domain/readiness";
import { assertNoUnsupportedCustomerEconomicsInput } from "../../features/sessions/api/checkout-economics-runtime";

type UcpHandler = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope>;
type UcpPaymentHandlerHandoff = Readonly<{
  payment: Readonly<Record<string, unknown>>;
  evaluateCompleteRequest: (
    body: Readonly<Record<string, unknown>>,
    checkout: Readonly<Record<string, unknown>>,
  ) =>
    | Readonly<{
        kind: "respond";
        response: UcpEnvelope;
      }>
    | Readonly<{
        kind: "headless-agentic-payment";
        agenticPayment: Parameters<typeof createCheckoutPaymentThroughPayments>[9];
        evidence?: Readonly<Record<string, unknown>>;
      }>
    | Promise<
        | Readonly<{
            kind: "respond";
            response: UcpEnvelope;
          }>
        | Readonly<{
            kind: "headless-agentic-payment";
            agenticPayment: Parameters<typeof createCheckoutPaymentThroughPayments>[9];
            evidence?: Readonly<Record<string, unknown>>;
          }>
        | null
      >
    | null;
}>;

export type CheckoutUcpHandlers = Readonly<{
  restHandlers: Readonly<Record<string, UcpHandler>>;
  mcpToolHandlers: Readonly<Record<string, UcpHandler>>;
}>;

type CheckoutIntentBody = Readonly<{
  source?: unknown;
  type?: unknown;
  intent?: unknown;
  items?: unknown;
  line_items?: unknown;
  shippingOption?: unknown;
  shipping_option?: unknown;
  optimizationGoal?: unknown;
  optimization_goal?: unknown;
  shippingAddress?: unknown;
  shipping_address?: unknown;
  readiness?: unknown;
  readinessSnapshotId?: unknown;
  readiness_snapshot_id?: unknown;
  readinessSourceRevision?: unknown;
  readiness_source_revision?: unknown;
  readinessDecisions?: unknown;
  readiness_decisions?: unknown;
  requestedBalanceCreditAmount?: unknown;
  fulfillmentPreviewRevision?: unknown;
  fulfillment_preview_revision?: unknown;
}>;

export function createCheckoutUcpHandlers(
  checkout: Pick<CheckoutServices, "sessions">,
  options: Readonly<{
    paymentHandoff?: UcpPaymentHandlerHandoff;
    signCheckout?: (checkout: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
    agentGrantSpendPolicy?: AgentGrantSpendPolicy;
  }> = {},
): CheckoutUcpHandlers {
  const handlers = {
    create_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.manage");
      if (access.error) {
        return access.error;
      }

      const body = await readInputObject<CheckoutIntentBody>(input);
      const source = readObject(body.source) ?? readObject(body.intent) ?? body;
      const sourceType = readString(source.type) ?? readString(body.type);

      try {
        const result =
          sourceType === "cart"
            ? await checkout.sessions.createFromCart(
                {
                  accountId: access.actor.accountId as AccountId,
                  shippingOption: readShippingOption(body),
                  optimizationGoal: readOptimizationGoal(body),
                  readinessSnapshotId: readCartReadinessSnapshotId(source, body),
                  readinessSourceRevision: readCartReadinessSourceRevision(source, body),
                  readinessDecisions: readCartReadinessDecisions(source, body),
                },
                access.context,
              )
            : sourceType === "offer-intent"
              ? await createOfferIntent(checkout, source, body, access)
              : await createBuyNow(checkout, source, body, access);

        const session = await checkout.sessions.getSession(result.sessionId, access.actor.accountId);

        return createUcpEnvelope("ok", {
          checkout: session
            ? sessionToUcpCheckout(session, options)
            : {
                id: result.sessionId,
                status: "started",
              },
        });
      } catch (error) {
        return validationError(error);
      }
    },
    get_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.view");
      if (access.error) {
        return access.error;
      }

      const sessionId = readCheckoutSessionId(input);
      const session = sessionId ? await checkout.sessions.getSession(sessionId, access.actor.accountId) : null;

      return session
        ? createUcpEnvelope("ok", { checkout: sessionToUcpCheckout(session, options) })
        : checkoutNotFound();
    },
    update_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.manage");
      if (access.error) {
        return access.error;
      }

      const sessionId = readCheckoutSessionId(input);
      if (!sessionId) {
        return validationError("Checkout session id is required.");
      }

      const body = await readInputObject<CheckoutIntentBody>(input);

      try {
        const shippingOption = readShippingOption(body);
        if (shippingOption) {
          await checkout.sessions.selectShippingOption(
            {
              sessionId,
              accountId: access.actor.accountId as AccountId,
              shippingOption,
            },
            access.context,
          );
        }

        const optimizationGoal = readOptimizationGoal(body);
        if (optimizationGoal) {
          await checkout.sessions.selectOptimizationGoal(
            {
              sessionId,
              accountId: access.actor.accountId as AccountId,
              optimizationGoal,
            },
            access.context,
          );
        }

        const shippingAddress = readShippingAddress(body.shippingAddress ?? body.shipping_address);
        if (shippingAddress) {
          await checkout.sessions.setShippingAddress(
            {
              sessionId,
              accountId: access.actor.accountId as AccountId,
              shippingAddress,
            },
            access.context,
          );
        }

        const session = await checkout.sessions.getSession(sessionId, access.actor.accountId);
        return session
          ? createUcpEnvelope("ok", { checkout: sessionToUcpCheckout(session, options) })
          : checkoutNotFound();
      } catch (error) {
        return validationError(error);
      }
    },
    complete_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.manage");
      if (access.error) {
        return access.error;
      }

      const sessionId = readCheckoutSessionId(input);
      const session = sessionId ? await checkout.sessions.getSession(sessionId, access.actor.accountId) : null;
      if (!session) {
        return checkoutNotFound();
      }

      const body = await readInputObject<Readonly<Record<string, unknown>>>(input);
      const checkoutPayload = sessionToUcpCheckout(session, options);
      const guardedPaymentResponse = await options.paymentHandoff?.evaluateCompleteRequest(body, checkoutPayload);
      if (guardedPaymentResponse?.kind === "respond") {
        return createUcpEnvelope(
          guardedPaymentResponse.response.ucp.status,
          {
            checkout: checkoutPayload,
            ...stripUcpEnvelope(guardedPaymentResponse.response),
          },
          guardedPaymentResponse.response.messages ?? [],
        );
      }

      if (guardedPaymentResponse?.kind === "headless-agentic-payment") {
        try {
          assertNoUnsupportedCustomerEconomicsInput(body);

          const shippingAddress = readShippingAddress(body.shippingAddress ?? body.shipping_address);
          if (shippingAddress) {
            await checkout.sessions.setShippingAddress(
              {
                sessionId,
                accountId: access.actor.accountId as AccountId,
                shippingAddress,
              },
              access.context,
            );
          }

          const refreshedSession = await checkout.sessions.getSession(sessionId, access.actor.accountId);
          if (!refreshedSession) {
            return checkoutNotFound();
          }
          if (refreshedSession.cancelled_at) {
            return createUcpEnvelope("ok", { checkout: sessionToUcpCheckout(refreshedSession, options) });
          }
          if (refreshedSession.source_type === "offer-intent") {
            return createUcpEnvelope(
              "requires_action",
              {
                checkout: sessionToUcpCheckout(refreshedSession, options),
                action: {
                  type: "trusted_checkout_handoff",
                  reason: "Purchase-intent offer submission still requires trusted UI review.",
                },
              },
              [
                {
                  severity: "warning",
                  code: "trusted_ui_required",
                  message: "UCP headless payment completion is only enabled for buy-now and cart checkout sessions.",
                },
              ],
            );
          }

          const marketplaceCheckoutFeeQuoteFingerprint = readNullableString(
            body.marketplaceCheckoutFeeQuoteFingerprint ?? body.marketplace_checkout_fee_quote_fingerprint,
          );
          if (!marketplaceCheckoutFeeQuoteFingerprint) {
            return createUcpEnvelope(
              "requires_action",
              {
                checkout: checkoutPayload,
                action: {
                  type: "trusted_checkout_handoff",
                  reason: "Payment quote review is required before headless checkout can create payment.",
                },
              },
              [
                {
                  severity: "warning",
                  code: "payment_quote_required",
                  message:
                    "Provide a reviewed marketplace checkout fee quote fingerprint or continue in the trusted checkout UI.",
                },
              ],
            );
          }

          let orderIds = [...refreshedSession.order_ids];
          let orderCreationWriteResult: unknown;
          if (orderIds.length === 0) {
            const readySession = await checkout.sessions.assertReadyForOrderCreation({
              sessionId,
              accountId: access.actor.accountId as AccountId,
            });
            const checkoutOrders = await createCheckoutOrdersThroughOrdering(input.request, readySession, {
              fulfillmentPreviewRevision: readNullableString(
                body.fulfillmentPreviewRevision ?? body.fulfillment_preview_revision,
              ),
              acknowledgedMaterialChanges:
                body.acknowledgedMaterialChanges === true || body.acknowledged_material_changes === true,
            });
            orderIds = checkoutOrders.orderIds;
            orderCreationWriteResult = checkoutOrders.writeResult;
            await checkout.sessions.recordOrdersCreated(
              {
                sessionId,
                accountId: access.actor.accountId as AccountId,
                orderIds,
                fulfilledLineKeys: checkoutOrders.readyLineKeys,
              },
              access.context,
            );
          }

          const requestedBalanceCreditAmount = readNullableString(
            body.requestedBalanceCreditAmount ?? body.requested_balance_credit_amount,
          );
          const paymentMethodCategory =
            readString(body.paymentMethodCategory ?? body.payment_method_category) ?? "card";
          const checkoutStatus = shouldAuthorizeAgentGrantSpend(options.agentGrantSpendPolicy, input)
            ? await getCheckoutPaymentStatusThroughPayments(
                input.request,
                orderIds,
                requestedBalanceCreditAmount,
                paymentMethodCategory,
                orderCreationWriteResult,
              )
            : null;
          if (checkoutStatus) {
            const spendGuard = await authorizeAgentGrantSpend(options.agentGrantSpendPolicy, input, {
              operation: "complete_checkout",
              operationId: `complete_checkout:${sessionId}:${readNullableString(body.idempotencyKey) ?? input.request.headers.get("Idempotency-Key") ?? "unknown"}`,
              amountCents: moneyToCents(checkoutStatus.marketplace_checkout_fee.total_amount),
              ...readCheckoutSpendContext(body, guardedPaymentResponse.agenticPayment),
            });
            if (spendGuard) {
              return spendGuard;
            }
          }

          const payment = await createCheckoutPaymentThroughPayments(
            input.request,
            sessionId,
            orderIds,
            requestedBalanceCreditAmount,
            paymentMethodCategory,
            marketplaceCheckoutFeeQuoteFingerprint,
            null,
            false,
            "/account/payments/:paymentId",
            guardedPaymentResponse.agenticPayment,
            orderCreationWriteResult,
            undefined,
            checkoutStatus ?? undefined,
          );
          const paymentId = payment.payment_id;
          await checkout.sessions.recordPaymentStarted(
            {
              sessionId,
              accountId: access.actor.accountId as AccountId,
              paymentId,
            },
            access.context,
          );
          const completedSession = await checkout.sessions.getSession(sessionId, access.actor.accountId);
          return createUcpEnvelope("ok", {
            checkout: completedSession ? sessionToUcpCheckout(completedSession, options) : checkoutPayload,
            payment_id: paymentId,
            order_ids: orderIds,
            ap2: {
              mandate_verification: "accepted",
              evidence: guardedPaymentResponse.evidence ?? null,
            },
          });
        } catch (error) {
          return validationError(error);
        }
      }

      if (session.payment_id || session.submitted_offer_id) {
        return createUcpEnvelope("ok", { checkout: sessionToUcpCheckout(session, options) });
      }
      if (session.cancelled_at) {
        return createUcpEnvelope("ok", { checkout: sessionToUcpCheckout(session, options) });
      }

      return createUcpEnvelope(
        "requires_action",
        {
          checkout: sessionToUcpCheckout(session, options),
          action: {
            type: "trusted_checkout_handoff",
            url: `/checkout/buy/session/${session.session_id}`,
            reason:
              "Checkout completion requires buyer review in trusted UI until Payments enables production AP2 mandate verification and payment-handler handoff.",
          },
        },
        [
          {
            severity: "warning",
            code: "trusted_ui_required",
            message: "Use trusted checkout handoff before creating orders or payment through an AI agent.",
          },
        ],
      );
    },
    cancel_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.manage");
      if (access.error) {
        return access.error;
      }

      const sessionId = readCheckoutSessionId(input);
      const session = sessionId ? await checkout.sessions.getSession(sessionId, access.actor.accountId) : null;
      if (!session) {
        return checkoutNotFound();
      }

      try {
        const releasedReservations = await releaseCheckoutInventoryReservations(input.request, session);
        const result = await checkout.sessions.cancelSession(
          {
            sessionId,
            accountId: access.actor.accountId as AccountId,
          },
          access.context,
        );
        return createUcpEnvelope("ok", {
          checkout: sessionToUcpCheckout(result.session, options),
          released_reservation_ids: releasedReservations.map((reservation) => reservation.holdId),
          ...(result.commitPosition ? { commit_position: result.commitPosition } : {}),
          ...(result.commitEventIds ? { commit_event_ids: result.commitEventIds } : {}),
          ...(result.commitPositions ? { commit_positions: result.commitPositions } : {}),
        });
      } catch (error) {
        return validationError(error);
      }
    },
  } satisfies Readonly<Record<string, UcpHandler>>;

  return {
    restHandlers: handlers,
    mcpToolHandlers: handlers,
  };
}

async function createBuyNow(
  checkout: Pick<CheckoutServices, "sessions">,
  source: Readonly<Record<string, unknown>>,
  body: CheckoutIntentBody,
  access: CheckoutAccess,
) {
  const item = readCheckoutItem(source, body);
  return checkout.sessions.createBuyNow(
    {
      accountId: access.actor.accountId as AccountId,
      listingId: readString(item.listingId ?? item.listing_id) ?? "",
      catalogItemId: readString(item.catalogItemId ?? item.catalog_item_id ?? item.id) ?? "",
      productId: readString(item.productId ?? item.product_id ?? item.variantId ?? item.variant_id) ?? "",
      itemTitle: readString(item.itemTitle ?? item.title) ?? "",
      itemSubtitle: readNullableString(item.itemSubtitle ?? item.subtitle),
      selectedOptions: readSelectedOptions(item.selectedOptions ?? item.selected_options),
      productSummary: readNullableString(item.productSummary ?? item.product_summary),
      quantity: readQuantity(item.quantity),
      fulfillmentMode:
        readString(item.fulfillmentMode ?? item.fulfillment_mode) === "locked-listing" ? "locked-listing" : "optimize",
      lockedListingId: readNullableString(
        item.lockedListingId ?? item.locked_listing_id ?? item.listingId ?? item.listing_id,
      ),
      sellerPreferenceId: readNullableString(item.sellerPreferenceId ?? item.seller_preference_id),
      shippingOption: readShippingOption(body),
      optimizationGoal: readOptimizationGoal(body),
      fulfillmentPreviewRevision:
        readNullableString(
          item.fulfillmentPreviewRevision ??
            item.fulfillment_preview_revision ??
            source.fulfillmentPreviewRevision ??
            source.fulfillment_preview_revision ??
            body.fulfillmentPreviewRevision ??
            body.fulfillment_preview_revision,
        ) ?? "",
    },
    access.context,
  );
}

async function createOfferIntent(
  checkout: Pick<CheckoutServices, "sessions">,
  source: Readonly<Record<string, unknown>>,
  body: CheckoutIntentBody,
  access: CheckoutAccess,
) {
  if (access.actor.roleKey === "guest-buyer") {
    throw new Error("Register or sign in before placing purchase intent.");
  }

  const item = readCheckoutItem(source, body);
  const offerPriceAmount =
    readNullableString(source.offerPriceAmount ?? source.offer_price_amount) ??
    readMoneyMajorUnits(readObject(source.offerPrice ?? source.offer_price)) ??
    "";

  // Purchase-intent offers are non-binding bids that move no money on their own; the spending
  // mandate is enforced at the payment completion path where a PaymentIntent is created.
  return checkout.sessions.createOfferIntent(
    {
      accountId: access.actor.accountId as AccountId,
      catalogItemId: readString(item.catalogItemId ?? item.catalog_item_id ?? item.id) ?? "",
      productId: readString(item.productId ?? item.product_id ?? item.variantId ?? item.variant_id) ?? "",
      itemTitle: readString(item.itemTitle ?? item.title) ?? "",
      itemSubtitle: readNullableString(item.itemSubtitle ?? item.subtitle),
      selectedOptions: readSelectedOptions(item.selectedOptions ?? item.selected_options),
      productSummary: readNullableString(item.productSummary ?? item.product_summary),
      offerPriceAmount,
      quantity: readQuantity(item.quantity),
      shippingOption: readShippingOption(body),
      optimizationGoal: readOptimizationGoal(body),
    },
    access.context,
  );
}

type CheckoutAccess = Exclude<ReturnType<typeof requireCheckoutAccess>, { error: UcpEnvelope }>;

function requireCheckoutAccess(input: UcpOperationHandlerInput, permission: "orders.view" | "orders.manage") {
  if (!input.actor) {
    return {
      error: createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "authentication_required",
          message: "UCP checkout requires a linked buyer account.",
        },
      ]),
    };
  }

  if (!input.actor.permissions.includes(permission) && !input.actor.permissions.includes("guest-checkout.manage")) {
    return {
      error: createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "authorization_forbidden",
          message: "The linked buyer account cannot manage this checkout session.",
        },
      ]),
    };
  }

  if (!input.context) {
    return {
      error: createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "context_required",
          message: "UCP checkout requires an event-store context.",
        },
      ]),
    };
  }

  return {
    actor: input.actor,
    context: input.context,
  };
}

function sessionToUcpCheckout(
  session: CheckoutSessionRow,
  options: Readonly<{
    paymentHandoff?: UcpPaymentHandlerHandoff;
    signCheckout?: (checkout: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  }> = {},
) {
  const checkout = {
    id: session.session_id,
    status: session.cancelled_at
      ? "cancelled"
      : session.payment_id
        ? "payment_started"
        : session.submitted_offer_id
          ? "purchase_intent_submitted"
          : "started",
    source_type: session.source_type,
    shipping_option: session.shipping_option,
    optimization_goal: session.optimization_goal,
    shipping_address: session.shipping_address,
    line_items: session.lines.map((line) => ({
      catalog_item_id: line.catalogItemId,
      product_id: line.productId,
      listing_id: line.listingId,
      title: line.itemTitle,
      subtitle: line.itemSubtitle,
      selected_options: line.selectedOptions,
      product_summary: line.productSummary,
      quantity: line.quantity,
      fulfillment_mode: line.fulfillmentMode ?? "optimize",
      availability_state: line.availabilityState ?? "available",
    })),
    order_ids: session.order_ids,
    payment_id: session.payment_id,
    offer_id: session.submitted_offer_id,
    cancelled_at: session.cancelled_at,
    ...(options.paymentHandoff ? { payment: options.paymentHandoff.payment } : {}),
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
  return options.signCheckout ? options.signCheckout(checkout) : checkout;
}

function stripUcpEnvelope(envelope: UcpEnvelope) {
  const { ucp: _ucp, messages: _messages, ...payload } = envelope;
  return payload;
}

function readCheckoutSessionId(input: UcpOperationHandlerInput) {
  return input.params.id || readString(input.arguments.id) || "";
}

function readCheckoutItem(source: Readonly<Record<string, unknown>>, body: CheckoutIntentBody) {
  const sourceItem = readObject(source.item) ?? source;
  const items = Array.isArray(source.items)
    ? source.items
    : Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.line_items)
        ? body.line_items
        : [];
  return readObject(items[0]) ?? sourceItem;
}

async function readInputObject<T extends Readonly<Record<string, unknown>>>(
  input: UcpOperationHandlerInput,
): Promise<T> {
  const args = input.arguments ?? {};
  return Object.keys(args).length > 0 ? (args as T) : readJsonObject<T>(input.request);
}

async function readJsonObject<T extends Readonly<Record<string, unknown>>>(request: Request): Promise<T> {
  const value = await request
    .clone()
    .json()
    .catch(() => ({}));
  return (readObject(value) ?? {}) as T;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readQuantity(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : 1;
}

function readShippingOption(body: CheckoutIntentBody) {
  return readString(body.shippingOption ?? body.shipping_option);
}

function readOptimizationGoal(body: CheckoutIntentBody): CheckoutOptimizationGoal | undefined {
  const value = readString(body.optimizationGoal ?? body.optimization_goal);
  return value === "fewest-shipments" ? "fewest-shipments" : value === "lowest-total" ? "lowest-total" : undefined;
}

function readReadinessSource(source: Readonly<Record<string, unknown>>, body: CheckoutIntentBody) {
  return readObject(source.readiness) ?? readObject(body.readiness) ?? source;
}

function readCartReadinessSnapshotId(source: Readonly<Record<string, unknown>>, body: CheckoutIntentBody) {
  const readiness = readReadinessSource(source, body);
  return (
    readString(readiness.snapshotId ?? readiness.snapshot_id) ??
    readString(source.readinessSnapshotId ?? source.readiness_snapshot_id) ??
    readString(body.readinessSnapshotId ?? body.readiness_snapshot_id) ??
    ""
  );
}

function readCartReadinessSourceRevision(source: Readonly<Record<string, unknown>>, body: CheckoutIntentBody) {
  const readiness = readReadinessSource(source, body);
  return (
    readString(readiness.sourceRevision ?? readiness.source_revision) ??
    readString(source.readinessSourceRevision ?? source.readiness_source_revision) ??
    readString(body.readinessSourceRevision ?? body.readiness_source_revision) ??
    ""
  );
}

function readCartReadinessDecisions(
  source: Readonly<Record<string, unknown>>,
  body: CheckoutIntentBody,
): CartReadinessDecisionInput | undefined {
  const readiness = readReadinessSource(source, body);
  const raw =
    readiness.decisions ??
    source.readinessDecisions ??
    source.readiness_decisions ??
    body.readinessDecisions ??
    body.readiness_decisions;
  const decisions = readObject(raw);
  if (!decisions) {
    return undefined;
  }

  return parseCartReadinessDecisionInput(decisions);
}

function readShippingAddress(value: unknown): CheckoutShippingAddress | null {
  const source = readObject(value);
  if (!source) {
    return null;
  }

  return {
    name: String(source.name ?? ""),
    company: readNullableString(source.company),
    line1: String(source.line1 ?? source.line_1 ?? ""),
    line2: readNullableString(source.line2 ?? source.line_2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? source.postal_code ?? ""),
    country: String(source.country ?? "US"),
    phone: readNullableString(source.phone),
    email: readNullableString(source.email),
  };
}

function readSelectedOptions(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(readObject)
        .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null)
        .map((entry) => ({
          dimensionId: readString(entry.dimensionId ?? entry.dimension_id) ?? "",
          optionId: readString(entry.optionId ?? entry.option_id) ?? "",
        }))
    : [];
}

function readMoneyMajorUnits(value: Readonly<Record<string, unknown>> | null) {
  if (!value) {
    return null;
  }

  const amount = readString(value.amount);
  if (!amount) {
    return null;
  }

  return `${amount.slice(0, -2) || "0"}.${amount.slice(-2).padStart(2, "0")}`;
}

function shouldAuthorizeAgentGrantSpend(
  spendPolicy: AgentGrantSpendPolicy | undefined,
  input: UcpOperationHandlerInput,
) {
  return spendPolicy !== undefined && agentGrantIdFromActor(input.actor) !== null;
}

async function authorizeAgentGrantSpend(
  spendPolicy: AgentGrantSpendPolicy | undefined,
  input: UcpOperationHandlerInput,
  params: Readonly<{
    operation: string;
    operationId: string;
    amountCents: number;
    rail?: AgentGrantRail | null;
    humanPresent?: boolean;
    humanNotPresentAuthorized?: boolean;
  }>,
): Promise<UcpEnvelope | null> {
  const grantId = agentGrantIdFromActor(input.actor);
  if (!spendPolicy || !grantId) {
    return null;
  }

  const decision = await spendPolicy.authorize({
    grantId,
    accountId: input.actor?.accountId ?? null,
    operation: params.operation,
    operationId: params.operationId,
    amountCents: params.amountCents,
    rail: params.rail,
    humanPresent: params.humanPresent,
    humanNotPresentAuthorized: params.humanNotPresentAuthorized,
  });
  if (decision.allowed) {
    return null;
  }

  // Elicitation-style response the agent surfaces to the human: it names the mandate limit
  // that was hit and hands off to a trusted checkout so a person can approve the purchase.
  return createUcpEnvelope(
    "requires_action",
    {
      action: {
        type: "trusted_checkout_handoff",
        reason: decision.reason,
      },
      guardrail: {
        type: "agent_grant_spending_mandate",
        limit_kind: decision.limitKind,
        cap_cents: decision.capCents,
        remaining_cents: decision.remainingCents,
      },
    },
    [
      {
        severity: "error",
        code: "agent_grant_spending_mandate_blocked",
        message: decision.reason,
      },
    ],
  );
}

// Derives the payment-rail and human-presence signals a completion carries so the mandate
// policy can decide whether an autonomous, human-not-present purchase is permitted.
function readCheckoutSpendContext(
  body: Readonly<Record<string, unknown>>,
  agenticPayment: unknown,
): Readonly<{ rail: AgentGrantRail; humanPresent: boolean; humanNotPresentAuthorized: boolean }> {
  const ap2 = readObject(body.ap2);
  const payment = readObject(agenticPayment);
  const kind = readString(payment?.kind);
  const rail: AgentGrantRail = kind === "stored-payment-method" ? "stored-pm" : "ap2";
  const humanPresent = ap2?.human_present === true || body.human_present === true;
  const humanNotPresentAuthorized =
    readString(payment?.ap2PaymentMandateId) !== undefined || ap2?.human_not_present === true;
  return { rail, humanPresent, humanNotPresentAuthorized };
}

function moneyToCents(value: unknown) {
  const raw = readNullableString(value);
  if (!raw || !/^\d+(\.\d{1,2})?$/.test(raw)) {
    return 0;
  }

  return Math.round(Number(raw) * 100);
}

function checkoutNotFound() {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "checkout_not_found",
      message: "Checkout could not resolve the requested checkout session for the linked buyer account.",
    },
  ]);
}

function validationError(error: unknown) {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: error instanceof CheckoutDomainError ? error.code : "validation_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  ]);
}
