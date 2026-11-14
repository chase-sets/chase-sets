import { describe, expect, it } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ReferenceRecordId } from "../../../ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { createProviderScopeMappingRuntime } from "../../provider-scope-mapping/api/runtime";
import { providerScopeMappingStreamId } from "../../provider-scope-mapping/domain/domain";
import { buildProviderScopeMappingCandidate } from "../../provider-scope-mapping/domain/mapping";
import { createReferenceDataRuntime } from "../../reference-data/api/runtime";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "../../source-observations/api/provider-integration-profiles";
import { listProviderScopeDiscoveryTargets } from "./discovery-targets";
import {
  acceptCanonicalScopeRecordProposal,
  acceptedReferenceRecordIdForProposal,
  acceptedReferenceRecordKey,
  type CanonicalScopeRecordProposalAcceptRequest,
} from "./proposal-acceptance";
import { parseScopeRecordProposalAcceptRequest } from "./route";
import {
  classifyProviderScopeDiscoveryTarget,
  matchScopeObservationsToScopeRecords,
} from "./scope-observation-matcher";
import { normalizeScopeMatchKey } from "./scope-record-proposal-store";

const TEST_CONTEXT = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_identity_system" },
} as unknown as EventStoreContext;
const YGOPRODECK_UNIT = "ygoprodeck:yugioh:single-card:reference-data";
const YGOJSON_UNIT = "ygojson:yugioh:set:reference-data";
const CREATE: CanonicalScopeRecordProposalAcceptRequest = {
  mode: "create",
  parentScopeRecordId: null,
  releaseDate: null,
  officialSetCode: null,
};

type ProposalRow = {
  proposal_id: string;
  scope_record_id: string;
  product_domain: string;
  scope_kind: string;
  name: string;
  normalized_name: string;
  official_set_code: string | null;
  release_date: string | null;
  language_editions: string[];
  parent_external_ids: string[];
  review_status: "proposed" | "accepted" | "rejected";
  accepted_scope_record_id: string | null;
  evidence: JsonObject;
  first_proposed_at: string;
  updated_at: string;
};

type ScopeRow = {
  scope_record_id: string;
  reference_record_id: string;
  reference_record_key: string;
  product_domain: string;
  scope_kind: string;
  name: string;
  official_set_code: string | null;
  language_editions: string[];
  lifecycle_status: string;
};

describe("acceptedReferenceRecordKey and acceptedReferenceRecordIdForProposal", () => {
  it("keys by the normalized code, else the name, suffixed with the language editions", () => {
    expect(
      acceptedReferenceRecordKey({ officialSetCode: "SDY", name: "Starter Deck: Yugi", languageEditions: ["en"] }),
    ).toBe("sdy-en");
    expect(
      acceptedReferenceRecordKey({ officialSetCode: null, name: "Starter Deck: Yugi", languageEditions: ["en"] }),
    ).toBe("starter-deck-yugi-en");
    expect(
      acceptedReferenceRecordKey({ officialSetCode: "XY2", name: "ワイルドブレイズ", languageEditions: ["ja"] }),
    ).toBe("xy2-ja");
    expect(
      acceptedReferenceRecordKey({ officialSetCode: null, name: "ワイルドブレイズ", languageEditions: ["ja"] }),
    ).toBe("");
  });

  it("derives one stable Reference Record id per proposal", () => {
    const id = acceptedReferenceRecordIdForProposal("proposal-a");
    expect(id).toMatch(/^ref_[0-9a-f]{26}$/);
    expect(acceptedReferenceRecordIdForProposal("proposal-a")).toBe(id);
    expect(acceptedReferenceRecordIdForProposal("proposal-b")).not.toBe(id);
  });
});

