import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CatalogItemServices } from "../../../catalog-items/api/runtime";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
} from "../../../catalog-items/domain/domain";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  discoverPromotionTargets,
  locatedPromotionSourceTargets,
  type PromotionTargetDiscovery,
} from "./promotion-target-discovery";
import {
  promotionTargetBindingStream,
  promotionTargetKeyIdentity,
  type PromotionTargetKey,
} from "./promotion-target-identity";
import { locatePromotionReferenceStreams, requirePromotionTargetIndexes } from "./promotion-target-indexes";
import type { CatalogProviderPromotionCommandPlan } from "./provider-promotion-command-planner";
import { promotionTargetBindingSchema } from "./promotion-target-discovery";

export type PromotionTargetAuthority = (client: PgQueryable) => Promise<void>;
export type PromotionTargetSession = Readonly<{
  targetId: string;
  evidence: PromotionTargetDiscovery;
  append: (input: AppendToStreamInput) => Promise<readonly StoredEvent[]>;
  commandHandler: CatalogItemServices["commandHandler"];
  preparePlan: (plan: CatalogProviderPromotionCommandPlan) => Promise<number>;
  guard: (streamId: string, version: number) => void;
}>;
export type PromotionTargetExclusion = Readonly<{
  acquire(
    input: Readonly<{
      keys: readonly PromotionTargetKey[];
      additionalTargetIds: readonly string[];
      context: EventStoreContext;
      validateAuthority: PromotionTargetAuthority;
      selectTarget: (evidence: PromotionTargetDiscovery, guard: PromotionTargetSession["guard"]) => Promise<string>;
    }>,
  ): Promise<PromotionTargetSession>;
}>;

export function createPostgresPromotionTargetExclusion(input: {
  pool: PgTransactionalPool;
  eventStore: PostgresEventStore;
}): PromotionTargetExclusion {
  return createPromotionTargetExclusion({
    eventStore: input.eventStore,
    ready: () => requirePromotionTargetIndexes(input.pool),
    locate: (key) => locatePromotionReferenceStreams(input.pool, key),
    append: (inputs, validateAuthority) =>
      withPgTransaction(
        input.pool,
        async (client: PgQueryable) => {
          await client.query("LOCK TABLE catalog_provider_integration_profile_versions IN SHARE MODE");
          await validateAuthority(client);
          return input.eventStore.appendToStreamsInTransaction(client, inputs);
        },
        { isolationLevel: "read committed" },
      ),
  });
}

