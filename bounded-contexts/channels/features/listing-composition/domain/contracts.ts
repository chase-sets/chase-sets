import type { DomainEvent } from "@chase-sets/event-core";
import type { GradedCardSnapshot } from "@chase-sets/primitives/graded-card-snapshot";
import type {
  ChannelPublicationDraft,
  ChannelPublicationRejection,
  ChannelPublicationSuccess,
} from "../../publication-port/domain/contracts";
import type { ChannelConnectionStatus, ChannelEnvironment } from "../../connections/domain/contracts";

export const channelMappingDimensions = ["category", "condition", "attribute"] as const;
export type ChannelMappingDimension = (typeof channelMappingDimensions)[number];

export const channelMappingConfidenceTiers = ["manual", "high", "medium", "low"] as const;
export type ChannelMappingConfidenceTier = (typeof channelMappingConfidenceTiers)[number];

export const channelMappingReviewStatuses = ["proposed", "accepted", "auto-accepted", "rejected", "revoked"] as const;
export type ChannelMappingReviewStatus = (typeof channelMappingReviewStatuses)[number];

export type ChannelMappingResolution = Readonly<{
  dimension: ChannelMappingDimension;
  sourceKey: string;
  targetKey: string | null;
  confidenceTier: ChannelMappingConfidenceTier;
  reviewStatus: ChannelMappingReviewStatus;
}>;

export type ChannelPublicationSettings = Readonly<{
  titlePrefix: string;
  titleSuffix: string;
  descriptionFooter: string;
  categoryAllowlist: readonly string[];
  excludedListingIds: readonly string[];
}>;

export type ChannelCompositionProfileDerivation = Readonly<{
  sourceKind: string;
  sourceRef: string;
  sourceVersion: string;
  capturedAt: string;
}>;

export type ChannelTextCompositionDimension = Readonly<
  | { mode: "template"; maxLength: number; snapshotField: string }
  | { mode: "snapshot-preserved"; maxLength: number; snapshotField: string }
>;

export type ChannelKeyCompositionDimension = Readonly<
  | { mode: "mapped"; maxKeyLength: number; snapshotField: string }
  | { mode: "snapshot-preserved"; maxKeyLength: number; snapshotField: string }
>;

export type ChannelAttributeCompositionDimension = Readonly<
  | { mode: "mapped"; maxCount: number; maxKeyLength: number; maxValueLength: number; snapshotField: string }
  | {
      mode: "snapshot-preserved";
      maxCount: number;
      maxKeyLength: number;
      maxValueLength: number;
      snapshotField: string;
    }
>;

export type ChannelCompositionProfile = Readonly<{
  identity: Readonly<{ providerKey: string; environment: ChannelEnvironment }>;
  derivation: ChannelCompositionProfileDerivation;
  snapshotPreservedPlaceholder: string;
  requiresProviderProductReference: boolean;
  requiresProviderCatalogItemReference: boolean;
  conditionDimensionId: string | null;
  title: ChannelTextCompositionDimension;
  description: ChannelTextCompositionDimension;
  category: ChannelKeyCompositionDimension;
  condition: ChannelKeyCompositionDimension;
  attributes: ChannelAttributeCompositionDimension;
  quantity: Readonly<{ max: number; draftField: string }>;
  price: Readonly<{ maxAmountMinor: number; allowedCurrencies: readonly string[]; draftField: string }>;
  forbiddenPatterns: readonly string[];
}>;

export interface ChannelCompositionProfileRegistry {
  get(identity: Readonly<{ providerKey: string; environment: ChannelEnvironment }>): ChannelCompositionProfile | null;
  list(): readonly Readonly<{ providerKey: string; environment: ChannelEnvironment }>[];
}

export type ChannelReferenceResolution =
  | Readonly<{ kind: "linked"; providerKey: string; externalKey: string }>
  | Readonly<{ kind: "unlinked" }>
  | Readonly<{ kind: "ambiguous"; candidateCount: number }>;

export type ChannelOptionalText = Readonly<{ kind: "present"; value: string }> | Readonly<{ kind: "absent" }>;

export type ChannelListingIdentity = Readonly<{
  catalogItemId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  selectedOptionKey: string;
  categoryIds: readonly string[];
  itemTitle: ChannelOptionalText;
  itemSubtitle: ChannelOptionalText;
  productSummary: ChannelOptionalText;
  gradedCard: Readonly<{ kind: "present"; snapshot: GradedCardSnapshot }> | Readonly<{ kind: "absent" }>;
}>;

export type ChannelListingOffer = Readonly<{
  price: Readonly<{ kind: "present"; amount: string; currencyCode: string }> | Readonly<{ kind: "absent" }>;
  publishableQuantity: Readonly<{ kind: "resolved"; value: number }> | Readonly<{ kind: "unavailable" }>;
}>;

