import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun } from "../../catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../../catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../../catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../../integration-unit";
import type {
  ProviderAdapter,
  ProviderImportScope,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "../../provider-adapters/provider-adapter";

export const LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "lorcast",
  productDomain: "lorcana",
  productForm: "single-card",
  ingestionPurpose: "reference-data",
});

export const LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "lorcast",
  productDomain: "lorcana",
  productForm: "set",
  ingestionPurpose: "reference-data",
});

export const LORCAST_PRODUCTION_PROFILE_VERSION = "2026.06.23";
export const LORCAST_VALIDATION_PROFILE_VERSION = "lorcast-validation-2026.06.23";

export type LorcastProviderPayload =
  | Readonly<{
      kind: "lorcana-card-reference";
      languageCode: "en";
      observationId: string;
      externalKey: string;
      sourceUrl: string;
      sourceUpdatedAt: string | null;
      sourcePayload: LorcastCompactCardSourcePayload;
      catalogHashMaterial: LorcastCatalogHashMaterial;
      mergeIdentity: LorcastCardMergeIdentity;
      externalCatalogItemReferences: readonly LorcastExternalCatalogItemReference[];
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
      sourcePayload: LorcastCompactSetSourcePayload;
      catalogHashMaterial: LorcastCatalogHashMaterial;
      externalCatalogItemReferences: readonly [];
      setId: string;
      setCode: string;
      setName: string;
      name: string;
      releaseDate: string | null;
      releaseYear: string | null;
      cardCount: number | null;
    }>;

export type LorcastProviderAdapterOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => Date;
  profileVersion?: string;
}>;

type LorcastSetListResponse = Readonly<{
  results?: readonly LorcastSetData[];
}>;

type LorcastSetData = Readonly<{
  id?: string;
  name?: string;
  code?: string;
  released_at?: string;
  prereleased_at?: string;
}> &
  Readonly<Record<string, unknown>>;

type LorcastCardData = Readonly<{
  id?: string;
  name?: string;
  version?: string | null;
  released_at?: string;
  image_uris?: Readonly<{
    digital?: Readonly<{
      small?: string;
      normal?: string;
      large?: string;
    }>;
  }>;
  ink?: string | null;
  type?: readonly string[];
  rarity?: string;
  collector_number?: string;
  lang?: string;
  tcgplayer_id?: string | number | null;
  set?: Readonly<{
    id?: string;
    code?: string;
    name?: string;
  }>;
}> &
  Readonly<Record<string, unknown>>;

type LorcastCompactCardSourcePayload = Readonly<{
  provider: "lorcast";
  set: LorcastCompactSetSourcePayload;
  card: Readonly<{
    id: string;
    name: string;
    version: string | null;
    cardNumber: string;
    rarity: string | null;
    cardType: string | null;
    inkColor: string | null;
    tcgplayerProductId: string | null;
    imageUrls: readonly string[];
  }>;
}>;

type LorcastCompactSetSourcePayload = Readonly<{
  provider: "lorcast";
  setId: string;
  setCode: string;
  setName: string;
  releaseDate: string | null;
  prereleaseDate: string | null;
  cardCount: number | null;
}>;

