import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { ygojsonYugiohSetReferenceProviderProfile } from "../../source-observations/api/providers/ygojson/executable-mapping-contract";
import { ygoprodeckYugiohSetReferenceProviderProfile } from "../../source-observations/api/providers/ygoprodeck/executable-mapping-contract";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { ReferenceRecordId } from "../../../ids";
import { seedContext } from "../../../support/seed-support/context";
import { createCatalogAliasRuntime } from "../../alias-equivalence/api/runtime";
import { createProviderScopeMappingRuntime } from "../../provider-scope-mapping/api/runtime";
import { providerScopeMappingStreamId } from "../../provider-scope-mapping/domain/domain";
import { buildProviderScopeMappingCandidate } from "../../provider-scope-mapping/domain/mapping";
import {
  evolveReferenceRecord,
  initialReferenceRecordState,
  type ReferenceRecordCommand,
  type ReferenceRecordEvent,
} from "../domain/domain";
import { createReferenceDataRuntime } from "./runtime";
import { seedReferenceData, seedLorcanaReferenceData, seedMagicReferenceData, seedOnePieceReferenceData } from "./seed";

const retryLocalProjectionBlockedStream = vi.hoisted(() =>
  vi.fn<typeof import("@chase-sets/bounded-context-runtime").retryLocalProjectionBlockedStream>(
    async (_contextName, _pool, _projector, streamId) => ({
      projectionKey: "catalog-reference-data-projection:catalog:v1",
      streamId,
      state: "already-resolved" as const,
      inspectedEvents: 0,
      appliedEvents: 0,
      errorMessage: null,
    }),
  ),
);

vi.mock("@chase-sets/bounded-context-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/bounded-context-runtime")>()),
  retryLocalProjectionBlockedStream,
}));

