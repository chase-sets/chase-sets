import { createHash } from "node:crypto";

import { t } from "@chase-sets/localization";
import { runCatalogIntegrationDryRun } from "../../catalog-integration-engine";
import type { CatalogIntegrationDryRunResult } from "../../catalog-integration-engine";
import { createCatalogProviderCredentialReadiness } from "../../catalog-integration-credential-readiness";
import { defineCatalogIntegrationUnitKey } from "../../integration-unit";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderImportScope,
  ProviderOptionItem,
  ProviderOptionQueryInput,
  ProviderOptionQueryResult,
  ProviderPayloadEnvelope,
} from "../../provider-adapters/provider-adapter";

export const MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "mtgjson",
  productDomain: "mtg",
  productForm: "single-card",
  ingestionPurpose: "reference-data",
});

export const MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY = defineCatalogIntegrationUnitKey({
  providerKey: "mtgjson",
  productDomain: "mtg",
  productForm: "set",
  ingestionPurpose: "reference-data",
});

export const MTGJSON_PRODUCTION_PROFILE_VERSION = "2026.06.19";
export const MTGJSON_VALIDATION_PROFILE_VERSION = "mtgjson-validation-2026.06.08";

export type MtgjsonProviderPayload =
  | Readonly<{
      kind: "single-card";
      meta: MtgjsonMeta;
      set: MtgjsonSetData;
      card: MtgjsonCardData;
      sourceUrl: string;
    }>
  | Readonly<{
      kind: "set-reference";
      meta: MtgjsonMeta;
      set: MtgjsonSetData;
      sourceUrl: string;
    }>;

export type MtgjsonProviderAdapterOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => Date;
  profileVersion?: string;
}>;

type MtgjsonMeta = Readonly<{
  date?: string;
  version?: string;
}>;

type MtgjsonSetListResponse = Readonly<{
  meta?: MtgjsonMeta;
  data?: readonly MtgjsonSetListEntry[];
}>;

type MtgjsonSetResponse = Readonly<{
  meta?: MtgjsonMeta;
  data?: MtgjsonSetData;
}>;

type MtgjsonSetListEntry = Readonly<{
  code?: string;
  name?: string;
  releaseDate?: string;
  totalSetSize?: number;
  type?: string;
}>;

type MtgjsonSetData = MtgjsonSetListEntry &
  Readonly<{
    baseSetSize?: number;
    cards?: readonly MtgjsonCardData[];
  }>;

type MtgjsonCardData = Readonly<{
  uuid?: string;
  name?: string;
  number?: string;
  rarity?: string;
  layout?: string;
  type?: string;
  identifiers?: Readonly<Record<string, string | undefined>>;
  finishes?: readonly string[];
}>;

