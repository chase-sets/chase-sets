import { t } from "@chase-sets/localization";
import { defineCatalogIntegrationUnitKey } from "../integration-unit";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import {
  fetchTcgdexExpansionOptions,
  fetchTcgdexSeriesOptions,
  fetchTcgdexSetObservationPayloads,
  listTcgdexLanguageOptions,
  type TcgdexObservationPayload,
} from "../tcgdex-client";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "./provider-adapter";

export const TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "tcgdex",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

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
      if (!setId) {
        throw new Error("TCGdex payload fetch requires a setId or expansionId scope value.");
      }

      const payloads = await fetchTcgdexSetObservationPayloads({
        profile: profileVersion.profile,
        languageCode,
        setId,
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
  };
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
    return {
      items: series.map((item) => ({
        value: item.seriesId,
        label: item.name,
        metadata: optionalMetadata({ logoUrl: item.logoUrl }),
      })),
    };
  }

  if (optionKind === "expansions" || optionKind === "expansion") {
    const seriesId = stringValue(parentValues.seriesId) || stringValue(parentValues.parentValue) || null;
    const expansions = await fetchTcgdexExpansionOptions({
      profile,
      languageCode,
      seriesId,
      fetch: options.fetch,
    });
    return {
      items: expansions.map((item) => ({
        value: item.expansionId,
        label: item.name,
        parentValue: item.seriesId ?? undefined,
        metadata: optionalMetadata({
          seriesName: item.seriesName,
          logoUrl: item.logoUrl,
          symbolUrl: item.symbolUrl,
          cardCount: item.cardCount === null ? null : String(item.cardCount),
          officialCardCount: item.officialCardCount === null ? null : String(item.officialCardCount),
        }),
      })),
    };
  }

  return { items: [] };
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

function stringValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}
