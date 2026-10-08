import type { ShippingOption } from "@chase-sets/product-measures";
import type { ChannelOrderFulfillmentStatus } from "@chase-sets/event-core/public-event-payloads";
import { assertClosedRecord, assertRfc3339Instant } from "../../connections/domain/validation";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import { composeChannelOrderFulfillmentReference } from "./fulfillment-reference";

export const fulfillmentObservationKind = "channel-order-fulfillment-observation/v1";
export type CapturedOrderValue = Readonly<{ surface: "list" | "detail"; value: string }>;
export type ChannelOrderShipTo = Readonly<{
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}>;
export type ChannelOrderFulfillmentLine = Readonly<{
  productId: string;
  skuId: string;
  providerOrderLineIdentity: string;
  quantity: number;
  unitPriceAmount: string;
}>;
type Identity = Readonly<{
  version: 1;
  providerKey: "tcgplayer";
  externalOrderReference: string;
  providerOrderStatus: CapturedOrderValue;
}>;
export type ChannelOrderFulfillmentObservation = Identity &
  (
    | Readonly<{
        variant: "full";
        orderedAt: string;
        providerShippingType: CapturedOrderValue;
        shipTo: ChannelOrderShipTo;
        lines: readonly ChannelOrderFulfillmentLine[];
        productAmount: string;
        shippingAmount: string;
        currency: Readonly<{ code: "USD"; provenance: "tcgplayer-constant" }>;
      }>
    | Readonly<{ variant: "status-only"; revision: string }>
  );
export class FulfillmentObservationRefusal extends Error {
  constructor(readonly code: "invalid-schema" | "unsupported-shipping-type" | "unsupported-order-status") {
    super(code);
  }
}

export function translateOrderShippingType(input: CapturedOrderValue): ShippingOption {
  if (input.surface === "list" && input.value === "Standard") return "standard";
  if (input.surface === "list" && input.value === "Expedited") return "expedited";
  if (input.surface === "detail" && input.value === "Standard (7-10 days)") return "standard";
  throw new FulfillmentObservationRefusal("unsupported-shipping-type");
}
export function translateOrderStatus(input: CapturedOrderValue): ChannelOrderFulfillmentStatus {
  if (input.surface === "detail" && input.value === "Ready to Ship") return "active";
  if (input.surface === "list") {
    if (input.value === "Canceled") return "cancelled";
    if (["Completed - Paid", "Ready to Ship", "Shipped - In Transit", "Shipped - Delivered"].includes(input.value))
      return "active";
  }
  throw new FulfillmentObservationRefusal("unsupported-order-status");
}

export function assertFulfillmentObservation(value: unknown): asserts value is ChannelOrderFulfillmentObservation {
  try {
    assertClosedRecord(
      value,
      [
        "version",
        "variant",
        "providerKey",
        "externalOrderReference",
        "providerOrderStatus",
        "revision",
        "orderedAt",
        "providerShippingType",
        "shipTo",
        "lines",
        "productAmount",
        "shippingAmount",
        "currency",
      ],
      "observation",
    );
    const common = ["version", "variant", "providerKey", "externalOrderReference", "providerOrderStatus"];
    if (value.version !== 1 || value.providerKey !== "tcgplayer") invalid();
    text(value.externalOrderReference, 128);
    captured(value.providerOrderStatus);
    translateOrderStatus(value.providerOrderStatus);
    if (value.variant === "status-only") {
      assertClosedRecord(value, [...common, "revision"], "status observation");
      text(value.revision, 512);
      return;
    }
    assertClosedRecord(
      value,
      [
        ...common,
        "orderedAt",
        "providerShippingType",
        "shipTo",
        "lines",
        "productAmount",
        "shippingAmount",
        "currency",
      ],
      "full observation",
    );
    if (value.variant !== "full") invalid();
    assertRfc3339Instant(value.orderedAt);
    captured(value.providerShippingType);
    translateOrderShippingType(value.providerShippingType);
    assertClosedRecord(value.currency, ["code", "provenance"], "currency");
    if (value.currency.code !== "USD" || value.currency.provenance !== "tcgplayer-constant") invalid();
    amount(value.productAmount);
    amount(value.shippingAmount);
    assertClosedRecord(
      value.shipTo,
      ["name", "line1", "line2", "city", "state", "postalCode", "country", "phone"],
      "ship-to",
    );
    for (const key of ["name", "line1", "city", "state", "postalCode", "country"]) text(value.shipTo[key], 256);
    for (const key of ["line2", "phone"]) if (Object.hasOwn(value.shipTo, key)) text(value.shipTo[key], 256);
    if (!/^[A-Z]{2}$/.test(String(value.shipTo.country))) invalid();
    if (!Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 500) invalid();
    const identities = new Set<string>();
    for (const line of value.lines) {
      assertClosedRecord(
        line,
        ["productId", "skuId", "providerOrderLineIdentity", "quantity", "unitPriceAmount"],
        "line",
      );
      for (const key of ["productId", "skuId"])
        if (typeof line[key] !== "string" || !/^[1-9]\d{0,19}$/.test(line[key])) invalid();
      text(line.providerOrderLineIdentity, 1024);
      if (identities.has(line.providerOrderLineIdentity)) invalid();
      identities.add(line.providerOrderLineIdentity);
      if (!Number.isSafeInteger(line.quantity) || Number(line.quantity) < 1 || Number(line.quantity) > 1000000)
        invalid();
      amount(line.unitPriceAmount);
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144) invalid();
  } catch (error) {
    if (error instanceof FulfillmentObservationRefusal) throw error;
    invalid();
  }
}
export async function fulfillmentObservationDigest(observation: ChannelOrderFulfillmentObservation) {
  const bytes = new TextEncoder().encode(canonicalJson(observation));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function composeChannelOrderFulfillmentInbound(observation: ChannelOrderFulfillmentObservation) {
  assertFulfillmentObservation(observation);
  const record = structuredClone(observation);
  const digest = await fulfillmentObservationDigest(record);
  return {
    inboundKind: fulfillmentObservationKind as typeof fulfillmentObservationKind,
    externalReference: await composeChannelOrderFulfillmentReference(record.externalOrderReference, digest),
    payload: { version: 1 as const, records: [record] },
  };
}
function captured(value: unknown): asserts value is CapturedOrderValue {
  assertClosedRecord(value, ["surface", "value"], "captured value");
  if (value.surface !== "list" && value.surface !== "detail") invalid();
  text(value.value, 128);
}
function text(value: unknown, max: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid();
}
function amount(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,9})\.\d{2}$/.test(value)) invalid();
}
function invalid(): never {
  throw new FulfillmentObservationRefusal("invalid-schema");
}
