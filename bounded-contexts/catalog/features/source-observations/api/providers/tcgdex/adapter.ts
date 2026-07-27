import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun } from "../../governance/catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../../governance/catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../../governance/catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../../governance/integration-unit";
import { getActiveCatalogProviderIntegrationProfileVersion } from "../registry";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../profile-types";
import {
  fetchTcgdexEnglishMirrorEntity,
  fetchTcgdexExpansionOptions,
  fetchTcgdexSeriesOptions,
  fetchTcgdexSetObservationPayloads,
  listTcgdexLanguageOptions,
  type TcgdexObservationPayload,
} from "../tcgdex-client";
import { matchTcgdexEnglishEndpointEntity } from "../tcgdex-alias-extraction";
import { buildEnglishEndpointOptionAlias, ENGLISH_ALIAS_LANGUAGE_CODE } from "../provider-option-aliases";
import type { CatalogAliasTypeKey } from "../../governance/catalog-integration-data-governance";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderOptionAlias,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "../../provider-adapters/provider-adapter";

export const TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgdex",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const TCGDEX_REAL_PROVIDER_PROOF_SCOPE = {
  languageCode: "en",
  seriesId: "swsh",
  setId: "swsh3",
} as const;

export type TcgdexProviderAdapterOptions = Readonly<{
  loadActiveProfileVersion: () => Promise<CatalogProviderIntegrationProfileVersionRecord>;
  fetch?: typeof globalThis.fetch;
}>;

export function createTcgdexProviderAdapter(
  options: TcgdexProviderAdapterOptions,
): ProviderAdapter<TcgdexObservationPayload> {
  return {
    providerKey: "tcgdex",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = await options.loadActiveProfileVersion();
      return [
        {
          unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          providerKey: "tcgdex",
          productDomain: "pokemon",
          productForm: "single-card",
          ingestionPurpose: "source-observation-import",
          displayName: "TCGdex Pokemon single-card Source Observation import",
          profileVersion: profileVersion.profileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listTcgdexAdapterOptions(input, options);
    },
    async planImport(scope) {
      assertTcgdexUnit(scope.unitKey);
      const languageCode = stringValue(scope.values.languageCode) || stringValue(scope.values.language) || "en";
      const setId = stringValue(scope.values.setId) || stringValue(scope.values.expansionId);
      if (!setId) {
        throw new Error("TCGdex expansion import planning requires a setId or expansionId scope value.");
      }

      return {
        unitKey: scope.unitKey,
        planKey: `tcgdex:${languageCode}:${setId}`,
        scope: {
          unitKey: scope.unitKey,
          scopeKey: scope.scopeKey,
          values: { ...scope.values, languageCode, setId },
        },
        transportSteps: ["Fetch TCGdex expansion metadata", "Fetch TCGdex card payloads", "Attach payload provenance"],
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertTcgdexUnit(plan.unitKey);
      const profileVersion = await options.loadActiveProfileVersion();
      const languageCode = stringValue(plan.scope.values.languageCode) || "en";
      const setId = stringValue(plan.scope.values.setId) || stringValue(plan.scope.values.expansionId);
      const seriesId = stringValue(plan.scope.values.seriesId);
      if (!setId) {
        throw new Error("TCGdex payload fetch requires a setId or expansionId scope value.");
      }

      const payloads = await fetchTcgdexSetObservationPayloads({
        profile: profileVersion.profile,
        languageCode,
        setId,
        seriesId,
        fetch: options.fetch,
        onProgress: (progress) =>
          fetchOptions?.onProgress?.({
            phase: "fetching",
            completed: progress.completed,
            total: progress.total,
            currentLabel: progress.currentName,
          }),
      });

      for (const payload of payloads) {
        yield toEnvelope(payload);
      }
    },
    async getTransportDiagnostics() {
      const profileVersion = await options.loadActiveProfileVersion();
      return [
        {
          code: "tcgdex-json-transport-configured",
          severity: "info",
          message: t("catalog.features.sourceObservations.api.providerAdapters.tcgdex.json.transport.configured", {
            connectorKind: profileVersion.profile.connector.kind,
          }),
          unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        },
      ];
    },
    async getCredentialReadiness() {
      const profileVersion = await options.loadActiveProfileVersion();
      return [
        createCatalogProviderCredentialReadiness({
          providerKey: "tcgdex",
          unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.tcgdex.credential.not.required"),
          scope: {
            environmentKey: "runtime",
          },
          evidence: {
            connectorKind: profileVersion.profile.connector.kind,
            credentialRequirement: "not-required",
          },
        }),
      ];
    },
  };
}

export async function runTcgdexSourceObservationImportProofDryRun(
  adapter: ProviderAdapter<TcgdexObservationPayload> = createTcgdexProviderAdapter({
    loadActiveProfileVersion: async () => requireActiveTcgdexProfileVersion(),
    fetch: tcgdexProofFetch,
  }),
  profileVersion: string = requireActiveTcgdexProfileVersion().profileVersion,
): Promise<CatalogIntegrationDryRunResult> {
  const unitKey = TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY;
  const plan = await adapter.planImport({
    unitKey,
    scopeKey: "expansion",
    values: TCGDEX_REAL_PROVIDER_PROOF_SCOPE,
  });
  const payloads: ProviderPayloadEnvelope<TcgdexObservationPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey,
    profileVersion,
    payloads,
    normalize: (envelope) => ({
      unitKey,
      providerKey: envelope.providerKey,
      externalKey: envelope.externalKey,
      profileVersion,
      normalizedFacts: tcgdexDryRunFacts(envelope.payload),
      sourceUrl: envelope.provenance.sourceUrl,
      sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
      sourceHash: envelope.provenance.contentHash,
    }),
  });
}