describe("reference data seed", () => {
  beforeEach(() => {
    retryLocalProjectionBlockedStream.mockReset();
    retryLocalProjectionBlockedStream.mockImplementation(async (_contextName, _pool, _projector, streamId) =>
      projectionRetryResult(streamId, "already-resolved"),
    );
  });

  it("seeds the canonical Yu-Gi-Oh product line idempotently for provider profiles", async () => {
    const harness = createReferenceSeedHarness();

    await seedReferenceData(harness.services as never);
    const firstRunDetails = [...harness.details];
    harness.commands.length = 0;
    harness.details.length = 0;

    await seedReferenceData(harness.services as never);

    expect(harness.commands).toEqual([]);
    expect(firstRunDetails).toContainEqual(
      expect.objectContaining({
        key: "yu-gi-oh-official-card-game",
        name: "Yu-Gi-Oh! Official Card Game",
      }),
    );
    expect(firstRunDetails.filter((detail) => detail.key === "yu-gi-oh-official-card-game")).toHaveLength(1);
    const productLineId = catalogSeedIds.referenceRecords.productLines.yuGiOhOfficialCardGame;
    expect(firstRunDetails).toContainEqual(
      expect.objectContaining({
        referenceRecordId: productLineId,
        typeKey: "product-line",
        key: "yu-gi-oh-official-card-game",
      }),
    );
    expect(
      [ygoprodeckYugiohSetReferenceProviderProfile, ygojsonYugiohSetReferenceProviderProfile].map((profile) =>
        profile.referenceHierarchyMapping.referenceRecords.find((rule) => rule.ruleKey === "yugioh-product-line"),
      ),
    ).toEqual([
      expect.objectContaining({ recordId: { kind: "static", referenceRecordId: productLineId } }),
      expect.objectContaining({ recordId: { kind: "static", referenceRecordId: productLineId } }),
    ]);
  });

  it("reconciles Magic reference roots and Time Spiral without recreating Pokemon reference data", async () => {
    const harness = createReferenceSeedHarness();

    const ids = await seedMagicReferenceData(harness.services as never);

    expect(ids.sets["time-spiral"]).toBe(catalogSeedIds.referenceRecords.sets.timeSpiral);
    expect(harness.commands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "CreateReferenceType",
        key: "set",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "CreateReferenceRecord",
        key: "wizards-of-the-coast",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "CreateReferenceRecord",
        key: "magic-the-gathering",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "CreateReferenceRecord",
        key: "time-spiral",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
  });

  it("creates supporting reference types before Magic reference records when bootstrap data is partial", async () => {
    const harness = createReferenceSeedHarness({
      existingReferenceTypeKeys: new Set(["set"]),
    });

    await seedMagicReferenceData(harness.services as never);

    expect(harness.commands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.manufacturer}`,
        type: "CreateReferenceType",
        key: "manufacturer",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.manufacturer}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.productLine}`,
        type: "CreateReferenceType",
        key: "product-line",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.productLine}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "CreateReferenceRecord",
        key: "wizards-of-the-coast",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "CreateReferenceRecord",
        key: "magic-the-gathering",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "CreateReferenceRecord",
        key: "time-spiral",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
  });

  it("seeds One Piece reference taxonomy idempotently with stable product-line naming", async () => {
    const harness = createReferenceSeedHarness({
      existingReferenceTypeKeys: new Set(["manufacturer", "product-line"]),
    });

    const ids = await seedOnePieceReferenceData(harness.services as never);
    const firstRunCommands = [...harness.commands];
    harness.commands.length = 0;
    const firstRunAliasCommands = [...harness.aliasCommands];
    harness.aliasCommands.length = 0;

    const rerunIds = await seedOnePieceReferenceData(harness.services as never);

    expect(ids.sets["romance-dawn"]).toBe(catalogSeedIds.referenceRecords.sets.romanceDawn);
    expect(rerunIds).toEqual(ids);
    expect(harness.commands).toEqual([]);
    expect(harness.aliasCommands).toEqual([]);
    expect(firstRunCommands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "CreateReferenceType",
        key: "set",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.bandai}`,
        type: "CreateReferenceRecord",
        key: "bandai",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.bandai}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.onePieceCardGame}`,
        type: "CreateReferenceRecord",
        key: "one-piece-card-game",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.onePieceCardGame}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.romanceDawn}`,
        type: "CreateReferenceRecord",
        key: "romance-dawn",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.romanceDawn}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "one-piece-card-game",
        name: "One Piece Card Game",
        attributes: { "official-name": "One Piece Card Game", "short-name": "One Piece" },
      }),
    );
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "romance-dawn",
        attributes: expect.objectContaining({
          "set-code": "OP-01",
          "scrydex-set-id": "op-01",
          "tcgplayer-set-name": "Romance Dawn",
        }),
        relationships: [
          { relationshipType: "part-of", referenceId: catalogSeedIds.referenceRecords.productLines.onePieceCardGame },
        ],
      }),
    );
    expect(firstRunAliasCommands).toEqual([
      expect.objectContaining({
        streamId: expect.stringMatching(/^catalog\.alias-/),
        type: "ProposeCatalogAlias",
        aliasText: "OP-01",
        targetId: catalogSeedIds.referenceRecords.sets.romanceDawn,
        targetKey: "set",
        reviewStatus: "auto-accepted",
      }),
    ]);
  });

  it("seeds Lorcana main chapter and promo/special set identity as reference data", async () => {
    const harness = createReferenceSeedHarness({
      existingReferenceTypeKeys: new Set(["manufacturer", "product-line"]),
    });

    const ids = await seedLorcanaReferenceData(harness.services as never);

    expect(ids.sets["the-first-chapter"]).toBe(catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter);
    expect(ids.sets["d23-collection"]).toBe(catalogSeedIds.referenceRecords.sets.lorcanaD23Collection);
    expect(harness.commands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "CreateReferenceType",
        key: "set",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.ravensburger}`,
        type: "CreateReferenceRecord",
        key: "ravensburger",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.ravensburger}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.disneyLorcana}`,
        type: "CreateReferenceRecord",
        key: "disney-lorcana",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.disneyLorcana}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter}`,
        type: "CreateReferenceRecord",
        key: "the-first-chapter",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaD23Collection}`,
        type: "CreateReferenceRecord",
        key: "d23-collection",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaD23Collection}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "the-first-chapter",
        attributes: expect.objectContaining({
          "set-code": "1",
          "chapter-number": 1,
          "set-kind": "chapter",
          "lorcanajson-set-code": "1",
          "lorcast-set-code": "1",
        }),
        relationships: [
          { relationshipType: "part-of", referenceId: catalogSeedIds.referenceRecords.productLines.disneyLorcana },
        ],
      }),
    );
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "d23-collection",
        attributes: expect.objectContaining({
          "set-code": "D23",
          "set-kind": "promo-special",
          "lorcast-set-code": "D23",
          "tcgplayer-set-name": "D23 Promos",
        }),
      }),
    );
    expect(harness.aliasCommands).toEqual([
      expect.objectContaining({
        streamId: expect.stringMatching(/^catalog\.alias-/),
        type: "ProposeCatalogAlias",
        aliasText: "1",
        targetId: catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter,
        targetKey: "set",
        reviewStatus: "auto-accepted",
      }),
      expect.objectContaining({
        streamId: expect.stringMatching(/^catalog\.alias-/),
        type: "ProposeCatalogAlias",
        aliasText: "D23",
        targetId: catalogSeedIds.referenceRecords.sets.lorcanaD23Collection,
        targetKey: "set",
        reviewStatus: "auto-accepted",
      }),
    ]);
  });

  it.each([{ state: "already-resolved" as const }, { state: "resolved" as const }])(
    "retries reference-type projection state before loading and authoring when $state",
    async ({ state }) => {
      const harness = createReferenceSeedHarness();
      retryLocalProjectionBlockedStream.mockImplementation(async (_contextName, _pool, _projector, streamId) => {
        harness.steps.push(`retry:${streamId}`);
        return projectionRetryResult(streamId, state);
      });

      const ids = await seedMagicReferenceData(harness.services as never);

      const streamId = `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`;
      expect(ids.sets["time-spiral"]).toBe(catalogSeedIds.referenceRecords.sets.timeSpiral);
      expect(harness.steps.indexOf(`retry:${streamId}`)).toBeGreaterThanOrEqual(0);
      expect(harness.steps.indexOf(`retry:${streamId}`)).toBeLessThan(harness.steps.indexOf(`load:${streamId}`));
      expect(harness.steps.indexOf(`load:${streamId}`)).toBeLessThan(
        harness.steps.indexOf(`command:${streamId}:CreateReferenceType`),
      );
      expect(harness.commands).toContainEqual({ streamId, type: "CreateReferenceType", key: "set" });
    },
  );

  it("refuses a still-blocked reference type before aggregate loading or seed authoring", async () => {
    const harness = createReferenceSeedHarness();
    const blockedStreamId = `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`;
    retryLocalProjectionBlockedStream.mockImplementation(async (_contextName, _pool, _projector, streamId) => {
      harness.steps.push(`retry:${streamId}`);
      return streamId === blockedStreamId
        ? projectionRetryResult(streamId, "still-blocked", "projection remains blocked")
        : projectionRetryResult(streamId, "already-resolved");
    });

    await expect(seedMagicReferenceData(harness.services as never)).rejects.toThrow(
      "Catalog integration bootstrap could not recover blocked reference type 'set': projection remains blocked",
    );

    expect(harness.steps).toContain(`retry:${blockedStreamId}`);
    expect(harness.steps).not.toContain(`load:${blockedStreamId}`);
    expect(harness.steps.some((step) => step.startsWith(`command:${blockedStreamId}:`))).toBe(false);
    expect(harness.commands).toEqual([]);
  });

  it.each(["accepted", "auto-accepted"] as const)(
    "refuses duplicate retirement with a %s authoritative mapping even when its projection is absent",
    async (status) => {
      const h = await createReconciliationHarness();
      await h.createDuplicate();
      await h.mapping(status);
      const before = await h.rowsFor(h.duplicateStream);
      await expect(seedReferenceData(h.services)).rejects.toThrow("it still owns 1 accepted Provider Scope Mapping(s)");
      expect(await h.rowsFor(h.duplicateStream)).toEqual(before);
    },
  );

  it.each(["absent", "proposed", "revoked"] as const)(
    "retires an unmapped duplicate with %s mapping history exactly once",
    async (status) => {
      const h = await createReconciliationHarness();
      await h.createDuplicate();
      if (status !== "absent") await h.mapping(status);
      await seedReferenceData(h.services);
      expect((await h.folded(h.duplicateId)).status).toBe("deprecated");
      const before = await h.rowsFor(h.duplicateStream);
      await seedReferenceData(h.services);
      expect(await h.rowsFor(h.duplicateStream)).toEqual(before);
    },
  );

  it.each(["unrelated attribute", "provider id"])(
    "refuses a stale correction after an intervening %s edit",
    async (edit) => {
      const h = await createReconciliationHarness();
      await h.revise(h.canonicalId, { "tcgdex-set-id": "sv8", "synthetic-operator-note": "before" });
      let interleaved = false;
      const handler = h.services.referenceData.referenceRecordCommandHandler;
      const services: CatalogServices = {
        ...h.services,
        referenceData: {
          ...h.services.referenceData,
          referenceRecordCommandHandler: async (input) => {
            if (
              !interleaved &&
              input.streamId === h.canonicalStream &&
              input.command.type === "ReviseReferenceRecord"
            ) {
              interleaved = true;
              await h.revise(h.canonicalId, {
                "tcgdex-set-id": edit === "provider id" ? "synthetic-custom-id" : "sv8",
                "synthetic-operator-note": "concurrent-update",
              });
            }
            return handler(input);
          },
        },
      };
      const before = (await h.rowsFor(h.canonicalStream)).length;
      await expect(seedReferenceData(services)).rejects.toThrow(/concurr|version/i);
      expect((await h.rowsFor(h.canonicalStream)).length).toBe(before + 1);
      expect((await h.folded(h.canonicalId)).attributes).toEqual({
        "tcgdex-set-id": edit === "provider id" ? "synthetic-custom-id" : "sv8",
        "synthetic-operator-note": "concurrent-update",
      });
      await seedReferenceData(h.services);
      expect((await h.folded(h.canonicalId)).attributes["tcgdex-set-id"]).toBe(
        edit === "provider id" ? "synthetic-custom-id" : "sv08",
      );
      expect((await h.folded(h.canonicalId)).attributes["synthetic-operator-note"]).toBe("concurrent-update");
    },
  );

  it.each(["duplicate", "canonical"] as const)(
    "refuses poisoned %s lifecycle history without appending",
    async (target) => {
      const h = await createReconciliationHarness();
      await h.createDuplicate();
      const id = target === "duplicate" ? h.duplicateId : h.canonicalId;
      await h.command(id, { type: "DeprecateReferenceRecord" });
      await h.command(id, { type: "ArchiveReferenceRecord" });
      await expect(h.command(id, { type: "PublishReferenceRecord" })).rejects.toThrow("Only draft reference records");
      // SYNTHETIC poison: the command API above forbids republishing an archived record.
      const streamId = `catalog.reference-record-${id}`;
      await h.eventStore.appendToStream({
        streamId,
        expectedVersion: (await h.rowsFor(streamId)).length,
        context: seedContext,
        events: [{ eventType: "catalog.reference-record.published", payload: {} }],
      });
      const before = await h.rowsFor(streamId);
      await expect(seedReferenceData(h.services)).rejects.toThrow(/illegal retained Reference Record history/);
      expect(await h.rowsFor(streamId)).toEqual(before);
    },
  );

  it.each(["deprecated", "archived"] as const)("leaves a valid %s duplicate history unchanged", async (status) => {
    const h = await createReconciliationHarness();
    await h.createDuplicate();
    await h.command(h.duplicateId, { type: "DeprecateReferenceRecord" });
    if (status === "archived") await h.command(h.duplicateId, { type: "ArchiveReferenceRecord" });
    const before = await h.rowsFor(h.duplicateStream);
    await seedReferenceData(h.services);
    expect(await h.rowsFor(h.duplicateStream)).toEqual(before);
  });

  it("refuses a duplicate stream carrying another record's identity", async () => {
    const h = await createReconciliationHarness();
    await h.eventStore.appendToStream({
      streamId: h.duplicateStream,
      expectedVersion: 0,
      context: seedContext,
      events: [
        {
          eventType: "catalog.reference-record.created",
          payload: { referenceRecordId: "ref_synthetic_wrong_identity" },
        },
        { eventType: "catalog.reference-record.published", payload: {} },
      ],
    });
    const before = await h.rowsFor(h.duplicateStream);
    await expect(seedReferenceData(h.services)).rejects.toThrow("illegal retained Reference Record history");
    expect(await h.rowsFor(h.duplicateStream)).toEqual(before);
  });

  it("validates a duplicate history before accepting its retired-state no-op", async () => {
    const h = await createReconciliationHarness();
    await h.createDuplicate();
    await h.eventStore.appendToStream({
      streamId: h.duplicateStream,
      expectedVersion: 2,
      context: seedContext,
      events: [{ eventType: "catalog.reference-record.archived", payload: {} }],
    });
    const before = await h.rowsFor(h.duplicateStream);
    await expect(seedReferenceData(h.services)).rejects.toThrow("illegal retained Reference Record history");
    expect(await h.rowsFor(h.duplicateStream)).toEqual(before);
  });

  it.each(["draft", "mismatch"])("preserves the existing %s duplicate refusal", async (state) => {
    const h = await createReconciliationHarness();
    await h.createDuplicate(state !== "draft");
    if (state === "mismatch") await h.revise(h.duplicateId, { "tcgdex-set-id": "synthetic-other-set" });
    const before = await h.rowsFor(h.duplicateStream);
    await expect(seedReferenceData(h.services)).rejects.toThrow("cannot retire duplicate Reference Record");
    expect(await h.rowsFor(h.duplicateStream)).toEqual(before);
  });

  it("corrects and retires through domain events without the new success logs", async () => {
    const h = await createReconciliationHarness();
    await h.createDuplicate();
    await h.revise(h.canonicalId, { "tcgdex-set-id": "sv8" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await seedReferenceData(h.services);
      expect((await h.rowsFor(h.canonicalStream)).at(-1)?.event_type).toBe("catalog.reference-record.revised");
      expect((await h.rowsFor(h.duplicateStream)).at(-1)?.event_type).toBe("catalog.reference-record.deprecated");
      expect(log.mock.calls.flat().join("\n")).not.toMatch(/corrected tcgdex-set-id|deprecated as a duplicate/);
    } finally {
      log.mockRestore();
    }
  });
});

async function createReconciliationHarness() {
  const { eventStore } = createInMemoryEventStore();
  const known = new Set<string>();
  const canonicalId = catalogSeedIds.referenceRecords.expansions.surgingSparks;
  const duplicateId = "ref_tcgdex_expansion_sv08" as ReferenceRecordId;
  const canonicalStream = `catalog.reference-record-${canonicalId}`;
  const duplicateStream = `catalog.reference-record-${duplicateId}`;
  const rowsFor = async (streamId: string) =>
    (await eventStore.readStream({ streamId })).map((event) => ({
      stream_id: event.streamId,
      stream_version: event.streamVersion,
      event_type: event.eventType,
      payload: event.payload,
    }));
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("FROM catalog_provider_scope_mappings")) return { rows: [] as Row[], rowCount: 0 };
      if (!sql.includes("FROM event_store_events")) throw new Error(`Unexpected seed query: ${sql}`);
      let rows = await rowsFor(String(values[0]));
      if (sql.includes("scopeRecordId")) {
        rows = [];
        for (const streamId of known) {
          const history = await rowsFor(streamId);
          if (
            history.some(
              (row) =>
                row.event_type === "catalog.provider-scope-mapping.proposed" && row.payload.scopeRecordId === values[0],
            )
          )
            rows.push(...history);
        }
      } else if (sql.includes("OR (")) {
        for (const streamId of known) {
          if (streamId !== values[0])
            rows.push(
              ...(await rowsFor(streamId)).filter(
                (row) =>
                  row.event_type === values[1] &&
                  row.payload.key === values[2] &&
                  (values.length < 4 || row.payload.typeKey === values[3]),
              ),
            );
        }
      }
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  const deps: CatalogRuntimeDeps = {
    eventStore,
    db,
    checkpointStore: {
      loadCheckpoint: async () => {
        throw new Error("Reconciliation harness does not run projections");
      },
      saveCheckpoint: async () => {
        throw new Error("Reconciliation harness does not run projections");
      },
    },
  };
  const referenceData = createReferenceDataRuntime(deps);
  const providerScopeMappings = createProviderScopeMappingRuntime(deps);
  const command = async (id: string, command: ReferenceRecordCommand) => {
    known.add(`catalog.reference-record-${id}`);
    return referenceData.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${id}`,
      command,
      context: seedContext,
    });
  };
  const folded = async (id: string) =>
    (await rowsFor(`catalog.reference-record-${id}`))
      .map((row) => ({ type: row.event_type, data: row.payload }) as ReferenceRecordEvent)
      .reduce(evolveReferenceRecord, initialReferenceRecordState);
  const revise = async (id: string, attributes: Record<string, string>) => {
    const state = await folded(id);
    return command(id, {
      type: "ReviseReferenceRecord",
      typeKey: state.typeKey!,
      key: state.key!,
      name: state.name!,
      description: state.description,
      relationships: state.relationships,
      attributes,
    });
  };
  const pool: PgTransactionalPool = {
    query: db.query,
    connect: async () => {
      throw new Error("Reconciliation harness does not open Postgres transactions");
    },
  };
  const defaults = createCatalogServices(pool);
  const services: CatalogServices = {
    ...defaults,
    referenceData: {
      ...referenceData,
      referenceTypeCommandHandler: async (input) => {
        known.add(input.streamId);
        return referenceData.referenceTypeCommandHandler(input);
      },
      referenceRecordCommandHandler: async (input) => {
        known.add(input.streamId);
        return referenceData.referenceRecordCommandHandler(input);
      },
    },
    providerScopeMappings,
    catalogAliases: createCatalogAliasRuntime(deps, {
      catalogItemCommandHandler: defaults.items.commandHandler,
      referenceRecordCommandHandler: referenceData.referenceRecordCommandHandler,
    }),
  };
  await seedReferenceData(services);
  const createDuplicate = async (publish = true) => {
    await command(duplicateId, {
      type: "CreateReferenceRecord",
      referenceRecordId: duplicateId,
      typeKey: "expansion",
      key: "sv08",
      name: { defaultLocale: "en", values: { en: "Synthetic Surging Sparks duplicate" } },
      attributes: { "tcgdex-set-id": "sv08" },
      relationships: [],
    });
    if (publish) await command(duplicateId, { type: "PublishReferenceRecord" });
  };
  const mapping = async (status: "accepted" | "auto-accepted" | "proposed" | "revoked") => {
    const candidate = buildProviderScopeMappingCandidate({
      scopeRecordId: duplicateId,
      providerKey: "tcgdex",
      unitKey: "synthetic-seed-regression",
      coordinates: { setId: "sv08" },
      confidence: "exact",
      reviewStatus: status === "auto-accepted" ? status : "proposed",
      provenance: { source: "synthetic-seed-regression" },
    });
    const streamId = providerScopeMappingStreamId(candidate);
    known.add(streamId);
    await providerScopeMappings.commandHandler({
      streamId,
      command: { type: "ProposeProviderScopeMapping", candidate, actor: "synthetic-seed-regression" },
      context: seedContext,
    });
    if (status === "accepted" || status === "revoked")
      await providerScopeMappings.commandHandler({
        streamId,
        command: { type: "AcceptProviderScopeMapping", actor: "synthetic-seed-regression" },
        context: seedContext,
      });
    if (status === "revoked")
      await providerScopeMappings.commandHandler({
        streamId,
        command: {
          type: "RevokeProviderScopeMapping",
          actor: "synthetic-seed-regression",
          reason: "Synthetic revoked control",
        },
        context: seedContext,
      });
  };
  return {
    services,
    eventStore,
    rowsFor,
    folded,
    revise,
    command,
    createDuplicate,
    mapping,
    canonicalId,
    duplicateId,
    canonicalStream,
    duplicateStream,
  };
}

