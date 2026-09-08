import { moneyToCents } from "@chase-sets/primitives/money";
import { gradedCardSnapshotSchema } from "@chase-sets/primitives/graded-card-snapshot";
import {
  channelListingPublishStates,
  channelMappingConfidenceTiers,
  channelMappingDimensions,
  channelMappingReviewStatuses,
  channelPublicationBlockingReasons,
  type ChannelCompositionProgrammingError,
  type ChannelListingCompositionInput,
  type ChannelListingLinkState,
  type ParseChannelListingCompositionInputResult,
} from "./contracts";
import { assertChannelCompositionProfile, deriveChannelSelectedOptionKey } from "./canonical";

class CompositionInputError extends Error {
  public constructor(public readonly code: ChannelCompositionProgrammingError) {
    super(code);
  }
}

export function parseChannelListingCompositionInput(candidate: unknown): ParseChannelListingCompositionInputResult {
  try {
    validateInput(candidate);
    return { kind: "valid", input: candidate };
  } catch (error) {
    return {
      kind: "invalid",
      programmingError: error instanceof CompositionInputError ? error.code : "bound-violation",
    };
  }
}

function validateInput(value: unknown): asserts value is ChannelListingCompositionInput {
  const input = closed(value, [
    "connection",
    "listing",
    "providerProductReference",
    "providerCatalogItemReference",
    "settings",
    "link",
    "profile",
    "mappings",
  ]);
  const connection = closed(input.connection, [
    "connectionId",
    "accountId",
    "providerKey",
    "environment",
    "connectionStatus",
    "publicationScopeState",
  ]);
  text(connection.connectionId, 128);
  text(connection.accountId, 128);
  text(connection.providerKey, 64);
  member(connection.environment, ["sandbox", "production"]);
  member(connection.connectionStatus, ["pending-setup", "active", "paused", "disconnected"]);
  const scope = closed(connection.publicationScopeState, ["kind"]);
  member(scope.kind, ["not-applicable", "current", "stale"]);

  const listing = record(input.listing);
  if (listing.kind === "facts-unavailable") {
    exactKeys(listing, ["kind", "listingId"]);
    text(listing.listingId, 128);
  } else if (listing.kind === "present") {
    exactKeys(listing, [
      "kind",
      "listingId",
      "listingRevision",
      "listingStatus",
      "sellerAvailabilityStatus",
      "identity",
      "offer",
    ]);
    text(listing.listingId, 128);
    safeInteger(listing.listingRevision);
    member(listing.listingStatus, ["draft", "active", "paused", "withdrawn", "auto-unlisted"]);
    member(listing.sellerAvailabilityStatus, ["available", "unavailable"]);
    validateIdentity(listing.identity);
    validateOffer(listing.offer);
  } else invalid("bound-violation");

  validateReference(input.providerProductReference);
  validateReference(input.providerCatalogItemReference);
  const settings = record(input.settings);
  if (settings.kind === "missing") exactKeys(settings, ["kind"]);
  else if (settings.kind === "configured") {
    exactKeys(settings, ["kind", "settings"]);
    validateSettings(settings.settings);
  } else invalid("bound-violation");

  const profile = record(input.profile);
  if (profile.kind === "unregistered") exactKeys(profile, ["kind"]);
  else if (profile.kind === "registered") {
    exactKeys(profile, ["kind", "profile"]);
    assertChannelCompositionProfile(profile.profile);
    const identity = profile.profile.identity;
    if (identity.providerKey !== connection.providerKey || identity.environment !== connection.environment) {
      invalid("profile-identity-mismatch");
    }
  } else invalid("bound-violation");

  const link = record(input.link);
  if (link.kind === "none") exactKeys(link, ["kind"]);
  else if (link.kind === "existing") {
    exactKeys(link, ["kind", "state"]);
    validateLink(link.state);
    if (link.state.connectionId !== connection.connectionId) invalid("link-connection-mismatch");
  } else invalid("bound-violation");

  if (!Array.isArray(input.mappings) || input.mappings.length > 1_000) invalid("bound-violation");
  const identities = new Set<string>();
  for (const value of input.mappings) {
    const mapping = closed(value, ["dimension", "sourceKey", "targetKey", "confidenceTier", "reviewStatus"]);
    member(mapping.dimension, channelMappingDimensions);
    text(mapping.sourceKey, 512);
    nullableText(mapping.targetKey, 512);
    member(mapping.confidenceTier, channelMappingConfidenceTiers);
    member(mapping.reviewStatus, channelMappingReviewStatuses);
    const identity = `${mapping.dimension}\u0000${mapping.sourceKey}`;
    if (identities.has(identity)) invalid("mapping-duplicate-source-key");
    identities.add(identity);
  }
}

function validateIdentity(value: unknown): void {
  const identity = closed(value, [
    "catalogItemId",
    "selectedOptions",
    "selectedOptionKey",
    "categoryIds",
    "itemTitle",
    "itemSubtitle",
    "productSummary",
    "gradedCard",
  ]);
  text(identity.catalogItemId, 128);
  if (!Array.isArray(identity.selectedOptions) || identity.selectedOptions.length > 200) invalid("bound-violation");
  for (const entry of identity.selectedOptions) {
    const selection = closed(entry, ["dimensionId", "optionId"]);
    text(selection.dimensionId, 128);
    text(selection.optionId, 128);
  }
  text(identity.selectedOptionKey, 51_200, true);
  if (identity.selectedOptionKey !== deriveChannelSelectedOptionKey(identity.selectedOptions as never))
    invalid("bound-violation");
  stringArray(identity.categoryIds, 200, 128);
  validateOptionalText(identity.itemTitle);
  validateOptionalText(identity.itemSubtitle);
  validateOptionalText(identity.productSummary);
  const graded = record(identity.gradedCard);
  if (graded.kind === "absent") exactKeys(graded, ["kind"]);
  else if (graded.kind === "present") {
    exactKeys(graded, ["kind", "snapshot"]);
    const parsed = gradedCardSnapshotSchema.strict().safeParse(graded.snapshot);
    if (!parsed.success) invalid("bound-violation");
  } else invalid("bound-violation");
}

