import { createHash } from "node:crypto";
import {
  createUcpEnvelope,
  readUcpRequestMeta,
  type UcpEnvelope,
  type UcpOperationHandlerInput,
} from "@chase-sets/platform-runtime/ucp";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import type { AccountId, CheckoutSessionId } from "@chase-sets/primitives/typed-ids";
import type { UcpPaymentHandlerHandoff } from "@chase-sets/payments/server";
import {
  previewBuyNowCheckoutSupplyThroughOrdering,
  releaseCheckoutInventoryReservations,
} from "../request-support/checkout-confirmation";
import type { CheckoutServices } from "../runtime-support/services";
import { CheckoutDomainError } from "../runtime-support/common";
import type { CheckoutSessionRow } from "../../features/sessions/read-model/queries";
import { prepareBuyNowCheckout } from "../../features/sessions/api/buy-now-preparation";

type UcpHandler = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope>;
type UcpPreflight = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope | null>;

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
  preflight: Readonly<Record<string, UcpPreflight>>;
}>;

type CheckoutUcpOptions = Readonly<{
  checkoutClosed?: boolean;
  paymentHandoff?: Pick<UcpPaymentHandlerHandoff, "payment">;
  getPublicListingById: (listingId: string) => Promise<CheckoutUcpListing | null>;
  getOrderFacts: (orderIds: readonly string[], accountId: string) => Promise<readonly CheckoutUcpOrderFact[]>;
  now?: () => Date;
}>;

const handoffTtlMs = 6 * 60 * 60 * 1000;

