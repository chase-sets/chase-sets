import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun } from "../../governance/catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../../governance/catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../../governance/catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../../governance/integration-unit";
import type {
  ProviderAdapter,
  ProviderImportScope,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "../../provider-adapters/provider-adapter";

export const LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "lorcanajson",
  productDomain: "lorcana",
  productForm: "single-card",
  ingestionPurpose: "reference-data",
});

export const LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "lorcanajson",
  productDomain: "lorcana",
  productForm: "set",
  ingestionPurpose: "reference-data",
});

export const LORCANAJSON_PRODUCTION_PROFILE_VERSION = "2026.06.23";
export const LORCANAJSON_VALIDATION_PROFILE_VERSION = "lorcanajson-validation-2026.06.23";

export type LorcanajsonProviderPayload =
  | Readonly<{
      kind: "lorcana-card-reference";
      languageCode: "en";
      observationId: string;
      externalKey: string;
      sourceUrl: string;
      sourceUpdatedAt: string | null;
      sourcePayload: LorcanajsonCompactCardSourcePayload;
      catalogHashMaterial: LorcanajsonCatalogHashMaterial;
      mergeIdentity: LorcanajsonCardMergeIdentity;
      externalCatalogItemReferences: readonly LorcanajsonExternalCatalogItemReference[];
      externalProductReferences: readonly [];
      imageUrls: readonly string[];
      cardId: string;
      name: string;
      cardNumber: string;
      setId: string;
      setCode: string;
      setName: string;
      rarity: string | null;
      cardType: string | null;
      inkColor: string | null;
      releaseDate: string | null;
      releaseYear: string | null;
      tcgplayerProductId: string | null;
    }>
  | Readonly<{
      kind: "lorcana-set-reference";
      languageCode: "en";
      observationId: string;
      externalKey: string;
      sourceUrl: string;
      sourceUpdatedAt: string | null;
      sourcePayload: LorcanajsonCompactSetSourcePayload;
      catalogHashMaterial: LorcanajsonCatalogHashMaterial;
      externalCatalogItemReferences: readonly [];
      setId: string;
      setCode: string;
      setName: string;
      name: string;
      releaseDate: string | null;
      releaseYear: string | null;
      cardCount: number | null;
    }>;

export type LorcanajsonProviderAdapterOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => Date;
  profileVersion?: string;
  fetchTimeoutMs?: number;
}>;

type LorcanajsonMetadata = Readonly<{
  formatVersion?: string;
  generatedOn?: string;
  language?: string;
}>;

type LorcanajsonAllCardsResponse = Readonly<{
  metadata?: LorcanajsonMetadata;
  sets?: Readonly<Record<string, LorcanajsonSetData>>;
  cards?: readonly LorcanajsonCardData[];
}>;

type LorcanajsonSetResponse = Readonly<{
  metadata?: LorcanajsonMetadata;
  code?: string | number;
  name?: string;
  releaseDate?: string;
  cards?: readonly LorcanajsonCardData[];
}>;

type LorcanajsonSetData = Readonly<{
  id?: string | number;
  code?: string | number;
  name?: string;
  releaseDate?: string;
  prereleaseDate?: string;
  type?: string;
  number?: number | string;
  cardCount?: number | string;
  totalCards?: number | string;
}> &
  Readonly<Record<string, unknown>>;

type LorcanajsonCardData = Readonly<{
  id?: string;
  fullName?: string;
  simpleName?: string;
  name?: string;
  number?: string | number;
  setCode?: string | number;
  rarity?: string;
  type?: string;
  typeText?: string;
  color?: string;
  images?: Readonly<{
    full?: string;
    thumbnail?: string;
  }>;
  externalLinks?: Readonly<{
    tcgPlayerId?: string | number;
  }>;
}> &
  Readonly<Record<string, unknown>>;

type LorcanajsonCompactCardSourcePayload = Readonly<{
  provider: "lorcanajson";
  formatVersion: string | null;
  generatedOn: string | null;
  set: LorcanajsonCompactSetSourcePayload;
  card: Readonly<{
    id: string;
    name: string;
    cardNumber: string;
    rarity: string | null;
    cardType: string | null;
    inkColor: string | null;
    tcgplayerProductId: string | null;
    imageUrls: readonly string[];
  }>;
}>;

