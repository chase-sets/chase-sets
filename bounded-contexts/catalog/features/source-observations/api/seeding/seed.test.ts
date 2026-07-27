import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { describe, expect, it } from "vitest";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationCommand,
  type SourceObservationState,
} from "../../domain/domain";
import {
  buildCatalogBrowserE2ePromotedObservationSeedEvidence,
  catalogBrowserE2ePromotedObservation,
  seedPromotedSourceObservationScenario,
} from "./seed";

describe("promoted Source Observation scenario seed", () => {
  it("derives the bounded TCGdex fixture through the executable mapper and promotion planner", async () => {
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence();

    expect(evidence.recordCommand).toMatchObject({
      type: "RecordSourceObservation",
      observationId: "tcgdex_en_base2_60",
      externalKey: "base2-60",
      providerKey: "tcgdex",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      sourceRecordHash: "33176435566a66d6f02e6d9a2e61716cc1d7d3dc51d945e5a4a2a708365065c4",
      sourceUpdatedAt: "2026-05-23T17:18:39+01:00",
      normalized: expect.objectContaining({
        name: "Pikachu",
        illustrator: "Ken Sugimori",
        cardVariantKey: "standard",
        variants: {
          firstEdition: true,
          holo: false,
          normal: true,
          reverse: false,
          wPromo: false,
        },
      }),
      sourcePayload: expect.objectContaining({
        id: "base2-60",
        illustrator: "Ken Sugimori",
        updated: "2026-05-23T17:18:39+01:00",
      }),
    });
    expect(evidence.recordCommand.sourcePayload).not.toHaveProperty("pricing");
    expect(evidence.promotionPlan).toMatchObject({
      mode: "refresh",
      catalogItemId: catalogSeedIds.items.pikachuJungle,
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.03",
    });
    expect(evidence.promotionCommand.promotionPlanFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.promotionCommand.promotionPlanFingerprint).not.toBe(
      evidence.recordCommand.sourceMappingFingerprint,
    );
  });

  it("records and promotes one identity-consistent observation from empty history", async () => {
    const commands: Array<{ streamId: string; command: SourceObservationCommand }> = [];
    const services = fakeServices([], commands);

    await seedPromotedSourceObservationScenario(services as never);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      streamId: `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}`,
      command: { type: "RecordSourceObservation", observationId: catalogBrowserE2ePromotedObservation.observationId },
    });
    expect(commands[1]).toMatchObject({
      command: {
        type: "PromoteSourceObservation",
        catalogItemId: catalogSeedIds.items.pikachuJungle,
        promotionProfileKey: "pokemon-tcg",
        promotionProfileVersion: "2026.06.03",
      },
    });
  });

  it("does not append duplicate events after the exact promoted aggregate exists", async () => {
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence();
    const { rows } = exactHistory(evidence.recordCommand, evidence.promotionCommand);
    const commands: Array<{ streamId: string; command: SourceObservationCommand }> = [];

    await seedPromotedSourceObservationScenario(fakeServices(rows, commands) as never);

    expect(commands).toEqual([]);
  });

  it("rejects a recorded aggregate whose mapped facts do not match the fixture", async () => {
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence();
    const { rows } = exactHistory(evidence.recordCommand);
    rows[0] = {
      ...rows[0]!,
      payload: {
        ...rows[0]!.payload,
        normalized: { ...(rows[0]!.payload.normalized as object), name: "Raichu" },
      },
    };

    await expect(seedPromotedSourceObservationScenario(fakeServices(rows, []) as never)).rejects.toThrow(
      "mismatched identity, facts, target, profile, terminal state, or fingerprint",
    );
  });
});

function exactHistory(...commands: SourceObservationCommand[]) {
  let state: SourceObservationState = initialSourceObservationState;
  const rows: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  for (const command of commands) {
    const events = decideSourceObservation(state, command);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    rows.push({ event_type: event.type, payload: event.data as Record<string, unknown> });
    state = evolveSourceObservation(state, event);
  }
  return { rows, state };
}

function fakeServices(
  rows: readonly { event_type: string; payload: Record<string, unknown> }[],
  commands: Array<{ streamId: string; command: SourceObservationCommand }>,
) {
  return {
    db: {
      query: async (sql: string) =>
        sql.includes("projection_active")
          ? { rows: [{ stream_created: true, stream_published: true, projection_active: true }] }
          : { rows },
    },
    sourceObservations: {
      commandHandler: async (input: { streamId: string; command: SourceObservationCommand }) => {
        commands.push({ streamId: input.streamId, command: input.command });
      },
    },
  };
}