describe("parseScopeRecordProposalAcceptRequest", () => {
  it("accepts exactly one well-formed mode", () => {
    expect(parseScopeRecordProposalAcceptRequest({ bind: { scopeRecordId: " ref_x " } })).toEqual({
      mode: "bind",
      scopeRecordId: "ref_x",
    });
    expect(parseScopeRecordProposalAcceptRequest({ create: {} })).toEqual(CREATE);
    expect(
      parseScopeRecordProposalAcceptRequest({
        create: { parentScopeRecordId: "ref_parent", releaseDate: "2013-12-06", officialSetCode: "XY2" },
      }),
    ).toEqual({ mode: "create", parentScopeRecordId: "ref_parent", releaseDate: "2013-12-06", officialSetCode: "XY2" });
  });

  it.each([
    null,
    {},
    { bind: { scopeRecordId: "ref_x" }, create: {} },
    { bind: {} },
    { bind: { scopeRecordId: "  " } },
    { bind: { scopeRecordId: "ref_x", extra: true } },
    { create: { name: "Renamed" } },
    { create: { releaseDate: "2002-02-30" } },
    { create: { releaseDate: "March 2002" } },
    { create: { officialSetCode: 7 } },
    { create: [] },
    { approve: {} },
  ])("refuses %j", (body) => {
    expect(parseScopeRecordProposalAcceptRequest(body as Record<string, unknown> | null)).toBeNull();
  });
});

