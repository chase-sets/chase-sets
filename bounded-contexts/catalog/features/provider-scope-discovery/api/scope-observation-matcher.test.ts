import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import japaneseSets from "../../source-observations/api/__fixtures__/tcgdex/ja-sets.json";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import { listProviderScopeDiscoveryTargets, type ProviderScopeDiscoveryTarget } from "./discovery-targets";
import type { ProviderScopeObservationRecord } from "./refresh-schedule-store";
import {
  classifyProviderScopeDiscoveryTarget,
  matchScopeObservationsToScopeRecords,
} from "./scope-observation-matcher";
import { normalizeScopeMatchKey } from "./scope-record-proposal-store";

const target: ProviderScopeDiscoveryTarget = {
  providerKey: "ygoprodeck",
  profileKey: "yugioh-card-print-reference-data",
  ingestionUnitKey: "ygoprodeck:yugioh:single-card:reference-data",
  productDomain: "yugioh",
  queryKind: "sets",
  providerScope: "set-name",
  parentScope: null,
  parentRequired: false,
  scopeKind: "set",
  languageCode: "en",
};

describe("matching observations against accepted canonical proposals", () => {
  it("treats an accepted proposal as its projected Scope Record, so the two never compete", async () => {
    const db = matcherDb({
      canonical: [canonicalSet("ref_accepted_sdy", "Starter Deck: Yugi", "SDY")],
      proposals: [proposalRow({ reviewStatus: "accepted", acceptedScopeRecordId: "ref_accepted_sdy" })],
    });

    const candidates = await matchScopeObservationsToScopeRecords(db, {
      target,
      observations: [observation("Starter Deck: Yugi", "SDY")],
      scanId: "scan-2",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      matchedBy: "exact-id-or-code",
      candidate: {
        scopeRecordId: "ref_accepted_sdy",
        reviewStatus: "auto-accepted",
        evidence: { proposedCanonicalScopeRecord: false },
      },
    });
  });

  it("targets the accepted id, for review only, while the accepted Scope Record is not projected yet", async () => {
    const db = matcherDb({
      canonical: [],
      proposals: [proposalRow({ reviewStatus: "accepted", acceptedScopeRecordId: "ref_accepted_sdy" })],
    });

    const candidates = await matchScopeObservationsToScopeRecords(db, {
      target,
      observations: [observation("Starter Deck: Yugi", "SDY")],
      scanId: "scan-2",
    });

    expect(candidates.map((entry) => entry.candidate)).toEqual([
      expect.objectContaining({
        scopeRecordId: "ref_accepted_sdy",
        reviewStatus: "proposed",
        evidence: expect.objectContaining({ proposedCanonicalScopeRecord: false }),
      }),
    ]);
    expect(db.inserts).toBe(0);
  });

  it.each(["load", "upsert"] as const)(
    "targets the accepted English Pokemon id, for review only, during projection lag on %s",
    async (path) => {
      const englishExpansions = listProviderScopeDiscoveryTargets(
        catalogProviderIntegrationProfileVersions,
        classifyProviderScopeDiscoveryTarget,
      ).find(
        (candidate) =>
          candidate.providerKey === "tcgdex" && candidate.queryKind === "expansions" && candidate.languageCode === "en",
      )!;
      const accepted = {
        ...proposalRow({ reviewStatus: "accepted", acceptedScopeRecordId: "ref_sv09", code: "sv09" }),
        product_domain: "pokemon",
        scope_kind: "expansion",
        name: "Journey Together",
        normalized_name: normalizeScopeMatchKey("Journey Together"),
      };
      const db = languageDb([], {
        proposals: path === "load" ? [accepted] : [],
        upsertedProposal: accepted,
      });

      const candidates = await matchScopeObservationsToScopeRecords(db, {
        target: englishExpansions,
        observations: [tcgdexObservation(englishExpansions, { id: "sv09", name: "Journey Together" })],
        scanId: "scan-en",
      });

      expect(candidates.map((entry) => entry.candidate)).toEqual([
        expect.objectContaining({
          scopeRecordId: "ref_sv09",
          reviewStatus: "proposed",
          evidence: expect.objectContaining({ proposedCanonicalScopeRecord: false }),
        }),
      ]);
      expect(db.insertedProposals).toHaveLength(path === "load" ? 0 : 1);
    },
  );

  it("matches a bound proposal's own name onto the record it was bound to", async () => {
    const db = matcherDb({
      canonical: [canonicalSet("ref_promoted", "Starter Deck Yugi Muto", "SDY-EN")],
      proposals: [proposalRow({ reviewStatus: "accepted", acceptedScopeRecordId: "ref_promoted", code: null })],
    });

    const candidates = await matchScopeObservationsToScopeRecords(db, {
      target,
      observations: [observation("Starter Deck: Yugi", null)],
      scanId: "scan-2",
    });

    expect(candidates.map((entry) => entry.candidate.scopeRecordId)).toEqual(["ref_promoted"]);
  });

  it("still maps a proposed proposal onto its proposed-scope id", async () => {
    const db = matcherDb({
      canonical: [],
      proposals: [proposalRow({ reviewStatus: "proposed", acceptedScopeRecordId: null })],
    });

    const candidates = await matchScopeObservationsToScopeRecords(db, {
      target,
      observations: [observation("Starter Deck: Yugi", "SDY")],
      scanId: "scan-2",
    });

    expect(candidates.map((entry) => entry.candidate)).toEqual([
      expect.objectContaining({
        scopeRecordId: "proposed-scope-sdy",
        reviewStatus: "proposed",
        evidence: expect.objectContaining({ proposedCanonicalScopeRecord: true }),
      }),
    ]);
  });
});