async function listTcgdexAdapterOptions(
  input: ProviderOptionQueryInput,
  options: TcgdexProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertTcgdexUnit(input.unitKey);
  const profileVersion = await options.loadActiveProfileVersion();
  const profile = profileVersion.profile;
  const optionKind = input.optionKind.trim().toLowerCase();
  const parentValues = input.parentValues ?? {};
  const languageCode = stringValue(parentValues.languageCode) || stringValue(parentValues.language) || "en";

  if (optionKind === "languages" || optionKind === "language") {
    return {
      items: listTcgdexLanguageOptions(profile).map((item) => ({
        value: item.languageCode,
        label: item.languageCode,
      })),
    };
  }

  if (optionKind === "series") {
    const series = await fetchTcgdexSeriesOptions({ profile, languageCode, fetch: options.fetch });
    const items = await Promise.all(
      series.map(async (item) => ({
        value: item.seriesId,
        label: item.name,
        aliases: await englishEndpointOptionAliases({
          profile,
          languageCode,
          entity: "series",
          aliasType: "series-equivalent",
          evidenceKind: "series-id",
          id: item.seriesId,
          fetch: options.fetch,
        }),
        metadata: optionalMetadata({ logoUrl: item.logoUrl }),
      })),
    );
    return { items: items.map(toOptionItem) };
  }

  if (optionKind === "expansions" || optionKind === "expansion") {
    const seriesId = stringValue(parentValues.seriesId) || stringValue(parentValues.parentValue) || null;
    const expansions = await fetchTcgdexExpansionOptions({
      profile,
      languageCode,
      seriesId,
      fetch: options.fetch,
    });
    const items = await Promise.all(
      expansions.map(async (item) => ({
        value: item.expansionId,
        label: item.name,
        parentValue: item.seriesId ?? undefined,
        aliases: await englishEndpointOptionAliases({
          profile,
          languageCode,
          entity: "set",
          aliasType: "set-equivalent",
          evidenceKind: "set-id",
          id: item.expansionId,
          fetch: options.fetch,
        }),
        metadata: optionalMetadata({
          seriesName: item.seriesName,
          logoUrl: item.logoUrl,
          symbolUrl: item.symbolUrl,
          cardCount: item.cardCount === null ? null : String(item.cardCount),
          officialCardCount: item.officialCardCount === null ? null : String(item.officialCardCount),
        }),
      })),
    );
    return { items: items.map(toOptionItem) };
  }

  return { items: [] };
}

/**
 * Resolve typed English option aliases for a single non-English option by
 * fetching the same-id English mirror entity and aligning it with the
 * reusable matcher (`matchTcgdexEnglishEndpointEntity`). English-language
 * selections have no localized name to translate, so they carry no alias. A
 * missing English mirror (404 or id mismatch) yields no alias: providers/options
 * with no reliable English equivalent fall back safely to the native label.
 */