export function createMtgjsonProviderAdapter(
  options: MtgjsonProviderAdapterOptions = {},
): ProviderAdapter<MtgjsonProviderPayload> {
  return {
    providerKey: "mtgjson",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      const profileVersion = options.profileVersion ?? MTGJSON_PRODUCTION_PROFILE_VERSION;
      return [
        {
          unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          providerKey: "mtgjson",
          productDomain: "mtg",
          productForm: "single-card",
          ingestionPurpose: "reference-data",
          displayName: "MTGJSON MTG single-card reference data",
          profileVersion,
        },
        {
          unitKey: MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
          providerKey: "mtgjson",
          productDomain: "mtg",
          productForm: "set",
          ingestionPurpose: "reference-data",
          displayName: "MTGJSON MTG set reference data",
          profileVersion,
        },
      ];
    },
    async listOptions(input) {
      return listMtgjsonOptions(input, options);
    },
    async planImport(scope) {
      assertMtgjsonUnit(scope.unitKey);
      const setCode = requireString(
        scope.values.setCode ?? scope.values.code,
        "MTGJSON import planning requires setCode.",
      );

      if (scope.unitKey === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY) {
        return {
          unitKey: scope.unitKey,
          planKey: `mtgjson:set:${setCode.toUpperCase()}`,
          scope: { unitKey: scope.unitKey, scopeKey: "set", values: { ...scope.values, setCode } },
          estimatedPayloads: 1,
          transportSteps: ["Fetch MTGJSON set file", "Attach set reference provenance"],
        };
      }

      const cardName = stringValue(scope.values.cardName ?? scope.values.name);
      const collectorNumber = stringValue(scope.values.collectorNumber ?? scope.values.number);
      const uuid = stringValue(scope.values.uuid);

      if (!cardName && !uuid) {
        return {
          unitKey: scope.unitKey,
          planKey: `mtgjson:cards:set:${setCode.toUpperCase()}`,
          scope: {
            unitKey: scope.unitKey,
            scopeKey: "set",
            values: { ...scope.values, setCode },
          },
          transportSteps: ["Fetch MTGJSON set file", "Select all card payloads", "Attach card reference provenance"],
        };
      }

      return {
        unitKey: scope.unitKey,
        planKey: `mtgjson:card:${setCode.toUpperCase()}:${uuid ?? `${cardName}:${collectorNumber ?? "any"}`}`,
        scope: {
          unitKey: scope.unitKey,
          scopeKey: "single-card",
          values: { ...scope.values, setCode, ...(cardName ? { cardName } : {}), ...(uuid ? { uuid } : {}) },
        },
        estimatedPayloads: 1,
        transportSteps: ["Fetch MTGJSON set file", "Select card payload", "Attach card reference provenance"],
      };
    },
    async *fetchPayloads(plan, fetchOptions) {
      assertMtgjsonUnit(plan.unitKey);
      const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
      const setCode = requireString(plan.scope.values.setCode, "MTGJSON payload fetch requires setCode.");
      const sourceUrl = mtgjsonSetUrl(setCode, options);
      const response = await fetchMtgjsonSet(setCode, options);
      const set = response.data;

      if (!set) {
        throw new Error(`MTGJSON set '${setCode}' response did not include data.`);
      }

      if (plan.unitKey === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY) {
        yield mtgjsonEnvelope({
          unitKey: plan.unitKey,
          externalKey: `set:${normalizeSetCode(set.code ?? setCode)}`,
          payload: { kind: "set-reference", meta: response.meta ?? {}, set, sourceUrl },
          sourceUrl,
          sourceUpdatedAt: response.meta?.date ?? set.releaseDate,
          fetchedAt,
        });
        await fetchOptions?.onProgress?.({
          phase: "fetching",
          completed: 1,
          total: 1,
          currentLabel: set.name ?? normalizeSetCode(set.code ?? setCode),
        });
        return;
      }

      if (plan.scope.scopeKey === "set") {
        const cards = set.cards ?? [];
        for (let index = 0; index < cards.length; index += 1) {
          const card = cards[index] ?? {};
          yield mtgjsonEnvelope({
            unitKey: plan.unitKey,
            externalKey: `card:${card.uuid ?? `${normalizeSetCode(set.code ?? setCode)}:${card.number ?? card.name ?? "unknown"}`}`,
            payload: { kind: "single-card", meta: response.meta ?? {}, set, card, sourceUrl },
            sourceUrl,
            sourceUpdatedAt: response.meta?.date ?? set.releaseDate,
            fetchedAt,
          });
          await fetchOptions?.onProgress?.({
            phase: "fetching",
            completed: index + 1,
            total: cards.length,
            currentLabel: card.name ?? card.uuid ?? null,
          });
        }
        return;
      }

      const card = findMtgjsonCard(set.cards ?? [], plan.scope.values);
      if (!card) {
        throw new Error(`MTGJSON set '${setCode}' did not include the requested card payload.`);
      }

      yield mtgjsonEnvelope({
        unitKey: plan.unitKey,
        externalKey: `card:${card.uuid ?? `${normalizeSetCode(set.code ?? setCode)}:${card.number ?? card.name ?? "unknown"}`}`,
        payload: { kind: "single-card", meta: response.meta ?? {}, set, card, sourceUrl },
        sourceUrl,
        sourceUpdatedAt: response.meta?.date ?? set.releaseDate,
        fetchedAt,
      });
      await fetchOptions?.onProgress?.({
        phase: "fetching",
        completed: 1,
        total: 1,
        currentLabel: card.name ?? card.uuid ?? null,
      });
    },
    async getCredentialReadiness() {
      return mtgjsonUnitKeys().map((unitKey) =>
        createCatalogProviderCredentialReadiness({
          providerKey: "mtgjson",
          unitKey,
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          message: t("catalog.features.sourceObservations.api.providerAdapters.mtgjson.credential.not.required"),
          evidence: { credentialRequirement: "not-required", publicJson: true },
        }),
      );
    },
    async getTransportDiagnostics() {
      return mtgjsonUnitKeys().map((unitKey) => ({
        code: "mtgjson-public-json-transport-configured",
        severity: "info",
        message: t("catalog.features.sourceObservations.api.providerAdapters.mtgjson.public.json.transport.configured"),
        unitKey,
      }));
    },
  };
}

