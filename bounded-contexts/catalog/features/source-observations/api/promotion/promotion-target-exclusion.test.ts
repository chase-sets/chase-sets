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
import { discoverPromotionTargets, foldPromotionTargetSource } from "./promotion-target-discovery";
import { promotionTargetBindingStream, type PromotionReferenceKey } from "./promotion-target-identity";
import { canonicalPromotionReferenceText as canonical } from "./promotion-reference-canonicalization";
import { requireCatalogProviderSourceObservation } from "./provider-source-observation-normalizer";
import { ygojsonYugiohSetReferenceSourceObservationMappingContract } from "../providers/ygojson/executable-mapping-contract";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
  type CatalogItemCommand,
} from "../../../catalog-items/domain/domain";

describe("promotion target retained-reference exclusion", () => {
  async function appendItem(
    eventStore: ReturnType<typeof createInMemoryEventStore>["eventStore"],
    id: string,
    commands: CatalogItemCommand[],
  ) {
    const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
    const events: CatalogItemEvent[] = [];
    let state = initialCatalogItemState;
    for (const command of [
      {
        type: "CreateCatalogItem",
        itemId: id as CatalogItemId,
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Synthetic owner" } },
      } as CatalogItemCommand,
      ...commands,
    ]) {
      const next = decideCatalogItem(state, command);
      events.push(...next);
      state = next.reduce(evolveCatalogItem, state);
    }
    await eventStore.appendToStream({
      streamId: `catalog.item-${id}`,
      expectedVersion: 0,
      context,
      events: events.map(codec.encode),
    });
  }

  function itemLocator(eventStore: ReturnType<typeof createInMemoryEventStore>["eventStore"]) {
    return async (key: PromotionReferenceKey) => [
      ...new Set(
        (await eventStore.readAll())
          .filter(
            (event) =>
              event.streamId.startsWith("catalog.item-") &&
              event.eventType.includes(`external-${key.level === "item" ? "catalog-item" : "product"}-reference-`) &&
              canonical(String(event.payload.providerKey)) === key.providerKey &&
              canonical(String(event.payload.externalKey)) === key.externalKey,
          )
          .map((event) => event.streamId),
      ),
    ];
  }

  it.each([
    ["item", true],
    ["item", false],
    ["product", true],
    ["product", false],
  ] as const)(
    "keeps released %s history negative without binding unrelated keys (released both: %s)",
    async (level, releasedBoth) => {
      const { eventStore } = createInMemoryEventStore();
      const r = { level, providerKey: "synthetic", externalKey: "shared-r" };
      const r2 = { level, providerKey: "synthetic", externalKey: "unrelated-r2" };
      const link = level === "item" ? "LinkExternalCatalogItemReference" : "LinkExternalProductReference";
      const unlink = level === "item" ? "UnlinkExternalCatalogItemReference" : "UnlinkExternalProductReference";
      await appendItem(eventStore, "cat_synthetic_x", [
        { type: link, providerKey: r.providerKey, externalKey: r.externalKey },
        { type: link, providerKey: r2.providerKey, externalKey: r2.externalKey },
        { type: unlink, providerKey: r.providerKey, externalKey: r.externalKey },
        ...(releasedBoth
          ? [{ type: unlink, providerKey: r2.providerKey, externalKey: r2.externalKey } satisfies CatalogItemCommand]
          : []),
      ]);
      const before = await eventStore.readStream({ streamId: "catalog.item-cat_synthetic_x" });
      const boundary = createPromotionTargetExclusion({
        eventStore,
        ready: async () => undefined,
        locate: itemLocator(eventStore),
        append: (inputs) => eventStore.appendToStreams!(inputs),
      });
      const acquire = (targetId: string, key: PromotionReferenceKey) =>
        boundary.acquire({
          keys: [key],
          additionalTargetIds: [targetId],
          context,
          validateAuthority: async () => undefined,
          selectTarget: async () => targetId,
        });
      const b = await acquire("cat_synthetic_b", r);
      expect([...b.evidence.keys.values()]).toEqual([r]);
      expect(b.evidence.histories.get("catalog.item-cat_synthetic_x")).toEqual(before);
      expect(await eventStore.readStream({ streamId: promotionTargetBindingStream(r2) })).toEqual([]);
      if (releasedBoth)
        await expect(acquire("cat_synthetic_c", r2)).resolves.toMatchObject({ targetId: "cat_synthetic_c" });
      else await expect(acquire("cat_synthetic_c", r2)).rejects.toThrow("promotion-target-bound-elsewhere");
      expect(await eventStore.readStream({ streamId: "catalog.item-cat_synthetic_x" })).toEqual(before);
    },
  );

  it.each(["item", "product"] as const)(
    "revisits deferred %s items when another owner expands the closure",
    async (level) => {
      const { eventStore } = createInMemoryEventStore();
      const link = level === "item" ? "LinkExternalCatalogItemReference" : "LinkExternalProductReference";
      const unlink = level === "item" ? "UnlinkExternalCatalogItemReference" : "UnlinkExternalProductReference";
      const key = (externalKey: string) => ({ level, providerKey: "synthetic", externalKey });
      await appendItem(eventStore, "cat_synthetic_deferred", [
        { type: link, providerKey: "synthetic", externalKey: "r" },
        { type: unlink, providerKey: "synthetic", externalKey: "r" },
        { type: link, providerKey: "synthetic", externalKey: "r2" },
        { type: link, providerKey: "synthetic", externalKey: "r3" },
        { type: unlink, providerKey: "synthetic", externalKey: "r3" },
      ]);
      await appendItem(eventStore, "cat_synthetic_owner", [
        { type: link, providerKey: "synthetic", externalKey: "r" },
        { type: link, providerKey: "synthetic", externalKey: "r2" },
      ]);
      const evidence = await discoverPromotionTargets({
        eventStore,
        keys: [key("r")],
        additionalTargetIds: [],
        locate: itemLocator(eventStore),
      });
      expect([...evidence.keys.values()]).toEqual([key("r"), key("r2"), key("r3")]);
      expect(evidence.histories.has(promotionTargetBindingStream(key("r3")))).toBe(true);
    },
  );

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

  it("discovers source observations with complete normalized evidence from legacy and normalized-evidence-chunked histories", async () => {
    const { eventStore } = createInMemoryEventStore();
    const codec = createPassthroughDomainEventCodec<SourceObservationEvent>();
    const ygoFixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../__fixtures__/ygojson-yugioh-set-reference-data/beginners-edition-2.json", import.meta.url),
        ),
        "utf8",
      ),
    );
    const ygojson = requireCatalogProviderSourceObservation({
      contract: ygojsonYugiohSetReferenceSourceObservationMappingContract,
      payload: ygoFixture,
      observedAt: "2026-10-22T00:00:00.000Z",
    });
    const inline = normalizeCatalogProviderSourceObservation({
      contract: tcgdexPokemonCardSourceObservationMappingContract,
      payload: { ...fixture, observationId: "inline-source", externalKey: "inline-source" },
      observedAt: "2026-10-22T00:00:00.000Z",
    });
    if (!inline.observation) throw new Error("Inline source fixture did not map");
    const legacy = {
      ...inline.observation,
      observationId: "legacy-source",
      sourcePayload: { oversized: "legacy source payload ".repeat(20_000) },
    };
    const observations = [inline.observation, legacy, { ...ygojson, observationId: "chunked-source" }] as const;

    for (const observation of observations) {
      const streamId = `catalog.source-observation-${observation.observationId}`;
      const events = decideSourceObservation(initialSourceObservationState, {
        type: "RecordSourceObservation",
        ...observation,
      });
      if (observation === inline.observation) expect(events).toHaveLength(1);
      if (observation === legacy) {
        expect(events[0]?.data).toHaveProperty("normalized", observation.normalized);
        expect(
          events.slice(1).every((event) => event.type === "catalog.source-observation.source-payload-chunk-recorded"),
        ).toBe(true);
      }
      await eventStore.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: events.map(codec.encode),
      });
      const history = await eventStore.readStream({ streamId });
      const source = foldPromotionTargetSource(observation.observationId, history);
      const discovered = await discoverPromotionTargets({
        eventStore,
        keys: [{ level: "member", observationId: observation.observationId }],
        additionalTargetIds: [],
        locate: async () => [],
      });
      expect(discovered.sources.get(observation.observationId)).toEqual(source);
      expect(source.revisions).toHaveLength(1);
      expect(source.state.normalized).toEqual(observation.normalized);
      expect(source.state.pendingSourcePayloadChunks).toBeNull();
      expect(source.state.pendingNormalizedEvidenceChunks).toBeNull();
    }

    const chunkedHistory = await eventStore.readStream({ streamId: "catalog.source-observation-chunked-source" });
    const finalNormalizedChunk = chunkedHistory.findLastIndex(
      (event) => event.eventType === "catalog.source-observation.normalized-evidence-chunk-recorded",
    );
    expect(finalNormalizedChunk).toBeGreaterThan(0);
    const invalidHistory = [
      ...chunkedHistory.slice(0, finalNormalizedChunk),
      chunkedHistory[0]!,
      ...chunkedHistory.slice(finalNormalizedChunk),
    ];
    expect(() => foldPromotionTargetSource("chunked-source", invalidHistory)).toThrow(
      "promotion-target-incomplete-source",
    );
  });
  it.each(["linked", "unlinked", "relinked"] as const)(
    "uses current source Product-link ownership after a proved %s history",
    async (state) => {
      const { eventStore } = createInMemoryEventStore();
      const mapped = normalizeCatalogProviderSourceObservation({
        contract: tcgdexPokemonCardSourceObservationMappingContract,
        payload: { ...fixture, observationId: "source-product-release", externalKey: "source-product-release" },
        observedAt: "2026-10-10T00:00:00.000Z",
      });
      if (!mapped.observation) throw new Error("Source-link fixture did not map");
      const source = mapped.observation;
      await eventStore.appendToStream({
        streamId: `catalog.source-observation-${source.observationId}`,
        expectedVersion: 0,
        context,
        events: decideSourceObservation(initialSourceObservationState, {
          type: "RecordSourceObservation",
          ...source,
        }).map(createPassthroughDomainEventCodec<SourceObservationEvent>().encode),
      });
      const reference = {
        providerKey: source.providerKey,
        externalKey: sourceObservationLinkExternalKey(source.languageCode, source.externalKey),
      };
      const commands: CatalogItemCommand[] = [
        { type: "LinkExternalProductReference", ...reference },
        { type: "LinkExternalProductReference", providerKey: "synthetic", externalKey: "unrelated-r2" },
      ];
      if (state !== "linked") commands.push({ type: "UnlinkExternalProductReference", ...reference });
      if (state === "relinked") commands.push({ type: "LinkExternalProductReference", ...reference });
      await appendItem(eventStore, "cat_synthetic_released_source", commands);
      const before = await eventStore.readStream({ streamId: "catalog.item-cat_synthetic_released_source" });
      const boundary = createPromotionTargetExclusion({
        eventStore,
        ready: async () => undefined,
        locate: itemLocator(eventStore),
        append: (inputs) => eventStore.appendToStreams!(inputs),
      });
      const attempt = boundary.acquire({
        keys: [{ level: "member", observationId: source.observationId }],
        additionalTargetIds: ["cat_synthetic_new"],
        context,
        validateAuthority: async () => undefined,
        selectTarget: async () => "cat_synthetic_new",
      });
      if (state === "unlinked") {
        const session = await attempt;
        expect(session.targetId).toBe("cat_synthetic_new");
        expect(session.evidence.histories.get("catalog.item-cat_synthetic_released_source")).toEqual(before);
        expect(
          await eventStore.readStream({
            streamId: promotionTargetBindingStream({
              level: "product",
              providerKey: "synthetic",
              externalKey: "unrelated-r2",
            }),
          }),
        ).toEqual([]);
      } else await expect(attempt).rejects.toThrow("promotion-target-bound-elsewhere");
      expect(await eventStore.readStream({ streamId: "catalog.item-cat_synthetic_released_source" })).toEqual(before);
    },
  );
  it("refreshes a promoted then changed observation without revalidating a carried fingerprint against new content", async () => {
    const { eventStore } = createInMemoryEventStore();
    const codec = createPassthroughDomainEventCodec<SourceObservationEvent>();
    const streamId = "catalog.source-observation-obs_changed";
    const map = (changed: boolean) => {
      const result = normalizeCatalogProviderSourceObservation({
        contract: tcgdexPokemonCardSourceObservationMappingContract,
        payload: {
          ...fixture,
          observationId: "obs_changed",
          ...(changed
            ? {
                card: { ...fixture.card, name: "Synthetic changed name" },
                catalogHashMaterial: { ...fixture.catalogHashMaterial, revision: "changed" },
              }
            : {}),
        },
        observedAt: "2026-10-10T00:00:00.000Z",
      });
      if (!result.observation) throw new Error("Changed fixture did not map");
      return result.observation;
    };
    const original = map(false);
    const changed = map(true);
    const runtimeFor = (
      observation: typeof original,
      status: "observed" | "promoted" | "changed",
      targetId: CatalogItemId | null,
    ) => {
      const harness = createChangedObservationRefreshHarness({
        normalized: observation.normalized,
        status,
        promotedCatalogItemId: targetId,
        externalKey: observation.externalKey,
      });
      const deps: CatalogRuntimeDeps = {
        ...harness.deps,
        eventStore: {
          ...eventStore,
          readStream: (input) =>
            /^(catalog\.item-|catalog\.promotion-|catalog\.source-observation-)/.test(input.streamId)
              ? eventStore.readStream(input)
              : harness.deps.eventStore.readStream(input),
        },
        promotionTargetExclusion: createPromotionTargetExclusion({
          eventStore,
          ready: async () => undefined,
          append: (inputs) => eventStore.appendToStreams!(inputs),
          locate: itemLocator(eventStore),
        }),
      };
      return {
        deps,
        runtime: createSourceObservationRuntime(deps, createCatalogItemRuntime(deps), harness.referenceData),
      };
    };
    await eventStore.appendToStream({
      streamId,
      expectedVersion: 0,
      context,
      events: decideSourceObservation(initialSourceObservationState, {
        type: "RecordSourceObservation",
        ...original,
      }).map(codec.encode),
    });
    const first = runtimeFor(original, "observed", null);
    const material = new Set<string>();
    await guardPromotionMaterial({
      deps: first.deps,
      session: {
        guard: (stream) => {
          material.add(stream);
        },
      },
      profile: tcgdexPokemonTcgProviderProfile,
      mapping: await loadCatalogItemPromotionProfile(first.deps, tcgdexPokemonTcgProviderProfile),
      normalized: requireCatalogItemPromotionObservation(original.normalized, original.providerKey),
    });
    for (const streamId of material) {
      const history = await first.deps.eventStore.readStream({ streamId });
      await eventStore.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: history.map(({ eventType, payload }) => ({ eventType, payload })),
      });
    }
    const promoted = await first.runtime.promoteObservation({ observationId: "obs_changed", context });
    const unchanged = await runtimeFor(original, "promoted", promoted.catalogItemId!).runtime.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });
    expect(unchanged.outcomes.map((outcome) => outcome.status)).toEqual(["reapplied"]);
    const history = await eventStore.readStream({ streamId });
    const previous = history.map(codec.decode).reduce(evolveSourceObservation, initialSourceObservationState);
    const events = decideSourceObservation(previous, { type: "RecordSourceObservation", ...changed });
    expect(events.map((event) => event.type)).toEqual(["catalog.source-observation.changed"]);
    expect(events.reduce(evolveSourceObservation, previous).promotionPlanFingerprint).toBe(
      previous.promotionPlanFingerprint,
    );
    await eventStore.appendToStream({
      streamId,
      expectedVersion: history.length,
      context,
      events: events.map(codec.encode),
    });
    const itemStream = `catalog.item-${promoted.catalogItemId}`;
    const before = await eventStore.readStream({ streamId: itemStream });
    await expect(
      runtimeFor(changed, "changed", promoted.catalogItemId!).runtime.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).resolves.toMatchObject({ catalogItemId: promoted.catalogItemId });
    const after = await eventStore.readStream({ streamId: itemStream });
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    const reapplied = await runtimeFor(changed, "promoted", promoted.catalogItemId!).runtime.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });
    expect(reapplied.outcomes.map((outcome) => outcome.status)).toEqual(["reapplied"]);
    expect(
      (await eventStore.readAll()).filter((event) => event.eventType === "catalog.catalog-item.created"),
    ).toHaveLength(1);
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
