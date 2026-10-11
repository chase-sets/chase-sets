import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  evolveSourceObservation,
  initialSourceObservationState,
  sourceObservationLinkExternalKey,
  type SourceObservationEvent,
  type SourceObservationState,
} from "../../domain/domain";
import {
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
  type CatalogItemState,
} from "../../../catalog-items/domain/domain";
import {
  promotionTargetBindingStream,
  promotionTargetKeyIdentity,
  promotionTargetKeySchema,
  canonicalPromotionTargetKey,
  retainedPromotionTargetBindingStream,
  sourceObservationTargetId,
  sourceObservationTargetKeys,
  type PromotionReferenceKey,
  type PromotionTargetKey,
} from "./promotion-target-identity";
import { canonicalPromotionReferenceText } from "./promotion-reference-canonicalization";

export const promotionTargetBindingSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    key: promotionTargetKeySchema,
    targetId: z.string().min(1).max(2048),
    operationId: z.string().min(1).max(2048),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    execution: z
      .object({
        planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        baselineVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        batches: z
          .array(
            z
              .array(
                z.object({ eventType: z.string().min(1).max(256), payload: z.record(z.string(), z.json()) }).strict(),
              )
              .max(100),
          )
          .max(1000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PromotionTargetBinding = z.infer<typeof promotionTargetBindingSchema>;
export type PromotionTargetSource = Readonly<{
  state: SourceObservationState;
  revisions: readonly SourceObservationState[];
}>;
export type PromotionTargetDiscovery = Readonly<{
  keys: ReadonlyMap<string, PromotionTargetKey>;
  histories: ReadonlyMap<string, readonly StoredEvent[]>;
  sources: ReadonlyMap<string, PromotionTargetSource>;
  items: ReadonlyMap<string, CatalogItemState>;
  bindings: ReadonlyMap<string, PromotionTargetBinding | null>;
}>;

export function locatedPromotionSourceTargets(
  evidence: PromotionTargetDiscovery,
  source: PromotionTargetSource,
): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const revision of source.revisions) {
    targets.add(sourceObservationTargetId(revision.id!));
    if (revision.promotedCatalogItemId) targets.add(revision.promotedCatalogItemId);
    const externalKey = sourceObservationLinkExternalKey(revision.languageCode, revision.externalKey);
    for (const [id, item] of evidence.items) {
      if (
        item.externalProductReferences.some(
          (reference) =>
            canonicalPromotionReferenceText(reference.providerKey) ===
              canonicalPromotionReferenceText(revision.providerKey) &&
            canonicalPromotionReferenceText(reference.externalKey) === canonicalPromotionReferenceText(externalKey),
        )
      )
        targets.add(id);
    }
  }
  return targets;
}

export async function discoverPromotionTargets(input: {
  eventStore: EventStore;
  keys: readonly PromotionTargetKey[];
  additionalTargetIds: readonly string[];
  locate: (key: PromotionReferenceKey) => Promise<readonly string[]>;
}): Promise<PromotionTargetDiscovery> {
  const keys = new Map<string, PromotionTargetKey>();
  const histories = new Map<string, readonly StoredEvent[]>();
  const sources = new Map<string, PromotionTargetSource>();
  const items = new Map<string, CatalogItemState>();
  const bindings = new Map<string, PromotionTargetBinding | null>();
  const retainedBindings: PromotionTargetBinding[] = [];
  const candidateTargets = new Set(input.additionalTargetIds);
  const expandedItems = new Set<string>();
  const pendingStreams = new Set(input.additionalTargetIds.map((id) => `catalog.item-${id}`));
  const addKey = (key: PromotionTargetKey) => {
    const retainedStream = retainedPromotionTargetBindingStream(key);
    if (retainedStream !== promotionTargetBindingStream(key)) pendingStreams.add(retainedStream);
    key = canonicalPromotionTargetKey(key);
    keys.set(promotionTargetKeyIdentity(key), key);
    if (keys.size > 10000) throw new Error("promotion-target-discovery-budget-exceeded");
  };
  input.keys.forEach(addKey);
  for (;;) {
    // Read identity versions BEFORE looking for any evidence they fence. New
    // closure keys restart this phase rather than inheriting an earlier scan.
    for (const [identity, key] of keys) {
      if (bindings.has(identity)) continue;
      const stream = promotionTargetBindingStream(key);
      const history = await readCompleteStream(input.eventStore, { streamId: stream, maxEvents: 100000 });
      histories.set(stream, history);
      let binding: PromotionTargetBinding | null = null;
      for (const event of history) {
        if (event.eventType !== "catalog.promotion-target.bound") throw new Error("promotion-target-invalid-binding");
        const next = promotionTargetBindingSchema.parse(event.payload);
        if (
          promotionTargetKeyIdentity(next.key) !== identity ||
          (next.version === 1
            ? retainedPromotionTargetBindingStream(next.key)
            : promotionTargetBindingStream(next.key)) !== stream ||
          (next.version === 2 && !isDeepStrictEqual(next.key, canonicalPromotionTargetKey(next.key))) ||
          next.generation !== (binding?.generation ?? 0) + 1 ||
          (binding && next.targetId !== binding.targetId)
        ) {
          throw new Error("promotion-target-conflicting-binding");
        }
        binding = next;
      }
      bindings.set(identity, binding);
      if (binding) {
        candidateTargets.add(binding.targetId);
        pendingStreams.add(`catalog.item-${binding.targetId}`);
      }
      if (key.level === "member") pendingStreams.add(`catalog.source-observation-${key.observationId}`);
      else for (const located of await input.locate(key)) pendingStreams.add(located);
    }
    for (const streamId of pendingStreams) {
      if (histories.has(streamId)) continue;
      if (histories.size > 10000) throw new Error("promotion-target-discovery-budget-exceeded");
      const history = await readCompleteStream(input.eventStore, { streamId, maxEvents: 100000 });
      histories.set(streamId, history);
      if (streamId.startsWith("catalog.promotion-target-")) {
        if (history.length === 0) continue;
        let previous: PromotionTargetBinding | null = null;
        for (const event of history) {
          if (event.eventType !== "catalog.promotion-target.bound") throw new Error("promotion-target-invalid-binding");
          const next = promotionTargetBindingSchema.parse(event.payload);
          if (
            (next.version === 1
              ? retainedPromotionTargetBindingStream(next.key)
              : promotionTargetBindingStream(next.key)) !== streamId ||
            next.generation !== (previous?.generation ?? 0) + 1 ||
            (previous &&
              (next.targetId !== previous.targetId ||
                promotionTargetKeyIdentity(next.key) !== promotionTargetKeyIdentity(previous.key)))
          )
            throw new Error("promotion-target-conflicting-binding");
          previous = next;
        }
        const binding = previous!;
        addKey(binding.key);
        const identity = promotionTargetKeyIdentity(binding.key);
        const current = bindings.get(identity);
        if (current && current.targetId !== binding.targetId) throw new Error("promotion-target-conflicting-binding");
        retainedBindings.push(binding);
        candidateTargets.add(binding.targetId);
        pendingStreams.add(`catalog.item-${binding.targetId}`);
      } else if (streamId.startsWith("catalog.source-observation-")) {
        if (history.length === 0) throw new Error(`promotion-target-missing-source:${streamId}`);
        const id = streamId.slice("catalog.source-observation-".length);
        const source = foldPromotionTargetSource(id, history);
        sources.set(id, source);
        candidateTargets.add(sourceObservationTargetId(id));
        pendingStreams.add(`catalog.item-${sourceObservationTargetId(id)}`);
        for (const revision of source.revisions) {
          sourceObservationTargetKeys(revision).forEach(addKey);
          if (revision.promotedCatalogItemId) {
            candidateTargets.add(revision.promotedCatalogItemId);
            pendingStreams.add(`catalog.item-${revision.promotedCatalogItemId}`);
          }
        }
      } else if (streamId.startsWith("catalog.item-")) {
        const id = streamId.slice("catalog.item-".length);
        const state = foldPromotionTargetItem(id, history);
        items.set(id, state);
      } else throw new Error(`promotion-target-invalid-locator:${streamId}`);
    }
    // Released histories remain guarded negative evidence, but only ownership
    // candidates expand the identity set. Revisit deferred items as it grows.
    for (const [id, item] of items) {
      if (expandedItems.has(id)) continue;
      const ownsKey = [
        ...item.externalCatalogItemReferences.map(({ providerKey, externalKey }) => ({
          level: "item" as const,
          providerKey,
          externalKey,
        })),
        ...item.externalProductReferences.map(({ providerKey, externalKey }) => ({
          level: "product" as const,
          providerKey,
          externalKey,
        })),
      ].some((key) => keys.has(promotionTargetKeyIdentity(key)));
      if (candidateTargets.has(id) || ownsKey) {
        expandedItems.add(id);
        for (const event of histories.get(`catalog.item-${id}`)!) {
          const level = event.eventType.includes(".external-catalog-item-reference-")
            ? "item"
            : event.eventType.includes(".external-product-reference-")
              ? "product"
              : null;
          if (level)
            addKey(
              promotionTargetKeySchema.parse({
                level,
                providerKey: event.payload.providerKey,
                externalKey: event.payload.externalKey,
              }),
            );
        }
      }
    }
    if (
      [...keys.keys()].every((key) => bindings.has(key)) &&
      [...pendingStreams].every((stream) => histories.has(stream))
    )
      break;
  }
  for (const binding of retainedBindings) {
    const identity = promotionTargetKeyIdentity(binding.key);
    const current = bindings.get(identity);
    if (current && current.targetId !== binding.targetId) throw new Error("promotion-target-conflicting-binding");
    if (!current) {
      bindings.set(identity, binding);
      continue;
    }
    if (!binding.execution || isDeepStrictEqual(binding.execution, current?.execution)) continue;
    const expected = binding.execution.batches.flat();
    const actual = histories
      .get(`catalog.item-${binding.targetId}`)
      ?.slice(binding.execution.baselineVersion, binding.execution.baselineVersion + expected.length)
      .map(({ eventType, payload }) => ({ eventType, payload }));
    if (!isDeepStrictEqual(actual, expected)) throw new Error("promotion-target-conflicting-binding-execution");
  }
  return { keys, histories, sources, items, bindings };
}

export function foldPromotionTargetSource(id: string, history: readonly StoredEvent[]): PromotionTargetSource {
  const codec = createPassthroughDomainEventCodec<SourceObservationEvent>();
  let state = initialSourceObservationState;
  let recordedTarget: string | null = null;
  const revisions: SourceObservationState[] = [];
  for (const [index, stored] of history.entries()) {
    if (index === 0 && stored.eventType !== "catalog.source-observation.recorded")
      throw new Error("promotion-target-invalid-source-history");
    if (
      state.pendingSourcePayloadChunks &&
      stored.eventType !== "catalog.source-observation.source-payload-chunk-recorded"
    )
      throw new Error("promotion-target-incomplete-source");
    const previous = state;
    state = evolveSourceObservation(state, codec.decode(stored));
    if (state.promotedCatalogItemId) {
      if (recordedTarget && recordedTarget !== state.promotedCatalogItemId)
        throw new Error("promotion-target-conflicting-source-terminal");
      recordedTarget = state.promotedCatalogItemId;
    }
    if (
      state.id !== id ||
      (previous.id && (previous.providerKey !== state.providerKey || previous.externalKey !== state.externalKey))
    )
      throw new Error("promotion-target-conflicting-source-identity");
    if (!state.pendingSourcePayloadChunks) {
      sourceObservationTargetKeys(state);
      revisions.push(state);
    }
  }
  if (!state.id || !state.normalized || state.pendingSourcePayloadChunks)
    throw new Error("promotion-target-incomplete-source");
  return { state, revisions };
}

export function foldPromotionTargetItem(id: string, history: readonly StoredEvent[]): CatalogItemState {
  const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
  let state = initialCatalogItemState;
  for (const [index, stored] of history.entries()) {
    if ((index === 0) !== (stored.eventType === "catalog.catalog-item.created"))
      throw new Error("promotion-target-invalid-item-history");
    if (["archived", "removed", "retired"].includes(state.status))
      throw new Error("promotion-target-conflicting-item-terminal");
    state = evolveCatalogItem(state, codec.decode(stored));
    if (state.id !== id) throw new Error("promotion-target-conflicting-item-identity");
  }
  return state;
}
