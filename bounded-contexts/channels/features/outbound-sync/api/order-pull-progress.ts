import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { readAcceptedReadyToShipMembership } from "../../order-fulfillment-observations/api/runtime";
import { OutboundSyncError } from "../domain/contracts";
import type { OrderPullPayload, ClaimedOrderPullOutcome } from "../domain/order-pull";
import {
  advanceOrderPullTraversal,
  assertOrderPullChunk,
  assertOrderPullWork,
  orderPullProgressKind,
  type OrderPullCheckpoint,
  type OrderPullWork,
} from "../domain/order-pull-progress";

type Chunk = {
  chunk_id: number | string;
  remaining_references: readonly string[];
  posted_references: readonly string[];
  revision: number | string;
};

export async function readOrderPullWork(
  db: PgQueryable,
  connectionId: string,
  burstId: string,
): Promise<OrderPullWork> {
  const result = await db.query<Chunk>(
    `SELECT chunk_id, remaining_references, posted_references, revision FROM channel_order_pull_chunks
     WHERE connection_id=$1 AND burst_id=$2 AND remaining_references <> '[]'::jsonb
     ORDER BY (NOT posted_references @> remaining_references) DESC, chunk_id LIMIT 1`,
    [connectionId, burstId],
  );
  const chunk = result.rows[0];
  if (!chunk) return { chunkId: null, references: [], postedReferences: [], acceptedReferences: [] };
  const references = chunk.remaining_references;
  assertOrderPullChunk(connectionId, references);
  const work = {
    chunkId: Number(chunk.chunk_id),
    references,
    postedReferences: chunk.posted_references,
    acceptedReferences: await readAcceptedReadyToShipMembership(db, { connectionId, orderReferences: references }),
  };
  assertOrderPullWork(work, connectionId);
  return work;
}

/** Called only inside the existing settlement transaction after its attempt/generation fence. */
export async function commitOrderPullProgress(
  db: PgQueryable,
  payload: OrderPullPayload,
  outcome: Exclude<ClaimedOrderPullOutcome["outcome"], { kind: "order-pull-unknown" | "abandoned" }>,
): Promise<Readonly<{ checkpoint: OrderPullCheckpoint; kind: ReturnType<typeof orderPullProgressKind> }>> {
  const { connectionId, checkpoint } = payload;
  const progress = outcome.progress;
  let traversal = checkpoint.traversal;
  const chunks = new Set<number>();
  if (payload.work.chunkId !== null) chunks.add(payload.work.chunkId);
  const allowed = new Set(payload.work.references);
  for (const page of progress.pages) {
    assertOrderPullChunk(connectionId, page.orderReferences);
    traversal = advanceOrderPullTraversal(payload.selector, traversal, page);
    const duplicate = await db.query(
      `SELECT chunk_id FROM channel_order_pull_chunks
       WHERE connection_id=$1 AND burst_id=$2 AND
         (cursor=$3 OR original_references ?| $4::text[]) LIMIT 1`,
      [connectionId, checkpoint.burstId, page.cursor ?? "", page.orderReferences],
    );
    if (duplicate.rows.length)
      throw new OutboundSyncError("invalid-input", "Traversal repeated a cursor or reference.");
    await db.query(
      `INSERT INTO channel_order_pull_chunks
       (connection_id, burst_id, chunk_id, cursor, original_references, remaining_references, posted_references, revision)
       VALUES ($1,$2,$3,$4,$5::jsonb,$5::jsonb,'[]'::jsonb,1)`,
      [connectionId, checkpoint.burstId, traversal.pages, page.cursor ?? "", JSON.stringify(page.orderReferences)],
    );
    chunks.add(traversal.pages);
    for (const reference of page.orderReferences) allowed.add(reference);
  }
  if (
    progress.postedReferences.some((ref) => !allowed.has(ref)) ||
    progress.gaps.some((gap) => !allowed.has(gap.reference))
  ) {
    throw new OutboundSyncError("invalid-input", "Disposition was not discovered in this claimed work.");
  }
  let gapCount = checkpoint.gapCount;
  let madeProgress = progress.pages.length > 0 || (progress.followUpTail && outcome.admissionCounts.followUpReads > 0);
  for (const chunkId of chunks) {
    const result = await db.query<Chunk>(
      `SELECT chunk_id, remaining_references, posted_references, revision FROM channel_order_pull_chunks
       WHERE connection_id=$1 AND burst_id=$2 AND chunk_id=$3 FOR UPDATE`,
      [connectionId, checkpoint.burstId, chunkId],
    );
    const chunk = result.rows[0];
    if (!chunk) throw new OutboundSyncError("stale-fence");
    const references = chunk.remaining_references;
    assertOrderPullChunk(connectionId, references);
    const accepted = new Set(
      await readAcceptedReadyToShipMembership(db, { connectionId, orderReferences: references }),
    );
    const gaps = progress.gaps.filter((gap) => references.includes(gap.reference) && !accepted.has(gap.reference));
    gapCount += gaps.length;
    if (!Number.isSafeInteger(gapCount)) throw new OutboundSyncError("invalid-input");
    const resolved = new Set([...accepted, ...gaps.map((gap) => gap.reference)]);
    const remaining = references.filter((ref) => !resolved.has(ref));
    const posted = [...new Set([...chunk.posted_references, ...progress.postedReferences])].filter((ref) =>
      remaining.includes(ref),
    );
    madeProgress ||= remaining.length !== references.length || posted.length !== chunk.posted_references.length;
    const changed = await db.query(
      `UPDATE channel_order_pull_chunks SET remaining_references=$4::jsonb, posted_references=$5::jsonb, revision=revision+1
       WHERE connection_id=$1 AND burst_id=$2 AND chunk_id=$3 AND revision=$6 RETURNING chunk_id`,
      [connectionId, checkpoint.burstId, chunkId, JSON.stringify(remaining), JSON.stringify(posted), chunk.revision],
    );
    if (changed.rows.length !== 1) throw new OutboundSyncError("stale-fence");
  }
  const pending = await db.query<{ unread: boolean }>(
    `SELECT NOT posted_references @> remaining_references AS unread FROM channel_order_pull_chunks
     WHERE connection_id=$1 AND burst_id=$2 AND remaining_references <> '[]'::jsonb
     ORDER BY (NOT posted_references @> remaining_references) DESC, chunk_id LIMIT 1`,
    [connectionId, checkpoint.burstId],
  );
  const kind = orderPullProgressKind({
    exhausted: traversal?.exhausted ?? false,
    unread: pending.rows[0]?.unread ?? false,
    pending: pending.rows.length > 0,
    followUpTail: progress.followUpTail,
    gapCount,
  });
  if ((outcome.kind === "order-pull-complete" || outcome.kind === "order-pull-gaps") && outcome.kind !== kind) {
    throw new OutboundSyncError("invalid-input", `Owner-verified progress requires ${kind}.`);
  }
  if (kind === "continuation-required" && !madeProgress)
    throw new OutboundSyncError(
      "invalid-input",
      "No-progress continuation refused; retain work under the existing error policy.",
    );
  return {
    kind,
    checkpoint: {
      ...checkpoint,
      traversal,
      gapCount,
      followUpTail: progress.followUpTail,
      drained: kind === "order-pull-complete" || kind === "order-pull-gaps",
    },
  };
}
