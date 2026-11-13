import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createProviderScopeDiscoveryRuntime } from "../../provider-scope-discovery/api/runtime";
import type { ProviderScopeObservationInput } from "../../provider-scope-discovery/api/refresh-schedule-store";
import type { TcgplayerSetNameEntry, TcgplayerSetNameObservationPost } from "../domain/extension/set-names/contract";
import salvageJson from "./fixtures/tcgplayer-set-name-observations.salvage.json" with { type: "json" };

export type SalvageUnit = Readonly<{
  productLineId: number;
  unitKey: string;
  sets: readonly TcgplayerSetNameEntry[];
  observations: readonly ProviderScopeObservationInput[];
}>;

export const salvage = salvageJson as unknown as Readonly<{ synthetic: true; units: readonly SalvageUnit[] }>;

export const routePath = "/scope-observations/tcgplayer-set-names";
export const observationUrl = `https://api.example.test/api/public/catalog/operator-session${routePath}`;
export const grantBearer = "S".repeat(43);
export const observedAt = "2026-10-28T13:42:00.953Z";
export const provenance = Object.freeze({
  grantId: "00000000-0000-0000-0000-0000000000a1",
  creatorUserId: "usr_set_name_creator",
  creatorMembershipId: "mbr_set_name_creator",
});

export function setNameEntry(
  productLineId: number,
  setNameId: number,
  overrides: Partial<TcgplayerSetNameEntry> = {},
): TcgplayerSetNameEntry {
  const name = overrides.name ?? `Synthetic Set ${setNameId}`;
  return {
    setNameId,
    categoryId: productLineId,
    name,
    cleanSetName: name,
    urlName: `synthetic-set-${setNameId}`,
    abbreviation: `S${setNameId % 1000}`,
    releaseDate: "2024-02-09T00:00:00",
    isSupplemental: false,
    active: true,
    ...overrides,
  };
}

export function setNamePost(
  productLineId: number,
  sets: readonly TcgplayerSetNameEntry[],
  overrides: Partial<TcgplayerSetNameObservationPost> = {},
): TcgplayerSetNameObservationPost {
  return { contractVersion: 1, productLineId, observedAt, sets, ...overrides };
}

