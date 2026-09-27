import type { DomainEvent } from "@chase-sets/event-core";
import { moneyToCents } from "@chase-sets/primitives/money";
import type { MarketplaceOfferState } from "../../offers/domain/domain";
import { buyerOfferPolicyTermsSchema, type BuyerOfferPolicyTerms } from "./contracts";

export type BuyerOfferPolicyStatus = "draft" | "active" | "paused" | "stopped";
export type BuyerOfferPolicyAudit = Readonly<{
  schemaVersion: 1;
  policyId: string;
  buyerAccountId: string;
  actorUserId: string;
  operationId: string;
  requestHash: string;
  recordedAt: string;
}>;
export type BuyerOfferPolicyPreview = Readonly<{
  previewId: string;
  policyVersion: number;
  terms: BuyerOfferPolicyTerms;
}>;
export type BuyerOfferPolicyState = Readonly<{
  policyId: string | null;
  buyerAccountId: string | null;
  status: BuyerOfferPolicyStatus;
  revision: number;
  currency: string | null;
  consumedItemAmount: string;
  authority: BuyerOfferPolicyTerms | null;
  preview: BuyerOfferPolicyPreview | null;
}>;
export const initialBuyerOfferPolicyState: BuyerOfferPolicyState = {
  policyId: null,
  buyerAccountId: null,
  status: "draft",
  revision: 0,
  currency: null,
  consumedItemAmount: "0.00",
  authority: null,
  preview: null,
};
export type BuyerOfferPolicyEvent =
  | DomainEvent<"marketplace.offer-policy.created", BuyerOfferPolicyAudit>
  | DomainEvent<"marketplace.offer-policy.previewed", BuyerOfferPolicyAudit & BuyerOfferPolicyPreview>
  | DomainEvent<
      "marketplace.offer-policy.authorized",
      BuyerOfferPolicyAudit & BuyerOfferPolicyPreview & { revision: number; consentedAt: string }
    >
  | DomainEvent<"marketplace.offer-policy.paused", BuyerOfferPolicyAudit>
  | DomainEvent<"marketplace.offer-policy.stopped", BuyerOfferPolicyAudit>;

export class BuyerOfferPolicyError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "invalid_authority"
      | "stale_preview"
      | "enforcement_unavailable"
      | "operation_conflict",
    message: string,
  ) {
    super(message);
    this.name = "BuyerOfferPolicyError";
  }
}
export function assertPolicy(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BuyerOfferPolicyError("invalid_authority", message);
}

export function validateBuyerOfferPolicyTerms(state: BuyerOfferPolicyState, input: BuyerOfferPolicyTerms) {
  const terms = buyerOfferPolicyTermsSchema.parse(input);
  assertPolicy(
    new Set(terms.offers.map((offer) => offer.offerId)).size === terms.offers.length,
    "Offer selection contains duplicates.",
  );
  for (const offer of terms.offers) {
    assertPolicy(
      new Set(offer.selectedOptions.map((option) => option.dimensionId)).size === offer.selectedOptions.length,
      "Offer options contain duplicate dimensions.",
    );
  }
  assertPolicy(
    state.currency === null || state.currency === terms.currency,
    "Policy currency cannot change after authorization.",
  );
  assertPolicy(
    moneyToCents(terms.itemCommitmentAllowance) >= moneyToCents(state.consumedItemAmount),
    "Item allowance cannot be below consumed commitment.",
  );
  return terms;
}

export function assertBuyerOfferPolicySelection(
  policyId: string,
  buyerAccountId: string,
  terms: BuyerOfferPolicyTerms,
  offers: readonly Readonly<{ state: MarketplaceOfferState; version: number }>[],
) {
  assertPolicy(offers.length === terms.offers.length, "Complete Offer selection is required.");
  for (let index = 0; index < offers.length; index += 1) {
    const { state, version } = offers[index]!;
    const selected = terms.offers[index]!;
    assertPolicy(
      state.offerId === selected.offerId && state.buyerAccountId === buyerAccountId,
      "Offer selection is unavailable.",
    );
    assertPolicy(state.status === "submitted", "Only submitted Offers can be selected.");
    assertPolicy(version === selected.offerVersion, "Offer selection is stale.");
    assertPolicy(
      !state.buyerOfferPolicyId || state.buyerOfferPolicyId === policyId,
      "Offer is permanently bound to another policy.",
    );
    assertPolicy(state.priceCurrencyCode === terms.currency, "Offer currency must match policy currency.");
    assertPolicy(
      state.catalogItemId === selected.catalogItemId &&
        state.productId === selected.productId &&
        state.quantityRequested === selected.quantity,
      "Offer scope and quantity must match exactly.",
    );
    assertPolicy(
      JSON.stringify(state.selectedOptions) === JSON.stringify(selected.selectedOptions),
      "Offer options must match exactly.",
    );
    assertPolicy(
      state.priceAmount !== null && moneyToCents(state.priceAmount) <= moneyToCents(selected.maximumUnitItemAmount),
      "Current unit item amount exceeds the buyer maximum.",
    );
  }
}

