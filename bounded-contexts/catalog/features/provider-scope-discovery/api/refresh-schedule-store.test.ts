import { describe, expect, it } from "vitest";
import { hashProviderScopeObservation, type ProviderScopeObservationInput } from "./refresh-schedule-store";

const observation: ProviderScopeObservationInput = {
  providerKey: "TCGDEX",
  unitKey: "Pokemon/Card/Import",
  scopeKind: "expansion",
  sourceQueryKind: "expansions",
  languageCode: "EN",
  externalId: "sv04.5",
  label: "Paldean Fates",
  parents: ["sv"],
  imageUrl: null,
  metadata: {
    abbreviation: "PAF",
    releaseDate: "2024-01-26",
    provider: { source: "sets", revision: 1 },
  },
};

describe("Provider Scope Observation hash", () => {
  it("is stable across key and parent ordering differences", () => {
    expect(hashProviderScopeObservation(observation)).toBe(
      hashProviderScopeObservation({
        ...observation,
        parents: ["sv", "sv"],
        metadata: {
          releaseDate: "2024-01-26",
          abbreviation: "PAF",
          provider: { revision: 1, source: "sets" },
        },
      }),
    );
  });

  it("changes when provider evidence changes", () => {
    expect(hashProviderScopeObservation(observation)).not.toBe(
      hashProviderScopeObservation({
        ...observation,
        metadata: { ...observation.metadata, releaseDate: "2024-02-09" },
      }),
    );
  });
});
