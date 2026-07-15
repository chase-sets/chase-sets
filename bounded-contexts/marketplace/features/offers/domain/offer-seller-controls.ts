import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, OfferId } from "@chase-sets/primitives/typed-ids";
import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";
import {
  DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY,
  parseMoneyCents,
  type MarketplaceOfferAbusePolicy,
} from "./offer-abuse-policy";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeMoneyAmount(value: string): string {
  const normalized = value.trim();
  const cents = tryMoneyToCents(normalized);
  assert(cents !== null, "Offer price amount must be a valid decimal within the supported money range.");
  return centsToMoneyAmount(cents);
}

function cooldownUntil(declinedAt: string, policy: MarketplaceOfferAbusePolicy) {
  return new Date(new Date(declinedAt).getTime() + policy.lowballCooldownWindowMs).toISOString();
}

export type MarketplaceOfferSellerControlState = Readonly<{
  sellerAccountId: AccountId | null;
  buyerAccountId: AccountId | null;
  listingId: string | null;
  productId: string | null;
  mutedAt: string | null;
  declinedOfferIds: readonly OfferId[];
  declinedOfferCount: number;
  lowballDeclineCount: number;
  lastLowballDeclinedAmount: string | null;
  lowballCooldownUntil: string | null;
}>;

export const initialMarketplaceOfferSellerControlState: MarketplaceOfferSellerControlState = {
  sellerAccountId: null,
  buyerAccountId: null,
  listingId: null,
  productId: null,
  mutedAt: null,
  declinedOfferIds: [],
  declinedOfferCount: 0,
  lowballDeclineCount: 0,
  lastLowballDeclinedAmount: null,
  lowballCooldownUntil: null,
};

export type DeclineOfferMatchCommand = Readonly<{
  type: "DeclineOfferMatch";
  sellerAccountId: AccountId;
  buyerAccountId: AccountId;
  listingId: string;
  productId: string;
  offerId: OfferId;
  offerPriceAmount: string;
  listingPriceAmount: string;
  declinedAt: string;
  policy?: MarketplaceOfferAbusePolicy;
}>;

export type MuteBuyerOffersCommand = Readonly<{
  type: "MuteBuyerOffers";
  sellerAccountId: AccountId;
  buyerAccountId: AccountId;
  listingId: string;
  productId: string;
  offerId?: OfferId | null;
  mutedAt: string;
}>;

export type UnmuteBuyerOffersCommand = Readonly<{
  type: "UnmuteBuyerOffers";
  sellerAccountId: AccountId;
  buyerAccountId: AccountId;
  listingId: string;
  productId: string;
  unmutedAt: string;
}>;

export type MarketplaceOfferSellerControlCommand =
  | DeclineOfferMatchCommand
  | MuteBuyerOffersCommand
  | UnmuteBuyerOffersCommand;

export type OfferMatchDeclinedEvent = DomainEvent<
  "marketplace.offer.match-declined",
  Readonly<{
    sellerAccountId: AccountId;
    buyerAccountId: AccountId;
    listingId: string;
    productId: string;
    offerId: OfferId;
    offerPriceAmount: string;
    listingPriceAmount: string;
    declinedAt: string;
    lowballDeclineCount: number;
    lowballCooldownUntil: string | null;
  }>
>;

export type OfferBuyerMutedEvent = DomainEvent<
  "marketplace.offer.buyer-muted",
  Readonly<{
    sellerAccountId: AccountId;
    buyerAccountId: AccountId;
    listingId: string;
    productId: string;
    offerId: OfferId | null;
    mutedAt: string;
  }>
>;

export type OfferBuyerUnmutedEvent = DomainEvent<
  "marketplace.offer.buyer-unmuted",
  Readonly<{
    sellerAccountId: AccountId;
    buyerAccountId: AccountId;
    listingId: string;
    productId: string;
    unmutedAt: string;
  }>
>;

export type MarketplaceOfferSellerControlEvent =
  | OfferMatchDeclinedEvent
  | OfferBuyerMutedEvent
  | OfferBuyerUnmutedEvent;

export const decideMarketplaceOfferSellerControl: AggregateDecider<
  MarketplaceOfferSellerControlState,
  MarketplaceOfferSellerControlCommand,
  MarketplaceOfferSellerControlEvent
