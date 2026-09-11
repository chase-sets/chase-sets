import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import contextManifest from "../../../context.json" with { type: "json" };

const contextRoot = path.resolve(import.meta.dirname, "../../..");

describe("channel-subscription-order-fence", () => {
  it("keeps five ordered projection subscriptions below all five reactions", () => {
    const subscriptions = contextManifest.eventSubscriptions;
    const reactions = contextManifest.eventReactions;
    expect(subscriptions.map((entry) => entry.sourceContextName)).toEqual([
      "marketplace",
      "catalog",
      "inventory",
      "channels",
      "channels",
    ]);
    expect(new Set(subscriptions.map((entry) => entry.sourceContextName)).size).toBe(4);
    expect(subscriptions.map((entry) => entry.order)).toEqual([10, 20, 30, 40, 50]);
    expect(Math.max(...subscriptions.map((entry) => entry.order))).toBeLessThan(
      Math.min(...reactions.map((entry) => entry.order)),
    );
    expect(reactions.map((entry) => entry.order)).toEqual([60, 61, 62, 63, 64]);
  });

  it("enumerates every producer event once and reacts only after the owning projection", () => {
    const subscriptions = contextManifest.eventSubscriptions;
    const reactions = contextManifest.eventReactions;
    expect(subscriptions.map((entry) => entry.eventTypes.length)).toEqual([9, 6, 8, 14, 2]);
    expect(reactions.map((entry) => entry.eventTypes.length)).toEqual([9, 6, 8, 11, 1]);
    expect(subscriptions.every((entry) => entry.subscriptionVersion === 1 && entry.filterToEventTypes)).toBe(true);
    expect(reactions.every((entry) => entry.subscriptionVersion === 1 && entry.filterToEventTypes)).toBe(true);
    for (let index = 0; index < 3; index += 1) {
      expect(reactions[index]!.eventTypes).toEqual(subscriptions[index]!.eventTypes);
    }
    const separatelyOwnedChannelListingEvents = [
      "channels.channel-listing.desired-state-changed",
      "channels.channel-listing.publication-blocked",
      "channels.channel-listing.publication-recorded",
    ];
    expect(reactions[3]!.eventTypes).toEqual(
      subscriptions[3]!.eventTypes.filter((eventType) => !separatelyOwnedChannelListingEvents.includes(eventType)),
    );
    expect(reactions[4]!.eventTypes).toEqual(["channels.channel-listing.desired-state-changed"]);
    expect(new Set(subscriptions.flatMap((entry) => entry.eventTypes)).size).toBe(39);
  });
});

describe("channel-listing-composition-draft-import", () => {
  it("imports the one real ChannelPublicationDraft declaration and no provider registry", () => {
    const contracts = source("features/listing-composition/domain/contracts.ts");
    const compose = source("features/listing-composition/domain/compose.ts");
    const root = source("index.ts");
    expect(contracts).toContain("ChannelPublicationDraft");
    expect(contracts).toContain('from "../../publication-port/domain/contracts"');
    expect(compose).toContain('from "../../publication-port/domain/contracts"');
    expect(`${contracts}\n${compose}`).not.toMatch(/ChannelProviderRegistry|ChannelProviderDescriptor/);
    expect(root.match(/type ChannelPublicationDraft/g)).toHaveLength(1);
  });
});

describe("channel-listing-composition-export-surface", () => {
  it("publishes the closed producer surface from one Channels root", () => {
    const root = source("index.ts");
    for (const symbol of [
      "deriveChannelSelectedOptionKey",
      "composeChannelListingPublication",
      "parseChannelListingCompositionInput",
    ])
      expect(root, symbol).toContain(symbol);
    const runtime = source("features/listing-composition/api/runtime.ts");
    for (const symbol of [
      "recordChannelListingDesiredState",
      "recordChannelListingPublicationOutcome",
      "readChannelListingProviderProductReferences",
      "readChannelMappingReviewQueue",
    ])
      expect(runtime, symbol).toContain(symbol);
    expect(root).not.toContain("@chase-sets/marketplace");
    expect(root).not.toContain("@chase-sets/catalog");
    expect(root).not.toContain("@chase-sets/inventory");
  });

  it("R12 rejects the fragmented eight-file entry-to-effect trace mutant", () => {
    const reaction = source("features/listing-composition/integrations/reactions.ts");
    const runtime = source("features/listing-composition/api/runtime.ts");
    const application = source("features/listing-composition/api/listing-publication-application.ts");
    expect(reaction).toContain("recordChannelListingDesiredState");
    expect(runtime).toContain("listingPublication.recordDesiredState");
    expect(runtime).not.toMatch(
      /readChannelListingCompositionFacts|parseChannelListingCompositionInput|composeChannelListingPublication|decideChannelListingComposition/,
    );
    for (const step of [
      "readChannelListingCompositionFacts",
      "parseChannelListingCompositionInput",
      "composeChannelListingPublication",
      "decideChannelListingComposition",
      "linkRepository.append",
    ]) {
      expect(application, step).toContain(step);
    }
    expect([reaction, runtime, application]).toHaveLength(3);
  });
});

describe("channel-listing-composition-scope-fence", () => {
  it("keeps provider calls, transport, retries and foreign writes outside the slice", () => {
    const files = [
      "features/listing-composition/domain/contracts.ts",
      "features/listing-composition/domain/compose.ts",
      "features/listing-composition/api/runtime.ts",
      "features/listing-composition/read-model/queries.ts",
    ]
      .map(source)
      .join("\n");
    expect(files).not.toMatch(/fetch\(|credential|publishListing\(|updatePriceQuantity\(|delistListing\(/);
    expect(files).not.toMatch(
      /INSERT INTO (?:marketplace|catalog|inventory)_|UPDATE (?:marketplace|catalog|inventory)_/,
    );
    expect(contextManifest.allowedContextDependencies).toEqual([]);
    expect(contextManifest.hostPorts).toEqual([]);
  });
});

function source(relativePath: string): string {
  return readFileSync(path.join(contextRoot, relativePath), "utf8");
}
