import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideSourceObservation,
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

describe("promotion target retained-reference exclusion", () => {
  it.each(["complete", "before-reference-link"] as const)(
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
        payload: { ...fixture, observationId: "retained-member-A", externalKey: "retained-member-A" },
        observedAt: "2026-10-10T00:00:00.000Z",
      });
      expect(mappedA.diagnostics).toEqual([]);
      if (!mappedA.observation) throw new Error("Mapper did not produce member A");
      const observationA = mappedA.observation;
      expect(observationA.observationId).not.toBe("obs_changed");
      expect(observationA.normalized.externalCatalogItemReferences).toEqual(
        observation.normalized.externalCatalogItemReferences,
      );
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
                        event.payload.providerKey === key.providerKey &&
                        event.payload.externalKey === key.externalKey
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
                          reference.providerKey === key.providerKey && reference.externalKey === key.externalKey,
                      ) ||
                      (key.level === "product" &&
                        event.payload.providerKey === key.providerKey &&
                        sourceObservationLinkExternalKey(
                          String(event.payload.languageCode),
                          String(event.payload.externalKey),
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
      if (crashPoint === "before-reference-link") expect(attempt.status).toBe("rejected");
      else {
        expect(attempt.status).toBe("fulfilled");
        if (attempt.status === "fulfilled") expect(attempt.result.catalogItemId).toBe(retainedId);
      }
    },
  );
});
