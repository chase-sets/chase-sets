import { describe, expect, it, vi } from "vitest";
import { MONEY_AMOUNT_MAX } from "@chase-sets/primitives/money";
import {
  assertChannelCompositionProfile,
  buildChannelCategorySourceKeys,
  buildChannelConditionSourceKeys,
  buildChannelGradedAttributeSourceEntries,
  channelCompositionProfileRegistry,
  createChannelCompositionProfileRegistry,
} from "../domain/canonical";
import { composeChannelListingPublication } from "../domain/compose";
import {
  channelCompositionProgrammingErrors,
  channelPublicationBlockingReasons,
  type ChannelCompositionProfile,
  type ChannelListingCompositionInput,
  type ChannelListingCompositionResult,
  type ChannelPublicationBlockingReason,
} from "../domain/contracts";
import { parseChannelListingCompositionInput } from "../domain/parse";
import { listingInput, publishedLink, syntheticProfile } from "./test-support";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

type BlockedCompositionResult = Extract<ChannelListingCompositionResult, { kind: "blocked" }>;
type DelistCompositionResult = Extract<ChannelListingCompositionResult, { intent: "delist" }>;

// @ts-expect-error A blocked result cannot leak a provider-ready draft.
const blockedWithDraft: BlockedCompositionResult = { kind: "blocked", reasons: [], draft: null };
const delistWithDraft: DelistCompositionResult = {
  kind: "publishable",
  intent: "delist",
  delist: {
    channelListingId: "channel-listing",
    listingRevision: 1,
    lastPublishedPrice: { amountMinor: 1, currency: "USD" },
    lastPublishedQuantity: 1,
    delistReasons: ["listing-not-active"],
  },
  desiredStateHash: "hash",
  // @ts-expect-error A delist directive carries the last pushed values, never a new draft.
  draft: null,
};

void blockedWithDraft;
void delistWithDraft;

describe("channel-listing-composition-input-parse", () => {
  it("rejects every programming error before the composer can run", () => {
    const candidates: readonly unknown[] = [
      mutateInput((input) => {
        if (input.profile.kind !== "registered") throw new Error("expected registered profile");
        input.profile.profile.identity.providerKey = "other-provider";
      }),
      mutateInput((input) => {
        input.link = { kind: "existing", state: mutable(publishedLink({ connectionId: "other-connection" })) };
      }),
      mutateInput((input) => {
        input.mappings.push(structuredClone(input.mappings[0]!));
      }),
      Object.assign(
        mutateInput(() => undefined),
        { unexpected: true },
      ),
      mutateInput((input) => {
        if (input.listing.kind !== "present") throw new Error("expected listing facts");
        input.listing.listingRevision = Number.MAX_SAFE_INTEGER + 1;
      }),
    ];
    const guardedComposer = vi.fn(composeChannelListingPublication);
    const observed = candidates.map((candidate) => {
      const parsed = parseChannelListingCompositionInput(candidate);
      if (parsed.kind === "valid") guardedComposer(parsed.input);
      return parsed.kind === "invalid" ? parsed.programmingError : null;
    });
    expect(observed).toEqual(channelCompositionProgrammingErrors);
    expect(guardedComposer).not.toHaveBeenCalled();
    expect(channelPublicationBlockingReasons).not.toEqual(
      expect.arrayContaining([...channelCompositionProgrammingErrors]),
    );
  });

  it("rejects family collapse, nested unknown keys, date-only instants and out-of-range numbers", () => {
    const familyCollapse = mutateInput((input) => {
      input.providerProductReference = null as never;
    });
    const nestedUnknown = mutateInput((input) => {
      Object.assign(input.connection.publicationScopeState, { unexpected: true });
    });
    const dateOnly = mutateInput((input) => {
      if (input.profile.kind !== "registered") throw new Error("expected registered profile");
      input.profile.profile.derivation.capturedAt = "2026-09-08";
    });
    const outOfRange = mutateInput((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.offer.publishableQuantity = { kind: "resolved", value: -1 };
    });
    expect(parseChannelListingCompositionInput(familyCollapse)).toEqual({
      kind: "invalid",
      programmingError: "bound-violation",
    });
    expect(parseChannelListingCompositionInput(nestedUnknown)).toEqual({
      kind: "invalid",
      programmingError: "unknown-key",
    });
    expect(parseChannelListingCompositionInput(dateOnly)).toEqual({
      kind: "invalid",
      programmingError: "bound-violation",
    });
    expect(parseChannelListingCompositionInput(outOfRange)).toEqual({
      kind: "invalid",
      programmingError: "bound-violation",
    });
  });
});

