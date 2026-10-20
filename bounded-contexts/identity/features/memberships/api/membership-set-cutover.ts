import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  compareGlobalPosition,
  parseGlobalPosition,
  type AppendToStreamInput,
  type EventStoreContext,
  type GlobalPosition,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { readGapSafeEventStoreHead, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  foldMembershipSet,
  MEMBERSHIP_SET_PREFIX,
  MEMBERSHIP_SOURCE_PREFIX,
  membershipFacts,
  membershipSetUnknown,
  planMembershipSetAppends,
  readUserMembershipSet,
  type MembershipHistoryReader,
  type MembershipSetFact,
} from "./membership-set";

const CUTOVER_STREAM = "identity.user-membership-set-cutover";
const CHECKPOINT_EVENT = "identity.user-membership-set-cutover.checkpointed";
const WRITER_VERSION = 1;
const SCAN_BOUND = 1_000_000;
type Checkpoint = Readonly<{
  phase: "importing" | "verified";
  firstThrough: GlobalPosition;
  afterPosition: GlobalPosition;
  verifiedThrough: GlobalPosition | null;
  writerVersion: number;
}>;

export function membershipHistoryReader(
  db: PgQueryable,
  store: Pick<EventStore, "readStream">,
): MembershipHistoryReader {
  return {
    readStream: (input) => store.readStream(input),
    readVersion: async (streamId) => {
      const result = await db.query<{ current_version: number }>(
        "SELECT current_version FROM event_store_streams WHERE stream_id = $1",
        [streamId],
      );
      return Number(result.rows[0]?.current_version ?? 0);
    },
  };
}

function checkpointHistory(history: readonly StoredEvent[]): Checkpoint | null {
  let previous: Checkpoint | null = null;
  for (const [index, event] of history.entries()) {
    const p = event.payload;
    if (
      event.streamId !== CUTOVER_STREAM ||
      event.streamVersion !== index + 1 ||
      event.eventType !== CHECKPOINT_EVENT ||
      Object.keys(p).sort().join("|") !== "afterPosition|firstThrough|phase|verifiedThrough|writerVersion" ||
      p.writerVersion !== WRITER_VERSION ||
      (p.phase !== "importing" && p.phase !== "verified") ||
      typeof p.firstThrough !== "string" ||
      typeof p.afterPosition !== "string" ||
      (p.verifiedThrough !== null && typeof p.verifiedThrough !== "string")
    )
      membershipSetUnknown("invalid cutover history");
    const firstThrough = parseGlobalPosition(String(p.firstThrough));
    const afterPosition = parseGlobalPosition(String(p.afterPosition));
    const verifiedThrough = p.verifiedThrough === null ? null : parseGlobalPosition(String(p.verifiedThrough));
    if (
      compareGlobalPosition(afterPosition, firstThrough) > 0 ||
      (p.phase === "verified"
        ? verifiedThrough === null || compareGlobalPosition(verifiedThrough, firstThrough) < 0
        : verifiedThrough !== null)
    )
      membershipSetUnknown("invalid cutover horizon");
    if (
      previous &&
      (firstThrough !== previous.firstThrough ||
        compareGlobalPosition(afterPosition, previous.afterPosition) < 0 ||
        (previous.phase === "verified" && p.phase !== "verified") ||
        (previous.verifiedThrough &&
          verifiedThrough &&
          compareGlobalPosition(verifiedThrough, previous.verifiedThrough) < 0))
    )
      membershipSetUnknown("cutover checkpoint regression");
    previous = { phase: p.phase, firstThrough, afterPosition, verifiedThrough, writerVersion: WRITER_VERSION };
  }
  return previous;
}

