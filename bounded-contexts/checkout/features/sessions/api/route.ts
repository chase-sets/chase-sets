import { createHash } from "node:crypto";
import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import {
  getMutationResultCommandReceipt,
  readApiErrorCode,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import { parseOptionalTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { ShippingAddressId, AccountId, CheckoutSessionId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutApiEnv } from "../../../api";
import { parseCartReadinessDecisionInput } from "../../cart/domain/readiness";
import type { CheckoutSessionCreateResult, CheckoutSessionServices } from "./runtime";
import type { CheckoutSessionRow } from "../read-model/queries";
import {
  createCheckoutOrdersThroughOrdering,
  createCheckoutInventoryReservations,
  createCheckoutPaymentThroughPayments,
  normalizeRequestedBalanceCreditAmount,
  previewCheckoutFulfillmentThroughOrdering,
  previewBuyNowCheckoutSupplyThroughOrdering,
  submitPurchaseIntentThroughMarketplace,
} from "../../../support/request-support/checkout-confirmation";
import { readCheckoutFulfillmentPreview } from "../domain/fulfillment-preview";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import {
  assertNoUnsupportedCustomerEconomicsInput,
  unsupportedCustomerEconomicsInputCode,
} from "./checkout-economics-runtime";
import { unresolvedFulfillmentError } from "./checkout-fulfillment-runtime";
import {
  recordAddressServiceabilityFailure,
  recordActiveSessionStaleRecovery,
  recordBuyCheckoutReviewRendered,
  recordChangedEconomicsReview,
  recordConfirmationPendingHandoff,
  recordDisabledSavedInstrumentFailure,
  recordSplitGroupSummaryRendered,
  recordUnassignedFulfillmentFailure,
  recordUnsupportedCustomerEconomicsInput,
} from "./checkout-session-route-observability";
import type { CheckoutObservabilityTelemetry } from "./checkout-observability-telemetry";

function requireCheckoutAccess(c: { get(key: "actor"): CheckoutApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("checkout.features.sessions.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.sessions.api.route.request.failed");
}

function errorBody(error: unknown) {
  return typeof error === "object" && error !== null && "body" in error && typeof error.body === "object"
    ? (error.body as { error?: { code?: unknown; message?: unknown } } | null)
    : null;
}

function errorStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}

function errorBodyMessage(error: unknown) {
  const message = errorBody(error)?.error?.message;
  return typeof message === "string" ? message : errorMessage(error);
}

function errorCode(error: unknown) {
  if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.trim()) {
    return error.code;
  }

  const body = errorBody(error);
  if (body?.error?.code === "account_sign_in_required") {
    return "account_sign_in_required";
  }
  return "validation_failed";
}

const savedCheckoutInstrumentUnavailableCode = "saved_checkout_instrument_unavailable" as const;
const paymentStartPendingCode = "payment_start_pending" as const;
const marketplaceCheckoutFeePolicyVersion = "marketplace-checkout-fee-v1";
const checkoutPaymentMethodCategories = ["card", "bank-account", "platform-credit"] as const;
const paymentOrderNotFoundPattern = /^Order ord_[0-9A-Za-z_:-]+ was not found\.$/;
const paymentOrderPendingReservationPattern =
  /^Order ord_[0-9A-Za-z_:-]+ is not eligible for payment in status pending-reservation\.$/;
const paymentOrderReadinessPendingCodes = new Set(["order_input_not_ready", "order_not_payment_ready"]);

type CheckoutPaymentMethodCategory = (typeof checkoutPaymentMethodCategories)[number];

function normalizeSavedCheckoutInstrumentId(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCheckoutPaymentMethodCategory(value: unknown): CheckoutPaymentMethodCategory {
  return checkoutPaymentMethodCategories.includes(value as CheckoutPaymentMethodCategory)
    ? (value as CheckoutPaymentMethodCategory)
    : "card";
}

function paymentMethodCategoryFromQuoteFingerprint(fingerprint: string | null): CheckoutPaymentMethodCategory | null {
  if (!fingerprint) {
    return null;
  }

  const [policyVersion, paymentMethodCategory] = fingerprint.split("|");
  if (policyVersion !== marketplaceCheckoutFeePolicyVersion) {
    return null;
  }

  return checkoutPaymentMethodCategories.includes(paymentMethodCategory as CheckoutPaymentMethodCategory)
    ? (paymentMethodCategory as CheckoutPaymentMethodCategory)
    : null;
}

function selectedPaymentMethodMatchesQuote(
  paymentMethodCategory: CheckoutPaymentMethodCategory,
  marketplaceCheckoutFeeQuoteFingerprint: string | null,
) {
  const quotedPaymentMethodCategory = paymentMethodCategoryFromQuoteFingerprint(marketplaceCheckoutFeeQuoteFingerprint);
  return !quotedPaymentMethodCategory || quotedPaymentMethodCategory === paymentMethodCategory;
}

function paymentQuoteRequiredResponse() {
  return {
    error: {
      code: "payment_quote_required",
      message: t("checkout.features.sessions.api.route.payment.quote.required"),
    },
  };
}

function paymentQuoteRequiredFromStaleFeeQuote(error: unknown, writeSources: readonly unknown[] = []) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    error.status !== 409 ||
    !("body" in error) ||
    readApiErrorCode(error.body) !== "fee_quote_stale"
  ) {
    return null;
  }

  const body = error.body;
  const providerQuote =
    body && typeof body === "object" && "marketplace_checkout_fee" in body
      ? (body as { marketplace_checkout_fee?: unknown }).marketplace_checkout_fee
      : null;

  return {
    ...paymentQuoteRequiredResponse(),
    ...(providerQuote ? { marketplace_checkout_fee: providerQuote } : {}),
    ...checkoutCommitMetadataFromSources(writeSources),
  };
}