type LorcanajsonCompactSetSourcePayload = Readonly<{
  provider: "lorcanajson";
  formatVersion: string | null;
  generatedOn: string | null;
  setId: string;
  setCode: string;
  setName: string;
  releaseDate: string | null;
  cardCount: number | null;
}>;

type LorcanajsonCatalogHashMaterial = Readonly<{
  provider: "lorcanajson";
  formatVersion: string | null;
  generatedOn: string | null;
  setId: string;
  setCode: string;
  setName: string;
  cardId?: string;
  cardNumber?: string;
  name?: string;
  rarity?: string | null;
  tcgplayerProductId?: string | null;
  releaseDate?: string | null;
  cardCount?: number | null;
}>;

type LorcanajsonCardMergeIdentity = Readonly<{
  tcg: "lorcana";
  productLineName: "Disney Lorcana";
  setName: string;
  printedProductName: string;
  collectorNumber: string;
  languageCode: "en";
  productForm: "single-card";
}>;

type LorcanajsonExternalCatalogItemReference = Readonly<{
  providerKey: "tcgplayer";
  externalKey: string;
}>;

type LorcanajsonUnitKey =
  | typeof LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY
  | typeof LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY;

const lorcanajsonProofFetchedAt = "2026-06-23T00:00:00.000Z";
const DEFAULT_LORCANAJSON_FETCH_TIMEOUT_MS = 30_000;