function projectionRetryResult(
  streamId: string,
  state: "already-resolved" | "resolved" | "still-blocked",
  errorMessage: string | null = null,
) {
  return {
    projectionKey: "catalog-reference-data-projection:catalog:v1",
    streamId,
    state,
    inspectedEvents: state === "already-resolved" ? 0 : 1,
    appliedEvents: state === "resolved" ? 1 : 0,
    errorMessage,
  };
}

function createReferenceSeedHarness(input: Readonly<{ existingReferenceTypeKeys?: ReadonlySet<string> }> = {}) {
  const existingReferenceTypeKeys =
    input.existingReferenceTypeKeys ?? new Set(["manufacturer", "product-line", "series", "expansion"]);
  const attributeKeysByType = {
    manufacturer: ["homepage-url"],
    "product-line": ["official-name", "short-name"],
    series: ["tcgdex-series-id"],
    expansion: [
      "abbreviation",
      "card-count",
      "parallel-set-card-count",
      "printed-card-count",
      "release-date",
      "tcgdex-set-id",
    ],
    set: [
      "set-code",
      "printed-card-count",
      "release-date",
      "mtgjson-set-code",
      "scryfall-set-code",
      "scrydex-set-id",
      "chapter-number",
      "set-kind",
      "lorcanajson-set-code",
      "lorcanajson-set-name",
      "lorcast-set-code",
      "lorcast-set-name",
      "tcgplayer-set-name",
    ],
  } as const;
  type ReferenceTypeRow = {
    reference_type_id: string;
    key: keyof typeof attributeKeysByType;
    name_i18n: { defaultLocale: "en"; values: { en: string } };
    description_i18n: { defaultLocale: "en"; values: Record<string, string> };
    attribute_keys: string[];
    status: string;
  };
  const referenceTypeRow = (referenceTypeId: string, key: keyof typeof attributeKeysByType): ReferenceTypeRow => ({
    reference_type_id: referenceTypeId,
    key,
    name_i18n: { defaultLocale: "en", values: { en: key } },
    description_i18n: { defaultLocale: "en", values: {} },
    attribute_keys: [...attributeKeysByType[key]],
    status: "active",
  });
  const referenceTypeEntries: [string, ReferenceTypeRow][] = [
    ["manufacturer", referenceTypeRow(catalogSeedIds.referenceTypes.manufacturer, "manufacturer")],
    ["product-line", referenceTypeRow(catalogSeedIds.referenceTypes.productLine, "product-line")],
    ["series", referenceTypeRow(catalogSeedIds.referenceTypes.series, "series")],
    ["expansion", referenceTypeRow(catalogSeedIds.referenceTypes.expansion, "expansion")],
    ["set", referenceTypeRow(catalogSeedIds.referenceTypes.set, "set")],
  ];
  const referenceTypes = new Map<string, ReferenceTypeRow>(
    referenceTypeEntries.filter(([key]) => existingReferenceTypeKeys.has(key)),
  );
  type EventRow = Readonly<{ event_type: string; payload: Record<string, unknown> }>;
  const eventsByStream = new Map<string, EventRow[]>();
  for (const row of referenceTypes.values()) {
    eventsByStream.set(`catalog.reference-type-${row.reference_type_id}`, [
      {
        event_type: "catalog.reference-type.created",
        payload: {
          referenceTypeId: row.reference_type_id,
          key: row.key,
          name: row.name_i18n,
          description: row.description_i18n,
          attributeKeys: row.attribute_keys,
        },
      },
      { event_type: "catalog.reference-type.published", payload: {} },
    ]);
  }
  const appendEvent = (streamId: string, event: EventRow): void => {
    eventsByStream.set(streamId, [...(eventsByStream.get(streamId) ?? []), event]);
  };
  const referenceRecords = new Map<
    string,
    { reference_record_id: string; type_key: string; key: string; status: string }
  >();
  const referenceAliases = new Set<string>();
  const commands: { streamId: string; type: string; key: string | undefined }[] = [];
  const aliasCommands: {
    streamId: string;
    type: string;
    aliasText: string | undefined;
    targetId: string | null | undefined;
    targetKey: string | undefined;
    reviewStatus: string | undefined;
  }[] = [];
  const details: {
    referenceRecordId?: string;
    typeKey?: string;
    key: string | undefined;
    name?: string;
    attributes?: unknown;
    relationships?: unknown;
  }[] = [];
  const steps: string[] = [];

  const services = {
    pool: {},
    db: {
      query: async <T>(sql: string, values: readonly unknown[]) => {
        if (sql.includes("FROM event_store_events")) {
          const streamId = String(values[0]);
          steps.push(`load:${streamId}`);
          return {
            rows: (eventsByStream.get(streamId) ?? []).map((event, index) => ({
              ...event,
              stream_id: streamId,
              stream_version: index + 1,
            })) as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          const referenceTypeId = String(values[0]);
          const key = String(values[1]);
          const row =
            referenceTypes.get(key) ??
            Array.from(referenceTypes.values()).find((candidate) => candidate.reference_type_id === referenceTypeId);
          return { rows: (row ? [row] : []) as T[] };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          const referenceRecordId = String(values[0]);
          const typeKey = String(values[1]);
          const key = String(values[2]);
          const row =
            referenceRecords.get(`${typeKey}:${key}`) ??
            Array.from(referenceRecords.values()).find(
              (candidate) => candidate.reference_record_id === referenceRecordId,
            );
          return { rows: (row ? [row] : []) as T[] };
        }

        if (sql.includes("FROM catalog_reference_record_aliases")) {
          const aliasHash = String(values[0]);
          return { rows: (referenceAliases.has(aliasHash) ? [{ alias_hash: aliasHash }] : []) as T[] };
        }

        return { rows: [] as T[] };
      },
    },
    referenceData: {
      projectors: [{ projectionName: "catalog-reference-data-projection" }],
      referenceTypeCommandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: {
          type: string;
          referenceTypeId?: string;
          key?: keyof typeof attributeKeysByType;
          attributeKeys?: readonly string[];
          name?: unknown;
          description?: unknown;
        };
      }) => {
        steps.push(`command:${streamId}:${command.type}`);
        commands.push({ streamId, type: command.type, key: command.key });
        details.push({ key: command.key });
        if (command.type === "CreateReferenceType" && command.referenceTypeId && command.key) {
          appendEvent(streamId, {
            event_type: "catalog.reference-type.created",
            payload: {
              referenceTypeId: command.referenceTypeId,
              key: command.key,
              name: command.name,
              description: command.description,
              attributeKeys: command.attributeKeys ?? [],
            },
          });
          referenceTypes.set(command.key, {
            ...referenceTypeRow(command.referenceTypeId, command.key),
            attribute_keys: [...(command.attributeKeys ?? [])],
            status: "draft",
          });
        }
        if (command.type === "ReviseReferenceType" && command.key) {
          appendEvent(streamId, {
            event_type: "catalog.reference-type.revised",
            payload: {
              key: command.key,
              name: command.name,
              description: command.description,
              attributeKeys: command.attributeKeys ?? [],
            },
          });
          const row = referenceTypes.get(command.key);
          if (row) {
            row.attribute_keys = [...(command.attributeKeys ?? row.attribute_keys)];
          }
        }
        if (command.type === "PublishReferenceType") {
          appendEvent(streamId, { event_type: "catalog.reference-type.published", payload: {} });
          const row = Array.from(referenceTypes.values()).find((candidate) =>
            streamId.endsWith(candidate.reference_type_id),
          );
          if (row) {
            row.status = "active";
          }
        }
      },
      referenceRecordCommandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: {
          type: string;
          referenceRecordId?: string;
          typeKey?: string;
          key?: string;
          name?: { values?: { en?: string } };
          attributes?: unknown;
          relationships?: unknown;
          description?: unknown;
        };
      }) => {
        commands.push({ streamId, type: command.type, key: command.key });
        details.push({
          referenceRecordId: command.referenceRecordId,
          typeKey: command.typeKey,
          key: command.key,
          name: command.name?.values?.en,
          attributes: command.attributes,
          relationships: command.relationships,
        });
        if (command.type === "CreateReferenceRecord" && command.referenceRecordId && command.typeKey && command.key) {
          appendEvent(streamId, {
            event_type: "catalog.reference-record.created",
            payload: {
              referenceRecordId: command.referenceRecordId,
              typeKey: command.typeKey,
              key: command.key,
              name: command.name,
              description: command.description,
              attributes: command.attributes ?? {},
              relationships: command.relationships ?? [],
            },
          });
          referenceRecords.set(`${command.typeKey}:${command.key}`, {
            reference_record_id: command.referenceRecordId,
            type_key: command.typeKey,
            key: command.key,
            status: "draft",
          });
        }
        if (command.type === "PublishReferenceRecord") {
          appendEvent(streamId, { event_type: "catalog.reference-record.published", payload: {} });
          const row = Array.from(referenceRecords.values()).find((candidate) =>
            streamId.endsWith(candidate.reference_record_id),
          );
          if (row) {
            row.status = "active";
          }
        }
      },
    },
    catalogAliases: {
      catalogAliasCommandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: {
          type: string;
          candidate?: {
            aliasHash: string;
            aliasText: string;
            target: { targetId: string | null; targetKey: string };
            reviewStatus: string;
            normalizedAliasText: string;
            aliasLanguageCode: string;
            sourceLanguageCode: string | null;
            aliasType: string;
            confidence: string;
            provenance: Record<string, unknown>;
            evidence: Record<string, unknown>;
          };
          actor?: string;
        };
      }) => {
        aliasCommands.push({
          streamId,
          type: command.type,
          aliasText: command.candidate?.aliasText,
          targetId: command.candidate?.target.targetId,
          targetKey: command.candidate?.target.targetKey,
          reviewStatus: command.candidate?.reviewStatus,
        });
        if (command.type === "ProposeCatalogAlias" && command.candidate) {
          appendEvent(streamId, {
            event_type: "catalog.alias.proposed",
            payload: {
              ...command.candidate,
              actor: command.actor ?? "system",
              policyVersion: "test",
            },
          });
          referenceAliases.add(command.candidate.aliasHash);
        }
      },
    },
  };

  return { aliasCommands, commands, details, services, steps };
}
