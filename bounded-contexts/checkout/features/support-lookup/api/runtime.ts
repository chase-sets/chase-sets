import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  confirmationIdFromSellListSupportReference,
  sellListConfirmationSupportReference,
} from "../../sell-list/read-model/support-reference";

export type CheckoutSupportEffectStatus =
  | "not-attempted"
  | "not-applicable"
  | "handoff-recorded"
  | "pending-downstream"
  | "failed";

export type CheckoutSupportState = "pending" | "committed" | "failed" | "no-side-effect";

export type CheckoutSupportSideEffects = Readonly<{
  order: CheckoutSupportEffectStatus;
  payment: CheckoutSupportEffectStatus;
  offer: CheckoutSupportEffectStatus;
  sale: CheckoutSupportEffectStatus;
  label: CheckoutSupportEffectStatus;
  payout: CheckoutSupportEffectStatus;
  settlement: CheckoutSupportEffectStatus;
  notification: CheckoutSupportEffectStatus;
  accountHistory: CheckoutSupportEffectStatus;
}>;

export type BuyCheckoutSupportLookup = Readonly<{
  type: "buy-checkout-session";
  supportReference: string;
  matchedReference: "checkout-session" | "fulfillment-group";
  state: CheckoutSupportState;
  sourceType: "cart" | "buy-now" | "offer-intent";
  optimizationGoal: "lowest-total" | "fewest-shipments";
  lineCount: number;
  groupCount: number;
  matchedGroup: Readonly<{
    supportReference: string;
    itemCount: number;
    packageCount: number;
    deliveryPromise: string | null;
    downstreamReferenceStatus: "not-started" | "unknown";
  }> | null;
  ownerFacts: Readonly<{
    orderCount: number;
    paymentStarted: boolean;
    offerSubmitted: boolean;
  }>;
  sideEffects: CheckoutSupportSideEffects;
  createdAt: string;
  updatedAt: string;
}>;

export type SellListConfirmationSupportLookup = Readonly<{
  type: "sell-list-confirmation";
  supportReference: string;
  state: CheckoutSupportState;
  acceptedOfferCount: number;
  publishedListingCount: number;
  skippedLineCount: number;
  sideEffects: CheckoutSupportSideEffects;
  lineOutcomes: readonly Readonly<{
    itemTitle: string;
    status: "completed" | "partial" | "skipped";
    action: "accepted-offer" | "accepted-smart-match" | "published-listing" | "mixed" | "kept-in-sell-list";
    quantity: number;
    remainingQuantity: number;
    detail: string;
  }>[];
  confirmedAt: string;
}>;

export type CheckoutSupportLookupResult = BuyCheckoutSupportLookup | SellListConfirmationSupportLookup;

type BuyCheckoutSupportRow = Readonly<{
  source_type: string;
  optimization_goal: string;
  split_group_handoff: unknown;
  lines: unknown;
  order_ids: unknown;
  payment_id: string | null;
  submitted_offer_id: string | null;
  created_at: string;
  updated_at: string;
}>;

type SellListConfirmationSupportRow = Readonly<{
  confirmation_id: string;
  confirmed_at: string;
  handoff_summary: unknown;
}>;

export type CheckoutSupportLookupServices = ReturnType<typeof createCheckoutSupportLookupRuntime>;

export function createCheckoutSupportLookupRuntime({ db }: { db: PgQueryable }) {
  return {
    lookupBySupportReference: (supportReference: string) => lookupCheckoutSupportReference(db, supportReference),
  };
}

export async function lookupCheckoutSupportReference(
  db: PgQueryable,
  supportReference: string,
): Promise<CheckoutSupportLookupResult | null> {
  const normalizedReference = supportReference.trim();
  if (!normalizedReference) {
    return null;
  }

  const buyLookup = await lookupBuyCheckoutReference(db, normalizedReference);
  if (buyLookup) {
    return buyLookup;
  }

  return lookupSellListConfirmationReference(db, normalizedReference);
}

