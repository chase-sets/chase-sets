import { describe, expect, it } from "vitest";
import { classifyChannelDrift } from "../domain/classification";
import type {
  ChannelDriftObservationV1,
  ChannelSourceAuthority,
  ChannelDriftObservation,
  ClaimedChannelStateRead,
} from "../domain/contracts";
import {
  indexClaimedMaterial,
  resolveClaimedMaterial,
  observedMaterialFingerprint,
  CHANNEL_OBSERVED_MATERIAL_SCHEME,
  type ClaimedMaterialIndex,
} from "../read-model/source";
import { tcgplayerExternalListingId } from "../../tcgplayer-csv/domain/composition";
import { syntheticLiveRow, syntheticClaimedSource } from "./fixtures/material.test-data";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const complete: ChannelSourceAuthority = { kind: "complete", collectedCount: 1, authorityTotal: 1 };

function observation(override: Partial<ChannelDriftObservationV1> = {}): ChannelDriftObservationV1 {
  return {
    connectionId: "connection-1",
    channelListingId: "channel-listing-1",
    expectedRevision: 7,
    expectedPrice: { amountMinor: 1_500, currency: "USD" },
    expectedQuantity: 3,
    expectedMaterialFingerprint: "expected-fingerprint",
    lastAppliedRevision: 6,
    acceptedForeignEdit: null,
    observed: {
      present: true,
      revision: "7",
      price: { amountMinor: 1_500, currency: "USD" },
      quantity: 3,
      fingerprint: "expected-fingerprint",
    },
    sourceAuthority: complete,
    ...override,
  };
}

describe("channel-drift-classification-table", () => {
  it.each([
    ["exact expected state", observation(), "in-sync"],
    [
      "retained accepted edit",
      observation({
        observed: {
          present: true,
          revision: "foreign",
          price: { amountMinor: 1_600, currency: "USD" },
          quantity: 2,
          fingerprint: "observed-accepted",
        },
        acceptedForeignEdit: {
          observedFingerprint: "observed-accepted",
          expectedMaterialFingerprint: "expected-fingerprint",
          acceptedAtRunGeneration: 4,
        },
      }),
      "in-sync",
    ],
    [
      "expected moved after acceptance",
      observation({
        expectedMaterialFingerprint: "expected-moved",
        observed: {
          present: true,
          revision: "foreign",
          price: { amountMinor: 1_600, currency: "USD" },
          quantity: 2,
          fingerprint: "observed-accepted",
        },
        acceptedForeignEdit: {
          observedFingerprint: "observed-accepted",
          expectedMaterialFingerprint: "expected-fingerprint",
          acceptedAtRunGeneration: 4,
        },
      }),
      "foreign-edit",
    ],
    [
      "provider still reports last applied state",
      observation({
        expectedRevision: 7,
        lastAppliedRevision: 6,
        observed: {
          present: true,
          revision: "6",
          price: { amountMinor: 1_400, currency: "USD" },
          quantity: 4,
          fingerprint: "previously-applied",
        },
      }),
      "repairable",
    ],
    [
      "provider reports an unowned edit",
      observation({
        lastAppliedRevision: null,
        observed: {
          present: true,
          revision: "foreign",
          price: { amountMinor: 1_400, currency: "USD" },
          quantity: 4,
          fingerprint: "foreign",
        },
      }),
      "foreign-edit",
    ],
    ["complete source reports absence", observation({ observed: { present: false } }), "structural"],
    [
      "declared incomplete source",
      observation({ sourceAuthority: { kind: "declared-incomplete", reason: "page-total-mismatch" } }),
      "source-unavailable",
    ],
    [
      "claimed source absent by design",
      observation({
        observed: { present: false },
        sourceAuthority: { kind: "absent-by-design", reason: "claimed-snapshot-not-installed" },
      }),
      "source-unavailable",
    ],
  ] as const)("classifies %s without a fallthrough", (_label, input, expected) => {
    expect(classifyChannelDrift(input)).toBe(expected);
  });

  it("covers every authority, observation-presence, and last-applied nullability branch", () => {
    const authorities: readonly ChannelSourceAuthority[] = [
      complete,
      { kind: "declared-incomplete", reason: "count-mismatch" },
      { kind: "absent-by-design", reason: "reconciliation-capability-unregistered" },
    ];
    const observedStates: readonly ChannelDriftObservationV1["observed"][] = [
      { present: false },
      {
        present: true,
        revision: "6",
        price: { amountMinor: 1_400, currency: "USD" },
        quantity: 4,
        fingerprint: "previously-applied",
      },
    ];
    const results = new Set<string>();
    for (const sourceAuthority of authorities) {
      for (const observed of observedStates) {
        for (const lastAppliedRevision of [null, 6] as const) {
          const result = classifyChannelDrift(observation({ sourceAuthority, observed, lastAppliedRevision }));
          results.add(result);
          expect(result).toBe(
            sourceAuthority.kind !== "complete"
              ? "source-unavailable"
              : !observed.present
                ? "structural"
                : lastAppliedRevision === 6
                  ? "repairable"
                  : "foreign-edit",
          );
        }
      }
    }
    expect([...results].sort()).toEqual(["foreign-edit", "repairable", "source-unavailable", "structural"]);
  });
});

