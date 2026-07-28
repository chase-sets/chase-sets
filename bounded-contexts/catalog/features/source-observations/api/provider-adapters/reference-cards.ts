import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun } from "../governance/catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../governance/catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../governance/catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../governance/integration-unit";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderPayloadEnvelope,
} from "./provider-adapter";

export const REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "reference-cards",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-proof",
});

export const REFERENCE_CARDS_PROFILE_VERSION = "reference-proof-2026.06.05";

export type ReferenceCardPayload = Readonly<{
  id: string;
  name: string;
  cardNumber: string;
  expansionName: string;
  rarity: string;
}>;

const referencePayloadEnvelope: ProviderPayloadEnvelope<ReferenceCardPayload> = {
  unitKey: REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
  providerKey: "reference-cards",
  externalKey: "pokemon:abra-43",
  payload: {
    id: "pokemon:abra-43",
    name: "Abra",
    cardNumber: "43",
    expansionName: "Reference Proof",
    rarity: "Common",
  },
  provenance: {
    sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
    sourceUpdatedAt: "2026-06-05T00:00:00.000Z",
    fetchedAt: "2026-06-05T00:00:00.000Z",
    contentHash: "sha256:reference-cards-abra-43",
  },
};

export function createReferenceCardsProviderAdapter(): ProviderAdapter<ReferenceCardPayload> {
  return {
    providerKey: "reference-cards",
    capabilities: {
      supportsOptionQueries: false,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      return [
        {
          unitKey: REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
          providerKey: "reference-cards",
          productDomain: "pokemon",
          productForm: "single-card",
          ingestionPurpose: "source-observation-proof",
          displayName: "Reference Pokemon single-card Source Observation proof",
          profileVersion: REFERENCE_CARDS_PROFILE_VERSION,
        },
      ];
    },
    async listOptions() {
      return { items: [] };
    },
    async planImport(scope: ProviderImportScope): Promise<ProviderImportPlan> {
      return {
        unitKey: scope.unitKey,
        planKey: "reference-cards-fixture-proof",
        scope,
        estimatedPayloads: 1,
        transportSteps: ["Load fixture payload", "Attach fixture provenance"],
      };
    },
    async *fetchPayloads(plan: ProviderImportPlan) {
      if (plan.unitKey === REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY) {
        yield referencePayloadEnvelope;
      }
    },
    async getCredentialReadiness() {
      return [
        createCatalogProviderCredentialReadiness({
          providerKey: "reference-cards",
          unitKey: REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.referenceCards.credential.not.required"),
          evidence: {
            credentialRequirement: "not-required",
            fixtureBacked: true,
          },
        }),
      ];
    },
    async getTransportDiagnostics() {
      return [
        {
          code: "fixture-backed-provider",
          severity: "info",
          message: t("catalog.features.sourceObservations.api.providerAdapters.referenceCards.fixture.backed.provider"),
          unitKey: REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
        },
      ];
    },
  };
}

export async function runReferenceCardsSourceObservationProofDryRun(
  adapter: ProviderAdapter<ReferenceCardPayload> = createReferenceCardsProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const unitKey = REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY;
  const plan = await adapter.planImport({
    unitKey,
    scopeKey: "fixture:normal",
    values: { fixtureFlow: "normal" },
  });
  const payloads: ProviderPayloadEnvelope<ReferenceCardPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey,
    profileVersion: REFERENCE_CARDS_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => ({
      unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion: REFERENCE_CARDS_PROFILE_VERSION,
      normalizedFacts: {
        name: envelope.payload.name,
        cardNumber: envelope.payload.cardNumber,
        expansionName: envelope.payload.expansionName,
        rarity: envelope.payload.rarity,
      },
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    }),
  });
}