export function createCheckoutUcpHandlers(
  checkout: Pick<CheckoutServices, "sessions">,
  options: CheckoutUcpOptions,
): CheckoutUcpHandlers {
  const now = () => options.now?.() ?? new Date();
  const loadSession = async (input: UcpOperationHandlerInput) => {
    const id = input.params.id || readString(input.arguments.id) || "";
    if (!/^chk_[0-9A-Za-z]{26,32}$/.test(id))
      throw new CheckoutDomainError("Checkout id is invalid.", "invalid_request");
    const session = await checkout.sessions.getSession(id, input.actor!.accountId);
    if (!session) throw new CheckoutDomainError("Checkout was not found.", "not_found");
    return session;
  };

  const expiredWrite: UcpPreflight = async (input) => {
    if (!input.actor) return null;
    try {
      const session = await loadSession(input);
      assertHandoffLive(session, now());
      return null;
    } catch (error) {
      return error instanceof CheckoutDomainError && error.code === "checkout_expired" ? validationError(error) : null;
    }
  };

  const payload = async (
    input: UcpOperationHandlerInput,
    session: CheckoutSessionRow,
    preparedPreview?: Parameters<typeof checkoutUcpState>[3],
  ) => {
    const currentTime = now();
    const hasOrders = session.order_ids.length > 0;
    const facts = hasOrders ? await options.getOrderFacts(session.order_ids, session.buyer_account_id) : [];
    const payment = session.payment_id ? await checkout.sessions.getPaymentSummary(session.payment_id) : null;
    const preview =
      hasOrders || session.cancelled_at || isExpiredHandoff(session, currentTime)
        ? null
        : (preparedPreview ??
          (await previewBuyNowCheckoutSupplyThroughOrdering(input.request, {
            checkoutSessionId: session.session_id,
            shippingOption: session.shipping_option,
            optimizationGoal: session.optimization_goal,
            line: session.lines[0],
          })));
    const state = checkoutUcpState(session, facts, payment, preview, currentTime);
    const snapshot = session.fulfillment_preview_snapshot;
    const totals = snapshot?.totals ?? {
      itemSubtotalAmount: "0",
      shippingAmount: "0",
      salesTaxAmount: "0",
      totalAmount: "0",
    };
    const linePrice = (line: (typeof session.lines)[number]) =>
      Math.round(Number(line.offerPriceAmount ?? "0") * 100) || 0;
    return {
      id: session.session_id,
      status: state.status,
      source_type: session.source_type,
      shipping_option: session.shipping_option,
      optimization_goal: session.optimization_goal,
      shipping_address: session.shipping_address,
      currency: payment?.currency_code ?? "USD",
      line_items: session.lines.map((line) => ({
        id: line.listingId ?? line.productId,
        item: {
          id: line.listingId ?? line.productId,
          title: line.itemTitle ?? line.productSummary ?? line.listingId,
          price: linePrice(line),
        },
        quantity: line.quantity,
        totals: [
          { type: "subtotal", amount: linePrice(line) * line.quantity },
          { type: "total", amount: linePrice(line) * line.quantity },
        ],
      })),
      totals: [
        { type: "subtotal", amount: moneyToMinorUnits(totals.itemSubtotalAmount) },
        { type: "fulfillment", amount: moneyToMinorUnits(totals.shippingAmount) },
        { type: "tax", amount: moneyToMinorUnits(totals.salesTaxAmount) },
        { type: "total", amount: moneyToMinorUnits(totals.totalAmount) },
      ],
      links: {
        terms: `${resolvePublicRequestOrigin(input.request)}/terms`,
        privacy: `${resolvePublicRequestOrigin(input.request)}/privacy`,
      },
      order_ids: session.order_ids,
      payment_id: session.payment_id,
      offer_id: session.submitted_offer_id,
      cancelled_at: session.cancelled_at,
      ...(options.paymentHandoff ? { payment: options.paymentHandoff.payment } : {}),
      created_at: session.created_at,
      updated_at: session.updated_at,
      ...(state.continue ? { continue_url: checkoutContinueUrl(input.request, session.session_id) } : {}),
      ...(session.handoff_expires_at ? { expires_at: session.handoff_expires_at } : {}),
      ...(state.order
        ? {
            order: state.order.map((fact) => ({
              id: fact.id,
              label: fact.label ?? fact.id,
              permalink_url: new URL(
                fact.permalinkUrl ?? `/account/purchases/${encodeURIComponent(fact.id)}`,
                resolvePublicRequestOrigin(input.request),
              ).href,
            })),
          }
        : {}),
      ...(state.messages.length ? { messages: state.messages } : {}),
    };
  };

  const handler =
    (permission: "orders.view" | "orders.manage", run: UcpHandler): UcpHandler =>
    async (input) => {
      const accessError = requireCheckoutAccess(input, permission);
      if (accessError) return accessError;
      try {
        return await run(input);
      } catch (error) {
        return validationError(error);
      }
    };
  const closed = () =>
    createUcpEnvelope("error", {}, [
      { severity: "error", code: "checkout_closed", message: "Checkout is closed until public launch." },
    ]);
  const handlers = {
    create_checkout: handler("orders.manage", async (input) => {
      if (options.checkoutClosed) return closed();
      const lines = await normalizeLineItems(input);
      if (lines.length !== 1)
        throw new CheckoutDomainError("Only one checkout line item is supported.", "multiple_line_items_unsupported");
      const line = lines[0];
      const listing = await options.getPublicListingById(line.listingId);
      if (!listing || listing.visible_quantity < line.quantity)
        throw new CheckoutDomainError("This item is no longer available.", "item_unavailable");
      const meta = input.requestMeta ?? readUcpRequestMeta(input.request, input.arguments);
      const sessionIdOverride = meta.retryKey
        ? (`chk_${createHash("sha256")
            .update(JSON.stringify([input.actor!.accountId, meta.retryKey, line.listingId]))
            .digest("hex")
            .slice(0, 28)}` as CheckoutSessionId)
        : undefined;
      const createdAt = now().toISOString();
      const prepared = await prepareBuyNowCheckout({
        request: input.request,
        services: checkout.sessions,
        accountId: input.actor!.accountId as AccountId,
        listing: {
          listingId: listing.listing_id,
          catalogItemId: listing.catalog_catalog_item_id,
          productId: listing.product_id,
          itemTitle: listing.item_title ?? listing.product_summary ?? listing.listing_id,
          itemSubtitle: listing.item_subtitle,
          productSummary: listing.product_summary,
          selectedOptions: readSelectedOptions(listing.selected_options),
        },
        quantity: line.quantity,
        context: input.context!,
        sessionIdOverride,
        createdAt,
        handoffExpiresAt: new Date(Date.parse(createdAt) + handoffTtlMs).toISOString(),
      });
      const session = await checkout.sessions.getSession(prepared.sessionId, input.actor!.accountId);
      if (!session) throw new CheckoutDomainError("Checkout was not found after creation.", "not_found");
      return createUcpEnvelope("success", { checkout: await payload(input, session, prepared.fulfillmentPreview) });
    }),
    get_checkout: handler("orders.view", async (input) =>
      createUcpEnvelope("success", { checkout: await payload(input, await loadSession(input)) }),
    ),
    update_checkout: handler("orders.manage", async (input) => {
      if (options.checkoutClosed) return closed();
      const session = await loadSession(input);
      assertHandoffLive(session, now());
      const lines = await normalizeLineItems(input);
      if (
        JSON.stringify(lines) !==
        JSON.stringify(session.lines.map((line) => ({ listingId: line.listingId, quantity: line.quantity })))
      )
        throw new CheckoutDomainError("Checkout line updates are not supported.", "line_items_update_unsupported");
      return createUcpEnvelope("success", { checkout: await payload(input, session) });
    }),
    complete_checkout: handler("orders.manage", async (input) => {
      if (options.checkoutClosed) return closed();
      const session = await loadSession(input);
      assertHandoffLive(session, now());
      const derived = await payload(input, session);
      return createUcpEnvelope("success", { checkout: derived }, derived.messages ?? []);
    }),
    cancel_checkout: handler("orders.manage", async (input) => {
      const session = await loadSession(input);
      if (!["Signature-Input", "Signature", "Content-Digest"].some((name) => input.request.headers.has(name)))
        return createUcpEnvelope("success", { checkout: await payload(input, session) });
      const released = await releaseCheckoutInventoryReservations(input.request, session);
      const result = await checkout.sessions.cancelSession(
        { sessionId: session.session_id, accountId: input.actor!.accountId as AccountId },
        input.context!,
      );
      return createUcpEnvelope("success", {
        checkout: await payload(input, result.session),
        released_reservation_ids: released.map((reservation) => reservation.holdId),
        ...(result.commitPosition ? { commit_position: result.commitPosition } : {}),
        ...(result.commitEventIds ? { commit_event_ids: result.commitEventIds } : {}),
        ...(result.commitPositions ? { commit_positions: result.commitPositions } : {}),
      });
    }),
  };
  return {
    restHandlers: handlers,
    mcpToolHandlers: handlers,
    preflight: { update_checkout: expiredWrite, complete_checkout: expiredWrite },
  };
}