async function expectedCount(db: PgQueryable, after: GlobalPosition, through: GlobalPosition, includeSets: boolean) {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM event_store_events
     WHERE global_position > $1::bigint AND global_position <= $2::bigint
       AND (left(stream_id, length($3)) = $3 OR ($5::boolean AND left(stream_id, length($4)) = $4))`,
    [after, through, MEMBERSHIP_SOURCE_PREFIX, MEMBERSHIP_SET_PREFIX, includeSets],
  );
  return BigInt(result.rows[0]?.count ?? membershipSetUnknown("missing independent scan count"));
}

async function scan(
  db: PgQueryable,
  store: EventStore,
  after: GlobalPosition,
  through: GlobalPosition,
  includeSets: boolean,
  page: (events: readonly StoredEvent[], cursor: GlobalPosition) => Promise<void>,
) {
  const expected = await expectedCount(db, after, through, includeSets);
  if (expected > BigInt(SCAN_BOUND)) membershipSetUnknown("global scan bound exceeded");
  let cursor = after;
  let scanned = 0;
  for (;;) {
    const events = await store.readAll({
      afterGlobalPosition: cursor,
      atOrBeforeGlobalPosition: through,
      streamPrefixes: includeSets ? [MEMBERSHIP_SOURCE_PREFIX, MEMBERSHIP_SET_PREFIX] : [MEMBERSHIP_SOURCE_PREFIX],
      limit: 500,
    });
    if (events.length > 500) membershipSetUnknown("oversized global page");
    for (const event of events) {
      if (
        compareGlobalPosition(event.globalPosition, cursor) <= 0 ||
        compareGlobalPosition(event.globalPosition, through) > 0 ||
        (!event.streamId.startsWith(MEMBERSHIP_SOURCE_PREFIX) &&
          !(includeSets && event.streamId.startsWith(MEMBERSHIP_SET_PREFIX)))
      )
        membershipSetUnknown("global scan identity or cursor mismatch");
      cursor = event.globalPosition;
      scanned++;
      if (scanned > SCAN_BOUND) membershipSetUnknown("global scan bound exceeded");
    }
    if (events.length) await page(events, cursor);
    if (events.length < 500) break;
  }
  if (BigInt(scanned) !== expected) membershipSetUnknown("global scan count mismatch");
  return { scanned, total: expected.toString() };
}

async function reconcileThroughPosition(db: PgQueryable, store: EventStore, through: GlobalPosition) {
  const streams = new Map<string, StoredEvent[]>();
  const partition = await scan(db, store, parseGlobalPosition("0"), through, true, async (events) => {
    for (const event of events) {
      const history = streams.get(event.streamId) ?? [];
      history.push(event);
      streams.set(event.streamId, history);
    }
  });
  const source = new Map<string, MembershipSetFact>();
  const recorded = new Map<string, MembershipSetFact>();
  const key = (tenantId: string, fact: MembershipSetFact) => `${tenantId}:${fact.membershipId}:${fact.sourceRevision}`;
  for (const [streamId, history] of streams) {
    const tenant = history[0].tenantId;
    const facts = streamId.startsWith(MEMBERSHIP_SOURCE_PREFIX)
      ? membershipFacts(history, streamId, tenant)
      : foldMembershipSet(history, streamId.slice("identity.user-membership-set-".length), tenant).facts;
    const target = streamId.startsWith(MEMBERSHIP_SOURCE_PREFIX) ? source : recorded;
    for (const fact of facts) {
      if (target.has(key(tenant, fact))) membershipSetUnknown("duplicate source-to-Set revision");
      target.set(key(tenant, fact), fact);
    }
  }
  if (source.size !== recorded.size) membershipSetUnknown("source-to-Set census mismatch");
  for (const [id, fact] of source) {
    if (JSON.stringify(fact) !== JSON.stringify(recorded.get(id))) membershipSetUnknown("source-to-Set fact mismatch");
  }
  return { ...partition, sourceRevisions: source.size };
}

export function createMembershipSetRuntime(pool: PgTransactionalPool, store: EventStore) {
  const reader = membershipHistoryReader(pool, store);
  async function loadCheckpoint() {
    const history = await readCompleteStream(reader, { streamId: CUTOVER_STREAM, maxEvents: 100_000 });
    if (history.length !== (await reader.readVersion(CUTOVER_STREAM)))
      membershipSetUnknown("truncated checkpoint history");
    return { checkpoint: checkpointHistory(history), version: history.length };
  }

  async function reconcile(context: EventStoreContext) {
    if (!store.appendToStreams) membershipSetUnknown("atomic append unavailable");
    let { checkpoint, version } = await loadCheckpoint();
    async function save(next: Checkpoint) {
      await store.appendToStream({
        streamId: CUTOVER_STREAM,
        expectedVersion: version,
        context,
        events: [{ eventType: CHECKPOINT_EVENT, payload: { ...next } }],
      });
      checkpoint = next;
      version++;
    }
    if (!checkpoint)
      await save({
        phase: "importing",
        firstThrough: await readGapSafeEventStoreHead(pool),
        afterPosition: parseGlobalPosition("0"),
        verifiedThrough: null,
        writerVersion: WRITER_VERSION,
      });
    const retained = checkpoint!;
    if (retained.phase === "verified") {
      const through = await readGapSafeEventStoreHead(pool);
      if ((await expectedCount(pool, retained.verifiedThrough!, through, true)) === 0n)
        return {
          status: "authoritative" as const,
          throughPosition: retained.verifiedThrough!,
          writerVersion: WRITER_VERSION,
          scanned: 0,
          total: "0",
          sourceRevisions: 0,
        };
    }
    if (retained.phase === "importing") {
      await scan(pool, store, retained.afterPosition, retained.firstThrough, false, async (events, cursor) => {
        const inputs: AppendToStreamInput[] = [];
        for (const streamId of new Set(events.map((event) => event.streamId))) {
          const sourceVersion = await reader.readVersion(streamId);
          const creation = await store.readStream({ streamId, fromVersion: 1, limit: 1 });
          if (!creation[0]) membershipSetUnknown("missing source creation during import");
          const sourceContext = { ...context, tenantId: creation[0].tenantId };
          inputs.push({ streamId, expectedVersion: sourceVersion, context: sourceContext, events: [] });
        }
        const expanded = await planMembershipSetAppends(reader, inputs, { reconcile: true });
        await store.appendToStreams!(expanded);
        await save({ ...retained, afterPosition: cursor });
      });
    }
    const through = await readGapSafeEventStoreHead(pool);
    const partition = await reconcileThroughPosition(pool, store, through);
    await save({ ...checkpoint!, phase: "verified", verifiedThrough: through });
    return { status: "authoritative" as const, throughPosition: through, writerVersion: WRITER_VERSION, ...partition };
  }

  async function authority(userId: string, tenantId: string) {
    try {
      const { checkpoint } = await loadCheckpoint();
      if (checkpoint?.phase !== "verified")
        return { status: "blocked-unknown" as const, reason: "cutover-not-verified" };
      const set = await readUserMembershipSet(reader, userId, tenantId);
      for (const membership of set.memberships) {
        const streamId = `${MEMBERSHIP_SOURCE_PREFIX}${membership.membershipId}`;
        const history = await readCompleteStream(reader, { streamId, maxEvents: 100_000 });
        if ((await reader.readVersion(streamId)) !== history.length)
          membershipSetUnknown("truncated authority source history");
        const source = membershipFacts(history, streamId, tenantId);
        const recorded = set.facts.filter((fact) => fact.membershipId === membership.membershipId);
        if (JSON.stringify(source) !== JSON.stringify(recorded))
          membershipSetUnknown("authority source-to-Set mismatch");
      }
      if ((await reader.readVersion(`identity.user-membership-set-${userId}`)) !== set.version)
        membershipSetUnknown("authority Set changed during read");
      return {
        status: "authoritative" as const,
        revision: set.version,
        memberships: set.memberships,
        throughPosition: checkpoint.verifiedThrough!,
      };
    } catch {
      return { status: "blocked-unknown" as const, reason: "invalid-or-incomplete-history" };
    }
  }
  return { reconcile, authority };
}
