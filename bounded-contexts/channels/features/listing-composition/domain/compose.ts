import { moneyToCents } from "@chase-sets/primitives/money";
import type { ChannelPublicationAttribute, ChannelPublicationDraft } from "../../publication-port/domain/contracts";
import { assertChannelPublicationDraft } from "../../publication-port/domain/validation";
import {
  buildChannelCategorySourceKeys,
  buildChannelConditionSourceKeys,
  buildChannelGradedAttributeSourceEntries,
  deriveChannelListingId,
  type ChannelListingIdDigest,
  findAcceptedChannelMapping,
  hashChannelDesiredState,
} from "./canonical";
import {
  channelPublicationConfigurationBlockingReasons,
  channelPublicationListingBlockingReasons,
  type ChannelCompositionProfile,
  type ChannelListingCompositionInput,
  type ChannelListingCompositionResult,
  type ChannelPublicationBlockingReason,
} from "./contracts";

export function composeChannelListingPublication(
  input: ChannelListingCompositionInput,
  listingIdDigest?: ChannelListingIdDigest,
): ChannelListingCompositionResult {
  const configurationReasons = collectConfigurationReasons(input);
  if (configurationReasons.length > 0) return { kind: "blocked", reasons: configurationReasons };
  if (input.listing.kind !== "present" || input.settings.kind !== "configured" || input.profile.kind !== "registered") {
    return { kind: "blocked", reasons: [] };
  }

  const { listing } = input;
  const profile = input.profile.profile;
  const settings = input.settings.settings;
  const listingReasons: ChannelPublicationBlockingReason[] = [];
  if (input.connection.connectionStatus !== "active") listingReasons.push("connection-not-active");
  if (listing.listingStatus !== "active") listingReasons.push("listing-not-active");
  if (listing.sellerAvailabilityStatus !== "available") listingReasons.push("seller-unavailable");
  if (listing.offer.publishableQuantity.kind === "resolved" && listing.offer.publishableQuantity.value === 0) {
    listingReasons.push("sold-out");
  }
  if (settings.excludedListingIds.includes(listing.listingId)) listingReasons.push("listing-excluded");
  if (listing.identity.categoryIds.some((categoryId) => !settings.categoryAllowlist.includes(categoryId))) {
    listingReasons.push("category-not-allowed");
  }
  if (input.connection.publicationScopeState.kind === "stale") listingReasons.push("provider-scope-not-current");

  const title = composeTextDimension(profile, "title", listing.identity.itemTitle, settings);
  if (title.reason) listingReasons.push(title.reason);
  const description = composeTextDimension(profile, "description", listing.identity.productSummary, settings);
  if (description.reason) listingReasons.push(description.reason);

  const category = composeCategory(listing, input.mappings, profile);
  if (category.reason) listingReasons.push(category.reason);
  const condition = composeCondition(listing, input.mappings, profile);
  if (condition.reason) listingReasons.push(condition.reason);
  const attributes = composeAttributes(listing, input.mappings, profile);
  if (attributes.reason) listingReasons.push(attributes.reason);

  let price: Readonly<{ amountMinor: number; currency: string }> | null = null;
  if (listing.offer.price.kind === "absent") listingReasons.push("missing-price");
  else {
    const amountMinor = Number(moneyToCents(listing.offer.price.amount));
    if (amountMinor > profile.price.maxAmountMinor) listingReasons.push("price-out-of-range");
    if (!profile.price.allowedCurrencies.includes(listing.offer.price.currencyCode))
      listingReasons.push("invalid-currency");
    price = { amountMinor, currency: listing.offer.price.currencyCode };
  }

  let quantity: number | null = null;
  if (listing.offer.publishableQuantity.kind === "resolved") {
    quantity = listing.offer.publishableQuantity.value;
    if (quantity > profile.quantity.max) listingReasons.push("quantity-out-of-range");
  }

  if (title.value !== null && containsForbiddenContent(title.value, profile)) listingReasons.push("forbidden-content");
  if (description.value !== null && containsForbiddenContent(description.value, profile)) {
    listingReasons.push("forbidden-content");
  }

  const reasons = orderReasons(listingReasons, channelPublicationListingBlockingReasons);
  if (reasons.length > 0) {
    const link = input.link.kind === "existing" ? input.link.state : null;
    if (
      link &&
      link.externalListingId !== null &&
      link.publishState !== "delisted" &&
      link.lastPushedPriceAmountMinor !== null &&
      link.lastPushedPriceCurrency !== null &&
      link.lastPushedQuantity !== null
    ) {
      const delist = {
        channelListingId: link.channelListingId,
        listingRevision: listing.listingRevision,
        lastPublishedPrice: {
          amountMinor: link.lastPushedPriceAmountMinor,
          currency: link.lastPushedPriceCurrency,
        },
        lastPublishedQuantity: link.lastPushedQuantity,
        delistReasons: reasons,
      } as const;
      return {
        kind: "publishable",
        intent: "delist",
        delist,
        desiredStateHash: hashChannelDesiredState({ intent: "delist", delist }),
      };
    }
    return { kind: "blocked", reasons };
  }

  if (
    title.value === null ||
    description.value === null ||
    category.value === null ||
    condition.value === null ||
    attributes.value === null ||
    price === null ||
    quantity === null
  ) {
    return { kind: "blocked", reasons: [] };
  }
  const channelListingId =
    input.link.kind === "existing"
      ? input.link.state.channelListingId
      : deriveChannelListingId(input.connection.connectionId, listing.listingId, listingIdDigest);
  const draft: ChannelPublicationDraft = {
    channelListingId,
    listingRevision: listing.listingRevision,
    title: title.value,
    description: description.value,
    categoryKey: category.value,
    conditionKey: condition.value,
    price,
    quantity,
    attributes: attributes.value,
  };
  assertChannelPublicationDraft(draft, "composed Channel Publication Draft");
  const intent = input.link.kind === "existing" && input.link.state.externalListingId !== null ? "update" : "publish";
  return {
    kind: "publishable",
    intent,
    draft,
    desiredStateHash: hashChannelDesiredState({ intent, draft }),
  };
}