describe("channel-composition-profile-registry", () => {
  it("is production-empty in both environments and isolates one synthetic registration", () => {
    expect(channelCompositionProfileRegistry.list()).toEqual([]);
    expect(
      channelCompositionProfileRegistry.get({ providerKey: "synthetic-provider", environment: "sandbox" }),
    ).toBeNull();
    expect(
      channelCompositionProfileRegistry.get({ providerKey: "synthetic-provider", environment: "production" }),
    ).toBeNull();
    const registry = createChannelCompositionProfileRegistry([syntheticProfile]);
    expect(registry.list()).toEqual([syntheticProfile.identity]);
    expect(registry.get(syntheticProfile.identity)).toEqual(syntheticProfile);
    expect(registry.get({ ...syntheticProfile.identity, environment: "production" })).toBeNull();
  });

  it("rejects every ruled invalid profile arm and an enable-all/default-shaped object", () => {
    const invalidProfiles: readonly unknown[] = [
      omitProfileMember("derivation"),
      mutateProfile((profile) => {
        delete (profile.title as Partial<typeof profile.title>).mode;
      }),
      mutateProfile((profile) => {
        profile.description.mode = "invented" as never;
      }),
      mutateProfile((profile) => {
        profile.conditionDimensionId = null;
      }),
      mutateProfile((profile) => {
        profile.category.mode = "snapshot-preserved";
        delete (profile.category as Partial<typeof profile.category>).snapshotField;
      }),
      mutateProfile((profile) => {
        profile.snapshotPreservedPlaceholder = "provider-default";
      }),
      { identity: syntheticProfile.identity, enableAll: true },
    ];
    for (const profile of invalidProfiles) expect(() => assertChannelCompositionProfile(profile)).toThrow();
  });
});

describe("channel-composition-dimension-modes", () => {
  it("never touches mappings when every mapped dimension is snapshot-preserved", () => {
    const input = mutateInput((candidate) => {
      if (candidate.profile.kind !== "registered") throw new Error("expected profile");
      candidate.profile.profile.category = {
        mode: "snapshot-preserved",
        maxKeyLength: 100,
        snapshotField: "category",
      };
      candidate.profile.profile.condition = {
        mode: "snapshot-preserved",
        maxKeyLength: 100,
        snapshotField: "condition",
      };
      candidate.profile.profile.attributes = {
        mode: "snapshot-preserved",
        maxCount: 20,
        maxKeyLength: 100,
        maxValueLength: 500,
        snapshotField: "attributes",
      };
      candidate.mappings = new Proxy([], {
        get() {
          throw new Error("snapshot-preserved mapping access");
        },
      });
    });
    expect(() => composeChannelListingPublication(input)).not.toThrow();
    expectPublishable(composeChannelListingPublication(input), {
      categoryKey: syntheticProfile.snapshotPreservedPlaceholder,
      conditionKey: syntheticProfile.snapshotPreservedPlaceholder,
      attributes: [],
    });
  });

  it.each(["proposed", "rejected", "revoked"] as const)("fails closed for a %s mapping", (reviewStatus) => {
    expectReason(
      composeWith((input) => {
        const mapping = input.mappings.find((candidate) => candidate.dimension === "category");
        if (!mapping) throw new Error("expected category mapping");
        mapping.reviewStatus = reviewStatus;
      }),
      "category-unmapped",
    );
  });

  it.each(["accepted", "auto-accepted"] as const)("publishes through a %s mapping", (reviewStatus) => {
    expectPublishable(
      composeWith((input) => {
        const mapping = input.mappings.find((candidate) => candidate.dimension === "category");
        if (!mapping) throw new Error("expected category mapping");
        mapping.reviewStatus = reviewStatus;
      }),
    );
  });
});