export type BuyerOfferPolicyCommand =
  | { type: "CreateBuyerOfferPolicy"; audit: BuyerOfferPolicyAudit }
  | { type: "PreviewBuyerOfferPolicy"; audit: BuyerOfferPolicyAudit; preview: BuyerOfferPolicyPreview }
  | {
      type: "AuthorizeBuyerOfferPolicy";
      audit: BuyerOfferPolicyAudit;
      previewId: string;
      policyVersion: number;
      consent: true;
    }
  | { type: "PauseBuyerOfferPolicy" | "StopBuyerOfferPolicy"; audit: BuyerOfferPolicyAudit };

export function decideBuyerOfferPolicy(
  state: BuyerOfferPolicyState,
  command: BuyerOfferPolicyCommand,
): readonly BuyerOfferPolicyEvent[] {
  const audit = command.audit;
  if (command.type === "CreateBuyerOfferPolicy") {
    assertPolicy(state.policyId === null, "Policy already exists.");
    return [{ type: "marketplace.offer-policy.created", data: audit }];
  }
  if (state.policyId !== audit.policyId || state.buyerAccountId !== audit.buyerAccountId) {
    throw new BuyerOfferPolicyError("not_found", "Buyer Offer Policy not found.");
  }
  if (command.type === "StopBuyerOfferPolicy" && state.status === "stopped") return [];
  assertPolicy(state.status !== "stopped", "Stopped policies are terminal.");
  if (command.type === "PreviewBuyerOfferPolicy") {
    validateBuyerOfferPolicyTerms(state, command.preview.terms);
    return [{ type: "marketplace.offer-policy.previewed", data: { ...audit, ...command.preview } }];
  }
  if (command.type === "AuthorizeBuyerOfferPolicy") {
    if (
      !state.preview ||
      state.preview.previewId !== command.previewId ||
      state.preview.policyVersion !== command.policyVersion
    ) {
      throw new BuyerOfferPolicyError("stale_preview", "A fresh exact-version preview is required.");
    }
    assertPolicy(command.consent === true, "Explicit buyer consent is required.");
    validateBuyerOfferPolicyTerms(state, state.preview.terms);
    return [
      {
        type: "marketplace.offer-policy.authorized",
        data: {
          ...audit,
          ...state.preview,
          revision: state.revision + 1,
          consentedAt: audit.recordedAt,
        },
      },
    ];
  }
  if (command.type === "PauseBuyerOfferPolicy") {
    if (state.status === "paused") return [];
    assertPolicy(state.status === "active", "Only active policies can pause.");
    return [{ type: "marketplace.offer-policy.paused", data: audit }];
  }
  return [{ type: "marketplace.offer-policy.stopped", data: audit }];
}

export function evolveBuyerOfferPolicy(
  state: BuyerOfferPolicyState,
  event: BuyerOfferPolicyEvent,
): BuyerOfferPolicyState {
  switch (event.type) {
    case "marketplace.offer-policy.created":
      return {
        ...initialBuyerOfferPolicyState,
        policyId: event.data.policyId,
        buyerAccountId: event.data.buyerAccountId,
      };
    case "marketplace.offer-policy.previewed":
      return {
        ...state,
        preview: { previewId: event.data.previewId, policyVersion: event.data.policyVersion, terms: event.data.terms },
      };
    case "marketplace.offer-policy.authorized":
      return {
        ...state,
        status: "active",
        currency: event.data.terms.currency,
        authority: event.data.terms,
        revision: event.data.revision,
        preview: null,
      };
    case "marketplace.offer-policy.paused":
      return { ...state, status: "paused", preview: null };
    case "marketplace.offer-policy.stopped":
      return { ...state, status: "stopped", preview: null };
  }
}

export function assertBuyerOfferPolicyAdmission(state: BuyerOfferPolicyState, offer: MarketplaceOfferState) {
  assertPolicy(
    state.status === "active" && state.authority !== null,
    "Only active policies admit managed changes or acceptance.",
  );
  const selection = state.authority.offers.find((selected) => selected.offerId === offer.offerId);
  assertPolicy(selection && offer.buyerOfferPolicyId === state.policyId, "Offer is outside authorized policy scope.");
  assertBuyerOfferPolicySelection(state.policyId!, state.buyerAccountId!, { ...state.authority, offers: [selection] }, [
    { state: offer, version: selection.offerVersion },
  ]);
}