async function normalizeLineItems(input: UcpOperationHandlerInput) {
  const isMcp = Object.keys(input.arguments).length > 0;
  const body = isMcp
    ? input.arguments
    : readObject(
        await input.request
          .clone()
          .json()
          .catch(() => null),
      );
  if (!body) throw new CheckoutDomainError("Checkout resource is required.", "invalid_request");
  const allowed = isMcp ? ["id", "checkout"] : ["line_items"];
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new CheckoutDomainError("Only the checkout resource is accepted.", "invalid_request");
  const resource = isMcp ? readObject(body.checkout) : body;
  if (!resource || Object.keys(resource).some((key) => key !== "line_items") || !Array.isArray(resource.line_items))
    throw new CheckoutDomainError("Checkout line_items are required; checkout.id is not accepted.", "invalid_request");
  return resource.line_items.map((raw) => {
    const line = readObject(raw);
    const listingId = readString(readObject(line?.item)?.id);
    if (!line || !listingId)
      throw new CheckoutDomainError("Checkout line item must include item.id.", "invalid_request");
    const quantity = line.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1)
      throw new CheckoutDomainError("Quantity must be a positive integer.", "invalid_quantity");
    const unit = line.quantity_unit;
    if (unit !== undefined && (!readObject(unit) || readObject(unit)!.unit !== "C62" || readObject(unit)!.scale !== 0))
      throw new CheckoutDomainError("Only C62 quantity units are supported.", "quantity_unit_mismatch");
    return { listingId, quantity };
  });
}

