import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeVersionSelection,
  type CartLineId,
  type VersionSelectedOptionEntry,
} from "../../../support/runtime-support/common";

export type CheckoutCartLine = Readonly<{
  lineId: CartLineId;
  catalogItemId: string;
  productId: string;
  itemLanguageCode: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  itemImageUrl: string | null;
  itemImageSrcSet: string | null;
  itemImageLoadingUrl: string | null;
  itemImageLoadingAlt: string | null;
  itemImageLoadingSrcSet: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode: "optimize" | "locked-listing";
  lockedListingId: string | null;
  sellerPreferenceId: string | null;
  selectedListingSnapshot: CheckoutSelectedListingSnapshot | null;
  availabilityState: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type CheckoutSelectedListingSnapshot = Readonly<{
  listingId: string;
  sellerAccountId: string | null;
  sellerDisplayName: string | null;
  sellerSlug: string | null;
  priceAmount: string | null;
  source: string;
}>;

export type CheckoutSelectedListingSnapshotInput = Readonly<{
  listingId: string;
  sellerAccountId?: string | null;
  sellerDisplayName?: string | null;
  sellerSlug?: string | null;
  priceAmount?: string | null;
  source?: string | null;
}>;

export type CheckoutCartState = Readonly<{
  buyerAccountId: AccountId | null;
  // The Account that claimed this anonymous source stream, if any. Claiming never
  // rewrites `buyerAccountId`: the source stream keeps its own identity so its
  // projected lines stay addressable by the key that wrote them.
  claimedByAccountId: AccountId | null;
  lines: readonly CheckoutCartLine[];
  lastCheckedOutAt: string | null;
}>;

export const initialCheckoutCartState: CheckoutCartState = {
  buyerAccountId: null,
  claimedByAccountId: null,
  lines: [],
  lastCheckedOutAt: null,
};

const ANONYMOUS_CART_OWNER_PREFIX = "anon_";
const CLAIMING_ACCOUNT_PREFIX = "acc_";

export type CheckoutCartClaimIdentity = Readonly<{
  sourceOwnerKey: string;
  accountId: AccountId;
}>;

// Cart Claim identity equality is exact: an unpadded, whitespace-free string with
// the required prefix and a non-empty suffix. Trimming an identifier here would
// silently address a different stream, so a padded value is refused rather than
// normalized. This deliberately does not introduce strict-ULID validation --
// synthetic `acc_buyer` / `anon_cart_a` and generated identifiers stay valid.
function isExactPrefixedIdentity(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.length > prefix.length && value.startsWith(prefix) && !/\s/.test(value);
}

export function requireCheckoutCartClaimIdentity(claim: Readonly<{ sourceOwnerKey: unknown; accountId: unknown }>) {
  assert(
    isExactPrefixedIdentity(claim.sourceOwnerKey, ANONYMOUS_CART_OWNER_PREFIX),
    "Cart claim source must be an exact anonymous cart key.",
  );
  assert(
    isExactPrefixedIdentity(claim.accountId, CLAIMING_ACCOUNT_PREFIX),
    "Cart claim account must be an exact account id.",
  );
  assert(claim.sourceOwnerKey !== claim.accountId, "A cart cannot claim itself.");

  return {
    sourceOwnerKey: claim.sourceOwnerKey,
    accountId: claim.accountId as AccountId,
  } satisfies CheckoutCartClaimIdentity;
}

export type AddCartLineCommand = Readonly<{
  type: "AddCartLine";
  buyerAccountId: AccountId;
  lineId: CartLineId;
  catalogItemId: string;
  productId: string;
  itemLanguageCode?: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  itemImageUrl: string | null;
  itemImageSrcSet?: string | null;
  itemImageLoadingUrl?: string | null;
  itemImageLoadingAlt?: string | null;
  itemImageLoadingSrcSet?: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type SetCartLineQuantityCommand = Readonly<{
  type: "SetCartLineQuantity";
  actingOwnerKey: string;
  lineId: CartLineId;
  quantity: number;
}>;

export type SetCartLineFulfillmentCommand = Readonly<{
  type: "SetCartLineFulfillment";
  actingOwnerKey: string;
  lineId: CartLineId;
  fulfillmentMode: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type RemoveCartLineCommand = Readonly<{
  type: "RemoveCartLine";
  actingOwnerKey: string;
  lineId: CartLineId;
}>;

export type ClearCartCommand = Readonly<{
  type: "CheckoutCart";
  checkedOutAt: string;
}>;

export type ClaimCartCommand = Readonly<{
  type: "ClaimCart";
  sourceOwnerKey: string;
  accountId: AccountId;
}>;

export type CheckoutCartCommand =
  | AddCartLineCommand
  | SetCartLineQuantityCommand
  | SetCartLineFulfillmentCommand
  | RemoveCartLineCommand
  | ClearCartCommand
  | ClaimCartCommand;

export type CartLineAddedEvent = DomainEvent<
  "checkout.cart.line-added",
  Readonly<{
    buyerAccountId: AccountId;
    lineId: CartLineId;
    catalogItemId: string;
    productId: string;
    itemLanguageCode: string | null;
    itemTitle: string;
    itemSubtitle: string | null;
    itemImageUrl: string | null;
    itemImageSrcSet?: string | null;
    itemImageLoadingUrl?: string | null;
    itemImageLoadingAlt?: string | null;
    itemImageLoadingSrcSet?: string | null;
    selectedOptions: VersionSelectedOptionEntry[];
    productSummary: string | null;
    quantity: number;
    fulfillmentMode?: "optimize" | "locked-listing";
    lockedListingId?: string | null;
    sellerPreferenceId?: string | null;
    selectedListingSnapshot?: CheckoutSelectedListingSnapshot | null;
    availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
  }>
>;

export type CartLineQuantitySetEvent = DomainEvent<
  "checkout.cart.line-quantity-set",
  Readonly<{
    lineId: CartLineId;
    quantity: number;
  }>
>;

export type CartLineFulfillmentSetEvent = DomainEvent<
  "checkout.cart.line-fulfillment-set",
  Readonly<{
    lineId: CartLineId;
    fulfillmentMode: "optimize" | "locked-listing";
    lockedListingId: string | null;
    sellerPreferenceId: string | null;
    selectedListingSnapshot: CheckoutSelectedListingSnapshot | null;
    availabilityState: "available" | "unavailable" | "changed" | "waiting-for-supply";
  }>
>;

export type CartLineRemovedEvent = DomainEvent<
  "checkout.cart.line-removed",
  Readonly<{
    lineId: CartLineId;
  }>
>;

export type CartCheckedOutEvent = DomainEvent<
  "checkout.cart.checked-out",
  Readonly<{
    buyerAccountId: AccountId;
    checkedOutAt: string;
  }>
>;

export type CartClaimedByAccountEvent = DomainEvent<
  "checkout.cart.claimed-by-account",
  Readonly<{
    sourceOwnerKey: string;
    accountId: AccountId;
  }>
>;

export type CheckoutCartEvent =
  | CartLineAddedEvent
  | CartLineQuantitySetEvent
  | CartLineFulfillmentSetEvent
  | CartLineRemovedEvent
  | CartCheckedOutEvent
  | CartClaimedByAccountEvent;

function requireCartLine(state: CheckoutCartState, lineId: CartLineId) {
  const line = state.lines.find((entry) => entry.lineId === lineId);
  assert(line, "Cart line not found.");
  return line;
}

/**
 * The single identity that may act on this cart, and the buyer its lines belong
 * to. Claiming moves both to the claimant Account while `buyerAccountId` keeps
 * the retained anonymous source identity, so possession of a claimed `anon_` key
 * stops being a write capability the moment the claim event lands.
 *
 * This reads evolved aggregate state only. The `checkout_cart_claims` alias and
 * the line-page projection are routing indexes: either can lag or be deleted
 * outright, so neither may decide authorization.
 */
function effectiveCartOwner(state: CheckoutCartState): AccountId | null {
  return state.claimedByAccountId ?? state.buyerAccountId;
}

/**
 * Refuses before any decision an unauthorized writer could observe.
 *
 * A null owner is an uninitialized stream, which holds no lines -- the caller's
 * own `requireCartLine` then refuses with the missing-line message. Ordering the
 * ownership check first is what keeps "this owner lacks the line", which a
 * line-id-total sweep absorbs, distinguishable from "this writer may not touch
 * this cart", which it must never absorb.
 */
function assertActingOwnerMayWrite(state: CheckoutCartState, actingOwnerKey: string) {
  const owner = effectiveCartOwner(state);
  assert(owner === null || owner === actingOwnerKey, "Cart is owned by a different account.");
}

function normalizeFulfillmentMode(
  value: "optimize" | "locked-listing" | undefined,
  lockedListingId: string | null | undefined,
) {
  return value === "locked-listing" || normalizeOptionalText(lockedListingId) ? "locked-listing" : "optimize";
}

function normalizeAvailabilityState(value: "available" | "unavailable" | "changed" | "waiting-for-supply" | undefined) {
  switch (value) {
    case "unavailable":
    case "changed":
    case "waiting-for-supply":
      return value;
    default:
      return "available";
  }
}

function normalizeOptionalPriceAmount(value?: string | null) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  assert(/^\d+(\.\d{1,2})?$/.test(normalized), "Selected listing price must be a valid amount.");
  const amount = Number.parseFloat(normalized);
  assert(Number.isFinite(amount) && amount > 0, "Selected listing price must be a positive amount.");
  return amount.toFixed(2);
}

function normalizeSelectedListingSnapshot(
  value: CheckoutSelectedListingSnapshotInput | CheckoutSelectedListingSnapshot | null | undefined,
  lockedListingId: string | null | undefined,
) {
  if (!value) {
    return null;
  }

  const normalizedLockedListingId = normalizeOptionalText(lockedListingId);
  const listingId = normalizeRequiredText(value.listingId, "Selected listing snapshot must include a listing.");
  assert(
    normalizedLockedListingId !== null && listingId === normalizedLockedListingId,
    "Selected listing snapshot must match the locked listing.",
  );

  return {
    listingId,
    sellerAccountId: normalizeOptionalText(value.sellerAccountId),
    sellerDisplayName: normalizeOptionalText(value.sellerDisplayName),
    sellerSlug: normalizeOptionalText(value.sellerSlug),
    priceAmount: normalizeOptionalPriceAmount(value.priceAmount),
    source: normalizeRequiredText(
      value.source ?? "checkout-cart-request",
      "Selected listing snapshot source is required.",
    ),
  };
}

function assertCartLineIsNotOwnListing(
  buyerAccountId: AccountId | null,
  selectedListingSnapshot: CheckoutSelectedListingSnapshot | null,
) {
  if (!buyerAccountId || !selectedListingSnapshot?.sellerAccountId) {
    return;
  }

  assert(buyerAccountId !== selectedListingSnapshot.sellerAccountId, "Accounts cannot add their own listings to cart.");
}

export const decideCheckoutCart: AggregateDecider<CheckoutCartState, CheckoutCartCommand, CheckoutCartEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "AddCartLine":
      assertActingOwnerMayWrite(state, command.buyerAccountId);
      assert(!state.lines.some((line) => line.lineId === command.lineId), "Cart line has already been added.");
      const selectedListingSnapshot = normalizeSelectedListingSnapshot(
        command.selectedListingSnapshot,
        command.lockedListingId,
      );
      assertCartLineIsNotOwnListing(command.buyerAccountId, selectedListingSnapshot);
      return [
        {
          type: "checkout.cart.line-added",
          data: {
            buyerAccountId: command.buyerAccountId,
            lineId: command.lineId,
            catalogItemId: normalizeRequiredText(command.catalogItemId, "Cart lines must reference a catalog item."),
            productId: normalizeRequiredText(String(command.productId), "Cart lines must reference a product id."),
            itemLanguageCode: normalizeOptionalText(command.itemLanguageCode ?? null),
            itemTitle: normalizeRequiredText(command.itemTitle, "Cart lines must include an item title snapshot."),
            itemSubtitle: normalizeOptionalText(command.itemSubtitle),
            itemImageUrl: normalizeOptionalText(command.itemImageUrl),
            itemImageSrcSet: normalizeOptionalText(command.itemImageSrcSet),
            itemImageLoadingUrl: normalizeOptionalText(command.itemImageLoadingUrl),
            itemImageLoadingAlt: normalizeOptionalText(command.itemImageLoadingAlt),
            itemImageLoadingSrcSet: normalizeOptionalText(command.itemImageLoadingSrcSet),
            selectedOptions: normalizeVersionSelection(command.selectedOptions),
            productSummary: normalizeOptionalText(command.productSummary),
            quantity: ensurePositiveInteger(command.quantity, "Cart quantity must be a positive whole number."),
            fulfillmentMode: normalizeFulfillmentMode(command.fulfillmentMode, command.lockedListingId),
            lockedListingId: normalizeOptionalText(command.lockedListingId),
            sellerPreferenceId: normalizeOptionalText(command.sellerPreferenceId),
            selectedListingSnapshot,
            availabilityState: normalizeAvailabilityState(command.availabilityState),
          },
        },
      ];
    case "SetCartLineQuantity":
      assertActingOwnerMayWrite(state, command.actingOwnerKey);
      requireCartLine(state, command.lineId);
      return [
        {
          type: "checkout.cart.line-quantity-set",
          data: {
            lineId: command.lineId,
            quantity: ensurePositiveInteger(command.quantity, "Cart quantity must be a positive whole number."),
          },
        },
      ];
    case "SetCartLineFulfillment": {
      assertActingOwnerMayWrite(state, command.actingOwnerKey);
      requireCartLine(state, command.lineId);
      const lockedListingId = normalizeOptionalText(command.lockedListingId);
      const fulfillmentMode = normalizeFulfillmentMode(command.fulfillmentMode, lockedListingId);
      assert(fulfillmentMode === "optimize" || Boolean(lockedListingId), "Locked cart lines must reference a listing.");
      const selectedListingSnapshot =
        fulfillmentMode === "locked-listing"
          ? normalizeSelectedListingSnapshot(command.selectedListingSnapshot, lockedListingId)
          : null;
      // The effective buyer, not the retained anonymous source key: on a claimed
      // cart the Account doing the locking is the one that must not buy its own
      // listing.
      assertCartLineIsNotOwnListing(effectiveCartOwner(state), selectedListingSnapshot);
      return [
        {
          type: "checkout.cart.line-fulfillment-set",
          data: {
            lineId: command.lineId,
            fulfillmentMode,
            lockedListingId: fulfillmentMode === "locked-listing" ? lockedListingId : null,
            sellerPreferenceId: normalizeOptionalText(command.sellerPreferenceId),
            selectedListingSnapshot,
            availabilityState: normalizeAvailabilityState(command.availabilityState),
          },
        },
      ];
    }
    case "RemoveCartLine":
      assertActingOwnerMayWrite(state, command.actingOwnerKey);
      requireCartLine(state, command.lineId);
      return [
        {
          type: "checkout.cart.line-removed",
          data: {
            lineId: command.lineId,
          },
        },
      ];
    case "CheckoutCart":
      assert(state.buyerAccountId !== null, "Cart has not been initialized.");
      assert(state.lines.length > 0, "Cart must contain at least one line.");
      return [
        {
          type: "checkout.cart.checked-out",
          data: {
            buyerAccountId: state.buyerAccountId,
            checkedOutAt: normalizeRequiredText(command.checkedOutAt, "Checkout must record a timestamp."),
          },
        },
      ];
    case "ClaimCart": {
      const claim = requireCheckoutCartClaimIdentity(command);
      // The runtime builds the stream id from this same validated source, so an
      // initialized state owned by a different key means the command was
      // addressed at the wrong stream. Refuse before any event or alias write.
      assert(
        state.buyerAccountId === null || state.buyerAccountId === claim.sourceOwnerKey,
        "Cart claim source does not match the cart stream owner.",
      );
      // A pre-feature snapshot has no claim field at all; an absent field is an
      // unclaimed cart, never a refusal.
      const claimedByAccountId = state.claimedByAccountId ?? null;
      if (claimedByAccountId === claim.accountId) {
        return [];
      }

      assert(claimedByAccountId === null, "Cart is already claimed by a different account.");
      return [
        {
          type: "checkout.cart.claimed-by-account",
          data: {
            sourceOwnerKey: claim.sourceOwnerKey,
            accountId: claim.accountId,
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveCheckoutCart: AggregateEvolver<CheckoutCartState, CheckoutCartEvent> = (state, event) => {
  switch (event.type) {
    case "checkout.cart.line-added":
      return {
        buyerAccountId: event.data.buyerAccountId,
        claimedByAccountId: state.claimedByAccountId ?? null,
        lines: [
          ...state.lines,
          {
            lineId: event.data.lineId,
            catalogItemId: event.data.catalogItemId,
            productId: event.data.productId,
            itemLanguageCode: event.data.itemLanguageCode,
            itemTitle: event.data.itemTitle,
            itemSubtitle: event.data.itemSubtitle,
            itemImageUrl: event.data.itemImageUrl,
            itemImageSrcSet: normalizeOptionalText(event.data.itemImageSrcSet),
            itemImageLoadingUrl: normalizeOptionalText(event.data.itemImageLoadingUrl),
            itemImageLoadingAlt: normalizeOptionalText(event.data.itemImageLoadingAlt),
            itemImageLoadingSrcSet: normalizeOptionalText(event.data.itemImageLoadingSrcSet),
            selectedOptions: event.data.selectedOptions,
            productSummary: event.data.productSummary,
            quantity: event.data.quantity,
            fulfillmentMode: normalizeFulfillmentMode(event.data.fulfillmentMode, event.data.lockedListingId),
            lockedListingId: normalizeOptionalText(event.data.lockedListingId),
            sellerPreferenceId: normalizeOptionalText(event.data.sellerPreferenceId),
            selectedListingSnapshot: normalizeSelectedListingSnapshot(
              event.data.selectedListingSnapshot,
              event.data.lockedListingId,
            ),
            availabilityState: normalizeAvailabilityState(event.data.availabilityState),
          },
        ],
        lastCheckedOutAt: state.lastCheckedOutAt,
      };
    case "checkout.cart.line-quantity-set":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId ? { ...line, quantity: event.data.quantity } : line,
        ),
      };
    case "checkout.cart.line-fulfillment-set":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId
            ? {
                ...line,
                fulfillmentMode: event.data.fulfillmentMode,
                lockedListingId: event.data.lockedListingId,
                sellerPreferenceId: event.data.sellerPreferenceId,
                selectedListingSnapshot: normalizeSelectedListingSnapshot(
                  event.data.selectedListingSnapshot,
                  event.data.lockedListingId,
                ),
                availabilityState: event.data.availabilityState,
              }
            : line,
        ),
      };
    case "checkout.cart.line-removed":
      return {
        ...state,
        lines: state.lines.filter((line) => line.lineId !== event.data.lineId),
      };
    case "checkout.cart.checked-out":
      return {
        buyerAccountId: event.data.buyerAccountId,
        // Checking out clears lines, never ownership: a claimed cart stays
        // claimed after it is emptied.
        claimedByAccountId: state.claimedByAccountId ?? null,
        lines: [],
        lastCheckedOutAt: event.data.checkedOutAt,
      };
    case "checkout.cart.claimed-by-account":
      return {
        ...state,
        // The claim establishes the source stream identity when the anonymous
        // cart has no line history yet.
        buyerAccountId: state.buyerAccountId ?? (event.data.sourceOwnerKey as AccountId),
        claimedByAccountId: event.data.accountId,
      };
    default:
      return assertNever(event);
  }
};