function paymentStartPendingFromMissingOrder(error: unknown, writeSources: readonly unknown[] = []) {
  const status = errorStatus(error);
  const code = readApiErrorCode(errorBody(error));
  if (status === 503 && code === "projection_freshness_timeout") {
    return {
      error: {
        code: paymentStartPendingCode,
        message: t("checkout.features.sessions.api.route.payment.start.pending"),
      },
      ...checkoutCommitMetadataFromSources(writeSources),
    };
  }

  if (status === 400 && paymentOrderReadinessPendingCodes.has(code ?? "")) {
    return {
      error: {
        code: paymentStartPendingCode,
        message: t("checkout.features.sessions.api.route.payment.start.pending"),
      },
      ...checkoutCommitMetadataFromSources(writeSources),
    };
  }

  if (status !== 400 || (code !== "validation_failed" && code !== "not_found")) {
    return null;
  }

  const message = errorBodyMessage(error);
  if (!paymentOrderNotFoundPattern.test(message) && !paymentOrderPendingReservationPattern.test(message)) {
    return null;
  }

  return {
    error: {
      code: paymentStartPendingCode,
      message: t("checkout.features.sessions.api.route.payment.start.pending"),
    },
    ...checkoutCommitMetadataFromSources(writeSources),
  };
}

function assertSavedInstrumentAllowed(
  actor: CheckoutApiEnv["Variables"]["actor"],
  savedCheckoutInstrumentId: string | null,
  savePaymentMethodForFuture: boolean,
) {
  if (actor?.roleKey === "guest-buyer" && (savedCheckoutInstrumentId || savePaymentMethodForFuture)) {
    throw new CheckoutDomainError(
      "Saved payment methods are available after sign-in. Continue with card payment.",
      savedCheckoutInstrumentUnavailableCode,
    );
  }
}

function checkoutSessionStartedResponse(result: CheckoutSessionCreateResult) {
  const commitEventIds = [...(result.commitEventIds ?? [])];
  const commitPositions = [...(result.commitPositions ?? [])];
  return {
    session_id: result.sessionId,
    status: "started",
    ...(result.commitPosition ? { commitPosition: result.commitPosition } : {}),
    ...(commitEventIds.length > 0 ? { commitEventIds } : {}),
    ...(commitPositions.length > 0 ? { commitPositions } : {}),
  };
}

type CommitMetadata = Readonly<{
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly SourceCommitPosition[];
}>;

function orderingCommitPositionsFromSource(source: unknown): SourceCommitPosition[] {
  const metadata = commitMetadataFromSource(source);
  return (metadata?.commitPositions ?? []).filter((position) => position.sourceContextName === "ordering");
}

function paymentOrderInputFreshnessSource(session: CheckoutSessionRow, orderCreationWriteResult: unknown) {
  const orderingCommitPositions =
    orderCreationWriteResult === undefined
      ? [...session.order_write_commit_positions]
      : orderingCommitPositionsFromSource(orderCreationWriteResult);

  return orderingCommitPositions.length > 0
    ? {
        commandReceipt: {
          commitEventIds: [...new Set(orderingCommitPositions.flatMap((position) => position.eventIds))],
          commitPositions: orderingCommitPositions,
        },
      }
    : orderCreationWriteResult;
}

function maxCommitPosition(left: string | undefined, right: string | undefined) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return BigInt(right) > BigInt(left) ? right : left;
}

function commitMetadataFromSource(source: unknown): CommitMetadata | null {
  const commandReceipt = getMutationResultCommandReceipt(source);
  if (commandReceipt) {
    return commandReceipt;
  }

  if (typeof source !== "object" || source === null) {
    return null;
  }

  const candidate = source as Partial<CommitMetadata>;
  if (
    typeof candidate.commitPosition !== "string" &&
    !Array.isArray(candidate.commitEventIds) &&
    !Array.isArray(candidate.commitPositions)
  ) {
    return null;
  }

  return candidate;
}

