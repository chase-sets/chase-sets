import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationCommand,
  type SourceObservationState,
} from "../../domain/domain";
import { buildCatalogBrowserE2ePromotedObservationSeedEvidence, seedPromotedSourceObservationScenario } from "./seed";

const oldFingerprint = "f0d75b34e937923016ba19fad5b9b611e101d8e31b8cbe2176e26aadaf4de599";
const currentFingerprint = "9ec3a12b68c7f1945da0089934ddc97ccc956d5a799c98d2cb8d9c61614ad90c";
type Row = { event_type: string; payload: Record<string, unknown>; stream_version: number };

// Public scenario facts from catalog-items/api/seed.ts, display-templates/api/seed.ts,
// and reference-data/api/seed.ts. No captured database rows or fabricated provider facts.
function scenarioDb(history: Row[] = []): PgQueryable {
  const fields = [
    [catalogSeedIds.fields.cardNumber, "card-number"],
    [catalogSeedIds.fields.cardName, "card-name"],
    [catalogSeedIds.fields.expansion, "expansion"],
    [catalogSeedIds.fields.rarity, "rarity"],
    [catalogSeedIds.fields.cardVariant, "card-variant"],
    [catalogSeedIds.fields.cardIllustrator, "card-illustrator"],
    [catalogSeedIds.fields.releaseYear, "release-year"],
  ].map(([field_id, key]) => ({ field_id, key }));
  return {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      let rows: unknown[];
      if (sql.includes("projection_active")) {
        rows = [{ stream_created: true, stream_published: true, projection_active: true }];
      } else if (sql.includes("FROM event_store_events")) {
        rows = structuredClone(history);
      } else if (sql.includes("FROM catalog_fields")) {
        rows = fields;
      } else if (sql.includes("FROM catalog_display_templates")) {
        rows = [
          {
            key: "pokemon-single-card-default",
            target_kind: "blueprint",
            target_id: catalogSeedIds.blueprints.pokemonCardSingle,
            priority: 10,
            title_template:
              "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
            subtitle_template: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
            required_field_keys: ["card-name", "card-number", "rarity"],
          },
        ];
      } else if (sql.includes("FROM catalog_reference_records")) {
        rows = [
          {
            reference_record_id: catalogSeedIds.referenceRecords.expansions.jungle,
            type_key: "expansion",
            key: "jungle",
            name: "Jungle",
            status: "active",
            attributes: {
              abbreviation: "JU",
              "card-count": 64,
              "release-date": "1999-06-16",
              "tcgdex-set-id": "base2",
            },
            relationships: [{ relationshipType: "part-of", referenceId: catalogSeedIds.referenceRecords.series.base }],
          },
          {
            reference_record_id: catalogSeedIds.referenceRecords.series.base,
            type_key: "series",
            key: "base",
            name: "Base",
            status: "active",
            attributes: { "tcgdex-series-id": "base" },
            relationships: [
              {
                relationshipType: "part-of",
                referenceId: catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
              },
            ],
          },
          {
            reference_record_id: catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
            type_key: "product-line",
            key: "pokemon-trading-card-game",
            name: "Pokemon Trading Card Game",
            status: "active",
            attributes: { "official-name": "Pokemon Trading Card Game", "short-name": "Pokemon TCG" },
            relationships: [
              {
                relationshipType: "published-by",
                referenceId: catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational,
              },
            ],
          },
          {
            reference_record_id: catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational,
            type_key: "manufacturer",
            key: "the-pokemon-company-international",
            name: "The Pokemon Company International",
            status: "active",
            attributes: { "homepage-url": "https://www.pokemon.com/us" },
            relationships: [],
          },
        ].filter((row) => Array.isArray(values[0]) && values[0].includes(row.reference_record_id));
      } else if (sql.includes("FROM catalog_item_aliases") || sql.includes("FROM catalog_reference_record_aliases")) {
        rows = [];
      } else if (sql.includes("FROM catalog_items")) {
        rows = [
          {
            catalog_item_id: catalogSeedIds.items.pikachuJungle,
            language_code: "en",
            status: "active",
            title: "Pikachu",
            subtitle: "Jungle 60/64 Common",
            blueprint_id: catalogSeedIds.blueprints.pokemonCardSingle,
            field_values: [
              { fieldId: catalogSeedIds.fields.cardNumber, value: "60" },
              { fieldId: catalogSeedIds.fields.cardName, value: { defaultLocale: "en", values: { en: "Pikachu" } } },
              {
                fieldId: catalogSeedIds.fields.expansion,
                value: { referenceId: catalogSeedIds.referenceRecords.expansions.jungle },
              },
              { fieldId: catalogSeedIds.fields.rarity, value: "Common" },
              { fieldId: catalogSeedIds.fields.cardIllustrator, value: "Kagemaru Himeno" },
              { fieldId: catalogSeedIds.fields.releaseYear, value: 1999 },
            ],
            category_ids: [
              catalogSeedIds.categories.pokemonTcg,
              catalogSeedIds.categories.singles,
              catalogSeedIds.categories.gen1,
              catalogSeedIds.categories.electric,
            ],
          },
        ];
      } else {
        throw new Error(`Unexpected scenario fixture query: ${sql}`);
      }
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

async function historicalFixture() {
  const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(scenarioDb());
  expect(evidence.promotionPlan.planFingerprint).toBe(currentFingerprint);
  let state: SourceObservationState = initialSourceObservationState;
  const rows: Row[] = [];
  for (const command of [
    evidence.recordCommand,
    { ...evidence.promotionCommand, promotionPlanFingerprint: oldFingerprint },
  ]) {
    for (const event of decideSourceObservation(state, command)) {
      rows.push({
        event_type: event.type,
        payload: event.data as Record<string, unknown>,
        stream_version: rows.length + 1,
      });
      state = evolveSourceObservation(state, event);
    }
  }
  return { evidence, rows, state };
}

describe("allowlisted Source Observation plan-contract migration", () => {
  it("appends the existing plan command at version two and preserves the original events across repeats", async () => {
    const fixture = await historicalFixture();
    const before = structuredClone(fixture.rows);
    const calls: unknown[] = [];
    const services = {
      db: scenarioDb(fixture.rows),
      sourceObservations: {
        commandHandler: async (input: { command: SourceObservationCommand; expectedVersion?: number }) => {
          calls.push(input);
          expect(input.expectedVersion).toBe(2);
          for (const event of decideSourceObservation(fixture.state, input.command)) {
            fixture.rows.push({
              event_type: event.type,
              payload: event.data as Record<string, unknown>,
              stream_version: 3,
            });
            fixture.state = evolveSourceObservation(fixture.state, event);
          }
        },
      },
    };
    await seedPromotedSourceObservationScenario(services as never);
    await seedPromotedSourceObservationScenario(services as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: { type: "RecordSourceObservationPromotionPlan", promotionPlanFingerprint: currentFingerprint },
    });
    expect(fixture.rows.slice(0, 2)).toEqual(before);
    expect(fixture.state).toMatchObject({
      status: "promoted",
      promotedAt: "2026-06-03T00:01:00.000Z",
      promotionPlanFingerprint: currentFingerprint,
    });
  });

  it.each([
    ["identity", 0, { observationId: "synthetic-other-observation" }],
    ["facts", 0, { sourceRecordHash: "synthetic-wrong-facts" }],
    ["target", 1, { catalogItemId: "cat_synthetic_other" }],
    ["profile", 1, { promotionProfileKey: "synthetic-other-profile" }],
    ["profile version", 1, { promotionProfileVersion: "synthetic-other-version" }],
    ["old hash", 1, { promotionPlanFingerprint: "f".repeat(64) }],
    ["promoted-at", 1, { promotedAt: "2026-06-04T00:01:00.000Z" }],
    ["extra payload", 0, { syntheticUnexpected: true }],
  ] as const)("refuses changed predecessor %s without appending", async (_name, index, patch) => {
    const { rows } = await historicalFixture();
    rows[index]!.payload = { ...rows[index]!.payload, ...patch };
    const before = structuredClone(rows);
    let calls = 0;
    await expect(
      seedPromotedSourceObservationScenario({
        db: scenarioDb(rows),
        sourceObservations: {
          commandHandler: async () => {
            calls += 1;
          },
        },
      } as never),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(rows).toEqual(before);
  });

  it("refuses changed resolver inputs rather than substituting the allowlisted successor", async () => {
    const { rows } = await historicalFixture();
    const db = scenarioDb(rows);
    let calls = 0;
    const changed: PgQueryable = {
      async query<T>(sql: string, values?: readonly unknown[]) {
        const result = await db.query<T>(sql, values);
        if (sql.includes("FROM catalog_display_templates")) {
          return { ...result, rows: result.rows.map((row) => ({ ...row, key: "synthetic-future-template" })) };
        }
        return result;
      },
    };
    await expect(
      seedPromotedSourceObservationScenario({
        db: changed,
        sourceObservations: {
          commandHandler: async () => {
            calls += 1;
          },
        },
      } as never),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it.each(["predecessor", "migration payload", "extra event", "wrong version", "terminal"] as const)(
    "refuses migrated lifecycle with changed %s",
    async (kind) => {
      const { rows, state, evidence } = await historicalFixture();
      const command: SourceObservationCommand = {
        ...evidence.promotionCommand,
        type: "RecordSourceObservationPromotionPlan",
      };
      const event = decideSourceObservation(state, command)[0]!;
      rows.push({ event_type: event.type, payload: event.data as Record<string, unknown>, stream_version: 3 });
      if (kind === "predecessor") rows[1]!.payload.promotionPlanFingerprint = currentFingerprint;
      if (kind === "migration payload") rows[2]!.payload.syntheticUnexpected = true;
      if (kind === "extra event") rows.push({ ...rows[2]!, stream_version: 4 });
      if (kind === "wrong version") rows[2]!.stream_version = 4;
      if (kind === "terminal")
        rows[1] = {
          event_type: "catalog.source-observation.rejected",
          payload: { reason: "synthetic rejection" },
          stream_version: 2,
        };
      let calls = 0;
      await expect(
        seedPromotedSourceObservationScenario({
          db: scenarioDb(rows),
          sourceObservations: {
            commandHandler: async () => {
              calls += 1;
            },
          },
        } as never),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );

  it("refuses an unresolved current display identity before the migration command", async () => {
    const { rows } = await historicalFixture();
    const db = scenarioDb(rows);
    let calls = 0;
    const unresolved: PgQueryable = {
      async query<T>(sql: string, values?: readonly unknown[]) {
        const result = await db.query<T>(sql, values);
        if (sql.includes("FROM catalog_display_templates")) {
          return {
            ...result,
            rows: result.rows.map((row) => ({ ...row, title_template: "{field.synthetic-missing}" })),
          };
        }
        return result;
      },
    };
    await expect(
      seedPromotedSourceObservationScenario({
        db: unresolved,
        sourceObservations: {
          commandHandler: async () => {
            calls += 1;
          },
        },
      } as never),
    ).rejects.toThrow("promotion plan is blocked");
    expect(calls).toBe(0);
  });

  it("propagates append failure without falling back to refresh or promotion", async () => {
    const { rows } = await historicalFixture();
    const calls: SourceObservationCommand[] = [];
    await expect(
      seedPromotedSourceObservationScenario({
        db: scenarioDb(rows),
        sourceObservations: {
          commandHandler: async (input: { command: SourceObservationCommand }) => {
            calls.push(input.command);
            throw new Error("synthetic append failure");
          },
        },
      } as never),
    ).rejects.toThrow("synthetic append failure");
    expect(calls.map((command) => command.type)).toEqual(["RecordSourceObservationPromotionPlan"]);
    expect(rows).toHaveLength(2);
  });
});