function collectConfigurationReasons(
  input: ChannelListingCompositionInput,
): readonly ChannelPublicationBlockingReason[] {
  const reasons: ChannelPublicationBlockingReason[] = [];
  if (input.settings.kind === "missing") reasons.push("publication-settings-missing");
  if (input.profile.kind === "unregistered") reasons.push("provider-composition-profile-unregistered");
  if (input.listing.kind === "facts-unavailable") reasons.push("listing-facts-unavailable");
  if (input.listing.kind === "present" && input.listing.offer.publishableQuantity.kind === "unavailable") {
    reasons.push("inventory-facts-unavailable");
  }
  if (input.profile.kind === "registered" && input.profile.profile.requiresProviderProductReference) {
    if (input.providerProductReference.kind === "unlinked") reasons.push("provider-product-reference-unlinked");
    if (input.providerProductReference.kind === "ambiguous") reasons.push("provider-product-reference-ambiguous");
  }
  if (input.profile.kind === "registered" && input.profile.profile.requiresProviderCatalogItemReference) {
    if (input.providerCatalogItemReference.kind === "unlinked")
      reasons.push("provider-catalog-item-reference-unlinked");
    if (input.providerCatalogItemReference.kind === "ambiguous")
      reasons.push("provider-catalog-item-reference-ambiguous");
  }
  return orderReasons(reasons, channelPublicationConfigurationBlockingReasons);
}

function composeTextDimension(
  profile: ChannelCompositionProfile,
  dimension: "title" | "description",
  source: Readonly<{ kind: "present"; value: string }> | Readonly<{ kind: "absent" }>,
  settings: Readonly<{ titlePrefix: string; titleSuffix: string; descriptionFooter: string }>,
): Readonly<{ value: string | null; reason: ChannelPublicationBlockingReason | null }> {
  const declaration = profile[dimension];
  switch (declaration.mode) {
    case "snapshot-preserved":
      return { value: profile.snapshotPreservedPlaceholder, reason: null };
    case "template": {
      if (dimension === "title" && source.kind === "absent") return { value: null, reason: "missing-title" };
      const sourceValue = source.kind === "present" ? source.value : "";
      const value =
        dimension === "title"
          ? `${settings.titlePrefix}${sourceValue}${settings.titleSuffix}`
          : `${sourceValue}${settings.descriptionFooter}`;
      if (scalarLength(value) > declaration.maxLength) {
        return { value: null, reason: dimension === "title" ? "title-too-long" : "description-too-long" };
      }
      return { value, reason: null };
    }
    default:
      return { value: null, reason: dimension === "title" ? "missing-title" : "description-too-long" };
  }
}

