import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import { module as catalogModule } from "../../../index";
import type { CatalogItemId, FieldId, ReferenceRecordId } from "../../../ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { seedContext as context } from "../../../support/seed-support/context";
import type { CatalogItemCommand } from "../../catalog-items/domain/domain";
import type { SourceObservationNormalized } from "../domain/domain";
import tcgdexFixture from "../api/__fixtures__/tcgdex/normal.json";
import scryfallFixture from "../api/__fixtures__/scryfall-card-print/normal.json";
import tcgplayerMtgSealedFixture from "../api/__fixtures__/tcgplayer-mtg-sealed-product/normal.json";
import scrydexOnePieceCardFixture from "../api/__fixtures__/scrydex-one-piece-card-print/normal.json";
import scrydexOnePieceSealedFixture from "../api/__fixtures__/scrydex-one-piece-sealed-product/normal.json";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import { scryfallMtgCardPrintSourceObservationMappingContract } from "../api/scryfall-executable-mapping-contract";
import { tcgplayerMtgSealedProductSourceObservationMappingContract } from "../api/tcgplayer-executable-mapping-contract";
import {
  scrydexOnePieceCardPrintSourceObservationMappingContract,
  scrydexOnePieceSealedProductSourceObservationMappingContract,
} from "../api/scrydex-one-piece-executable-mapping-contract";
import {
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "../api/promotion/provider-source-observation-normalizer";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionCommandPlan,
  type CatalogProviderPromotionResolvedCatalogMapping,
} from "../api/promotion/provider-promotion-command-planner";
import { normalizeReferenceKey } from "../api/promotion/provider-reference-hierarchy-provisioner";
import {
  resolveCatalogProviderDuplicatePrevention,
  type CatalogProviderDuplicatePreventionDb,
} from "../api/promotion/provider-duplicate-prevention-resolver";
import {
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceSealedProductProviderProfile,
  scryfallMtgCardPrintProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "../api/provider-integration-profiles";
import {
  loadCatalogItemPromotionProfile,
  requireCatalogItemPromotionObservation,
} from "../api/source-observation-promotion-execution";
import { resolvePromotionReferenceHierarchy } from "../api/source-observation-promotion-reference-hierarchy";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for duplicate-prevention resolver database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

type SetFieldValueCommand = Extract<CatalogItemCommand, { type: "SetCatalogItemFieldValue" }>;
type TracedQuery = Readonly<{ sql: string; values: readonly unknown[] }>;

/**
 * Expansion/set lookup: TCGdex and Scrydex hierarchies key their Reference
 * Records by provider id, while the deterministic rules look the record up by
 * its name key, so those rows provision the name-keyed record a set-name
 * hierarchy (Scryfall, TCGplayer) creates. The item's field values always come
 * from the executable normalizer and promotion planner.
 */
type ReferenceLookup = "provider-hierarchy" | "name-keyed";

const fieldRuleCases = [
  {
    ruleKey: "pokemon-card-deterministic-fields",
    profile: tcgdexPokemonTcgProviderProfile,
    contract: tcgdexPokemonCardSourceObservationMappingContract,
    payload: tcgdexFixture,
    reference: { typeKey: "expansion", nameKey: "expansionName", fieldKey: "expansion", lookup: "name-keyed" },
  },
  {
    ruleKey: "magic-card-print-deterministic-fields",
    profile: scryfallMtgCardPrintProviderProfile,
    contract: scryfallMtgCardPrintSourceObservationMappingContract,
    payload: scryfallFixture,
    reference: { typeKey: "set", nameKey: "setName", fieldKey: "set", lookup: "provider-hierarchy" },
  },
  {
    ruleKey: "sealed-product-deterministic-fields",
    profile: tcgplayerMtgSealedProductProviderProfile,
    contract: tcgplayerMtgSealedProductSourceObservationMappingContract,
    payload: tcgplayerMtgSealedFixture,
    reference: { typeKey: "set", nameKey: "setName", fieldKey: "set", lookup: "provider-hierarchy" },
  },
  {
    ruleKey: "one-piece-card-print-deterministic-fields",
    profile: scrydexOnePieceCardPrintProviderProfile,
    contract: scrydexOnePieceCardPrintSourceObservationMappingContract,
    payload: scrydexOnePieceCardFixture,
    reference: { typeKey: "set", nameKey: "setName", fieldKey: "set", lookup: "name-keyed" },
  },
  {
    ruleKey: "one-piece-sealed-product-deterministic-fields",
    profile: scrydexOnePieceSealedProductProviderProfile,
    contract: scrydexOnePieceSealedProductSourceObservationMappingContract,
    payload: scrydexOnePieceSealedFixture,
    reference: { typeKey: "set", nameKey: "setName", fieldKey: "set", lookup: "name-keyed" },
  },
] as const satisfies readonly Readonly<{
  ruleKey: string;
  profile: CatalogProviderIntegrationProfile;
  contract: CatalogProviderSourceObservationMappingContract;
  payload: JsonValue;
  reference: Readonly<{
    typeKey: "expansion" | "set";
    nameKey: "expansionName" | "setName";
    fieldKey: "expansion" | "set";
    lookup: ReferenceLookup;
  }>;
}>[];

describeDb("duplicate-prevention field rules against projected Catalog Items (db)", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  let deps: CatalogRuntimeDeps;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "duplicate_prevention_resolver");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    services = createCatalogServices(pool);
    deps = {
      db: pool,
      eventStore: createPostgresEventStore({ pool }),
      checkpointStore: createPostgresProjectionStore({ db: pool }),
    } as CatalogRuntimeDeps;
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  function observe(contract: CatalogProviderSourceObservationMappingContract, payload: JsonValue) {
    const mapped = normalizeCatalogProviderSourceObservation({
      contract,
      payload,
      observedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(mapped.diagnostics).toEqual([]);
    if (!mapped.observation) {
      throw new Error("Executable mapper did not produce a Source Observation.");
    }
    return {
      providerKey: mapped.observation.providerKey,
      externalKey: mapped.observation.externalKey,
      normalized: requireCatalogItemPromotionObservation(mapped.observation.normalized, mapped.observation.providerKey),
    };
  }

  async function drain() {
    await drainLocalProjectionHandlerSets("catalog", pool, services.projectors);
  }

  async function nameKeyedReferenceRecord(typeKey: string, name: string): Promise<ReferenceRecordId> {
    const key = normalizeReferenceKey(name);
    const existing = await pool.query<{ reference_record_id: ReferenceRecordId }>(
      "SELECT reference_record_id FROM catalog_reference_records WHERE type_key = $1 AND key = $2",
      [typeKey, key],
    );
    if (existing.rows[0]) {
      return existing.rows[0].reference_record_id;
    }
    const referenceRecordId = `ref_name_keyed_${typeKey}_${key.replace(/-/g, "_")}` as ReferenceRecordId;
    const streamId = `catalog.reference-record-${referenceRecordId}`;
    await services.referenceData.referenceRecordCommandHandler({
      streamId,
      command: {
        type: "CreateReferenceRecord",
        referenceRecordId,
        typeKey,
        key,
        name: localizedTextMapFromEnglish(name),
        description: localizedTextMapFromEnglish(`${name} name-keyed Reference Record.`),
      },
      context,
    });
    await services.referenceData.referenceRecordCommandHandler({
      streamId,
      command: { type: "PublishReferenceRecord" },
      context,
    });
    await drain();
    return referenceRecordId;
  }

  /** Plans promotion through the executable planner and projects the item through `projection.ts`. */
  async function projectPromotedItem(input: {
    catalogItemId: string;
    profile: CatalogProviderIntegrationProfile;
    contract: CatalogProviderSourceObservationMappingContract;
    observation: ReturnType<typeof observe>;
    lookup: ReferenceLookup;
    reference: Readonly<{ typeKey: string; nameKey: "expansionName" | "setName" }>;
    skipCommand?: (command: CatalogItemCommand) => boolean;
  }) {
    const hierarchy = await resolvePromotionReferenceHierarchy({
      deps,
      referenceData: services.referenceData,
      profile: input.profile,
      normalized: input.observation.normalized,
      context,
    });
    await drain();
    const referenceName = String(
      (input.observation.normalized as unknown as Record<string, unknown>)[input.reference.nameKey],
    );
    const referenceRecordId =
      input.lookup === "name-keyed"
        ? await nameKeyedReferenceRecord(input.reference.typeKey, referenceName)
        : hierarchy.targetReferenceRecordId;
    const catalog = await loadCatalogItemPromotionProfile(deps, input.profile);
    const planned = await planCatalogProviderPromotionCommands({
      db: pool,
      promoteAsDraft: true,
      profile: input.profile,
      profileKey: input.contract.profileKey,
      profileVersion: input.contract.profileVersion,
      providerKey: input.observation.providerKey,
      externalKey: input.observation.externalKey,
      mode: "create",
      catalogItemId: input.catalogItemId as CatalogItemId,
      normalized: input.observation.normalized,
      catalog,
      expansionReferenceId: referenceRecordId,
      setReferenceId: referenceRecordId,
      metadata: { title: input.observation.normalized.name, subtitle: "" },
      productAssetSet: null,
      preflight: { status: "ready" },
    });
    if (planned.status !== "planned") {
      throw new Error(`Promotion planning blocked: ${JSON.stringify(planned.diagnostics)}`);
    }
    for (const command of planned.plan.commands) {
      if (input.skipCommand?.(command)) {
        continue;
      }
      await itemCommand(input.catalogItemId, command);
    }
    await drain();
    return { catalog, plan: planned.plan, referenceRecordId, referenceName };
  }

  async function itemCommand(catalogItemId: string, command: CatalogItemCommand) {
    await services.items.commandHandler({ streamId: `catalog.item-${catalogItemId}`, command, context });
  }

  async function resolve(input: {
    profile: CatalogProviderIntegrationProfile;
    ruleKey: string;
    observation: ReturnType<typeof observe>;
    normalized?: SourceObservationNormalized;
    providerKey?: string;
    externalKey?: string;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
  }) {
    const trace: TracedQuery[] = [];
    const db: CatalogProviderDuplicatePreventionDb = {
      async query<T>(sql: string, values: readonly unknown[] = []) {
        trace.push({ sql, values });
        return pool.query<T>(sql, [...values]);
      },
    };
    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: profileWithOnlyRule(input.profile, input.ruleKey),
      providerKey: input.providerKey ?? input.observation.providerKey,
      externalKey: input.externalKey ?? input.observation.externalKey,
      normalized: input.normalized ?? input.observation.normalized,
      catalog: input.catalog,
    });
    return { result, trace };
  }

  it.each(fieldRuleCases)(
    "$ruleKey matches a projected item holding every rule field and refuses any differing or absent field",
    async (testCase) => {
      const observation = observe(testCase.contract, testCase.payload);
      const catalogItemId = `cat_field_rule_${testCase.ruleKey.replace(/-/g, "_")}`;
      const { catalog, plan } = await projectPromotedItem({
        catalogItemId,
        profile: testCase.profile,
        contract: testCase.contract,
        observation,
        lookup: testCase.reference.lookup,
        reference: testCase.reference,
      });
      const resolveRule = (normalized?: SourceObservationNormalized) =>
        resolve({ profile: testCase.profile, ruleKey: testCase.ruleKey, observation, normalized, catalog });

      expect((await resolveRule()).result).toMatchObject({
        status: "matched",
        catalogItemId,
        ruleKey: testCase.ruleKey,
      });

      const fieldMatches = ruleFieldMatches(testCase.profile, testCase.ruleKey);
      expect(fieldMatches.length).toBeGreaterThan(0);
      for (const fieldMatch of fieldMatches) {
        const differing = withTopLevelValue(
          observation.normalized,
          fieldMatch.valuePath,
          differentValue(topLevelValue(observation.normalized, fieldMatch.valuePath)),
        );
        expect((await resolveRule(differing)).result, `differing ${fieldMatch.valuePath}`).toMatchObject({
          status: "none",
        });
      }

      const requiredFieldIds = [
        ...fieldMatches.map((fieldMatch) => requireFieldId(catalog, fieldMatch.fieldKey)),
        requireFieldId(catalog, testCase.reference.fieldKey),
      ];
      for (const fieldId of requiredFieldIds) {
        await itemCommand(catalogItemId, { type: "ClearCatalogItemFieldValue", fieldId });
        await drain();
        expect((await resolveRule()).result, `absent ${fieldId}`).toMatchObject({ status: "none" });
        await itemCommand(catalogItemId, plannedFieldValue(plan, fieldId));
        await drain();
      }

      expect((await resolveRule()).result).toMatchObject({ status: "matched", catalogItemId });
    },
  );

  it("controls one projected row: the object operand is not contained, the array operand is, and the plan reads catalog_items", async () => {
    const observation = observe(scryfallMtgCardPrintSourceObservationMappingContract, scryfallFixture);
    const catalogItemId = "cat_field_rule_operand_control";
    const { catalog } = await projectPromotedItem({
      catalogItemId,
      profile: scryfallMtgCardPrintProviderProfile,
      contract: scryfallMtgCardPrintSourceObservationMappingContract,
      observation,
      lookup: "provider-hierarchy",
      reference: { typeKey: "set", nameKey: "setName" },
    });
    const { result, trace } = await resolve({
      profile: scryfallMtgCardPrintProviderProfile,
      ruleKey: "magic-card-print-deterministic-fields",
      observation,
      catalog,
    });
    expect(result).toMatchObject({ status: "matched", catalogItemId });

    const fieldQuery = trace.find((query) => query.sql.includes("item.field_values @>"));
    if (!fieldQuery) {
      throw new Error("The resolver issued no field-match query.");
    }
    const parameters = [...fieldQuery.sql.matchAll(/item\.field_values @> \$(\d+)::jsonb/g)].map(([, parameter]) =>
      Number(parameter),
    );
    expect(parameters).toHaveLength(3);
    for (const parameter of parameters) {
      const operand = JSON.parse(String(fieldQuery.values[parameter - 1])) as unknown[];
      expect(operand).toHaveLength(1);
      const control = await pool.query<{ object_match: boolean; array_match: boolean }>(
        `SELECT field_values @> $2::jsonb AS object_match, field_values @> $3::jsonb AS array_match
         FROM catalog_items
         WHERE catalog_item_id = $1`,
        [catalogItemId, JSON.stringify(operand[0]), JSON.stringify(operand)],
      );
      expect(control.rows).toEqual([{ object_match: false, array_match: true }]);
    }

    const explained = await pool.query<{ "QUERY PLAN": { Plan: QueryPlanNode }[] }>(
      `EXPLAIN (FORMAT JSON) ${fieldQuery.sql}`,
      [...fieldQuery.values],
    );
    expect(planRelations(explained.rows[0]["QUERY PLAN"][0].Plan)).toContain("catalog_items");
  });

  describe("partial Pokemon draft retry gates", () => {
    const ruleKey = "pokemon-card-partial-draft-retry";
    const isReferenceLink = (command: CatalogItemCommand) => command.type.startsWith("LinkExternal");

    async function projectPartialDraft(catalogItemId: string) {
      const observation = observe(tcgdexPokemonCardSourceObservationMappingContract, tcgdexFixture);
      // A partial draft is a promotion that stopped before its reference links.
      const projected = await projectPromotedItem({
        catalogItemId,
        profile: tcgdexPokemonTcgProviderProfile,
        contract: tcgdexPokemonCardSourceObservationMappingContract,
        observation,
        lookup: "provider-hierarchy",
        reference: { typeKey: "expansion", nameKey: "expansionName" },
        skipCommand: isReferenceLink,
      });
      const resolveRule = (normalized?: SourceObservationNormalized) =>
        resolve({
          profile: tcgdexPokemonTcgProviderProfile,
          ruleKey,
          observation,
          normalized,
          catalog: projected.catalog,
        });
      return { ...projected, observation, resolveRule };
    }

    it("matches a draft with the required tags, rule fields, and no Product reference without an expansion lookup", async () => {
      const catalogItemId = "cat_partial_draft_match";
      const { resolveRule } = await projectPartialDraft(catalogItemId);

      const { result, trace } = await resolveRule();
      expect(result).toMatchObject({ status: "matched", catalogItemId, ruleKey });
      expect(trace.some((query) => query.sql.includes("FROM catalog_reference_records"))).toBe(false);
      const partialQuery = trace.find((query) => query.sql.includes("item.status = 'draft'"));
      expect(partialQuery?.sql.match(/item\.field_values @>/g)).toHaveLength(3);
    });

    it("refuses a differing rule field", async () => {
      const { observation, resolveRule } = await projectPartialDraft("cat_partial_draft_differing");

      expect(
        (await resolveRule(withTopLevelValue(observation.normalized, "name", "Synthetic Different Name"))).result,
      ).toMatchObject({ status: "none" });
    });

    it("refuses a draft that already carries an external Product reference", async () => {
      const catalogItemId = "cat_partial_draft_referenced";
      const { plan, resolveRule } = await projectPartialDraft(catalogItemId);
      const sourceLink = plan.commands.find((command) => command.type === "LinkExternalProductReference");
      if (!sourceLink) {
        throw new Error("The promotion plan has no source-observation Product reference.");
      }

      await itemCommand(catalogItemId, sourceLink);
      await drain();

      expect((await resolveRule()).result).toMatchObject({ status: "none" });
    });

    it("refuses a draft missing a required tag", async () => {
      const catalogItemId = "cat_partial_draft_untagged";
      const { plan, resolveRule } = await projectPartialDraft(catalogItemId);
      const tags = plan.commands.find((command) => command.type === "SetCatalogItemTags");
      if (!tags || tags.type !== "SetCatalogItemTags") {
        throw new Error("The promotion plan sets no tags.");
      }
      expect(tags.tags).toContain("variant:standard");

      await itemCommand(catalogItemId, { ...tags, tags: tags.tags.filter((tag) => tag !== "variant:standard") });
      await drain();

      expect((await resolveRule()).result).toMatchObject({ status: "none" });
    });

    it("refuses an item that is no longer a draft", async () => {
      const catalogItemId = "cat_partial_draft_published";
      const { resolveRule } = await projectPartialDraft(catalogItemId);

      const published = await services.items.publishBulk([catalogItemId], context);
      expect(published, JSON.stringify(published.candidates)).toMatchObject({ published_count: 1 });
      await drain();
      const status = await pool.query<{ status: string }>(
        "SELECT status FROM catalog_items WHERE catalog_item_id = $1",
        [catalogItemId],
      );
      expect(status.rows).toEqual([{ status: "active" }]);

      expect((await resolveRule()).result).toMatchObject({ status: "none" });
    });
  });

  it("finds the owner of a mixed-case, whitespace-padded Product reference recorded through the Catalog Item domain", async () => {
    const observation = observe(tcgdexPokemonCardSourceObservationMappingContract, tcgdexFixture);
    const catalogItemId = "cat_source_link_owner";
    const { catalog } = await projectPromotedItem({
      catalogItemId,
      profile: tcgdexPokemonTcgProviderProfile,
      contract: tcgdexPokemonCardSourceObservationMappingContract,
      observation,
      lookup: "provider-hierarchy",
      reference: { typeKey: "expansion", nameKey: "expansionName" },
      skipCommand: (command) => command.type.startsWith("LinkExternal"),
    });
    await itemCommand(catalogItemId, {
      type: "LinkExternalProductReference",
      providerKey: " TCGdex ",
      externalKey: " EN:PRODUCT:493958 ",
    });
    await drain();
    const stored = await pool.query<{ provider_key: string; external_key: string }>(
      "SELECT provider_key, external_key FROM catalog_external_product_references WHERE catalog_item_id = $1",
      [catalogItemId],
    );
    expect(stored.rows).toEqual([{ provider_key: "tcgdex", external_key: "en:product:493958" }]);

    const lookup = (externalKey: string) =>
      resolve({
        profile: tcgdexPokemonTcgProviderProfile,
        ruleKey: "source-observation-link",
        observation,
        providerKey: " TCGdex ",
        externalKey,
        catalog,
      });

    expect((await lookup(" PRODUCT:493958 ")).result).toMatchObject({
      status: "matched",
      catalogItemId,
      ruleKey: "source-observation-link",
    });
    expect((await lookup(" PRODUCT:999999 ")).result).toEqual({ status: "none", evidenceSummaries: [] });
  });
});

