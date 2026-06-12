import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRecordCommand, ReferenceTypeCommand } from "../../reference-data/domain/domain";
import type { SourceObservationPokemonCardNormalized } from "../domain/domain";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import type {
  TcgplayerAutomationCatalogClient,
  TcgplayerAutomationProductDetail,
} from "./tcgplayer-automation-catalog-client";

export const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_test" as UserId,
    forAccountId: "acc_test" as AccountId,
  },
};

export type ReferenceTypeRow = {
  reference_type_id: string;
  key: string;
};

export type ReferenceRecordRow = {
  reference_record_id: string;
  type_key: string;
  key: string;
  attributes: Readonly<Record<string, JsonValue>>;
};

export function createActiveTcgplayerProfileVersions(): {
  listProfileVersions: (
    providerKey?: string | null,
  ) => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
  getActiveProfileVersion: (providerKey: string) => Promise<CatalogProviderIntegrationProfileVersionRecord | null>;
} {
  const versions = catalogProviderIntegrationProfileVersions.map((version) =>
    version.providerKey === "tcgplayer"
      ? {
          ...version,
          lifecycle: "active" as const,
          active: true,
          profile: {
            ...version.profile,
            status: "active" as const,
          },
        }
      : version,
  );
  return {
    listProfileVersions: async (providerKey?: string | null) => {
      const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
      return normalizedProviderKey
        ? versions.filter((version) => version.providerKey === normalizedProviderKey)
        : versions;
    },
    getActiveProfileVersion: async (providerKey: string) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      return (
        versions.find(
          (version) =>
            version.providerKey === normalizedProviderKey && version.active && version.lifecycle === "active",
        ) ?? null
      );
    },
  };
}

export function createMutableProfileVersionReader(
  initialVersions: readonly CatalogProviderIntegrationProfileVersionRecord[],
) {
  let versions = [...initialVersions];
  return {
    listProfileVersions: async (providerKey?: string | null) => {
      const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
      return normalizedProviderKey
        ? versions.filter((version) => version.providerKey === normalizedProviderKey)
        : versions;
    },
    getActiveProfileVersion: async (providerKey: string) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      return (
        versions.find(
          (version) =>
            version.providerKey === normalizedProviderKey && version.active && version.lifecycle === "active",
        ) ?? null
      );
    },
    activate: (providerKey: string, profileVersion: string) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      versions = versions.map((version) => {
        if (version.providerKey !== normalizedProviderKey) {
          return version;
        }
        const active = version.profileVersion === profileVersion;
        return {
          ...version,
          lifecycle: active ? ("active" as const) : ("deprecated" as const),
          active,
          executableMappingContract: version.executableMappingContract
            ? {
                ...version.executableMappingContract,
                lifecycle: active ? ("active" as const) : ("deprecated" as const),
              }
            : undefined,
        };
      });
    },
  };
}

export function tcgdexProfileVersion(input: {
  profileVersion: string;
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
  active: boolean;
  displayName: string;
}): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexProfileVersion();
  return {
    ...base,
    profileVersion: input.profileVersion,
    lifecycle: input.lifecycle,
    active: input.active,
    profile: {
      ...base.profile,
      displayName: input.displayName,
    },
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileVersion: input.profileVersion,
          lifecycle: input.lifecycle,
        }
      : undefined,
  };
}

export function providerProfileVersionForProvider(
  providerKey: string,
  profileKey: string,
  profileVersion: string,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexProfileVersion();

  return {
    ...base,
    providerKey,
    profileKey,
    profileVersion,
    lifecycle: "active",
    active: true,
    profile: {
      ...base.profile,
      providerKey,
      displayName: `${providerKey} Pokemon profile`,
    },
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          providerKey,
          profileKey,
          profileVersion,
          lifecycle: "active",
        }
      : undefined,
  };
}

export function tcgdexProfileSnapshot(profileVersion: string): Record<string, unknown> {
  return {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    profileVersion,
    lifecycle: "active",
    connectorKind: "tcgdex-json",
    connectorSourceVersion: null,
    sourceMappingFingerprint: `fingerprint:${profileVersion}`,
  };
}

export function currentTcgdexProfileVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === "tcgdex");
  if (!version) {
    throw new Error("Expected seeded TCGdex profile version.");
  }
  return version;
}

