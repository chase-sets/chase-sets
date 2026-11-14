import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  CheckoutSellerCheckoutOwners,
  SellerCheckoutReadinessOwner,
  SellerCheckoutReadinessResult,
  SellerCheckoutRiskResult,
  SellerShippingOrigin,
  SellerShippingOriginResolution,
} from "../../../api";
import type { CheckoutShipFromAddressRow } from "../../cart/integrations/identity/identity-queries";
import type { SellListSellerConfirmationEvidence } from "../domain/domain";
import type { SellerCheckoutChoices, SellerCheckoutOwnerReadCapture } from "../domain/owner-reads";
import type { SellListReadinessLine, SellListReadinessSnapshot } from "../domain/readiness";
import type {
  CheckoutSellListCompositeReview,
  CheckoutSellListLineRow,
  CheckoutSellPayoutReadinessRow,
} from "./queries";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  const row = object(value);
  return !!row && Object.keys(row).length === keys.length && Object.keys(row).every((key) => keys.includes(key));
}

export function realTimestamp(value: unknown): string | null {
  try {
    const stamp = value instanceof Date ? value.toISOString() : value;
    if (typeof stamp !== "string") return null;
    parseIsoUtcTimestamp(stamp);
    const canonical = new Date(stamp).toISOString();
    return canonical.slice(0, 19) === stamp.slice(0, 19) ? canonical : null;
  } catch {
    return null;
  }
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function sellerCheckoutOwner(id: string): SellerCheckoutReadinessOwner | null {
  if (/^anon_[A-Za-z0-9_-]+$/.test(id) && id.length <= 160)
    return { kind: "anonymous", anonymousSellListId: id as `anon_${string}` };
  if (/^acc_[A-Za-z0-9_-]+$/.test(id) && id.length <= 160 && id !== "acc_anonymous_sell_list")
    return { kind: "account", accountId: id as AccountId };
  return null;
}

export function parseSellerCheckoutChoices(value: unknown): SellerCheckoutChoices {
  const body = object(value);
  const ship = object(body?.shipFrom);
  const label = body?.label;
  const preference =
    closed(label, ["preference"]) && (label.preference === "prepaid-label" || label.preference === "seller-label-later")
      ? label.preference
      : null;
  let shipFrom: SellerCheckoutChoices["shipFrom"];
  if (closed(ship, ["addressId"]) && typeof ship.addressId === "string" && ship.addressId.trim()) {
    shipFrom = { addressId: ship.addressId };
  } else if (
    ship &&
    Object.keys(ship).every((key) =>
      ["name", "line1", "line2", "city", "state", "postalCode", "country"].includes(key),
    ) &&
    ["name", "line1", "city", "state", "postalCode", "country"].every(
      (key) =>
        typeof ship[key] === "string" && (ship[key] as string).trim().length > 0 && (ship[key] as string).length <= 200,
    ) &&
    (ship.line2 === undefined || ship.line2 === null || (typeof ship.line2 === "string" && ship.line2.length <= 200))
  ) {
    shipFrom = {
      name: ship.name as string,
      line1: ship.line1 as string,
      line2: (ship.line2 as string | null) ?? null,
      city: ship.city as string,
      state: ship.state as string,
      postalCode: ship.postalCode as string,
      country: ship.country as string,
    };
  }
  return { ...(shipFrom ? { shipFrom } : {}), ...(preference ? { label: { preference } } : {}) };
}

function riskResult(value: unknown): SellerCheckoutRiskResult | null {
  if (
    !closed(value, [
      "schemaVersion",
      "policyRevision",
      "rowState",
      "status",
      "reasonCode",
      "sourceRevision",
      "sourceTimestamp",
    ]) ||
    value.schemaVersion !== "settlement.seller-checkout-risk.v1" ||
    value.policyRevision !== "seller-checkout-risk-v1"
  )
    return null;
  const paired =
    (value.status === "clear" && value.reasonCode === null) ||
    (value.status === "hold" && value.reasonCode === "risk-hold") ||
    (value.status === "block" && value.reasonCode === "risk-block");
  const valid =
    value.rowState === "absent"
      ? value.status === "clear" &&
        value.reasonCode === null &&
        value.sourceRevision === 0 &&
        value.sourceTimestamp === null
      : value.rowState === "unavailable"
        ? value.status === "not-clear" &&
          value.reasonCode === "risk-not-clear" &&
          value.sourceRevision === null &&
          value.sourceTimestamp === null
        : value.rowState === "present" &&
          paired &&
          typeof value.sourceRevision === "number" &&
          Number.isSafeInteger(value.sourceRevision) &&
          value.sourceRevision >= 0 &&
          realTimestamp(value.sourceTimestamp) !== null;
  return valid ? (value as SellerCheckoutRiskResult) : null;
}

function fulfillmentResult(value: unknown): SellerCheckoutReadinessResult | null {
  if (
    !closed(value, ["schemaVersion", "label", "provider", "sourceRevision", "sourceTimestamp"]) ||
    value.schemaVersion !== "fulfillment.seller-checkout-readiness.v1"
  )
    return null;
  for (const [name, reason] of [
    ["label", "label-not-ready"],
    ["provider", "provider-not-ready"],
  ] as const) {
    const dimension = value[name];
    if (
      !(closed(dimension, ["status", "reason"]) && dimension.status === "ready" && dimension.reason === "ready") &&
      !(
        closed(dimension, ["status", "reason", "fact"]) &&
        dimension.status === "blocked" &&
        dimension.reason === reason &&
        typeof dimension.fact === "string" &&
        ["missing", "stale", "conflicting", "unavailable"].includes(dimension.fact)
      )
    )
      return null;
  }
  const stamped = revision(value.sourceRevision) && realTimestamp(value.sourceTimestamp) !== null;
  const unstamped =
    value.sourceRevision === null &&
    value.sourceTimestamp === null &&
    object(value.label)?.status === "blocked" &&
    object(value.provider)?.status === "blocked";
  return stamped || unstamped ? (value as SellerCheckoutReadinessResult) : null;
}

function originResult(
  value: unknown,
  owner: SellerCheckoutReadinessOwner,
  preference: string,
): SellerShippingOriginResolution | null {
  if (
    closed(value, ["status", "fact"]) &&
    value.status === "blocked" &&
    typeof value.fact === "string" &&
    ["missing", "conflicting", "stale", "unavailable"].includes(value.fact)
  )
    return value as SellerShippingOriginResolution;
  if (
    !closed(value, ["status", "key", "sourceRevision", "sourceTimestamp"]) ||
    value.status !== "accepted" ||
    !revision(value.sourceRevision) ||
    !realTimestamp(value.sourceTimestamp)
  )
    return null;
  const key = value.key;
  if (
    !closed(key, ["owner", "shipFromLocationId", "labelPreference"]) ||
    key.labelPreference !== preference ||
    typeof key.shipFromLocationId !== "string" ||
    !/^sfl_[A-Za-z0-9_-]+$/.test(key.shipFromLocationId) ||
    key.shipFromLocationId.length > 160
  )
    return null;
  const owned = key.owner;
  if (
    owner.kind === "account"
      ? !closed(owned, ["kind", "accountId"]) || owned.kind !== "account" || owned.accountId !== owner.accountId
      : !closed(owned, ["kind", "anonymousSellListId"]) ||
        owned.kind !== "anonymous" ||
        owned.anonymousSellListId !== owner.anonymousSellListId
  )
    return null;
  return value as SellerShippingOriginResolution;
}

async function safely<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export async function readSellerCheckoutOwners(
  params: Readonly<{
    ownerId: string;
    choices: SellerCheckoutChoices;
    ports?: CheckoutSellerCheckoutOwners;
    addresses: () => Promise<readonly CheckoutShipFromAddressRow[]>;
  }>,
) {
  const owner = sellerCheckoutOwner(params.ownerId);
  const choices = parseSellerCheckoutChoices(params.choices);
  let selected: SellerShippingOrigin | null = null;
  let addressId: string | null = null;
  if (choices.shipFrom && "addressId" in choices.shipFrom) {
    if (owner?.kind === "account") {
      const id = choices.shipFrom.addressId;
      const addresses = await safely(params.addresses);
      const matches =
        addresses?.filter((row) => row.shipping_address_id === id && row.account_id === owner.accountId) ?? [];
      if (matches.length === 1) {
        const row = matches[0]!;
        selected = {
          name: row.recipient_name,
          line1: row.line1,
          line2: row.line2,
          city: row.city,
          state: row.state,
          postalCode: row.postal_code,
          country: row.country,
        };
        addressId = id;
      }
    }
  } else if (choices.shipFrom) selected = choices.shipFrom;
  const preference = choices.label?.preference;
  const risk = owner && params.ports ? riskResult(await safely(() => params.ports!.readRisk(owner))) : null;
  const origin =
    owner && selected && preference && params.ports
      ? originResult(
          await safely(() => params.ports!.resolveOrigin(owner, { origin: selected, labelPreference: preference })),
          owner,
          preference,
        )
      : null;
  const fulfillment =
    origin?.status === "accepted" && params.ports
      ? fulfillmentResult(await safely(() => params.ports!.readFulfillment(origin.key)))
      : null;
  const bound =
    origin?.status === "accepted" &&
    fulfillment?.sourceRevision === origin.sourceRevision &&
    fulfillment.sourceTimestamp === origin.sourceTimestamp;
  return { owner, risk, origin, fulfillment, bound, selected, addressId, preference };
}

function cents(value: string): number | null {
  if (!/^\d+\.\d{2}$/.test(value)) return null;
  const result = Number(value.replace(".", ""));
  return Number.isSafeInteger(result) ? result : null;
}

export function sellerCheckoutEstimate(
  lines: readonly CheckoutSellListLineRow[],
  review: CheckoutSellListCompositeReview | null,
  snapshot: SellListReadinessSnapshot,
): SellerCheckoutOwnerReadCapture["estimate"] {
  const unavailable = { status: "unavailable", amount: null, currencyCode: null } as const;
  if (!review || snapshot.unresolvedLineIds.length || !snapshot.includedLineIds.length) return unavailable;
  let total = 0;
  let currencyCode: string | null = null;
  for (const lineId of snapshot.includedLineIds) {
    const line = lines.find((row) => row.line_id === lineId);
    if (!line || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) return unavailable;
    const action = snapshot.lineOutcomes.find((row) => row.lineId === lineId)?.action;
    if (action === "selected-offer") {
      const item = review.offerReviews.find((row) => row.lineId === lineId);
      const net = item?.status === "ready" && item.terms ? cents(item.terms.seller_net_unit_amount) : null;
      if (net === null || !line.offer_price_currency_code) return unavailable;
      if (currencyCode && currencyCode !== line.offer_price_currency_code) return unavailable;
      currencyCode = line.offer_price_currency_code;
      total += net * line.quantity;
    } else if (action === "smart-match") {
      const item = review.productOfferReviews.find((row) => row.lineId === lineId);
      if (
        item?.status !== "ready" ||
        item.offers.length === 0 ||
        item.offers.reduce((sum, row) => sum + row.offer.quantity_requested, 0) > line.quantity
      )
        return unavailable;
      for (const { offer, terms } of item.offers) {
        const net = cents(terms.seller_net_unit_amount);
        if (
          net === null ||
          !Number.isSafeInteger(offer.quantity_requested) ||
          offer.quantity_requested <= 0 ||
          !offer.price_currency_code ||
          (currencyCode && currencyCode !== offer.price_currency_code)
        )
          return unavailable;
        currencyCode = offer.price_currency_code;
        total += net * offer.quantity_requested;
      }
    } else if (action === "fallback-listing") {
      if (
        !line.minimum_listing_price_amount ||
        cents(line.minimum_listing_price_amount) === null ||
        !review.inventoryItems.some(
          (item) => item.product_id === line.product_id && item.available_quantity >= line.quantity,
        )
      )
        return unavailable;
      // A future listing is not a sale: it contributes no immediate seller payout.
    } else return unavailable;
    if (!Number.isSafeInteger(total)) return unavailable;
  }
  return { status: "complete", amount: (total / 100).toFixed(2), currencyCode };
}

export function sellerCheckoutEvidence(
  params: Readonly<{
    reads: Awaited<ReturnType<typeof readSellerCheckoutOwners>>;
    payout: CheckoutSellPayoutReadinessRow | null;
    estimate: SellerCheckoutOwnerReadCapture["estimate"];
    lines: readonly SellListReadinessLine[];
  }>,
): SellListSellerConfirmationEvidence {
  const { reads, payout } = params;
  const shipReady = reads.bound && !!reads.selected;
  const payoutReady =
    payout?.account_id ===
      (reads.owner?.kind === "account" ? reads.owner.accountId : reads.owner?.anonymousSellListId) &&
    payout?.status === "ready" &&
    realTimestamp(payout.updated_at) !== null;
  const freshness =
    reads.bound &&
    params.lines.length > 0 &&
    params.lines.every(
      (line) =>
        realTimestamp(line.updated_at) && (!line.listing_evidence || realTimestamp(line.listing_evidence.updatedAt)),
    ) &&
    params.estimate.status === "complete";
  return {
    shipFrom: {
      status: shipReady ? "ready" : "blocked",
      addressId: reads.addressId,
      country: reads.selected?.country ?? "",
      region: reads.selected?.state ?? "",
      postalCode: reads.selected?.postalCode ?? "",
    },
    payout: {
      status: payoutReady && params.estimate.status === "complete" ? "ready" : "blocked",
      method: "saved-payout",
      readinessStatus: payout?.status ?? "not-started",
      lastCheckedAt: realTimestamp(payout?.updated_at),
    },
    label: {
      status: reads.bound && reads.fulfillment?.label.status === "ready" ? "ready" : "blocked",
      preference: reads.preference ?? "prepaid-label",
    },
    risk: { status: reads.risk?.status ?? "not-clear" },
    provider: { status: reads.bound && reads.fulfillment?.provider.status === "ready" ? "ready" : "blocked" },
    freshness: { status: freshness ? "current" : "stale" },
    authorityRevision: JSON.stringify({
      owner: reads.owner,
      origin: reads.origin,
      fulfillment: reads.fulfillment,
      riskPolicy: reads.risk?.policyRevision ?? null,
      estimate: params.estimate,
    }),
  };
}
