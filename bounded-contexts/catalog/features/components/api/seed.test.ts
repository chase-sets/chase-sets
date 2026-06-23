import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedOnePieceComponents } from "./seed";

describe("component seed", () => {
  it("seeds One Piece card and sealed components from shared card product dimensions", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = {
      db: { query: async <T>() => ({ rows: [] as T[] }) },
      components: {
        commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
          commands.push({ streamId: input.streamId, command: input.command });
        },
      },
    };

    const ids = await seedOnePieceComponents(services as never, dimensions() as never, keyBackedIds("fld") as never);

    expect(ids["one-piece-card-print-identity"]).toBe(catalogSeedIds.components.onePieceCardPrintIdentity);
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.component-${catalogSeedIds.components.onePieceCardPrintIdentity}`,
        command: expect.objectContaining({
          type: "AddFieldRuleToComponent",
          fieldId: "fld_set",
          required: true,
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.component-${catalogSeedIds.components.onePieceCardProductResolution}`,
        command: expect.objectContaining({
          type: "AddDimensionRuleToComponent",
          dimensionId: "dim_condition",
          required: true,
          appliesWhen: [{ dimensionId: "dim_form", optionIds: ["chc_raw"] }],
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        streamId: `catalog.component-${catalogSeedIds.components.onePieceSealedProductIdentity}`,
        command: expect.objectContaining({
          type: "AddFieldRuleToComponent",
          fieldId: "fld_pack-count",
          required: true,
        }),
      }),
    );
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