async function lookupBuyCheckoutReference(
  db: PgQueryable,
  supportReference: string,
): Promise<BuyCheckoutSupportLookup | null> {
  const result = await db.query<BuyCheckoutSupportRow>(
    `SELECT
       source_type,
       optimization_goal,
       split_group_handoff,
       lines,
       order_ids,
       payment_id,
       submitted_offer_id,
       created_at,
       updated_at
     FROM checkout_session_pages
     WHERE split_group_handoff ->> 'supportReference' = $1
        OR split_group_handoff @> jsonb_build_object(
          'groups',
          jsonb_build_array(jsonb_build_object('supportReference', $1::text))
        )
     ORDER BY updated_at DESC
     LIMIT 1`,
    [supportReference],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const handoff = objectValue(row.split_group_handoff);
  const groups = arrayValue(handoff?.groups)
    .map(objectValue)
    .filter((group): group is Record<string, unknown> => Boolean(group));
  const sessionReference = stringValue(handoff?.supportReference);
  const matchedGroupSource = groups.find((group) => stringValue(group.supportReference) === supportReference) ?? null;
  const matchedGroup = matchedGroupSource ? sanitizeFulfillmentGroup(matchedGroupSource) : null;
  const orderCount = arrayValue(row.order_ids).filter((value) => typeof value === "string" && value.trim()).length;
  const paymentStarted = stringValue(row.payment_id).length > 0;
  const offerSubmitted = stringValue(row.submitted_offer_id).length > 0;
  const sourceType = normalizeSourceType(row.source_type);

  return {
    type: "buy-checkout-session",
    supportReference,
    matchedReference: sessionReference === supportReference ? "checkout-session" : "fulfillment-group",
    state: orderCount > 0 || offerSubmitted ? "committed" : "pending",
    sourceType,
    optimizationGoal: row.optimization_goal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
    lineCount: arrayValue(row.lines).length,
    groupCount: groups.length,
    matchedGroup,
    ownerFacts: {
      orderCount,
      paymentStarted,
      offerSubmitted,
    },
    sideEffects: buyCheckoutSideEffects(sourceType, orderCount, paymentStarted, offerSubmitted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function lookupSellListConfirmationReference(
  db: PgQueryable,
  supportReference: string,
): Promise<SellListConfirmationSupportLookup | null> {
  const confirmationId = confirmationIdFromSellListSupportReference(supportReference);
  if (!confirmationId) {
    return null;
  }

  const result = await db.query<SellListConfirmationSupportRow>(
    `SELECT
       confirmation_id,
       confirmed_at,
       handoff_summary
     FROM checkout_sell_list_confirmation_pages
     WHERE confirmation_id = $1
     ORDER BY confirmed_at DESC
     LIMIT 1`,
    [confirmationId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const summary = objectValue(row.handoff_summary);
  const acceptedOfferCount = positiveIntegerValue(summary?.acceptedOfferCount);
  const publishedListingCount = positiveIntegerValue(summary?.publishedListingCount);
  const skippedLineCount = positiveIntegerValue(summary?.skippedLineCount);
  const sideEffects = sellListSideEffects(summary?.sideEffects, acceptedOfferCount, publishedListingCount);
  const lineOutcomes = arrayValue(summary?.lineOutcomes)
    .map(objectValue)
    .filter((outcome): outcome is Record<string, unknown> => Boolean(outcome))
    .map(sanitizeSellListLineOutcome);

  return {
    type: "sell-list-confirmation",
    supportReference: sellListConfirmationSupportReference(row.confirmation_id),
    state: sellListState(sideEffects, acceptedOfferCount, publishedListingCount, skippedLineCount, lineOutcomes.length),
    acceptedOfferCount,
    publishedListingCount,
    skippedLineCount,
    sideEffects,
    lineOutcomes,
    confirmedAt: row.confirmed_at,
  };
}

function normalizeSourceType(value: string): BuyCheckoutSupportLookup["sourceType"] {
  if (value === "buy-now" || value === "offer-intent") {
    return value;
  }

  return "cart";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveIntegerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function nonNegativeIntegerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function statusValue(value: unknown, fallback: CheckoutSupportEffectStatus): CheckoutSupportEffectStatus {
  return value === "not-attempted" ||
    value === "not-applicable" ||
    value === "handoff-recorded" ||
    value === "pending-downstream" ||
    value === "failed"
    ? value
    : fallback;
}

function sanitizeFulfillmentGroup(group: Record<string, unknown>): BuyCheckoutSupportLookup["matchedGroup"] {
  const supportReference = stringValue(group.supportReference);
  return {
    supportReference,
    itemCount: positiveIntegerValue(group.itemCount),
    packageCount: positiveIntegerValue(group.packageCount),
    deliveryPromise: stringValue(group.deliveryPromise) || null,
    downstreamReferenceStatus:
      stringValue(group.downstreamReferenceStatus) === "not-started" ? "not-started" : "unknown",
  };
}

function buyCheckoutSideEffects(
  sourceType: BuyCheckoutSupportLookup["sourceType"],
  orderCount: number,
  paymentStarted: boolean,
  offerSubmitted: boolean,
): CheckoutSupportSideEffects {
  const orderHandoffRecorded = orderCount > 0;
  const downstreamHandoffRecorded = orderHandoffRecorded || paymentStarted || offerSubmitted;

  return {
    order: orderHandoffRecorded
      ? "handoff-recorded"
      : sourceType === "offer-intent"
        ? "not-applicable"
        : "not-attempted",
    payment: paymentStarted ? "handoff-recorded" : orderHandoffRecorded ? "pending-downstream" : "not-attempted",
    offer: offerSubmitted ? "handoff-recorded" : sourceType === "offer-intent" ? "not-attempted" : "not-applicable",
    sale: "not-applicable",
    label: orderHandoffRecorded ? "pending-downstream" : "not-applicable",
    payout: "not-applicable",
    settlement: paymentStarted ? "pending-downstream" : "not-applicable",
    notification: downstreamHandoffRecorded ? "pending-downstream" : "not-attempted",
    accountHistory: downstreamHandoffRecorded ? "pending-downstream" : "not-attempted",
  };
}

function sellListSideEffects(
  value: unknown,
  acceptedOfferCount: number,
  publishedListingCount: number,
): CheckoutSupportSideEffects {
  const sideEffects = objectValue(value);
  const hasSaleHandoff = acceptedOfferCount > 0;
  const hasMarketplaceHandoff = acceptedOfferCount > 0 || publishedListingCount > 0;

  return {
    order: "not-applicable",
    payment: "not-applicable",
    offer: "not-applicable",
    sale: statusValue(sideEffects?.sale, hasSaleHandoff ? "handoff-recorded" : "not-applicable"),
    label: statusValue(sideEffects?.label, hasSaleHandoff ? "pending-downstream" : "not-applicable"),
    payout: statusValue(sideEffects?.payout, hasSaleHandoff ? "pending-downstream" : "not-applicable"),
    settlement: statusValue(sideEffects?.settlement, hasSaleHandoff ? "pending-downstream" : "not-applicable"),
    notification: statusValue(
      sideEffects?.notification,
      hasMarketplaceHandoff ? "pending-downstream" : "not-applicable",
    ),
    accountHistory: statusValue(
      sideEffects?.accountHistory,
      hasMarketplaceHandoff ? "pending-downstream" : "not-applicable",
    ),
  };
}

function sanitizeSellListLineOutcome(
  source: Record<string, unknown>,
): SellListConfirmationSupportLookup["lineOutcomes"][number] {
  const status = source.status === "completed" || source.status === "partial" ? source.status : "skipped";
  const action =
    source.action === "accepted-offer" ||
    source.action === "accepted-smart-match" ||
    source.action === "published-listing" ||
    source.action === "mixed"
      ? source.action
      : "kept-in-sell-list";

  return {
    itemTitle: stringValue(source.itemTitle),
    status,
    action,
    quantity: positiveIntegerValue(source.quantity),
    remainingQuantity: nonNegativeIntegerValue(source.remainingQuantity),
    detail: stringValue(source.detail),
  };
}

function sellListState(
  sideEffects: CheckoutSupportSideEffects,
  acceptedOfferCount: number,
  publishedListingCount: number,
  skippedLineCount: number,
  lineOutcomeCount: number,
): CheckoutSupportState {
  if (Object.values(sideEffects).includes("failed")) {
    return "failed";
  }

  if (acceptedOfferCount > 0 || publishedListingCount > 0 || sideEffects.sale === "handoff-recorded") {
    return "committed";
  }

  if (skippedLineCount > 0 || lineOutcomeCount > 0) {
    return "no-side-effect";
  }

  return "pending";
}
