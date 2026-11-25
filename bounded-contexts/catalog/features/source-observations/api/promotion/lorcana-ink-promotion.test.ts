import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogServices } from "../../../../support/authoring-support/services";
import type { CatalogItemId, ReferenceRecordId } from "../../../../ids";
import { seedDisplayTemplates } from "../../../display-templates/api/seed";
import { deriveRequiredFieldKeys, type DisplayTemplateCommand } from "../../../display-templates/domain/domain";
import { decideSourceObservation, evolveSourceObservation, initialSourceObservationState } from "../../domain/domain";
import { observationRow } from "../../tests/magic-provider-role-fixture";
import normalPayload from "../__fixtures__/lorcanajson-card-reference/normal.json";
import {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcastLorcanaCardReferenceProviderProfile,
  scrydexLorcanaCardPrintProviderProfile,
  scrydexLorcanaSealedProductProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "../provider-integration-profiles";
import { lorcanajsonLorcanaCardReferenceSourceObservationMappingContract } from "../providers/lorcanajson/executable-mapping-contract";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "../providers/registry";
import { scrydexLorcanaCardPrintSourceObservationMappingContract } from "../providers/scrydex/lorcana-executable-mapping-contract";
import { loadCatalogItemPromotionProfile } from "../source-observation-promotion-execution";
import { createChangedObservationRefreshHarness } from "../seeding/runtime-test-harness";
import {
  createSyntheticDisplayIdentityQueryable,
  syntheticCurrentCatalogItem,
  type SyntheticDisplayTemplate,
} from "../seeding/synthetic-display-identity-queryable";
import { normalizeCatalogProviderSourceObservation } from "./provider-source-observation-normalizer";
import { snapshotWithAuthoredFacts } from "./catalog-merge-candidate-application";
import { buildCatalogMergeCandidatesFromObservations } from "./catalog-merge-candidate-matcher";
import { planCatalogMergeCandidatePromotionCommands } from "./catalog-merge-candidate-promotion-planner";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionMode,
} from "./provider-promotion-command-planner";

async function seededLorcanaTemplate(): Promise<SyntheticDisplayTemplate> {
  const commands: DisplayTemplateCommand[] = [];
  // Only the seed's persistence ports are synthetic; the shipped seed owns the template.
  await seedDisplayTemplates({
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    displayTemplates: {
      commandHandler: async ({ command }: { command: DisplayTemplateCommand }) => {
        commands.push(command);
      },
    },
  } as unknown as CatalogServices);
  const command = commands.find(
    (candidate) => candidate.type === "CreateDisplayTemplate" && candidate.key === "lorcana-card-print-default",
  );
  if (!command || command.type !== "CreateDisplayTemplate") throw new Error("Lorcana seed template missing");
  return {
    key: command.key,
    target_kind: command.target.kind,
    target_id: command.target.id ?? null,
    priority: command.priority,
    title_template: command.titleTemplate,
    subtitle_template: command.subtitleTemplate,
    required_field_keys: deriveRequiredFieldKeys(command.titleTemplate, command.subtitleTemplate),
  };
}

async function fixture(
  profile: CatalogProviderIntegrationProfile = lorcanajsonLorcanaCardReferenceProviderProfile,
  missingKey?: string,
  referenceName = "The First Chapter",
  projectReferenceRecords = true,
) {
  const template = await seededLorcanaTemplate();
  const keys: string[] = [];
  const fallback: PgQueryable = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      if (!sql.includes("status = 'active'")) throw new Error(`Unexpected synthetic lookup: ${sql}`);
      const key = String(values[0]);
      keys.push(key);
      const id = sql.includes("catalog_blueprints") ? template.target_id : `synthetic_${key}`;
      const rows = key === missingKey ? [] : [{ id }];
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
  const fields = [...new Set([...Object.values(profile.catalogFieldMapping.fieldKeys), "ink-color"])].map((key) => ({
    field_id: `synthetic_${key}`,
    key,
  }));
  const db = createSyntheticDisplayIdentityQueryable({
    projectReferenceRecords,
    templates: [template],
    fields,
    fallback,
    currentItems: [
      syntheticCurrentCatalogItem({ catalog_item_id: "synthetic_lorcana_item", blueprint_id: template.target_id }),
    ],
    referenceRecords: [
      {
        reference_record_id: "synthetic_lorcana_set",
        type_key: "set",
        key: "1",
        name: referenceName,
        attributes: {},
        relationships: [],
        status: "active",
      },
    ],
  });
  const deps = { ...createChangedObservationRefreshHarness().deps, db };
  return { db, deps, keys, template };
}

