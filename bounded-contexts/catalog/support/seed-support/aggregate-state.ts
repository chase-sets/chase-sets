import type { AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogLifecycleStatus } from "../runtime-support/common";

export type SeedAggregateLifecycleState = Readonly<{
  id: string | null;
  key: string | null;
  status: CatalogLifecycleStatus;
}>;

export type SeedAggregateState<State extends SeedAggregateLifecycleState, Event extends DomainEvent> = Readonly<{
  kind: "absent" | "draft" | "active";
  state: State;
  events: readonly Event[];
}>;

type StoredSeedEventRow = Readonly<{
  stream_id: string;
  stream_version: string | number;
  event_type: string;
  payload: Record<string, unknown>;
}>;

export async function loadSeedAggregateState<
  State extends SeedAggregateLifecycleState,
  Event extends DomainEvent,
>(input: {
  db: PgQueryable;
  aggregateName: string;
  streamId: string;
  createdEventType: Event["type"];
  createdIdField: string;
  expectedId: string;
  expectedKey: string;
  keyScope?: Readonly<{ field: string; value: string }>;
  initialState: State;
  evolve: AggregateEvolver<State, Event>;
  validateIdentity?: (state: State) => void;
}): Promise<SeedAggregateState<State, Event>> {
  const stored = await input.db.query<StoredSeedEventRow>(
    `SELECT stream_id, stream_version, event_type, payload
     FROM event_store_events
     WHERE stream_id = $1
        OR (
          event_type = $2
          AND payload->>'key' = $3
          AND ($4::text IS NULL OR payload->>$4 = $5)
        )
     ORDER BY stream_id, stream_version`,
    [
      input.streamId,
      input.createdEventType,
      input.expectedKey,
      input.keyScope?.field ?? null,
      input.keyScope?.value ?? null,
    ],
  );

  const conflictingCreated = stored.rows.find((row) => row.stream_id !== input.streamId);
  if (conflictingCreated) {
    throw identityConflictError(input, {
      id: stringValue(conflictingCreated.payload[input.createdIdField]),
      key: stringValue(conflictingCreated.payload.key),
    });
  }

  const events = stored.rows
    .filter((row) => row.stream_id === input.streamId)
    .map(
      (row) =>
        ({
          type: row.event_type,
          data: row.payload,
        }) as Event,
    );
  const state = events.reduce(input.evolve, input.initialState);

  if (state.id === null) {
    if (events.length > 0) {
      throw new Error(
        `Catalog integration bootstrap ${input.aggregateName} '${input.expectedKey}' has events but folds to no aggregate id.`,
      );
    }
    return { kind: "absent", state, events };
  }

  if (String(state.id) !== input.expectedId || state.key !== input.expectedKey) {
    throw identityConflictError(input, {
      id: String(state.id),
      key: state.key,
    });
  }
  input.validateIdentity?.(state);

  if (state.status === "deprecated" || state.status === "archived") {
    throw new Error(
      `Catalog integration bootstrap ${input.aggregateName} '${input.expectedKey}' expected status 'active', but found terminal status '${state.status}'.`,
    );
  }
  if (state.status === "active") {
    return { kind: "active", state, events };
  }
  if (state.status === "draft") {
    return { kind: "draft", state, events };
  }

  throw new Error(
    `Catalog integration bootstrap ${input.aggregateName} '${input.expectedKey}' expected status 'draft' or 'active', but found '${String(state.status)}'.`,
  );
}

export async function loadSeedStreamEvents<Event extends DomainEvent>(
  db: PgQueryable,
  streamId: string,
): Promise<readonly Event[]> {
  const stored = await db.query<StoredSeedEventRow>(
    `SELECT stream_id, stream_version, event_type, payload
     FROM event_store_events
     WHERE stream_id = $1
     ORDER BY stream_version`,
    [streamId],
  );
  return stored.rows.map(
    (row) =>
      ({
        type: row.event_type,
        data: row.payload,
      }) as Event,
  );
}

function identityConflictError(
  input: Readonly<{
    aggregateName: string;
    expectedId: string;
    expectedKey: string;
  }>,
  found: Readonly<{ id: string | null; key: string | null }>,
): Error {
  return new Error(
    `Catalog integration bootstrap ${input.aggregateName} '${input.expectedKey}' expected id '${input.expectedId}' and key '${input.expectedKey}', but found id '${found.id ?? "null"}' and key '${found.key ?? "null"}'.`,
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