function checkoutCommitMetadataFromSources(sources: readonly unknown[]): CommitMetadata {
  let commitPosition: string | undefined;
  const commitEventIds = new Set<string>();
  const commitPositions = new Map<string, SourceCommitPosition>();

  for (const source of sources) {
    const metadata = commitMetadataFromSource(source);
    commitPosition = maxCommitPosition(commitPosition, metadata?.commitPosition);

    for (const eventId of metadata?.commitEventIds ?? []) {
      commitEventIds.add(eventId);
    }

    for (const position of metadata?.commitPositions ?? []) {
      const current = commitPositions.get(position.sourceContextName);
      if (!current) {
        commitPositions.set(position.sourceContextName, position);
        continue;
      }

      commitPositions.set(position.sourceContextName, {
        sourceContextName: position.sourceContextName,
        maxGlobalPosition:
          maxCommitPosition(current.maxGlobalPosition, position.maxGlobalPosition) ?? position.maxGlobalPosition,
        eventIds: [...new Set([...current.eventIds, ...position.eventIds])],
      });
    }
  }

  const mergedCommitPositions = [...commitPositions.values()].sort((left, right) =>
    left.sourceContextName.localeCompare(right.sourceContextName),
  );

  return {
    ...(commitPosition ? { commitPosition } : {}),
    ...(commitEventIds.size > 0 ? { commitEventIds: [...commitEventIds] } : {}),
    ...(mergedCommitPositions.length > 0 ? { commitPositions: mergedCommitPositions } : {}),
  };
}