describe("matching observations by language edition", () => {
  const englishExpansions = listProviderScopeDiscoveryTargets(
    catalogProviderIntegrationProfileVersions,
    classifyProviderScopeDiscoveryTarget,
  ).find((candidate) => candidate.providerKey === "tcgdex" && candidate.queryKind === "expansions")!;
  const japaneseExpansions: ProviderScopeDiscoveryTarget = { ...englishExpansions, languageCode: "ja" };
  const recorded = (id: string) => japaneseSets.find((set) => set.id === id)!;

  it.each([{ editions: [] }, { editions: ["en"] }, { editions: ["ja"] }])(
    "checks an accepted Japanese proposal's target editions $editions before matching",
    async ({ editions }) => {
      const accepted = japaneseAcceptedProposal();
      const db = languageDb(
        editions.includes("ja")
          ? [{ ...canonicalSet("ref_xy2", "Different canonical name", "XY2"), scope_kind: "expansion" }]
          : [],
        { proposals: [accepted], upsertedProposal: accepted },
      );

      const candidates = await matchScopeObservationsToScopeRecords(db, {
        target: japaneseExpansions,
        observations: [tcgdexObservation(japaneseExpansions, recorded("XY2"))],
        scanId: "scan-ja",
      });

      expect(candidates).toEqual(
        editions.includes("ja")
          ? [
              expect.objectContaining({
                matchedBy: "exact-id-or-code",
                candidate: expect.objectContaining({ scopeRecordId: "ref_xy2", reviewStatus: "auto-accepted" }),
              }),
            ]
          : [],
      );
    },
  );

  it.each([{ editions: [] }, { editions: ["en"] }, { editions: ["ja"] }])(
    "checks an upserted accepted Japanese proposal's target editions $editions before emitting a candidate",
    async ({ editions }) => {
      const db = languageDb(
        editions.includes("ja")
          ? [{ ...canonicalSet("ref_xy2", "Different canonical name", "OTHER"), scope_kind: "expansion" }]
          : [],
        { upsertedProposal: japaneseAcceptedProposal() },
      );

      const candidates = await matchScopeObservationsToScopeRecords(db, {
        target: japaneseExpansions,
        observations: [tcgdexObservation(japaneseExpansions, recorded("XY2"))],
        scanId: "scan-ja",
      });

      expect(db.insertedProposals).toHaveLength(1);
      expect(candidates.map((entry) => entry.candidate.scopeRecordId)).toEqual(
        editions.includes("ja") ? ["ref_xy2"] : [],
      );
    },
  );

  it("loads only Scope Records and proposals of the observation's language edition", async () => {
    const japanese = languageDb([]);
    await matchScopeObservationsToScopeRecords(japanese, {
      target: japaneseExpansions,
      observations: [tcgdexObservation(japaneseExpansions, recorded("XY2"))],
      scanId: "scan-ja",
    });
    expect(japanese.queries.records).toEqual({
      sql: expect.stringContaining("AND records.language_editions ? $2\n"),
      params: ["pokemon", "ja"],
    });
    expect(japanese.queries.proposals).toEqual({
      sql: expect.stringContaining("WHERE product_domain = $1 AND language_editions ? $2\n"),
      params: ["pokemon", "ja", 2_000],
    });

    const english = languageDb([]);
    await matchScopeObservationsToScopeRecords(english, {
      target: englishExpansions,
      observations: [tcgdexObservation(englishExpansions, { id: "sv09", name: "Journey Together" })],
      scanId: "scan-en",
    });
    expect(english.queries.records).toEqual({
      sql: expect.stringContaining("(records.language_editions ? $2 OR records.language_editions = '[]'::jsonb)"),
      params: ["pokemon", "en"],
    });
    expect(english.queries.proposals?.params).toEqual(["pokemon", "en", 2_000]);

    const yugioh = languageDb([]);
    await matchScopeObservationsToScopeRecords(yugioh, {
      target,
      observations: [observation("Starter Deck: Yugi", "SDY")],
      scanId: "scan-yugioh",
    });
    expect(yugioh.queries.records?.params).toEqual(["yugioh"]);
    expect(yugioh.queries.proposals?.params).toEqual(["yugioh", 2_000]);
  });

  it("matches a Japanese observation by id or code only and proposes it under its TCGdex id", async () => {
    const supercharged = recorded("SV8");
    const db = languageDb([
      {
        ...canonicalSet("ref_sv8_ja", supercharged.name, supercharged.id),
        reference_record_key: "sv8-ja",
        scope_kind: "expansion",
      },
    ]);

    const candidates = await matchScopeObservationsToScopeRecords(db, {
      target: japaneseExpansions,
      observations: [
        tcgdexObservation(japaneseExpansions, recorded("XY2")),
        tcgdexObservation(japaneseExpansions, supercharged),
      ],
      scanId: "scan-ja",
    });

    expect(db.insertedProposals).toEqual([
      expect.objectContaining({ name: "ワイルドブレイズ", officialSetCode: "XY2", languageEditions: ["ja"] }),
    ]);
    expect(
      candidates.map((entry) => [entry.candidate.scopeRecordId, entry.matchedBy, entry.candidate.reviewStatus]),
    ).toEqual([
      [db.insertedProposals[0]!.scopeRecordId, "new-canonical-scope", "proposed"],
      ["ref_sv8_ja", "exact-id-or-code", "auto-accepted"],
    ]);
    expect(candidates.map((entry) => entry.candidate.coordinates)).toEqual([
      expect.objectContaining({ setId: "XY2", language: expect.objectContaining({ languageCode: "ja" }) }),
      expect.objectContaining({ setId: "SV8", language: expect.objectContaining({ languageCode: "ja" }) }),
    ]);
  });
});

