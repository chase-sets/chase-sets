import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Shared, stream-sourced aggregate state for bootstrap seeds.
 *
 * A seed must never decide what remains to author from a read-model
 * projection. Projections lag their streams and every context stores its
 * replayable projections `UNLOGGED`, so PostgreSQL truncates them on crash
 * recovery while the logged event streams survive. A projection-sourced guard
 * then reads zero rows, re-issues a create command against an aggregate that
 * already exists, and the domain correctly rejects it
 * (`... has already been created`).
 *
 * This fold reads `event_store_events` — the authoritative record — and
 * classifies the aggregate as:
 *
 * - `absent`  no events on the stream, nothing authored yet: author it.
 * - `draft`   committed but not finished: resume the remaining commands.
 * - `active`  finished: append nothing.
 *
 * and fails closed (throws, naming the context, aggregate, and stream) when
 * retained state cannot be reconciled with what the seed expects: a
 * conflicting identity on the stream, the same logical key carried by a
 * different stream, or an unexpected terminal status.
 */

export type SeedAggregateStateKind = "absent" | "draft" | "active";

export type SeedAggregateState<State, Event extends DomainEvent> = Readonly<{
  kind: SeedAggregateStateKind;
  /** Derived status of the folded aggregate; `null` when the stream is empty. */
  status: string | null;
  state: State;
  events: readonly Event[];
}>;

export type SeedAggregateIdentity = Readonly<{
  id: string | null;
  key: string | null;
}>;

export type SeedAggregateStateInput<State, Event extends DomainEvent> = Readonly<{
  db: PgQueryable;
  /**
   * Human-readable prefix naming the owning context, e.g.
   * `"Catalog integration bootstrap"` or `"Inventory seed bootstrap"`.
   */
  bootstrapLabel: string;
  aggregateName: string;
  streamId: string;
  createdEventType: Event["type"];
  createdIdField: string;
  /**
   * Payload field carrying the aggregate's logical key on its created event.
   * Defaults to `"key"`. Pass `null` to skip the cross-stream key scan for
   * aggregates whose created payload carries no key distinct from their id.
   */
  createdKeyField?: string | null;
  expectedId: string;
  expectedKey: string;
  /** Narrows the cross-stream key scan to one payload scope, e.g. a type key. */
  keyScope?: Readonly<{ field: string; value: string }>;
  initialState: State;
  evolve: AggregateEvolver<State, Event>;
  identity: (state: State) => SeedAggregateIdentity;
  /**
   * Derives the aggregate's seed-relevant status. Multi-command seed stages
   * receive the folded stream as well, so a stage whose completion is not
   * visible in the aggregate's own state (a follow-up command that leaves no
   * distinguishing state) still reports `draft` rather than being mistaken for
   * complete.
   */
  status: (state: State, events: readonly Event[]) => string;
  /** Statuses meaning "fully authored"; the aggregate resolves to `active`. */
  completedStatuses: readonly string[];
  /** Statuses that must fail closed rather than be resumed or re-authored. */
  terminalStatuses?: readonly string[];
  /**
   * Statuses that resolve to `draft`. When supplied, any status outside
   * `completedStatuses`, `terminalStatuses`, and this list fails closed rather
   * than being silently treated as resumable.
   */
  resumableStatuses?: readonly string[];
  validateIdentity?: (state: State) => void;
}>;

type StoredSeedEventRow = Readonly<{
  stream_id: string;
  stream_version: string | number;
  event_type: string;
  payload: Record<string, unknown>;
}>;

