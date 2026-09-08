import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  channelMappingConfidenceTiers,
  channelMappingDimensions,
  channelMappingReviewStatuses,
  channelPublicationBlockingReasons,
  type ChannelListingEvent,
} from "./contracts";
import type { ChannelPublicationConfigurationEvent } from "./configuration";
import type { ChannelListingReconciliationEvent } from "./reconciliation";

export const channelPublicationConfigurationEventCodec: DomainEventCodec<ChannelPublicationConfigurationEvent> = {
  encode: (event) => ({ eventType: event.type, payload: event.data }),
  decode: (stored) => {
    const data = record(stored.payload);
    switch (stored.eventType) {
      case "channels.channel-publication-configuration.settings-replaced": {
        closed(data, ["connectionId", "settings"]);
        text(data.connectionId);
        settings(data.settings);
        return event(stored, data);
      }
      case "channels.channel-publication-configuration.mapping-candidate-recorded": {
        closed(data, ["connectionId", "provenance", "candidates"]);
        text(data.connectionId);
        member(data.provenance, ["compose-discovered", "export-discovered"]);
        if (!Array.isArray(data.candidates) || data.candidates.length > 500) invalid();
        for (const value of data.candidates) candidate(value);
        return event(stored, data);
      }
      case "channels.channel-publication-configuration.mapping-review-decided": {
        closed(data, [
          "connectionId",
          "dimension",
          "sourceKey",
          "targetKey",
          "confidenceTier",
          "reviewStatus",
          "evidence",
        ]);
        text(data.connectionId);
        member(data.dimension, channelMappingDimensions);
        text(data.sourceKey);
        nullableText(data.targetKey);
        member(data.confidenceTier, channelMappingConfidenceTiers);
        member(data.reviewStatus, channelMappingReviewStatuses);
        evidence(data.evidence);
        return event(stored, data);
      }
      default:
        return unsupported();
    }
  },
};

export const channelListingEventCodec: DomainEventCodec<ChannelListingEvent> = {
  encode: (event) => ({ eventType: event.type, payload: event.data }),
  decode: (stored) => {
    const data = record(stored.payload);
    switch (stored.eventType) {
      case "channels.channel-listing.desired-state-changed": {
        const intent = data.intent;
        if (intent === "delist") {
          closed(data, [
            "intent",
            "connectionId",
            "channelListingId",
            "listingId",
            "listingRevision",
            "desiredStateSequence",
            "desiredStateHash",
            "delist",
          ]);
          delist(data.delist);
        } else {
          member(intent, ["publish", "update"]);
          closed(data, [
            "intent",
            "connectionId",
            "channelListingId",
            "listingId",
            "listingRevision",
            "desiredStateSequence",
            "desiredStateHash",
            "draft",
          ]);
          draft(data.draft);
        }
        desiredIdentity(data);
        return event(stored, data);
      }
      case "channels.channel-listing.publication-blocked":
        closed(data, ["connectionId", "channelListingId", "listingId", "listingRevision", "reasons"]);
        text(data.connectionId);
        text(data.channelListingId);
        text(data.listingId);
        integer(data.listingRevision);
        reasons(data.reasons);
        return event(stored, data);
      case "channels.channel-listing.publication-recorded":
        closed(data, [
          "connectionId",
          "channelListingId",
          "operationId",
          "reportedDesiredStateSequence",
          "reportedListingRevision",
          "reportedDesiredStateHash",
          "outcome",
          "adoption",
        ]);
        text(data.connectionId);
        text(data.channelListingId);
        text(data.operationId);
        integer(data.reportedDesiredStateSequence);
        integer(data.reportedListingRevision);
        hash(data.reportedDesiredStateHash);
        outcome(data.outcome);
        member(data.adoption, ["none", "identity-adopted", "identity-and-state-applied"]);
        return event(stored, data);
      default:
        return unsupported();
    }
  },
};

export const channelListingReconciliationEventCodec: DomainEventCodec<ChannelListingReconciliationEvent> = {
  encode: (event) => ({ eventType: event.type, payload: event.data }),
  decode: (stored) => {
    const data = record(stored.payload);
    switch (stored.eventType) {
      case "channels.channel-listing-reconciliation.run-enqueued":
        closed(data, ["runId", "connectionId", "scope", "scopeKey"]);
        text(data.runId);
        text(data.connectionId);
        member(data.scope, ["connection", "account", "catalog-item", "inventory-item"]);
        text(data.scopeKey);
        return event(stored, data);
      case "channels.channel-listing-reconciliation.chunk-drained":
        closed(data, ["runId", "fromCursor", "toCursor", "processedCount", "remaining"]);
        text(data.runId);
        nullableText(data.fromCursor);
        nullableText(data.toCursor);
        integer(data.processedCount);
        if (typeof data.remaining !== "boolean") invalid();
        return event(stored, data);
      case "channels.channel-listing-reconciliation.run-settled": {
        closed(data, ["runId", "outcome"]);
        text(data.runId);
        const value = record(data.outcome);
        if (value.kind === "complete") {
          closed(value, ["kind", "processedCount"]);
          integer(value.processedCount);
        } else if (value.kind === "failed") {
          closed(value, ["kind", "code"]);
          text(value.code);
        } else invalid();
        return event(stored, data);
      }
      default:
        return unsupported();
    }
  },
};

