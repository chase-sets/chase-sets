import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { foldEvents } from "@chase-sets/event-core";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  decideEconomicsOverride,
  evolveEconomicsOverrides,
  initialEconomicsOverridesState,
  type EconomicsOverrideCommand,
  type EconomicsOverrideEvent,
  type EconomicsOverrideKey,
  type EconomicsOverridesState,
} from "../domain/overrides";
import { requireRfc3339Instant } from "../domain/contracts";
import { canonicalSha256 } from "../domain/revision";
import { buildEconomicsOverrideProjectionHandlers } from "../read-model/override-projection";
import { readCurrentEconomicsOverrides } from "../read-model/override-queries";

export type EconomicsOverrideRuntime = Readonly<{
  execute: (
    input: Readonly<{
      key: EconomicsOverrideKey;
      command: EconomicsOverrideCommand;
      context: EventStoreContext;
    }>,
  ) => Promise<EconomicsOverridesState>;
  loadAt: (key: EconomicsOverrideKey, effectiveAt: string) => Promise<EconomicsOverridesState>;
  readCurrentProjection: (key: EconomicsOverrideKey) => Promise<EconomicsOverridesState>;
  streamIdForKey: (key: EconomicsOverrideKey) => string;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createEconomicsOverrideRuntime(
  deps: Readonly<{ eventStore: EventStore; db: PgQueryable }>,
): EconomicsOverrideRuntime {
  const codec = createPassthroughDomainEventCodec<EconomicsOverrideEvent>();

  return {
    execute: async ({ key, command, context }) => {
      const initial = initialEconomicsOverridesState(key);
      const { commandHandler } = createAggregateCommandHandler({
        eventStore: deps.eventStore,
        codec,
        initialState: () => initial,
        evolve: evolveEconomicsOverrides,
        decide: decideEconomicsOverride,
        commitSourceContextName: "pricing",
      });
      const result = await commandHandler({
        streamId: economicsOverrideStreamId(key),
        command,
        context,
        expectedVersion: command.expectedVersion,
      });
      return result.state;
    },
    loadAt: async (key, effectiveAt) => {
      const cutoff = Date.parse(requireRfc3339Instant(effectiveAt, "effectiveAt"));
      const events = await readCompleteStream(deps.eventStore, { streamId: economicsOverrideStreamId(key) });
      const applicable = events
        .map((stored) => codec.decode({ eventType: stored.eventType, payload: stored.payload }))
        .filter((event) => Date.parse(requireRfc3339Instant(event.data.occurredAt, "override occurredAt")) <= cutoff);
      return foldEvents(initialEconomicsOverridesState(key), evolveEconomicsOverrides, applicable);
    },
    readCurrentProjection: (key) => readCurrentEconomicsOverrides(deps.db, key),
    streamIdForKey: economicsOverrideStreamId,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "pricing-economics-overrides-projection",
        handlers: buildEconomicsOverrideProjectionHandlers(deps.db),
      }),
    ],
  };
}

export function economicsOverrideStreamId(key: EconomicsOverrideKey): string {
  const normalized = initialEconomicsOverridesState(key).key;
  return `pricing.economics-overrides-${canonicalSha256(normalized).slice("sha256:".length)}`;
}