async function englishEndpointOptionAliases(input: {
  profile: CatalogProviderIntegrationProfileVersionRecord["profile"];
  languageCode: string;
  entity: "set" | "series";
  aliasType: CatalogAliasTypeKey;
  evidenceKind: string;
  id: string;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly ProviderOptionAlias[]> {
  if (normalizeOptionKey(input.languageCode) === ENGLISH_ALIAS_LANGUAGE_CODE) {
    return [];
  }

  const englishEntity = await fetchTcgdexEnglishMirrorEntity({
    profile: input.profile,
    entity: input.entity,
    id: input.id,
    fetch: input.fetch,
  });
  const englishName = matchTcgdexEnglishEndpointEntity({ sourceId: input.id, englishEntity });
  const alias = buildEnglishEndpointOptionAlias({
    englishName,
    aliasType: input.aliasType,
    sourceLanguageCode: input.languageCode,
    providerId: input.id,
    evidenceKind: input.evidenceKind,
  });
  return alias ? [alias] : [];
}

function toOptionItem(item: {
  value: string;
  label: string;
  parentValue?: string;
  aliases: readonly ProviderOptionAlias[];
  metadata: ProviderOptionItem["metadata"];
}): ProviderOptionItem {
  return {
    value: item.value,
    label: item.label,
    ...(item.parentValue ? { parentValue: item.parentValue } : {}),
    ...(item.aliases.length > 0 ? { aliases: item.aliases } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  };
}

function toEnvelope(payload: TcgdexObservationPayload): ProviderPayloadEnvelope<TcgdexObservationPayload> {
  const externalKey = stringValue(payload.payload.externalKey);
  if (!externalKey) {
    throw new Error("TCGdex payload envelope requires an externalKey.");
  }

  return {
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    providerKey: "tcgdex",
    externalKey,
    payload,
    provenance: {
      sourceUrl: stringValue(payload.payload.sourceUrl) || undefined,
      sourceUpdatedAt: stringValue(payload.payload.sourceUpdatedAt) || undefined,
      fetchedAt: payload.observedAt,
    },
  };
}

function assertTcgdexUnit(unitKey: string): void {
  if (unitKey !== TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY) {
    throw new Error(`TCGdex adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function optionalMetadata(values: Readonly<Record<string, string | null>>): ProviderOptionItem["metadata"] {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOptionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/([a-z])0+(\d)/g, "$1$2");
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}

function requireActiveTcgdexProfileVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const version = getActiveCatalogProviderIntegrationProfileVersion("tcgdex");
  if (!version) {
    throw new Error("Expected active TCGdex profile version for real-provider proof.");
  }
  return version;
}

function tcgdexDryRunFacts(payload: TcgdexObservationPayload): Readonly<Record<string, string>> {
  return {
    name: stringFact(payload.payload, "catalogHashMaterial.normalized.name"),
    cardNumber: stringFact(payload.payload, "catalogHashMaterial.normalized.cardNumber"),
    expansionName: stringFact(payload.payload, "catalogHashMaterial.normalized.expansionName"),
    rarity: stringFact(payload.payload, "catalogHashMaterial.normalized.rarity"),
    cardVariantLabel: stringFact(payload.payload, "catalogHashMaterial.normalized.cardVariantLabel"),
  };
}

function stringFact(payload: unknown, path: string): string {
  const value = path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, payload);

  return stringValue(value) ?? "";
}

function tcgdexProofFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const response = tcgdexProofResponses[url];
  if (!response) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const tcgdexProofResponses: Readonly<Record<string, unknown>> = {
  "https://api.tcgdex.net/v2/en/sets/swsh3": {
    id: "swsh3",
    name: "Darkness Ablaze",
    releaseDate: "2020-08-14",
    serie: {
      id: "swsh",
      name: "Sword & Shield",
    },
    cardCount: {
      total: 201,
      official: 189,
      reverse: 155,
    },
    cards: [{ id: "swsh3-136", localId: "136", name: "Furret" }],
  },
  "https://api.tcgdex.net/v2/en/cards/swsh3-136": {
    id: "swsh3-136",
    localId: "136",
    name: "Furret",
    category: "Pokemon",
    illustrator: "tetsuya koizumi",
    rarity: "Uncommon",
    updated: "2026-05-15T00:00:00.000Z",
    image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
    set: {
      id: "swsh3",
      name: "Darkness Ablaze",
    },
  },
};