export function pokemonObservation(input: {
  expansionName: string;
  seriesName: string;
  cardNumber?: string;
  expansionCardCount?: number | null;
  name?: string;
  rarity?: string | null;
  cardVariantKey?: string;
  cardVariantLabel?: string;
  cardVariantSourceKey?: string | null;
  parallelSet?: boolean;
}): SourceObservationPokemonCardNormalized {
  return {
    kind: "pokemon-card",
    tcg: "pokemon",
    languageCode: "en",
    name: input.name ?? "Furret",
    cardNumber: input.cardNumber ?? "136",
    setId: "me02.5",
    setName: input.expansionName,
    expansionId: "me02.5",
    expansionName: input.expansionName,
    expansionAbbreviation: "MEH",
    expansionCardCount: input.expansionCardCount === undefined ? 217 : input.expansionCardCount,
    expansionParallelSetCardCount: 78,
    seriesId: "me",
    seriesName: input.seriesName,
    rarity: input.rarity ?? "Uncommon",
    illustrator: "tetsuya koizumi",
    releaseDate: "2026-05-18",
    releaseYear: 2026,
    category: "Pokemon",
    imageBaseUrl: null,
    imageUrls: [],
    productAssetSet: null,
    parallelSet: input.parallelSet ?? true,
    cardVariantKey: input.cardVariantKey ?? "reverse-holo",
    cardVariantLabel: input.cardVariantLabel ?? "Parallel Set - Reverse Foil",
    cardVariantSourceKey: input.cardVariantSourceKey ?? "reverse",
    cardVariantIsPrimaryImage: false,
    imageDisclaimer:
      "TCGDex provides one image for this card number. This Catalog Item represents the Parallel Set - Reverse Foil variant, so the image may not show the exact foil or pattern.",
    variants: {},
  };
}

export function sourceObservationDetailRow(overrides: Record<string, unknown> = {}) {
  const normalized = pokemonObservation({
    expansionName: "Base Set",
    seriesName: "Base",
    name: "Selected Observation",
  });

  return {
    observation_id: "obs_selected",
    provider_key: "tcgdex",
    external_key: "base1-1",
    source_url: "https://api.tcgdex.net/v2/en/cards/base1-1",
    language_code: "en",
    source_record_hash: "hash-selected",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    source_mapping_fingerprint: "fingerprint:2026.06.03",
    normalized,
    source_payload: { id: "base1-1" },
    status: "promoted",
    status_reason: null,
    promoted_catalog_item_id: "cat_selected",
    promoted_at: "2026-05-20T00:01:00.000Z",
    promotion_profile_key: "pokemon-tcg",
    promotion_profile_version: "2026.06.03",
    promotion_plan_fingerprint: "plan-fingerprint:2026.06.03",
    updated_at: "2026-05-20T00:01:00.000Z",
    ...overrides,
  };
}