function mappedObservation() {
  const result = normalizeCatalogProviderSourceObservation({
    contract: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract,
    payload: normalPayload,
    observedAt: "2026-10-02T00:00:00.000Z",
  });
  expect(result.diagnostics).toEqual([]);
  const normalized = result.observation?.normalized;
  if (normalized?.kind !== "lorcana-card-print") throw new Error("Real Lorcana mapper failed");
  return normalized;
}

async function plan(mode: CatalogProviderPromotionMode, referenceName = "The First Chapter", projectReferences = true) {
  const harness = await fixture(
    lorcanajsonLorcanaCardReferenceProviderProfile,
    undefined,
    referenceName,
    projectReferences,
  );
  const catalog = await loadCatalogItemPromotionProfile(harness.deps, lorcanajsonLorcanaCardReferenceProviderProfile);
  const input = {
    db: harness.db,
    profile: lorcanajsonLorcanaCardReferenceProviderProfile,
    profileKey: "lorcana-card-reference-data",
    profileVersion: "2026.06.23",
    providerKey: "lorcanajson",
    externalKey: normalPayload.externalKey,
    mode,
    catalogItemId: "synthetic_lorcana_item" as CatalogItemId,
    normalized: mappedObservation(),
    catalog,
    setReferenceId: "synthetic_lorcana_set" as ReferenceRecordId,
    metadata: { title: normalPayload.name, subtitle: "" },
    productAssetSet: null,
  };
  return { input, harness, result: await planCatalogProviderPromotionCommands(input) };
}