function checkoutContinueUrl(request: Request, sessionId: string) {
  return `${resolvePublicRequestOrigin(request)}/checkout/buy/session/${encodeURIComponent(sessionId)}`;
}

function isExpiredHandoff(session: CheckoutSessionRow, now: Date) {
  return (
    session.order_ids.length === 0 &&
    typeof session.handoff_expires_at === "string" &&
    now.getTime() >= Date.parse(session.handoff_expires_at)
  );
}

function assertHandoffLive(session: CheckoutSessionRow, now: Date) {
  if (!session.cancelled_at && isExpiredHandoff(session, now))
    throw new CheckoutDomainError("This checkout handoff has expired. Start a new checkout.", "checkout_expired");
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
  const message = (
    code: "payment_required" | "payment_confirmation_required" | "checkout_expired" | "item_unavailable",
    recoverability: "requires_buyer_input" | "unrecoverable",
    target?: string,
  ) => ({
    severity: "warning" as const,
    code,
    message: {
      payment_required: "Payment is required to continue checkout.",
      payment_confirmation_required: "Buyer confirmation is required to continue payment.",
      checkout_expired: "This checkout has expired. Start a new checkout.",
      item_unavailable: "This item is no longer available.",
    }[code],
    recoverability,
    ...(target ? { target } : {}),
  });
  const completeFacts =
    session.order_ids.length > 0 &&
    orderFacts.length === session.order_ids.length &&
    session.order_ids.every((id) => orderFacts.some((fact) => fact.id === id));
  if (session.cancelled_at || (completeFacts && orderFacts.every((fact) => fact.status === "cancelled")))
    return { status: "canceled" as const, messages: [] as const };
  if (completeFacts && orderFacts.every((fact) => Boolean(fact.readyForFulfillmentAt)))
    return { status: "completed" as const, order: orderFacts, messages: [] as const };
  if (isExpiredHandoff(session, now))
    return { status: "canceled" as const, messages: [message("checkout_expired", "unrecoverable")] };
  if (session.order_ids.length > 0) {
    if (paymentSummary?.status === "captured")
      return { status: "complete_in_progress" as const, messages: [] as const };
    return {
      status: "requires_escalation" as const,
      continue: true,
      messages: [
        message(
          paymentSummary?.status === "pending-confirmation" ? "payment_confirmation_required" : "payment_required",
          "requires_buyer_input",
        ),
      ],
    };
  }
  if (
    currentPreview &&
    (!currentPreview.readyLineKeys?.length ||
      (currentPreview.unavailableLines?.length ?? 0) > 0 ||
      (currentPreview.unavailableLineKeys?.length ?? 0) > 0)
  )
    return {
      status: "incomplete" as const,
      messages: [message("item_unavailable", "unrecoverable", "$.line_items[0]")],
    };
  return {
    status: "requires_escalation" as const,
    continue: true,
    messages: [message("payment_required", "requires_buyer_input")],
  };
}

function requireCheckoutAccess(input: UcpOperationHandlerInput, permission: "orders.view" | "orders.manage") {
  if (!input.actor)
    return createUcpEnvelope("error", {}, [
      { severity: "error", code: "authentication_required", message: "UCP checkout requires a linked buyer account." },
    ]);
  if (!input.actor.permissions.includes(permission) && !input.actor.permissions.includes("guest-checkout.manage"))
    return createUcpEnvelope("error", {}, [
      {
        severity: "error",
        code: "authorization_forbidden",
        message: "The linked buyer account cannot manage this checkout session.",
      },
    ]);
  if (!input.context)
    return createUcpEnvelope("error", {}, [
      { severity: "error", code: "context_required", message: "UCP checkout requires an event-store context." },
    ]);
  return null;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
function moneyToMinorUnits(amount: string) {
  const normalized = amount.trim();
  const [dollars = "0", cents = ""] = normalized.split(".");
  return Number(`${dollars}${cents.padEnd(2, "0").slice(0, 2)}`.replace(/^0+(?=\d)/, "") || "0");
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
