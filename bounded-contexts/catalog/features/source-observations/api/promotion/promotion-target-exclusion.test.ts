import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationEvent,
} from "../../domain/domain";
import { createCatalogItemRuntime } from "../../../catalog-items/api/runtime";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import type { CatalogItemId, ReferenceRecordId } from "../../../../ids";
import { createSourceObservationRuntime } from "../runtime";
import { context, createChangedObservationRefreshHarness } from "../seeding/runtime-test-harness";
import { createSyntheticDisplayIdentityQueryable } from "../seeding/synthetic-display-identity-queryable";
import { tcgdexPokemonTcgProviderProfile } from "../provider-integration-profiles";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../tcgdex-executable-mapping-contract";
import fixture from "../__fixtures__/tcgdex/normal.json";
import { normalizeCatalogProviderSourceObservation } from "./provider-source-observation-normalizer";
import { planCatalogProviderPromotionCommands } from "./provider-promotion-command-planner";
import { loadCatalogItemPromotionProfile } from "../source-observation-promotion-execution";
import { createPromotionTargetExclusion } from "./promotion-target-exclusion";
import { sourceObservationLinkExternalKey } from "../../domain/domain";
import { guardPromotionMaterial } from "./promotion-material-guards";
import { requireCatalogItemPromotionObservation } from "../source-observation-promotion-execution";
import { foldPromotionTargetSource } from "./promotion-target-discovery";
import { canonicalPromotionReferenceText as canonical } from "./promotion-reference-canonicalization";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
  type CatalogItemCommand,
} from "../../../catalog-items/domain/domain";