describe("channel-listing-source-key-derivation", () => {
  it("exhausts selected/graded condition arms, category absence, and nullable graded members", () => {
    const graded = {
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: null,
      population: null,
      conditionDescriptors: [],
    };
    expect(buildChannelConditionSourceKeys([], graded, "condition")).toEqual(["graded-condition:PSA|10"]);
    expect(
      buildChannelConditionSourceKeys([{ dimensionId: "condition", optionId: "near-mint" }], null, "condition"),
    ).toEqual(["selected-option:condition:near-mint"]);
    expect(
      buildChannelConditionSourceKeys([{ dimensionId: "condition", optionId: "near-mint" }], graded, "condition"),
    ).toHaveLength(2);
    expect(buildChannelConditionSourceKeys([], null, "condition")).toEqual([]);
    expect(buildChannelCategorySourceKeys([])).toEqual([]);
    expect(buildChannelGradedAttributeSourceEntries(graded).map((entry) => entry.sourceKey)).toEqual([
      "graded:grading-company",
      "graded:grade",
    ]);
    expect(
      buildChannelGradedAttributeSourceEntries({
        ...graded,
        certificationNumber: "cert",
        population: {
          populationAtGrade: 2,
          populationHigher: 1,
          source: "population-source",
          asOf: "2026-09-08",
        },
        conditionDescriptors: ["first", "second"],
      }).map((entry) => entry.sourceKey),
    ).toEqual([
      "graded:grading-company",
      "graded:grade",
      "graded:certification-number",
      "graded:population-at-grade",
      "graded:population-higher",
      "graded:population-source",
      "graded:population-as-of",
      "graded:condition-descriptor:0",
      "graded:condition-descriptor:1",
    ]);
  });
});

describe("channel-listing-composition-draft-fields", () => {
  it("accepts each scalar field at its declared bound and rejects the next scalar", () => {
    expectPublishable(
      composeWith((input) => {
        const { listing, profile } = presentRegistered(input);
        profile.title.maxLength = 3;
        listing.identity.itemTitle = { kind: "present", value: "😀ab" };
      }),
      { title: "😀ab" },
    );
    expectReason(
      composeWith((input) => {
        const { listing, profile } = presentRegistered(input);
        profile.title.maxLength = 3;
        listing.identity.itemTitle = { kind: "present", value: "😀abc" };
      }),
      "title-too-long",
    );

    expectPublishable(
      composeWith((input) => {
        const { listing, profile } = presentRegistered(input);
        profile.description.maxLength = 3;
        listing.identity.productSummary = { kind: "present", value: "😀ab" };
      }),
      { description: "😀ab" },
    );
    expectReason(
      composeWith((input) => {
        const { listing, profile } = presentRegistered(input);
        profile.description.maxLength = 3;
        listing.identity.productSummary = { kind: "present", value: "😀abc" };
      }),
      "description-too-long",
    );

    for (const [dimension, reason] of [
      ["category", "category-key-out-of-bounds"],
      ["condition", "condition-key-out-of-bounds"],
    ] as const) {
      expectPublishable(
        composeWith((input) => {
          const { profile } = presentRegistered(input);
          profile[dimension].maxKeyLength = dimension === "category" ? 13 : 9;
        }),
      );
      expectReason(
        composeWith((input) => {
          const { profile } = presentRegistered(input);
          profile[dimension].maxKeyLength = dimension === "category" ? 12 : 8;
        }),
        reason,
      );
    }

    expectPublishable(
      composeWith((input) => {
        const { listing, profile } = presentRegistered(input);
        profile.quantity.max = 3;
        listing.offer.publishableQuantity = { kind: "resolved", value: 3 };
      }),
      { quantity: 3 },
    );
    expectReason(
      composeWith((input) => {
        const { listing, profile } = presentRegistered(input);
        profile.quantity.max = 3;
        listing.offer.publishableQuantity = { kind: "resolved", value: 4 };
      }),
      "quantity-out-of-range",
    );
    expectPublishable(
      composeWith((input) => {
        const { listing, profile } = presentRegistered(input);
        listing.offer.price = { kind: "present", amount: MONEY_AMOUNT_MAX, currencyCode: "USD" };
        profile.price.maxAmountMinor = 999_999_999_999;
      }),
      { price: { amountMinor: 999_999_999_999, currency: "USD" } },
    );
    expectReason(
      composeWith((input) => {
        const { profile } = presentRegistered(input);
        profile.price.maxAmountMinor = 1_999;
      }),
      "price-out-of-range",
    );
  });

  it("accepts attribute count/key/value bounds and preserves derived order, case and spelling", () => {
    const exact = composeWith((input) =>
      configureMappedAttributes(input, { maxCount: 2, maxKeyLength: 5, maxValueLength: 3 }),
    );
    expectPublishable(exact, {
      attributes: [
        { key: "Z-Key", value: "PSA" },
        { key: "a-key", value: "10" },
      ],
    });
    for (const [mutate, reason] of [
      [
        (input: Mutable<ChannelListingCompositionInput>) =>
          configureMappedAttributes(input, { maxCount: 1, maxKeyLength: 5, maxValueLength: 3 }),
        "attribute-limit-exceeded",
      ],
      [
        (input: Mutable<ChannelListingCompositionInput>) =>
          configureMappedAttributes(input, { maxCount: 2, maxKeyLength: 4, maxValueLength: 3 }),
        "attribute-limit-exceeded",
      ],
      [
        (input: Mutable<ChannelListingCompositionInput>) =>
          configureMappedAttributes(input, { maxCount: 2, maxKeyLength: 5, maxValueLength: 2 }),
        "attribute-limit-exceeded",
      ],
    ] as const) {
      expectReason(composeWith(mutate), reason);
    }
  });
});

