import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createEventStoreError, type AppendToStreamsResult, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityOwner, ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import { LISTING_AUTHORITY_RESOURCE_LIMIT } from "@chase-sets/event-core/listing-authority";
import type { ListingAuthoritySource } from "./listing-authority-participant";
import { assertSameAuthority, authorityHash, authorityPayload } from "./listing-authority-state";
import { appendAuthorityAppends, readAuthorityJournal } from "./listing-authority-journal";

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

  const writeStream = (writeId: string) => `${deps.owner}.listing-authority-write-${writeId}`;
  type Attempt = Readonly<{
    writeId: string;
    mutationId: string;
    resources: readonly string[];
    inputs: readonly AppendToStreamInput[];
  }>;
  const conflict = () =>
    createEventStoreError("concurrency_conflict", "Authority source changed before its mutation acquired closure.");

  async function readAttempt(writeId: string) {
    const { events: history } = await readAuthorityJournal(raw, writeStream(writeId));
    let attempt: Attempt | undefined;
    let status: "pending" | "appended" | "source-conflict" | "resources-conflict" | undefined;
    for (const event of history) {
      if (event.eventType === `${deps.owner}.listing-authority-write.started`) {
        if (status === "pending" || (status && status !== "resources-conflict"))
          throw new Error("Invalid source write attempt transition.");
        attempt = event.payload as unknown as Attempt;
        if (
          attempt.writeId !== writeId ||
          !Array.isArray(attempt.inputs) ||
          !Array.isArray(attempt.resources) ||
          authorityHash({ inputs: attempt.inputs }) !== writeId ||
          attempt.mutationId !== `writer-${authorityHash([writeId, event.streamVersion])}`
        )
          throw new Error("Invalid source write attempt identity.");
        status = "pending";
      } else if (event.eventType === `${deps.owner}.listing-authority-write.completed`) {
        if (
          status !== "pending" ||
          event.payload.mutationId !== attempt?.mutationId ||
          !["appended", "source-conflict", "resources-conflict"].includes(String(event.payload.status))
        )
          throw new Error("Invalid source write completion.");
        status = event.payload.status as Exclude<typeof status, "pending" | undefined>;
      } else throw new Error("Unknown source write event.");
    }
    return { attempt, status, version: history.at(-1)?.streamVersion ?? 0 };
  }

  async function append(inputs: readonly AppendToStreamInput[]): Promise<readonly AppendToStreamsResult[]> {
    const writeId = authorityHash({ inputs });
    let journal = await readAttempt(writeId);
    if (!journal.attempt || journal.status === "resources-conflict") {
      let resources = [...new Set(await deps.resources(inputs))].sort();
      if (!resources.length && !journal.attempt) return atomic!(inputs);
      if (!resources.length) resources = [...journal.attempt!.resources];
      if (resources.length > LISTING_AUTHORITY_RESOURCE_LIMIT || resources.some((id) => !id || id.length > 500))
        throw new Error("Invalid bounded authority resource set.");
      const context = inputs[0]?.context;
      if (!context || inputs.some((input) => input.context.tenantId !== context.tenantId))
        throw new Error("Authority mutation must have one tenant.");
      if (inputs.some((input) => input.expectedVersion === "any"))
        throw new Error("Authority mutation requires exact source versions.");
      const attempt: Attempt = {
        writeId,
        mutationId: `writer-${authorityHash([writeId, journal.version + 1])}`,
        resources,
        inputs,
      };
      await appendAuthorityAppends(raw, [
        {
          streamId: writeStream(writeId),
          expectedVersion: journal.version,
          context,
          events: [{ eventType: `${deps.owner}.listing-authority-write.started`, payload: authorityPayload(attempt) }],
        },
      ]);
      journal = await readAttempt(writeId);
    }
    return execute(journal);
  }

  async function execute(journal: Awaited<ReturnType<typeof readAttempt>>): Promise<readonly AppendToStreamsResult[]> {
    const attempt = journal.attempt;
    if (!attempt) throw new Error("Unknown source write attempt.");
    const { inputs, resources, mutationId, writeId } = attempt;
    if (journal.status === "source-conflict" || journal.status === "resources-conflict") throw conflict();
    const context = inputs[0]?.context;
    if (!context || inputs.some((input) => input.context.tenantId !== context.tenantId)) {
      throw new Error("Authority mutation must have one tenant.");
    }
    if (inputs.some((input) => input.expectedVersion === "any")) {
      throw new Error("Authority mutation requires exact source versions.");
    }
    const command = authorityPayload({ inputs, writeId });
    const localCommits: ListingAuthorityOperation[] = [];
    for (const input of inputs) {
      if (input.events.some((event) => event.eventType === `${deps.owner}.listing-authority-operation.committed`)) {
        const { events: history } = await readAuthorityJournal(raw, input.streamId);
        const operation = history[0]?.payload.operation as unknown as ListingAuthorityOperation | undefined;
        if (!operation || input.streamId !== `${deps.owner}.listing-authority-operation-${operation.operationId}`)
          throw new Error("Source-local commit lost its operation history.");
        localCommits.push(operation);
      }
    }
    if (journal.status === "pending")
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
          const resourcesChanged = currentResources.some((resource) => !resources.includes(resource));
          let sourceChanged = false;
          for (const input of inputs) {
            const events = await readCompleteStream(raw, { streamId: input.streamId });
            const version = events.at(-1)?.streamVersion ?? 0;
            const expected = input.expectedVersion === "no_stream" ? 0 : input.expectedVersion;
            if (version !== expected) sourceChanged = true;
            if (input.authorizationDeadline && !(Date.now() < Date.parse(input.authorizationDeadline)))
              sourceChanged = true;
          }
          return [
            ...(sourceChanged || resourcesChanged ? [] : inputs),
            {
              streamId: writeStream(writeId),
              expectedVersion: journal.version,
              context,
              events: [
                {
                  eventType: `${deps.owner}.listing-authority-write.completed`,
                  payload: {
                    mutationId,
                    status: sourceChanged ? "source-conflict" : resourcesChanged ? "resources-conflict" : "appended",
                  },
                },
              ],
            },
          ];
        },
      });
    const receipt = await readAttempt(writeId);
    if (receipt.attempt?.mutationId !== mutationId) {
      throw new Error("Missing authoritative source mutation receipt.");
    }
    if (receipt.status === "source-conflict" || receipt.status === "resources-conflict") throw conflict();
    if (receipt.status !== "appended") throw new Error("Corrupt source mutation receipt.");
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
    appendToStream: async (input) => {
      if (input.expectedFirstEventId !== undefined)
        throw new Error("Stream opening guards require atomic appendToStreams.");
      return (await append([input]))[0]!.storedEvents;
    },
    appendToStreams: append,
    appendToStreamsIndependently: async (inputs) => {
      if (inputs.some((input) => input.expectedFirstEventId !== undefined))
        throw new Error("Stream opening guards require atomic appendToStreams.");
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
    async resumeWrite(writeId: string) {
      return execute(await readAttempt(writeId));
    },
    /** The owner recovery job supplies the original tenant/audit context, not a fresh request identity. */
    async resume(mutationId: string, context: EventStoreContext) {
      const mutation = await deps.source.inspectInvalidation(context.tenantId, mutationId);
      if (!mutation) throw new Error("Unknown source writer mutation.");
      const inputs = mutation.intent.command.inputs as unknown as readonly AppendToStreamInput[];
      const writeId = mutation.intent.command.writeId;
      if (!Array.isArray(inputs) || typeof writeId !== "string" || authorityHash({ inputs }) !== writeId) {
        throw new Error("Invalid source writer mutation intent.");
      }
      const journal = await readAttempt(writeId);
      if (journal.attempt?.mutationId !== mutationId) throw new Error("Source writer attempt has already advanced.");
      return execute(journal);
    },
  };
}
