import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { describe, expect, it } from "vitest";
import { catalogBrowserE2ePromotedObservation, seedPromotedSourceObservationScenario } from "./seed";

describe("promoted Source Observation scenario seed", () => {
  it("records and promotes one identity-consistent TCGdex observation", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = fakeServices([], commands);

    await seedPromotedSourceObservationScenario(services as never);

    const streamId = `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}`;
    expect(commands).toEqual([
      {
        streamId,
        command: expect.objectContaining({
          type: "RecordSourceObservation",
          observationId: catalogBrowserE2ePromotedObservation.observationId,
          externalKey: "base2-60",
          providerKey: "tcgdex",
          sourceProfileKey: "pokemon-tcg",
          sourceProfileVersion: "2026.06.03",
          normalized: expect.objectContaining({ name: catalogBrowserE2ePromotedObservation.displayName }),
        }),
      },
      {
        streamId,
        command: expect.objectContaining({
          type: "PromoteSourceObservation",
          catalogItemId: catalogSeedIds.items.pikachuJungle,
          promotionProfileKey: "pokemon-tcg",
          promotionProfileVersion: "2026.06.03",
        }),
      },
    ]);
  });

  it("does not append duplicate commands after the promoted event exists", async () => {
    const commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
    const services = fakeServices(
      [{ event_type: "catalog.source-observation.recorded" }, { event_type: "catalog.source-observation.promoted" }],
      commands,
    );

    await seedPromotedSourceObservationScenario(services as never);

    expect(commands).toEqual([]);
  });
});

function fakeServices(
  rows: readonly { event_type: string }[],
  commands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }>,
) {
  return {
    db: {
      query: async () => ({ rows }),
    },
    sourceObservations: {
      commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
        commands.push({ streamId: input.streamId, command: input.command });
      },
    },
  };
}
