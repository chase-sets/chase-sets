import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedLorcanaBlueprints, seedOnePieceBlueprints } from "./seed";

describe("blueprint seed", () => {
  it("seeds One Piece card and sealed blueprints with deterministic product resolution", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = {
      db: { query: async <T>() => ({ rows: [] as T[] }) },
      blueprints: {
        commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
          commands.push({ streamId: input.streamId, command: input.command });
        },
      },
    };

    const ids = await seedOnePieceBlueprints(
      services as never,
      keyBackedIds("cmp") as never,
      dimensions() as never,
      keyBackedIds("fld") as never,
    );

    expect(ids["one-piece-card-print"]).toBe(catalogSeedIds.blueprints.onePieceCardPrint);
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.blueprint-${catalogSeedIds.blueprints.onePieceCardPrint}`,
        command: expect.objectContaining({
          type: "SetBlueprintProductResolutionRules",
          canonicalDimensionOrder: ["dim_form", "dim_condition", "dim_grading_company", "dim_grade"],
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.blueprint-${catalogSeedIds.blueprints.onePieceCardPrint}`,
        command: expect.objectContaining({
          type: "SetBlueprintFields",
          fieldRules: expect.arrayContaining([
            { fieldId: "fld_card-number", required: true },
            { fieldId: "fld_card-name", required: true },
            { fieldId: "fld_set", required: true },
            { fieldId: "fld_card-variant", required: false },
          ]),
        }),
      }),
    );
    expect(
      commands.some(
        ({ streamId, command }) =>
          streamId === `catalog.blueprint-${catalogSeedIds.blueprints.onePieceSealedProduct}` &&
          command.type === "SetBlueprintProductResolutionRules",
      ),
    ).toBe(false);
  });

  it("seeds Lorcana card and sealed blueprints without schema changes", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = {
      db: { query: async <T>() => ({ rows: [] as T[] }) },
      blueprints: {
        commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
          commands.push({ streamId: input.streamId, command: input.command });
        },
      },
    };

    const ids = await seedLorcanaBlueprints(
      services as never,
      keyBackedIds("cmp") as never,
      dimensions() as never,
      keyBackedIds("fld") as never,
    );

    expect(ids["lorcana-card-print"]).toBe(catalogSeedIds.blueprints.lorcanaCardPrint);
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.blueprint-${catalogSeedIds.blueprints.lorcanaCardPrint}`,
        command: expect.objectContaining({
          type: "SetBlueprintProductResolutionRules",
          canonicalDimensionOrder: ["dim_form", "dim_condition", "dim_grading_company", "dim_grade"],
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.blueprint-${catalogSeedIds.blueprints.lorcanaCardPrint}`,
        command: expect.objectContaining({
          type: "SetBlueprintFields",
          fieldRules: expect.arrayContaining([
            { fieldId: "fld_card-number", required: true },
            { fieldId: "fld_card-name", required: true },
            { fieldId: "fld_set", required: true },
            { fieldId: "fld_card-variant", required: false },
            { fieldId: "fld_ink-color", required: false },
            { fieldId: "fld_card-type", required: false },
            { fieldId: "fld_card-classifications", required: false },
            { fieldId: "fld_card-properties", required: false },
            { fieldId: "fld_card-illustrator", required: false },
          ]),
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.blueprint-${catalogSeedIds.blueprints.lorcanaSealedProduct}`,
        command: expect.objectContaining({
          type: "SetBlueprintFields",
          fieldRules: expect.arrayContaining([
            { fieldId: "fld_set", required: true },
            { fieldId: "fld_sealed-product-form", required: true },
            { fieldId: "fld_pack-count", required: false },
          ]),
        }),
      }),
    );
    expect(
      commands.some(
        ({ streamId, command }) =>
          streamId === `catalog.blueprint-${catalogSeedIds.blueprints.lorcanaSealedProduct}` &&
          command.type === "SetBlueprintProductResolutionRules",
      ),
    ).toBe(false);
  });
});

function dimensions() {
  return {
    form: {
      dimensionId: "dim_form",
      optionIds: { raw: "chc_raw", graded: "chc_graded" },
      orderedOptionIds: ["chc_raw", "chc_graded"],
    },
    condition: {
      dimensionId: "dim_condition",
      optionIds: {},
      orderedOptionIds: ["chc_near_mint"],
    },
    "grading-company": {
      dimensionId: "dim_grading_company",
      optionIds: {},
      orderedOptionIds: ["chc_psa"],
    },
    grade: {
      dimensionId: "dim_grade",
      optionIds: {},
      orderedOptionIds: ["chc_gem_mint_10"],
    },
  };
}

function keyBackedIds(prefix: string): Record<string, string> {
  return new Proxy(
    {},
    {
      get: (_target, property) => `${prefix}_${String(property)}`,
    },
  ) as Record<string, string>;
}
