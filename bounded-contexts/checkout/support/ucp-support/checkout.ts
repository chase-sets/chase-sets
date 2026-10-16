import { createHash } from "node:crypto";
import { getMutationResultCommandReceipt, type ResponseConsistencyMetadata } from "@chase-sets/http/responses";
import { createUcpEnvelope, readUcpRequestMeta, type UcpEnvelope } from "@chase-sets/platform-runtime/ucp";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import {
  agentGrantIdFromActor,
  type AgentGrantRail,
  type AgentGrantSpendPolicy,
} from "@chase-sets/platform-runtime/agent-guardrails";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { UcpPaymentHandlerHandoff as PaymentsUcpPaymentHandlerHandoff } from "@chase-sets/payments/server";
import {
  createCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments,
  getCheckoutPaymentStatusThroughPayments,
  releaseCheckoutInventoryReservations,
} from "../request-support/checkout-confirmation";
import type { CheckoutServices } from "../runtime-support/services";
import { CheckoutDomainError } from "../runtime-support/common";
import { OrderCartCleanupError, type CheckoutSessionMutationResult } from "../../features/sessions/api/runtime";
import type { CheckoutSessionRow } from "../../features/sessions/read-model/queries";
import type { CheckoutOptimizationGoal, CheckoutShippingAddress } from "../../features/sessions/domain/domain";
import { parseCartReadinessDecisionInput, type CartReadinessDecisionInput } from "../../features/cart/domain/readiness";
import { assertNoUnsupportedCustomerEconomicsInput } from "../../features/sessions/api/checkout-economics-runtime";
import { prepareBuyNowCheckout } from "../../features/sessions/api/buy-now-preparation";

type UcpHandler = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope>;

function checkoutClosedResponse() {
  return createUcpEnvelope("error", {}, [
    { severity: "error", code: "checkout_closed", message: "Checkout is closed until public launch." },
  ]);
}

// Checkout embeds the Payments-declared handlers in its responses and lets Payments decide whether a
// completion request names a saved checkout instrument; the decision type stays Payments-owned.
type UcpPaymentHandlerHandoff = Readonly<{
  payment: Readonly<Record<string, unknown>>;
  evaluateCompleteRequest: PaymentsUcpPaymentHandlerHandoff["evaluateCompleteRequest"];
}>;

export type CheckoutUcpOrderFact = Readonly<{
  id: string;
  status?: string | null;
  readyForFulfillmentAt?: string | null;
  label?: string;
  permalinkUrl?: string;
}>;

export type CheckoutUcpListing = Readonly<{
  listing_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  product_summary: string | null;
  selected_options: unknown;
  inventory_item_id: string;
  account_id: string;
  price_amount: string;
  price_currency_code: string | null;
  visible_quantity: number;
}>;

export type CheckoutUcpHandlers = Readonly<{
  restHandlers: Readonly<Record<string, UcpHandler>>;
  mcpToolHandlers: Readonly<Record<string, UcpHandler>>;
}>;

