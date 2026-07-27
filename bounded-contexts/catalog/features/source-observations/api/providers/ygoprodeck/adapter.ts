import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun, type CatalogIntegrationDryRunResult } from "../../catalog-integration-engine";
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

export const YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "ygoprodeck",
  productDomain: "yugioh",
  productForm: "single-card",
  ingestionPurpose: "reference-data",
});

export const YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "ygoprodeck",
  productDomain: "yugioh",
  productForm: "set",
  ingestionPurpose: "reference-data",
});

export const YGOPRODECK_PRODUCTION_PROFILE_VERSION = "2026.06.21";
export const YGOPRODECK_VALIDATION_PROFILE_VERSION = "ygoprodeck-validation-2026.06.21";

export type YgoprodeckProviderPayload =
  | Readonly<{
      kind: "single-card";
      card: YgoprodeckCard;
      selectedPrint: YgoprodeckCardSetPrint | null;
      sourceUrl: string;
    }>
  | Readonly<{
      kind: "set-reference";
      set: YgoprodeckCardSetReference;
      sourceUrl: string;
    }>;

export type YgoprodeckProviderAdapterOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => Date;
  profileVersion?: string;
  userAgent?: string;
}>;

type YgoprodeckCardInfoResponse = Readonly<{
  data?: readonly YgoprodeckCard[];
  meta?: Readonly<{
    current_rows?: number;
    total_rows?: number;
    rows_remaining?: number;
    total_pages?: number;
    pages_remaining?: number;
    next_page?: string;
  }>;
  error?: string;
}>;

type YgoprodeckCard = Readonly<{
  id?: number | string;
  name?: string;
  type?: string;
  frameType?: string;
  desc?: string;
  race?: string;
  attribute?: string;
  archetype?: string;
  card_sets?: readonly YgoprodeckCardSetPrint[];
  card_images?: readonly YgoprodeckCardImage[];
  card_prices?: readonly Readonly<Record<string, string | null>>[];
}>;

type YgoprodeckCardSetPrint = Readonly<{
  set_name?: string;
  set_code?: string;
  set_rarity?: string;
  set_rarity_code?: string;
  set_price?: string;
}>;

type YgoprodeckCardImage = Readonly<{
  id?: number | string;
  image_url?: string;
  image_url_small?: string;
  image_url_cropped?: string;
}>;

type YgoprodeckCardSetReference = Readonly<{
  set_name?: string;
  set_code?: string;
  num_of_cards?: number;
  tcg_date?: string;
}>;