export function createTcgplayerImportHarness(input: { failProductIds?: ReadonlySet<number> } = {}) {
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const productDetails = new Map<number, TcgplayerAutomationProductDetail>([
    [610001, tcgplayerProductDetail({ productId: 610001, productName: "Eevee ex", number: "131", sku: 987654 })],
    [610002, tcgplayerProductDetail({ productId: 610002, productName: "Umbreon ex", number: "161", sku: 987655 })],
  ]);
  const client: TcgplayerAutomationCatalogClient = {
    listProductLines: async () => [
      {
        productLineId: 3,
        productLineName: "Pokemon",
        productLineUrlName: "pokemon",
        isDirect: true,
      },
    ],
    listCatalogSetNames: async () => ({
      errors: [],
      results: [
        {
          setNameId: 7001,
          categoryId: 3,
          name: "Prismatic Evolutions",
          cleanSetName: "Prismatic Evolutions",
          urlName: "prismatic-evolutions",
          abbreviation: "PRE",
          releaseDate: "2025-01-17",
          isSupplemental: false,
          active: true,
        },
      ],
    }),
    searchProducts: async () => ({
      errors: [],
      results: [],
    }),
    listAllProducts: async () => [
      {
        productId: 610001,
        productName: "Eevee ex",
        productLineId: 3,
        productLineName: "Pokemon",
        productTypeName: "Cards",
        setId: 7001,
        setName: "Prismatic Evolutions",
        setUrlName: "prismatic-evolutions",
        rarityName: "Special Illustration Rare",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "131", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
      },
      {
        productId: 610002,
        productName: "Umbreon ex",
        productLineId: 3,
        productLineName: "Pokemon",
        productTypeName: "Cards",
        setId: 7001,
        setName: "Prismatic Evolutions",
        setUrlName: "prismatic-evolutions",
        rarityName: "Special Illustration Rare",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "161", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
      },
    ],
    getProductDetail: async ({ productId }) => {
      if (input.failProductIds?.has(productId)) {
        throw new Error(`Product ${productId} unavailable.`);
      }
      const detail = productDetails.get(productId);
      if (!detail) {
        throw new Error(`Product ${productId} not found.`);
      }
      return detail;
    },
  };
  const deps = {
    db: {
      query: async <T>() => ({ rowCount: 0, rows: [] as T[] }),
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async (eventInput: {
        streamId: string;
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        appendedSourceEvents.push(...eventInput.events);
        return eventInput.events.map((event, index) =>
          storedEvent(index + 1, eventInput.streamId, event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
    tcgplayerAutomationCatalogClient: client,
  } as object as CatalogRuntimeDeps;

  return {
    deps,
    client,
    appendedSourceEvents,
  };
}

export function tcgplayerProductDetail(input: {
  productId: number;
  productName: string;
  number: string;
  sku: number;
}): TcgplayerAutomationProductDetail {
  return {
    productTypeName: "Cards",
    rarityName: "Special Illustration Rare",
    sealed: false,
    productName: input.productName,
    setId: 7001,
    setCode: "PRE",
    productId: input.productId,
    setName: "Prismatic Evolutions",
    productLineId: 3,
    productStatusId: 1,
    productLineName: "Pokemon",
    customAttributes: {
      number: input.number,
      releaseDate: "2025-01-17",
      cardType: ["Pokemon"],
    },
    formattedAttributes: {
      Artist: "Catalog Artist",
    },
    skus: [
      {
        sku: input.sku,
        condition: "Near Mint",
        variant: "Normal",
        language: "English",
      },
    ],
    marketPrice: 12.34,
    lowestPrice: 10.01,
    lowestPriceWithShipping: 11.23,
    medianPrice: 12.5,
    listings: 25,
  };
}

export function createIntegrationJobDedupeHarness(
  input: { existingJob?: Record<string, unknown>; reapplyObservationIds?: readonly string[] } = {},
) {
  let existingJob = input.existingJob ? { ...input.existingJob } : undefined;
  const insertedJobs: Record<string, unknown>[] = [];
  const insertedWorkUnits: Array<Readonly<{ unitId: string; unitKind: string; payload: Record<string, unknown> }>> = [];
  const jobEvents: Record<string, unknown>[] = [];
  let queryCount = 0;
  let activeLookupValues: readonly unknown[] = [];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        queryCount += 1;

        if (
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("status IN ('queued', 'running')")
        ) {
          activeLookupValues = values;
          return {
            rowCount: existingJob ? 1 : 0,
            rows: (existingJob ? [existingJob] : []) as T[],
          };
        }

        if (sql.includes("SELECT observation_id FROM catalog_source_observations")) {
          const rows = (input.reapplyObservationIds ?? []).map((observationId) => ({
            observation_id: observationId,
          }));
          return { rowCount: rows.length, rows: rows as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_durable_jobs")) {
          const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
          const row = integrationJobRow({
            jobId: String(values[0]),
            action: String(values[1]),
            scope: payload.scope as Record<string, unknown>,
            profileSnapshot: payload.profileSnapshot as Record<string, unknown> | null,
            reapplyProfileMode: payload.reapplyProfileMode as string | null,
            eventContext: JSON.parse(String(values[4])) as EventStoreContext,
            progress: JSON.parse(String(values[3])) as Record<string, unknown>,
          });
          insertedJobs.push(row);
          return { rowCount: 1, rows: [row] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_work_units")) {
          const units = JSON.parse(String(values[1])) as Array<{
            unit_id: string;
            unit_kind: string;
            payload: Record<string, unknown>;
          }>;
          insertedWorkUnits.push(
            ...units.map((unit) => ({
              unitId: unit.unit_id,
              unitKind: unit.unit_kind,
              payload: unit.payload,
            })),
          );
          return { rowCount: units.length, rows: [] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_job_events")) {
          jobEvents.push({
            jobKind: "integration",
            jobId: values[0],
            snapshot: JSON.parse(String(values[1])) as Record<string, unknown>,
          });
          return { rowCount: 1, rows: [{ sequence: jobEvents.length }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("completed_at = NULL") &&
          existingJob?.job_id === values[0]
        ) {
          const currentJob = existingJob!;
          existingJob = {
            ...currentJob,
            status: "queued",
            progress: JSON.parse(String(values[1])),
            result: values[2] == null ? currentJob.result : JSON.parse(String(values[2])),
            error_message: values[3] as string | null,
            claim_owner_id: null,
            claimed_until: null,
            completed_at: null,
            updated_at: "2026-05-28T00:00:10.000Z",
          };
          return { rowCount: 1, rows: [existingJob] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("status = 'failed'") &&
          existingJob?.job_id === values[0]
        ) {
          const currentJob = existingJob!;
          existingJob = {
            ...currentJob,
            status: "failed",
            progress: JSON.parse(String(values[1])),
            error_message: String(values[2]),
            claim_owner_id: null,
            claimed_until: null,
            completed_at: "2026-05-28T00:00:10.000Z",
            updated_at: "2026-05-28T00:00:10.000Z",
          };
          return { rowCount: 1, rows: [existingJob] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("WHERE job_id = $1")
        ) {
          const row =
            existingJob?.job_id === values[0] ? existingJob : insertedJobs.find((job) => job.job_id === values[0]);
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async () => [],
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as object as CatalogRuntimeDeps;

  return {
    deps,
    insertedJobs,
    insertedWorkUnits,
    jobEvents,
    get activeLookupValues() {
      return activeLookupValues;
    },
    get queryCount() {
      return queryCount;
    },
  };
}

export function integrationJobRow(input: {
  jobId: string;
  action: string;
  scope: Record<string, unknown>;
  profileSnapshot?: Record<string, unknown> | null;
  reapplyProfileMode?: string | null;
  eventContext: EventStoreContext;
  progress?: Record<string, unknown>;
}) {
  return {
    job_id: input.jobId,
    job_kind: input.action,
    payload: {
      action: input.action,
      scope: input.scope,
      profileSnapshot: input.profileSnapshot ?? null,
      reapplyProfileMode: input.reapplyProfileMode ?? null,
    },
    event_context: input.eventContext,
    status: "queued",
    progress:
      input.progress ??
      ({
        phase: "queued",
        completed: 0,
        total: 0,
        currentName: null,
        status: null,
      } as const),
    result: null,
    error_message: null,
    claim_owner_id: null,
    claimed_until: null,
    created_at: "2026-05-28T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    updated_at: "2026-05-28T00:00:00.000Z",
  };
}

export function createIntegrationJobClaimHandoffHarness(
  input: {
    scope?: Record<string, unknown>;
    profileSnapshot?: Record<string, unknown> | null;
    renewSucceeds?: boolean;
    tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient;
  } = {},
) {
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let renewAttempts = 0;
  const job = {
    job_id: "job_import_base1",
    job_kind: "import",
    payload: {
      action: "import",
      scope: input.scope ?? {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      profileSnapshot: input.profileSnapshot ?? null,
    },
    event_context: context,
    status: "queued",
    progress: {
      phase: "queued",
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    error_message: null as string | null,
    claim_owner_id: null as string | null,
    claimed_until: null as string | null,
    created_at: "2026-05-20T00:00:00.000Z",
    started_at: null as string | null,
    completed_at: null as string | null,
    updated_at: "2026-05-20T00:00:00.000Z",
  };

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("UPDATE catalog_source_observation_integration_durable_jobs AS job")) {
          if (job.status !== "queued") {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.status = "running";
          job.claim_owner_id = String(values[0]);
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("SET claimed_until") &&
          !sql.includes("RETURNING")
        ) {
          renewAttempts += 1;
          return { rowCount: input.renewSucceeds ? 1 : 0, rows: [] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_integration_durable_jobs")) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          if (sql.includes("status = 'completed'")) {
            job.status = "completed";
            job.progress = JSON.parse(String(values[2]));
            job.result = JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else if (sql.includes("status = 'failed'")) {
            job.status = "failed";
            job.progress = JSON.parse(String(values[2]));
            job.error_message = String(values[3]);
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else {
            job.progress = JSON.parse(String(values[2]));
            if (values[3] !== null && values[3] !== undefined) {
              job.result = JSON.parse(String(values[3]));
            }
            job.claimed_until = "2026-05-20T00:02:00.000Z";
          }
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_job_events")) {
          return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          return { rowCount: 1, rows: [{ reference_type_id: String(values[0]) }] as T[] };
        }

        if (sql.includes("WHERE reference_record_id = $1")) {
          return { rowCount: 1, rows: [{ attributes: {} }] as T[] };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          return { rowCount: 1, rows: [{ reference_record_id: `ref_${String(values[1] ?? "existing")}` }] as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async (input: {
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        appendedSourceEvents.push(...input.events);
        return input.events.map((event, index) =>
          storedEvent(index + 1, "catalog.source-observation-obs_1", event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
    tcgplayerAutomationCatalogClient: input.tcgplayerAutomationCatalogClient,
  } as object as CatalogRuntimeDeps;

  const referenceData = {
    referenceTypeCommandHandler: async () => ({ version: 1, state: {} }),
    referenceRecordCommandHandler: async () => ({ version: 1, state: {} }),
    projectors: [],
  } as object as ReferenceDataServices;

  return {
    deps,
    referenceData,
    job,
    appendedSourceEvents,
    get renewAttempts() {
      return renewAttempts;
    },
  };
}

export function createReferencePreloadHarness() {
  const referenceTypes = new Map<string, ReferenceTypeRow>();
  const referenceRecords = new Map<string, ReferenceRecordRow>();
  const referenceRecordCreateCommands: Extract<ReferenceRecordCommand, { type: "CreateReferenceRecord" }>[] = [];
  let projectorRuns = 0;

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_reference_types")) {
          const referenceTypeId = String(values[0]);
          const row = referenceTypes.get(referenceTypeId);
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("WHERE type_key = $1 AND key = $2")) {
          const typeKey = String(values[0]);
          const key = String(values[1]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.key === key,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("attributes ->> $2")) {
          const typeKey = String(values[0]);
          const attributeKey = String(values[1]);
          const attributeValue = String(values[2]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
  } as object as CatalogRuntimeDeps;

  const referenceData = {
    referenceTypeCommandHandler: async (input: { command: ReferenceTypeCommand }) => {
      if (input.command.type === "CreateReferenceType") {
        referenceTypes.set(input.command.referenceTypeId, {
          reference_type_id: input.command.referenceTypeId,
          key: input.command.key,
        });
      }
    },
    referenceRecordCommandHandler: async (input: { command: ReferenceRecordCommand }) => {
      if (input.command.type === "CreateReferenceRecord") {
        referenceRecordCreateCommands.push(input.command);
        referenceRecords.set(input.command.referenceRecordId, {
          reference_record_id: input.command.referenceRecordId,
          type_key: input.command.typeKey,
          key: input.command.key,
          attributes: input.command.attributes ?? {},
        });
      }
    },
    projectors: [
      {
        runOnce: async () => {
          projectorRuns += 1;
          return { processed: 0 };
        },
      },
    ],
  } as object as ReferenceDataServices;

  return {
    deps,
    referenceData,
    referenceRecordCreateCommands,
    projectorRuns: () => projectorRuns,
    referenceRecordsByProviderAttribute(typeKey: string, attributeKey: string, attributeValue: string) {
      return Array.from(referenceRecords.values()).filter(
        (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
      );
    },
  };
}

export function createChangedObservationRefreshHarness(
  input: {
    normalized?: SourceObservationPokemonCardNormalized;
    providerKey?: string;
    sourceProfileKey?: string;
    sourceProfileVersion?: string;
    sourceMappingFingerprint?: string;
    expansionAttributes?: Readonly<Record<string, JsonValue>>;
    status?: string;
    promotedCatalogItemId?: string | null;
    reusableCatalogItemId?: string | null;
    reusableExternalCatalogItemIds?: readonly string[];
    deterministicCatalogItemIds?: readonly string[];
    partialCatalogItemId?: string | null;
    promotionCommandAlreadyApplied?: { catalogItemId: string };
  } = {},
) {
  const itemCommands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let itemProjectorRuns = 0;
  let referenceProjectorRuns = 0;
  const normalized =
    input.normalized ??
    pokemonObservation({
      expansionName: "Ascended Heroes Updated",
      seriesName: "Mega Evolution",
    });
  const observationRow = {
    observation_id: "obs_changed",
    provider_key: input.providerKey ?? "tcgdex",
    external_key: "me02.5-136:reverse-holo",
    source_url: "https://api.tcgdex.net/v2/en/cards/me02.5-136",
    language_code: "en",
    source_record_hash: "new-hash",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
    source_profile_key: input.sourceProfileKey ?? "pokemon-tcg",
    source_profile_version: input.sourceProfileVersion ?? "2026.06.03",
    source_mapping_fingerprint: input.sourceMappingFingerprint ?? "fingerprint:2026.06.03",
    normalized,
    source_payload: { id: "me02.5-136" },
    status: input.status ?? "changed",
    status_reason: null,
    promoted_catalog_item_id: input.promotedCatalogItemId === undefined ? "cat_existing" : input.promotedCatalogItemId,
    promoted_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
  };
  const streamId = "catalog.source-observation-obs_changed";
  const observationStatus = input.status ?? "changed";
  const promotionCommandAlreadyApplied = input.promotionCommandAlreadyApplied;
  const sourceEvents = [
    storedEvent(1, streamId, "catalog.source-observation.recorded", {
      ...observationRow,
      observationId: observationRow.observation_id,
      providerKey: observationRow.provider_key,
      externalKey: observationRow.external_key,
      sourceUrl: observationRow.source_url,
      languageCode: observationRow.language_code,
      sourceRecordHash: observationStatus === "observed" ? observationRow.source_record_hash : "old-hash",
      sourceUpdatedAt: observationStatus === "observed" ? observationRow.source_updated_at : null,
      observedAt: observationStatus === "observed" ? observationRow.observed_at : "2026-05-19T00:00:00.000Z",
      sourceProfileKey: observationRow.source_profile_key,
      sourceProfileVersion: observationRow.source_profile_version,
      sourceMappingFingerprint: observationRow.source_mapping_fingerprint,
      normalized,
      sourcePayload: observationRow.source_payload,
    }),
    ...(observationStatus === "observed"
      ? []
      : [
          storedEvent(2, streamId, "catalog.source-observation.promoted", {
            catalogItemId: observationRow.promoted_catalog_item_id ?? "cat_existing",
            promotedAt: "2026-05-19T00:00:00.000Z",
            promotionProfileKey: observationRow.source_profile_key,
            promotionProfileVersion: observationRow.source_profile_version,
            promotionPlanFingerprint: "plan-fingerprint:2026.06.03",
          }),
        ]),
    ...(observationStatus === "changed"
      ? [
          storedEvent(3, streamId, "catalog.source-observation.changed", {
            observationId: observationRow.observation_id,
            providerKey: observationRow.provider_key,
            externalKey: observationRow.external_key,
            sourceUrl: observationRow.source_url,
            languageCode: observationRow.language_code,
            sourceRecordHash: observationRow.source_record_hash,
            sourceUpdatedAt: observationRow.source_updated_at,
            observedAt: observationRow.observed_at,
            sourceProfileKey: observationRow.source_profile_key,
            sourceProfileVersion: observationRow.source_profile_version,
            sourceMappingFingerprint: observationRow.source_mapping_fingerprint,
            normalized,
            sourcePayload: observationRow.source_payload,
          }),
        ]
      : []),
  ];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_source_observations")) {
          return {
            rowCount: 1,
            rows: [observationRow] as T[],
          };
        }

        if (sql.includes("FROM catalog_items AS item") && sql.includes("item.status NOT IN")) {
          return {
            rowCount: input.deterministicCatalogItemIds?.length ?? 0,
            rows: (input.deterministicCatalogItemIds ?? []).map((catalogItemId) => ({
              catalog_item_id: catalogItemId,
            })) as T[],
          };
        }

        if (sql.includes("FROM catalog_items AS item")) {
          const row = input.partialCatalogItemId ? { catalog_item_id: input.partialCatalogItemId } : null;
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("FROM catalog_external_catalog_item_references")) {
          return {
            rowCount: input.reusableExternalCatalogItemIds?.length ?? 0,
            rows: (input.reusableExternalCatalogItemIds ?? []).map((catalogItemId) => ({
              catalog_item_id: catalogItemId,
            })) as T[],
          };
        }

        if (sql.includes("FROM catalog_external_product_references")) {
          const row = input.reusableCatalogItemId ? { catalog_item_id: input.reusableCatalogItemId } : null;
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          return {
            rowCount: 1,
            rows: [{ reference_type_id: String(values[0]) }] as T[],
          };
        }

        if (sql.includes("WHERE reference_record_id = $1")) {
          return {
            rowCount: 1,
            rows: [{ attributes: input.expansionAttributes ?? {} }] as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          return {
            rowCount: 1,
            rows: [{ reference_record_id: `ref_${String(values[1] ?? "existing")}` }] as T[],
          };
        }

        if (sql.includes("FROM catalog_blueprints")) {
          return { rowCount: 1, rows: [{ id: "bpr_pokemon" }] as T[] };
        }

        if (sql.includes("FROM catalog_categories")) {
          return { rowCount: 1, rows: [{ id: "cat_singles" }] as T[] };
        }

        if (sql.includes("FROM catalog_fields")) {
          return { rowCount: 1, rows: [{ id: `fld_${String(values[0])}` }] as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => sourceEvents,
      appendToStream: async (input: {
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        if (
          promotionCommandAlreadyApplied &&
          input.events.some((event) => event.eventType === "catalog.source-observation.promoted")
        ) {
          observationRow.status = "promoted";
          observationRow.promoted_catalog_item_id = promotionCommandAlreadyApplied.catalogItemId;
          throw new Error("Only observed or changed source observations can be promoted.");
        }
        appendedSourceEvents.push(...input.events);
        return input.events.map((event, index) => storedEvent(4 + index, streamId, event.eventType, event.payload));
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as object as CatalogRuntimeDeps;

  const items = {
    commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
      itemCommands.push(input);
      return { version: itemCommands.length, state: { status: "draft" } };
    },
    projectors: [
      {
        runOnce: async () => {
          itemProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as object as CatalogItemServices;

  const referenceData = {
    referenceTypeCommandHandler: async () => ({ version: 1, state: {} }),
    referenceRecordCommandHandler: async () => ({ version: 1, state: {} }),
    projectors: [
      {
        runOnce: async () => {
          referenceProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as object as ReferenceDataServices;

  return {
    deps,
    items,
    referenceData,
    itemCommands,
    appendedSourceEvents,
    projectorRuns: () => itemProjectorRuns + referenceProjectorRuns,
  };
}

export function createBulkReviewJobHarness(
  count: number,
  options: {
    status?: "queued" | "running" | "completed" | "failed";
    progressTotal?: number;
    carriedOutcomes?: ReadonlyArray<{ observationId: string; status: "rejected"; reason?: string | null }>;
    terminalWorkUnits?: boolean;
  } = {},
) {
  const observationIds = Array.from({ length: count }, (_, index) => `obs_${index + 1}`);
  const observations = new Map(
    observationIds.map((observationId, index) => [
      observationId,
      {
        observation_id: observationId,
        provider_key: "tcgdex",
        external_key: `card-${index + 1}`,
        source_url: `https://api.tcgdex.net/v2/en/cards/card-${index + 1}`,
        language_code: "en",
        source_record_hash: `hash-${index + 1}`,
        source_updated_at: "2026-05-20T00:00:00.000Z",
        observed_at: "2026-05-20T00:00:00.000Z",
        source_profile_key: "pokemon-tcg",
        source_profile_version: "2026.06.03",
        source_mapping_fingerprint: "fingerprint:2026.06.03",
        normalized: pokemonObservation({
          expansionName: "Base Set",
          seriesName: "Base",
          name: `Card ${index + 1}`,
        }),
        source_payload: { id: `card-${index + 1}` },
        status: "observed",
        status_reason: null,
        promoted_catalog_item_id: null,
        promoted_at: null,
        updated_at: "2026-05-20T00:00:00.000Z",
      },
    ]),
  );
  const job = {
    job_id: "job_bulk_review",
    job_kind: "reject",
    payload: {
      action: "reject",
      selectionMode: "ids",
      observationIds,
      scope: {},
      reason: "Out of scope.",
    },
    event_context: context,
    status: options.status ?? "queued",
    progress: {
      phase: "queued",
      completed: 0,
      total: options.progressTotal ?? 0,
      currentName: null,
      status: null,
    },
    result: options.carriedOutcomes
      ? ({
          requested: options.progressTotal ?? options.carriedOutcomes.length,
          rejected: options.carriedOutcomes.length,
          skipped: 0,
          failed: 0,
          outcomes: options.carriedOutcomes,
        } as Record<string, unknown>)
      : (null as null | Record<string, unknown>),
    error_message: null as string | null,
    claim_owner_id: null as string | null,
    claimed_until: null as string | null,
    created_at: "2026-05-20T00:00:00.000Z",
    started_at: null as string | null,
    completed_at: null as string | null,
    updated_at: "2026-05-20T00:00:00.000Z",
  };
  const appendedEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const workUnits = new Map<
    string,
    {
      unit_id: string;
      unit_kind: string;
      state: "queued" | "running" | "completed" | "failed" | "skipped";
      payload: { observationId: string };
      result: Record<string, unknown> | null;
      error_message: string | null;
      claim_owner_id: string | null;
      claim_token: string | null;
      claimed_until: string | null;
      attempt_count: number;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }
  >();
  if (options.terminalWorkUnits) {
    for (const observationId of observationIds) {
      workUnits.set(observationId, {
        unit_id: observationId,
        unit_kind: job.job_kind,
        state: "completed",
        payload: { observationId },
        result: {
          observationId,
          status: "rejected",
          reason: null,
        },
        error_message: null,
        claim_owner_id: null,
        claim_token: null,
        claimed_until: null,
        attempt_count: 1,
        created_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        completed_at: "2026-05-20T00:00:00.000Z",
      });
    }
  } else {
    for (const observationId of observationIds) {
      workUnits.set(observationId, {
        unit_id: observationId,
        unit_kind: job.job_kind,
        state: "queued",
        payload: { observationId },
        result: null,
        error_message: null,
        claim_owner_id: null,
        claim_token: null,
        claimed_until: null,
        attempt_count: 0,
        created_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        completed_at: null,
      });
    }
  }

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_work_units")) {
          const units = JSON.parse(String(values[1])) as Array<{
            unit_id: string;
            unit_kind: string;
            payload: { observationId: string };
          }>;
          let inserted = 0;
          for (const unit of units) {
            if (workUnits.has(unit.unit_id)) {
              continue;
            }
            inserted += 1;
            workUnits.set(unit.unit_id, {
              unit_id: unit.unit_id,
              unit_kind: unit.unit_kind,
              state: "queued",
              payload: unit.payload,
              result: null,
              error_message: null,
              claim_owner_id: null,
              claim_token: null,
              claimed_until: null,
              attempt_count: 0,
              created_at: "2026-05-20T00:00:00.000Z",
              updated_at: "2026-05-20T00:00:00.000Z",
              completed_at: null,
            });
          }
          return { rowCount: inserted, rows: [] as T[] };
        }

        if (sql.includes("WITH workflow_budget")) {
          const unit = [...workUnits.values()].find(
            (candidate) => candidate.state === "queued" || candidate.claimed_until === "expired",
          );
          if (!unit) {
            return { rowCount: 0, rows: [] as T[] };
          }
          unit.state = "running";
          unit.claim_owner_id = String(values[0]);
          unit.claim_token = String(values[1]);
          unit.claimed_until = "2026-05-20T00:02:00.000Z";
          unit.attempt_count += 1;
          job.status = "running";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [{ ...prefixedBulkJobRow(job), ...prefixedBulkWorkUnitRow(unit) }] as T[] };
        }

        if (
          sql.includes("SELECT job_id") &&
          sql.includes("FROM catalog_source_observation_bulk_review_jobs") &&
          sql.includes("FOR UPDATE")
        ) {
          return ["queued", "running"].includes(job.status)
            ? { rowCount: 1, rows: [{ job_id: job.job_id }] as T[] }
            : { rowCount: 0, rows: [] as T[] };
        }

        if (sql.includes("state NOT IN ('completed', 'failed', 'skipped')")) {
          return {
            rowCount: 1,
            rows: [
              {
                count: [...workUnits.values()].filter(
                  (unit) => unit.state !== "completed" && unit.state !== "failed" && unit.state !== "skipped",
                ).length,
              },
            ] as T[],
          };
        }

        if (sql.includes("WITH terminal_unit")) {
          const unit = workUnits.get(String(values[1]));
          if (!unit || unit.claim_owner_id !== String(values[2]) || unit.claim_token !== String(values[3])) {
            return { rowCount: 0, rows: [] as T[] };
          }
          unit.state = values[4] as typeof unit.state;
          unit.result = values[5] == null ? null : JSON.parse(String(values[5]));
          unit.error_message = values[6] == null ? null : String(values[6]);
          unit.claim_owner_id = null;
          unit.claim_token = null;
          unit.claimed_until = null;
          unit.completed_at = "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [{ job_id: job.job_id }] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job") &&
          sql.includes("CASE WHEN $4::boolean")
        ) {
          job.status = values[3] === true ? "completed" : "running";
          job.progress = JSON.parse(String(values[1]));
          job.result = values[2] == null ? job.result : JSON.parse(String(values[2]));
          job.completed_at = values[3] === true ? "2026-05-20T00:00:00.000Z" : job.completed_at;
          return { rowCount: 1, rows: [prefixedBulkJobRow(job)] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_bulk_review_work_units") &&
          sql.includes("count(*)::integer AS total")
        ) {
          const units = values[0]
            ? [...workUnits.values()].filter((unit) => unit.unit_id || job.job_id === values[0])
            : [...workUnits.values()];
          return { rowCount: 1, rows: [bulkWorkUnitSummaryRow(units)] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_bulk_review_work_units") &&
          sql.includes("ORDER BY created_at ASC, unit_id ASC")
        ) {
          return { rowCount: workUnits.size, rows: [...workUnits.values()] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job")) {
          if (job.status !== "queued") {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.status = "running";
          job.claim_owner_id = String(values[0]);
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_bulk_review_jobs") &&
          sql.includes("SET claimed_until") &&
          !sql.includes("RETURNING")
        ) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs")) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          if (sql.includes("status = 'queued'")) {
            job.status = "queued";
            job.progress = JSON.parse(String(values[2]));
            job.result = values[3] === null || values[3] === undefined ? job.result : JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
          } else if (sql.includes("status = 'completed'")) {
            job.status = "completed";
            job.progress = JSON.parse(String(values[2]));
            job.result = JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else if (sql.includes("status = 'failed'")) {
            job.status = "failed";
            job.progress = JSON.parse(String(values[2]));
            job.error_message = String(values[3]);
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else {
            job.progress = JSON.parse(String(values[2]));
            if (values[3] !== null && values[3] !== undefined) {
              job.result = JSON.parse(String(values[3]));
            }
            job.claimed_until = "2026-05-20T00:02:00.000Z";
          }
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
          return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("FROM catalog_source_observation_bulk_review_jobs")) {
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("FROM catalog_source_observations")) {
          const row = observations.get(String(values[0]));
          return { rowCount: row ? 1 : 0, rows: (row ? [row] : []) as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async (input: { streamId: string }) => {
        const observationId = input.streamId.replace("catalog.source-observation-", "");
        const row = observations.get(observationId);
        if (!row) {
          return [];
        }
        return [
          storedEvent(1, input.streamId, "catalog.source-observation.recorded", {
            observationId: row.observation_id,
            providerKey: row.provider_key,
            externalKey: row.external_key,
            sourceUrl: row.source_url,
            languageCode: row.language_code,
            sourceRecordHash: row.source_record_hash,
            sourceUpdatedAt: row.source_updated_at,
            observedAt: row.observed_at,
            sourceProfileKey: row.source_profile_key,
            sourceProfileVersion: row.source_profile_version,
            sourceMappingFingerprint: row.source_mapping_fingerprint,
            normalized: row.normalized,
            sourcePayload: row.source_payload,
          }),
        ];
      },
      appendToStream: async (input: {
        streamId: string;
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        const observationId = input.streamId.replace("catalog.source-observation-", "");
        const row = observations.get(observationId);
        if (row) {
          row.status = "rejected";
        }
        appendedEvents.push(...input.events);
        return input.events.map((event, index) =>
          storedEvent(2 + index, input.streamId, event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as object as CatalogRuntimeDeps;

  return {
    deps,
    job,
    appendedEvents,
  };
}

export function prefixedBulkJobRow(job: Record<string, unknown>) {
  return {
    job_job_id: job.job_id,
    job_job_kind: job.job_kind,
    job_status: job.status,
    job_payload: job.payload,
    job_progress: job.progress,
    job_result: job.result,
    job_error_message: job.error_message,
    job_event_context: job.event_context,
    job_claim_owner_id: job.claim_owner_id,
    job_claimed_until: job.claimed_until,
    job_created_at: job.created_at,
    job_started_at: job.started_at,
    job_completed_at: job.completed_at,
    job_updated_at: job.updated_at,
  };
}

export function prefixedBulkWorkUnitRow(unit: Record<string, unknown>) {
  return {
    unit_job_id: "job_bulk_review",
    unit_unit_id: unit.unit_id,
    unit_unit_kind: unit.unit_kind,
    unit_state: unit.state,
    unit_payload: unit.payload,
    unit_result: unit.result,
    unit_error_message: unit.error_message,
    unit_claim_owner_id: unit.claim_owner_id,
    unit_claim_token: unit.claim_token,
    unit_claimed_until: unit.claimed_until,
    unit_attempt_count: unit.attempt_count,
    unit_created_at: unit.created_at,
    unit_updated_at: unit.updated_at,
    unit_completed_at: unit.completed_at,
  };
}

export function bulkWorkUnitSummaryRow(units: readonly { state: string; claimed_until: string | null }[]) {
  return {
    total: units.length,
    queued: units.filter((unit) => unit.state === "queued").length,
    running: units.filter((unit) => unit.state === "running").length,
    completed: units.filter((unit) => unit.state === "completed").length,
    failed: units.filter((unit) => unit.state === "failed").length,
    skipped: units.filter((unit) => unit.state === "skipped").length,
    active_claims: units.filter((unit) => unit.state === "running" && unit.claimed_until).length,
    expired_claims: 0,
  };
}

export function storedEvent(
  streamVersion: number,
  streamId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    eventId: `evt_${streamVersion}`,
    streamId,
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: context.tenantId,
    eventType,
    payload,
    metadata: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
    recordedAt: "2026-05-20T00:00:00.000Z",
    performedByUserId: context.audit.performedByUserId,
    forAccountId: context.audit.forAccountId,
  };
}
