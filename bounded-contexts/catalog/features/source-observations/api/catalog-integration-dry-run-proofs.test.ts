import { describe, expect, it } from "vitest";

import { createCatalogIntegrationDryRunProofRegistry } from "./catalog-integration-dry-run-proofs";
import { REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY } from "./provider-adapters/reference-cards";
import { TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "./provider-adapters/tcgdex";

describe("Catalog integration dry-run proof registry", () => {
  it("registers proof runners by Catalog integration unit key", async () => {
    const registry = createCatalogIntegrationDryRunProofRegistry();

    expect([...registry.keys()]).toEqual([
      REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
      TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    ]);
    await expect(
      registry.get(TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgdex",
          externalKey: "swsh3-136",
        }),
      ],
    });
  });
});