function validateOffer(value: unknown): void {
  const offer = closed(value, ["price", "publishableQuantity"]);
  const price = record(offer.price);
  if (price.kind === "absent") exactKeys(price, ["kind"]);
  else if (price.kind === "present") {
    exactKeys(price, ["kind", "amount", "currencyCode"]);
    text(price.amount, 32);
    try {
      moneyToCents(price.amount as string);
    } catch {
      invalid("bound-violation");
    }
    if (typeof price.currencyCode !== "string" || !/^[A-Z]{3}$/.test(price.currencyCode)) invalid("bound-violation");
  } else invalid("bound-violation");
  const quantity = record(offer.publishableQuantity);
  if (quantity.kind === "unavailable") exactKeys(quantity, ["kind"]);
  else if (quantity.kind === "resolved") {
    exactKeys(quantity, ["kind", "value"]);
    safeInteger(quantity.value);
  } else invalid("bound-violation");
}

function validateReference(value: unknown): void {
  const reference = record(value);
  if (reference.kind === "unlinked") exactKeys(reference, ["kind"]);
  else if (reference.kind === "ambiguous") {
    exactKeys(reference, ["kind", "candidateCount"]);
    if (!Number.isSafeInteger(reference.candidateCount) || Number(reference.candidateCount) < 2)
      invalid("bound-violation");
  } else if (reference.kind === "linked") {
    exactKeys(reference, ["kind", "providerKey", "externalKey"]);
    text(reference.providerKey, 64);
    text(reference.externalKey, 512);
  } else invalid("bound-violation");
}

function validateSettings(value: unknown): void {
  const settings = closed(value, [
    "titlePrefix",
    "titleSuffix",
    "descriptionFooter",
    "categoryAllowlist",
    "excludedListingIds",
  ]);
  text(settings.titlePrefix, 1_000, true);
  text(settings.titleSuffix, 1_000, true);
  text(settings.descriptionFooter, 5_000, true);
  stringArray(settings.categoryAllowlist, 1_000, 128);
  stringArray(settings.excludedListingIds, 1_000, 128);
}

function validateOptionalText(value: unknown): void {
  const optional = record(value);
  if (optional.kind === "absent") exactKeys(optional, ["kind"]);
  else if (optional.kind === "present") {
    exactKeys(optional, ["kind", "value"]);
    text(optional.value, 100_000, true);
  } else invalid("bound-violation");
}

function validateLink(value: unknown): asserts value is ChannelListingLinkState {
  const state = closed(value, [
    "connectionId",
    "channelListingId",
    "listingId",
    "externalListingId",
    "externalOfferId",
    "providerRevision",
    "lastDesiredStateSequence",
    "lastDesiredListingRevision",
    "lastDesiredStateHash",
    "lastDesiredIntent",
    "lastPushedListingRevision",
    "lastPushedPriceAmountMinor",
    "lastPushedPriceCurrency",
    "lastPushedQuantity",
    "publishState",
    "blockingReasonCodes",
    "failureReason",
    "driftStatus",
    "lastStreamVersion",
  ]);
  text(state.connectionId, 128);
  text(state.channelListingId, 128);
  text(state.listingId, 128);
  nullableText(state.externalListingId, 512);
  nullableText(state.externalOfferId, 512);
  nullableText(state.providerRevision, 512);
  for (const member of [
    state.lastDesiredStateSequence,
    state.lastDesiredListingRevision,
    state.lastPushedListingRevision,
    state.lastPushedPriceAmountMinor,
    state.lastPushedQuantity,
  ])
    if (member !== null) safeInteger(member);
  nullableText(state.lastDesiredStateHash, 64);
  nullableText(state.lastPushedPriceCurrency, 3);
  if (state.lastDesiredIntent !== null) member(state.lastDesiredIntent, ["publish", "update", "delist"]);
  member(state.publishState, channelListingPublishStates);
  if (
    !Array.isArray(state.blockingReasonCodes) ||
    state.blockingReasonCodes.some((reason) => !channelPublicationBlockingReasons.includes(reason))
  )
    invalid("bound-violation");
  nullableText(state.failureReason, 512);
  nullableText(state.driftStatus, 128);
  safeInteger(state.lastStreamVersion);
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  exactKeys(result, keys);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("bound-violation");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid("unknown-key");
  if (keys.some((key) => !(key in value))) invalid("bound-violation");
}
function text(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && value.length === 0) || Array.from(value).length > max)
    invalid("bound-violation");
}
function nullableText(value: unknown, max: number): void {
  if (value !== null) text(value, max);
}
function safeInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid("bound-violation");
}
function member(value: unknown, members: readonly unknown[]): void {
  if (!members.includes(value)) invalid("bound-violation");
}
function stringArray(value: unknown, maxCount: number, maxLength: number): void {
  if (!Array.isArray(value) || value.length > maxCount) invalid("bound-violation");
  const seen = new Set<string>();
  for (const item of value) {
    text(item, maxLength);
    if (seen.has(item)) invalid("bound-violation");
    seen.add(item);
  }
}
function invalid(code: ChannelCompositionProgrammingError): never {
  throw new CompositionInputError(code);
}
