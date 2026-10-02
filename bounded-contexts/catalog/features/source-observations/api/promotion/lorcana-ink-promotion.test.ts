import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogServices } from "../../../../support/authoring-support/services";
import type { CatalogItemId, ReferenceRecordId } from "../../../../ids";
import { seedDisplayTemplates } from "../../../display-templates/api/seed";
import { deriveRequiredFieldKeys, type DisplayTemplateCommand } from "../../../display-templates/domain/domain";
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
import { loadCatalogItemPromotionProfile } from "../source-observation-promotion-execution";
import { createChangedObservationRefreshHarness } from "../seeding/runtime-test-harness";
import {
  createSyntheticDisplayIdentityQueryable,
  syntheticCurrentCatalogItem,
  type SyntheticDisplayTemplate,
} from "../seeding/synthetic-display-identity-queryable";
import { normalizeCatalogProviderSourceObservation } from "./provider-source-observation-normalizer";
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
        name: "The First Chapter",
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

async function plan(mode: CatalogProviderPromotionMode) {
  const harness = await fixture();
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

describe("Lorcana ink promotion through real mapper, active-key loader and seeded template (synthetic Catalog)", () => {
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