describe("channel-listing-blocking-reason-matrix", () => {
  it("produces every declared reason in isolation from a parsed-valid input", () => {
    const cases = reasonCases();
    expect(Object.keys(cases)).toEqual(channelPublicationBlockingReasons);
    for (const reason of channelPublicationBlockingReasons) {
      const input = cases[reason]();
      expect(parseChannelListingCompositionInput(input), reason).toMatchObject({ kind: "valid" });
      expect(composeChannelListingPublication(input), reason).toEqual({ kind: "blocked", reasons: [reason] });
    }
  });
});

function reasonCases(): Record<ChannelPublicationBlockingReason, () => ChannelListingCompositionInput> {
  const mutate = (change: (input: Mutable<ChannelListingCompositionInput>) => void) => () => mutateInput(change);
  return {
    "publication-settings-missing": mutate((input) => {
      input.settings = { kind: "missing" };
    }),
    "provider-composition-profile-unregistered": mutate((input) => {
      input.profile = { kind: "unregistered" };
    }),
    "listing-facts-unavailable": mutate((input) => {
      input.listing = { kind: "facts-unavailable", listingId: "listing-synthetic" };
    }),
    "inventory-facts-unavailable": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.offer.publishableQuantity = { kind: "unavailable" };
    }),
    "provider-product-reference-unlinked": mutate((input) => {
      input.providerProductReference = { kind: "unlinked" };
    }),
    "provider-product-reference-ambiguous": mutate((input) => {
      input.providerProductReference = { kind: "ambiguous", candidateCount: 2 };
    }),
    "provider-catalog-item-reference-unlinked": mutate((input) => {
      input.providerCatalogItemReference = { kind: "unlinked" };
    }),
    "provider-catalog-item-reference-ambiguous": mutate((input) => {
      input.providerCatalogItemReference = { kind: "ambiguous", candidateCount: 2 };
    }),
    "connection-not-active": mutate((input) => {
      input.connection.connectionStatus = "paused";
    }),
    "listing-not-active": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.listingStatus = "draft";
    }),
    "seller-unavailable": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.sellerAvailabilityStatus = "unavailable";
    }),
    "sold-out": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.offer.publishableQuantity = { kind: "resolved", value: 0 };
    }),
    "listing-excluded": mutate((input) => {
      if (input.settings.kind !== "configured") throw new Error("expected settings");
      input.settings.settings.excludedListingIds = ["listing-synthetic"];
    }),
    "category-not-allowed": mutate((input) => {
      if (input.settings.kind !== "configured") throw new Error("expected settings");
      input.settings.settings.categoryAllowlist = [];
    }),
    "provider-scope-not-current": mutate((input) => {
      input.connection.publicationScopeState = { kind: "stale" };
    }),
    "category-unmapped": mutate((input) => {
      input.mappings = input.mappings.filter((mapping) => mapping.dimension !== "category");
    }),
    "category-ambiguous": mutate((input) => {
      if (input.listing.kind !== "present" || input.settings.kind !== "configured")
        throw new Error("expected facts and settings");
      input.listing.identity.categoryIds = ["cards", "other"];
      input.settings.settings.categoryAllowlist = ["cards", "other"];
      input.mappings.push({
        dimension: "category",
        sourceKey: "catalog-category:other",
        targetKey: "other-target",
        confidenceTier: "manual",
        reviewStatus: "accepted",
      });
    }),
    "condition-unmapped": mutate((input) => {
      input.mappings = input.mappings.filter((mapping) => mapping.dimension !== "condition");
    }),
    "condition-ambiguous": mutate((input) => {
      if (input.profile.kind !== "registered") throw new Error("expected profile");
      input.profile.profile.conditionDimensionId = "missing-dimension";
    }),
    "attribute-unmapped": mutate((input) => configureMappedAttributes(input, { omitMappings: true })),
    "missing-title": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.identity.itemTitle = { kind: "absent" };
    }),
    "title-too-long": mutate((input) => {
      const { profile } = presentRegistered(input);
      profile.title.maxLength = 1;
    }),
    "description-too-long": mutate((input) => {
      const { profile } = presentRegistered(input);
      profile.description.maxLength = 1;
    }),
    "forbidden-content": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.identity.itemTitle = { kind: "present", value: "forbidden" };
    }),
    "missing-price": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.offer.price = { kind: "absent" };
    }),
    "price-out-of-range": mutate((input) => {
      const { profile } = presentRegistered(input);
      profile.price.maxAmountMinor = 1_999;
    }),
    "invalid-currency": mutate((input) => {
      if (input.listing.kind !== "present") throw new Error("expected listing facts");
      input.listing.offer.price = { kind: "present", amount: "20.00", currencyCode: "GBP" };
    }),
    "quantity-out-of-range": mutate((input) => {
      const { listing, profile } = presentRegistered(input);
      profile.quantity.max = 2;
      listing.offer.publishableQuantity = { kind: "resolved", value: 3 };
    }),
    "category-key-out-of-bounds": mutate((input) => {
      const { profile } = presentRegistered(input);
      profile.category.maxKeyLength = 1;
    }),
    "condition-key-out-of-bounds": mutate((input) => {
      const { profile } = presentRegistered(input);
      profile.condition.maxKeyLength = 1;
    }),
    "attribute-limit-exceeded": mutate((input) =>
      configureMappedAttributes(input, { maxCount: 1, maxKeyLength: 5, maxValueLength: 3 }),
    ),
  };
}