describe("promotion target retained-reference exclusion", () => {
  it("folds legitimate recorded revisions before the first promotion without losing old references", async () => {
    const { eventStore } = createInMemoryEventStore();
    const codec = createPassthroughDomainEventCodec<SourceObservationEvent>();
    let state = initialSourceObservationState;
    for (const externalKey of ["product:old", "product:new"]) {
      const mapped = normalizeCatalogProviderSourceObservation({
        contract: tcgdexPokemonCardSourceObservationMappingContract,
        payload: {
          ...fixture,
          observationId: "revision-source",
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey }],
          catalogHashMaterial: { ...fixture.catalogHashMaterial, revision: externalKey },
        },
        observedAt: "2026-10-10T00:00:00.000Z",
      });
      if (!mapped.observation) throw new Error("Revision fixture did not map");
      const events = decideSourceObservation(state, { type: "RecordSourceObservation", ...mapped.observation });
      const streamId = "catalog.source-observation-revision-source";
      const history = await eventStore.readStream({ streamId });
      await eventStore.appendToStream({
        streamId,
        expectedVersion: history.length,
        context,
        events: events.map(codec.encode),
      });
      state = events.reduce(evolveSourceObservation, state);
    }
    const history = await eventStore.readStream({ streamId: "catalog.source-observation-revision-source" });
    expect(history.map((event) => event.eventType)).toEqual([
      "catalog.source-observation.recorded",
      "catalog.source-observation.recorded",
    ]);
    const source = foldPromotionTargetSource("revision-source", history);
    expect(
      source.revisions.map((revision) => revision.normalized?.externalCatalogItemReferences?.[0]?.externalKey),
    ).toEqual(["product:old", "product:new"]);
  });
  it("enforces retained ownership even when a shared-port consumer selects another target", async () => {
    const { eventStore } = createInMemoryEventStore();
    const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
    const commands: CatalogItemCommand[] = [
      {
        type: "CreateCatalogItem",
        itemId: "cat_synthetic_owner" as CatalogItemId,
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Synthetic owner" } },
      },
      { type: "LinkExternalCatalogItemReference", providerKey: "synthetic", externalKey: "shared" },
    ];
    let state = initialCatalogItemState;
    for (const command of commands) {
      const events = decideCatalogItem(state, command);
      const history = await eventStore.readStream({ streamId: "catalog.item-cat_synthetic_owner" });
      await eventStore.appendToStream({
        streamId: "catalog.item-cat_synthetic_owner",
        expectedVersion: history.length,
        context,
        events: events.map(codec.encode),
      });
      state = events.reduce(evolveCatalogItem, state);
    }
    const boundary = createPromotionTargetExclusion({
      eventStore,
      ready: async () => undefined,
      locate: async () => ["catalog.item-cat_synthetic_owner"],
      append: (inputs) => eventStore.appendToStreams!(inputs),
    });
    await expect(
      boundary.acquire({
        keys: [{ level: "item", providerKey: "synthetic", externalKey: "shared" }],
        additionalTargetIds: ["cat_synthetic_fork"],
        context,
        validateAuthority: async () => undefined,
        selectTarget: async () => "cat_synthetic_fork",
      }),
    ).rejects.toThrow("promotion-target-bound-elsewhere");
    expect(await eventStore.readStream({ streamId: "catalog.item-cat_synthetic_fork" })).toEqual([]);
    expect((await eventStore.readAll()).some((event) => event.streamId.startsWith("catalog.promotion-target-"))).toBe(
      false,
    );
  });
  it.each(["complete", "before-reference-link", "case-folded-before-reference-link"] as const)(
    "does not allocate beside retained A (%s) for incoming B sharing R under projection lag",
    async (crashPoint) => {
      const mapped = normalizeCatalogProviderSourceObservation({
        contract: tcgdexPokemonCardSourceObservationMappingContract,
        payload: { ...fixture, observationId: "obs_changed" },
        observedAt: "2026-10-10T00:00:00.000Z",
      });
      expect(mapped.diagnostics).toEqual([]);
      if (!mapped.observation) throw new Error("Mapper did not produce a fixture");
      const observation = mapped.observation;
      const mappedA = normalizeCatalogProviderSourceObservation({
        contract: tcgdexPokemonCardSourceObservationMappingContract,
        payload: {
          ...fixture,
          observationId: "retained-member-A",
          externalKey: "retained-member-A",
          externalCatalogItemReferences:
            crashPoint === "case-folded-before-reference-link"
              ? [{ providerKey: "tcgplayer", externalKey: "PRODUCT:493958" }]
              : fixture.externalCatalogItemReferences,
        },
        observedAt: "2026-10-10T00:00:00.000Z",
      });
      expect(mappedA.diagnostics).toEqual([]);
      if (!mappedA.observation) throw new Error("Mapper did not produce member A");
      const observationA = mappedA.observation;
      expect(observationA.observationId).not.toBe("obs_changed");
      expect(
        observationA.normalized.externalCatalogItemReferences?.map((reference) => ({
          ...reference,
          externalKey: reference.externalKey.toLowerCase(),
        })),
      ).toEqual(observation.normalized.externalCatalogItemReferences);
      const harness = createChangedObservationRefreshHarness({
        normalized: observation.normalized,
        status: "observed",
        promotedCatalogItemId: null,
        externalKey: observation.externalKey,
      });
      const { eventStore } = createInMemoryEventStore();
      const incomingHistory = await harness.deps.eventStore.readStream({
        streamId: "catalog.source-observation-obs_changed",
      });
      await eventStore.appendToStream({
        streamId: "catalog.source-observation-obs_changed",
        expectedVersion: 0,
        context,
        events: incomingHistory.map((event) => ({ eventType: event.eventType, payload: event.payload })),
      });
      await eventStore.appendToStream({
        streamId: `catalog.source-observation-${observationA.observationId}`,
        expectedVersion: 0,
        events: decideSourceObservation(initialSourceObservationState, {
          type: "RecordSourceObservation",
          ...observationA,
        }).map(createPassthroughDomainEventCodec<SourceObservationEvent>().encode),
        context,
      });
      const deps: CatalogRuntimeDeps = {
        ...harness.deps,
        eventStore: {
          ...eventStore,
          readStream: (input) =>
            input.streamId.startsWith("catalog.item-") ||
            input.streamId.startsWith("catalog.promotion-") ||
            input.streamId.startsWith("catalog.source-observation-")
              ? eventStore.readStream(input)
              : harness.deps.eventStore.readStream(input),
        },
        promotionTargetExclusion: createPromotionTargetExclusion({
          eventStore,
          ready: async () => undefined,
          // Synthetic indexed locator over this fixture's complete, small store.
          // Canonical SQL profile fencing is exercised by the DB suite, not this adapter.
          append: (inputs) => eventStore.appendToStreams!(inputs),
          locate: async (key) => {
            const events = await eventStore.readAll();
            return [
              ...new Set(
                events
                  .filter((event) => {
                    if (event.streamId.startsWith("catalog.item-"))
                      return (
                        event.eventType.includes(
                          `external-${key.level === "item" ? "catalog-item" : "product"}-reference-`,
                        ) &&
                        canonical(String(event.payload.providerKey)) === key.providerKey &&
                        canonical(String(event.payload.externalKey)) === key.externalKey
                      );
                    if (
                      ![
                        "catalog.source-observation.recorded",
                        "catalog.source-observation.changed",
                        "catalog.source-observation.refreshed",
                      ].includes(event.eventType)
                    )
                      return false;
                    const normalized = event.payload.normalized as typeof observation.normalized;
                    const references =
                      key.level === "item"
                        ? normalized.externalCatalogItemReferences
                        : normalized.externalProductReferences;
                    return (
                      references?.some(
                        (reference) =>
                          canonical(reference.providerKey) === key.providerKey &&
                          canonical(reference.externalKey) === key.externalKey,
                      ) ||
                      (key.level === "product" &&
                        canonical(String(event.payload.providerKey)) === key.providerKey &&
                        canonical(
                          sourceObservationLinkExternalKey(
                            String(event.payload.languageCode),
                            String(event.payload.externalKey),
                          ),
                        ) === key.externalKey)
                    );
                  })
                  .map((event) => event.streamId),
              ),
            ];
          },
        }),
      };
      const items = createCatalogItemRuntime(deps);
      const retainedId =
        `cat_source_${createHash("sha256").update(observationA.observationId).digest("hex")}` as CatalogItemId;
      const plan = await planCatalogProviderPromotionCommands({
        db: createSyntheticDisplayIdentityQueryable(),
        profile: tcgdexPokemonTcgProviderProfile,
        profileKey: observation.sourceProfileKey,
        profileVersion: observation.sourceProfileVersion,
        providerKey: observation.providerKey,
        externalKey: observationA.externalKey,
        mode: "create",
        catalogItemId: retainedId,
        normalized: observationA.normalized,
        catalog: await loadCatalogItemPromotionProfile(deps, tcgdexPokemonTcgProviderProfile),
        expansionReferenceId: "ref_sv01" as ReferenceRecordId,
        metadata: { title: observation.normalized.name, subtitle: "" },
        productAssetSet: null,
      });
      if (plan.status !== "planned") throw new Error(JSON.stringify(plan.diagnostics));
      const referenceCommandIndex = plan.plan.commands.findIndex(
        (command) => command.type === "LinkExternalCatalogItemReference",
      );
      expect(referenceCommandIndex).toBeGreaterThan(0);
      if (crashPoint === "case-folded-before-reference-link") {
        const completeState = plan.plan.commands.reduce(
          (state, command) => decideCatalogItem(state, command).reduce(evolveCatalogItem, state),
          initialCatalogItemState,
        );
        expect(observationA.normalized.externalCatalogItemReferences?.[0]?.externalKey).toBe("PRODUCT:493958");
        expect(completeState.externalCatalogItemReferences).toEqual(
          observation.normalized.externalCatalogItemReferences,
        );
      }
      const commands =
        crashPoint === "complete" ? plan.plan.commands : plan.plan.commands.slice(0, referenceCommandIndex);
      for (const command of commands) {
        await items.commandHandler({ streamId: `catalog.item-${retainedId}`, command, context });
      }
      const before = await eventStore.readAll();
      const reference = observation.normalized.externalCatalogItemReferences![0];
      const discoverable = before.filter(
        (event) =>
          event.streamId.startsWith("catalog.item-") &&
          [
            "catalog.catalog-item.external-catalog-item-reference-linked",
            "catalog.catalog-item.external-catalog-item-reference-unlinked",
          ].includes(event.eventType) &&
          event.payload.providerKey === reference.providerKey &&
          event.payload.externalKey === reference.externalKey,
      );
      expect(discoverable).toHaveLength(crashPoint === "complete" ? 1 : 0);
      expect(before.some((event) => event.streamId.startsWith("catalog.promotion-target-"))).toBe(false);
      const material = new Set<string>();
      await guardPromotionMaterial({
        deps,
        session: {
          guard: (stream) => {
            material.add(stream);
          },
        },
        profile: tcgdexPokemonTcgProviderProfile,
        mapping: await loadCatalogItemPromotionProfile(deps, tcgdexPokemonTcgProviderProfile),
        normalized: requireCatalogItemPromotionObservation(observation.normalized, observation.providerKey),
      });
      for (const streamId of material) {
        const history = await deps.eventStore.readStream({ streamId });
        await eventStore.appendToStream({
          streamId,
          expectedVersion: 0,
          context,
          events: history.map((event) => ({ eventType: event.eventType, payload: event.payload })),
        });
      }
      const runtime = createSourceObservationRuntime(deps, items, harness.referenceData);
      const attempt = await runtime
        .promoteObservation({ observationId: "obs_changed", context })
        .then((result) => ({ status: "fulfilled" as const, result }))
        .catch((error: unknown) => ({ status: "rejected" as const, error }));
      const creations = (await eventStore.readAll()).filter(
        (event) => event.eventType === "catalog.catalog-item.created",
      );
      console.info(
        JSON.stringify({
          crashPoint,
          retainedCommandCount: commands.length,
          discoverableReferenceRows: discoverable.length,
          attemptStatus: attempt.status,
          diagnostic: attempt.status === "rejected" ? String(attempt.error) : null,
          createdItemIds: creations.map((event) => event.payload.itemId),
        }),
      );
      expect(creations).toHaveLength(1);
      if (crashPoint !== "complete") expect(attempt.status).toBe("rejected");
      else {
        expect(attempt.status).toBe("fulfilled");
        if (attempt.status === "fulfilled") expect(attempt.result.catalogItemId).toBe(retainedId);
      }
    },
  );
});
