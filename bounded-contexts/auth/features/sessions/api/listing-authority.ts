import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, AppendToStreamInput, GlobalPosition } from "@chase-sets/event-core/storage";
import type {
  ListingAuthorityConsumerPort,
  ListingAuthorityOperation,
  ListingAuthoritySessionAuthorityPort,
  ListingAuthoritySessionEvidence,
  ListingAuthorityReservation,
} from "@chase-sets/event-core/listing-authority";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { toJsonValue } from "@chase-sets/primitives/json";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { AUTH_SESSION_STREAM_PREFIX, toSessionStreamId } from "../domain/auth-flow";
import { evolveSession, initialSessionState, type SessionEvent } from "../domain/domain";
import type { SessionTokenMutation, SessionTokenStore } from "./session-token-store";

export type AuthListingSessionAuthorityHostPorts = Readonly<{
  listingAuthorityConsumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
}>;

export class AuthSessionMutationPendingError extends HTTPException {
  readonly code = "auth_session_mutation_pending";
  constructor(
    public readonly mutationId: string,
    options: ErrorOptions,
  ) {
    const message = "Session mutation outcome is pending; resume the same mutation identity.";
    super(503, {
      message,
      cause: options.cause,
      res: Response.json({ error: { code: "auth_session_mutation_pending", mutationId, message } }, { status: 503 }),
    });
    this.name = "AuthSessionMutationPendingError";
  }
}

const resource = (sessionId: string) => `session/${sessionId}`;
const participant = { owner: "auth", purpose: "authenticated-session" } as const;

