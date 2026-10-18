import { describe, expect, it, vi } from "vitest";
import allCards from "../../__fixtures__/lorcanajson-promo-grouping/all-cards.json";
import setdata1 from "../../__fixtures__/lorcanajson-promo-grouping/setdata.1.json";
import provenance from "../../__fixtures__/lorcanajson-promo-grouping/provenance.json";
import { ProviderAdapterRegistry } from "../../provider-adapters/registry";
import type { ProviderPayloadEnvelope } from "../../provider-adapters/provider-adapter";
import { catalogProviderIntegrationProfileVersions } from "../../provider-integration-profiles";
import { unitKeyForCatalogProviderProfileVersion } from "../../governance/catalog-integration-impact-analysis";
import { listProviderScopeDiscoveryTargets } from "../../../../provider-scope-discovery/api/discovery-targets";
import {
  classifyProviderScopeDiscoveryTarget,
  providerScopeMappingCoordinates,
} from "../../../../provider-scope-discovery/api/scope-observation-matcher";
import { buildProviderScopeMappingCandidate } from "../../../../provider-scope-mapping/domain/mapping";
import {
  catalogSyncAcceptedScopeMappingFromRow,
  previewCatalogSyncProviderParticipation,
} from "../catalog-sync-scope-planner";
import {
  createLorcanajsonProviderAdapter,
  LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type LorcanajsonProviderPayload,
} from "./adapter";

// The fixtures are sanitized slices of the LorcanaJSON files captured on 2026-10-18;
// provenance.json names each source digest and what each slice keeps.
const ALL_CARDS_URL = "https://lorcanajson.org/files/current/en/allCards.json";
const SETDATA_1_URL = "https://lorcanajson.org/files/current/en/sets/setdata.1.json";
const capturedFiles: Readonly<Record<string, unknown>> = {
  [ALL_CARDS_URL]: allCards,
  [SETDATA_1_URL]: setdata1,
};
const d23Cards = allCards.cards.filter((card) => card.promoGrouping === "D23");