export function postRequest(
  body: BodyInit | Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(observationUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${grantBearer}`, "content-type": "application/json", ...headers },
    body:
      typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream
        ? (body as BodyInit)
        : JSON.stringify(body),
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

// Synthetic Pokemon controls for the measured F2 finding: one character from each permitted general
// category, a leading U+FEFF id beside its plain twin with an equal display name, and every
// releaseDate form the contract admits. None of these are provider captures.
export const unicodeControlSets: readonly TcgplayerSetNameEntry[] = [
  setNameEntry(3, 920001, {
    name: "Synthetic\u0007Bell",
    cleanSetName: "Synthetic\u0007Bell",
    urlName: "synthetic\u0007bell",
    releaseDate: "2023-03-31T00:00:00",
  }),
  setNameEntry(3, 920002, {
    name: "Synthetic​Zero Width",
    cleanSetName: "Synthetic­Soft Hyphen",
    urlName: "synthetic-soft­hyphen",
    releaseDate: "2023-03-31",
  }),
  setNameEntry(3, 920003, {
    name: "SyntheticPrivate",
    cleanSetName: "SyntheticPrivate",
    urlName: "syntheticprivate",
    releaseDate: "2023-03-31T00:00:00.000Z",
  }),
  setNameEntry(3, 920004, {
    name: "Synthetic͸Unassigned",
    cleanSetName: "Synthetic͸Unassigned",
    urlName: "synthetic͸unassigned",
    releaseDate: "2023-03-31T09:00:00-07:00",
  }),
  setNameEntry(3, 920005, {
    name: "Synthetic Base",
    cleanSetName: "Synthetic Base",
    urlName: "synthetic-base",
    abbreviation: null,
    releaseDate: null,
  }),
  setNameEntry(3, 920006, {
    name: "Synthetic Base",
    cleanSetName: "﻿Synthetic Base",
    urlName: "﻿synthetic-base",
    abbreviation: "",
    releaseDate: "2023-03-31T23:59:59",
  }),
];

export const testContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_set_name_creator", forAccountId: "acc_identity_system" },
} as unknown as EventStoreContext;

type StoredObservation = Readonly<{
  providerKey: string;
  unitKey: string;
  scopeKind: string;
  sourceQueryKind: string;
  languageCode: string;
  externalId: string;
  label: string;
  parents: readonly string[];
  imageUrl: string | null;
  metadata: Record<string, unknown>;
  observationHash: string;
}>;

// An in-memory stand-in for the observation, proposal and schedule tables that answers exactly the
// statements the discovery service issues, so service behavior is checkable without a database.
export function createInMemoryObservationStore() {
  const observations = new Map<string, StoredObservation>();
  const proposals = new Map<string, Record<string, unknown>>();
  const runs: Array<{ status: unknown; observationCount: unknown; error: unknown; triggeredBy: unknown }> = [];
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const commands: unknown[] = [];

  const db = {
    async query(sql: string, params: readonly unknown[] = []) {
      statements.push({ sql, params });
      if (sql.includes("INSERT INTO catalog_provider_scope_observations")) {
        const key = [params[0], params[1], params[2], params[4], params[5]].join("\u0000");
        const prior = observations.get(key);
        observations.set(key, {
          providerKey: params[0] as string,
          unitKey: params[1] as string,
          scopeKind: params[2] as string,
          sourceQueryKind: params[3] as string,
          languageCode: params[4] as string,
          externalId: params[5] as string,
          label: params[6] as string,
          parents: JSON.parse(params[7] as string),
          imageUrl: params[8] as string | null,
          metadata: JSON.parse(params[9] as string),
          observationHash: params[10] as string,
        });
        return {
          rows: [
            {
              first_observed_at: new Date(params[12] as string),
              inserted: !prior,
              changed: !prior || prior.observationHash !== params[10],
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO catalog_scope_record_proposals")) {
        const now = new Date();
        const row = {
          proposal_id: params[0],
          scope_record_id: params[1],
          product_domain: params[2],
          scope_kind: params[3],
          name: params[4],
          normalized_name: params[5],
          official_set_code: params[6],
          release_date: params[7],
          language_editions: JSON.parse(params[8] as string),
          parent_external_ids: JSON.parse(params[9] as string),
          review_status: "proposed",
          evidence: JSON.parse(params[10] as string),
          first_proposed_at: now,
          updated_at: now,
        };
        proposals.set(String(params[0]), row);
        return { rows: [row] };
      }
      if (sql.includes("FROM catalog_scope_record_proposals"))
        return { rows: [...proposals.values()].filter((row) => params.includes(row.product_domain)) };
      if (sql.includes("SET last_run_completed_at")) {
        runs.push({ status: params[2], observationCount: params[3], error: params[4], triggeredBy: params[5] });
      }
      return { rows: [] };
    },
  } as unknown as PgQueryable;

  const runtimeDeps = { db } as unknown as Parameters<typeof createProviderScopeDiscoveryRuntime>[0];
  const runtime = createProviderScopeDiscoveryRuntime(runtimeDeps, {
    listProfileVersions: async () => [],
    queryIntegrationOptions: async () => {
      throw new Error("operator-extension posts never query a provider");
    },
    providerScopeMappingCommandHandler: async (input) => {
      commands.push(input);
      return { state: {} as never, version: 1, newEvents: [{} as never], storedEvents: [] };
    },
    referenceRecordCommandHandler: async () => {
      throw new Error("operator-extension posts never accept a Reference Record proposal");
    },
  });

  return {
    runtime,
    db,
    observations: () => [...observations.values()],
    proposals: () => [...proposals.values()],
    runs,
    statements,
    commands,
  };
}
