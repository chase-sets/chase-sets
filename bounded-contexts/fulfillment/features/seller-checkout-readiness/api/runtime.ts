import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OperatorAuthority, ResolvedActor } from "@chase-sets/auth-context";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, withPgTransaction, type PgQueryable, type PgTransactionalPool, type PostgresEventStore } from "@chase-sets/event-core-postgres";
import { parseIsoUtcTimestamp, type IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { createId, type AccountId, type EventId } from "@chase-sets/primitives/typed-ids";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { SellerCheckoutReadinessKey, SellerCheckoutReadinessOwner, SellerCheckoutReadinessReader } from "../domain/contract";
import { closedObject, parseLabelPreference, parseShippingOwner, parseShippingSetup, parseShippingState, sameShippingOrigin, sellerShippingLaunchPolicyId, SellerShippingError, shippingId, shippingOwnerKey, type SellerShippingState, type SellerShippingSupport } from "../domain/shipping-setup";
import { readSellerCheckoutReadiness, type SellerCheckoutReadinessFacts } from "../read-model/queries";

export type SellerShippingRecordedState = Readonly<{ state: SellerShippingState; recordedAt: IsoUtcTimestamp }>;
export type SellerShippingSetupResult = Readonly<{
  setup: SellerShippingState["setup"];
  revision: number | null;
  recordedAt: IsoUtcTimestamp | null;
  supportStatus: "enabled" | "missing" | "revoked" | "invalidated";
}>;
export type SellerShippingOriginResolution = Readonly<
  | { status: "accepted"; key: SellerCheckoutReadinessKey; sourceRevision: number; sourceTimestamp: IsoUtcTimestamp }
  | { status: "blocked"; fact: "missing" | "conflicting" | "stale" | "unavailable" }
>;

const eventTypes = ["fulfillment.seller-shipping.setup-recorded.v1", "fulfillment.seller-shipping.support-recorded.v1", "fulfillment.seller-shipping.anonymous-invalidated.v1"];
const streamFor = (owner: SellerCheckoutReadinessOwner) => `fulfillment.seller-shipping-${shippingOwnerKey(owner)}`;

function decodeRevision(value: unknown): number {
  const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new SellerShippingError("source-unavailable");
  return number;
}

type StateRow = { current_version: unknown; stream_version: unknown; recorded_at: unknown; event_type: unknown; payload: unknown };

export function decodeSellerShippingRow(row: StateRow, owner: SellerCheckoutReadinessOwner): SellerShippingRecordedState {
  try {
    const payload = closedObject(row.payload, ["state", "operation", "audit"]);
    const state = parseShippingState(payload.state);
    const revision = decodeRevision(row.current_version);
    if (revision !== decodeRevision(row.stream_version) || state.revision !== revision || shippingOwnerKey(state.owner) !== shippingOwnerKey(owner) || !eventTypes.includes(row.event_type as string)) throw new SellerShippingError("source-unavailable");
    const time = row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at;
    if (typeof time !== "string") throw new SellerShippingError("source-unavailable");
    return { state, recordedAt: parseIsoUtcTimestamp(time) };
  } catch {
    throw new SellerShippingError("source-unavailable");
  }
}

export async function loadSellerShippingState(db: PgQueryable, owner: SellerCheckoutReadinessOwner): Promise<SellerShippingRecordedState | null> {
  const result = await db.query<StateRow>(
    `SELECT s.current_version, e.stream_version, e.recorded_at, e.event_type, e.payload
     FROM event_store_streams s LEFT JOIN event_store_events e
       ON e.stream_id = s.stream_id AND e.stream_version = s.current_version
     WHERE s.stream_id = $1`, [streamFor(owner)],
  );
  if (!result.rows.length) return null;
  if (result.rows.length !== 1) throw new SellerShippingError("source-unavailable");
  return decodeSellerShippingRow(result.rows[0]!, owner);
}

function setupResult(record: SellerShippingRecordedState | null): SellerShippingSetupResult {
  const state = record?.state;
  return {
    setup: state?.mergedIntoAccountId ? null : state?.setup ?? null,
    revision: state?.revision ?? null,
    recordedAt: record?.recordedAt ?? null,
    supportStatus: state?.mergedIntoAccountId ? "invalidated" : !state?.setup || !state.support ? "missing" : state.support[state.setup.labelPreference],
  };
}

export function createSellerShippingSetupServices(options: Readonly<{
  pool: PgTransactionalPool;
  eventStore?: PostgresEventStore;
  operatorAuthority?: OperatorAuthority;
}>) {
  const { pool, operatorAuthority } = options;
  const eventStore = options.eventStore ?? createPostgresEventStore({ pool });

  async function mutate(owner: SellerCheckoutReadinessOwner, operation: JsonObject, context: EventStoreContext, change: (current: SellerShippingState) => Readonly<{ state: SellerShippingState; audit: JsonObject | null; eventType: string }> | null, operationId?: string): Promise<SellerShippingRecordedState> {
    const validOwner = parseShippingOwner(owner);
    const receiptId = operationId ? `evt_${createHash("sha256").update(`seller-shipping-support:${operationId}`).digest("hex")}` as EventId : undefined;
    const result = await withPgTransaction(pool, async (client) => {
      if (receiptId) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [receiptId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [streamFor(validOwner)]);
      if (receiptId) {
        const receipt = await client.query<{ stream_id: string; payload: unknown; recorded_at: Date | string; stream_version: string | number; event_type: string }>("SELECT stream_id, payload, recorded_at, stream_version, event_type FROM event_store_events WHERE event_id = $1", [receiptId]);
        if (receipt.rows.length) {
          const row = receipt.rows[0]!;
          const envelope = closedObject(row.payload, ["state", "operation", "audit"]);
          if (row.stream_id !== streamFor(validOwner) || !isDeepStrictEqual(envelope.operation, operation)) throw new SellerShippingError("conflicting-operation");
          return { record: decodeSellerShippingRow({ ...row, current_version: row.stream_version }, validOwner), events: [] };
        }
      }
      const previous = await loadSellerShippingState(client, validOwner);
      const current: SellerShippingState = previous?.state ?? { owner: validOwner, revision: 0, setup: null, support: null, mergedIntoAccountId: null };
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new SellerShippingError("source-unavailable");
      const next = change(current);
      if (!next) {
        if (!previous) throw new SellerShippingError("source-unavailable");
        return { record: previous, events: [] };
      }
      const state = parseShippingState({ ...next.state, revision: current.revision + 1 });
      const events = await eventStore.appendToStreamInTransaction(client, {
        streamId: streamFor(validOwner), expectedVersion: current.revision === 0 ? "no_stream" : current.revision,
        context, events: [{ ...(receiptId ? { eventId: receiptId } : {}), eventType: next.eventType, payload: { state, operation, audit: next.audit } as JsonObject }],
      });
      if (events.length !== 1 || events[0]!.streamVersion !== state.revision) throw new SellerShippingError("source-unavailable");
      return { record: { state, recordedAt: events[0]!.recordedAt }, events };
    });
    recordCommittedEvents(result.events);
    return result.record;
  }

  const readReadiness: SellerCheckoutReadinessReader = async (key) => {
    try {
      closedObject(key, ["owner", "shipFromLocationId", "labelPreference"]);
      parseShippingOwner(key.owner);
      shippingId(key.shipFromLocationId, "sfl");
      parseLabelPreference(key.labelPreference);
    } catch {
      return { schemaVersion: "fulfillment.seller-checkout-readiness.v1", label: { status: "blocked", reason: "label-not-ready", fact: "unavailable" }, provider: { status: "blocked", reason: "provider-not-ready", fact: "unavailable" }, sourceRevision: null, sourceTimestamp: null };
    }
    return readSellerCheckoutReadiness(async (validKey) => {
    const record = await loadSellerShippingState(pool, validKey.owner);
    if (!record || !record.state.setup) return null;
    const { state, recordedAt } = record;
    const setup = state.setup!;
    if (setup.shipFromLocationId !== validKey.shipFromLocationId) return null;
    const preference = setup.labelPreference;
    const facts = state.support ? [{ labelPreference: preference, availability: state.support[preference] === "enabled" ? "available" as const : "unavailable" as const, revision: state.revision }] : [];
    return { owner: state.owner, shipFromLocationId: setup.shipFromLocationId, revision: state.revision, recordedAt, mergedIntoAccountId: state.mergedIntoAccountId, labelPreferences: facts, providerRoutes: facts } satisfies SellerCheckoutReadinessFacts;
    }, key);
  };

  return {
    readReadiness,
    async readSetup(owner: SellerCheckoutReadinessOwner): Promise<SellerShippingSetupResult> {
      return setupResult(await loadSellerShippingState(pool, parseShippingOwner(owner)));
    },
    async saveSetup(owner: SellerCheckoutReadinessOwner, input: unknown, context: EventStoreContext): Promise<SellerShippingSetupResult> {
      const setup = parseShippingSetup(input);
      const record = await mutate(owner, { kind: "setup", setup }, context, (current) => {
        if (current.mergedIntoAccountId !== null) throw new SellerShippingError("invalidated");
        if (current.setup && sameShippingOrigin(current.setup.origin, setup.origin) && current.setup.labelPreference === setup.labelPreference) return null;
        return { state: { ...current, setup: { ...setup, shipFromLocationId: createId("sfl") } }, audit: null, eventType: eventTypes[0]! };
      });
      return setupResult(record);
    },
    async changeSupport(actor: ResolvedActor | null, input: unknown, context: EventStoreContext): Promise<Readonly<{ support: SellerShippingSupport; revision: number; recordedAt: IsoUtcTimestamp }>> {
      if (!actor) throw new SellerShippingError("forbidden");
      let decision;
      try { decision = await operatorAuthority?.(actor); } catch { throw new SellerShippingError("authority-unavailable"); }
      if (!decision) throw new SellerShippingError("authority-unavailable");
      if (decision.kind !== "granted" || decision.roleKey !== "platform-admin" || decision.membershipId !== actor.membershipId) throw new SellerShippingError("forbidden");
      shippingId(actor.userId, "usr");
      const body = closedObject(input, ["owner", "action", "labelPreference", "reason", "operationId"]);
      const owner = parseShippingOwner(body.owner);
      const action = body.action;
      if (action !== "initialize" && action !== "enable" && action !== "revoke") throw new SellerShippingError("invalid-input");
      const preference = action === "initialize" ? null : parseLabelPreference(body.labelPreference);
      if (action === "initialize" && body.labelPreference !== undefined) throw new SellerShippingError("invalid-input");
      if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500 || typeof body.operationId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(body.operationId)) throw new SellerShippingError("invalid-input");
      const operation = { kind: "support", owner, action, labelPreference: preference, reason: body.reason.trim(), operationId: body.operationId, userId: actor.userId, membershipId: decision.membershipId } satisfies JsonObject;
      const record = await mutate(owner, operation, context, (current) => {
        if (current.mergedIntoAccountId !== null) throw new SellerShippingError("invalidated");
        let support: SellerShippingSupport;
        if (action === "initialize") {
          if (current.support !== null) throw new SellerShippingError("conflicting-operation");
          support = { launchPolicyId: sellerShippingLaunchPolicyId, "prepaid-label": "enabled", "seller-label-later": "enabled" };
        } else {
          if (!current.support || !preference) throw new SellerShippingError("support-not-initialized");
          support = { ...current.support, [preference]: action === "enable" ? "enabled" : "revoked" };
        }
        return { state: { ...current, support }, audit: { userId: actor.userId, membershipId: decision.membershipId, owner, before: current.support, after: support, reason: operation.reason, operationId: operation.operationId, revision: current.revision + 1 }, eventType: eventTypes[1]! };
      }, body.operationId);
      return { support: record.state.support!, revision: record.state.revision, recordedAt: record.recordedAt };
    },
    async resolveOrigin(owner: SellerCheckoutReadinessOwner, input: unknown): Promise<SellerShippingOriginResolution> {
      try {
        const selected = parseShippingSetup(input);
        const record = await loadSellerShippingState(pool, parseShippingOwner(owner));
        if (!record?.state.setup) return { status: "blocked", fact: "missing" };
        if (record.state.mergedIntoAccountId !== null) return { status: "blocked", fact: "stale" };
        const setup = record.state.setup;
        if (!sameShippingOrigin(setup.origin, selected.origin) || setup.labelPreference !== selected.labelPreference) return { status: "blocked", fact: "conflicting" };
        return { status: "accepted", key: { owner: record.state.owner, shipFromLocationId: setup.shipFromLocationId, labelPreference: setup.labelPreference }, sourceRevision: record.state.revision, sourceTimestamp: record.recordedAt };
      } catch (error) {
        return { status: "blocked", fact: error instanceof SellerShippingError && error.code === "invalid-input" ? "conflicting" : "unavailable" };
      }
    },
    async invalidateAnonymousOwner(input: Readonly<{ owner: SellerCheckoutReadinessOwner; targetAccountId: AccountId }>, context: EventStoreContext): Promise<Readonly<{ revision: number; recordedAt: IsoUtcTimestamp }>> {
      const owner = parseShippingOwner(input.owner);
      if (owner.kind !== "anonymous") throw new SellerShippingError("invalid-input");
      const targetAccountId = shippingId(input.targetAccountId, "acc") as AccountId;
      const record = await mutate(owner, { kind: "invalidate", targetAccountId }, context, (current) => {
        if (current.mergedIntoAccountId !== null) {
          if (current.mergedIntoAccountId !== targetAccountId) throw new SellerShippingError("conflicting-operation");
          return null;
        }
        return { state: { ...current, mergedIntoAccountId: targetAccountId }, audit: null, eventType: eventTypes[2]! };
      });
      return { revision: record.state.revision, recordedAt: record.recordedAt };
    },
  };
}

export type SellerShippingSetupServices = ReturnType<typeof createSellerShippingSetupServices>;

export function createSellerCheckoutReadinessReader(pool: PgTransactionalPool): SellerCheckoutReadinessReader {
  return createSellerShippingSetupServices({ pool }).readReadiness;
}