export function createMtgjsonValidationProviderAdapter(): ProviderAdapter<MtgjsonProviderPayload> {
  return createMtgjsonProviderAdapter({
    fetch: mtgjsonValidationFetch,
    now: () => new Date("2026-06-08T00:00:00.000Z"),
    profileVersion: MTGJSON_VALIDATION_PROFILE_VERSION,
  });
}

export async function runMtgjsonSourceObservationValidationDryRun(
  adapter: ProviderAdapter<MtgjsonProviderPayload> = createMtgjsonValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "single-card",
    values: { setCode: "TSP", cardName: "Fury Sliver", collectorNumber: "157" },
  });
  const payloads: ProviderPayloadEnvelope<MtgjsonProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    profileVersion: MTGJSON_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "single-card") {
        throw new Error("MTGJSON single-card dry run received a non-card payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: MTGJSON_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: stringValue(envelope.payload.card.name) ?? "",
          cardNumber: stringValue(envelope.payload.card.number) ?? "",
          setCode: stringValue(envelope.payload.set.code) ?? "",
          setName: stringValue(envelope.payload.set.name) ?? "",
          rarity: stringValue(envelope.payload.card.rarity) ?? "",
          layout: stringValue(envelope.payload.card.layout) ?? "",
          scryfallId: stringValue(envelope.payload.card.identifiers?.scryfallId) ?? "",
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

export async function runMtgjsonSetReferenceValidationDryRun(
  adapter: ProviderAdapter<MtgjsonProviderPayload> = createMtgjsonValidationProviderAdapter(),
): Promise<CatalogIntegrationDryRunResult> {
  const plan = await adapter.planImport({
    unitKey: MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
    scopeKey: "set",
    values: { setCode: "TSP" },
  });
  const payloads: ProviderPayloadEnvelope<MtgjsonProviderPayload>[] = [];

  for await (const payload of adapter.fetchPayloads(plan)) {
    payloads.push(payload);
  }

  return runCatalogIntegrationDryRun({
    unitKey: MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
    profileVersion: MTGJSON_VALIDATION_PROFILE_VERSION,
    payloads,
    normalize: (envelope) => {
      if (envelope.payload.kind !== "set-reference") {
        throw new Error("MTGJSON set-reference dry run received a non-set payload.");
      }

      return {
        unitKey: envelope.unitKey,
        providerKey: envelope.providerKey,
        externalKey: envelope.externalKey,
        profileVersion: MTGJSON_VALIDATION_PROFILE_VERSION,
        normalizedFacts: {
          name: stringValue(envelope.payload.set.name) ?? "",
          setCode: stringValue(envelope.payload.set.code) ?? "",
          setName: stringValue(envelope.payload.set.name) ?? "",
          releaseDate: stringValue(envelope.payload.set.releaseDate) ?? "",
          totalSetSize: stringValue(envelope.payload.set.totalSetSize) ?? "",
          mtgjsonVersion: stringValue(envelope.payload.meta.version) ?? "",
        },
        sourceUrl: envelope.provenance.sourceUrl,
        sourceUpdatedAt: envelope.provenance.sourceUpdatedAt,
        sourceHash: envelope.provenance.contentHash,
      };
    },
  });
}

async function listMtgjsonOptions(
  input: ProviderOptionQueryInput,
  options: MtgjsonProviderAdapterOptions,
): Promise<ProviderOptionQueryResult> {
  assertMtgjsonUnit(input.unitKey);
  const optionKind = input.optionKind.trim().toLowerCase();

  if (optionKind === "sets" || optionKind === "set") {
    const response = await fetchMtgjsonSetList(options);
    return {
      items: (response.data ?? []).map((item) => ({
        value: normalizeSetCode(item.code ?? ""),
        label: stringValue(item.name) ?? normalizeSetCode(item.code ?? ""),
        metadata: optionalMetadata({
          releaseDate: item.releaseDate ?? null,
          totalSetSize: item.totalSetSize === undefined ? null : String(item.totalSetSize),
          setCode: item.code ?? null,
          type: item.type ?? null,
          mtgjsonVersion: response.meta?.version ?? null,
        }),
      })),
    };
  }

  if (optionKind === "cards" || optionKind === "card") {
    const setCode = requireString(
      input.parentValues?.setCode ?? input.parentValues?.parentValue,
      "MTGJSON card option queries require a setCode parent value.",
    );
    const response = await fetchMtgjsonSet(setCode, options);
    return {
      items: (response.data?.cards ?? []).map((card) => ({
        value: stringValue(card.uuid) ?? `${normalizeSetCode(setCode)}:${card.number ?? card.name ?? "unknown"}`,
        label: [card.name, card.number].filter((value) => stringValue(value)).join(" #"),
        parentValue: normalizeSetCode(setCode),
        metadata: optionalMetadata({
          collectorNumber: card.number ?? null,
          rarity: card.rarity ?? null,
          layout: card.layout ?? null,
          setCode,
          setName: response.data?.name ?? null,
          scryfallId: card.identifiers?.scryfallId ?? null,
        }),
      })),
    };
  }

  return { items: [] };
}

async function fetchMtgjsonSetList(options: MtgjsonProviderAdapterOptions): Promise<MtgjsonSetListResponse> {
  return fetchJson(mtgjsonUrl("SetList.json", options), options);
}

async function fetchMtgjsonSet(setCode: string, options: MtgjsonProviderAdapterOptions): Promise<MtgjsonSetResponse> {
  return fetchJson(mtgjsonSetUrl(setCode, options), options);
}

async function fetchJson<T>(url: string, options: MtgjsonProviderAdapterOptions): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(url);
  if (!response.ok) {
    throw new Error(`MTGJSON request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

function mtgjsonSetUrl(setCode: string, options: MtgjsonProviderAdapterOptions): string {
  return mtgjsonUrl(`${normalizeSetCode(setCode)}.json`, options);
}

function mtgjsonUrl(path: string, options: MtgjsonProviderAdapterOptions): string {
  return `${(options.baseUrl ?? "https://mtgjson.com/api/v5").replace(/\/$/, "")}/${path}`;
}

function findMtgjsonCard(
  cards: readonly MtgjsonCardData[],
  values: Readonly<Record<string, string>>,
): MtgjsonCardData | null {
  const uuid = stringValue(values.uuid);
  const cardName = stringValue(values.cardName ?? values.name);
  const collectorNumber = stringValue(values.collectorNumber ?? values.number);

  return (
    cards.find((card) => uuid && card.uuid === uuid) ??
    cards.find(
      (card) =>
        cardName &&
        normalizeLabel(card.name) === normalizeLabel(cardName) &&
        (!collectorNumber || normalizeLabel(card.number) === normalizeLabel(collectorNumber)),
    ) ??
    null
  );
}

function mtgjsonEnvelope(input: {
  unitKey: string;
  externalKey: string;
  payload: MtgjsonProviderPayload;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
}): ProviderPayloadEnvelope<MtgjsonProviderPayload> {
  return {
    unitKey: input.unitKey,
    providerKey: "mtgjson",
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

function assertMtgjsonUnit(unitKey: string): void {
  if (
    unitKey !== MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY &&
    unitKey !== MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY
  ) {
    throw new Error(`MTGJSON adapter does not support Catalog integration unit '${unitKey}'.`);
  }
}

function mtgjsonUnitKeys(): readonly [
  typeof MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  typeof MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
] {
  return [MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY];
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

function mtgjsonValidationFetch(input: RequestInfo | URL): Promise<Response> {
  const response = mtgjsonValidationResponses[String(input)];
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

const mtgjsonValidationResponses: Readonly<Record<string, unknown>> = {
  "https://mtgjson.com/api/v5/SetList.json": {
    meta: { date: "2026-06-05", version: "5.3.0+20260605" },
    data: [
      {
        code: "TSP",
        name: "Time Spiral",
        releaseDate: "2006-10-06",
        totalSetSize: 301,
        type: "expansion",
      },
    ],
  },
  "https://mtgjson.com/api/v5/TSP.json": {
    meta: { date: "2026-06-05", version: "5.3.0+20260605" },
    data: {
      code: "TSP",
      name: "Time Spiral",
      releaseDate: "2006-10-06",
      totalSetSize: 301,
      cards: [
        {
          uuid: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
          name: "Fury Sliver",
          number: "157",
          rarity: "uncommon",
          layout: "normal",
          type: "Creature - Sliver",
          identifiers: {
            scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
          },
          finishes: ["foil", "nonfoil"],
        },
      ],
    },
  },
};