type CheckoutIntentBody = Readonly<{
  checkout?: unknown;
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

function orderingCommitPositions(source: unknown) {
  const metadata =
    getMutationResultCommandReceipt(source) ??
    (typeof source === "object" && source !== null ? (source as ResponseConsistencyMetadata) : null);
  return (metadata?.commitPositions ?? []).filter((position) => position.sourceContextName === "ordering");
}

function cleanupWriteMetadata(result: Partial<CheckoutSessionMutationResult> | undefined) {
  return result
    ? {
        ...(result.commitPosition ? { commit_position: result.commitPosition } : {}),
        ...(result.commitEventIds ? { commit_event_ids: result.commitEventIds } : {}),
        ...(result.commitPositions ? { commit_positions: result.commitPositions } : {}),
      }
    : {};
}

export function createCheckoutUcpHandlers(
  checkout: Pick<CheckoutServices, "sessions">,
  options: Readonly<{
    checkoutClosed?: boolean;
    paymentHandoff?: UcpPaymentHandlerHandoff;
    agentGrantSpendPolicy?: AgentGrantSpendPolicy;
    getPublicListingById?: (listingId: string) => Promise<CheckoutUcpListing | null>;
    getOrderFacts?: (orderIds: readonly string[], accountId: string) => Promise<readonly CheckoutUcpOrderFact[]>;
    now?: () => Date;
  }> = {},
): CheckoutUcpHandlers {
  // Headless completion over the stored-payment-method off-session rail. Creates orders once,
  // enforces the agent grant's spending mandate against the server-computed total, charges through
  // Payments, and hands a 3DS/SCA challenge back to the human as a hosted URL when the processor
  // demands one. Idempotent on replay: order creation and payment
  // creation are single-flight, and spend authorization is deduped by operation id, so re-invoking
  // after the buyer clears a challenge resumes to the same payment.
  const completeHeadlessCheckout = async (
    input: UcpOperationHandlerInput,
    access: CheckoutAccess,
    sessionId: string,
    body: Readonly<Record<string, unknown>>,
    checkoutPayload: Readonly<Record<string, unknown>>,
    savedCheckoutInstrumentId: string,
  ): Promise<UcpEnvelope> => {
    assertNoUnsupportedCustomerEconomicsInput(body);

    let cleanupResult: CheckoutSessionMutationResult | undefined;
    let refreshedSession = await checkout.sessions.getSession(sessionId, access.actor.accountId);
    if (!refreshedSession) return checkoutNotFound();
    if (refreshedSession.order_ids.length > 0) {
      cleanupResult = await checkout.sessions.resumeOrderCartCleanup(
        { sessionId, accountId: access.actor.accountId as AccountId },
        access.context,
      );
      refreshedSession = cleanupResult.session;
    } else {
      const shippingAddress = readShippingAddress(body.shippingAddress ?? body.shipping_address);
      if (shippingAddress) {
        await checkout.sessions.setShippingAddress(
          { sessionId, accountId: access.actor.accountId as AccountId, shippingAddress },
          access.context,
        );
        refreshedSession = await checkout.sessions.getSession(sessionId, access.actor.accountId);
        if (!refreshedSession) return checkoutNotFound();
      }
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
          ...cleanupWriteMetadata(cleanupResult),
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
      refreshedSession = readySession;
      orderIds = [...readySession.order_ids];
      if (orderIds.length > 0) {
        cleanupResult = await checkout.sessions.resumeOrderCartCleanup(
          { sessionId, accountId: access.actor.accountId as AccountId },
          access.context,
        );
        refreshedSession = cleanupResult.session;
        orderIds = [...refreshedSession.order_ids];
      } else {
        const checkoutOrders = await createCheckoutOrdersThroughOrdering(input.request, readySession, {
          fulfillmentPreviewRevision: readNullableString(
            body.fulfillmentPreviewRevision ?? body.fulfillment_preview_revision,
          ),
          acknowledgedMaterialChanges:
            body.acknowledgedMaterialChanges === true || body.acknowledged_material_changes === true,
        });
        orderIds = checkoutOrders.orderIds;
        orderCreationWriteResult = checkoutOrders.writeResult;
        const ordersResult = await checkout.sessions.recordOrdersCreated(
          {
            sessionId,
            accountId: access.actor.accountId as AccountId,
            orderIds,
            fulfilledLineKeys: checkoutOrders.readyLineKeys,
            orderWriteCommitPositions: orderingCommitPositions(orderCreationWriteResult),
          },
          access.context,
        );
        cleanupResult = ordersResult;
        refreshedSession = ordersResult.session;
        orderIds = [...refreshedSession.order_ids];
      }
    }

    orderCreationWriteResult ??=
      refreshedSession.order_write_commit_positions.length > 0
        ? {
            commandReceipt: {
              commitEventIds: refreshedSession.order_write_commit_positions.flatMap((position) => position.eventIds),
              commitPositions: refreshedSession.order_write_commit_positions,
            },
          }
        : undefined;

    const requestedBalanceCreditAmount = readNullableString(
      body.requestedBalanceCreditAmount ?? body.requested_balance_credit_amount,
    );
    const paymentMethodCategory = readString(body.paymentMethodCategory ?? body.payment_method_category) ?? "card";
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
        // The saved instrument carries the buyer's standing off-session consent captured at setup, so a
        // human-not-present charge is authorized here; the grant's mandate still gates the stored-pm rail
        // and the per-order/daily/monthly caps.
        rail: "stored-pm",
        humanPresent: false,
        humanNotPresentAuthorized: true,
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
      savedCheckoutInstrumentId,
      false,
      "/account/payments/:paymentId",
      null,
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
    const completedCheckoutPayload = completedSession
      ? sessionToUcpCheckout(completedSession, options)
      : checkoutPayload;

    // A 3DS/SCA challenge appears as a hosted next-action URL on a not-yet-settled payment. Surface
    // it as a requires_action handoff the agent gives the human; the payment id lets them poll and
    // resume complete_checkout once the buyer finishes authenticating.
    const challengeUrl = readPaymentChallengeUrl(payment);
    if (challengeUrl) {
      return createUcpEnvelope(
        "requires_action",
        {
          ...cleanupWriteMetadata(cleanupResult),
          checkout: completedCheckoutPayload,
          payment_id: paymentId,
          order_ids: orderIds,
          action: {
            type: "payment_challenge",
            url: challengeUrl,
            reason:
              "This payment needs the buyer to finish a secure bank verification (3-D Secure). Share the link so they can complete it, then call complete_checkout again to resume.",
            payment_id: paymentId,
            resume: {
              operation: "complete_checkout",
              checkout_id: sessionId,
            },
          },
        },
        [
          {
            severity: "warning",
            code: "payment_challenge_required",
            message:
              "Off-session payment requires a 3-D Secure / SCA challenge; hand off the hosted URL to the buyer to authenticate.",
          },
        ],
      );
    }

    return createUcpEnvelope("ok", {
      ...cleanupWriteMetadata(cleanupResult),
      checkout: completedCheckoutPayload,
      payment_id: paymentId,
      order_ids: orderIds,
      payment_rail: "stored-payment-method",
    });
  };

  const handlers = {
    create_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.manage");
      if (access.error) {
        return access.error;
      }
      if (options.checkoutClosed) return checkoutClosedResponse();

      try {
        const body = await readInputObject<CheckoutIntentBody>(input);
        if (Object.hasOwn(body, "source") || Object.hasOwn(body, "intent") || Object.hasOwn(body, "items"))
          throw new CheckoutDomainError("Only the checkout resource is accepted.", "invalid_request");
        const checkoutBody = readObject(body.checkout);
        if (checkoutBody && Object.hasOwn(checkoutBody, "id"))
          throw new CheckoutDomainError(
            "Checkout resource ids must be supplied as the top-level id.",
            "invalid_request",
          );
        const lineItems = readLineItems(body);
        if (lineItems.length !== 1)
          throw new CheckoutDomainError("Only one checkout line item is supported.", "multiple_line_items_unsupported");
        const item = readObject(lineItems[0]);
        if (!item) throw new CheckoutDomainError("Checkout line item is required.", "invalid_request");
        const result = await createUcpBuyNow(checkout, options, input, access, item);

        const session = await checkout.sessions.getSession(result.sessionId, access.actor.accountId);

        return createUcpEnvelope("ok", {
          checkout: session
            ? await ucpCheckoutPayload(checkout, options, input, session)
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
      if (!isCheckoutSessionId(sessionId, !options.getPublicListingById))
        return validationError(new CheckoutDomainError("Checkout id is invalid.", "invalid_request"));
      const session = sessionId ? await checkout.sessions.getSession(sessionId, access.actor.accountId) : null;

      return session
        ? createUcpEnvelope("ok", { checkout: await ucpCheckoutPayload(checkout, options, input, session) })
        : checkoutNotFound();
    },
    update_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.manage");
      if (access.error) {
        return access.error;
      }
      if (options.checkoutClosed) return checkoutClosedResponse();

      const sessionId = readCheckoutSessionId(input);
      if (!sessionId) {
        return validationError("Checkout session id is required.");
      }

      try {
        if (!isCheckoutSessionId(sessionId, !options.getPublicListingById))
          throw new CheckoutDomainError("Checkout id is invalid.", "invalid_request");
        const body = await readInputObject<CheckoutIntentBody>(input);
        const checkoutBody = readObject(body.checkout);
        if (checkoutBody && Object.hasOwn(checkoutBody, "id"))
          throw new CheckoutDomainError(
            "Checkout resource ids must be supplied as the top-level id.",
            "invalid_request",
          );
        const lineItems = readLineItems(body);
        const session = await checkout.sessions.getSession(sessionId, access.actor.accountId);
        if (!session) return checkoutNotFound();
        if (
          lineItems.length > 0 &&
          JSON.stringify(lineItems) !==
            JSON.stringify(session.lines.map((line) => ({ id: line.listingId, quantity: line.quantity })))
        ) {
          throw new CheckoutDomainError("Checkout line updates are not supported.", "line_items_update_unsupported");
        }
        if (
          session.handoff_expires_at &&
          !hasOrders(session) &&
          Date.parse(session.handoff_expires_at) <= (options.now?.() ?? new Date()).getTime()
        ) {
          throw new CheckoutDomainError("This checkout handoff has expired. Start a new checkout.", "checkout_expired");
        }
        return session
          ? createUcpEnvelope("ok", { checkout: await ucpCheckoutPayload(checkout, options, input, session) })
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
      if (options.checkoutClosed) return checkoutClosedResponse();

      try {
        const sessionId = readCheckoutSessionId(input);
        let session = sessionId ? await checkout.sessions.getSession(sessionId, access.actor.accountId) : null;
        if (!session) {
          return checkoutNotFound();
        }

        if (!isCheckoutSessionId(sessionId, !options.getPublicListingById))
          throw new CheckoutDomainError("Checkout id is invalid.", "invalid_request");
        if (!options.getPublicListingById && !isCheckoutSessionId(sessionId)) {
          const body = await readInputObject<Readonly<Record<string, unknown>>>(input);
          const checkoutPayload = sessionToUcpCheckout(session, options);
          const paymentDecision = options.paymentHandoff?.evaluateCompleteRequest(body);
          if (paymentDecision?.kind === "headless-stored-payment-method") {
            return await completeHeadlessCheckout(
              input,
              access,
              sessionId,
              body,
              checkoutPayload,
              paymentDecision.savedCheckoutInstrumentId,
            );
          }
          if (session.payment_id || session.submitted_offer_id || session.cancelled_at) {
            return createUcpEnvelope("ok", { checkout: checkoutPayload });
          }
          return createUcpEnvelope(
            "requires_action",
            {
              checkout: checkoutPayload,
              action: { type: "trusted_checkout_handoff", url: checkoutContinueUrl(input.request, session.session_id) },
            },
            [
              {
                severity: "warning",
                code: "trusted_ui_required",
                message: "Use trusted checkout handoff before creating orders or payment through an AI agent.",
              },
            ],
          );
        }
        const payload = await ucpCheckoutPayload(checkout, options, input, session);
        return createUcpEnvelope("requires_action", { checkout: payload }, [
          {
            severity: "warning",
            code: "payment_required",
            message: "Continue in trusted checkout to confirm payment.",
            target: "$.checkout",
          },
        ]);
      } catch (error) {
        return validationError(error);
      }
    },
    cancel_checkout: async (input: UcpOperationHandlerInput) => {
      const access = requireCheckoutAccess(input, "orders.manage");
      if (access.error) {
        return access.error;
      }

      const sessionId = readCheckoutSessionId(input);
      if (!isCheckoutSessionId(sessionId, !options.getPublicListingById))
        return validationError(new CheckoutDomainError("Checkout id is invalid.", "invalid_request"));
      const session = sessionId ? await checkout.sessions.getSession(sessionId, access.actor.accountId) : null;
      if (!session) {
        return checkoutNotFound();
      }

      try {
        if (!isSignedAttempt(input.request) && (options.getPublicListingById || isCheckoutSessionId(sessionId))) {
          return createUcpEnvelope("ok", { checkout: await ucpCheckoutPayload(checkout, options, input, session) });
        }
        const releasedReservations = await releaseCheckoutInventoryReservations(input.request, session);
        const result = await checkout.sessions.cancelSession(
          { sessionId, accountId: access.actor.accountId as AccountId },
          access.context,
        );
        return createUcpEnvelope("ok", {
          checkout: await ucpCheckoutPayload(checkout, options, input, result.session),
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

function readLineItems(body: Readonly<Record<string, unknown>>) {
  const checkout = readObject(body.checkout);
  const value = checkout?.line_items ?? body.line_items;
  return Array.isArray(value) ? value : [];
}

function isCheckoutSessionId(value: string, legacy = false) {
  return (legacy ? /^chk_[0-9A-Za-z]{1,32}$/ : /^chk_[0-9A-Za-z]{26,32}$/).test(value);
}

function hasOrders(session: CheckoutSessionRow) {
  return session.order_ids.length > 0;
}

function isSignedAttempt(request: Request) {
  return ["Signature-Input", "Signature", "Content-Digest"].some((name) => request.headers.has(name));
}

function checkoutContinueUrl(request: Request, sessionId: string) {
  return `${resolvePublicRequestOrigin(request)}/checkout/buy/session/${encodeURIComponent(sessionId)}`;
}

export function checkoutUcpState(
  session: CheckoutSessionRow,
  orderFacts: readonly CheckoutUcpOrderFact[] = [],
  paymentSummary: Readonly<{ status?: string | null }> | null = null,
  currentPreview: Readonly<{
    readyLineKeys?: readonly string[];
    unavailableLines?: readonly unknown[];
    unavailableLineKeys?: readonly string[];
  }> | null = null,
  now = new Date(),
) {
  const continueUrl = `/checkout/buy/session/${encodeURIComponent(session.session_id)}`;
  const message = (code: string, target?: string, recoverability: "recoverable" | "unrecoverable" = "recoverable") => ({
    severity: "warning" as const,
    code,
    message:
      code === "checkout_expired"
        ? "This checkout has expired. Start a new checkout."
        : code === "payment_confirmation_required"
          ? "Buyer confirmation is required to continue payment."
          : code === "item_unavailable"
            ? "This item is no longer available."
            : "Payment is required to continue checkout.",
    ...(target ? { target } : {}),
    recoverability,
  });
  if (
    session.cancelled_at ||
    (session.order_ids.length > 0 && orderFacts.length > 0 && orderFacts.every((fact) => fact.status === "cancelled"))
  ) {
    return { status: "canceled" as const, messages: [] as const };
  }
  if (session.order_ids.length > 0) {
    if (orderFacts.length > 0 && orderFacts.every((fact) => Boolean(fact.readyForFulfillmentAt))) {
      return {
        status: "completed" as const,
        order: orderFacts.map((fact) => ({
          id: fact.id,
          label: fact.label ?? fact.id,
          permalink_url: fact.permalinkUrl ?? `/account/purchases/${fact.id}`,
        })),
        messages: [] as const,
      };
    }
    if (paymentSummary?.status === "captured")
      return { status: "complete_in_progress" as const, messages: [] as const };
    if (paymentSummary?.status === "pending-confirmation")
      return {
        status: "requires_escalation" as const,
        continue_url: continueUrl,
        messages: [message("payment_confirmation_required")],
      };
    return {
      status: "requires_escalation" as const,
      continue_url: continueUrl,
      messages: [message("payment_required")],
    };
  }
  if (session.handoff_expires_at && now.getTime() >= Date.parse(session.handoff_expires_at)) {
    return {
      status: "canceled" as const,
      expires_at: session.handoff_expires_at,
      messages: [message("checkout_expired", undefined, "unrecoverable")],
    };
  }
  if ((currentPreview?.unavailableLines?.length ?? 0) > 0 || (currentPreview?.unavailableLineKeys?.length ?? 0) > 0) {
    return {
      status: "incomplete" as const,
      messages: [message("item_unavailable", "$.line_items[0]", "unrecoverable")],
    };
  }
  return { status: "requires_escalation" as const, continue_url: continueUrl, messages: [message("payment_required")] };
}

async function ucpCheckoutPayload(
  checkout: Pick<CheckoutServices, "sessions">,
  options: Readonly<{
    getOrderFacts?: (orderIds: readonly string[], accountId: string) => Promise<readonly CheckoutUcpOrderFact[]>;
    now?: () => Date;
    paymentHandoff?: UcpPaymentHandlerHandoff;
  }>,
  input: UcpOperationHandlerInput,
  session: CheckoutSessionRow,
) {
  const facts = options.getOrderFacts ? await options.getOrderFacts(session.order_ids, session.buyer_account_id) : [];
  const payment = session.payment_id ? await checkout.sessions.getPaymentSummary(session.payment_id) : null;
  const state = checkoutUcpState(
    session,
    facts,
    payment,
    session.fulfillment_preview_snapshot,
    options.now?.() ?? new Date(),
  );
  return {
    ...sessionToUcpCheckout(session, options),
    status: state.status,
    ...(state.continue_url ? { continue_url: checkoutContinueUrl(input.request, session.session_id) } : {}),
    ...(session.handoff_expires_at ? { expires_at: session.handoff_expires_at } : {}),
    ...(state.order ? { order: state.order } : {}),
    ...(state.messages.length > 0 ? { messages: state.messages } : {}),
  };
}

async function createUcpBuyNow(
  checkout: Pick<CheckoutServices, "sessions">,
  options: Readonly<{
    getPublicListingById?: (listingId: string) => Promise<CheckoutUcpListing | null>;
    now?: () => Date;
  }>,
  input: UcpOperationHandlerInput,
  access: CheckoutAccess,
  item: Readonly<Record<string, unknown>>,
) {
  if (!options.getPublicListingById) {
    return createBuyNow(checkout, item, item as CheckoutIntentBody, access);
  }
  const listingId = readString(item.id);
  if (!listingId) throw new CheckoutDomainError("Checkout line item id is required.", "invalid_request");
  const quantity = item.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1)
    throw new CheckoutDomainError("Quantity must be a positive integer.", "invalid_quantity");
  const unit = readObject(item.quantity_unit ?? item.quantityUnit);
  if (unit && (unit.unit !== "C62" || unit.scale !== 0))
    throw new CheckoutDomainError("Only C62 quantity units are supported.", "quantity_unit_mismatch");
  const listing = await options.getPublicListingById(listingId);
  if (!listing || listing.visible_quantity < quantity)
    throw new CheckoutDomainError("This item is no longer available.", "item_unavailable");
  const meta =
    input.requestMeta ??
    readUcpRequestMeta(input.request, {
      ...input.arguments,
      ...(await readJsonObject(input.request)),
    });
  const sessionId = meta.retryKey
    ? (`chk_${createHash("sha256").update(`${access.actor.accountId}:${meta.retryKey}:${listingId}`).digest("hex").slice(0, 28)}` as never)
    : undefined;
  const prepared = await prepareBuyNowCheckout({
    request: input.request,
    services: checkout.sessions,
    accountId: access.actor.accountId as AccountId,
    listing: {
      listingId: listing.listing_id,
      catalogItemId: listing.catalog_catalog_item_id,
      productId: listing.product_id,
      itemTitle: listing.item_title ?? listing.product_summary ?? listing.listing_id,
      itemSubtitle: listing.item_subtitle,
      productSummary: listing.product_summary,
      selectedOptions: readSelectedOptions(listing.selected_options),
    },
    quantity,
    context: access.context,
    sessionIdOverride: sessionId,
    handoffExpiresAt: new Date((options.now?.() ?? new Date()).getTime() + 6 * 60 * 60 * 1000).toISOString(),
  });
  return prepared;
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
  const offerMoney = readObject(source.offerPrice ?? source.offer_price);
  const offerPriceCurrencyCode =
    readString(source.offerPriceCurrencyCode ?? source.offer_price_currency_code) ??
    readString(offerMoney?.currency ?? offerMoney?.currencyCode ?? offerMoney?.currency_code) ??
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
      offerPriceCurrencyCode,
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
  }> = {},
) {
  return {
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

// A 3DS/SCA challenge shows up as a hosted next-action URL on a payment that has not yet settled.
// Off-session saved-instrument and shared-token charges only carry a redirect URL when the processor
// demands additional buyer authentication, so its presence is the challenge signal to hand off.
function readPaymentChallengeUrl(
  payment: Readonly<{ status?: unknown; processor_redirect_url?: unknown }>,
): string | null {
  const status = typeof payment.status === "string" ? payment.status : "";
  if (status === "captured" || status === "failed" || status === "cancelled" || status === "refunded") {
    return null;
  }
  const redirectUrl = typeof payment.processor_redirect_url === "string" ? payment.processor_redirect_url.trim() : "";
  if (!redirectUrl) {
    return null;
  }
  return /^https:\/\//i.test(redirectUrl) ? redirectUrl : null;
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
  return createUcpEnvelope(
    "error",
    error instanceof OrderCartCleanupError
      ? {
          commit_position: error.commitMetadata.commitPosition,
          commit_event_ids: error.commitMetadata.commitEventIds,
          commit_positions: error.commitMetadata.commitPositions,
        }
      : {},
    [
      {
        severity: "error",
        code: error instanceof CheckoutDomainError ? error.code : "validation_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  );
}