describe("channel-drift-provenance-discriminator", () => {
  it("distinguishes our unapplied desired move from a foreign edit", () => {
    const ours = observation({
      observed: {
        present: true,
        revision: "6",
        price: { amountMinor: 1_400, currency: "USD" },
        quantity: 4,
        fingerprint: "previously-applied",
      },
    });
    expect(classifyChannelDrift(ours)).toBe("repairable");
    expect(classifyChannelDrift({ ...ours, lastAppliedRevision: 5 })).toBe("foreign-edit");
  });
});

describe("drift-material", () => {
  const row = syntheticLiveRow();
  const identity = tcgplayerExternalListingId(row.externalKey, row.conditionText);
  function material(source: ClaimedChannelStateRead = syntheticClaimedSource()): ChannelDriftObservation {
    return {
      ...observation({
        expectedPrice: { amountMinor: 1000, currency: "USD" },
        expectedQuantity: 2,
        expectedMaterialFingerprint: "e".repeat(64),
      }),
      ...resolveClaimedMaterial(
        {
          channelListingId: "channel-foreign",
          externalListingId: identity,
          externalOfferId: null,
          expectedPrice: { amountMinor: 1000, currency: "USD" },
        },
        indexClaimedMaterial("connection-1", source, 10),
      ),
    };
  }

  it("drift-material-authority-table retains full V1 revision and hash comparison", () => {
    const baseline = observation();
    if (!baseline.observed.present) throw new Error("present fixture required");
    for (const revision of ["6", "foreign"]) {
      expect(classifyChannelDrift({ ...baseline, observed: { ...baseline.observed, revision } })).toBe(
        revision === "6" ? "repairable" : "foreign-edit",
      );
    }
    expect(classifyChannelDrift({ ...baseline, observed: { ...baseline.observed, fingerprint: "foreign" } })).toBe(
      "foreign-edit",
    );
    expect(classifyChannelDrift(material())).toBe("in-sync");
  });

  it("drift-material-projection-parity derives observed material independently of expected hash and revision", () => {
    const input = material();
    expect(input.observed).toMatchObject({ revision: null, price: { amountMinor: 1000 }, quantity: 2 });
    if (!input.observed.present) throw new Error("present fixture required");
    expect(input.observed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(input.observed.fingerprint).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            CHANNEL_OBSERVED_MATERIAL_SCHEME,
            row.externalKey,
            row.conditionText,
            row.currency,
            row.priceAmountMinor,
            row.totalQuantity,
          ]),
        )
        .digest("hex"),
    );
    expect(input.observed.fingerprint).not.toBe(input.expectedMaterialFingerprint);
    expect(classifyChannelDrift({ ...input, expectedRevision: 999, expectedMaterialFingerprint: "f".repeat(64) })).toBe(
      "in-sync",
    );
    expect(classifyChannelDrift(material(syntheticClaimedSource(syntheticLiveRow("10.01"))))).toBe("foreign-edit");
    expect(classifyChannelDrift(material(syntheticClaimedSource(syntheticLiveRow("10.00", 3))))).toBe("foreign-edit");
    expect(classifyChannelDrift(material(syntheticClaimedSource({ ...row, pendingQuantityDelta: 55 })))).toBe(
      "in-sync",
    );
  });

  it.each([
    ["stale", { freshness: "stale" }],
    ["unknown", { freshness: "unknown" }],
    ["unproven", { sourceAuthority: { kind: "declared-incomplete", reason: "unverified" } }],
    ["partial", { sourceAuthority: { kind: "complete", collectedCount: 1, authorityTotal: 2 } }],
    ["F6 missing applied membership", { appliedChannelListingIds: [] }],
    ["Staged", { rows: [{ ...row, surface: "staged" }] }],
    ["null price", { rows: [{ ...row, priceAmountMinor: null }] }],
    ["negative price", { rows: [{ ...row, priceAmountMinor: -1 }] }],
    ["fractional price", { rows: [{ ...row, priceAmountMinor: 0.5 }] }],
    ["unsafe quantity", { rows: [{ ...row, totalQuantity: Number.MAX_SAFE_INTEGER + 1 }] }],
    ["negative count", { sourceAuthority: { kind: "complete", collectedCount: -1, authorityTotal: -1 } }],
    ["wrong snapshot", { snapshotId: "SYNTHETIC-other" }],
    ["wrong connection", { rows: [{ ...row, connectionId: "SYNTHETIC-other" }] }],
    ["ambiguous", { rows: [row, row], sourceAuthority: { kind: "complete", collectedCount: 2, authorityTotal: 2 } }],
  ] satisfies readonly (readonly [string, Partial<ClaimedChannelStateRead>])[])(
    "drift-material-projection-parity rejects %s without equality or consent",
    (_label, override) => {
      expect(classifyChannelDrift(material({ ...syntheticClaimedSource(), ...override }))).toBe("source-unavailable");
    },
  );

  it("drift-material-projection-parity never infers material from claimed absence", () => {
    const source = syntheticClaimedSource({ ...row, conditionText: "Lightly Played" });
    expect(classifyChannelDrift(material(source))).toBe("source-unavailable");
    expect(
      classifyChannelDrift(
        material({ ...source, sourceAuthority: { kind: "declared-incomplete", reason: "partial" } }),
      ),
    ).toBe("source-unavailable");
    expect(
      classifyChannelDrift(
        material({
          ...syntheticClaimedSource(),
          rows: [],
          sourceAuthority: { kind: "complete", collectedCount: 0, authorityTotal: 0 },
        }),
      ),
    ).toBe("source-unavailable");
    expect(classifyChannelDrift({ ...material(), expectedMaterialIdentity: "different" })).toBe("source-unavailable");
    expect(classifyChannelDrift({ ...material(), expectedPrice: { amountMinor: 1000, currency: "EUR" } })).toBe(
      "source-unavailable",
    );
  });

  it("drift-material-repair-authority never substitutes lastAppliedRevision", () => {
    const input = material(syntheticClaimedSource(syntheticLiveRow("11.00")));
    expect(input.observed).toMatchObject({ revision: null });
    expect(classifyChannelDrift({ ...input, lastAppliedRevision: 7 })).toBe("foreign-edit");
  });

  it("drift-material-scheme-lapse separates schemes while preserving exact stable accepted pairs", () => {
    const movedRow = syntheticLiveRow("11.00");
    const input = material(syntheticClaimedSource(movedRow));
    const accepted = {
      observedFingerprint: observedMaterialFingerprint(movedRow),
      expectedMaterialFingerprint: input.expectedMaterialFingerprint,
      acceptedAtRunGeneration: 1,
    };
    expect(classifyChannelDrift({ ...input, acceptedForeignEdit: accepted })).toBe("in-sync");
    const old = createHash("sha256")
      .update(
        JSON.stringify([
          `${CHANNEL_OBSERVED_MATERIAL_SCHEME}-previous`,
          movedRow.externalKey,
          movedRow.conditionText,
          movedRow.currency,
          movedRow.priceAmountMinor,
          movedRow.totalQuantity,
        ]),
      )
      .digest("hex");
    expect(old).not.toBe(accepted.observedFingerprint);
    expect(classifyChannelDrift({ ...input, acceptedForeignEdit: { ...accepted, observedFingerprint: old } })).toBe(
      "foreign-edit",
    );
    expect(
      classifyChannelDrift({ ...input, expectedMaterialFingerprint: "f".repeat(64), acceptedForeignEdit: accepted }),
    ).toBe("foreign-edit");
  });
});