export function createLorcanajsonProviderAdapter(
  options: LorcanajsonProviderAdapterOptions = {},
): ProviderAdapter<LorcanajsonProviderPayload> {
  return {
    providerKey: "lorcanajson",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = options.profileVersion ?? LORCANAJSON_PRODUCTION_PROFILE_VERSION;
      return [
        {
          unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          providerKey: "lorcanajson",
          productDomain: "lorcana",
          productForm: "single-card",
          ingestionPurpose: "reference-data",
          displayName: "LorcanaJSON Lorcana single-card reference data",
          profileVersion,
        },
        {
          unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
          providerKey: "lorcanajson",
          productDomain: "lorcana",
          productForm: "set",
          ingestionPurpose: "reference-data",
          displayName: "LorcanaJSON Lorcana set reference data",
          profileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listLorcanajsonOptions(input, options);
    },
    async planImport(scope) {
      assertLorcanajsonUnit(scope.unitKey);
      const setCode = requireString(
        scope.values.setCode ?? scope.values.code ?? scope.values.setId ?? scope.values.expansionId,
        "LorcanaJSON import planning requires setCode.",
      );

      if (scope.unitKey === LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY) {
        return {
          unitKey: scope.unitKey,
          planKey: `lorcanajson:set:${normalizeSetCode(setCode)}`,
          scope: { unitKey: scope.unitKey, scopeKey: "set", values: { ...scope.values, setCode } },
          estimatedPayloads: 1,
          transportSteps: [
            "Fetch LorcanaJSON set file",
            "Attach set reference provenance",
            "Use allCards.json only for option discovery",
          ],
          usageEstimate: {
            requestStrategy: "bulk-first",
            estimateState: "estimated",
            estimatedRequestCount: 1,
            estimateReason: "One selected set file contains set metadata and card list.",
            pageSize: null,
            selectedFields: [],
            perRecordFallbackReason: null,
            usageCheckState: "not-supported",
            creditDiagnostic: null,
            degradedDiagnostic: null,
          },
        };
      }

      const cardId = stringValue(scope.values.cardId ?? scope.values.id);
      const cardName = stringValue(scope.values.cardName ?? scope.values.name);
      const cardNumber = stringValue(scope.values.cardNumber ?? scope.values.collectorNumber ?? scope.values.number);

      if (!cardId && !cardName && !cardNumber) {
        return {
          unitKey: scope.unitKey,
          planKey: `lorcanajson:cards:set:${normalizeSetCode(setCode)}`,
          scope: { unitKey: scope.unitKey, scopeKey: "set", values: { ...scope.values, setCode } },
          transportSteps: [
            "Fetch LorcanaJSON set file",
            "Select all card payloads from the selected set",
            "Attach card reference provenance",
          ],
          usageEstimate: {
            requestStrategy: "bulk-first",
            estimateState: "estimated",
            estimatedRequestCount: 1,
            estimateReason: "One selected set file contains every card payload for the set.",
            pageSize: null,
            selectedFields: [],
            perRecordFallbackReason: null,
            usageCheckState: "not-supported",
            creditDiagnostic: null,
            degradedDiagnostic: null,
          },
        };
      }

      return {
        unitKey: scope.unitKey,
        planKey: `lorcanajson:card:${normalizeSetCode(setCode)}:${
          cardId ?? `${cardName ?? "card"}:${cardNumber ?? "any"}`
        }`,
        scope: {
          unitKey: scope.unitKey,
          scopeKey: "single-card",
          values: {
            ...scope.values,
            setCode,
            ...(cardId ? { cardId } : {}),
            ...(cardName ? { cardName } : {}),
            ...(cardNumber ? { cardNumber } : {}),
          },
        },
        estimatedPayloads: 1,
        transportSteps: [
          "Fetch LorcanaJSON set file",
          "Select requested card payload",
          "Attach card reference provenance",
        ],
        usageEstimate: {
          requestStrategy: "bulk-first",
          estimateState: "estimated",
          estimatedRequestCount: 1,
          estimateReason: "A selected-card import still uses the bulk set file instead of a per-card endpoint.",
          pageSize: null,
          selectedFields: [],
          perRecordFallbackReason: null,
          usageCheckState: "not-supported",
          creditDiagnostic: null,
          degradedDiagnostic: null,
        },
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertLorcanajsonUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
      const setCode = requireString(plan.scope.values.setCode, "LorcanaJSON payload fetch requires setCode.");
      const sourceUrl = lorcanajsonSetUrl(setCode, options);
      const response = await fetchLorcanajsonSet(setCode, options);
      const set = normalizeSetFromSetResponse(response, setCode);

      if (plan.unitKey === LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY) {
        yield lorcanajsonEnvelope({
          unitKey: plan.unitKey,
          externalKey: `set:${set.setId}`,
          payload: createLorcanajsonSetPayload({ response, set, sourceUrl }),
          sourceUrl,
          sourceUpdatedAt: sourceUpdatedAt(response.metadata, set.releaseDate),
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: set.setName,
        });
        return;
      }

      const cards = response.cards ?? [];
      if (plan.scope.scopeKey === "set") {
        for (let index = 0; index < cards.length; index += 1) {
          const card = cards[index] ?? {};
          const payload = createLorcanajsonCardPayload({ response, set, card, sourceUrl });
          yield lorcanajsonEnvelope({
            unitKey: plan.unitKey,
            externalKey: payload.externalKey,
            payload,
            sourceUrl,
            sourceUpdatedAt: sourceUpdatedAt(response.metadata, set.releaseDate),
            fetchedAt,
          });
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed: index + 1,
            total: cards.length,
            currentLabel: payload.name,
          });
        }
        return;
      }

      const card = findLorcanajsonCard(cards, plan.scope.values);
      if (!card) {
        throw new Error(`LorcanaJSON set '${setCode}' did not include the requested card payload.`);
      }

      const payload = createLorcanajsonCardPayload({ response, set, card, sourceUrl });
      yield lorcanajsonEnvelope({
        unitKey: plan.unitKey,
        externalKey: payload.externalKey,
        payload,
        sourceUrl,
        sourceUpdatedAt: sourceUpdatedAt(response.metadata, set.releaseDate),
        fetchedAt,
      });
      await fetchOptions?.onProgress?.({
        phase: "fetching",
        completed: 1,
        total: 1,
        currentLabel: payload.name,
      });
    },
    async getCredentialReadiness() {
      return lorcanajsonUnitKeys().map((unitKey) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "lorcanajson",
          unitKey,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.lorcanajson.credential.not.required"),
          evidence: { credentialRequirement: "not-required", publicJson: true },
        }),
      );
    },
    async getTransportDiagnostics() {
      return lorcanajsonUnitKeys().map((unitKey) => ({
        code: "lorcanajson-public-json-transport-configured",
        severity: "info",
        message: t(
          "catalog.features.sourceObservations.api.providerAdapters.lorcanajson.public.json.transport.configured",
        ),
        unitKey,
      }));
    },
  };
}

export function createLorcanajsonValidationProviderAdapter(): ProviderAdapter<LorcanajsonProviderPayload> {
  return createLorcanajsonProviderAdapter({
    fetch: lorcanajsonValidationFetch,
    now: () => new Date(lorcanajsonProofFetchedAt),
    profileVersion: LORCANAJSON_VALIDATION_PROFILE_VERSION,
  });
}