function desiredIdentity(data: Record<string, unknown>): void {
  text(data.connectionId);
  text(data.channelListingId);
  text(data.listingId);
  integer(data.listingRevision);
  integer(data.desiredStateSequence);
  hash(data.desiredStateHash);
}
function draft(value: unknown): void {
  const data = record(value);
  closed(data, [
    "channelListingId",
    "listingRevision",
    "title",
    "description",
    "categoryKey",
    "conditionKey",
    "price",
    "quantity",
    "attributes",
  ]);
  text(data.channelListingId);
  integer(data.listingRevision);
  string(data.title);
  string(data.description);
  string(data.categoryKey);
  string(data.conditionKey);
  integer(data.quantity);
  const price = record(data.price);
  closed(price, ["amountMinor", "currency"]);
  integer(price.amountMinor);
  text(price.currency);
  if (!Array.isArray(data.attributes)) invalid();
  for (const value of data.attributes) {
    const attribute = record(value);
    closed(attribute, ["key", "value"]);
    text(attribute.key);
    string(attribute.value);
  }
}
function delist(value: unknown): void {
  const data = record(value);
  closed(data, ["channelListingId", "listingRevision", "lastPublishedPrice", "lastPublishedQuantity", "delistReasons"]);
  text(data.channelListingId);
  integer(data.listingRevision);
  integer(data.lastPublishedQuantity);
  reasons(data.delistReasons);
  const price = record(data.lastPublishedPrice);
  closed(price, ["amountMinor", "currency"]);
  integer(price.amountMinor);
  text(price.currency);
}
function outcome(value: unknown): void {
  const data = record(value);
  if (data.kind === "succeeded") {
    closedOptional(data, ["kind", "externalListingId"], ["externalOfferId", "providerRevision"]);
    text(data.externalListingId);
    nullableOptionalText(data.externalOfferId);
    nullableOptionalText(data.providerRevision);
  } else if (data.kind === "rejected") {
    closed(data, ["kind", "code"]);
    member(data.code, ["validation", "authorization", "rate-limited", "provider-unavailable", "conflict", "not-found"]);
  } else if (data.kind === "outcome-unknown") closed(data, ["kind"]);
  else invalid();
}
function settings(value: unknown): void {
  const data = record(value);
  closed(data, ["titlePrefix", "titleSuffix", "descriptionFooter", "categoryAllowlist", "excludedListingIds"]);
  string(data.titlePrefix);
  string(data.titleSuffix);
  string(data.descriptionFooter);
  stringArray(data.categoryAllowlist);
  stringArray(data.excludedListingIds);
}
function candidate(value: unknown): void {
  const data = record(value);
  closed(data, ["dimension", "sourceKey", "proposedTargetKey", "confidenceTier", "evidence"]);
  member(data.dimension, channelMappingDimensions);
  text(data.sourceKey);
  nullableText(data.proposedTargetKey);
  member(data.confidenceTier, channelMappingConfidenceTiers);
  evidence(data.evidence);
}
function evidence(value: unknown): void {
  const data = record(value);
  closed(data, ["listingId", "derivedFrom"]);
  text(data.listingId);
  text(data.derivedFrom);
}
function reasons(value: unknown): void {
  if (!Array.isArray(value) || value.some((reason) => !channelPublicationBlockingReasons.includes(reason))) invalid();
}
function event<T>(stored: Pick<StoredEvent, "eventType">, data: Record<string, unknown>): T {
  return { type: stored.eventType, data } as T;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  closedOptional(value, keys, []);
  if (keys.some((key) => !(key in value))) invalid();
}
function closedOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}
function string(value: unknown): asserts value is string {
  if (typeof value !== "string") invalid();
}
function text(value: unknown): asserts value is string {
  string(value);
  if (value.length === 0 || Array.from(value).length > 1_000) invalid();
}
function nullableText(value: unknown): void {
  if (value !== null) text(value);
}
function nullableOptionalText(value: unknown): void {
  if (value !== undefined) text(value);
}
function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
}
function hash(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
}
function member(value: unknown, members: readonly unknown[]): void {
  if (!members.includes(value)) invalid();
}
function stringArray(value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid();
}
function invalid(): never {
  throw new Error("Invalid closed Channels desired-state event.");
}
function unsupported(): never {
  throw new Error("Unsupported Channels desired-state event type.");
}
