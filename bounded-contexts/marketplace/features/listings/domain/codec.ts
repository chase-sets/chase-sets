import { z } from "zod";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import { tryMoneyToCents } from "@chase-sets/primitives/money";
import type { MarketplaceListingEvent } from "./domain";

const text = z.string().min(1);
const revision = z.number().int().positive().safe();
const money = z.string().refine((value) => {
  const cents = tryMoneyToCents(value);
  return cents !== null && cents >= 0n;
}, "Invalid retained money amount.");
const price = money.refine((value) => tryMoneyToCents(value)! > 0n, "Listing price must be positive.");
const currency = z.string().regex(/^[A-Z]{3}$/);
const nullableText = text.nullable();
const bps = z.number().int().min(0).max(10_000);
const limits = z.strictObject({
  maxUnitsPerOrder: revision.nullable(),
  maxUnitsPerDay: revision.nullable(),
  maxUnitsPerCustomerAccount: revision.nullable(),
});
const feeLock = z.strictObject({
  unitCount: revision,
  terms: z.strictObject({
    marketplaceSalesFeePercentageBps: bps,
    marketplaceSalesFeeFixedAmount: money,
    marketplaceSalesFeeCapAmount: money.nullable(),
    shippingAllowancePercentageBps: bps,
    termsScheduleId: nullableText,
    termsAgreementId: nullableText,
    termsResolvedAt: text,
  }),
  marketplaceSalesFeeUnitAmount: money,
  sellerNetUnitAmount: money,
  feeQuoteFingerprint: text,
});
const fees = {
  marketplaceSalesFeeUnitAmount: money.nullable(),
  sellerNetUnitAmount: money.nullable(),
  shippingAllowancePercentageBps: bps.optional(),
  termsScheduleId: nullableText,
  termsAgreementId: nullableText,
  termsResolvedAt: nullableText,
  feeQuoteFingerprint: nullableText.optional(),
  feeLocks: z.array(feeLock),
};
const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("native-marketplace") }),
  z.strictObject({ kind: z.literal("channel-connection"), connectionId: text }),
]);
const decision = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("seller-reference") }),
  z.strictObject({ kind: z.literal("legacy-native-anchor") }),
  z.strictObject({
    kind: z.literal("pricing-evaluation"),
    evaluationId: text,
    evaluationRevision: text,
    policyId: text,
    policyRevision: text,
    goal: z.strictObject({ goalId: text, version: text }).nullable(),
    inputEvidenceRefs: z.array(text),
    curveEvidenceRefs: z.array(text),
    economicsSourceRevision: nullableText,
    economicsOverrideRevision: nullableText,
    basePriceRevision: revision,
    standingAuthorizationId: text,
    standingAuthorizationRevision: text,
  }),
]);
export const acceptedListingTargetPriceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    accountId: text,
    listingId: text,
    target,
    priceAmount: price,
    priceCurrencyCode: currency,
    targetPriceRevision: revision,
    listingRevision: revision,
    acceptedByUserId: text,
    acceptedAt: z.iso.datetime(),
    sourceEventId: text,
    decision,
    connectionAuthority: z
      .strictObject({
        connectionId: text,
        providerKey: text,
        environment: z.enum(["sandbox", "production"]),
        identityRevision: revision,
      })
      .nullable(),
  })
  .superRefine((accepted, ctx) => {
    if (accepted.targetPriceRevision !== accepted.listingRevision) {
      ctx.addIssue({ code: "custom", message: "Accepted target revision must identify its owner commit." });
    }
    if (accepted.target.kind === "native-marketplace") {
      if (accepted.connectionAuthority !== null) {
        ctx.addIssue({ code: "custom", message: "Native acceptance cannot carry connection authority." });
      }
    } else if (
      accepted.connectionAuthority?.connectionId !== accepted.target.connectionId ||
      accepted.decision.kind !== "pricing-evaluation"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "External acceptance requires matching connection and Pricing authority.",
      });
    }
  });