export function createYgoprodeckProviderAdapter(
  options: YgoprodeckProviderAdapterOptions = {},
): ProviderAdapter<YgoprodeckProviderPayload> {
  return {
    providerKey: "ygoprodeck",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = options.profileVersion ?? YGOPRODECK_PRODUCTION_PROFILE_VERSION;
      return [
        {
          unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          providerKey: "ygoprodeck",
          productDomain: "yugioh",
          productForm: "single-card",
          ingestionPurpose: "reference-data",
          displayName: "YGOPRODeck Yu-Gi-Oh single-card reference data",
          profileVersion,
        },
        {
          unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
          providerKey: "ygoprodeck",
          productDomain: "yugioh",
          productForm: "set",
          ingestionPurpose: "reference-data",
          displayName: "YGOPRODeck Yu-Gi-Oh set reference data",
          profileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listYgoprodeckOptions(input, options);
    },
    async planImport(scope) {
      assertYgoprodeckUnit(scope.unitKey);
      if (scope.unitKey === YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY) {
        const setIdentity = requireSetIdentity(
          scope.values,
          "YGOPRODeck set import planning requires setName or setCode.",
        );
        return {
          unitKey: scope.unitKey,
          planKey: `ygoprodeck:set:${normalizePlanSegment(setIdentity)}`,
          scope: { unitKey: scope.unitKey, scopeKey: "set", values: { ...scope.values, setIdentity } },
          estimatedPayloads: 1,
          transportSteps: ["Fetch YGOPRODeck card set list", "Select set reference", "Attach set provenance"],
        };
      }

      const setIdentity = stringValue(
        scope.values.setName ?? scope.values.cardset ?? scope.values.setCode ?? scope.values.parentValue,
      );
      const cardId = stringValue(scope.values.cardId ?? scope.values.id ?? scope.values.passcode);
      const cardName = stringValue(scope.values.cardName ?? scope.values.name);
      const printCode = stringValue(scope.values.printCode ?? scope.values.setCode);

      if (setIdentity && !cardId && !cardName) {
        return {
          unitKey: scope.unitKey,
          planKey: `ygoprodeck:cards:set:${normalizePlanSegment(setIdentity)}`,
          scope: { unitKey: scope.unitKey, scopeKey: "set", values: { ...scope.values, setIdentity } },
          transportSteps: [
            "Fetch YGOPRODeck cards by card set",
            "Select card print payloads",
            "Attach card provenance",
          ],
        };
      }

      if (!cardId && !cardName) {
        throw new Error("YGOPRODeck card import planning requires setName, setCode, cardId, or cardName.");
      }

      return {
        unitKey: scope.unitKey,
        planKey: `ygoprodeck:card:${normalizePlanSegment(cardId ?? cardName ?? "unknown")}:${
          printCode ? normalizePlanSegment(printCode) : "any-print"
        }`,
        scope: {
          unitKey: scope.unitKey,
          scopeKey: "single-card",
          values: {
            ...scope.values,
            ...(setIdentity ? { setIdentity } : {}),
            ...(cardId ? { cardId } : {}),
            ...(cardName ? { cardName } : {}),
            ...(printCode ? { printCode } : {}),
          },
        },
        estimatedPayloads: 1,
        transportSteps: ["Fetch YGOPRODeck card information", "Select card print payload", "Attach card provenance"],
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertYgoprodeckUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();

      if (plan.unitKey === YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY) {
        const sets = await fetchYgoprodeckCardSets(options);
        const set = findYgoprodeckSet(sets, plan.scope.values);
        if (!set) {
          throw new Error("YGOPRODeck set reference payload was not found for the requested scope.");
        }
        yield ygoprodeckEnvelope({
          unitKey: plan.unitKey,
          externalKey: `set:${stringValue(set.set_code) ?? normalizePlanSegment(set.set_name ?? "unknown")}`,
          payload: { kind: "set-reference", set, sourceUrl: ygoprodeckUrl("cardsets.php", options) },
          sourceUrl: ygoprodeckUrl("cardsets.php", options),
          sourceUpdatedAt: set.tcg_date,
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: set.set_name ?? set.set_code ?? null,
        });
        return;
      }

      if (plan.scope.scopeKey === "set") {
        const setName = await resolveYgoprodeckSetName(plan.scope.values, options);
        const sourceUrl = ygoprodeckCardInfoUrl({ cardset: setName }, options);
        const cards = await fetchAllYgoprodeckCards({ cardset: setName }, options);
        for (let index = 0; index < cards.length; index += 1) {
          const card = sanitizeYgoprodeckCard(cards[index] ?? {});
          const selectedPrint = findYgoprodeckCardPrint(card, { setIdentity: setName });
          yield ygoprodeckEnvelope({
            unitKey: plan.unitKey,
            externalKey: ygoprodeckCardExternalKey(card, selectedPrint),
            payload: { kind: "single-card", card, selectedPrint, sourceUrl },
            sourceUrl,
            sourceUpdatedAt: selectedPrint?.set_name === setName ? undefined : undefined,
            fetchedAt,
          });
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed: index + 1,
            total: cards.length,
            currentLabel: card.name ?? stringValue(card.id),
          });
        }
        return;
      }

      const sourceQuery = cardInfoQueryFromScope(plan.scope);
      const sourceUrl = ygoprodeckCardInfoUrl(sourceQuery, options);
      const cards = await fetchAllYgoprodeckCards(sourceQuery, options);
      const card = findYgoprodeckCard(cards, plan.scope.values);
      if (!card) {
        throw new Error("YGOPRODeck card payload was not found for the requested scope.");
      }
      const sanitizedCard = sanitizeYgoprodeckCard(card);
      const selectedPrint = findYgoprodeckCardPrint(sanitizedCard, plan.scope.values);

      yield ygoprodeckEnvelope({
        unitKey: plan.unitKey,
        externalKey: ygoprodeckCardExternalKey(sanitizedCard, selectedPrint),
        payload: { kind: "single-card", card: sanitizedCard, selectedPrint, sourceUrl },
        sourceUrl,
        sourceUpdatedAt: undefined,
        fetchedAt,
      });
      await fetchOptions?.onProgress?.({
        phase: "fetching",
        completed: 1,
        total: 1,
        currentLabel: sanitizedCard.name ?? stringValue(sanitizedCard.id),
      });
    },
    async getCredentialReadiness() {
      return ygoprodeckUnitKeys().map((unitKey) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "ygoprodeck",
          unitKey,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.ygoprodeck.credential.not.required"),
          evidence: { credentialRequirement: "not-required", publicApi: true },
        }),
      );
    },
    async getTransportDiagnostics() {
      return ygoprodeckUnitKeys().map((unitKey) => ({
        code: "ygoprodeck-public-api-transport-configured",
        severity: "info",
        message: t(
          "catalog.features.sourceObservations.api.providerAdapters.ygoprodeck.public.api.transport.configured",
        ),
        unitKey,
        retryAfterSeconds: 1,
      }));
    },
  };
}

