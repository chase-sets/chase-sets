import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProviderScopeDiscoveryTarget } from "./discovery-targets";
import type { ProviderScopeObservationRecord } from "./refresh-schedule-store";
import { matchScopeObservationsToScopeRecords } from "./scope-observation-matcher";
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
