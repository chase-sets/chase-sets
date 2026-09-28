import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createEventStoreError, type AppendToStreamsResult, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityOwner, ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import type { ListingAuthoritySource } from "./listing-authority-participant";
import { assertSameAuthority, authorityHash, authorityPayload } from "./listing-authority-state";

/** Owner policy supplies the affected predicate scopes, including insertions, not just existing streams. */
export function createListingAuthorityWriter(
  deps: Readonly<{
    eventStore: EventStore;
    source: ListingAuthoritySource;
    owner: ListingAuthorityOwner;
    resources(inputs: readonly AppendToStreamInput[]): Promise<readonly string[]>;
  }>,
) {
  const raw = deps.eventStore;
  const atomic = raw.appendToStreams;
  if (!atomic) throw new Error("Authority writers require atomic source appends.");

  async function append(inputs: readonly AppendToStreamInput[]): Promise<readonly AppendToStreamsResult[]> {
    let resources = await deps.resources(inputs);
    if (!resources.length) return atomic!(inputs);
    const context = inputs[0]?.context;
    if (!context || inputs.some((input) => input.context.tenantId !== context.tenantId)) {
      throw new Error("Authority mutation must have one tenant.");
    }
    if (inputs.some((input) => input.expectedVersion === "any")) {
      throw new Error("Authority mutation requires exact source versions.");
    }
    const command = authorityPayload({ inputs });
    const mutationId = `writer-${authorityHash(command)}`;
    const prior = await deps.source.inspectInvalidation(context.tenantId, mutationId);
    if (prior) resources = prior.intent.resources;
    const receiptStream = `${deps.owner}.listing-authority-write-${authorityHash([context.tenantId, mutationId])}`;
    const localCommits: ListingAuthorityOperation[] = [];
    for (const input of inputs) {
      if (input.events.some((event) => event.eventType === `${deps.owner}.listing-authority-operation.committed`)) {
        const history = await readCompleteStream(raw, { streamId: input.streamId });
        const operation = history[0]?.payload.operation as unknown as ListingAuthorityOperation | undefined;
        if (!operation || input.streamId !== `${deps.owner}.listing-authority-operation-${operation.operationId}`)
          throw new Error("Source-local commit lost its operation history.");
        localCommits.push(operation);
      }
    }
    await deps.source.mutate({
      resources,
      mutationId,
      command,
      context,
      localCommits,
      prepare: async () => {
        // Closure prevents new grants. A previous writer may have won before closure;
        // reject its stale successor durably rather than stranding the predicate closed.
        const currentResources = await deps.resources(inputs);
        let conflict =
          authorityHash([...new Set(currentResources)].sort()) !== authorityHash([...new Set(resources)].sort());
        for (const input of inputs) {
          const events = await readCompleteStream(raw, { streamId: input.streamId });
          const version = events.at(-1)?.streamVersion ?? 0;
          const expected = input.expectedVersion === "no_stream" ? 0 : input.expectedVersion;
          if (version !== expected) conflict = true;
          if (input.authorizationDeadline && !(Date.now() < Date.parse(input.authorizationDeadline))) conflict = true;
        }
        return [
          ...(conflict ? [] : inputs),
          {
            streamId: receiptStream,
            expectedVersion: 0,
            context,
            events: [
              {
                eventType: `${deps.owner}.listing-authority-write.completed`,
                payload: { mutationId, status: conflict ? "conflict" : "appended" },
              },
            ],
          },
        ];
      },
    });
    const receipt = await readCompleteStream(raw, { streamId: receiptStream });
    if (receipt.length !== 1 || receipt[0]!.payload.mutationId !== mutationId) {
      throw new Error("Missing authoritative source mutation receipt.");
    }
    if (receipt[0]!.payload.status === "conflict") {
      throw createEventStoreError(
        "concurrency_conflict",
        "Authority source changed before its mutation acquired closure.",
      );
    }
    if (receipt[0]!.payload.status !== "appended") throw new Error("Corrupt source mutation receipt.");
    return Promise.all(
      inputs.map(async (input) => {
        const expected = input.expectedVersion === "no_stream" ? 0 : Number(input.expectedVersion);
        const storedEvents = (
          await readCompleteStream(raw, {
            streamId: input.streamId,
            fromVersion: expected + 1,
          })
        ).slice(0, input.events.length);
        if (storedEvents.length !== input.events.length) throw new Error("Source mutation history is incomplete.");
        storedEvents.forEach((event, index) => {
          const intended = input.events[index]!;
          assertSameAuthority(event.payload, intended.payload);
          if (event.eventType !== intended.eventType || event.tenantId !== input.context.tenantId) {
            throw new Error("Source mutation history does not match its durable intent.");
          }
        });
        return { streamId: input.streamId, storedEvents };
      }),
    );
  }

  const eventStore: EventStore = {
    readAll: raw.readAll,
    readStream: raw.readStream,
    appendToStream: async (input) => (await append([input]))[0]!.storedEvents,
    appendToStreams: append,
    appendToStreamsIndependently: async (inputs) => {
      const results = [];
      for (const input of inputs) {
        try {
          const [result] = await append([input]);
          results.push({ ...result!, outcome: input.events.length ? ("appended" as const) : ("no_op" as const) });
        } catch (error) {
          if ((error as { code?: string }).code !== "concurrency_conflict") throw error;
          results.push({
            streamId: input.streamId,
            storedEvents: [],
            outcome: "conflict" as const,
            error: createEventStoreError("concurrency_conflict", (error as Error).message),
          });
        }
      }
      return results;
    },
  };

  return {
    eventStore,
    /** The owner recovery job supplies the original tenant/audit context, not a fresh request identity. */
    async resume(mutationId: string, context: EventStoreContext) {
      const mutation = await deps.source.inspectInvalidation(context.tenantId, mutationId);
      if (!mutation) throw new Error("Unknown source writer mutation.");
      const inputs = mutation.intent.command.inputs as unknown as readonly AppendToStreamInput[];
      if (!Array.isArray(inputs) || `writer-${authorityHash({ inputs })}` !== mutationId) {
        throw new Error("Invalid source writer mutation intent.");
      }
      return append(inputs);
    },
  };
}
