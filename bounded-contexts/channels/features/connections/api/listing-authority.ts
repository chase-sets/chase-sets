import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ListingAuthorityConsumerPort, ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import type {
  AppendToStreamInput,
  EventStoreContext,
  GlobalPosition,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { channelConnectionEventCodec } from "../domain/codec";
import { ChannelConnectionError, type ChannelConnectionEvent, type ChannelConnectionState } from "../domain/contracts";
import { evolveChannelConnection, initialChannelConnectionState } from "../domain/domain";
import { assertOpaqueId } from "../domain/validation";

const streamId = (connectionId: string) => `channels.connection-${connectionId}`;
const resourceId = (connectionId: string) => `connection/${connectionId}`;

export class ChannelConnectionMutationPendingError extends Error {
  constructor(
    public readonly mutationId: string,
    options: ErrorOptions,
  ) {
    super("Channel connection mutation outcome unresolved; recover this mutation identity.", options);
    this.name = "ChannelConnectionMutationPendingError";
  }
}

/** Mount only with the consumer's authenticated channels-bound port. No publication adapter is involved. */
export function createChannelConnectionAuthority(
  eventStore: EventStore,
  consumer?: (operation: ListingAuthorityOperation) => ListingAuthorityConsumerPort,
) {
  const source = createListingAuthorityParticipant({
    eventStore,
    participant: { owner: "channels", purpose: "connection" },
    consumer: (operation) => {
      if (!consumer) throw new Error("Channel connection authority consumer is not mounted.");
      return consumer(operation);
    },
    resources: (operation) => [resourceId(targetConnection(operation))],
    validate: async (operation, context) => {
      const connectionId = targetConnection(operation);
      const loaded = await loadConnection(eventStore, connectionId, context);
      if (!loaded.state.connectionId) throw new ChannelConnectionError("connection-not-found");
      if (loaded.state.status === "disconnected") throw new ChannelConnectionError("connection-disconnected");
      return {
        value: {
          connectionId,
          accountId: loaded.state.accountId,
          providerKey: loaded.state.providerKey,
          environment: loaded.state.environment,
          status: loaded.state.status,
          revision: loaded.version,
        },
        sourceRevisions: [{ resourceId: resourceId(connectionId), revision: String(loaded.version) }],
        validBefore: operation.prepareBefore,
        localAppends: [{ streamId: streamId(connectionId), expectedVersion: loaded.version, events: [], context }],
      };
    },
  });

  async function recoverMutation(mutationId: string, context: EventStoreContext): Promise<readonly StoredEvent[]> {
    const retained = await source.inspectInvalidation(context.tenantId, mutationId);
    if (!retained) throw new Error("Unknown channel connection mutation.");
    const command = retained.intent.command;
    const connectionId = command.connectionId;
    assertOpaqueId(connectionId, "connectionId");
    if (
      command.accountId !== context.audit.forAccountId ||
      command.actorId !== context.audit.performedByUserId ||
      !Number.isSafeInteger(command.expectedVersion) ||
      (command.expectedVersion as number) < 0 ||
      !Array.isArray(command.events) ||
      command.events.length < 1 ||
      command.events.length > 2 ||
      retained.intent.resources.length !== 1 ||
      retained.intent.resources[0] !== resourceId(connectionId)
    )
      throw new Error("Invalid channel connection mutation binding.");
    const expectedVersion = command.expectedVersion as number;
    const events = command.events.map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.eventType !== "string" ||
        !value.payload ||
        typeof value.payload !== "object" ||
        Array.isArray(value.payload)
      ) {
        throw new Error("Corrupt channel connection mutation events.");
      }
      const decoded = channelConnectionEventCodec.decode({ eventType: value.eventType, payload: value.payload });
      if (decoded.data.connectionId !== connectionId) throw new Error("Connection mutation identity mismatch.");
      return { ...channelConnectionEventCodec.encode(decoded), metadata: { authorityMutationId: mutationId } };
    });
    try {
      await source.mutate({
        resources: [resourceId(connectionId)],
        mutationId,
        command,
        context,
        prepare: async () => {
          const loaded = await loadConnection(eventStore, connectionId, context);
          if (loaded.version !== expectedVersion) throw new Error("Connection mutation source revision changed.");
          events.reduce(
            (state, event) => advanceConnection(state, channelConnectionEventCodec.decode(event), context),
            loaded.state,
          );
          return [
            { streamId: streamId(connectionId), expectedVersion, events, context, wakeSourceContextName: "channels" },
          ];
        },
      });
    } catch (cause) {
      // A lost append reply may already have completed. Anything else retains the SAME intent.
      const status = await source.inspectInvalidation(context.tenantId, mutationId).catch(() => null);
      if (status?.status !== "completed" || !isDeepStrictEqual(status.intent.command, command)) {
        throw new ChannelConnectionMutationPendingError(mutationId, { cause });
      }
      await source.mutate({
        resources: retained.intent.resources,
        mutationId,
        command,
        context,
        prepare: async () => {
          throw new Error("Completed connection mutation unexpectedly reopened.");
        },
      });
    }
    const loaded = await loadConnection(eventStore, connectionId, context);
    const written = loaded.events.slice(expectedVersion, expectedVersion + events.length);
    if (
      written.length !== events.length ||
      written.some((event) => event.metadata.authorityMutationId !== mutationId)
    ) {
      throw new Error("Completed connection mutation history is unavailable or corrupt.");
    }
    return written;
  }

  async function append(input: AppendToStreamInput): Promise<readonly StoredEvent[]> {
    if (!input.streamId.startsWith("channels.connection-") || input.expectedVersion === "any" || !input.events.length) {
      throw new Error("Connection authority requires an exact source revision and business events.");
    }
    const connectionId = input.streamId.slice("channels.connection-".length);
    const loaded = await loadConnection(eventStore, connectionId, input.context);
    const expectedVersion = input.expectedVersion === "no_stream" ? 0 : input.expectedVersion;
    if (loaded.version !== expectedVersion) throw new Error("Connection mutation source revision changed.");
    const events = input.events.map((event) =>
      channelConnectionEventCodec.encode(channelConnectionEventCodec.decode(event)),
    );
    events.reduce(
      (state, event) => advanceConnection(state, channelConnectionEventCodec.decode(event), input.context),
      loaded.state,
    );
    if (
      events.some(
        (event) =>
          event.payload.connectionId !== connectionId ||
          (event.eventType === "channels.connection.connected" &&
            event.payload.accountId !== input.context.audit.forAccountId),
      )
    ) {
      throw new Error("Connection mutation account or identity mismatch.");
    }
    // The next revision is a durable mutation slot, not a new random key on each retry.
    const mutationId = createHash("sha256")
      .update(JSON.stringify([input.context.tenantId, connectionId, expectedVersion]))
      .digest("hex");
    const command = {
      connectionId,
      expectedVersion,
      accountId: input.context.audit.forAccountId,
      actorId: input.context.audit.performedByUserId,
      events: events.map(({ eventType, payload }) => ({ eventType, payload })),
    };
    try {
      await source.mutate({
        resources: [resourceId(connectionId)],
        mutationId,
        command,
        context: input.context,
        prepare: async () => [
          {
            ...input,
            expectedVersion,
            events: events.map((event) => ({
              ...event,
              metadata: { authorityMutationId: mutationId },
            })),
          },
        ],
      });
    } catch (cause) {
      const status = await source.inspectInvalidation(input.context.tenantId, mutationId).catch(() => null);
      if (status?.status !== "completed" || !isDeepStrictEqual(status.intent.command, command)) {
        throw new ChannelConnectionMutationPendingError(mutationId, { cause });
      }
      await source.mutate({
        resources: [resourceId(connectionId)],
        mutationId,
        command,
        context: input.context,
        prepare: async () => {
          throw new Error("Completed connection mutation unexpectedly reopened.");
        },
      });
    }
    return recoverMutation(mutationId, input.context);
  }

  async function recoverPage(
    input: Readonly<{ tenantId: EventStoreContext["tenantId"]; afterGlobalPosition?: GlobalPosition }>,
  ) {
    const events = await eventStore.readAll({
      tenantId: input.tenantId,
      afterGlobalPosition: input.afterGlobalPosition,
      limit: 16,
      streamPrefixes: ["channels.listing-authority-mutation-", "channels.listing-authority-reservation-"],
      eventTypes: ["channels.listing-authority.invalidation-started", "channels.listing-authority.reserved"],
    });
    for (const event of events) {
      if (event.tenantId !== input.tenantId) throw new Error("Foreign connection authority recovery history.");
      if (event.eventType === "channels.listing-authority.invalidation-started") {
        const intent = event.payload.intent;
        if (!isRecord(intent) || typeof intent.mutationId !== "string") {
          throw new Error("Corrupt connection authority recovery intent.");
        }
        await recoverMutation(intent.mutationId, {
          tenantId: event.tenantId,
          audit: { forAccountId: event.forAccountId, performedByUserId: event.performedByUserId },
        });
      } else {
        const retained = event.payload.reservation;
        if (!isRecord(retained) || !isRecord(retained.operation))
          throw new Error("Corrupt connection reservation recovery history.");
        const operation = retained.operation as unknown as ListingAuthorityOperation;
        const grant = await source.inspect(operation);
        if (!grant || grant.operation.tenantId !== input.tenantId)
          throw new Error("Missing connection authority recovery reservation.");
        if (grant.status === "reserved") {
          if (!consumer) throw new Error("Channel connection authority consumer is not mounted.");
          const outcome = await consumer(operation).inspect(operation);
          if (outcome.status === "unknown")
            throw new Error("Unknown connection consumer outcome; retain recovery cursor.");
          if (outcome.status !== "pending") await source.settle(operation);
        }
      }
    }
    // Scan again from the beginning on the next sweep; pending promises are never reclaimed by age.
    return { nextCursor: events.length === 16 ? events.at(-1)!.globalPosition : null };
  }

  return { source, append, recoverMutation, recoverPage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function targetConnection(operation: ListingAuthorityOperation) {
  if (operation.target.kind !== "channel-connection")
    throw new Error("Connection authority requires an exact channel target.");
  assertOpaqueId(operation.target.connectionId, "connectionId");
  return operation.target.connectionId;
}

async function loadConnection(eventStore: EventStore, connectionId: string, context: EventStoreContext) {
  assertOpaqueId(connectionId, "connectionId");
  const events = await readCompleteStream(eventStore, { streamId: streamId(connectionId) });
  let state = initialChannelConnectionState;
  for (const [index, stored] of events.entries()) {
    const event = channelConnectionEventCodec.decode(stored);
    if (
      stored.streamVersion !== index + 1 ||
      stored.tenantId !== context.tenantId ||
      stored.forAccountId !== context.audit.forAccountId ||
      event.data.connectionId !== connectionId ||
      (index === 0) !== (event.type === "channels.connection.connected") ||
      state.status === "disconnected"
    ) {
      throw new Error("Corrupt or foreign channel connection authority history.");
    }
    state = advanceConnection(state, event, context);
  }
  if (events.length && state.accountId !== context.audit.forAccountId)
    throw new ChannelConnectionError("connection-not-found");
  return { state, version: events.length, events };
}

function advanceConnection(state: ChannelConnectionState, event: ChannelConnectionEvent, context: EventStoreContext) {
  if (
    (state.connectionId === null) !== (event.type === "channels.connection.connected") ||
    state.status === "disconnected" ||
    (state.connectionId !== null && event.data.connectionId !== state.connectionId) ||
    (event.type === "channels.connection.connected" && event.data.accountId !== context.audit.forAccountId) ||
    (event.type === "channels.connection.activated" && state.status !== "pending-setup") ||
    (event.type === "channels.connection.paused" && state.status !== "active") ||
    (event.type === "channels.connection.resumed" && state.status !== "paused")
  ) {
    throw new Error("Invalid connection authority transition history.");
  }
  return evolveChannelConnection(state, event);
}