function composeCategory(
  listing: Extract<ChannelListingCompositionInput["listing"], { kind: "present" }>,
  mappings: ChannelListingCompositionInput["mappings"],
  profile: ChannelCompositionProfile,
): Readonly<{ value: string | null; reason: ChannelPublicationBlockingReason | null }> {
  switch (profile.category.mode) {
    case "snapshot-preserved":
      return boundKey(
        profile.snapshotPreservedPlaceholder,
        profile.category.maxKeyLength,
        "category-key-out-of-bounds",
      );
    case "mapped": {
      const sourceKeys = buildChannelCategorySourceKeys(listing.identity.categoryIds);
      if (sourceKeys.length === 0) return { value: null, reason: "category-unmapped" };
      const targets = sourceKeys.map(
        (sourceKey) => findAcceptedChannelMapping(mappings, "category", sourceKey)?.targetKey ?? null,
      );
      if (targets.some((target) => target === null)) return { value: null, reason: "category-unmapped" };
      const distinct = [...new Set(targets as string[])];
      if (distinct.length !== 1) return { value: null, reason: "category-ambiguous" };
      return boundKey(distinct[0]!, profile.category.maxKeyLength, "category-key-out-of-bounds");
    }
    default:
      return { value: null, reason: "category-unmapped" };
  }
}

function composeCondition(
  listing: Extract<ChannelListingCompositionInput["listing"], { kind: "present" }>,
  mappings: ChannelListingCompositionInput["mappings"],
  profile: ChannelCompositionProfile,
): Readonly<{ value: string | null; reason: ChannelPublicationBlockingReason | null }> {
  switch (profile.condition.mode) {
    case "snapshot-preserved":
      return boundKey(
        profile.snapshotPreservedPlaceholder,
        profile.condition.maxKeyLength,
        "condition-key-out-of-bounds",
      );
    case "mapped": {
      const gradedCard = listing.identity.gradedCard.kind === "present" ? listing.identity.gradedCard.snapshot : null;
      const keys = buildChannelConditionSourceKeys(
        listing.identity.selectedOptions,
        gradedCard,
        profile.conditionDimensionId,
      );
      if (keys.length !== 1) return { value: null, reason: "condition-ambiguous" };
      const target = findAcceptedChannelMapping(mappings, "condition", keys[0]!)?.targetKey ?? null;
      if (target === null) return { value: null, reason: "condition-unmapped" };
      return boundKey(target, profile.condition.maxKeyLength, "condition-key-out-of-bounds");
    }
    default:
      return { value: null, reason: "condition-unmapped" };
  }
}

function composeAttributes(
  listing: Extract<ChannelListingCompositionInput["listing"], { kind: "present" }>,
  mappings: ChannelListingCompositionInput["mappings"],
  profile: ChannelCompositionProfile,
): Readonly<{ value: readonly ChannelPublicationAttribute[] | null; reason: ChannelPublicationBlockingReason | null }> {
  switch (profile.attributes.mode) {
    case "snapshot-preserved":
      return { value: [], reason: null };
    case "mapped": {
      const gradedCard = listing.identity.gradedCard.kind === "present" ? listing.identity.gradedCard.snapshot : null;
      const sourceEntries = buildChannelGradedAttributeSourceEntries(gradedCard);
      const attributes: ChannelPublicationAttribute[] = [];
      for (const entry of sourceEntries) {
        const target = findAcceptedChannelMapping(mappings, "attribute", entry.sourceKey)?.targetKey ?? null;
        if (target === null) return { value: null, reason: "attribute-unmapped" };
        if (
          scalarLength(target) > profile.attributes.maxKeyLength ||
          scalarLength(entry.value) > profile.attributes.maxValueLength
        ) {
          return { value: null, reason: "attribute-limit-exceeded" };
        }
        attributes.push({ key: target, value: entry.value });
      }
      if (
        attributes.length > profile.attributes.maxCount ||
        new Set(attributes.map(({ key }) => key)).size !== attributes.length
      ) {
        return { value: null, reason: "attribute-limit-exceeded" };
      }
      return { value: attributes, reason: null };
    }
    default:
      return { value: null, reason: "attribute-unmapped" };
  }
}

function boundKey(
  value: string,
  maxLength: number,
  reason: "category-key-out-of-bounds" | "condition-key-out-of-bounds",
): Readonly<{ value: string | null; reason: ChannelPublicationBlockingReason | null }> {
  return scalarLength(value) <= maxLength ? { value, reason: null } : { value: null, reason };
}

function containsForbiddenContent(value: string, profile: ChannelCompositionProfile): boolean {
  return profile.forbiddenPatterns.some((pattern) => new RegExp(pattern, "u").test(value));
}

function orderReasons(
  reasons: readonly ChannelPublicationBlockingReason[],
  order: readonly ChannelPublicationBlockingReason[],
): readonly ChannelPublicationBlockingReason[] {
  const present = new Set(reasons);
  return order.filter((reason) => present.has(reason));
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}