export const channelListingPublishStates = ["pending", "published", "delisted", "failed", "blocked"] as const;
export type ChannelListingPublishState = (typeof channelListingPublishStates)[number];

export type ChannelListingLinkState = Readonly<{
  connectionId: string;
  channelListingId: string;
  listingId: string;
  externalListingId: string | null;
  externalOfferId: string | null;
  providerRevision: string | null;
  lastDesiredStateSequence: number | null;
  lastDesiredListingRevision: number | null;
  lastDesiredStateHash: string | null;
  lastDesiredIntent: "publish" | "update" | "delist" | null;
  lastPushedListingRevision: number | null;
  lastPushedPriceAmountMinor: number | null;
  lastPushedPriceCurrency: string | null;
  lastPushedQuantity: number | null;
  publishState: ChannelListingPublishState;
  blockingReasonCodes: readonly ChannelPublicationBlockingReason[];
  failureReason: string | null;
  driftStatus: string | null;
  lastStreamVersion: number;
}>;

export type ChannelListingCompositionInput = Readonly<{
  connection: Readonly<{
    connectionId: string;
    accountId: string;
    providerKey: string;
    environment: ChannelEnvironment;
    connectionStatus: ChannelConnectionStatus;
    publicationScopeState: Readonly<{ kind: "not-applicable" | "current" | "stale" }>;
  }>;
  listing:
    | Readonly<{ kind: "facts-unavailable"; listingId: string }>
    | Readonly<{
        kind: "present";
        listingId: string;
        listingRevision: number;
        listingStatus: "draft" | "active" | "paused" | "withdrawn" | "auto-unlisted";
        sellerAvailabilityStatus: "available" | "unavailable";
        identity: ChannelListingIdentity;
        offer: ChannelListingOffer;
      }>;
  providerProductReference: ChannelReferenceResolution;
  providerCatalogItemReference: ChannelReferenceResolution;
  settings: Readonly<{ kind: "configured"; settings: ChannelPublicationSettings }> | Readonly<{ kind: "missing" }>;
  link: Readonly<{ kind: "existing"; state: ChannelListingLinkState }> | Readonly<{ kind: "none" }>;
  profile: Readonly<{ kind: "registered"; profile: ChannelCompositionProfile }> | Readonly<{ kind: "unregistered" }>;
  mappings: readonly ChannelMappingResolution[];
}>;

export const channelPublicationConfigurationBlockingReasons = [
  "publication-settings-missing",
  "provider-composition-profile-unregistered",
  "listing-facts-unavailable",
  "inventory-facts-unavailable",
  "provider-product-reference-unlinked",
  "provider-product-reference-ambiguous",
  "provider-catalog-item-reference-unlinked",
  "provider-catalog-item-reference-ambiguous",
] as const;

export const channelPublicationListingBlockingReasons = [
  "connection-not-active",
  "listing-not-active",
  "seller-unavailable",
  "sold-out",
  "listing-excluded",
  "category-not-allowed",
  "provider-scope-not-current",
  "category-unmapped",
  "category-ambiguous",
  "condition-unmapped",
  "condition-ambiguous",
  "attribute-unmapped",
  "missing-title",
  "title-too-long",
  "description-too-long",
  "forbidden-content",
  "missing-price",
  "price-out-of-range",
  "invalid-currency",
  "quantity-out-of-range",
  "category-key-out-of-bounds",
  "condition-key-out-of-bounds",
  "attribute-limit-exceeded",
] as const;

export const channelPublicationBlockingReasons = [
  ...channelPublicationConfigurationBlockingReasons,
  ...channelPublicationListingBlockingReasons,
] as const;
export type ChannelPublicationBlockingReason = (typeof channelPublicationBlockingReasons)[number];

export type ChannelListingDelistDirective = Readonly<{
  channelListingId: string;
  listingRevision: number;
  lastPublishedPrice: Readonly<{ amountMinor: number; currency: string }>;
  lastPublishedQuantity: number;
  delistReasons: readonly ChannelPublicationBlockingReason[];
}>;

export type ChannelListingCompositionResult =
  | Readonly<{
      kind: "publishable";
      intent: "publish" | "update";
      draft: ChannelPublicationDraft;
      desiredStateHash: string;
    }>
  | Readonly<{
      kind: "publishable";
      intent: "delist";
      delist: ChannelListingDelistDirective;
      desiredStateHash: string;
    }>
  | Readonly<{ kind: "blocked"; reasons: readonly ChannelPublicationBlockingReason[] }>;