type LorcastCatalogHashMaterial = Readonly<{
  provider: "lorcast";
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

type LorcastCardMergeIdentity = Readonly<{
  tcg: "lorcana";
  productLineName: "Disney Lorcana";
  setName: string;
  printedProductName: string;
  collectorNumber: string;
  languageCode: "en";
  productForm: "single-card";
}>;

type LorcastExternalCatalogItemReference = Readonly<{
  providerKey: "tcgplayer";
  externalKey: string;
}>;

type LorcastUnitKey =
  | typeof LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY
  | typeof LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY;

const lorcastProofFetchedAt = "2026-06-23T00:00:00.000Z";

export function createLorcastProviderAdapter(
  options: LorcastProviderAdapterOptions = {},
): ProviderAdapter<LorcastProviderPayload> {
  return {
    providerKey: "lorcast",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = options.profileVersion ?? LORCAST_PRODUCTION_PROFILE_VERSION;
      return [
        {
          unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          providerKey: "lorcast",
          productDomain: "lorcana",
          productForm: "single-card",
          ingestionPurpose: "reference-data",
          displayName: "Lorcast Lorcana single-card reference data",
          profileVersion,
        },
        {
          unitKey: LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
          providerKey: "lorcast",
          productDomain: "lorcana",
          productForm: "set",
          ingestionPurpose: "reference-data",
          displayName: "Lorcast Lorcana set reference data",
          profileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listLorcastOptions(input, options);
    },
    async planImport(scope) {
      assertLorcastUnit(scope.unitKey);
      const setCode = requireString(
        scope.values.setCode ?? scope.values.code ?? scope.values.setId ?? scope.values.expansionId,
        "Lorcast import planning requires setCode.",
      );

      if (scope.unitKey === LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY) {
        return {
          unitKey: scope.unitKey,
          planKey: `lorcast:set:${normalizeSetCode(setCode)}`,
          scope: { unitKey: scope.unitKey, scopeKey: "set", values: { ...scope.values, setCode } },
          estimatedPayloads: 1,
          transportSteps: [
            "Fetch Lorcast selected set endpoint",
            "Attach set reference provenance",
            "Prefer cached set payloads for repeat diagnostics",
          ],
          usageEstimate: lorcastUsageEstimate("One selected set request returns set metadata."),
        };
      }

      const cardId = stringValue(scope.values.cardId ?? scope.values.id);
      const cardName = stringValue(scope.values.cardName ?? scope.values.name);
      const cardNumber = stringValue(scope.values.cardNumber ?? scope.values.collectorNumber ?? scope.values.number);

      if (!cardId && !cardName && !cardNumber) {
        return {
          unitKey: scope.unitKey,
          planKey: `lorcast:cards:set:${normalizeSetCode(setCode)}`,
          scope: { unitKey: scope.unitKey, scopeKey: "set", values: { ...scope.values, setCode } },
          transportSteps: [
            "Fetch Lorcast set cards endpoint",
            "Attach card reference provenance",
            "Prefer cached set payloads for repeat diagnostics",
          ],
          usageEstimate: lorcastUsageEstimate("One selected-set cards request returns every card payload for the set."),
        };
      }

      return {
        unitKey: scope.unitKey,
        planKey: `lorcast:card:${normalizeSetCode(setCode)}:${cardId ?? `${cardName ?? "card"}:${cardNumber ?? "any"}`}`,
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
          "Fetch Lorcast set cards endpoint",
          "Select requested card payload",
          "Attach card reference provenance",
          "Prefer cached set payloads for repeat diagnostics",
        ],
        usageEstimate: lorcastUsageEstimate(
          "A selected-card import uses the set-scoped cards endpoint instead of per-card lookup.",
        ),
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertLorcastUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
      const setCode = requireString(plan.scope.values.setCode, "Lorcast payload fetch requires setCode.");

      if (plan.unitKey === LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY) {
        const sourceUrl = lorcastSetUrl(setCode, options);
        const set = normalizeLorcastSet(await fetchLorcastSet(setCode, options));
        yield lorcastEnvelope({
          unitKey: plan.unitKey,
          externalKey: `set:${set.setId}`,
          payload: createLorcastSetPayload({ set, sourceUrl }),
          sourceUrl,
          sourceUpdatedAt: set.releaseDate,
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({ phase: "fetching", completed: 1, total: 1, currentLabel: set.setName });
        return;
      }

      const sourceUrl = lorcastSetCardsUrl(setCode, options);
      const cards = await fetchLorcastSetCards(setCode, options);
      if (plan.scope.scopeKey === "set") {
        for (let index = 0; index < cards.length; index += 1) {
          const payload = createLorcastCardPayload({ card: cards[index] ?? {}, sourceUrl, cardCount: cards.length });
          yield lorcastEnvelope({
            unitKey: plan.unitKey,
            externalKey: payload.externalKey,
            payload,
            sourceUrl,
            sourceUpdatedAt: payload.releaseDate,
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

      const card = findLorcastCard(cards, plan.scope.values);
      if (!card) {
        throw new Error(`Lorcast set '${setCode}' did not include the requested card payload.`);
      }

      const payload = createLorcastCardPayload({ card, sourceUrl, cardCount: cards.length });
      yield lorcastEnvelope({
        unitKey: plan.unitKey,
        externalKey: payload.externalKey,
        payload,
        sourceUrl,
        sourceUpdatedAt: payload.releaseDate,
        fetchedAt,
      });
      await fetchOptions?.onProgress?.({ phase: "fetching", completed: 1, total: 1, currentLabel: payload.name });
    },
    async getCredentialReadiness() {
      return lorcastUnitKeys().map((unitKey) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "lorcast",
          unitKey,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.lorcast.credential.not.required"),
          evidence: { credentialRequirement: "not-required", publicApi: true },
        }),
      );
    },
    async getTransportDiagnostics() {
      return lorcastUnitKeys().map((unitKey) => ({
        code: "lorcast-public-api-transport-configured",
        severity: "info",
        message: t("catalog.features.sourceObservations.api.providerAdapters.lorcast.public.api.transport.configured"),
        unitKey,
      }));
    },
  };
}

export function createLorcastValidationProviderAdapter(): ProviderAdapter<LorcastProviderPayload> {
  return createLorcastProviderAdapter({
    fetch: lorcastValidationFetch,
    now: () => new Date(lorcastProofFetchedAt),
    profileVersion: LORCAST_VALIDATION_PROFILE_VERSION,
  });
}

export async function runLorcastCardReferenceValidationDryRun(
  adapter: ProviderAdapter<LorcastProviderPayload> = createLorcastValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "single-card",
    values: { setCode: "1", cardName: "Elsa", cardNumber: "41" },
  });
  const payloads: ProviderPayloadEnvelope<LorcastProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    profileVersion: LORCAST_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "lorcana-card-reference") {
        throw new Error("Lorcast card dry run received a non-card payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: LORCAST_VALIDATION_PROFILE_VERSION,
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

export async function runLorcastSetReferenceValidationDryRun(
  adapter: ProviderAdapter<LorcastProviderPayload> = createLorcastValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "set",
    values: { setCode: "1" },
  });
  const payloads: ProviderPayloadEnvelope<LorcastProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    profileVersion: LORCAST_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "lorcana-set-reference") {
        throw new Error("Lorcast set dry run received a non-set payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: LORCAST_VALIDATION_PROFILE_VERSION,
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

async function listLorcastOptions(
  input: ProviderOptionQueryInput,
  options: LorcastProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertLorcastUnit(input.unitKey);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "sets" || optionKind === "set") {
    const response = await fetchLorcastSets(options);
    return {
      items: (response.results ?? [])
        .map((set) => setOptionFromLorcastSet(normalizeLorcastSet(set)))
        .sort((left, right) => left.label.localeCompare(right.label)),
    };
  }

  if (optionKind === "cards" || optionKind === "card") {
    const setCode = requireString(
      input.parentValues?.setCode ?? input.parentValues?.parentValue,
      "Lorcast card option queries require a setCode parent value.",
    );
    const cards = await fetchLorcastSetCards(setCode, options);
    return {
      items: cards.map((card) => {
        const payload = createLorcastCardPayload({
          card,
          sourceUrl: lorcastSetCardsUrl(setCode, options),
          cardCount: cards.length,
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
            setId: payload.setId,
            setCode: payload.setCode,
            setName: payload.setName,
            cardNumber: payload.cardNumber,
            rarity: payload.rarity,
            cardType: payload.cardType,
            inkColor: payload.inkColor,
            tcgplayerProductId: payload.tcgplayerProductId,
            imageUrl: payload.imageUrls[0] ?? null,
            releaseDate: payload.releaseDate,
          }),
        };
      }),
    };
  }

  return { items: [] };
}

async function fetchLorcastSets(options: LorcastProviderAdapterOptions): Promise<LorcastSetListResponse> {
  return fetchJson(lorcastUrl("sets", options), options);
}

async function fetchLorcastSet(setCode: string, options: LorcastProviderAdapterOptions): Promise<LorcastSetData> {
  return fetchJson(lorcastUrl(`sets/${encodeURIComponent(normalizeSetCode(setCode))}`, options), options);
}

async function fetchLorcastSetCards(
  setCode: string,
  options: LorcastProviderAdapterOptions,
): Promise<readonly LorcastCardData[]> {
  return fetchJson(lorcastSetCardsUrl(setCode, options), options);
}

async function fetchJson<T>(url: string, options: LorcastProviderAdapterOptions): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(url);
  if (!response.ok) {
    throw new Error(`Lorcast request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

function createLorcastCardPayload(input: {
  card: LorcastCardData;
  sourceUrl: string;
  cardCount: number | null;
}): Extract<LorcastProviderPayload, { kind: "lorcana-card-reference" }> {
  const cardId = requireString(input.card.id, "Lorcast card payload did not include id.");
  const name = requireString(printedCardName(input.card), "Lorcast card payload did not include a name.");
  const cardNumber = requireString(
    input.card.collector_number,
    "Lorcast card payload did not include collector_number.",
  );
  const set = normalizeLorcastSet(input.card.set ?? {});
  const imageUrls = imageUrlsFromCard(input.card);
  const tcgplayerProductId = stringValue(input.card.tcgplayer_id);
  const releaseDate = stringValue(input.card.released_at) ?? set.releaseDate;
  const releaseYear = yearFromDate(releaseDate);
  const externalCatalogItemReferences = tcgplayerProductId
    ? [{ providerKey: "tcgplayer" as const, externalKey: `product:${tcgplayerProductId}` }]
    : [];
  const cardType = Array.isArray(input.card.type) ? input.card.type.join(" ") : null;
  const sourcePayload: LorcastCompactCardSourcePayload = {
    provider: "lorcast",
    set: compactSetSourcePayload({ ...set, cardCount: input.cardCount }),
    card: {
      id: cardId,
      name,
      version: stringValue(input.card.version),
      cardNumber,
      rarity: stringValue(input.card.rarity),
      cardType,
      inkColor: stringValue(input.card.ink),
      tcgplayerProductId,
      imageUrls,
    },
  };
  const catalogHashMaterial = {
    provider: "lorcast" as const,
    setId: set.setId,
    setCode: set.setCode,
    setName: set.setName,
    cardId,
    cardNumber,
    name,
    rarity: stringValue(input.card.rarity),
    tcgplayerProductId,
  };

  return {
    kind: "lorcana-card-reference",
    languageCode: "en",
    observationId: `lorcast_card_en_${cardId}`,
    externalKey: `card:${cardId}`,
    sourceUrl: input.sourceUrl,
    sourceUpdatedAt: releaseDate,
    sourcePayload,
    catalogHashMaterial,
    mergeIdentity: {
      tcg: "lorcana",
      productLineName: "Disney Lorcana",
      setName: set.setName,
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
    setId: set.setId,
    setCode: set.setCode,
    setName: set.setName,
    rarity: stringValue(input.card.rarity),
    cardType,
    inkColor: stringValue(input.card.ink),
    releaseDate,
    releaseYear,
    tcgplayerProductId,
  };
}

function createLorcastSetPayload(input: {
  set: NormalizedLorcastSet;
  sourceUrl: string;
}): Extract<LorcastProviderPayload, { kind: "lorcana-set-reference" }> {
  const sourcePayload = compactSetSourcePayload(input.set);
  const catalogHashMaterial = {
    provider: "lorcast" as const,
    setId: input.set.setId,
    setCode: input.set.setCode,
    setName: input.set.setName,
    releaseDate: input.set.releaseDate,
    cardCount: input.set.cardCount,
  };

  return {
    kind: "lorcana-set-reference",
    languageCode: "en",
    observationId: `lorcast_set_en_${input.set.setId}`,
    externalKey: `set:${input.set.setId}`,
    sourceUrl: input.sourceUrl,
    sourceUpdatedAt: input.set.releaseDate,
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

type NormalizedLorcastSet = Readonly<{
  setId: string;
  setCode: string;
  setName: string;
  releaseDate: string | null;
  prereleaseDate: string | null;
  cardCount: number | null;
}>;

function normalizeLorcastSet(set: LorcastSetData | NonNullable<LorcastCardData["set"]>): NormalizedLorcastSet {
  const setCode = normalizeSetCode(requireString(set.code, "Lorcast set payload did not include code."));
  const setName = requireString(set.name, "Lorcast set payload did not include name.");
  return {
    setId: stringValue(set.id) ?? setCode,
    setCode,
    setName,
    releaseDate: stringValue("released_at" in set ? set.released_at : null),
    prereleaseDate: stringValue("prereleased_at" in set ? set.prereleased_at : null),
    cardCount: null,
  };
}

function setOptionFromLorcastSet(set: NormalizedLorcastSet): ProviderOptionItem {
  return {
    value: set.setCode,
    label: set.setName,
    metadata: optionalMetadata({
      setId: set.setId,
      setCode: set.setCode,
      releaseDate: set.releaseDate,
      prereleaseDate: set.prereleaseDate,
      cacheGuidance: "cache-at-least-24h",
    }),
  };
}

function compactSetSourcePayload(set: NormalizedLorcastSet): LorcastCompactSetSourcePayload {
  return {
    provider: "lorcast",
    setId: set.setId,
    setCode: set.setCode,
    setName: set.setName,
    releaseDate: set.releaseDate,
    prereleaseDate: set.prereleaseDate,
    cardCount: set.cardCount,
  };
}

function findLorcastCard(
  cards: readonly LorcastCardData[],
  values: Readonly<Record<string, string>>,
): LorcastCardData | null {
  const cardId = stringValue(values.cardId ?? values.id);
  const cardName = stringValue(values.cardName ?? values.name);
  const cardNumber = stringValue(values.cardNumber ?? values.collectorNumber ?? values.number);

  return (
    cards.find((card) => cardId && card.id === cardId) ??
    cards.find(
      (card) =>
        cardName &&
        normalizeLabel(printedCardName(card)) === normalizeLabel(cardName) &&
        (!cardNumber || normalizeLabel(card.collector_number) === normalizeLabel(cardNumber)),
    ) ??
    cards.find((card) => cardNumber && normalizeLabel(card.collector_number) === normalizeLabel(cardNumber)) ??
    null
  );
}

function lorcastEnvelope(input: {
  unitKey: LorcastUnitKey;
  externalKey: string;
  payload: LorcastProviderPayload;
  sourceUrl: string;
  sourceUpdatedAt?: string | null;
  fetchedAt: string;
}): ProviderPayloadEnvelope<LorcastProviderPayload> {
  return {
    unitKey: input.unitKey,
    providerKey: "lorcast",
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

function lorcastSetUrl(setCode: string, options: LorcastProviderAdapterOptions): string {
  return lorcastUrl(`sets/${encodeURIComponent(normalizeSetCode(setCode))}`, options);
}

function lorcastSetCardsUrl(setCode: string, options: LorcastProviderAdapterOptions): string {
  return lorcastUrl(`sets/${encodeURIComponent(normalizeSetCode(setCode))}/cards`, options);
}

function lorcastUrl(path: string, options: LorcastProviderAdapterOptions): string {
  return `${(options.baseUrl ?? "https://api.lorcast.com/v0").replace(/\/$/, "")}/${path}`;
}

function imageUrlsFromCard(card: LorcastCardData): readonly string[] {
  return [card.image_uris?.digital?.large, card.image_uris?.digital?.normal, card.image_uris?.digital?.small].flatMap(
    (value) => {
      const normalized = stringValue(value);
      return normalized ? [normalized] : [];
    },
  );
}

function printedCardName(card: LorcastCardData): string | null {
  const name = stringValue(card.name);
  const version = stringValue(card.version);
  if (!name || !version || normalizeLabel(name).includes(normalizeLabel(version))) {
    return name;
  }
  return `${name} - ${version}`;
}

function yearFromDate(date: string | null): string | null {
  return date && /^\d{4}/.test(date) ? date.slice(0, 4) : null;
}

function assertLorcastUnit(unitKey: string): asserts unitKey is LorcastUnitKey {
  if (
    unitKey !== LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY
  ) {
    throw new Error(`Lorcast adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function lorcastUnitKeys(): readonly [
  typeof LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  typeof LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
] {
  return [LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY];
}

function lorcastUsageEstimate(estimateReason: string) {
  return {
    requestStrategy: "bulk-first" as const,
    estimateState: "estimated" as const,
    estimatedRequestCount: 1,
    estimateReason,
    pageSize: null,
    selectedFields: [],
    perRecordFallbackReason: null,
    usageCheckState: "not-supported" as const,
    creditDiagnostic: "Lorcast is a public API with no credentialed usage or credit endpoint.",
    degradedDiagnostic: "Respect Lorcast rate guidance: cache API data for at least 24 hours and pace requests.",
  };
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

function normalizeSetCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeLabel(value: unknown): string {
  return stringValue(value)?.toLowerCase() ?? "";
}

function lorcastValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = lorcastValidationResponses[String(input)];
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

const lorcastValidationResponses: Readonly<Record<string, unknown>> = {
  "https://api.lorcast.com/v0/sets": {
    results: [
      {
        id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
        name: "The First Chapter",
        code: "1",
        released_at: "2023-08-18",
        prereleased_at: "2023-08-18",
      },
    ],
  },
  "https://api.lorcast.com/v0/sets/1": {
    id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
    name: "The First Chapter",
    code: "1",
    released_at: "2023-08-18T00:00:00.000Z",
    prereleased_at: "2023-08-18T00:00:00.000Z",
  },
  "https://api.lorcast.com/v0/sets/1/cards": [
    {
      id: "crd_elsa_snow_queen_1_041",
      name: "Elsa - Snow Queen",
      version: null,
      released_at: "2023-08-18",
      image_uris: {
        digital: {
          small: "https://cards.lorcast.io/card/digital/small/crd_elsa_snow_queen_1_041.avif",
          normal: "https://cards.lorcast.io/card/digital/normal/crd_elsa_snow_queen_1_041.avif",
          large: "https://cards.lorcast.io/card/digital/large/crd_elsa_snow_queen_1_041.avif",
        },
      },
      ink: "Amethyst",
      type: ["Character"],
      rarity: "Super_rare",
      collector_number: "41",
      lang: "en",
      tcgplayer_id: 1005010,
      set: {
        id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
        code: "1",
        name: "The First Chapter",
      },
    },
  ],
};
