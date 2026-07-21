import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { sendSeedCommand } from "../../../support/seed-support/context";
import type { SourceObservationCommand, SourceObservationPokemonCardNormalized } from "../domain/domain";
import { catalogProviderSourceMappingFingerprint } from "./provider-source-observation-normalizer";
import { tcgdexPokemonCardSourceObservationMappingContract } from "./tcgdex-executable-mapping-contract";

export const catalogBrowserE2ePromotedObservation = {
  observationId: "tcgdex_en_base2_60",
  displayName: "Pikachu",
} as const;

const sourceObservationStreamId =
  `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}` as const;
const sourceMappingFingerprint = catalogProviderSourceMappingFingerprint(
  tcgdexPokemonCardSourceObservationMappingContract,
);

/**
 * Gives disposable scenario environments one stable promoted review row so the
 * browser journey can prove row-level reapply/replay wiring without a live provider pull.
 */
export async function seedPromotedSourceObservationScenario(services: CatalogServices): Promise<void> {
  const existing = await services.db.query<{ event_type: string }>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [sourceObservationStreamId],
  );
  const eventTypes = new Set(existing.rows.map((row) => row.event_type));

  if (eventTypes.size === 0) {
    await sendSeedCommand(services.sourceObservations.commandHandler, sourceObservationStreamId, recordCommand());
  }

  if (!eventTypes.has("catalog.source-observation.promoted")) {
    await sendSeedCommand(services.sourceObservations.commandHandler, sourceObservationStreamId, {
      type: "PromoteSourceObservation",
      catalogItemId: catalogSeedIds.items.pikachuJungle,
      promotedAt: "2026-06-03T00:01:00.000Z",
      promotionProfileKey: tcgdexPokemonCardSourceObservationMappingContract.profileKey,
      promotionProfileVersion: tcgdexPokemonCardSourceObservationMappingContract.profileVersion,
      promotionPlanFingerprint: sourceMappingFingerprint,
    });
  }
}

function recordCommand(): Extract<SourceObservationCommand, { type: "RecordSourceObservation" }> {
  return {
    type: "RecordSourceObservation",
    observationId: catalogBrowserE2ePromotedObservation.observationId,
    providerKey: tcgdexPokemonCardSourceObservationMappingContract.providerKey,
    externalKey: "base2-60",
    sourceUrl: "https://api.tcgdex.net/v2/en/cards/base2-60",
    languageCode: "en",
    sourceRecordHash: "sha256:catalog-browser-e2e-tcgdex-base2-60-v1",
    sourceUpdatedAt: null,
    observedAt: "2026-06-03T00:00:00.000Z",
    sourceProfileKey: tcgdexPokemonCardSourceObservationMappingContract.profileKey,
    sourceProfileVersion: tcgdexPokemonCardSourceObservationMappingContract.profileVersion,
    sourceMappingFingerprint,
    normalized: pikachuJungleObservation(),
    sourcePayload: { id: "base2-60", localScenarioEvidence: true },
  };
}

function pikachuJungleObservation(): SourceObservationPokemonCardNormalized {
  return {
    kind: "pokemon-card",
    tcg: "pokemon",
    languageCode: "en",
    name: catalogBrowserE2ePromotedObservation.displayName,
    cardNumber: "60",
    setId: "base2",
    setName: "Jungle",
    expansionId: "base2",
    expansionName: "Jungle",
    expansionAbbreviation: "JU",
    expansionCardCount: 64,
    expansionParallelSetCardCount: 0,
    seriesId: "base",
    seriesName: "Base",
    rarity: "Common",
    illustrator: "Kagemaru Himeno",
    releaseDate: "1999-06-16",
    releaseYear: 1999,
    category: "Pokemon",
    imageBaseUrl: "https://assets.tcgdex.net/en/base/base2/60",
    imageUrls: ["https://assets.tcgdex.net/en/base/base2/60/high.webp"],
    productAssetSet: null,
    parallelSet: false,
    cardVariantKey: "standard-set",
    cardVariantLabel: "Standard Set",
    cardVariantSourceKey: "normal",
    cardVariantIsPrimaryImage: true,
    imageDisclaimer: null,
    variants: {},
    externalCatalogItemReferences: [],
  };
}