export function createYgoprodeckValidationProviderAdapter(): ProviderAdapter<YgoprodeckProviderPayload> {
  return createYgoprodeckProviderAdapter({
    fetch: ygoprodeckValidationFetch,
    now: () => new Date("2026-06-21T00:00:00.000Z"),
    profileVersion: YGOPRODECK_VALIDATION_PROFILE_VERSION,
  });
}

export async function runYgoprodeckCardReferenceValidationDryRun(
  adapter: ProviderAdapter<YgoprodeckProviderPayload> = createYgoprodeckValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "single-card",
    values: { cardName: "Dark Magician", setName: "Starter Deck: Yugi", printCode: "SDY-006" },
  });
  const payloads: ProviderPayloadEnvelope<YgoprodeckProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    profileVersion: YGOPRODECK_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "single-card") {
        throw new Error("YGOPRODeck single-card dry run received a non-card payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: YGOPRODECK_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: stringValue(envelope.payload.card.name) ?? "",
          passcode: stringValue(envelope.payload.card.id) ?? "",
          setName: stringValue(envelope.payload.selectedPrint?.set_name) ?? "",
          setCode: stringValue(envelope.payload.selectedPrint?.set_code) ?? "",
          rarity: stringValue(envelope.payload.selectedPrint?.set_rarity) ?? "",
          cardType: stringValue(envelope.payload.card.type) ?? "",
          frameType: stringValue(envelope.payload.card.frameType) ?? "",
          race: stringValue(envelope.payload.card.race) ?? "",
          attribute: stringValue(envelope.payload.card.attribute) ?? "",
          imageEvidenceCount: String(envelope.payload.card.card_images?.length ?? 0),
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

export async function runYgoprodeckSetReferenceValidationDryRun(
  adapter: ProviderAdapter<YgoprodeckProviderPayload> = createYgoprodeckValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "set",
    values: { setName: "Starter Deck: Yugi" },
  });
  const payloads: ProviderPayloadEnvelope<YgoprodeckProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    profileVersion: YGOPRODECK_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "set-reference") {
        throw new Error("YGOPRODeck set-reference dry run received a non-set payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: YGOPRODECK_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: stringValue(envelope.payload.set.set_name) ?? "",
          setCode: stringValue(envelope.payload.set.set_code) ?? "",
          releaseDate: stringValue(envelope.payload.set.tcg_date) ?? "",
          cardCount: stringValue(envelope.payload.set.num_of_cards) ?? "",
          productLineName: "Yu-Gi-Oh!",
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

async function listYgoprodeckOptions(
  input: ProviderOptionQueryInput,
  options: YgoprodeckProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertYgoprodeckUnit(input.unitKey);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "sets" || optionKind === "set") {
    const sets = await fetchYgoprodeckCardSets(options);
    return {
      items: sets.map((set) => ({
        value: requireString(set.set_name, "YGOPRODeck set option is missing set_name."),
        label: stringValue(set.set_name) ?? "",
        metadata: optionalMetadata({
          setName: set.set_name ?? null,
          setCode: set.set_code ?? null,
          cardCount: set.num_of_cards === undefined ? null : String(set.num_of_cards),
          releaseDate: set.tcg_date ?? null,
        }),
      })),
    };
  }

  if (optionKind === "cards" || optionKind === "card") {
    const setName = await resolveYgoprodeckSetName(
      {
        setName: input.parentValues?.setName,
        cardset: input.parentValues?.cardset,
        setCode: input.parentValues?.setCode ?? input.parentValues?.parentValue,
        parentValue: input.parentValues?.parentValue,
      },
      options,
    );
    const cards = await fetchAllYgoprodeckCards({ cardset: setName }, options);
    return {
      items: cards.map((card) => {
        const sanitizedCard = sanitizeYgoprodeckCard(card);
        const selectedPrint = findYgoprodeckCardPrint(sanitizedCard, { setIdentity: setName });
        return cardOptionItem(sanitizedCard, selectedPrint, setName);
      }),
    };
  }

  return { items: [] };
}

async function fetchYgoprodeckCardSets(
  options: YgoprodeckProviderAdapterOptions,
): Promise<readonly YgoprodeckCardSetReference[]> {
  return fetchJson<readonly YgoprodeckCardSetReference[]>(ygoprodeckUrl("cardsets.php", options), options);
}

async function fetchAllYgoprodeckCards(
  query: Readonly<Record<string, string>>,
  options: YgoprodeckProviderAdapterOptions,
): Promise<readonly YgoprodeckCard[]> {
  const cards: YgoprodeckCard[] = [];
  let nextUrl: string | null = ygoprodeckCardInfoUrl(query, options);

  while (nextUrl) {
    const response: YgoprodeckCardInfoResponse = await fetchJson(nextUrl, options);
    cards.push(...(response.data ?? []));
    nextUrl = response.meta?.next_page ?? null;
  }

  return cards;
}

async function fetchJson<T>(url: string, options: YgoprodeckProviderAdapterOptions): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers: {
      "User-Agent":
        options.userAgent ??
        "ChaseSetsCatalogValidation/1.0 (engineering-validation; https://github.com/chase-sets/chase-sets)",
      Accept: "application/json;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`YGOPRODeck request failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as T & { error?: string };
  if (body && typeof body === "object" && typeof body.error === "string") {
    throw new Error(`YGOPRODeck request failed: ${body.error}`);
  }
  return body;
}

async function resolveYgoprodeckSetName(
  values: Readonly<Record<string, string | undefined>>,
  options: YgoprodeckProviderAdapterOptions,
): Promise<string> {
  const setName = stringValue(values.setName ?? values.cardset);
  if (setName) {
    return setName;
  }

  const setCode = stringValue(values.setCode ?? values.parentValue);
  if (!setCode) {
    throw new Error("YGOPRODeck card option queries require a setName or setCode parent value.");
  }

  const sets = await fetchYgoprodeckCardSets(options);
  const set = findYgoprodeckSet(sets, { setCode });
  if (!set?.set_name) {
    throw new Error(`YGOPRODeck set code '${setCode}' did not resolve to a set name.`);
  }
  return set.set_name;
}

function cardInfoQueryFromScope(scope: ProviderImportScope): Readonly<Record<string, string>> {
  const cardId = stringValue(scope.values.cardId ?? scope.values.id ?? scope.values.passcode);
  if (cardId) {
    return { id: cardId };
  }

  const cardName = requireString(
    scope.values.cardName ?? scope.values.name,
    "YGOPRODeck card fetch requires cardId or cardName.",
  );
  return { name: cardName };
}

function findYgoprodeckSet(
  sets: readonly YgoprodeckCardSetReference[],
  values: Readonly<Record<string, string>>,
): YgoprodeckCardSetReference | null {
  const setIdentity = stringValue(values.setIdentity);
  const setName = stringValue(values.setName ?? values.cardset);
  const setCode = stringValue(values.setCode);
  const lookup = normalizeLookup(setIdentity ?? setName ?? setCode);

  return (
    sets.find((set) => lookup && normalizeLookup(set.set_name) === lookup) ??
    sets.find((set) => lookup && normalizeLookup(set.set_code) === lookup) ??
    null
  );
}

function findYgoprodeckCard(
  cards: readonly YgoprodeckCard[],
  values: Readonly<Record<string, string>>,
): YgoprodeckCard | null {
  const cardId = stringValue(values.cardId ?? values.id ?? values.passcode);
  const cardName = stringValue(values.cardName ?? values.name);

  return (
    cards.find((card) => cardId && stringValue(card.id) === cardId) ??
    cards.find((card) => cardName && normalizeLookup(card.name) === normalizeLookup(cardName)) ??
    null
  );
}

function findYgoprodeckCardPrint(
  card: YgoprodeckCard,
  values: Readonly<Record<string, string>>,
): YgoprodeckCardSetPrint | null {
  const printCode = stringValue(values.printCode ?? values.setCode);
  const setIdentity = stringValue(values.setIdentity ?? values.setName ?? values.cardset);
  const prints = card.card_sets ?? [];

  return (
    prints.find((print) => printCode && normalizeLookup(print.set_code) === normalizeLookup(printCode)) ??
    prints.find((print) => setIdentity && normalizeLookup(print.set_name) === normalizeLookup(setIdentity)) ??
    prints[0] ??
    null
  );
}

function cardOptionItem(
  card: YgoprodeckCard,
  selectedPrint: YgoprodeckCardSetPrint | null,
  setName: string,
): ProviderOptionItem {
  const cardId = requireString(card.id, "YGOPRODeck card option is missing id.");
  const printCode = stringValue(selectedPrint?.set_code);
  return {
    value: printCode ? `${cardId}:${printCode}` : cardId,
    label: [card.name, printCode].filter((value) => stringValue(value)).join(" #"),
    parentValue: setName,
    metadata: optionalMetadata({
      cardId,
      setName: selectedPrint?.set_name ?? setName,
      setCode: selectedPrint?.set_code ?? null,
      rarity: selectedPrint?.set_rarity ?? null,
      cardType: card.type ?? null,
      frameType: card.frameType ?? null,
      race: card.race ?? null,
      attribute: card.attribute ?? null,
      archetype: card.archetype ?? null,
      imageEvidenceAvailable: card.card_images && card.card_images.length > 0 ? "true" : null,
    }),
  };
}

function sanitizeYgoprodeckCard(card: YgoprodeckCard): YgoprodeckCard {
  const { card_prices: _cardPrices, card_sets, ...cardWithoutPrices } = card;
  return {
    ...cardWithoutPrices,
    card_sets: card_sets?.map(({ set_price: _setPrice, ...print }) => print),
  };
}

function ygoprodeckEnvelope(input: {
  unitKey: string;
  externalKey: string;
  payload: YgoprodeckProviderPayload;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
}): ProviderPayloadEnvelope<YgoprodeckProviderPayload> {
  return {
    unitKey: input.unitKey,
    providerKey: "ygoprodeck",
    externalKey: input.externalKey,
    payload: input.payload,
    provenance: {
      sourceUrl: input.sourceUrl,
      sourceUpdatedAt: input.sourceUpdatedAt,
      fetchedAt: input.fetchedAt,
      contentHash: `sha256:${createHash("sha256").update(JSON.stringify(input.payload)).digest("hex")}`,
    },
  };
}

function ygoprodeckCardExternalKey(card: YgoprodeckCard, selectedPrint: YgoprodeckCardSetPrint | null): string {
  return `card:${requireString(card.id, "YGOPRODeck card payload is missing id.")}:${
    stringValue(selectedPrint?.set_code) ?? "unknown-print"
  }`;
}

function ygoprodeckCardInfoUrl(
  query: Readonly<Record<string, string>>,
  options: YgoprodeckProviderAdapterOptions,
): string {
  const params = new URLSearchParams(query);
  return `${ygoprodeckUrl("cardinfo.php", options)}?${params.toString()}`;
}

function ygoprodeckUrl(path: string, options: YgoprodeckProviderAdapterOptions): string {
  return `${(options.baseUrl ?? "https://db.ygoprodeck.com/api/v7").replace(/\/$/, "")}/${path}`;
}

function assertYgoprodeckUnit(unitKey: string): void {
  if (
    unitKey !== YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY
  ) {
    throw new Error(`YGOPRODeck adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function ygoprodeckUnitKeys(): readonly [
  typeof YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  typeof YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
] {
  return [YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY];
}

function requireSetIdentity(values: Readonly<Record<string, string>>, message: string): string {
  return requireString(values.setIdentity ?? values.setName ?? values.cardset ?? values.setCode, message);
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

function normalizeLookup(value: unknown): string {
  return stringValue(value)?.toLowerCase() ?? "";
}

function normalizePlanSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function ygoprodeckValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = ygoprodeckValidationResponses[String(input)];
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

const ygoprodeckValidationCard = {
  id: 46986414,
  name: "Dark Magician",
  type: "Normal Monster",
  frameType: "normal",
  desc: "The ultimate wizard in terms of attack and defense.",
  race: "Spellcaster",
  attribute: "DARK",
  archetype: "Dark Magician",
  card_sets: [
    {
      set_name: "Starter Deck: Yugi",
      set_code: "SDY-006",
      set_rarity: "Ultra Rare",
      set_rarity_code: "(UR)",
      set_price: "3.21",
    },
  ],
  card_images: [
    {
      id: 46986414,
      image_url: "https://images.ygoprodeck.com/images/cards/46986414.jpg",
      image_url_small: "https://images.ygoprodeck.com/images/cards_small/46986414.jpg",
      image_url_cropped: "https://images.ygoprodeck.com/images/cards_cropped/46986414.jpg",
    },
  ],
  card_prices: [
    {
      cardmarket_price: "0.10",
      tcgplayer_price: "0.25",
      ebay_price: "0.99",
      amazon_price: "1.50",
      coolstuffinc_price: "0.49",
    },
  ],
};

const ygoprodeckValidationResponses: Readonly<Record<string, unknown>> = {
  "https://db.ygoprodeck.com/api/v7/cardsets.php": [
    {
      set_name: "Starter Deck: Yugi",
      set_code: "SDY",
      num_of_cards: 50,
      tcg_date: "2002-03-29",
    },
  ],
  "https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=Starter+Deck%3A+Yugi": {
    data: [ygoprodeckValidationCard],
  },
  "https://db.ygoprodeck.com/api/v7/cardinfo.php?name=Dark+Magician": {
    data: [ygoprodeckValidationCard],
  },
  "https://db.ygoprodeck.com/api/v7/cardinfo.php?id=46986414": {
    data: [ygoprodeckValidationCard],
  },
};