describe("acceptCanonicalScopeRecordProposal", () => {
  it.each([{ editions: [] }, { editions: ["en"] }])(
    "refuses a Japanese bind target with editions $editions",
    async ({ editions }) => {
      const harness = buildHarness();
      const proposal = harness.addProposal({
        ...sdyProposal(),
        product_domain: "pokemon",
        scope_kind: "expansion",
        language_editions: ["ja"],
      });
      harness.scopeRecords.push({
        ...setRow("ref_english", "pokemon", "sdy", "English target", "SDY", editions),
        scope_kind: "expansion",
      });

      expect(await harness.accept(proposal.proposal_id, { mode: "bind", scopeRecordId: "ref_english" })).toMatchObject({
        ok: false,
        refusal: {
          status: 422,
          code: "scope_record_proposal_bind_target_ineligible",
          details: { reason: "language-editions" },
        },
      });
      expect(proposal.review_status).toBe("proposed");
      expect(harness.referenceEventCount()).toBe(0);
    },
  );

  it.each([{ editions: [] }, { editions: ["en"] }])(
    "keeps English binding to editions $editions",
    async ({ editions }) => {
      const harness = buildHarness();
      const proposal = harness.addProposal({ ...sdyProposal(), product_domain: "pokemon", scope_kind: "expansion" });
      harness.scopeRecords.push({
        ...setRow("ref_english", "pokemon", "sdy", "English target", "SDY", editions),
        scope_kind: "expansion",
      });

      expect(await harness.accept(proposal.proposal_id, { mode: "bind", scopeRecordId: "ref_english" })).toMatchObject({
        ok: true,
        acceptance: { scopeRecordId: "ref_english" },
      });
    },
  );

  it.each(["normalized-name", "exact-id-or-code"])(
    "moves both discovery units with an empty mapping projection after a later %s match",
    async (matchedBy) => {
      const harness = buildHarness();
      const targets = listProviderScopeDiscoveryTargets(
        catalogProviderIntegrationProfileVersions,
        classifyProviderScopeDiscoveryTarget,
      ).filter((target) => target.productDomain === "yugioh" && target.scopeKind === "set");
      const first = targets.find((target) => target.providerKey === "ygoprodeck")!;
      const second = targets.find((target) => target.providerKey === "ygojson")!;
      const observe = async (target: typeof first, later: boolean) => {
        const externalId = later ? "later-sdy" : "first-sdy";
        const matches = await matchScopeObservationsToScopeRecords(harness.db, {
          target,
          scanId: "scan-regression",
          observations: [
            {
              providerKey: target.providerKey,
              unitKey: target.ingestionUnitKey,
              scopeKind: "set",
              sourceQueryKind: target.queryKind,
              languageCode: "en",
              externalId,
              label: later && matchedBy === "exact-id-or-code" ? "Another provider label" : "Starter Deck: Yugi",
              parents: [],
              imageUrl: null,
              metadata: {
                ...(later && matchedBy === "normalized-name" ? {} : { setCode: "SDY" }),
                releaseDate: "2002-03-29",
              },
              scanId: "scan-regression",
              scannedAt: "2026-11-13T00:00:00.000Z",
              firstObservedAt: "2026-11-13T00:00:00.000Z",
              observationHash: `hash-${externalId}`,
              newlyObserved: true,
              changed: true,
            },
          ],
        });
        expect(matches).toHaveLength(1);
        expect(matches[0]!.matchedBy).toBe(later ? matchedBy : "new-canonical-scope");
        const candidate = matches[0]!.candidate;
        await harness.mappings.commandHandler({
          streamId: providerScopeMappingStreamId(candidate),
          command: { type: "ProposeProviderScopeMapping", candidate, actor: "system:discovery" },
          context: TEST_CONTEXT,
        });
        return candidate;
      };
      const original = await observe(first, false);
      const proposal = [...harness.proposals.values()][0]!;
      const evidence = structuredClone(proposal.evidence);
      const later = await observe(second, true);
      expect(proposal.evidence).toEqual(evidence);
      expect(JSON.stringify(evidence)).not.toContain(second.ingestionUnitKey);
      harness.scopeRecords.push(setRow("ref_bound", "yugioh", "sdy", "Starter Deck: Yugi", "SDY", ["en"]));

      const result = await harness.accept(proposal.proposal_id, { mode: "bind", scopeRecordId: "ref_bound" });

      expect(result).toMatchObject({ ok: true, acceptance: { mappings: { conflicts: [], retained: [] } } });
      if (!result.ok) throw new Error("Acceptance refused");
      expect(result.acceptance.mappings.repointed).toHaveLength(2);
      for (const source of [original, later]) {
        expect(harness.eventTypes(providerScopeMappingStreamId(source))).toEqual([
          "catalog.provider-scope-mapping.proposed",
          "catalog.provider-scope-mapping.rejected",
        ]);
        expect(harness.payloads(providerScopeMappingStreamId({ ...source, scopeRecordId: "ref_bound" }))).toEqual([
          expect.objectContaining({
            reviewStatus: "proposed",
            coordinates: source.coordinates,
            provenance: source.provenance,
          }),
        ]);
      }
    },
  );

  it.each(["CreateReferenceRecord", "PublishReferenceRecord"])(
    "returns the same accepted id when another caller completes before %s dispatch",
    async (command) => {
      const harness = buildHarness();
      harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
      const proposal = harness.addProposal(sdyProposal());
      const pause = harness.pauseBefore(command);
      const delayed = harness.accept(proposal.proposal_id, CREATE);
      // Observe rejection immediately too, so the RED run cannot leak an unhandled promise.
      const delayedResult = delayed.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await pause.reached;
      let winner;
      try {
        winner = await harness.accept(proposal.proposal_id, CREATE);
      } finally {
        pause.resume();
      }
      expect(await delayedResult).toMatchObject({
        result: { ok: true, acceptance: { scopeRecordId: acceptedReferenceRecordIdForProposal(proposal.proposal_id) } },
      });
      expect(winner).toMatchObject({
        ok: true,
        acceptance: { scopeRecordId: acceptedReferenceRecordIdForProposal(proposal.proposal_id) },
      });
      expect(
        harness.eventTypes(`catalog.reference-record-${acceptedReferenceRecordIdForProposal(proposal.proposal_id)}`),
      ).toEqual(["catalog.reference-record.created", "catalog.reference-record.published"]);
    },
  );

  it("creates and publishes one Reference Record and a repeat appends nothing", async () => {
    const harness = buildHarness();
    harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
    const proposal = harness.addProposal(sdyProposal());
    const acceptedId = acceptedReferenceRecordIdForProposal(proposal.proposal_id);

    const first = await harness.accept(proposal.proposal_id, CREATE);

    expect(first).toMatchObject({
      ok: true,
      acceptance: {
        scopeRecordId: acceptedId,
        referenceRecord: { referenceRecordId: acceptedId, created: true, published: true },
        proposal: { reviewStatus: "accepted", acceptedScopeRecordId: acceptedId },
      },
    });
    expect(harness.eventTypes(`catalog.reference-record-${acceptedId}`)).toEqual([
      "catalog.reference-record.created",
      "catalog.reference-record.published",
    ]);
    expect(harness.payloads(`catalog.reference-record-${acceptedId}`)[0]).toMatchObject({
      typeKey: "set",
      key: "sdy-en",
      attributes: { "release-date": "2002-03-29", "official-set-code": "SDY", "language-editions": ["en"] },
      relationships: [{ relationshipType: "part-of", referenceId: "ref_yugioh_line" }],
    });

    const repeat = await harness.accept(proposal.proposal_id, CREATE);

    expect(repeat).toMatchObject({
      ok: true,
      acceptance: { scopeRecordId: acceptedId, referenceRecord: { created: false, published: false } },
    });
    expect(harness.eventTypes(`catalog.reference-record-${acceptedId}`)).toHaveLength(2);
  });

  it("resumes a crash between create and publish without a second create", async () => {
    const harness = buildHarness();
    harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
    const proposal = harness.addProposal(sdyProposal());
    const acceptedId = acceptedReferenceRecordIdForProposal(proposal.proposal_id);
    harness.crashes.push("PublishReferenceRecord");

    await expect(harness.accept(proposal.proposal_id, CREATE)).rejects.toThrow("Injected crash");
    expect(harness.eventTypes(`catalog.reference-record-${acceptedId}`)).toEqual(["catalog.reference-record.created"]);
    expect(proposal.review_status).toBe("proposed");

    const resumed = await harness.accept(proposal.proposal_id, CREATE);

    expect(resumed).toMatchObject({
      ok: true,
      acceptance: { referenceRecord: { created: false, published: true } },
    });
    expect(harness.eventTypes(`catalog.reference-record-${acceptedId}`)).toEqual([
      "catalog.reference-record.created",
      "catalog.reference-record.published",
    ]);
  });

  it("refuses a resumed history that is not the record this proposal plans", async () => {
    const harness = buildHarness();
    harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
    const proposal = harness.addProposal(sdyProposal());
    const acceptedId = acceptedReferenceRecordIdForProposal(proposal.proposal_id);
    await harness.referenceData.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${acceptedId}`,
      command: {
        type: "CreateReferenceRecord",
        referenceRecordId: acceptedId,
        typeKey: "set",
        key: "sdy-en",
        name: localizedTextMapFromEnglish("Starter Deck: Yugi"),
        relationships: [{ relationshipType: "part-of", referenceId: "ref_other_line" as ReferenceRecordId }],
      },
      context: TEST_CONTEXT,
    });

    expect(await harness.accept(proposal.proposal_id, CREATE)).toMatchObject({
      ok: false,
      refusal: { status: 409, code: "scope_record_proposal_reference_history_conflict" },
    });
    expect(harness.eventTypes(`catalog.reference-record-${acceptedId}`)).toHaveLength(1);
    expect(proposal.review_status).toBe("proposed");
  });

  it("refuses create beside a candidate, then binds without Reference Record events and re-points every live mapping", async () => {
    const harness = buildHarness();
    harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
    harness.scopeRecords.push(
      setRow("ref_promoted_sdy", "yugioh", "starter-deck-yugi", "Starter Deck: Yugi", "SDY", ["en"]),
    );
    harness.scopeRecords.push(setRow("ref_promoted_lob", "yugioh", "lob", "Legend of Blue Eyes", "LOB", ["en"]));
    const proposal = harness.addProposal(sdyProposal());
    const ygoprodeck = await harness.proposeMapping(proposal.scope_record_id, "ygoprodeck", YGOPRODECK_UNIT, "SDY");
    const ygojson = await harness.proposeMapping(proposal.scope_record_id, "ygojson", YGOJSON_UNIT, "ygojson-sdy");
    await harness.mappings.commandHandler({
      streamId: ygoprodeck.streamId,
      command: { type: "AcceptProviderScopeMapping", actor: "user:operator" },
      context: TEST_CONTEXT,
    });
    const referenceEvents = harness.referenceEventCount();

    expect(await harness.accept(proposal.proposal_id, CREATE)).toMatchObject({
      ok: false,
      refusal: {
        status: 409,
        code: "scope_record_proposal_candidates_exist",
        details: { candidates: [{ scopeRecordId: "ref_promoted_sdy", matchedBy: "identity" }] },
      },
    });

    const bound = await harness.accept(proposal.proposal_id, { mode: "bind", scopeRecordId: "ref_promoted_sdy" });

    expect(bound).toMatchObject({
      ok: true,
      acceptance: {
        scopeRecordId: "ref_promoted_sdy",
        referenceRecord: null,
        mappings: {
          repointed: [
            { providerKey: "ygojson", retiredAs: "rejected", targetAlreadyPresent: false },
            { providerKey: "ygoprodeck", retiredAs: "revoked", targetAlreadyPresent: false },
          ],
          conflicts: [],
          retained: [],
        },
      },
    });
    expect(harness.referenceEventCount()).toBe(referenceEvents);
    for (const source of [ygoprodeck, ygojson]) {
      const target = providerScopeMappingStreamId({
        scopeRecordId: "ref_promoted_sdy",
        providerKey: source.candidate.providerKey,
        unitKey: source.candidate.unitKey,
      });
      expect(harness.payloads(target)).toEqual([
        expect.objectContaining({
          scopeRecordId: "ref_promoted_sdy",
          reviewStatus: "proposed",
          coordinates: source.candidate.coordinates,
          provenance: source.candidate.provenance,
        }),
      ]);
      expect(harness.payloads(source.streamId).at(-1)).toMatchObject({
        reason: expect.stringContaining("ref_promoted_sdy"),
      });
    }
    expect(harness.eventTypes(ygoprodeck.streamId).at(-1)).toBe("catalog.provider-scope-mapping.revoked");
    expect(harness.eventTypes(ygojson.streamId).at(-1)).toBe("catalog.provider-scope-mapping.rejected");

    expect(
      await harness.accept(proposal.proposal_id, { mode: "bind", scopeRecordId: "ref_promoted_lob" }),
    ).toMatchObject({
      ok: false,
      refusal: { status: 409, code: "scope_record_proposal_accepted_elsewhere" },
    });
  });

  it("keeps rejected mappings and a different target mapping, reporting the conflict", async () => {
    const harness = buildHarness();
    harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
    harness.scopeRecords.push(
      setRow("ref_promoted_sdy", "yugioh", "starter-deck-yugi", "Starter Deck: Yugi", "SDY", ["en"]),
    );
    const proposal = harness.addProposal(sdyProposal());
    const ygoprodeck = await harness.proposeMapping(proposal.scope_record_id, "ygoprodeck", YGOPRODECK_UNIT, "SDY");
    const ygojson = await harness.proposeMapping(proposal.scope_record_id, "ygojson", YGOJSON_UNIT, "ygojson-sdy");
    await harness.mappings.commandHandler({
      streamId: ygojson.streamId,
      command: { type: "RejectProviderScopeMapping", actor: "user:operator", reason: "Wrong provider set." },
      context: TEST_CONTEXT,
    });
    const kept = await harness.proposeMapping("ref_promoted_sdy", "ygoprodeck", YGOPRODECK_UNIT, "SDY-REPRINT");

    const bound = await harness.accept(proposal.proposal_id, { mode: "bind", scopeRecordId: "ref_promoted_sdy" });

    expect(bound).toMatchObject({
      ok: true,
      acceptance: {
        mappings: {
          repointed: [],
          conflicts: [
            {
              providerKey: "ygoprodeck",
              keptMappingId: kept.candidate.mappingId,
              keptReviewStatus: "proposed",
              retiredAs: "rejected",
            },
          ],
          retained: [{ providerKey: "ygojson", reviewStatus: "rejected" }],
        },
      },
    });
    expect(harness.eventTypes(kept.streamId)).toEqual(["catalog.provider-scope-mapping.proposed"]);
    expect(harness.eventTypes(ygoprodeck.streamId).at(-1)).toBe("catalog.provider-scope-mapping.rejected");
    expect(harness.eventTypes(ygojson.streamId)).toEqual([
      "catalog.provider-scope-mapping.proposed",
      "catalog.provider-scope-mapping.rejected",
    ]);
  });

  it("finishes an interrupted re-point on retry", async () => {
    const harness = buildHarness();
    harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
    const proposal = harness.addProposal(sdyProposal());
    const source = await harness.proposeMapping(proposal.scope_record_id, "ygoprodeck", YGOPRODECK_UNIT, "SDY");
    const acceptedId = acceptedReferenceRecordIdForProposal(proposal.proposal_id);
    const target = providerScopeMappingStreamId({
      scopeRecordId: acceptedId,
      providerKey: "ygoprodeck",
      unitKey: YGOPRODECK_UNIT,
    });
    harness.crashes.push("RejectProviderScopeMapping");

    await expect(harness.accept(proposal.proposal_id, CREATE)).rejects.toThrow("Injected crash");
    expect(proposal).toMatchObject({ review_status: "accepted", accepted_scope_record_id: acceptedId });
    expect(harness.eventTypes(target)).toEqual(["catalog.provider-scope-mapping.proposed"]);
    expect(harness.eventTypes(source.streamId)).toEqual(["catalog.provider-scope-mapping.proposed"]);

    const retried = await harness.accept(proposal.proposal_id, CREATE);

    expect(retried).toMatchObject({
      ok: true,
      acceptance: { mappings: { repointed: [{ retiredAs: "rejected", targetAlreadyPresent: true }] } },
    });
    expect(harness.eventTypes(target)).toHaveLength(1);
    expect(harness.eventTypes(source.streamId).at(-1)).toBe("catalog.provider-scope-mapping.rejected");
  });

  it("refuses ineligible requests with no Reference Record event", async () => {
    const harness = buildHarness();
    harness.addProductLine("magic", "ref_magic_line", "magic-the-gathering");
    harness.scopeRecords.push({
      ...setRow("ref_yugioh_rush_line", "yugioh", "yu-gi-oh-rush-duel", "Rush Duel", null, []),
      scope_kind: "product-line",
    });
    const proposal = harness.addProposal(sdyProposal());
    const noCode = harness.addProposal({ ...sdyProposal(), proposal_id: "no-code", official_set_code: null });

    expect(await harness.accept(proposal.proposal_id, CREATE)).toMatchObject({
      ok: false,
      refusal: {
        status: 409,
        code: "scope_record_proposal_product_line_missing",
        details: { productDomain: "yugioh", referenceRecordKey: "yu-gi-oh-official-card-game" },
      },
    });
    harness.addProductLine("yugioh", "ref_yugioh_line", "yu-gi-oh-official-card-game");
    expect(await harness.accept(noCode.proposal_id, CREATE)).toMatchObject({
      ok: false,
      refusal: {
        status: 422,
        code: "scope_record_proposal_attribute_missing",
        details: { attributeKey: "official-set-code" },
      },
    });
    expect(await harness.accept(proposal.proposal_id, { ...CREATE, releaseDate: "2002-03-30" })).toMatchObject({
      ok: false,
      refusal: { status: 422, code: "scope_record_proposal_field_not_fillable", details: { field: "releaseDate" } },
    });
    expect(
      await harness.accept(proposal.proposal_id, { ...CREATE, parentScopeRecordId: "ref_magic_line" }),
    ).toMatchObject({ ok: false, refusal: { status: 422, code: "scope_record_proposal_parent_ineligible" } });
    harness.referenceKeys.push({ reference_record_id: "ref_magic_holder", type_key: "set", key: "sdy-en" });
    expect(await harness.accept(proposal.proposal_id, CREATE)).toMatchObject({
      ok: false,
      refusal: {
        status: 409,
        code: "scope_record_proposal_key_unavailable",
        details: { referenceRecordKey: "sdy-en", reason: "taken", referenceRecordId: "ref_magic_holder" },
      },
    });
    proposal.review_status = "rejected";
    expect(await harness.accept(proposal.proposal_id, CREATE)).toMatchObject({
      ok: false,
      refusal: { status: 409, code: "scope_record_proposal_rejected" },
    });
    expect(await harness.accept("missing", CREATE)).toMatchObject({
      ok: false,
      refusal: { status: 404, code: "scope_record_proposal_not_found" },
    });
    expect(harness.referenceEventCount()).toBe(0);
  });

  it("creates a ja expansion beside an en record with the same code-like key", async () => {
    const harness = buildHarness();
    harness.addProductLine("pokemon", "ref_pokemon_line", "pokemon-trading-card-game");
    harness.scopeRecords.push({
      ...setRow("ref_flashfire_en", "pokemon", "xy2", "Flashfire", "FLF", ["en"]),
      scope_kind: "expansion",
    });
    const japanese = harness.addProposal({
      ...sdyProposal(),
      proposal_id: "ja-xy2",
      product_domain: "pokemon",
      scope_kind: "expansion",
      name: "ワイルドブレイズ",
      normalized_name: "",
      official_set_code: "XY2",
      release_date: null,
      language_editions: ["ja"],
      evidence: { "observation:ja": { providerKey: "tcgdex", unitKey: "tcgdex:unit", externalId: "XY2" } },
    });

    const created = await harness.accept(japanese.proposal_id, { ...CREATE, releaseDate: "2013-12-06" });

    expect(created).toMatchObject({ ok: true, acceptance: { referenceRecord: { created: true, published: true } } });
    expect(
      harness.payloads(`catalog.reference-record-${acceptedReferenceRecordIdForProposal("ja-xy2")}`)[0],
    ).toMatchObject({
      typeKey: "expansion",
      key: "xy2-ja",
      attributes: { "release-date": "2013-12-06", "official-set-code": "XY2", "language-editions": ["ja"] },
    });
  });
});

function buildHarness() {
  const proposals = new Map<string, ProposalRow>();
  const scopeRecords: ScopeRow[] = [];
  const referenceKeys: { reference_record_id: string; type_key: string; key: string }[] = [];
  const db = {
    async query(sql: string, params: readonly unknown[] = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT * FROM catalog_scope_record_proposals WHERE proposal_id = $1")) {
        const row = proposals.get(String(params[0]));
        return { rows: row ? [{ ...row }] : [] };
      }
      if (text.startsWith("SELECT * FROM catalog_scope_record_proposals")) {
        return { rows: [...proposals.values()].filter((row) => row.product_domain === params[0]) };
      }
      if (text.startsWith("INSERT INTO catalog_scope_record_proposals")) {
        const row: ProposalRow = {
          ...sdyProposal(),
          proposal_id: String(params[0]),
          scope_record_id: String(params[1]),
          product_domain: String(params[2]),
          scope_kind: String(params[3]),
          name: String(params[4]),
          normalized_name: String(params[5]),
          official_set_code: params[6] as string | null,
          release_date: params[7] as string | null,
          language_editions: JSON.parse(String(params[8])),
          parent_external_ids: JSON.parse(String(params[9])),
          evidence: JSON.parse(String(params[10])),
        };
        proposals.set(row.proposal_id, row);
        return { rows: [row] };
      }
      if (text.includes("FROM catalog_scope_records records")) return { rows: [] };
      if (text.includes("FROM catalog_provider_integration_profile_versions")) {
        return {
          rows: catalogProviderIntegrationProfileVersions.map((version) => ({
            provider_key: version.providerKey,
            profile_key: version.profileKey,
            profile_version: version.profileVersion,
            ingestion_unit_key: catalogProviderProfileVersionIngestionUnitKey(version),
            lifecycle: version.lifecycle,
            active: version.active,
            profile_json: version.profile,
            source_contract_json: version.sourceContract,
            fixture_contract_json: version.fixtures,
          })),
        };
      }
      if (text.startsWith("UPDATE catalog_scope_record_proposals SET review_status = 'accepted'")) {
        const row = proposals.get(String(params[0]));
        if (!row || row.review_status !== "proposed") {
          return { rows: [] };
        }
        row.review_status = "accepted";
        row.accepted_scope_record_id = String(params[1]);
        return { rows: [{ ...row }] };
      }
      if (text.includes("FROM catalog_scope_records WHERE scope_record_id = $1")) {
        return { rows: scopeRecords.filter((row) => row.scope_record_id === params[0]) };
      }
      if (text.includes("FROM catalog_scope_records WHERE product_domain = $1 AND scope_kind = 'product-line'")) {
        return {
          rows: scopeRecords.filter(
            (row) =>
              row.product_domain === params[0] &&
              row.scope_kind === "product-line" &&
              row.reference_record_key === params[1] &&
              row.lifecycle_status === "active",
          ),
        };
      }
      if (text.includes("FROM catalog_scope_records WHERE product_domain = $1 AND scope_kind = $2")) {
        return {
          rows: scopeRecords.filter(
            (row) =>
              row.product_domain === params[0] &&
              row.scope_kind === params[1] &&
              ["draft", "active"].includes(row.lifecycle_status) &&
              row.scope_record_id !== params[2],
          ),
        };
      }
      if (text.includes("FROM catalog_reference_records")) {
        return {
          rows: referenceKeys.filter(
            (row) => row.type_key === params[0] && row.key === params[1] && row.reference_record_id !== params[2],
          ),
        };
      }
      if (text.includes("FROM catalog_provider_scope_mappings")) {
        // A lagging read model: re-point must still find mappings from the proposal evidence.
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    },
  } as unknown as PgQueryable;

  const { eventStore, streams } = createInMemoryEventStore();
  const deps = { db, eventStore, checkpointStore: {} } as unknown as CatalogRuntimeDeps;
  const referenceData = createReferenceDataRuntime(deps);
  const mappings = createProviderScopeMappingRuntime(deps);
  const crashes: string[] = [];
  let pause: { type: string; reached: () => void; wait: Promise<void> } | null = null;
  const crashBefore = (type: string) => {
    const index = crashes.indexOf(type);
    if (index >= 0) {
      crashes.splice(index, 1);
      throw new Error(`Injected crash before ${type}.`);
    }
  };

  return {
    db,
    proposals,
    scopeRecords,
    referenceKeys,
    referenceData,
    mappings,
    crashes,
    pauseBefore(type: string) {
      let reached!: () => void;
      let resume!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        resume = resolve;
      });
      pause = { type, reached, wait };
      return { reached: reachedPromise, resume };
    },
    addProductLine(productDomain: string, id: string, key: string) {
      scopeRecords.push({ ...setRow(id, productDomain, key, key, null, []), scope_kind: "product-line" });
    },
    addProposal(row: ProposalRow): ProposalRow {
      proposals.set(row.proposal_id, row);
      return row;
    },
    async proposeMapping(scopeRecordId: string, providerKey: string, unitKey: string, setName: string) {
      const candidate = buildProviderScopeMappingCandidate({
        scopeRecordId,
        providerKey,
        unitKey,
        coordinates: { productLineId: null, seriesId: null, setId: null, setName, language: null },
        confidence: "generated",
        reviewStatus: "proposed",
        provenance: { source: "provider-scope-observation", sourceId: `hash-${setName}` },
        evidence: { externalId: setName },
      });
      const streamId = providerScopeMappingStreamId({ scopeRecordId, providerKey, unitKey });
      await mappings.commandHandler({
        streamId,
        command: { type: "ProposeProviderScopeMapping", candidate, actor: "system:discovery" },
        context: TEST_CONTEXT,
      });
      const proposal = [...proposals.values()].find((row) => row.scope_record_id === scopeRecordId);
      if (proposal) {
        proposal.evidence = { ...proposal.evidence, [`observation:${setName}`]: { providerKey, unitKey } };
      }
      return { candidate, streamId };
    },
    accept(proposalId: string, request: CanonicalScopeRecordProposalAcceptRequest) {
      return acceptCanonicalScopeRecordProposal(
        { db, eventStore },
        {
          referenceRecordCommandHandler: async (input) => {
            if (pause?.type === input.command.type) {
              const current = pause;
              pause = null;
              current.reached();
              await current.wait;
            }
            crashBefore(input.command.type);
            return referenceData.referenceRecordCommandHandler(input);
          },
          providerScopeMappingCommandHandler: async (input) => {
            crashBefore(input.command.type);
            return mappings.commandHandler(input);
          },
        },
        { proposalId, request, actor: "user:operator", context: TEST_CONTEXT },
      );
    },
    eventTypes(streamId: string): string[] {
      return (streams.get(streamId) ?? []).map((event) => event.eventType);
    },
    payloads(streamId: string): JsonObject[] {
      return (streams.get(streamId) ?? []).map((event) => event.payload);
    },
    referenceEventCount(): number {
      return [...streams.entries()]
        .filter(([streamId]) => streamId.startsWith("catalog.reference-record-"))
        .reduce((total, [, events]) => total + events.length, 0);
    },
  };
}

function sdyProposal(): ProposalRow {
  return {
    proposal_id: "sdy",
    scope_record_id: "proposed-scope-sdy",
    product_domain: "yugioh",
    scope_kind: "set",
    name: "Starter Deck: Yugi",
    normalized_name: normalizeScopeMatchKey("Starter Deck: Yugi"),
    official_set_code: "SDY",
    release_date: "2002-03-29",
    language_editions: ["en"],
    parent_external_ids: [],
    review_status: "proposed",
    accepted_scope_record_id: null,
    evidence: {},
    first_proposed_at: "2026-11-13T00:00:00.000Z",
    updated_at: "2026-11-13T00:00:00.000Z",
  };
}

function setRow(
  id: string,
  productDomain: string,
  key: string,
  name: string,
  officialSetCode: string | null,
  languageEditions: string[],
): ScopeRow {
  return {
    scope_record_id: id,
    reference_record_id: id,
    reference_record_key: key,
    product_domain: productDomain,
    scope_kind: "set",
    name,
    official_set_code: officialSetCode,
    language_editions: languageEditions,
    lifecycle_status: "active",
  };
}