describe("LorcanaJSON promo groupings", () => {
  it("lists promo groupings as set options without changing set options", async () => {
    const recorded = recordingFetch(capturedFiles);
    const { items } = await createLorcanajsonProviderAdapter({ fetch: recorded.fetch }).listOptions({
      unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      optionKind: "sets",
    });
    const control = await createLorcanajsonProviderAdapter({
      fetch: recordingFetch({ [ALL_CARDS_URL]: withoutPromoGroupings(allCards) }).fetch,
    }).listOptions({ unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY, optionKind: "sets" });
    const groupingOptions = items.filter((item) => item.metadata?.promoGrouping);

    expect(recorded.urls).toEqual([ALL_CARDS_URL]);
    expect(groupingOptions.map((item) => [item.value, item.label])).toEqual([
      ["C1", "C1"],
      ["CC1", "CC1"],
      ["D23", "D23"],
      ["P1", "P1"],
    ]);
    expect(groupingOptions.find((item) => item.value === "D23")).toEqual({
      value: "D23",
      label: "D23",
      metadata: {
        setId: "D23",
        setCode: "D23",
        promoGrouping: "D23",
        cardCount: "16",
        formatVersion: "2.4.0",
        generatedOn: "2026-10-16T16:43:42",
      },
    });
    expect(d23Cards).toHaveLength(provenance.files["all-cards.json"].capturedPromoGroupingCounts.D23);
    expect(control.items.map((item) => item.value).sort()).toEqual(Object.keys(allCards.sets).sort());
    expect(items.filter((item) => !item.metadata?.promoGrouping)).toEqual(control.items);
  });

  it("refuses a promo grouping that collides with a set code", async () => {
    // Synthetic provider files: no LorcanaJSON release publishes these codes.
    const syntheticAllCards = (promoGrouping: string) => ({
      sets: { Q1: { name: "Synthetic Quest" }, S1: { name: "Synthetic Special Set" } },
      cards: [{ id: "synthetic-1", setCode: "Q1", number: 1, fullName: "Synthetic Card", promoGrouping }],
    });
    const listSets = (promoGrouping: string) =>
      createLorcanajsonProviderAdapter({
        fetch: recordingFetch({ [ALL_CARDS_URL]: syntheticAllCards(promoGrouping) }).fetch,
      }).listOptions({ unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY, optionKind: "sets" });

    await expect(listSets(" q1 ")).rejects.toThrow("LorcanaJSON promo grouping 'Q1' collides with a set code.");
    await expect(listSets("s1")).rejects.toThrow("LorcanaJSON promo grouping 'S1' collides with a set code.");
    await expect(listSets("17")).rejects.toThrow("LorcanaJSON promo grouping '17' has the form of a set code.");

    const adapter = createLorcanajsonProviderAdapter({
      fetch: recordingFetch({ [ALL_CARDS_URL]: syntheticAllCards("SYN") }).fetch,
    });
    const importCodes = async (setName: string) =>
      collectPayloads(
        adapter.fetchPayloads(
          await adapter.planImport({
            unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
            scopeKey: "set-name",
            values: { setName },
          }),
        ),
      );
    await expect(importCodes("S1")).rejects.toThrow("LorcanaJSON promo grouping 'S1' collides with a set code.");
    await expect(importCodes("ZZ")).rejects.toThrow("LorcanaJSON allCards.json did not include promo grouping 'ZZ'.");
  });

  it("refuses a label-typed set name instead of importing it as a set", async () => {
    const recorded = recordingFetch(capturedFiles);
    const adapter = createLorcanajsonProviderAdapter({ fetch: recorded.fetch });
    const plan = await adapter.planImport({
      unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-name",
      values: { setName: "The First Chapter" },
    });

    await expect(collectPayloads(adapter.fetchPayloads(plan))).rejects.toThrow(
      "LorcanaJSON allCards.json did not include promo grouping 'THE FIRST CHAPTER'.",
    );
    expect(recorded.urls).toEqual([ALL_CARDS_URL]);
  });

  it.each([
    ["lorcana-card-reference-data", "1", "lorcanajson:cards:set:1"],
    ["lorcana-card-reference-data", "D23", "lorcanajson:cards:set:D23"],
    ["lorcana-set-reference-data", "1", "lorcanajson:set:1"],
    ["lorcana-set-reference-data", "D23", "lorcanajson:set:D23"],
  ])("plans LorcanaJSON from an accepted set-name coordinate (%s, %s)", async (profileKey, coordinate, planKey) => {
    const profile = requireProfile("lorcanajson", profileKey);
    const unitKey = unitKeyForCatalogProviderProfileVersion(profile);
    const target = listProviderScopeDiscoveryTargets([profile], classifyProviderScopeDiscoveryTarget).find(
      (candidate) => candidate.providerScope === "set-name",
    )!;
    const option = (
      await createLorcanajsonProviderAdapter({ fetch: recordingFetch(capturedFiles).fetch }).listOptions({
        unitKey,
        optionKind: target.queryKind,
      })
    ).items.find((item) => item.value === coordinate);
    expect(option, `LorcanaJSON option ${coordinate}`).toBeDefined();
    const coordinates = providerScopeMappingCoordinates(target, {
      providerKey: profile.providerKey,
      unitKey,
      scopeKind: target.scopeKind,
      sourceQueryKind: target.queryKind,
      languageCode: "en",
      externalId: option!.value,
      label: option!.label,
      parents: [],
      imageUrl: null,
      metadata: option!.metadata ?? {},
      scanId: "synthetic-lorcanajson-scan",
      scannedAt: "2026-10-18T00:00:00.000Z",
      firstObservedAt: "2026-10-18T00:00:00.000Z",
      observationHash: "synthetic-lorcanajson-observation",
      newlyObserved: true,
      changed: true,
    });
    expect(coordinates).toMatchObject({ setId: null, setName: coordinate });
    const candidate = buildProviderScopeMappingCandidate({
      scopeRecordId: `scope_synthetic_lorcana_${coordinate}`,
      providerKey: profile.providerKey,
      unitKey,
      coordinates: coordinates!,
      confidence: "exact",
      reviewStatus: "accepted",
      provenance: { source: "provider-scope-observation" },
    });
    const mapping = catalogSyncAcceptedScopeMappingFromRow({
      mapping_id: candidate.mappingId,
      scope_record_id: candidate.scopeRecordId,
      provider_key: candidate.providerKey,
      unit_key: candidate.unitKey,
      product_line_id: candidate.coordinates.productLineId,
      series_id: candidate.coordinates.seriesId,
      set_id: candidate.coordinates.setId,
      set_name: candidate.coordinates.setName,
      review_status: candidate.reviewStatus,
      updated_at: "2026-10-18T00:00:00.000Z",
    });
    const deniedFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("Live fetch denied.");
    });
    const adapter = createLorcanajsonProviderAdapter({ fetch: deniedFetch });
    const planImport = vi.spyOn(adapter, "planImport");
    const preview = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "lorcana",
        reference: { kind: "set", scopeRecordId: candidate.scopeRecordId },
      },
      acceptedScopeMappings: [mapping],
      providerProfileVersions: [profile],
      providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
      includeOperationalGates: true,
    });

    expect(deniedFetch).not.toHaveBeenCalled();
    expect(preview).toMatchObject({ status: "ready", startAllowed: true, blockers: [] });
    expect(preview.units).toEqual([
      expect.objectContaining({ unitKey, eligibility: "eligible", selected: true, blockers: [] }),
    ]);
    expect(planImport).toHaveBeenCalledOnce();
    await expect(planImport.mock.results[0]!.value).resolves.toMatchObject({
      planKey,
      scope: { scopeKey: "set", values: { setName: coordinate, setCode: coordinate } },
    });
  });

  it("keeps explicit LorcanaJSON coordinates ahead of an accepted set name", async () => {
    const deniedFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("Live fetch denied.");
    });
    const adapter = createLorcanajsonProviderAdapter({ fetch: deniedFetch });
    const planKeyFor = async (values: Readonly<Record<string, string>>) =>
      (
        await adapter.planImport({
          unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          scopeKey: "set-name",
          values,
        })
      ).planKey;

    await expect(planKeyFor({ setCode: "2", code: "3", setId: "4", expansionId: "5", setName: "D23" })).resolves.toBe(
      "lorcanajson:cards:set:2",
    );
    await expect(planKeyFor({ code: "3", setId: "4", expansionId: "5", setName: "D23" })).resolves.toBe(
      "lorcanajson:cards:set:3",
    );
    await expect(planKeyFor({ setId: "4", expansionId: "5", setName: "D23" })).resolves.toBe("lorcanajson:cards:set:4");
    await expect(planKeyFor({ expansionId: "5", setName: "D23" })).resolves.toBe("lorcanajson:cards:set:5");
    await expect(planKeyFor({ setName: "   " })).rejects.toThrow("LorcanaJSON import planning requires setCode.");
    await expect(planKeyFor({})).rejects.toThrow("LorcanaJSON import planning requires setCode.");
    expect(deniedFetch).not.toHaveBeenCalled();
  });

  it("imports the D23 promo grouping from allCards", async () => {
    const recorded = recordingFetch(capturedFiles);
    const adapter = createLorcanajsonProviderAdapter({ fetch: recorded.fetch });
    const cardPlan = await adapter.planImport({
      unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-name",
      values: { setName: "D23" },
    });
    const cards = cardPayloads(await collectPayloads(adapter.fetchPayloads(cardPlan)));

    expect(recorded.urls).toEqual([ALL_CARDS_URL]);
    expect(cards.map((card) => card.cardId)).toEqual(d23Cards.map((card) => String(card.id)));
    expect(cards.map((card) => card.cardNumber)).toEqual(
      Array.from({ length: 16 }, (_unused, index) => String(index + 1)),
    );
    for (const card of cards) {
      expect(card).toMatchObject({
        observationId: `lorcanajson_card_en_${card.cardId}`,
        sourceUrl: ALL_CARDS_URL,
        setId: "D23",
        setCode: "D23",
        setName: "D23",
        sourcePayload: { set: { setId: "D23", setCode: "D23", setName: "D23", cardCount: 16 } },
        mergeIdentity: { setName: "D23", collectorNumber: card.cardNumber },
        catalogHashMaterial: { setId: "D23", setCode: "D23", setName: "D23", cardId: card.cardId },
      });
    }

    const setPlan = await adapter.planImport({
      unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-name",
      values: { setName: "D23" },
    });
    const sets = await collectPayloads(adapter.fetchPayloads(setPlan));

    expect(recorded.urls).toEqual([ALL_CARDS_URL, ALL_CARDS_URL]);
    expect(sets).toEqual([
      expect.objectContaining({
        externalKey: "set:D23",
        provenance: expect.objectContaining({ sourceUrl: ALL_CARDS_URL }),
        payload: expect.objectContaining({
          kind: "lorcana-set-reference",
          observationId: "lorcanajson_set_en_D23",
          setId: "D23",
          setCode: "D23",
          setName: "D23",
          name: "D23",
          cardCount: 16,
          catalogHashMaterial: expect.objectContaining({ setCode: "D23", setName: "D23", cardCount: 16 }),
        }),
      }),
    ]);
    expect(recorded.urls.filter((url) => url.includes("setdata.D23"))).toEqual([]);
  });

  it("excludes promo-grouped cards from home-set imports", async () => {
    const recorded = recordingFetch(capturedFiles);
    const adapter = createLorcanajsonProviderAdapter({ fetch: recorded.fetch });
    const planFor = (values: Readonly<Record<string, string>>) =>
      adapter.planImport({ unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, scopeKey: "set", values });
    const homeSet = cardPayloads(await collectPayloads(adapter.fetchPayloads(await planFor({ setCode: "1" }))));
    const grouping = cardPayloads(await collectPayloads(adapter.fetchPayloads(await planFor({ setCode: "D23" }))));

    expect(recorded.urls).toEqual([SETDATA_1_URL, ALL_CARDS_URL]);
    expect(setdata1.cards.filter((card) => "promoGrouping" in card)).toHaveLength(4);
    expect(homeSet.map((card) => card.cardId)).toEqual(["1-041"]);
    expect(homeSet.filter((card) => card.cardNumber === "1")).toEqual([]);
    const homeObservationIds = new Set(homeSet.map((card) => card.observationId));
    expect(grouping.filter((card) => homeObservationIds.has(card.observationId))).toEqual([]);
    expect(grouping.map((card) => card.observationId)).toContain("lorcanajson_card_en_1191");
    await expect(
      collectPayloads(adapter.fetchPayloads(await planFor({ setCode: "1", cardNumber: "1" }))),
    ).rejects.toThrow("LorcanaJSON set '1' did not include the requested card payload.");
  });
});

