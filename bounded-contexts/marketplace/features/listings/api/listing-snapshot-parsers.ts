import { MarketplaceListingRequestError } from "./listing-request-error";
import { parseGradedCardSnapshot } from "@chase-sets/primitives/graded-card-snapshot";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { normalizeMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";
import { z } from "zod";

const requiredTextSchema = z.string().refine((value) => value.trim().length > 0);
const optionalTextSchema = z.string().nullable().optional();

const addressFields = {
  name: requiredTextSchema,
  company: optionalTextSchema,
  line1: requiredTextSchema,
  line2: optionalTextSchema,
  city: requiredTextSchema,
  state: requiredTextSchema,
  postalCode: requiredTextSchema,
  country: requiredTextSchema,
  phone: optionalTextSchema,
  email: optionalTextSchema,
};
const addressVerificationSchema = z.strictObject({
  status: z.enum(["verified", "corrected", "unverified", "undeliverable"]),
  source: requiredTextSchema,
  checkedAt: z.iso.datetime({ offset: true }),
  buyerDecision: z.enum(["accepted-suggested", "kept-original", "provider-unavailable"]).nullable().optional(),
  suggestedAddress: z.strictObject(addressFields).nullable().optional(),
  messages: z.array(z.string()).optional(),
});
const shipFromAddressSnapshotSchema = z.strictObject({
  ...addressFields,
  verification: addressVerificationSchema.nullable().optional(),
});

export function parseShipFromAddressSnapshot(value: unknown): AddressSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = shipFromAddressSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")) {
      throw new MarketplaceListingRequestError("unknown-field", "Ship-from address snapshot contains unknown fields.");
    }
    throw new MarketplaceListingRequestError("inventory-snapshot-invalid", "Ship-from address snapshot is invalid.");
  }

  return parsed.data;
}

export function parseAcquisitionCostSnapshot(amount: unknown, currencyCode: unknown) {
  if (amount != null && (typeof amount !== "string" || tryMoneyToCents(amount) === null)) {
    throw new MarketplaceListingRequestError("inventory-snapshot-invalid", "Acquisition cost amount is invalid.");
  }
  if (
    currencyCode != null &&
    (typeof currencyCode !== "string" || !/^[A-Z]{3}$/.test(currencyCode) || amount == null)
  ) {
    throw new MarketplaceListingRequestError("inventory-snapshot-invalid", "Acquisition cost currency is invalid.");
  }
  return {
    acquisitionCostAmount: typeof amount === "string" ? normalizeMoneyAmount(amount) : null,
    // Old amount-only snapshots have no evidence of their denomination.
    acquisitionCostCurrencyCode: typeof currencyCode === "string" ? currencyCode : null,
  };
}

export { parseGradedCardSnapshot };
