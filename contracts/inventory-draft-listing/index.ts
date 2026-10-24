import { z } from "zod";

const text = z.string().trim().min(1).max(256);
const identity = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9_-]{1,180}$/);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const quantity = z.number().int().positive().max(2_147_483_647);
const money = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${BigInt(whole!).toString()}.${fraction.padEnd(2, "0")}`;
  });
const positiveMoney = money.refine((value) => Number(value) > 0, "Money must be greater than zero.");
const addressFields = {
  name: text,
  company: text.nullable().optional(),
  line1: text,
  line2: text.nullable().optional(),
  city: text,
  state: text,
  postalCode: text,
  country: z.string().regex(/^[A-Z]{2}$/),
  phone: text.nullable().optional(),
  email: text.nullable().optional(),
};
const address = z.strictObject({
  ...addressFields,
  verification: z
    .strictObject({
      status: z.enum(["verified", "corrected", "unverified", "undeliverable"]),
      source: text,
      checkedAt: instant,
      buyerDecision: z.enum(["accepted-suggested", "kept-original", "provider-unavailable"]).nullable().optional(),
      suggestedAddress: z.strictObject(addressFields).nullable().optional(),
      messages: z.array(text).max(32).optional(),
    })
    .nullable()
    .optional(),
});
export function compareInventoryDraftSelectedOptions(
  left: Readonly<{ dimensionId: string }>,
  right: Readonly<{ dimensionId: string }>,
): number {
  return left.dimensionId < right.dimensionId ? -1 : left.dimensionId > right.dimensionId ? 1 : 0;
}

const selectedOptions = z
  .array(z.strictObject({ dimensionId: text, optionId: text }))
  .max(64)
  .refine((options) => new Set(options.map((option) => option.dimensionId)).size === options.length)
  .transform((options) => [...options].sort(compareInventoryDraftSelectedOptions));
export const inventoryDraftListingMessageSchema = z
  .strictObject({
    schemaVersion: z.literal("inventory-draft-listing/v1"),
    messageId: identity,
    authority: z.strictObject({ tenantId: identity, accountId: identity, performedByUserId: identity }),
    snapshot: z.strictObject({
      importBatchId: identity,
      importRowId: z.string().regex(/^imr_[A-Za-z0-9_-]{1,180}$/),
      committedAt: instant,
      inventoryItemId: identity,
      catalogItemId: identity,
      productId: text,
      selectedOptions,
      storageLocationId: identity,
      storageLocationName: text,
      shipFromCode: text,
      shipFromAddress: address,
      totalQuantity: quantity,
      acquisitionCostAmount: money.nullable(),
      priceAmount: positiveMoney,
      priceCurrencyCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/),
      quantityCap: quantity,
    }),
  })
  .superRefine((message, context) => {
    const { snapshot } = message;
    if (message.messageId !== snapshot.importRowId || snapshot.quantityCap > snapshot.totalQuantity) {
      context.addIssue({ code: "custom", message: "Invalid committed row binding." });
    }
  });

export type InventoryDraftListingMessage = z.infer<typeof inventoryDraftListingMessageSchema>;

export const inventoryDraftListingErrorCodes = ["inventory-draft-conflict", "inventory-draft-unavailable"] as const;
export type InventoryDraftListingErrorCode = (typeof inventoryDraftListingErrorCodes)[number];

export const inventoryDraftListingUnavailableDiagnostics = [
  "listing-rejected",
  "unexpected-failure",
  "receipt-ledger-not-ready",
  "consumer-unbound",
] as const;
export type InventoryDraftListingUnavailableDiagnostic =
  (typeof inventoryDraftListingUnavailableDiagnostics)[number];

export const inventoryDraftListingReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("inventory-draft-listing-receipt/v1"),
    messageVersion: z.literal("inventory-draft-listing/v1"),
    messageId: identity,
    tenantId: identity,
    accountId: identity,
    performedByUserId: identity,
    importBatchId: identity,
    importRowId: z.string().regex(/^imr_[A-Za-z0-9_-]{1,180}$/),
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
    listingId: z.string().regex(/^lst_[A-Za-z0-9_-]{1,180}$/),
    listingVersion: z.literal(1),
    feeQuoteFingerprint: text,
    acceptedAt: instant,
    source: z.enum(["message", "legacy-draft"]),
  })
  .refine(
    (receipt) =>
      receipt.messageId === receipt.importRowId &&
      receipt.listingId === listingIdForInventoryDraftRow(receipt.importRowId),
  );

export type InventoryDraftListingReceipt = z.infer<typeof inventoryDraftListingReceiptSchema>;

export function listingIdForInventoryDraftRow(importRowId: string): string {
  return importRowId.replace(/^imr_/, "lst_");
}

export function canonicalInventoryDraftListingIntent(input: unknown): string {
  return canonicalDraftValue(inventoryDraftListingMessageSchema.parse(input));
}

export function canonicalDraftValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDraftValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDraftValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