type QueryPlanNode = Readonly<{ "Relation Name"?: string; Plans?: readonly QueryPlanNode[] }>;

function planRelations(plan: QueryPlanNode): string[] {
  return [...(plan["Relation Name"] ? [plan["Relation Name"]] : []), ...(plan.Plans ?? []).flatMap(planRelations)];
}

function profileWithOnlyRule(
  profile: CatalogProviderIntegrationProfile,
  ruleKey: string,
): CatalogProviderIntegrationProfile {
  const rule = profile.duplicatePreventionMapping.rules.find((candidate) => candidate.ruleKey === ruleKey);
  if (!rule) {
    throw new Error(`${profile.displayName} has no duplicate-prevention rule '${ruleKey}'.`);
  }
  return { ...profile, duplicatePreventionMapping: { ...profile.duplicatePreventionMapping, rules: [rule] } };
}

function ruleFieldMatches(profile: CatalogProviderIntegrationProfile, ruleKey: string) {
  const rule = profileWithOnlyRule(profile, ruleKey).duplicatePreventionMapping.rules[0];
  return "fieldMatches" in rule ? rule.fieldMatches : [];
}

function requireFieldId(
  catalog: CatalogProviderPromotionResolvedCatalogMapping,
  fieldKey: keyof CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
): FieldId {
  const fieldId = catalog.fieldIds[fieldKey];
  if (!fieldId) {
    throw new Error(`The catalog mapping has no '${fieldKey}' field.`);
  }
  return fieldId;
}

function plannedFieldValue(plan: CatalogProviderPromotionCommandPlan, fieldId: FieldId): SetFieldValueCommand {
  const command = plan.commands.find(
    (candidate): candidate is SetFieldValueCommand =>
      candidate.type === "SetCatalogItemFieldValue" && candidate.fieldId === fieldId,
  );
  if (!command) {
    throw new Error(`The promotion plan sets no value for field '${fieldId}'.`);
  }
  return command;
}

function topLevelValue(normalized: SourceObservationNormalized, path: string): JsonValue {
  expect(path).not.toContain(".");
  const value = (normalized as unknown as Record<string, JsonValue | undefined>)[path];
  if (value === undefined || value === null) {
    throw new Error(`The observation has no '${path}' value.`);
  }
  return value;
}

function withTopLevelValue(
  normalized: SourceObservationNormalized,
  path: string,
  value: JsonValue,
): SourceObservationNormalized {
  expect(path).not.toContain(".");
  return { ...normalized, [path]: value } as SourceObservationNormalized;
}

function differentValue(value: JsonValue): JsonValue {
  return typeof value === "number" ? value + 1 : `${String(value)} (synthetic different)`;
}