describe("synthetic Scrydex D23 Collection candidate display identity", () => {
  // Set shape and printed-number format come from the offline Scrydex import test;
  // the card identity and values are controls, not retained staging data.
  it.each([
    { ink: "Amber", rarity: "Promo", missing: [] },
    { ink: "Amber / Ruby", rarity: "Promo", missing: [] },
    { ink: null, rarity: "Promo", missing: ["ink-color"] },
    { ink: "Amber", rarity: null, missing: ["rarity"] },
    { ink: null, rarity: null, missing: ["ink-color", "rarity"] },
    { ink: "Amber", rarity: "Promo", reviewedInk: "", missing: ["ink-color"] },
    { ink: "Amber", rarity: "Promo", reviewedRarity: "Rare", missing: ["rarity"] },
  ])(
    "resolves or reports $missing (ink $ink, rarity $rarity, reviewed ink $reviewedInk, reviewed rarity $reviewedRarity)",
    async ({ ink, rarity, reviewedInk, reviewedRarity, missing }) => {
      const at = "2026-10-02T00:00:00.000Z";
      const contract = scrydexLorcanaCardPrintSourceObservationMappingContract;
      const { observation, diagnostics } = normalizeCatalogProviderSourceObservation({
        contract,
        payload: {
          kind: "lorcana-card",
          sourceUrl: "https://source.example/synthetic-d23",
          card: {
            id: "synthetic-d23-card",
            name: "Synthetic Promo Card",
            number: "1",
            printed_number: "1/D23",
            ...(ink === null ? {} : { ink }),
            ...(rarity === null ? {} : { rarity }),
            language_code: "en",
            expansion: { id: "synthetic-d23", code: "D23C24", name: "D23 Collection" },
          },
        },
        observedAt: at,
      });
      expect(diagnostics).toEqual([]);
      if (observation?.normalized.kind !== "lorcana-card-print") throw new Error("Scrydex card did not normalize");
      const { normalized } = observation;
      expect(normalized).toMatchObject({ name: "Synthetic Promo Card", cardNumber: "1/D23", setCode: "d23c24" });
      expect(normalized.inkColor ?? null).toBe(ink);
      expect(normalized.rarity ?? null).toBe(rarity);

      const version = catalogProviderIntegrationProfileVersions.find(
        (entry) =>
          entry.providerKey === contract.providerKey &&
          entry.profileKey === contract.profileKey &&
          entry.profileVersion === contract.profileVersion,
      );
      if (!version) throw new Error("Scrydex card profile is not registered");
      const unit = catalogProviderProfileVersionIngestionUnitKey(version);
      const { candidates, exclusions } = buildCatalogMergeCandidatesFromObservations([observationRow(observation)], {
        addedAt: at,
        providerUnitKeyByObservationId: { [observation.observationId]: unit },
        acceptedScopeMappings: [
          {
            mapping_id: "map_synthetic_d23",
            scope_record_id: "ref_synthetic_d23",
            provider_key: contract.providerKey,
            unit_key: unit,
            product_line_id: null,
            series_id: null,
            set_id: "synthetic-d23",
            set_name: "D23 Collection",
            language_coordinates: null,
            confidence: "exact",
            review_status: "accepted",
            provenance: {},
            evidence: {},
            last_actor: null,
            last_reason: null,
            policy_version: "synthetic",
            proposed_at: at,
            reviewed_at: at,
            updated_at: at,
          },
        ],
      });
      expect(exclusions).toEqual([]);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0]!;
      expect(candidate.snapshot.proposedCatalogItemFacts).not.toHaveProperty("inkColor");
      const snapshot = {
        ...candidate.snapshot,
        proposedCatalogItemFacts: {
          ...candidate.snapshot.proposedCatalogItemFacts,
          ...(reviewedInk === undefined ? {} : { inkColor: reviewedInk }),
          ...(reviewedRarity === undefined ? {} : { rarity: reviewedRarity }),
        },
      };
      const revision = decideSourceObservation(initialSourceObservationState, {
        type: "RecordSourceObservation",
        ...observation,
      }).reduce(evolveSourceObservation, initialSourceObservationState);
      const authored = snapshotWithAuthoredFacts(snapshot, [{ revision, normalized, version }]);
      expect(authored.proposedCatalogItemFacts.inkColor ?? null).toBe(reviewedInk ?? ink);
      expect(authored.proposedCatalogItemFacts.rarity ?? null).toBe(reviewedRarity === undefined ? rarity : null);

      const { db, deps } = await fixture(version.profile, undefined, "D23 Collection");
      const { blueprintId, categoryId, fieldIds } = await loadCatalogItemPromotionProfile(deps, version.profile);
      const result = await planCatalogMergeCandidatePromotionCommands({
        db,
        candidate: { candidateId: candidate.candidateId, status: "ready", snapshot: authored },
        createCatalogItemId: "cat_synthetic_d23" as CatalogItemId,
        catalog: {
          blueprintId,
          categoryId,
          fields: [
            { fieldPath: "catalogItem.name", fieldId: fieldIds.cardName, valueKind: "localized-text", factKey: "name" },
            {
              fieldPath: "catalogItem.collectorNumber",
              fieldId: fieldIds.cardNumber,
              valueKind: "raw",
              factKey: "collectorNumber",
            },
            { fieldPath: "catalogItem.rarity", fieldId: fieldIds.rarity, valueKind: "raw", factKey: "rarity" },
            { fieldPath: "catalogItem.inkColor", fieldId: fieldIds.inkColor!, valueKind: "raw", factKey: "inkColor" },
            {
              fieldPath: "catalogItem.setName",
              fieldId: fieldIds.set!,
              valueKind: "reference-record",
              referenceRecordId: "synthetic_lorcana_set" as ReferenceRecordId,
            },
          ],
        },
      });
      if (missing.length === 0) {
        expect(result.status).toBe("planned");
        expect(result.plan?.displayIdentity).toMatchObject({
          resolutionStatus: "resolved",
          templateKey: "lorcana-card-print-default",
        });
      } else {
        expect(result.status).toBe("blocked");
        expect(result.diagnostics).toMatchObject([
          {
            code: "display-identity-unresolvable",
            displayIdentity: { missingTokens: missing, templateKey: null, templateReason: "missing-required-fields" },
          },
        ]);
      }
    },
  );
});