export function createAuthListingSessionAuthority(
  deps: Readonly<{
    eventStore: EventStore;
    tokens: SessionTokenStore;
    listingAuthorityConsumer?: AuthListingSessionAuthorityHostPorts["listingAuthorityConsumer"];
  }>,
) {
  const consumer = (operation: ListingAuthorityOperation) => {
    if (!deps.listingAuthorityConsumer) throw new Error("Auth session authority consumer is not mounted.");
    return deps.listingAuthorityConsumer(operation);
  };
  async function readSession(sessionId: string) {
    const events = await readCompleteStream(deps.eventStore, { streamId: toSessionStreamId(sessionId) });
    const codec = createPassthroughDomainEventCodec<SessionEvent>();
    const state = events.reduce((state, event) => evolveSession(state, codec.decode(event)), initialSessionState);
    const tenantId = events[0]?.tenantId;
    if (events.some((event) => event.tenantId !== tenantId)) throw new Error("Session tenant history is corrupt.");
    return { state, tenantId, revision: String(events.at(-1)?.streamVersion ?? 0) };
  }
  async function authenticate(tokenHash: string): Promise<ListingAuthoritySessionEvidence | null> {
    const token = await deps.tokens.authenticate(tokenHash);
    if (!token?.token_revision) return null;
    const loaded = await readSession(token.session_id);
    const { state, tenantId } = loaded;
    const validBefore = Math.min(Date.parse(token.expires_at), Date.parse(state.expiresAt ?? ""));
    if (
      !tenantId ||
      state.id !== token.session_id ||
      !state.userId ||
      !state.accountId ||
      state.status !== "active" ||
      !(Date.now() < validBefore)
    )
      return null;
    return {
      tenantId,
      userId: state.userId,
      accountId: state.accountId,
      authentication: {
        kind: "session",
        sessionId: token.session_id,
        revision: loaded.revision,
        tokenRevision: token.token_revision,
      },
      validBefore: new Date(validBefore).toISOString(),
    };
  }
  const source = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    participant,
    resourceScope: "owner",
    consumer,
    resources: (operation) => {
      const principal = operation.principal;
      if (principal?.kind !== "user" || principal.authentication.kind !== "session")
        throw new Error("Authenticated session principal required.");
      return [resource(principal.authentication.sessionId)];
    },
    validate: async (operation, context) => {
      const principal = operation.principal;
      if (principal?.kind !== "user" || principal.authentication.kind !== "session")
        throw new Error("Authenticated session principal required.");
      const selected = principal.authentication;
      const loaded = await readSession(selected.sessionId);
      const token = await deps.tokens.read(selected.sessionId);
      const { state } = loaded;
      const deadline = Math.min(
        Date.parse(token?.expires_at ?? ""),
        Date.parse(state.expiresAt ?? ""),
        Date.parse(principal.validBefore),
      );
      if (
        loaded.tenantId !== operation.tenantId ||
        state.id !== selected.sessionId ||
        state.userId !== principal.userId ||
        state.accountId !== operation.accountId ||
        state.status !== "active" ||
        selected.revision !== loaded.revision ||
        !token?.token_revision ||
        selected.tokenRevision !== token.token_revision ||
        !(Date.now() < deadline)
      )
        throw new Error("Selected session authority is no longer valid.");
      return {
        value: { sessionId: selected.sessionId },
        sourceRevisions: [
          { resourceId: resource(selected.sessionId), revision: loaded.revision },
          { resourceId: `session-token/${selected.sessionId}`, revision: token.token_revision },
        ],
        validBefore: new Date(deadline).toISOString(),
        localAppends: [
          {
            streamId: toSessionStreamId(selected.sessionId),
            expectedVersion: Number(loaded.revision),
            events: [],
            context,
          },
        ],
      };
    },
  });
  const writer = createListingAuthorityWriter({
    eventStore: deps.eventStore,
    source,
    owner: "auth",
    resources: async (inputs) =>
      inputs
        .filter((input) => input.events.length && input.streamId.startsWith(AUTH_SESSION_STREAM_PREFIX))
        .map((input) => resource(input.streamId.slice(AUTH_SESSION_STREAM_PREFIX.length))),
  });
  const intentStream = (id: string) => `auth.session-write-intent-${id}`;
  async function resumeSessionWrite(id: string) {
    const history = await readCompleteStream(deps.eventStore, { streamId: intentStream(id) });
    const inputs = history[0]?.payload.inputs as unknown as readonly AppendToStreamInput[];
    if (history.length !== 1 || !Array.isArray(inputs) || !inputs.length)
      throw new Error("Unknown or corrupt session write intent.");
    try {
      return await writer.eventStore.appendToStreams!(inputs);
    } catch (cause) {
      if ((cause as { code?: string }).code === "concurrency_conflict") throw cause;
      throw new AuthSessionMutationPendingError(id, { cause });
    }
  }
  async function append(inputs: readonly AppendToStreamInput[]) {
    if (!inputs.some((input) => input.events.length && input.streamId.startsWith(AUTH_SESSION_STREAM_PREFIX)))
      return writer.eventStore.appendToStreams!(inputs);
    // Retain the exact append plan before calling the shared writer. Its internal
    // fingerprint is deliberately private; owner recovery never reconstructs it.
    const id = `session-write-${randomUUID()}`;
    try {
      await deps.eventStore.appendToStream({
        streamId: intentStream(id),
        expectedVersion: 0,
        context: inputs[0]!.context,
        events: [{ eventType: "auth.session-write-intent.recorded", payload: { inputs: toJsonValue(inputs) } }],
      });
      return await resumeSessionWrite(id);
    } catch (cause) {
      if (
        cause instanceof AuthSessionMutationPendingError ||
        (cause as { code?: string }).code === "concurrency_conflict"
      )
        throw cause;
      throw new AuthSessionMutationPendingError(id, { cause });
    }
  }
  const eventStore: EventStore = {
    ...writer.eventStore,
    appendToStream: async (input) => (await append([input]))[0]!.storedEvents,
    appendToStreams: append,
  };
  async function resumeToken(mutationId: string) {
    const retained = await deps.tokens.readMutation(mutationId);
    if (!retained) throw new Error("Unknown session token mutation.");
    const command = { kind: "session-token", mutationId, sessionId: retained.sessionId };
    try {
      await source.mutate({
        resources: [resource(retained.sessionId)],
        mutationId,
        command,
        context: retained.context,
        prepare: async () => {
          await deps.tokens.apply(mutationId);
          return [];
        },
      });
    } catch (cause) {
      const status = await source.inspectInvalidation(retained.context.tenantId, mutationId).catch(() => null);
      if (status?.status !== "completed") throw new AuthSessionMutationPendingError(mutationId, { cause });
    }
    if (!(await deps.tokens.readMutation(mutationId))?.applied) throw new Error("Session token receipt missing.");
    await deps.tokens.complete(mutationId);
  }
  const port: ListingAuthoritySessionAuthorityPort = { ...source, participant };
  return {
    source,
    port,
    eventStore,
    authenticate,
    readSession,
    async mutateToken(input: SessionTokenMutation) {
      try {
        await deps.tokens.stage(input);
      } catch (cause) {
        throw new AuthSessionMutationPendingError(input.mutationId, { cause });
      }
      await resumeToken(input.mutationId);
    },
    resumeToken,
    resumeWrite: writer.resumeWrite,
    /** Host persists the event cursor and wraps to zero after each bounded scan.
     * Pending SQL mutations are also scanned: a crash may precede event closure. */
    async recoverPage(input: Readonly<{ after?: string; limit?: number }> = {}) {
      const limit = input.limit ?? 25;
      const after = input.after ?? "0";
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid Auth recovery page.");
      const outcomes: { identity: string; status: "recovered" | "pending"; error?: string }[] = [];
      async function recover(identity: string, run: () => Promise<unknown>) {
        try {
          await run();
          outcomes.push({ identity, status: "recovered" });
        } catch (error) {
          outcomes.push({
            identity,
            status: "pending",
            error: error instanceof Error ? error.message : "Unknown recovery error",
          });
        }
      }
      for (const id of await deps.tokens.pending(limit)) await recover(id, () => resumeToken(id));
      const events = await deps.eventStore.readAll({
        afterGlobalPosition: after as GlobalPosition,
        eventTypes: ["auth.session-write-intent.recorded", "auth.listing-authority.reserved"],
        limit,
      });
      for (const event of events) {
        if (event.eventType === "auth.session-write-intent.recorded") {
          const id = event.streamId.slice("auth.session-write-intent-".length);
          await recover(id, () => resumeSessionWrite(id));
        } else {
          const reservation = event.payload.reservation as unknown as ListingAuthorityReservation;
          await recover(reservation.reservationId, async () => {
            const current = await source.inspect(reservation.operation);
            if (!current) throw new Error("Missing Auth reservation history.");
            if (current.status !== "reserved") return;
            let terminal = await consumer(reservation.operation).inspect(reservation.operation);
            if (terminal.status === "pending" && Date.now() >= Date.parse(current.validBefore))
              terminal = await consumer(reservation.operation).invalidate(reservation.operation, "auth-validity-ended");
            if (terminal.status === "pending" || terminal.status === "unknown")
              throw new Error("Auth promise still pending.");
            await source.settle(reservation.operation);
          });
        }
      }
      return { after: events.length === limit ? events.at(-1)!.globalPosition : "0", outcomes };
    },
    resumeMutation: async (mutationId: string, context: EventStoreContext) => {
      if (mutationId.startsWith("session-write-")) return resumeSessionWrite(mutationId);
      if (mutationId.startsWith("writer-")) return writer.resume(mutationId, context);
      return resumeToken(mutationId);
    },
  };
}

export type AuthListingSessionAuthorityServices = ReturnType<typeof createAuthListingSessionAuthority>;