describe("claimed-row-authority", () => {
  const row = syntheticLiveRow();
  const identity = tcgplayerExternalListingId(row.externalKey, row.conditionText);
  const source: ClaimedChannelStateRead = {
    ...syntheticClaimedSource(),
    sourceAuthority: { kind: "present-rows", collectedCount: 1, snapshotRowTotal: 1 },
  };
  const listing = {
    channelListingId: "channel-foreign",
    externalListingId: identity,
    externalOfferId: null,
    expectedPrice: { amountMinor: 1000, currency: "USD" },
  };
  function input(read = source, maxListings = 10): ChannelDriftObservation {
    const index: ClaimedMaterialIndex | null = indexClaimedMaterial("connection-1", read, maxListings);
    return {
      ...observation({
        expectedPrice: listing.expectedPrice,
        expectedQuantity: 2,
        expectedMaterialFingerprint: "e".repeat(64),
      }),
      ...resolveClaimedMaterial(listing, index),
    };
  }

  it.each([
    ["equal", row, "in-sync"],
    ["price moved", { ...row, priceAmountMinor: 1001 }, "foreign-edit"],
    ["quantity moved", { ...row, totalQuantity: 3 }, "foreign-edit"],
    ["pending delta is not material", { ...row, pendingQuantityDelta: 99 }, "in-sync"],
  ] as const)("claimed-row-authority-classification: %s", (_label, observedRow, expected) => {
    const candidate = input({ ...source, rows: [observedRow] });
    expect(candidate.sourceAuthority).toEqual(source.sourceAuthority);
    expect(candidate.observed).toMatchObject({ present: true, revision: null });
    expect(classifyChannelDrift(candidate)).toBe(expected);
    expect(classifyChannelDrift({ ...candidate, lastAppliedRevision: 7 })).toBe(expected);
    expect(candidate.sourceAuthority).not.toHaveProperty("authorityTotal");
  });

  it("claimed-row-authority-accepted-successor keeps only the exact observed/full-expected pair", () => {
    const candidate = input({ ...source, rows: [{ ...row, priceAmountMinor: 1100 }] });
    const accepted = {
      observedFingerprint: observedMaterialFingerprint({ ...row, priceAmountMinor: 1100 }),
      expectedMaterialFingerprint: candidate.expectedMaterialFingerprint,
      acceptedAtRunGeneration: 1,
    };
    expect(classifyChannelDrift({ ...candidate, acceptedForeignEdit: accepted })).toBe("in-sync");
    expect(classifyChannelDrift({ ...candidate, acceptedForeignEdit: { ...accepted } })).toBe("in-sync");
    expect(
      classifyChannelDrift({
        ...candidate,
        acceptedForeignEdit: accepted,
        expectedMaterialFingerprint: "f".repeat(64),
      }),
    ).toBe("foreign-edit");
    expect(
      classifyChannelDrift({
        ...input({ ...source, rows: [{ ...row, priceAmountMinor: 1101 }] }),
        acceptedForeignEdit: accepted,
      }),
    ).toBe("foreign-edit");
    expect(
      classifyChannelDrift({ ...candidate, acceptedForeignEdit: { ...accepted, observedFingerprint: "a".repeat(64) } }),
    ).toBe("foreign-edit");
  });

  it.each([0, 2])(
    "claimed-row-authority-rejections: absent applied expected quantity %s is not zero or structural",
    (expectedQuantity) => {
      const partial = { ...source, rows: [{ ...row, conditionText: "Lightly Played" }] };
      const candidate = { ...input(partial), expectedQuantity };
      expect(candidate.observed).toEqual({ present: false });
      expect(classifyChannelDrift(candidate)).toBe("source-unavailable");
      const empty = input({
        ...source,
        rows: [],
        sourceAuthority: { kind: "present-rows", collectedCount: 0, snapshotRowTotal: 0 },
      });
      expect(classifyChannelDrift({ ...empty, expectedQuantity })).toBe("source-unavailable");
      expect(classifyChannelDrift(input())).toBe("in-sync");
    },
  );

  it.each([
    ["stale", { freshness: "stale" }],
    ["unknown age", { freshness: "unknown" }],
    ["missing snapshot", { snapshotId: "" }],
    ["wrong snapshot", { snapshotId: "SYNTHETIC-other" }],
    ["wrong connection", { rows: [{ ...row, connectionId: "SYNTHETIC-other" }] }],
    ["wrong provider", { rows: [{ ...row, providerKey: "other" as never }] }],
    ["Staged", { rows: [{ ...row, surface: "staged" }] }],
    ["non USD", { rows: [{ ...row, currency: "EUR" as never }] }],
    ["missing applied proof", { appliedChannelListingIds: [] }],
    ["null price", { rows: [{ ...row, priceAmountMinor: null }] }],
    ["fractional price", { rows: [{ ...row, priceAmountMinor: 0.5 }] }],
    ["negative price", { rows: [{ ...row, priceAmountMinor: -1 }] }],
    ["negative quantity", { rows: [{ ...row, totalQuantity: -1 }] }],
    ["unsafe quantity", { rows: [{ ...row, totalQuantity: Number.MAX_SAFE_INTEGER + 1 }] }],
    [
      "incomplete local membership",
      { sourceAuthority: { kind: "present-rows", collectedCount: 1, snapshotRowTotal: 2 } },
    ],
    ["wrong collected count", { sourceAuthority: { kind: "present-rows", collectedCount: 0, snapshotRowTotal: 1 } }],
    ["negative local total", { sourceAuthority: { kind: "present-rows", collectedCount: -1, snapshotRowTotal: -1 } }],
    [
      "unsafe local total",
      {
        sourceAuthority: {
          kind: "present-rows",
          collectedCount: Number.MAX_SAFE_INTEGER + 1,
          snapshotRowTotal: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ],
    [
      "ambiguous identity",
      { rows: [row, row], sourceAuthority: { kind: "present-rows", collectedCount: 2, snapshotRowTotal: 2 } },
    ],
  ] satisfies readonly (readonly [string, Partial<ClaimedChannelStateRead>])[])(
    "claimed-row-authority-rejections: %s",
    (_label, override) => {
      expect(classifyChannelDrift(input())).toBe("in-sync");
      const candidate = input({ ...source, ...override });
      expect(classifyChannelDrift(candidate)).toBe("source-unavailable");
      expect(
        classifyChannelDrift({
          ...candidate,
          acceptedForeignEdit: {
            observedFingerprint: observedMaterialFingerprint(row),
            expectedMaterialFingerprint: candidate.expectedMaterialFingerprint,
            acceptedAtRunGeneration: 1,
          },
        }),
      ).toBe("source-unavailable");
    },
  );

  it("claimed-row-authority-rejections: local cap refuses authority even with every applied row present", () => {
    expect(classifyChannelDrift(input(source, 1))).toBe("in-sync");
    expect(classifyChannelDrift(input(source, 0))).toBe("source-unavailable");
    const extra = { ...row, externalKey: "product:90000099" };
    const overflow: ClaimedChannelStateRead = {
      ...source,
      rows: [row, extra],
      sourceAuthority: { kind: "present-rows", collectedCount: 2, snapshotRowTotal: 2 },
    };
    expect(classifyChannelDrift(input(overflow, 1))).toBe("source-unavailable");
    expect(classifyChannelDrift(input(overflow, 2))).toBe("in-sync");
    expect(indexClaimedMaterial("connection-1", source, Number.NaN)).toBeNull();
    expect(
      indexClaimedMaterial(
        "connection-1",
        { ...source, appliedChannelListingIds: ["channel-foreign", "SYNTHETIC-beyond-cap"] },
        1,
      ),
    ).toBeNull();
  });

  it("claimed-row-authority-rejections: identity and revision arms cannot bypass material validation", () => {
    const candidate = input();
    expect(classifyChannelDrift({ ...candidate, expectedMaterialIdentity: "other" })).toBe("source-unavailable");
    expect(classifyChannelDrift({ ...candidate, expectedPrice: { amountMinor: 1000, currency: "EUR" } })).toBe(
      "source-unavailable",
    );
    expect(classifyChannelDrift({ ...candidate, observed: observation().observed })).toBe("source-unavailable");
    for (const override of [
      { externalListingId: null },
      { externalOfferId: "SYNTHETIC-unbound-offer" },
      { expectedPrice: { amountMinor: 1000, currency: "EUR" } },
    ]) {
      expect(
        classifyChannelDrift({
          ...candidate,
          ...resolveClaimedMaterial({ ...listing, ...override }, indexClaimedMaterial("connection-1", source, 10)),
        }),
      ).toBe("source-unavailable");
    }
    if (!candidate.observed.present || candidate.observed.revision !== null)
      throw new Error("claimed material required");
    for (const override of [
      { fingerprint: "not-a-digest" },
      { price: { amountMinor: -1, currency: "USD" as const } },
      { quantity: -1 },
    ]) {
      expect(classifyChannelDrift({ ...candidate, observed: { ...candidate.observed, ...override } })).toBe(
        "source-unavailable",
      );
    }
  });

  it("claimed-row-authority-glossary distinguishes present-row source authority from provider census", () => {
    const glossary = readFileSync(new URL("../../../GLOSSARY.md", import.meta.url), "utf8");
    const drift = glossary.split("## Channel Drift\n")[1]!.split("## Channel Drift Decision")[0]!;
    expect(drift).toContain("present-row source authority");
    expect(drift).toContain("Provider census remains unverified");
    expect(drift).toContain("source-unavailable");
    expect(drift).toContain("complete sales authority");
  });
});