function parseSelectedOptions(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((selection): selection is { dimensionId: string; optionId: string } =>
          Boolean(selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

function parseShippingAddress(value: unknown) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    shippingAddressId: parseOptionalTypedIdBoundary(source.shippingAddressId, "adr", "shippingAddressId") ?? null,
    name: source.name === null || source.name === undefined ? "" : String(source.name),
    company: source.company === null || source.company === undefined ? null : String(source.company),
    line1: String(source.line1 ?? ""),
    line2: source.line2 === null || source.line2 === undefined ? null : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
    phone: source.phone === null || source.phone === undefined ? null : String(source.phone),
    email: source.email === null || source.email === undefined ? null : String(source.email),
  };
}

function parseOptionalShippingAddress(value: unknown) {
  return value === null || value === undefined ? null : parseShippingAddress(value);
}

function parseAddressVerificationDecision(value: unknown) {
  return value === "accept-suggested" || value === "keep-original" ? value : null;
}

function addressVerificationChoiceResponse(
  choice: Extract<Awaited<ReturnType<CheckoutSessionServices["verifyShippingAddress"]>>, { status: "choice-required" }>,
) {
  return {
    error: {
      code: "address_standardization_suggested",
      message: t("checkout.features.sessions.api.route.address.standardization.suggested"),
    },
    suggestedAddress: choice.suggestedAddress,
    verification: choice.verification,
    messages: choice.messages,
  };
}

function normalizePreviewShippingOption(value: unknown, fallback: CheckoutSessionRow["shipping_option"]) {
  return value === "priority" || value === "expedited" || value === "standard" ? value : fallback;
}

function sessionHasCommittedCheckoutSideEffects(session: CheckoutSessionRow) {
  return Boolean(
    session.cancelled_at ||
    session.payment_id ||
    session.submitted_offer_id ||
    (Array.isArray(session.order_ids) && session.order_ids.length > 0),
  );
}

async function recordCheckoutFulfillmentPreviewSnapshot(
  request: Request,
  services: CheckoutSessionServices,
  session: CheckoutSessionRow,
  accountId: AccountId,
  context: NonNullable<CheckoutApiEnv["Variables"]["context"]>,
  options: Readonly<{
    fulfillmentPreviewSnapshot?: unknown;
    fulfillmentPreviewRevision?: string | null;
    shippingOption?: CheckoutSessionRow["shipping_option"];
    shippingAddress?: CheckoutSessionRow["shipping_address"];
  }> = {},
) {
  const suppliedSnapshot = readCheckoutFulfillmentPreview(options.fulfillmentPreviewSnapshot);
  const calculatedSnapshot =
    suppliedSnapshot ??
    (await previewCheckoutFulfillmentThroughOrdering(request, session, {
      shippingOption: options.shippingOption,
      shippingAddress: options.shippingAddress,
    }));
  const fulfillmentPreviewRevision = String(
    options.fulfillmentPreviewRevision ?? calculatedSnapshot?.revision ?? "",
  ).trim();

  if (!fulfillmentPreviewRevision) {
    throw new CheckoutDomainError("Fulfillment preview must include a revision.", "fulfillment_preview_required");
  }

  return services.recordFulfillmentPreview(
    {
      sessionId: session.session_id,
      accountId,
      fulfillmentPreviewRevision,
      fulfillmentPreviewSnapshot: calculatedSnapshot,
    },
    context,
  );
}

function parseOptimizationGoal(value: unknown) {
  return value === "fewest-shipments" ? ("fewest-shipments" as const) : ("lowest-total" as const);
}

type CheckoutEntryIdempotencySource =
  | Readonly<{
      type: "cart";
      readinessSnapshotId: string;
      readinessSourceRevision: string;
      readinessDecisions: ReturnType<typeof parseCartReadinessDecisionInput>;
    }>
  | Readonly<{
      type: "buy-now";
      listingId: string;
      catalogItemId: string;
      productId: string;
      selectedOptions: ReturnType<typeof parseSelectedOptions>;
      quantity: number;
      fulfillmentMode: "locked-listing";
      lockedListingId: string;
      sellerPreferenceId: string | null;
    }>
  | Readonly<{
      type: "offer-intent";
      catalogItemId: string;
      productId: string;
      selectedOptions: ReturnType<typeof parseSelectedOptions>;
      offerPriceAmount: string;
      quantity: number;
    }>;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function normalizeCheckoutEntryAttemptKey(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    const normalized = String(value).trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function checkoutEntrySessionId(params: {
  accountId: AccountId;
  entryAttemptKey: string | null;
  source: CheckoutEntryIdempotencySource;
  shippingOption: string;
  optimizationGoal: ReturnType<typeof parseOptimizationGoal>;
}): CheckoutSessionId | undefined {
  const idempotencyScope =
    params.entryAttemptKey ?? (params.source.type === "cart" ? params.source.readinessSnapshotId : null);
  if (!idempotencyScope) {
    return undefined;
  }

  const digest = createHash("sha256")
    .update(
      stableStringify({
        schema: "checkout.entry-idempotency.v1",
        accountId: params.accountId,
        entryAttemptKey: params.entryAttemptKey,
        source: params.source,
        shippingOption: params.shippingOption,
        optimizationGoal: params.optimizationGoal,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `chk_${digest}` as CheckoutSessionId;
}

function buyNowPreflightSessionId(params: {
  accountId: AccountId;
  source: CheckoutEntryIdempotencySource;
  shippingOption: string;
  optimizationGoal: ReturnType<typeof parseOptimizationGoal>;
}) {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        schema: "checkout.buy-now-preflight.v1",
        accountId: params.accountId,
        source: params.source,
        shippingOption: params.shippingOption,
        optimizationGoal: params.optimizationGoal,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `chk_${digest}`;
}

function buyNowOrderingPreflightMessage(reason: string | null | undefined) {
  const normalized = reason?.trim();
  return normalized && normalized !== "Locked listing is unavailable."
    ? normalized
    : "This listing is still becoming available for checkout. Try again shortly.";
}

export function createAccountCheckoutSessionRoutes(
  services: CheckoutSessionServices,
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
) {
  const app = new Hono<CheckoutApiEnv>();

  app.post("/checkout-sessions", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.sessions.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    const entryAttemptKey = normalizeCheckoutEntryAttemptKey(
      body.entryAttemptKey,
      c.req.header("idempotency-key"),
      c.req.header("x-idempotency-key"),
      c.req.header("x-checkout-entry-attempt-key"),
    );

    try {
      if (body.source?.type === "cart") {
        const readinessSnapshotId = String(body.source.readinessSnapshotId ?? "");
        const readinessSourceRevision = String(body.source.readinessSourceRevision ?? "");
        const readinessDecisions = parseCartReadinessDecisionInput(body.source.readinessDecisions);
        const shippingOption = String(body.shippingOption ?? "standard");
        const optimizationGoal = parseOptimizationGoal(body.optimizationGoal);
        const result = await services.createFromCart(
          {
            accountId: access.actor.accountId as AccountId,
            shippingOption,
            optimizationGoal,
            readinessSnapshotId,
            readinessSourceRevision,
            readinessDecisions,
            sessionIdOverride: checkoutEntrySessionId({
              accountId: access.actor.accountId as AccountId,
              entryAttemptKey,
              source: {
                type: "cart",
                readinessSnapshotId,
                readinessSourceRevision,
                readinessDecisions,
              },
              shippingOption,
              optimizationGoal,
            }),
          },
          context,
        );
        try {
          const session = await services.getSession(result.sessionId, access.actor.accountId);
          if (!session || sessionHasCommittedCheckoutSideEffects(session)) {
            return c.json(checkoutSessionStartedResponse(result), 201);
          }

          const fulfillmentPreviewResult = await recordCheckoutFulfillmentPreviewSnapshot(
            c.req.raw,
            services,
            session,
            access.actor.accountId as AccountId,
            context,
          );
          return c.json(
            checkoutSessionStartedResponse({
              ...result,
              ...checkoutCommitMetadataFromSources([result, fulfillmentPreviewResult]),
            }),
            201,
          );
        } catch {
          return c.json(checkoutSessionStartedResponse(result), 201);
        }
      }

      const source =
        body.source && typeof body.source === "object"
          ? (body.source as Record<string, unknown>)
          : (body as Record<string, unknown>);
      if (source.type === "offer-intent") {
        if (access.actor.roleKey === "guest-buyer") {
          return c.json(
            {
              error: {
                code: "account_registration_required",
                message: t("checkout.features.sessions.api.route.register.or.sign.in.before.placing.purchase.intent"),
              },
            },
            403,
          );
        }

        const selectedOptions = parseSelectedOptions(source.selectedOptions);
        const shippingOption = String(body.shippingOption ?? "standard");
        const optimizationGoal = parseOptimizationGoal(body.optimizationGoal);
        const catalogItemId = String(source.catalogItemId ?? "");
        const productId = String(source.productId ?? "");
        const offerPriceAmount = String(source.offerPriceAmount ?? source.priceAmount ?? "");
        const quantity = Number(source.quantity ?? source.quantityRequested ?? 0);
        const result = await services.createOfferIntent(
          {
            accountId: access.actor.accountId as AccountId,
            catalogItemId,
            productId,
            itemTitle: String(source.itemTitle ?? ""),
            itemSubtitle:
              source.itemSubtitle === null || source.itemSubtitle === undefined ? null : String(source.itemSubtitle),
            selectedOptions,
            productSummary:
              source.productSummary === null || source.productSummary === undefined
                ? null
                : String(source.productSummary),
            offerPriceAmount,
            quantity,
            optimizationGoal,
            shippingOption,
            sessionIdOverride: checkoutEntrySessionId({
              accountId: access.actor.accountId as AccountId,
              entryAttemptKey,
              source: {
                type: "offer-intent",
                catalogItemId,
                productId,
                selectedOptions,
                offerPriceAmount,
                quantity,
              },
              shippingOption,
              optimizationGoal,
            }),
          },
          context,
        );
        return c.json(checkoutSessionStartedResponse(result), 201);
      }

      const lockedListingId = String(source.lockedListingId ?? source.listingId ?? "").trim();
      if (!lockedListingId) {
        throw unresolvedFulfillmentError();
      }

      const selectedOptions = parseSelectedOptions(source.selectedOptions);
      const requestedShippingOption = String(body.shippingOption ?? "standard");
      const shippingOption =
        requestedShippingOption === "expedited" || requestedShippingOption === "priority"
          ? requestedShippingOption
          : "standard";
      const optimizationGoal = parseOptimizationGoal(body.optimizationGoal);
      const listingId = String(source.listingId ?? "");
      const catalogItemId = String(source.catalogItemId ?? "");
      const productId = String(source.productId ?? "");
      const quantity = Number(source.quantity ?? 0);
      const sellerPreferenceId =
        source.sellerPreferenceId === null || source.sellerPreferenceId === undefined
          ? null
          : String(source.sellerPreferenceId || "") || null;
      const buyNowSource = {
        type: "buy-now",
        listingId,
        catalogItemId,
        productId,
        selectedOptions,
        quantity,
        fulfillmentMode: "locked-listing" as const,
        lockedListingId,
        sellerPreferenceId,
      } satisfies CheckoutEntryIdempotencySource;
      const sessionIdOverride = checkoutEntrySessionId({
        accountId: access.actor.accountId as AccountId,
        entryAttemptKey,
        source: buyNowSource,
        shippingOption,
        optimizationGoal,
      });
      const buyNowLine = {
        listingId,
        cartLineId: null,
        catalogItemId,
        productId,
        itemTitle: String(source.itemTitle ?? ""),
        itemSubtitle:
          source.itemSubtitle === null || source.itemSubtitle === undefined ? null : String(source.itemSubtitle),
        selectedOptions,
        productSummary:
          source.productSummary === null || source.productSummary === undefined ? null : String(source.productSummary),
        quantity,
        fulfillmentMode: "locked-listing" as const,
        lockedListingId,
        sellerPreferenceId,
      };
      const supplyPreview = await previewBuyNowCheckoutSupplyThroughOrdering(c.req.raw, {
        checkoutSessionId:
          sessionIdOverride ??
          buyNowPreflightSessionId({
            accountId: access.actor.accountId as AccountId,
            source: buyNowSource,
            shippingOption,
            optimizationGoal,
          }),
        shippingOption,
        optimizationGoal,
        line: buyNowLine,
      });
      if (supplyPreview.readyLineKeys.length === 0) {
        throw new CheckoutDomainError(
          buyNowOrderingPreflightMessage(supplyPreview.unavailableLines[0]?.reason),
          "unresolved_fulfillment",
        );
      }
      const result = await services.createBuyNow(
        {
          accountId: access.actor.accountId as AccountId,
          listingId,
          catalogItemId,
          productId,
          itemTitle: buyNowLine.itemTitle,
          itemSubtitle: buyNowLine.itemSubtitle,
          selectedOptions,
          productSummary: buyNowLine.productSummary,
          quantity,
          fulfillmentMode: "locked-listing",
          lockedListingId,
          sellerPreferenceId,
          optimizationGoal,
          shippingOption,
          fulfillmentPreviewRevision: supplyPreview.revision,
          fulfillmentPreviewSnapshot: supplyPreview,
          sessionIdOverride,
        },
        context,
      );
      if (sessionIdOverride && result.sessionId !== sessionIdOverride) {
        const replacementSupplyPreview = await previewBuyNowCheckoutSupplyThroughOrdering(c.req.raw, {
          checkoutSessionId: result.sessionId,
          shippingOption,
          optimizationGoal,
          line: buyNowLine,
        });
        if (replacementSupplyPreview.readyLineKeys.length === 0) {
          throw new CheckoutDomainError(
            buyNowOrderingPreflightMessage(replacementSupplyPreview.unavailableLines[0]?.reason),
            "unresolved_fulfillment",
          );
        }
        const fulfillmentPreviewResult = await services.recordFulfillmentPreview(
          {
            sessionId: result.sessionId,
            accountId: access.actor.accountId as AccountId,
            fulfillmentPreviewRevision: replacementSupplyPreview.revision,
            fulfillmentPreviewSnapshot: replacementSupplyPreview,
          },
          context,
        );
        return c.json(
          checkoutSessionStartedResponse({
            ...result,
            ...checkoutCommitMetadataFromSources([result, fulfillmentPreviewResult]),
          }),
          201,
        );
      }

      return c.json(checkoutSessionStartedResponse(result), 201);
    } catch (error) {
      const code = errorCode(error);
      recordUnassignedFulfillmentFailure(checkoutObservabilityTelemetry, access.actor, code);
      return c.json({ error: { code, message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout-sessions/:sessionId", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    let session: Awaited<ReturnType<CheckoutSessionServices["getSession"]>>;
    try {
      session = await services.getSession(c.req.param("sessionId"), access.actor.accountId);
    } catch (error) {
      if (error instanceof CheckoutDomainError) {
        const code = errorCode(error);
        recordActiveSessionStaleRecovery(checkoutObservabilityTelemetry, access.actor, code);
        return c.json({ error: { code, message: errorMessage(error) } }, 400);
      }

      throw error;
    }

    if (!session) {
      return c.json(
        { error: { code: "not_found", message: t("checkout.features.sessions.api.route.checkout.session.not.found") } },
        404,
      );
    }

    recordBuyCheckoutReviewRendered(checkoutObservabilityTelemetry, access.actor, session);
    recordSplitGroupSummaryRendered(checkoutObservabilityTelemetry, access.actor, session);
    return c.json(session);
  });

  app.get("/checkout-payment-summaries/:paymentId", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const paymentSummary = await services.getPaymentSummary(c.req.param("paymentId"));
    if (!paymentSummary) {
      return c.json(
        { error: { code: "not_found", message: t("checkout.features.sessions.api.route.payment.summary.not.found") } },
        404,
      );
    }

    return c.json(paymentSummary);
  });

  app.get("/checkout-payment-affordances", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const instruments = await services.listSavedPaymentInstruments(access.actor.accountId as AccountId);
    return c.json({ items: instruments });
  });

  app.post("/checkout-sessions/:sessionId/shipping-option", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.sessions.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      await services.selectShippingOption(
        {
          sessionId: c.req.param("sessionId"),
          accountId: access.actor.accountId as AccountId,
          shippingOption: String(body.shippingOption ?? "standard"),
        },
        context,
      );
      return c.json({
        session_id: c.req.param("sessionId"),
        status: "shipping-option-selected",
      });
    } catch (error) {
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.post("/checkout-sessions/:sessionId/shipping-address", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.sessions.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const verification = await services.verifyShippingAddress(
        parseShippingAddress(body.shippingAddress),
        parseAddressVerificationDecision(body.addressVerificationDecision),
      );
      if (verification.status === "choice-required") {
        return c.json(addressVerificationChoiceResponse(verification), 409);
      }
      await services.setShippingAddress(
        {
          sessionId: c.req.param("sessionId"),
          accountId: access.actor.accountId as AccountId,
          shippingAddress: verification.shippingAddress,
          addressVerificationDecision: parseAddressVerificationDecision(body.addressVerificationDecision),
        },
        context,
      );
      return c.json({
        session_id: c.req.param("sessionId"),
        status: "shipping-address-selected",
      });
    } catch (error) {
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.post("/checkout-sessions/:sessionId/fulfillment-preview", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.sessions.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const sessionId = c.req.param("sessionId");
    const parsedBody = await c.req.json().catch(() => ({}));
    const body = parsedBody && typeof parsedBody === "object" ? (parsedBody as Record<string, unknown>) : {};
    const fulfillmentPreviewRevision =
      typeof body.fulfillmentPreviewRevision === "string" ? body.fulfillmentPreviewRevision : "";

    try {
      const session = await services.getSession(sessionId, access.actor.accountId);
      if (!session) {
        return c.json(
          {
            error: {
              code: "not_found",
              message: t("checkout.features.sessions.api.route.checkout.session.not.found"),
            },
          },
          404,
        );
      }

      const suppliedPreview = body.fulfillmentPreviewSnapshot ?? body.fulfillmentPreview;
      const hasReviewInput = "shippingOption" in body || "shippingAddress" in body;
      const result =
        fulfillmentPreviewRevision && !suppliedPreview && !hasReviewInput
          ? await services.recordFulfillmentPreview(
              {
                sessionId,
                accountId: access.actor.accountId as AccountId,
                fulfillmentPreviewRevision,
              },
              context,
            )
          : await recordCheckoutFulfillmentPreviewSnapshot(
              c.req.raw,
              services,
              session,
              access.actor.accountId as AccountId,
              context,
              {
                fulfillmentPreviewRevision,
                fulfillmentPreviewSnapshot: suppliedPreview,
                shippingOption: normalizePreviewShippingOption(body.shippingOption, session.shipping_option),
                shippingAddress:
                  "shippingAddress" in body
                    ? parseOptionalShippingAddress(body.shippingAddress)
                    : session.shipping_address,
              },
            );
      return c.json({
        session_id: sessionId,
        status: "fulfillment-preview-recorded",
        ...checkoutCommitMetadataFromSources([result]),
      });
    } catch (error) {
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.post("/checkout-sessions/:sessionId/optimization-goal", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.sessions.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      await services.selectOptimizationGoal(
        {
          sessionId: c.req.param("sessionId"),
          accountId: access.actor.accountId as AccountId,
          optimizationGoal: parseOptimizationGoal(body.optimizationGoal),
        },
        context,
      );
      return c.json({
        session_id: c.req.param("sessionId"),
        status: "optimization-goal-selected",
      });
    } catch (error) {
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.post("/checkout-sessions/:sessionId/confirm", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.sessions.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const sessionId = c.req.param("sessionId");
    const body = await c.req.json().catch(() => ({}));
    const requestedBalanceCreditAmount = normalizeRequestedBalanceCreditAmount(body.requestedBalanceCreditAmount);
    const paymentMethodCategory = normalizeCheckoutPaymentMethodCategory(body.paymentMethodCategory);
    const savedCheckoutInstrumentId = normalizeSavedCheckoutInstrumentId(body.savedCheckoutInstrumentId);
    const marketplaceCheckoutFeeQuoteFingerprint =
      typeof body.marketplaceCheckoutFeeQuoteFingerprint === "string"
        ? body.marketplaceCheckoutFeeQuoteFingerprint
        : null;
    const fulfillmentPreviewRevision =
      typeof body.fulfillmentPreviewRevision === "string" ? body.fulfillmentPreviewRevision : null;
    const acknowledgedMaterialChanges = body.acknowledgedMaterialChanges === true;
    const savePaymentMethodForFuture =
      body.savePaymentMethodForFuture === true && access.actor.roleKey !== "guest-buyer" && !savedCheckoutInstrumentId;
    const requestedSavePaymentMethodForFuture = body.savePaymentMethodForFuture === true;
    const writeSources: unknown[] = [];

    try {
      assertNoUnsupportedCustomerEconomicsInput(body);
      assertSavedInstrumentAllowed(access.actor, savedCheckoutInstrumentId, requestedSavePaymentMethodForFuture);
      if (!selectedPaymentMethodMatchesQuote(paymentMethodCategory, marketplaceCheckoutFeeQuoteFingerprint)) {
        return c.json(paymentQuoteRequiredResponse(), 409);
      }
      let session = await services.getSession(sessionId, access.actor.accountId);
      if (!session) {
        return c.json(
          {
            error: {
              code: "not_found",
              message: t("checkout.features.sessions.api.route.checkout.session.not.found.2"),
            },
          },
          404,
        );
      }

      if (session.payment_id) {
        recordConfirmationPendingHandoff(
          checkoutObservabilityTelemetry,
          access.actor,
          session,
          "payment-already-started",
        );
        return c.json({
          payment_id: session.payment_id,
          order_ids: session.order_ids,
          status: "confirmed",
        });
      }

      if (session.cancelled_at) {
        return c.json({
          status: "cancelled",
          session,
        });
      }

      if (session.submitted_offer_id) {
        return c.json({
          offer_id: session.submitted_offer_id,
          status: "purchase-intent-submitted",
          session,
        });
      }

      if (
        session.order_ids.length === 0 &&
        session.fulfillment_preview_revision &&
        fulfillmentPreviewRevision !== session.fulfillment_preview_revision &&
        !acknowledgedMaterialChanges
      ) {
        recordChangedEconomicsReview(
          checkoutObservabilityTelemetry,
          access.actor,
          session,
          "fulfillment-preview-stale",
        );
        return c.json(
          {
            error: {
              code: "fulfillment_preview_stale",
              message: t("checkout.features.sessions.api.route.fulfillment.preview.stale"),
            },
          },
          409,
        );
      }

      if (session.order_ids.length === 0) {
        const verification = await services.verifyShippingAddress(
          parseShippingAddress(body.shippingAddress),
          parseAddressVerificationDecision(body.addressVerificationDecision),
        );
        if (verification.status === "choice-required") {
          return c.json(addressVerificationChoiceResponse(verification), 409);
        }
        const shippingAddressResult = await services.setShippingAddress(
          {
            sessionId,
            accountId: access.actor.accountId as AccountId,
            shippingAddress: verification.shippingAddress,
            addressVerificationDecision: parseAddressVerificationDecision(body.addressVerificationDecision),
          },
          context,
        );
        writeSources.push(shippingAddressResult);
        session = shippingAddressResult.session;
      }

      if (session.source_type === "offer-intent") {
        const offerSubmission = await submitPurchaseIntentThroughMarketplace(c.req.raw, session);
        const offerResult = await services.recordOfferSubmitted(
          {
            sessionId,
            accountId: access.actor.accountId as AccountId,
            offerId: offerSubmission.offerId,
          },
          context,
        );
        session = offerResult.session;
        return c.json({
          offer_id: offerSubmission.offerId,
          status: "purchase-intent-submitted",
          session,
          ...checkoutCommitMetadataFromSources([offerSubmission.writeResult, offerResult]),
        });
      }

      if (!marketplaceCheckoutFeeQuoteFingerprint) {
        return c.json(paymentQuoteRequiredResponse(), 409);
      }

      let orderIds = [...session.order_ids];
      let orderCreationWriteResult: unknown;
      if (orderIds.length === 0) {
        const readySession = await services.assertReadyForOrderCreation({
          sessionId,
          accountId: access.actor.accountId as AccountId,
        });
        const reservationAttempt = await createCheckoutInventoryReservations(c.req.raw, readySession);
        const checkoutReservations = [...reservationAttempt.reservations];
        if (checkoutReservations.length > 0) {
          const reservationResult = await services.recordCheckoutReservations(
            {
              sessionId,
              accountId: access.actor.accountId as AccountId,
              reservations: checkoutReservations,
            },
            context,
          );
          writeSources.push(reservationResult);
        }
        if (reservationAttempt.unavailableLines.length > 0) {
          return c.json(
            {
              error: {
                code: "checkout_reservation_unavailable",
                message: t("checkout.features.sessions.api.route.checkout.reservation.unavailable"),
              },
              unavailableLines: reservationAttempt.unavailableLines,
              ...checkoutCommitMetadataFromSources(writeSources),
            },
            409,
          );
        }
        const checkoutOrders = await createCheckoutOrdersThroughOrdering(c.req.raw, readySession, {
          fulfillmentPreviewRevision,
          acknowledgedMaterialChanges,
          checkoutReservations,
        });
        orderIds = checkoutOrders.orderIds;
        orderCreationWriteResult = checkoutOrders.writeResult;
        writeSources.push(orderCreationWriteResult);
        const ordersResult = await services.recordOrdersCreated(
          {
            sessionId,
            accountId: access.actor.accountId as AccountId,
            orderIds,
            fulfilledLineKeys: checkoutOrders.readyLineKeys,
            orderWriteCommitPositions: orderingCommitPositionsFromSource(orderCreationWriteResult),
          },
          context,
        );
        writeSources.push(ordersResult);
        session = ordersResult.session;
      }

      const orderInputFreshnessSource = paymentOrderInputFreshnessSource(session, orderCreationWriteResult);
      if (orderCreationWriteResult === undefined && orderInputFreshnessSource !== undefined) {
        writeSources.push(orderInputFreshnessSource);
      }

      const payment = await createCheckoutPaymentThroughPayments(
        c.req.raw,
        sessionId,
        orderIds,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
        marketplaceCheckoutFeeQuoteFingerprint,
        savedCheckoutInstrumentId,
        savePaymentMethodForFuture,
        access.actor.roleKey === "guest-buyer" ? "/checkout/payments/:paymentId" : "/account/payments/:paymentId",
        null,
        orderInputFreshnessSource,
      );
      const paymentId = payment.payment_id;
      const paymentResult = await services.recordPaymentStarted(
        {
          sessionId,
          accountId: access.actor.accountId as AccountId,
          paymentId,
        },
        context,
      );

      session = paymentResult.session;
      recordConfirmationPendingHandoff(checkoutObservabilityTelemetry, access.actor, session, "payment-started");
      return c.json({
        payment_id: paymentId,
        order_ids: orderIds,
        status: "confirmed",
        session,
        ...checkoutCommitMetadataFromSources([payment, paymentResult]),
      });
    } catch (error) {
      const stalePaymentQuote = paymentQuoteRequiredFromStaleFeeQuote(error, writeSources);
      if (stalePaymentQuote) {
        return c.json(stalePaymentQuote, 409);
      }

      const paymentStartPending = paymentStartPendingFromMissingOrder(error, writeSources);
      if (paymentStartPending) {
        return c.json(paymentStartPending, 409);
      }

      const code = errorCode(error);
      recordActiveSessionStaleRecovery(checkoutObservabilityTelemetry, access.actor, code);
      recordAddressServiceabilityFailure(checkoutObservabilityTelemetry, access.actor, code);
      recordUnassignedFulfillmentFailure(checkoutObservabilityTelemetry, access.actor, code);
      recordUnsupportedCustomerEconomicsInput(checkoutObservabilityTelemetry, access.actor, code);
      recordDisabledSavedInstrumentFailure(checkoutObservabilityTelemetry, access.actor, code);
      return c.json(
        { error: { code, message: errorMessage(error) } },
        code === unsupportedCustomerEconomicsInputCode || code === savedCheckoutInstrumentUnavailableCode ? 409 : 400,
      );
    }
  });

  return app;
}