export const channelCompositionProgrammingErrors = [
  "profile-identity-mismatch",
  "link-connection-mismatch",
  "mapping-duplicate-source-key",
  "unknown-key",
  "bound-violation",
] as const;
export type ChannelCompositionProgrammingError = (typeof channelCompositionProgrammingErrors)[number];

export type ParseChannelListingCompositionInputResult =
  | Readonly<{ kind: "valid"; input: ChannelListingCompositionInput }>
  | Readonly<{ kind: "invalid"; programmingError: ChannelCompositionProgrammingError }>;

type ChannelListingDesiredStateCommon = Readonly<{
  connectionId: string;
  channelListingId: string;
  listingId: string;
  listingRevision: number;
  desiredStateSequence: number;
  desiredStateHash: string;
}>;

export type ChannelListingDesiredStateChangedData =
  | (ChannelListingDesiredStateCommon & Readonly<{ intent: "publish" | "update"; draft: ChannelPublicationDraft }>)
  | (ChannelListingDesiredStateCommon & Readonly<{ intent: "delist"; delist: ChannelListingDelistDirective }>);

export type ChannelListingDesiredStateChangedEvent = DomainEvent<
  "channels.channel-listing.desired-state-changed",
  ChannelListingDesiredStateChangedData
>;
export type ChannelListingPublicationBlockedEvent = DomainEvent<
  "channels.channel-listing.publication-blocked",
  Readonly<{
    connectionId: string;
    channelListingId: string;
    listingId: string;
    listingRevision: number;
    reasons: readonly ChannelPublicationBlockingReason[];
  }>
>;

export type ChannelPublicationOutcome =
  | ChannelPublicationSuccess
  | ChannelPublicationRejection
  | Readonly<{ kind: "outcome-unknown" }>;
export type ChannelPublicationAdoption = "none" | "identity-adopted" | "identity-and-state-applied";

export type ChannelListingPublicationRecordedEvent = DomainEvent<
  "channels.channel-listing.publication-recorded",
  Readonly<{
    connectionId: string;
    channelListingId: string;
    operationId: string;
    reportedDesiredStateSequence: number;
    reportedListingRevision: number;
    reportedDesiredStateHash: string;
    outcome: ChannelPublicationOutcome;
    adoption: ChannelPublicationAdoption;
  }>
>;

export type ChannelListingEvent =
  | ChannelListingDesiredStateChangedEvent
  | ChannelListingPublicationBlockedEvent
  | ChannelListingPublicationRecordedEvent;

export type ChannelReferenceRead = Readonly<{
  channelListingId: string;
  catalogItemReference: ChannelReferenceResolution;
  productReference: ChannelReferenceResolution;
}>;

export type ChannelMappingReviewQueueItem = Readonly<{
  connectionId: string;
  dimension: ChannelMappingDimension;
  sourceKey: string;
  targetKey: string | null;
  confidenceTier: ChannelMappingConfidenceTier;
  reviewStatus: Exclude<ChannelMappingReviewStatus, "accepted" | "auto-accepted">;
  provenance: "compose-discovered" | "export-discovered" | "operator";
  evidence: Readonly<{ listingId: string; derivedFrom: string }>;
  lastStreamVersion: number;
}>;

export type ChannelMappingReviewPage = Readonly<{
  items: readonly ChannelMappingReviewQueueItem[];
  nextCursor: string | null;
  completeness: Readonly<{ kind: "complete"; total: number }> | Readonly<{ kind: "incomplete"; reason: string }>;
}>;

export type ChannelPublicationConnectionSummary = Readonly<{
  connectionId: string;
  providerKey: string;
  environment: ChannelEnvironment;
  connectionStatus: ChannelConnectionStatus;
  settingsState: "missing" | "configured";
  reviewCount: number;
}>;

export type ChannelPublicationConnectionDetail = Readonly<{
  connection: ChannelPublicationConnectionSummary;
  settings: ChannelPublicationSettings | null;
  mappingReview: ChannelMappingReviewPage;
  configurationStreamVersion: number;
}>;

export type ChannelCommandRefusal =
  | "unknown-mapping"
  | "already-decided"
  | "not-decided"
  | "not-proposed"
  | "not-accepted"
  | "already-revoked"
  | "target-required"
  | "stream-version-conflict"
  | "channel-listing-id-collision"
  | "unknown-link"
  | "desired-state-mismatch"
  | "operation-rebound"
  | "external-identity-conflict";

export type ChannelCommandResult<T = undefined> =
  | Readonly<{ kind: "applied"; value: T; streamVersion: number }>
  | Readonly<{ kind: "unchanged"; value: T; streamVersion: number }>
  | Readonly<{ kind: "refused"; code: ChannelCommandRefusal }>;