export async function runLorcanajsonCardReferenceValidationDryRun(
  adapter: ProviderAdapter<LorcanajsonProviderPayload> = createLorcanajsonValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "single-card",
    values: { setCode: "1", cardName: "Elsa - Snow Queen", cardNumber: "41" },
  });
  const payloads: ProviderPayloadEnvelope<LorcanajsonProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    profileVersion: LORCANAJSON_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "lorcana-card-reference") {
        throw new Error("LorcanaJSON card dry run received a non-card payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: LORCANAJSON_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: envelope.payload.name,
          cardNumber: envelope.payload.cardNumber,
          setCode: envelope.payload.setCode,
          setName: envelope.payload.setName,
          rarity: envelope.payload.rarity ?? "",
          cardType: envelope.payload.cardType ?? "",
          inkColor: envelope.payload.inkColor ?? "",
          tcgplayerProductId: envelope.payload.tcgplayerProductId ?? "",
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

export async function runLorcanajsonSetReferenceValidationDryRun(
  adapter: ProviderAdapter<LorcanajsonProviderPayload> = createLorcanajsonValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "set",
    values: { setCode: "1" },
  });
  const payloads: ProviderPayloadEnvelope<LorcanajsonProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    profileVersion: LORCANAJSON_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "lorcana-set-reference") {
        throw new Error("LorcanaJSON set dry run received a non-set payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: LORCANAJSON_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: envelope.payload.name,
          setCode: envelope.payload.setCode,
          setName: envelope.payload.setName,
          releaseDate: envelope.payload.releaseDate ?? "",
          cardCount: String(envelope.payload.cardCount ?? ""),
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

async function listLorcanajsonOptions(
  input: ProviderOptionQueryInput,
  options: LorcanajsonProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertLorcanajsonUnit(input.unitKey);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "sets" || optionKind === "set") {
    const response = await fetchLorcanajsonAllCards(options);
    const cardsBySetCode = countCardsBySetCode(response.cards ?? []);
    return {
      items: Object.entries(response.sets ?? {})
        .map(([setKey, set]) => setOptionFromAllCardsEntry(setKey, set, response.metadata, cardsBySetCode))
        .sort((left, right) => left.label.localeCompare(right.label)),
    };
  }

  if (optionKind === "cards" || optionKind === "card") {
    const setCode = requireString(
      input.parentValues?.setCode ?? input.parentValues?.parentValue,
      "LorcanaJSON card option queries require a setCode parent value.",
    );
    const response = await fetchLorcanajsonSet(setCode, options);
    const set = normalizeSetFromSetResponse(response, setCode);
    return {
      items: (response.cards ?? []).map((card) => {
        const payload = createLorcanajsonCardPayload({
          response,
          set,
          card,
          sourceUrl: lorcanajsonSetUrl(setCode, options),
        });
        return {
          value: payload.cardId,
          label: t("catalog.features.sourceObservations.api.providerAdapters.card.option.label", {
            name: payload.name,
            cardNumber: payload.cardNumber,
          }),
          parentValue: payload.setCode,
          metadata: optionalMetadata({
            cardId: payload.cardId,
            setCode: payload.setCode,
            setName: payload.setName,
            cardNumber: payload.cardNumber,
            rarity: payload.rarity,
            cardType: payload.cardType,
            inkColor: payload.inkColor,
            tcgplayerProductId: payload.tcgplayerProductId,
            imageUrl: payload.imageUrls[0] ?? null,
          }),
        };
      }),
    };
  }

  return { items: [] };
}

async function fetchLorcanajsonAllCards(
  options: LorcanajsonProviderAdapterOptions,
): Promise<LorcanajsonAllCardsResponse> {
  return fetchJson(lorcanajsonUrl("allCards.json", options), options);
}

async function fetchLorcanajsonSet(
  setCode: string,
  options: LorcanajsonProviderAdapterOptions,
): Promise<LorcanajsonSetResponse> {
  return fetchJson(lorcanajsonSetUrl(setCode, options), options);
}

async function fetchJson<T>(url: string, options: LorcanajsonProviderAdapterOptions): Promise<T> {
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_LORCANAJSON_FETCH_TIMEOUT_MS;
  const abortController = timeoutMs > 0 ? new AbortController() : null;
  const timeout =
    abortController && timeoutMs > 0
      ? setTimeout(() => {
          abortController.abort();
        }, timeoutMs)
      : null;

  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      url,
      abortController ? { signal: abortController.signal } : undefined,
    );
    if (!response.ok) {
      throw new Error(`LorcanaJSON request failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (abortController?.signal.aborted) {
      throw new Error("LorcanaJSON request timed out before the provider returned a response.");
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function createLorcanajsonCardPayload(input: {
  response: LorcanajsonSetResponse;
  set: NormalizedLorcanajsonSet;
  card: LorcanajsonCardData;
  sourceUrl: string;
}): Extract<LorcanajsonProviderPayload, { kind: "lorcana-card-reference" }> {
  const cardId = requireString(input.card.id, "LorcanaJSON card payload did not include id.");
  const name = requireString(
    input.card.fullName ?? input.card.simpleName ?? input.card.name,
    "LorcanaJSON card payload did not include a name.",
  );
  const cardNumber = requireString(input.card.number, "LorcanaJSON card payload did not include a number.");
  const imageUrls = imageUrlsFromCard(input.card);
  const tcgplayerProductId = stringValue(input.card.externalLinks?.tcgPlayerId);
  const releaseYear = yearFromDate(input.set.releaseDate);
  const externalCatalogItemReferences = tcgplayerProductId
    ? [{ providerKey: "tcgplayer" as const, externalKey: `product:${tcgplayerProductId}` }]
    : [];
  const sourcePayload: LorcanajsonCompactCardSourcePayload = {
    provider: "lorcanajson",
    formatVersion: input.response.metadata?.formatVersion ?? null,
    generatedOn: input.response.metadata?.generatedOn ?? null,
    set: compactSetSourcePayload(input.response.metadata, input.set),
    card: {
      id: cardId,
      name,
      cardNumber,
      rarity: stringValue(input.card.rarity),
      cardType: stringValue(input.card.typeText ?? input.card.type),
      inkColor: stringValue(input.card.color),
      tcgplayerProductId,
      imageUrls,
    },
  };
  const catalogHashMaterial = {
    provider: "lorcanajson" as const,
    formatVersion: input.response.metadata?.formatVersion ?? null,
    generatedOn: input.response.metadata?.generatedOn ?? null,
    setId: input.set.setId,
    setCode: input.set.setCode,
    setName: input.set.setName,
    cardId,
    cardNumber,
    name,
    rarity: stringValue(input.card.rarity),
    tcgplayerProductId,
  };

  return {
    kind: "lorcana-card-reference",
    languageCode: "en",
    observationId: `lorcanajson_card_en_${cardId}`,
    externalKey: `card:${cardId}`,
    sourceUrl: input.sourceUrl,
    sourceUpdatedAt: sourceUpdatedAt(input.response.metadata, input.set.releaseDate),
    sourcePayload,
    catalogHashMaterial,
    mergeIdentity: {
      tcg: "lorcana",
      productLineName: "Disney Lorcana",
      setName: input.set.setName,
      printedProductName: name,
      collectorNumber: cardNumber,
      languageCode: "en",
      productForm: "single-card",
    },
    externalCatalogItemReferences,
    externalProductReferences: [],
    imageUrls,
    cardId,
    name,
    cardNumber,
    setId: input.set.setId,
    setCode: input.set.setCode,
    setName: input.set.setName,
    rarity: stringValue(input.card.rarity),
    cardType: stringValue(input.card.typeText ?? input.card.type),
    inkColor: stringValue(input.card.color),
    releaseDate: input.set.releaseDate,
    releaseYear,
    tcgplayerProductId,
  };
}

function createLorcanajsonSetPayload(input: {
  response: LorcanajsonSetResponse;
  set: NormalizedLorcanajsonSet;
  sourceUrl: string;
}): Extract<LorcanajsonProviderPayload, { kind: "lorcana-set-reference" }> {
  const sourcePayload = compactSetSourcePayload(input.response.metadata, input.set);
  const catalogHashMaterial = {
    provider: "lorcanajson" as const,
    formatVersion: input.response.metadata?.formatVersion ?? null,
    generatedOn: input.response.metadata?.generatedOn ?? null,
    setId: input.set.setId,
    setCode: input.set.setCode,
    setName: input.set.setName,
    releaseDate: input.set.releaseDate,
    cardCount: input.set.cardCount,
  };

  return {
    kind: "lorcana-set-reference",
    languageCode: "en",
    observationId: `lorcanajson_set_en_${input.set.setId}`,
    externalKey: `set:${input.set.setId}`,
    sourceUrl: input.sourceUrl,
    sourceUpdatedAt: sourceUpdatedAt(input.response.metadata, input.set.releaseDate),
    sourcePayload,
    catalogHashMaterial,
    externalCatalogItemReferences: [],
    setId: input.set.setId,
    setCode: input.set.setCode,
    setName: input.set.setName,
    name: input.set.setName,
    releaseDate: input.set.releaseDate,
    releaseYear: yearFromDate(input.set.releaseDate),
    cardCount: input.set.cardCount,
  };
}

type NormalizedLorcanajsonSet = Readonly<{
  setId: string;
  setCode: string;
  setName: string;
  releaseDate: string | null;
  cardCount: number | null;
}>;

function normalizeSetFromSetResponse(
  response: LorcanajsonSetResponse,
  fallbackSetCode: string,
): NormalizedLorcanajsonSet {
  const setCode = normalizeSetCode(stringValue(response.code) ?? fallbackSetCode);
  const setName = requireString(response.name, "LorcanaJSON set payload did not include a name.");
  return {
    setId: setCode,
    setCode,
    setName,
    releaseDate: stringValue(response.releaseDate),
    cardCount: response.cards?.length ?? null,
  };
}

function setOptionFromAllCardsEntry(
  setKey: string,
  set: LorcanajsonSetData,
  metadata: LorcanajsonMetadata | undefined,
  cardsBySetCode: ReadonlyMap<string, number>,
): ProviderOptionItem {
  const setCode = normalizeSetCode(stringValue(set.code ?? setKey) ?? setKey);
  const cardCount = numberValue(set.cardCount ?? set.totalCards) ?? cardsBySetCode.get(setCode) ?? null;
  return {
    value: setCode,
    label: stringValue(set.name) ?? setCode,
    metadata: optionalMetadata({
      setId: stringValue(set.id ?? setCode) ?? setCode,
      setCode,
      releaseDate: stringValue(set.releaseDate),
      prereleaseDate: stringValue(set.prereleaseDate),
      type: stringValue(set.type),
      setNumber: stringValue(set.number),
      cardCount: cardCount === null ? null : String(cardCount),
      formatVersion: metadata?.formatVersion ?? null,
      generatedOn: metadata?.generatedOn ?? null,
    }),
  };
}

function compactSetSourcePayload(
  metadata: LorcanajsonMetadata | undefined,
  set: NormalizedLorcanajsonSet,
): LorcanajsonCompactSetSourcePayload {
  return {
    provider: "lorcanajson",
    formatVersion: metadata?.formatVersion ?? null,
    generatedOn: metadata?.generatedOn ?? null,
    setId: set.setId,
    setCode: set.setCode,
    setName: set.setName,
    releaseDate: set.releaseDate,
    cardCount: set.cardCount,
  };
}

function findLorcanajsonCard(
  cards: readonly LorcanajsonCardData[],
  values: Readonly<Record<string, string>>,
): LorcanajsonCardData | null {
  const cardId = stringValue(values.cardId ?? values.id);
  const cardName = stringValue(values.cardName ?? values.name);
  const cardNumber = stringValue(values.cardNumber ?? values.collectorNumber ?? values.number);

  return (
    cards.find((card) => cardId && card.id === cardId) ??
    cards.find(
      (card) =>
        cardName &&
        normalizeLabel(card.fullName ?? card.simpleName ?? card.name) === normalizeLabel(cardName) &&
        (!cardNumber || normalizeLabel(card.number) === normalizeLabel(cardNumber)),
    ) ??
    cards.find((card) => cardNumber && normalizeLabel(card.number) === normalizeLabel(cardNumber)) ??
    null
  );
}

function countCardsBySetCode(cards: readonly LorcanajsonCardData[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const setCode = normalizeSetCode(stringValue(card.setCode) ?? "");
    if (!setCode) {
      continue;
    }
    counts.set(setCode, (counts.get(setCode) ?? 0) + 1);
  }
  return counts;
}

function lorcanajsonEnvelope(input: {
  unitKey: LorcanajsonUnitKey;
  externalKey: string;
  payload: LorcanajsonProviderPayload;
  sourceUrl: string;
  sourceUpdatedAt?: string | null;
  fetchedAt: string;
}): ProviderPayloadEnvelope<LorcanajsonProviderPayload> {
  return {
    unitKey: input.unitKey,
    providerKey: "lorcanajson",
    externalKey: input.externalKey,
    payload: input.payload,
    provenance: {
      sourceUrl: input.sourceUrl,
      sourceUpdatedAt: input.sourceUpdatedAt ?? undefined,
      fetchedAt: input.fetchedAt,
      contentHash: `sha256:${createHash("sha256").update(JSON.stringify(input.payload)).digest("hex")}`,
    },
  };
}

function lorcanajsonSetUrl(setCode: string, options: LorcanajsonProviderAdapterOptions): string {
  return lorcanajsonUrl(`sets/setdata.${normalizeSetCode(setCode)}.json`, options);
}

function lorcanajsonUrl(path: string, options: LorcanajsonProviderAdapterOptions): string {
  return `${(options.baseUrl ?? "https://lorcanajson.org/files/current/en").replace(/\/$/, "")}/${path}`;
}

function sourceUpdatedAt(metadata: LorcanajsonMetadata | undefined, releaseDate: string | null): string | null {
  return metadata?.generatedOn ?? releaseDate;
}

function imageUrlsFromCard(card: LorcanajsonCardData): readonly string[] {
  return [card.images?.full, card.images?.thumbnail].flatMap((value) => {
    const normalized = stringValue(value);
    return normalized ? [normalized] : [];
  });
}

function yearFromDate(date: string | null): string | null {
  return date && /^\d{4}/.test(date) ? date.slice(0, 4) : null;
}

function assertLorcanajsonUnit(unitKey: string): asserts unitKey is LorcanajsonUnitKey {
  if (
    unitKey !== LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY
  ) {
    throw new Error(`LorcanaJSON adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function lorcanajsonUnitKeys(): readonly [
  typeof LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  typeof LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
] {
  return [LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY];
}

function optionalMetadata(values: Readonly<Record<string, string | null>>): ProviderOptionItem["metadata"] {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function requireString(value: unknown, message: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const normalized = stringValue(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSetCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeLabel(value: unknown): string {
  return stringValue(value)?.toLowerCase() ?? "";
}

function lorcanajsonValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = lorcanajsonValidationResponses[String(input)];
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

const lorcanajsonValidationResponses: Readonly<Record<string, unknown>> = {
  "https://lorcanajson.org/files/current/en/allCards.json": {
    metadata: {
      formatVersion: "2.3.2",
      generatedOn: "2026-05-26T19:11:58",
      language: "en",
    },
    sets: {
      "1": {
        id: "1",
        code: "1",
        name: "The First Chapter",
        releaseDate: "2023-08-18",
        type: "expansion",
        number: 1,
      },
    },
    cards: [
      {
        id: "1-041",
        fullName: "Elsa - Snow Queen",
        number: "41",
        setCode: "1",
        rarity: "Super Rare",
        type: "Storyborn Hero Queen",
        color: "Amethyst",
        images: {
          full: "https://images.lorcanajson.org/cards/en/1/041.webp",
          thumbnail: "https://images.lorcanajson.org/cards/en/1/041-small.webp",
        },
        externalLinks: { tcgPlayerId: "1005010" },
      },
    ],
  },
  "https://lorcanajson.org/files/current/en/sets/setdata.1.json": {
    metadata: {
      formatVersion: "2.3.2",
      generatedOn: "2026-05-26T19:11:58",
      language: "en",
    },
    code: "1",
    name: "The First Chapter",
    releaseDate: "2023-08-18",
    cards: [
      {
        id: "1-041",
        fullName: "Elsa - Snow Queen",
        number: "41",
        setCode: "1",
        rarity: "Super Rare",
        type: "Storyborn Hero Queen",
        color: "Amethyst",
        images: {
          full: "https://images.lorcanajson.org/cards/en/1/041.webp",
          thumbnail: "https://images.lorcanajson.org/cards/en/1/041-small.webp",
        },
        externalLinks: { tcgPlayerId: "1005010" },
      },
    ],
  },
};