export async function loadSeedAggregateState<State, Event extends DomainEvent>(
  input: SeedAggregateStateInput<State, Event>,
): Promise<SeedAggregateState<State, Event>> {
  const createdKeyField = input.createdKeyField === undefined ? "key" : input.createdKeyField;
  const stored = await input.db.query<StoredSeedEventRow>(
    `SELECT stream_id, stream_version, event_type, payload
     FROM event_store_events
     WHERE stream_id = $1
        OR (
          $2::text IS NOT NULL
          AND event_type = $3
          AND payload->>$2 = $4
          AND ($5::text IS NULL OR payload->>$5 = $6)
        )
     ORDER BY stream_id, stream_version`,
    [
      input.streamId,
      createdKeyField,
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
      key: createdKeyField === null ? null : stringValue(conflictingCreated.payload[createdKeyField]),
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
  const identity = input.identity(state);

  if (identity.id === null) {
    if (events.length > 0) {
      throw new Error(
        `${input.bootstrapLabel} ${input.aggregateName} '${input.expectedKey}' has events but folds to no aggregate id.` +
          streamSuffix(input.streamId),
      );
    }
    return { kind: "absent", status: null, state, events };
  }

  if (String(identity.id) !== input.expectedId || identity.key !== input.expectedKey) {
    throw identityConflictError(input, { id: String(identity.id), key: identity.key });
  }
  input.validateIdentity?.(state);

  const status = input.status(state, events);

  if (input.terminalStatuses?.includes(status)) {
    throw new Error(
      `${input.bootstrapLabel} ${input.aggregateName} '${input.expectedKey}' expected status ` +
        `'${input.completedStatuses.join("' or '")}', but found terminal status '${status}'.` +
        streamSuffix(input.streamId),
    );
  }
  if (input.completedStatuses.includes(status)) {
    return { kind: "active", status, state, events };
  }
  if (!input.resumableStatuses || input.resumableStatuses.includes(status)) {
    return { kind: "draft", status, state, events };
  }

  throw new Error(
    `${input.bootstrapLabel} ${input.aggregateName} '${input.expectedKey}' expected status ` +
      `'${[...input.resumableStatuses, ...input.completedStatuses].join("' or '")}', but found '${status}'.` +
      streamSuffix(input.streamId),
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

/**
 * Counts the events already committed to each of `streamIds`. Seeds use this
 * for set-shaped decisions (many sibling aggregates authored in one stage) so a
 * partially authored set resumes per row instead of collapsing into a single
 * all-or-nothing verdict.
 */
export async function countSeedStreamEvents(
  db: PgQueryable,
  streamIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (streamIds.length === 0) {
    return new Map();
  }
  const result = await db.query<Readonly<{ stream_id: string; count: string }>>(
    `SELECT stream_id, COUNT(*) AS count
     FROM event_store_events
     WHERE stream_id = ANY($1::text[])
     GROUP BY stream_id`,
    [[...streamIds]],
  );
  const counted = new Map(result.rows.map((row) => [row.stream_id, Number(row.count)]));
  return new Map(streamIds.map((streamId) => [streamId, counted.get(streamId) ?? 0]));
}

export type SeedAggregateStepPlanInput<State, Command, Event extends DomainEvent> = Readonly<{
  /** Human-readable prefix naming the owning context. */
  bootstrapLabel: string;
  aggregateName: string;
  /** Stable label for this aggregate in error messages. */
  aggregateKey: string;
  streamId: string;
  initialState: State;
  decide: AggregateDecider<State, Command, Event>;
  evolve: AggregateEvolver<State, Event>;
  /** Events already committed to `streamId`, oldest first. */
  committed: readonly Event[];
  /** The full ordered command sequence this seed authors for the aggregate. */
  steps: readonly Command[];
}>;

export type SeedAggregateStepPlan<State, Command> = Readonly<{
  kind: SeedAggregateStateKind;
  /** Steps whose events are already committed. */
  appliedSteps: number;
  /** Steps still to send, in order. */
  pending: readonly Command[];
  /** State after replaying the committed events for the applied steps. */
  state: State;
}>;

/**
 * Resolves how much of a seed's ordered command sequence is already committed
 * to the aggregate's authoritative stream, so the remainder can be resumed
 * without re-authoring what exists.
 *
 * The expected event shape of each step is derived from the context's own
 * decider rather than a hand-maintained event-type list, so a seed and its
 * resumption plan cannot drift apart. Steps are matched positionally: a
 * committed stream that diverges from what the seed would have authored fails
 * closed naming the context, aggregate, stream, and step, instead of guessing.
 * Trailing events beyond the plan (ordinary runtime activity on a seeded
 * aggregate) leave the plan complete and append nothing.
 */
export function planSeedAggregateSteps<State, Command, Event extends DomainEvent>(
  input: SeedAggregateStepPlanInput<State, Command, Event>,
): SeedAggregateStepPlan<State, Command> {
  let state = input.initialState;
  let cursor = 0;

  let appliedSteps = 0;

  for (const [stepIndex, command] of input.steps.entries()) {
    const produced = input.decide(state, command);
    if (produced.length === 0) {
      // The command is already satisfied by the folded state and would append
      // nothing. Treat it as applied rather than leaving it pending forever.
      appliedSteps += 1;
      continue;
    }

    if (cursor >= input.committed.length) {
      return {
        kind: cursor === 0 ? "absent" : "draft",
        appliedSteps,
        pending: input.steps.slice(stepIndex),
        state,
      };
    }

    for (const [offset, event] of produced.entries()) {
      const committedEvent = input.committed[cursor + offset];
      if (!committedEvent || committedEvent.type !== event.type) {
        throw new Error(
          `${input.bootstrapLabel} ${input.aggregateName} '${input.aggregateKey}' cannot resume: step ` +
            `${stepIndex + 1} expected committed event '${event.type}' at stream position ` +
            `${cursor + offset + 1}, but found '${committedEvent?.type ?? "end of stream"}'.` +
            streamSuffix(input.streamId),
        );
      }
    }

    state = input.committed.slice(cursor, cursor + produced.length).reduce(input.evolve, state);
    cursor += produced.length;
    appliedSteps += 1;
  }

  return { kind: "active", appliedSteps, pending: [], state };
}

export type SeedAggregateReconciler = Readonly<{
  contextName: string;
  aggregateName: string;
  id: string;
  key: string;
  streamId: string;
  /**
   * Folds the authoritative stream and reports the aggregate's seed state.
   * When `apply` is true, also sends the steps the stream does not yet carry.
   */
  reconcile: (apply: boolean) => Promise<BcSeedAggregateStateReport>;
}>;

export type SeedAggregateReconcilerInput<State, Command, Event extends DomainEvent> = Readonly<{
  db: PgQueryable;
  contextName: string;
  bootstrapLabel: string;
  aggregateName: string;
  id: string;
  key: string;
  streamId: string;
  initialState: State;
  decide: AggregateDecider<State, Command, Event>;
  evolve: AggregateEvolver<State, Event>;
  steps: readonly Command[];
  send: (streamId: string, command: Command) => Promise<unknown>;
}>;

/**
 * Binds one seeded aggregate's ordered command sequence to its authoritative
 * stream. Seeding and state inspection run the same plan, so a context cannot
 * report a state its seed would not act on.
 */
export function createSeedAggregateReconciler<State, Command, Event extends DomainEvent>(
  input: SeedAggregateReconcilerInput<State, Command, Event>,
): SeedAggregateReconciler {
  return {
    contextName: input.contextName,
    aggregateName: input.aggregateName,
    id: input.id,
    key: input.key,
    streamId: input.streamId,
    reconcile: async (apply: boolean) => {
      const committed = await loadSeedStreamEvents<Event>(input.db, input.streamId);
      const plan = planSeedAggregateSteps<State, Command, Event>({
        bootstrapLabel: input.bootstrapLabel,
        aggregateName: input.aggregateName,
        aggregateKey: input.key,
        streamId: input.streamId,
        initialState: input.initialState,
        decide: input.decide,
        evolve: input.evolve,
        committed,
        steps: input.steps,
      });

      if (apply) {
        for (const command of plan.pending) {
          await input.send(input.streamId, command);
        }
      }

      return {
        contextName: input.contextName,
        aggregateName: input.aggregateName,
        id: input.id,
        key: input.key,
        streamId: input.streamId,
        kind: plan.kind,
        status: `${plan.appliedSteps}/${input.steps.length} steps`,
        eventCount: committed.length,
      };
    },
  };
}

/** Reconciles every runner in order, returning one report per aggregate. */
export async function reconcileSeedAggregates(
  reconcilers: readonly SeedAggregateReconciler[],
  apply: boolean,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const reports: BcSeedAggregateStateReport[] = [];
  for (const reconciler of reconcilers) {
    reports.push(await reconciler.reconcile(apply));
  }
  return reports;
}

function identityConflictError<State, Event extends DomainEvent>(
  input: Pick<
    SeedAggregateStateInput<State, Event>,
    "bootstrapLabel" | "aggregateName" | "expectedId" | "expectedKey" | "streamId"
  >,
  found: SeedAggregateIdentity,
): Error {
  return new Error(
    `${input.bootstrapLabel} ${input.aggregateName} '${input.expectedKey}' expected id '${input.expectedId}' ` +
      `and key '${input.expectedKey}', but found id '${found.id ?? "null"}' and key '${found.key ?? "null"}'.` +
      streamSuffix(input.streamId),
  );
}

function streamSuffix(streamId: string): string {
  return ` Stream '${streamId}'.`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