describe("Lorcana ink promotion through real mapper, active-key loader and seeded template (synthetic Catalog)", () => {
  it.each(["create", "refresh"] as const)(
    "binds %s to truthful reference history rather than projection visibility",
    async (mode) => {
      const before = await plan(mode, "The First Chapter", false);
      const after = await plan(mode, "The First Chapter", true);
      const revised = await plan(mode, "Synthetic Corrected Set", false);
      expect(before.result.status).toBe("planned");
      expect(before.result.plan?.displayIdentity.resolutionStatus).toBe("resolved");
      expect(before.result.plan?.planFingerprint).toBe(after.result.plan?.planFingerprint);
      expect(before.result.plan?.displayIdentity).toEqual(after.result.plan?.displayIdentity);
      expect(revised.result.plan?.planFingerprint).not.toBe(after.result.plan?.planFingerprint);
      expect(before.harness.db.queries.some((query) => /INSERT|UPDATE|DELETE/.test(query))).toBe(false);
    },
  );

  it.each(["create", "refresh"] as const)("resolves the required ink-bearing identity before %s", async (mode) => {
    const { result, harness, input } = await plan(mode);
    expect(harness.template.required_field_keys).toEqual(["card-name", "card-number", "ink-color", "rarity", "set"]);
    expect(harness.keys.filter((key) => key === "ink-color")).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("planned");
    expect(result.plan?.commands).toContainEqual({
      type: "SetCatalogItemFieldValue",
      fieldId: "synthetic_ink-color",
      value: "Amethyst",
    });
    expect(result.plan?.displayIdentity).toMatchObject({
      resolutionStatus: "resolved",
      missingTokens: [],
      templateKey: "lorcana-card-print-default",
    });
    // An omission-only control must fail against exactly the same template and facts.
    const withoutInk = await planCatalogProviderPromotionCommands({
      ...input,
      normalized: { ...input.normalized, inkColor: null },
    });
    expect(withoutInk.status).toBe("blocked");
    expect(withoutInk.plan).toBeNull();
    expect(withoutInk.diagnostics[0]?.displayIdentity?.missingTokens).toEqual(["ink-color"]);
  });

  it.each([
    lorcanajsonLorcanaCardReferenceProviderProfile,
    lorcastLorcanaCardReferenceProviderProfile,
    scrydexLorcanaCardPrintProviderProfile,
  ])("resolves active ink for $providerKey card-print profiles and fails closed when absent", async (profile) => {
    const active = await fixture(profile);
    expect((await loadCatalogItemPromotionProfile(active.deps, profile)).fieldIds).toHaveProperty(
      "inkColor",
      "synthetic_ink-color",
    );
    const missing = await fixture(profile, "ink-color");
    await expect(loadCatalogItemPromotionProfile(missing.deps, profile)).rejects.toThrow(
      "requires active Catalog catalog_fields key 'ink-color'",
    );
  });

  it.each([tcgdexPokemonTcgProviderProfile, scrydexLorcanaSealedProductProviderProfile])(
    "does not look up ink for $providerKey $normalizedObservationMapping.kind",
    async (profile) => {
      const harness = await fixture(profile, "ink-color");
      const catalog = await loadCatalogItemPromotionProfile(harness.deps, profile);
      expect(harness.keys).not.toContain("ink-color");
      expect(catalog.fieldIds).not.toHaveProperty("inkColor");
    },
  );

  it.each(["create", "refresh"] as const)(
    "refuses absent, null and blank ink in %s without an executable plan",
    async (mode) => {
      const { input } = await plan(mode);
      const missingInk = { ...input.normalized };
      Reflect.deleteProperty(missingInk, "inkColor");
      for (const inkColor of [undefined, null, "", "   "]) {
        const result = await planCatalogProviderPromotionCommands({
          ...input,
          normalized: inkColor === undefined ? missingInk : { ...input.normalized, inkColor },
        });
        expect(result.status).toBe("blocked");
        expect(result.plan).toBeNull();
        expect(result.diagnostics[0]?.displayIdentity?.missingTokens).toEqual(["ink-color"]);
      }
    },
  );

  it.each(["create", "refresh"] as const)("retains every required Field refusal in %s", async (mode) => {
    const { input } = await plan(mode);
    for (const key of ["card-name", "card-number", "ink-color", "rarity", "set"]) {
      const harness = await fixture();
      const db = createSyntheticDisplayIdentityQueryable({
        templates: [harness.template],
        fields: ["card-name", "card-number", "ink-color", "rarity", "set", "card-type", "release-year"]
          .filter((candidate) => candidate !== key)
          .map((candidate) => ({ field_id: `synthetic_${candidate}`, key: candidate })),
        currentItems: [
          syntheticCurrentCatalogItem({
            catalog_item_id: input.catalogItemId,
            blueprint_id: harness.template.target_id,
          }),
        ],
        referenceRecords: [
          {
            reference_record_id: "synthetic_lorcana_set",
            type_key: "set",
            key: "1",
            name: "The First Chapter",
            attributes: {},
            relationships: [],
            status: "active",
          },
        ],
      });
      const result = await planCatalogProviderPromotionCommands({ ...input, db });
      expect(result.status).toBe("blocked");
      expect(result.plan).toBeNull();
      expect(result.diagnostics[0]?.displayIdentity?.missingTokens).toContain(key);
    }
  });
});