// The algorithm is shared with deterministic test stores. Production always
// composes the Postgres adapter above, never an in-memory authority fallback.
export function createPromotionTargetExclusion(ports: {
  eventStore: EventStore;
  ready: () => Promise<void>;
  locate: Parameters<typeof discoverPromotionTargets>[0]["locate"];
  append: (
    inputs: readonly AppendToStreamInput[],
    validateAuthority: PromotionTargetAuthority,
  ) => ReturnType<PostgresEventStore["appendToStreamsInTransaction"]>;
}): PromotionTargetExclusion {
  return {
    async acquire(input) {
      await ports.ready();
      const evidence = await discoverPromotionTargets({
        eventStore: ports.eventStore,
        keys: input.keys,
        additionalTargetIds: input.additionalTargetIds,
        locate: ports.locate,
      });
      const versions = new Map(
        [...evidence.histories].map(([streamId, history]) => [streamId, history.at(-1)?.streamVersion ?? 0]),
      );
      function guard(streamId: string, version: number) {
        if (!Number.isSafeInteger(version) || version < 0) throw new Error("promotion-target-invalid-guard");
        const existing = versions.get(streamId);
        if (existing !== undefined && existing !== version)
          throw new Error("promotion-target-material-version-changed");
        versions.set(streamId, version);
      }
      const targetId = await input.selectTarget(evidence, guard);
      if (!evidence.items.has(targetId)) throw new Error("promotion-target-undiscovered-target");
      const selected = evidence.items.get(targetId)!;
      if (selected.id && selected.status !== "draft" && selected.status !== "active")
        throw new Error("promotion-target-inactive");
      // Every consumer must honor located applications, even when it supplies
      // its own duplicate policy and legacy histories predate all bindings.
      for (const [id, item] of evidence.items) {
        const ownsIdentity = [
          ...item.externalCatalogItemReferences.map((reference) => ({
            level: "item" as const,
            providerKey: reference.providerKey,
            externalKey: reference.externalKey,
          })),
          ...item.externalProductReferences.map((reference) => ({
            level: "product" as const,
            providerKey: reference.providerKey,
            externalKey: reference.externalKey,
          })),
        ].some((key) => evidence.keys.has(promotionTargetKeyIdentity(key)));
        if (ownsIdentity && id !== targetId) throw new Error("promotion-target-bound-elsewhere");
      }
      for (const source of evidence.sources.values()) {
        for (const revision of source.revisions) {
          const recorded = revision.promotedCatalogItemId;
          if (recorded && !evidence.items.get(recorded)?.id)
            throw new Error("promotion-target-missing-recorded-target");
        }
        for (const located of locatedPromotionSourceTargets(evidence, source)) {
          if (evidence.items.get(located)?.id && located !== targetId)
            throw new Error("promotion-target-bound-elsewhere");
        }
      }
      const operationId = randomUUID();
      const bindingInputs: AppendToStreamInput[] = [];
      for (const [identity, key] of evidence.keys) {
        const previous = evidence.bindings.get(identity);
        if (previous && previous.targetId !== targetId) throw new Error("promotion-target-bound-elsewhere");
        const streamId = promotionTargetBindingStream(key);
        bindingInputs.push({
          streamId,
          expectedVersion: versions.get(streamId)!,
          context: input.context,
          events: [
            {
              eventType: "catalog.promotion-target.bound",
              payload: {
                version: 2,
                key,
                targetId,
                operationId,
                generation: (evidence.histories.get(streamId)?.length ?? 0) + 1,
                ...(previous?.execution ? { execution: previous.execution } : {}),
              },
            },
          ],
        });
      }
      async function append(inputs: readonly AppendToStreamInput[]) {
        const combined = new Map<string, AppendToStreamInput>(
          [...versions].map(([streamId, version]) => [
            streamId,
            { streamId, expectedVersion: version, events: [], context: input.context },
          ]),
        );
        for (const entry of inputs) {
          const version = versions.get(entry.streamId);
          if (
            version === undefined ||
            (entry.expectedVersion !== version && !(entry.expectedVersion === "no_stream" && version === 0))
          )
            throw new Error("promotion-target-unfenced-write");
          combined.set(entry.streamId, entry);
        }
        const results = await ports.append(
          [...combined.values()].sort((a, b) => (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0)),
          input.validateAuthority,
        );
        for (const result of results) {
          versions.set(result.streamId, result.storedEvents.at(-1)?.streamVersion ?? versions.get(result.streamId)!);
        }
        return results;
      }
      await append(bindingInputs);
      let planPrepared = false;
      return {
        targetId,
        evidence,
        guard,
        async append(entry) {
          if (entry.streamId !== `catalog.item-${targetId}`) throw new Error("promotion-target-wrong-target");
          const results = await append([entry]);
          return results.find((result) => result.streamId === entry.streamId)!.storedEvents;
        },
        async commandHandler(commandInput) {
          if (!planPrepared) throw new Error("promotion-target-plan-not-bound");
          if (commandInput.streamId !== `catalog.item-${targetId}`) throw new Error("promotion-target-wrong-target");
          const history = await readCompleteStream(ports.eventStore, { streamId: commandInput.streamId });
          const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
          const before = history.map(codec.decode).reduce(evolveCatalogItem, initialCatalogItemState);
          const version = history.at(-1)?.streamVersion ?? 0;
          if (commandInput.expectedVersion !== undefined && commandInput.expectedVersion !== version)
            throw new Error("promotion-target-command-version-changed");
          const newEvents = decideCatalogItem(before, commandInput.command);
          const results = await append([
            {
              streamId: commandInput.streamId,
              expectedVersion: version,
              events: newEvents.map(codec.encode),
              context: commandInput.context,
            },
          ]);
          const storedEvents = results.find((result) => result.streamId === commandInput.streamId)!.storedEvents;
          return {
            state: newEvents.reduce(evolveCatalogItem, before),
            version: storedEvents.at(-1)?.streamVersion ?? version,
            newEvents,
            storedEvents,
          };
        },
        async preparePlan(plan) {
          if (planPrepared || plan.catalogItemId !== targetId) throw new Error("promotion-target-plan-conflict");
          const streamId = `catalog.item-${targetId}`;
          const history = await readCompleteStream(ports.eventStore, { streamId });
          const actual = history.map((event) => ({ eventType: event.eventType, payload: event.payload }));
          let baselineVersion = plan.mode === "create" ? 0 : history.length;
          const previousExecutions = [...evidence.bindings.values()].flatMap((binding) =>
            binding?.execution ? [binding.execution] : [],
          );
          for (const previous of previousExecutions) {
            if (previous.baselineVersion > history.length)
              throw new Error("promotion-target-invalid-execution-baseline");
            const expected = previous.batches.flat();
            const suffix = actual.slice(previous.baselineVersion);
            const complete =
              suffix.length >= expected.length && isDeepStrictEqual(suffix.slice(0, expected.length), expected);
            if (complete && plan.mode === "create" && previous.planFingerprint === plan.planFingerprint) {
              baselineVersion = previous.baselineVersion;
              continue;
            }
            if (!complete || (previous.planFingerprint === plan.planFingerprint && suffix.length === expected.length)) {
              if (
                previous.planFingerprint !== plan.planFingerprint ||
                !isDeepStrictEqual(suffix, expected.slice(0, suffix.length))
              )
                throw new Error("promotion-target-resume-conflict");
              baselineVersion = previous.baselineVersion;
            }
          }
          const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
          let state = history
            .slice(0, baselineVersion)
            .map(codec.decode)
            .reduce(evolveCatalogItem, initialCatalogItemState);
          const batches = plan.commands.map((command) => {
            const events = decideCatalogItem(state, command);
            state = events.reduce(evolveCatalogItem, state);
            return events.map((event) => ({ eventType: event.type, payload: event.data }));
          });
          const suffix = actual.slice(baselineVersion);
          let completed = suffix.length === 0 ? 0 : -1;
          const expected = [] as { eventType: string; payload: CatalogItemEvent["data"] }[];
          for (const [index, batch] of batches.entries()) {
            expected.push(...batch);
            if (isDeepStrictEqual(suffix, expected)) completed = index + 1;
          }
          if (plan.mode === "create" && isDeepStrictEqual(suffix.slice(0, expected.length), expected))
            completed = batches.length;
          if (completed < 0) throw new Error("promotion-target-partial-command-or-unrelated-suffix");
          const execution = { planFingerprint: plan.planFingerprint, baselineVersion, batches };
          for (const previous of previousExecutions) {
            if (
              previous.planFingerprint === plan.planFingerprint &&
              previous.baselineVersion === baselineVersion &&
              !isDeepStrictEqual(previous.batches, batches)
            )
              throw new Error("promotion-target-poisoned-plan");
          }
          const entries = [...evidence.keys.values()].map((key) => {
            const bindingStream = promotionTargetBindingStream(key);
            const payload = promotionTargetBindingSchema.parse({
              version: 2,
              key,
              targetId,
              operationId,
              generation: versions.get(bindingStream)! + 1,
              execution,
            });
            return {
              streamId: bindingStream,
              expectedVersion: versions.get(bindingStream)!,
              context: input.context,
              events: [{ eventType: "catalog.promotion-target.bound", payload }],
            };
          });
          await append(entries);
          planPrepared = true;
          return completed;
        },
      };
    },
  };
}