function recordingFetch(files: Readonly<Record<string, unknown>>) {
  const urls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    urls.push(url);
    const body = files[url];
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetch, urls };
}

function withoutPromoGroupings(response: typeof allCards) {
  return {
    ...response,
    cards: response.cards.map(({ promoGrouping: _promoGrouping, ...card }: Record<string, unknown>) => card),
  };
}

async function collectPayloads(
  payloads: AsyncIterable<ProviderPayloadEnvelope<LorcanajsonProviderPayload>>,
): Promise<ProviderPayloadEnvelope<LorcanajsonProviderPayload>[]> {
  const collected: ProviderPayloadEnvelope<LorcanajsonProviderPayload>[] = [];
  for await (const payload of payloads) {
    collected.push(payload);
  }
  return collected;
}

function cardPayloads(envelopes: readonly ProviderPayloadEnvelope<LorcanajsonProviderPayload>[]) {
  return envelopes.flatMap((envelope) =>
    envelope.payload.kind === "lorcana-card-reference" ? [envelope.payload] : [],
  );
}

function requireProfile(providerKey: string, profileKey: string) {
  const version = catalogProviderIntegrationProfileVersions.find(
    (candidate) => candidate.providerKey === providerKey && candidate.profileKey === profileKey,
  );
  if (!version) {
    throw new Error(`Missing ${providerKey}/${profileKey} test profile.`);
  }
  return version;
}
