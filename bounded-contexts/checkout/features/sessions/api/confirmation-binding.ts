import { createHash } from "node:crypto";
import type { CheckoutSessionRow } from "../read-model/queries";

/**
 * The confirm inputs a Checkout Session binds once their side effect is
 * recorded (#9994 Decision 4). Orders bind the order hash; payment start binds
 * the payment hash. A later confirm that differs in a bound hash is refused
 * before any owner call; inputs no recorded side effect depends on proceed.
 */
export type CheckoutConfirmationBinding = Readonly<{ orderHash: string; paymentHash: string }>;

export type CheckoutConfirmationInput = Readonly<{
  shippingAddress: Readonly<Record<string, unknown>> | null;
  fulfillmentPreviewRevision: string | null;
  acknowledgedMaterialChanges: boolean;
  paymentMethodCategory: string;
  savedCheckoutInstrumentId: string | null;
  requestedBalanceCreditAmount: string | null;
  marketplaceCheckoutFeeQuoteFingerprint: string | null;
  savePaymentMethodForFuture: boolean;
}>;

/** The address content a buyer confirmed; the address-book id and verification receipt are not inputs. */
const SHIPPING_ADDRESS_CONTENT_FIELDS = [
  "name",
  "company",
  "line1",
  "line2",
  "city",
  "state",
  "postalCode",
  "country",
  "phone",
  "email",
] as const;

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function digest(schema: string, value: unknown) {
  return createHash("sha256")
    .update(`${schema}\n${canonicalJson(value)}`)
    .digest("hex");
}

function shippingAddressContent(address: CheckoutConfirmationInput["shippingAddress"]) {
  return address
    ? Object.fromEntries(SHIPPING_ADDRESS_CONTENT_FIELDS.map((field) => [field, address[field] ?? null]))
    : null;
}

export function checkoutConfirmationBinding(
  input: CheckoutConfirmationInput,
  session: Pick<CheckoutSessionRow, "authenticity_check_opt_in">,
): CheckoutConfirmationBinding {
  const optIn = session.authenticity_check_opt_in;
  return {
    orderHash: digest("checkout-confirmation-order/v1", {
      shippingAddress: shippingAddressContent(input.shippingAddress),
      fulfillmentPreviewRevision: input.fulfillmentPreviewRevision,
      acknowledgedMaterialChanges: input.acknowledgedMaterialChanges,
      authenticityCheckOptIn: optIn?.selected ? { selected: true, quoteFingerprint: optIn.quoteFingerprint } : null,
    }),
    paymentHash: digest("checkout-confirmation-payment/v1", {
      paymentMethodCategory: input.paymentMethodCategory,
      savedCheckoutInstrumentId: input.savedCheckoutInstrumentId,
      requestedBalanceCreditAmount: input.requestedBalanceCreditAmount,
      marketplaceCheckoutFeeQuoteFingerprint: input.marketplaceCheckoutFeeQuoteFingerprint,
      savePaymentMethodForFuture: input.savePaymentMethodForFuture,
    }),
  };
}

/**
 * Which bound hash this confirm changes, if any. A side effect recorded
 * without a hash (before the hashes existed) binds nothing, so its Session
 * keeps the result it shipped with.
 */
export function changedCheckoutConfirmationBinding(
  session: Pick<CheckoutSessionRow, "order_ids" | "payment_id">,
  recorded: Readonly<{ orderHash: string | null; paymentHash: string | null }>,
  binding: CheckoutConfirmationBinding,
): "orders" | "payment" | null {
  if (session.order_ids.length > 0 && recorded.orderHash && recorded.orderHash !== binding.orderHash) {
    return "orders";
  }
  if (session.payment_id && recorded.paymentHash && recorded.paymentHash !== binding.paymentHash) {
    return "payment";
  }
  return null;
}