> = (state, command) => {
  switch (command.type) {
    case "DeclineOfferMatch": {
      assert(!state.declinedOfferIds.includes(command.offerId), "Offer match has already been declined.");
      const policy = command.policy ?? DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY;
      const offerPriceAmount = normalizeMoneyAmount(command.offerPriceAmount);
      const listingPriceAmount = normalizeMoneyAmount(command.listingPriceAmount);
      const isLowball = parseMoneyCents(offerPriceAmount) < parseMoneyCents(listingPriceAmount);
      const nextLowballDeclineCount = isLowball ? state.lowballDeclineCount + 1 : state.lowballDeclineCount;
      return [
        {
          type: "marketplace.offer.match-declined",
          data: {
            sellerAccountId: command.sellerAccountId,
            buyerAccountId: command.buyerAccountId,
            listingId: normalizeRequiredText(command.listingId, "Offer decline must reference a listing."),
            productId: normalizeRequiredText(command.productId, "Offer decline must reference a product."),
            offerId: command.offerId,
            offerPriceAmount,
            listingPriceAmount,
            declinedAt: normalizeRequiredText(command.declinedAt, "Offer decline must record a timestamp."),
            lowballDeclineCount: nextLowballDeclineCount,
            lowballCooldownUntil:
              isLowball && nextLowballDeclineCount >= policy.lowballDeclineCountForCooldown
                ? cooldownUntil(command.declinedAt, policy)
                : null,
          },
        },
      ];
    }
    case "MuteBuyerOffers":
      return [
        {
          type: "marketplace.offer.buyer-muted",
          data: {
            sellerAccountId: command.sellerAccountId,
            buyerAccountId: command.buyerAccountId,
            listingId: normalizeRequiredText(command.listingId, "Offer mute must reference a listing."),
            productId: normalizeRequiredText(command.productId, "Offer mute must reference a product."),
            offerId: command.offerId ?? null,
            mutedAt: normalizeRequiredText(command.mutedAt, "Offer mute must record a timestamp."),
          },
        },
      ];
    case "UnmuteBuyerOffers":
      return [
        {
          type: "marketplace.offer.buyer-unmuted",
          data: {
            sellerAccountId: command.sellerAccountId,
            buyerAccountId: command.buyerAccountId,
            listingId: normalizeRequiredText(command.listingId, "Offer unmute must reference a listing."),
            productId: normalizeRequiredText(command.productId, "Offer unmute must reference a product."),
            unmutedAt: normalizeRequiredText(command.unmutedAt, "Offer unmute must record a timestamp."),
          },
        },
      ];
    default:
      throw new Error(`Unhandled marketplace offer seller control command: ${JSON.stringify(command)}`);
  }
};

export const evolveMarketplaceOfferSellerControl: AggregateEvolver<
  MarketplaceOfferSellerControlState,
  MarketplaceOfferSellerControlEvent
> = (state, event) => {
  if (event.type === "marketplace.offer.match-declined") {
    return {
      ...state,
      sellerAccountId: event.data.sellerAccountId,
      buyerAccountId: event.data.buyerAccountId,
      listingId: event.data.listingId,
      productId: event.data.productId,
      declinedOfferIds: [...state.declinedOfferIds, event.data.offerId],
      declinedOfferCount: state.declinedOfferCount + 1,
      lowballDeclineCount: event.data.lowballDeclineCount,
      lastLowballDeclinedAmount: event.data.lowballCooldownUntil
        ? event.data.offerPriceAmount
        : state.lastLowballDeclinedAmount,
      lowballCooldownUntil: event.data.lowballCooldownUntil ?? state.lowballCooldownUntil,
    };
  }

  if (event.type === "marketplace.offer.buyer-muted") {
    return {
      ...state,
      sellerAccountId: event.data.sellerAccountId,
      buyerAccountId: event.data.buyerAccountId,
      listingId: event.data.listingId,
      productId: event.data.productId,
      mutedAt: event.data.mutedAt,
    };
  }

  if (event.type === "marketplace.offer.buyer-unmuted") {
    return {
      ...state,
      sellerAccountId: event.data.sellerAccountId,
      buyerAccountId: event.data.buyerAccountId,
      listingId: event.data.listingId,
      productId: event.data.productId,
      mutedAt: null,
    };
  }

  throw new Error(`Unhandled marketplace offer seller control event: ${JSON.stringify(event)}`);
};
