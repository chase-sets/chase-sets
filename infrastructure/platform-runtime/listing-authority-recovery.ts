import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  listingAuthorityParticipantKey,
  type ListingAuthorityConsumerPort,
  type ListingAuthorityOperation,
  type ListingAuthorityOwner,
  type ListingAuthorityReservation,
} from "@chase-sets/event-core/listing-authority";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ListingAuthoritySource } from "./listing-authority-participant";
import { assertSameAuthority, authorityContext, authorityHash } from "./listing-authority-state";

/** One bounded pass for an owner's durable worker. The worker retains the cursor and schedules the next pass. */
export function createListingAuthorityRecovery(
  deps: Readonly<{
    db: PgQueryable;
    owner: ListingAuthorityOwner;
    sources: readonly ListingAuthoritySource[];
    consumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
    resume(mutationId: string, context: EventStoreContext): Promise<unknown>;
    resumeWrite(writeId: string): Promise<unknown>;
    now?: () => Date;
  }>,
) {
  if (!deps.sources.length || deps.sources.some((source) => source.participant.owner !== deps.owner))
    throw new Error("Recovery sources must belong to their owner.");
  const sources = new Map(deps.sources.map((source) => [listingAuthorityParticipantKey(source.participant), source]));
  const prefix = `${deps.owner}.listing-authority`;
  return async function recoverPage(input: Readonly<{ after?: string; limit?: number }> = {}) {
    const after = input.after ?? "0";
    const limit = input.limit ?? 25;
    if (!/^\d+$/.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid bounded authority recovery page.");
    const page = await deps.db.query<{
      stream_id: string;
      global_position: string;
      tenant_id: string;
      payload: JsonObject;
    }>(
      `
      SELECT pending.stream_id, pending.global_position::text, pending.tenant_id, pending.payload
      FROM event_store_events pending
      WHERE pending.global_position > $1::bigint
        AND ((pending.stream_version = 1 AND (pending.stream_id LIKE $2 OR pending.stream_id LIKE $3))
          OR (pending.stream_id LIKE $6 AND pending.event_type = $7))
        AND NOT EXISTS (SELECT 1 FROM event_store_events terminal
          WHERE terminal.stream_id = pending.stream_id AND terminal.stream_version > pending.stream_version
            AND terminal.event_type = ANY($4::text[]))
      ORDER BY pending.global_position LIMIT $5`,
      [
        after,
        `${prefix}-reservation-%`,
        `${prefix}-mutation-%`,
        [`${prefix}.settled`, `${prefix}.invalidation-completed`, `${prefix}-write.completed`],
        limit,
        `${prefix}-write-%`,
        `${prefix}-write.started`,
      ],
    );
    if (page.rows.length > limit) throw new Error("Authority recovery query exceeded its bound.");
    const outcomes: {
      streamId: string;
      status: "settled" | "resumed" | "pending" | "blocked";
      error: string | null;
    }[] = [];
    for (const row of page.rows) {
      try {
        if (row.stream_id.startsWith(`${prefix}-write-`)) {
          const writeId = row.payload.writeId;
          const inputs = row.payload.inputs as unknown as readonly AppendToStreamInput[];
          if (
            typeof writeId !== "string" ||
            inputs?.[0]?.context.tenantId !== row.tenant_id ||
            row.stream_id !== `${prefix}-write-${writeId}` ||
            authorityHash({ inputs }) !== writeId
          )
            throw new Error("Invalid source write recovery record.");
          try {
            await deps.resumeWrite(writeId);
          } catch (error) {
            if ((error as { code?: string }).code !== "concurrency_conflict") throw error;
            const mutation = await deps.sources[0]!.inspectInvalidation(row.tenant_id, String(row.payload.mutationId));
            if (mutation?.status !== "completed") throw error;
          }
          outcomes.push({ streamId: row.stream_id, status: "resumed", error: null });
          continue;
        }
        const reservation = row.payload.reservation as unknown as ListingAuthorityReservation | undefined;
        if (reservation) {
          const source = sources.get(listingAuthorityParticipantKey(reservation.participant));
          if (!source || row.tenant_id !== reservation.operation.tenantId)
            throw new Error("Unowned source reservation recovery record.");
          const current = await source.inspect(reservation.operation);
          if (!current) throw new Error("Source reservation recovery lost its history.");
          let terminal = await deps.consumer(reservation.operation).inspect(reservation.operation);
          if (terminal.status === "unknown") throw new Error("Consumer outcome unknown; retain source promise.");
          assertSameAuthority(terminal.operation, reservation.operation);
          if (
            terminal.status === "pending" &&
            (deps.now?.() ?? new Date()).getTime() >= Date.parse(current.validBefore)
          ) {
            terminal = await deps
              .consumer(reservation.operation)
              .invalidate(reservation.operation, "source-validity-ended");
          }
          if (terminal.status === "pending") outcomes.push({ streamId: row.stream_id, status: "pending", error: null });
          else {
            await source.settle(reservation.operation);
            outcomes.push({ streamId: row.stream_id, status: "settled", error: null });
          }
          continue;
        }
        const intent = row.payload.intent as unknown as { mutationId: string; command: JsonObject } | undefined;
        if (!intent?.mutationId || !intent.command) throw new Error("Invalid source mutation recovery record.");
        if (intent.mutationId.startsWith("writer-")) {
          const inputs = intent.command.inputs as unknown as readonly AppendToStreamInput[];
          const context = inputs?.[0]?.context;
          if (!context || context.tenantId !== row.tenant_id)
            throw new Error("Source writer lost its original audit context.");
          try {
            await deps.resume(intent.mutationId, context);
          } catch (error) {
            // A stale append plan has a durable conflict receipt; it is resolved, not stuck.
            if ((error as { code?: string }).code !== "concurrency_conflict") throw error;
            const mutation = await deps.sources[0]!.inspectInvalidation(context.tenantId, intent.mutationId);
            if (mutation?.status !== "completed") throw error;
          }
          outcomes.push({ streamId: row.stream_id, status: "resumed", error: null });
          continue;
        }
        const operation = intent.command.operation as unknown as ListingAuthorityOperation;
        if (!operation || operation.tenantId !== row.tenant_id)
          throw new Error("Source preparation lost its operation binding.");
        const source = deps.sources.find(
          (candidate) =>
            intent.mutationId ===
            `prepare-${authorityHash([
              listingAuthorityParticipantKey(candidate.participant),
              operation.operationId,
              operation.generation,
            ])}`,
        );
        if (!source) throw new Error("Unowned source preparation recovery record.");
        let terminal = await deps.consumer(operation).inspect(operation);
        if (terminal.status === "unknown") throw new Error("Consumer outcome unknown; retain source preparation.");
        assertSameAuthority(terminal.operation, operation);
        if (
          terminal.status === "pending" &&
          (deps.now?.() ?? new Date()).getTime() >= Date.parse(operation.prepareBefore)
        ) {
          terminal = await deps.consumer(operation).invalidate(operation, "source-preparation-expired");
        }
        try {
          await source.prepare(operation, authorityContext(operation));
        } catch (error) {
          const mutation = await source.inspectInvalidation(operation.tenantId, intent.mutationId);
          if (terminal.status !== "aborted" || mutation?.status !== "completed") throw error;
        }
        outcomes.push({ streamId: row.stream_id, status: "resumed", error: null });
      } catch (error) {
        outcomes.push({
          streamId: row.stream_id,
          status: "blocked",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { outcomes, nextCursor: page.rows.length === limit ? page.rows.at(-1)!.global_position : null };
  };
}