function configureMappedAttributes(
  input: Mutable<ChannelListingCompositionInput>,
  bounds: Readonly<{
    maxCount?: number;
    maxKeyLength?: number;
    maxValueLength?: number;
    omitMappings?: boolean;
  }> = {},
): void {
  const { listing, profile } = presentRegistered(input);
  profile.condition = { mode: "snapshot-preserved", maxKeyLength: 100, snapshotField: "condition" };
  profile.attributes = {
    mode: "mapped",
    maxCount: bounds.maxCount ?? 2,
    maxKeyLength: bounds.maxKeyLength ?? 5,
    maxValueLength: bounds.maxValueLength ?? 3,
    snapshotField: "attributes",
  };
  listing.identity.gradedCard = {
    kind: "present",
    snapshot: {
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: null,
      population: null,
      conditionDescriptors: [],
    },
  };
  if (!bounds.omitMappings) {
    input.mappings.push(
      {
        dimension: "attribute",
        sourceKey: "graded:grade",
        targetKey: "a-key",
        confidenceTier: "manual",
        reviewStatus: "accepted",
      },
      {
        dimension: "attribute",
        sourceKey: "graded:grading-company",
        targetKey: "Z-Key",
        confidenceTier: "manual",
        reviewStatus: "accepted",
      },
    );
  }
}

function composeWith(
  change: (input: Mutable<ChannelListingCompositionInput>) => void,
): ChannelListingCompositionResult {
  return composeChannelListingPublication(mutateInput(change));
}

function mutateInput(change: (input: Mutable<ChannelListingCompositionInput>) => void): ChannelListingCompositionInput {
  const input = mutable(listingInput());
  change(input);
  return input;
}

function mutateProfile(change: (profile: Mutable<ChannelCompositionProfile>) => void): unknown {
  const profile = mutable(syntheticProfile);
  change(profile);
  return profile;
}

function omitProfileMember(member: keyof ChannelCompositionProfile): unknown {
  const profile = mutable(syntheticProfile) as Mutable<ChannelCompositionProfile> & Record<string, unknown>;
  delete profile[member];
  return profile;
}

function mutable<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function presentRegistered(input: Mutable<ChannelListingCompositionInput>) {
  if (input.listing.kind !== "present" || input.profile.kind !== "registered") {
    throw new Error("expected present listing and registered profile");
  }
  return { listing: input.listing, profile: input.profile.profile };
}

function expectPublishable(result: ChannelListingCompositionResult, draft: Record<string, unknown> = {}): void {
  expect(result).toMatchObject({ kind: "publishable", intent: "publish", draft });
}

function expectReason(result: ChannelListingCompositionResult, reason: ChannelPublicationBlockingReason): void {
  expect(result).toEqual({ kind: "blocked", reasons: [reason] });
}