function tcgdexObservation(
  scanTarget: ProviderScopeDiscoveryTarget,
  set: Readonly<{ id: string; name: string }>,
): ProviderScopeObservationRecord {
  return {
    providerKey: scanTarget.providerKey,
    unitKey: scanTarget.ingestionUnitKey,
    scopeKind: "expansion",
    sourceQueryKind: scanTarget.queryKind,
    languageCode: scanTarget.languageCode,
    externalId: set.id,
    label: set.name,
    parents: [],
    imageUrl: null,
    metadata: { languageCode: scanTarget.languageCode, expansionId: set.id },
    scanId: `scan-${scanTarget.languageCode}`,
    scannedAt: "2026-11-13T00:00:00.000Z",
    firstObservedAt: "2026-11-13T00:00:00.000Z",
    observationHash: `hash-${scanTarget.languageCode}-${set.id}`,
    newlyObserved: true,
    changed: true,
  };
}

type RecordedQuery = Readonly<{ sql: string; params: readonly unknown[] }>;

/** Serves edition-filtered records; an upsert can return an existing accepted proposal. */
function languageDb(
  canonical: readonly object[],
  input: { proposals?: readonly object[]; upsertedProposal?: object } = {},
) {
  const db = {
    queries: {} as { records?: RecordedQuery; proposals?: RecordedQuery },
    insertedProposals: [] as Array<{
      scopeRecordId: string;
      name: string;
      officialSetCode: string | null;
      languageEditions: readonly string[];
    }>,
    async query(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("FROM catalog_scope_records records")) {
        db.queries.records = { sql, params };
        return { rows: canonical };
      }
      if (sql.includes("INSERT INTO catalog_scope_record_proposals")) {
        const [proposalId, scopeRecordId, productDomain, scopeKind, name, normalizedName, officialSetCode] = params;
        const languageEditions = JSON.parse(String(params[8])) as string[];
        db.insertedProposals.push({
          scopeRecordId: String(scopeRecordId),
          name: String(name),
          officialSetCode: officialSetCode as string | null,
          languageEditions,
        });
        if (input.upsertedProposal) return { rows: [input.upsertedProposal] };
        return {
          rows: [
            {
              proposal_id: proposalId,
              scope_record_id: scopeRecordId,
              product_domain: productDomain,
              scope_kind: scopeKind,
              name,
              normalized_name: normalizedName,
              official_set_code: officialSetCode,
              release_date: null,
              language_editions: languageEditions,
              parent_external_ids: JSON.parse(String(params[9])) as string[],
              review_status: "proposed",
              accepted_scope_record_id: null,
              evidence: {},
              first_proposed_at: "2026-11-13T00:00:00.000Z",
              updated_at: "2026-11-13T00:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("FROM catalog_scope_record_proposals")) {
        db.queries.proposals = { sql, params };
        return { rows: input.proposals ?? [] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  return db as unknown as PgQueryable & Omit<typeof db, "query">;
}

function japaneseAcceptedProposal() {
  return {
    ...proposalRow({ reviewStatus: "accepted", acceptedScopeRecordId: "ref_xy2", code: "XY2" }),
    proposal_id: "synthetic-ja-xy2",
    scope_record_id: "proposed-scope-synthetic-ja-xy2",
    product_domain: "pokemon",
    scope_kind: "expansion",
    name: "Synthetic Japanese XY2",
    language_editions: ["ja"],
  };
}

function matcherDb(input: { canonical: readonly object[]; proposals: readonly object[] }) {
  const db = {
    inserts: 0,
    async query(sql: string) {
      if (sql.includes("FROM catalog_scope_records records")) {
        return { rows: input.canonical };
      }
      if (sql.includes("FROM catalog_scope_record_proposals")) {
        return { rows: input.proposals };
      }
      if (sql.includes("INSERT INTO catalog_scope_record_proposals")) {
        db.inserts += 1;
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  return db as unknown as PgQueryable & { inserts: number };
}

function canonicalSet(id: string, name: string, officialSetCode: string | null) {
  return {
    scope_record_id: id,
    reference_record_id: id,
    reference_record_key: normalizeScopeMatchKey(name).replace(/ /g, "-"),
    scope_kind: "set",
    name,
    official_set_code: officialSetCode,
    release_date: "2002-03-29",
    aliases: [],
  };
}

function proposalRow(input: {
  reviewStatus: "proposed" | "accepted";
  acceptedScopeRecordId: string | null;
  code?: string | null;
}) {
  return {
    proposal_id: "sdy",
    scope_record_id: "proposed-scope-sdy",
    product_domain: "yugioh",
    scope_kind: "set",
    name: "Starter Deck: Yugi",
    normalized_name: "starter deck yugi",
    official_set_code: input.code === undefined ? "SDY" : input.code,
    release_date: "2002-03-29",
    language_editions: ["en"],
    parent_external_ids: [],
    review_status: input.reviewStatus,
    accepted_scope_record_id: input.acceptedScopeRecordId,
    evidence: {},
    first_proposed_at: "2026-11-13T00:00:00.000Z",
    updated_at: "2026-11-13T00:00:00.000Z",
  };
}

function observation(label: string, setCode: string | null): ProviderScopeObservationRecord {
  return {
    providerKey: target.providerKey,
    unitKey: target.ingestionUnitKey,
    scopeKind: "set",
    sourceQueryKind: "sets",
    languageCode: "en",
    externalId: label,
    label,
    parents: [],
    imageUrl: null,
    metadata: setCode ? { setName: label, setCode, releaseDate: "2002-03-29" } : { setName: label },
    scanId: "scan-2",
    scannedAt: "2026-11-13T00:00:00.000Z",
    firstObservedAt: "2026-11-13T00:00:00.000Z",
    observationHash: `hash-${label}-${setCode ?? "none"}`,
    newlyObserved: false,
    changed: true,
  };
}