const creation = z.strictObject({
  ...fees,
  listingId: text,
  accountId: text,
  inventoryItemId: text,
  catalogItemId: text,
  productId: text,
  itemLanguageCode: z.string().nullable().optional(),
  itemTitle: z.string().nullable(),
  itemSubtitle: z.string().nullable(),
  selectedOptions: z.array(z.strictObject({ dimensionId: text, optionId: text })),
  productSummary: z.string().nullable(),
  productMeasureSnapshot: z.json().optional(),
  gradedCard: z.json().optional(),
  storageLocationName: z.string().nullable(),
  shipFromCode: z.string().nullable(),
  shipFromAddress: z.json(),
  priceAmount: price,
  priceCurrencyCode: currency.nullable().optional(),
  quantityCap: revision,
  purchaseLimits: limits.optional(),
  evidenceRequirements: z.json().optional(),
  evidence: z.array(z.json()).optional(),
  changeSource: z.literal("repricing-engine").optional(),
});
const historicalFees = {
  marketplaceSalesFeeUnitAmount: money,
  sellerNetUnitAmount: money,
  termsResolvedAt: text,
};
const created = z.union([
  creation.extend({ ...historicalFees, schemaVersion: z.never().optional() }),
  creation
    .extend({
      schemaVersion: z.literal(2),
      requestFingerprint: text.optional(),
      priceCurrencyCode: currency,
      publicationScope: z.enum(["native", "channel-only"]),
      nativeVisibility: z.enum(["enabled", "disabled"]),
      nativeFeeState: z.enum(["enrolled", "not-enrolled"]),
    })
    .superRefine((data, ctx) => {
      const native = data.publicationScope === "native";
      if (
        data.nativeVisibility !== (native ? "enabled" : "disabled") ||
        data.nativeFeeState !== (native ? "enrolled" : "not-enrolled")
      ) {
        ctx.addIssue({ code: "custom", message: "Creation scope, visibility and fee enrollment disagree." });
      }
      if (
        native
          ? data.feeLocks.reduce((sum, lock) => sum + lock.unitCount, 0) !== data.quantityCap
          : data.feeLocks.length !== 0 ||
            data.marketplaceSalesFeeUnitAmount !== null ||
            data.sellerNetUnitAmount !== null ||
            data.termsResolvedAt !== null ||
            data.termsScheduleId !== null ||
            data.termsAgreementId !== null ||
            data.feeQuoteFingerprint !== null
      ) {
        ctx.addIssue({ code: "custom", message: "Creation fee locks disagree with enrollment." });
      }
      if (
        native &&
        (data.marketplaceSalesFeeUnitAmount === null ||
          data.sellerNetUnitAmount === null ||
          data.termsResolvedAt === null ||
          !data.feeQuoteFingerprint)
      ) {
        ctx.addIssue({ code: "custom", message: "Native creation requires its retained fee quote." });
      }
    }),
]);
const priceUpdate = z.strictObject({
  ...fees,
  priceAmount: price,
  priceCurrencyCode: currency.nullable().optional(),
  changeSource: z.literal("repricing-engine").optional(),
});
const priceUpdated = z.union([
  priceUpdate.extend({ ...historicalFees, schemaVersion: z.never().optional() }),
  priceUpdate
    .extend({
      schemaVersion: z.literal(2),
      priceCurrencyCode: currency,
      requestFingerprint: text.optional(),
      acceptedTargetPrice: acceptedListingTargetPriceSchema.refine(
        (accepted) => accepted.decision.kind !== "legacy-native-anchor",
      ),
    })
    .superRefine((data, ctx) => {
      const accepted = data.acceptedTargetPrice;
      if (
        accepted.target.kind !== "native-marketplace" ||
        accepted.priceAmount !== data.priceAmount ||
        accepted.priceCurrencyCode !== data.priceCurrencyCode
      ) {
        ctx.addIssue({ code: "custom", message: "Native price payload and accepted pair disagree." });
      }
    }),
]);
const quantityUpdate = z.strictObject({ ...fees, quantityCap: revision, purchaseLimits: limits.optional() });
const quantityUpdated = z.union([
  quantityUpdate.extend({ ...historicalFees, schemaVersion: z.never().optional() }),
  quantityUpdate.extend({ schemaVersion: z.literal(2) }),
]);
const pauseReason = z.enum(["seller", "policy-input-missing", "channel-inbound-dark"]);
const schemas = {
  "marketplace.listing.created": created,
  "marketplace.listing.price-updated": priceUpdated,
  "marketplace.listing.quantity-cap-updated": quantityUpdated,
  "marketplace.listing.target-price-accepted": z.strictObject({
    schemaVersion: z.literal(1),
    acceptedTargetPrice: acceptedListingTargetPriceSchema.refine(
      (accepted) => accepted.target.kind === "channel-connection",
    ),
  }),
  "marketplace.listing.channel-activated": z.strictObject({
    connectionId: text,
    targetPriceRevision: revision,
    allocationRevision: revision,
  }),
  "marketplace.listing.native-visibility-changed": z
    .strictObject({
      nativeVisibility: z.enum(["enabled", "disabled"]),
      nativeFeeState: z.enum(["enrolled", "not-enrolled"]),
      feeLocks: z.array(feeLock),
      evidenceRequirements: z.json(),
    })
    .refine(
      (data) =>
        data.nativeFeeState === "enrolled" || (data.nativeVisibility === "disabled" && data.feeLocks.length === 0),
      "Unenrolled native visibility must stay disabled and unlocked.",
    ),
  "marketplace.listing.resumed": z.strictObject({ pauseReason }),
  "marketplace.listing.published": z.strictObject({ csatOutcomeFact: z.json().optional() }),
  "marketplace.listing.paused": z.strictObject({ reason: pauseReason.optional() }),
  "marketplace.listing.withdrawn": z.strictObject({}),
  "marketplace.listing.auto-unlisted": z.strictObject({
    reportId: text,
    reportCount: revision,
    threshold: revision,
    autoUnlistedAt: text,
  }),
  "marketplace.listing.purchase-limits-updated": z.strictObject({ purchaseLimits: limits }),
  "marketplace.listing.photos-added": z.strictObject({ evidence: z.array(z.json()) }),
  "marketplace.listing.photo-classified": z.strictObject({
    photoId: text,
    slotId: nullableText,
    viewKind: nullableText,
    altText: z.string().nullable(),
    capturedAt: nullableText,
  }),
  "marketplace.listing.photo-replaced": z.strictObject({ replacedPhotoId: text, photo: z.json() }),
  "marketplace.listing.photo-removed": z.strictObject({ photoId: text }),
  "marketplace.listing.photos-reordered": z.strictObject({ orderedPhotoIds: z.array(text) }),
  "marketplace.listing.evidence-requirements-refreshed": z.strictObject({ evidenceRequirements: z.json() }),
  "marketplace.listing.offer-commitment-recorded": z.strictObject({
    offerId: text,
    quantity: revision,
    evidenceSnapshotHash: text,
    committedAt: text,
  }),
} satisfies Record<MarketplaceListingEvent["type"], z.ZodType>;

export const marketplaceListingCodec: DomainEventCodec<MarketplaceListingEvent> = {
  encode(event) {
    const decoded = marketplaceListingCodec.decode({ eventType: event.type, payload: event.data });
    return { eventType: decoded.type, payload: decoded.data };
  },
  decode(event) {
    if (!Object.hasOwn(schemas, event.eventType)) throw new Error(`Unsupported Listing event: ${event.eventType}.`);
    const type = event.eventType as MarketplaceListingEvent["type"];
    const data = schemas[type].parse(event.payload);
    return { type, data } as MarketplaceListingEvent;
  },
};
