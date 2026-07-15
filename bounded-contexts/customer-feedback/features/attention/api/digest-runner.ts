import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildFeedbackAttentionDigest } from "../domain/attention";
import type { FeedbackAttentionDigestRequestedEvent } from "../domain/attention-events";
import { listFeedbackAttention } from "../read-model/queries";

const DEFAULT_DIGEST_WINDOW_MINUTES = 15;
const DEFAULT_MAX_ITEMS_PER_GROUP = 25;

export type FeedbackAttentionDigestRunResult = Readonly<{
  windowStart: string;
  windowEnd: string;
  groupsRequested: number;
  groupsAlreadyRequested: number;
  noRecipientGroups: number;
  itemCount: number;
}>;

export function createFeedbackAttentionDigestRunner(deps: Readonly<{ db: PgQueryable; eventStore: EventStore }>) {
  return async function runFeedbackAttentionDigest(
    input: Readonly<{
      now?: string;
      windowMinutes?: number;
      maxItemsPerGroup?: number;
      teamRecipientUserIds?: readonly string[];
    }> = {},
    context: EventStoreContext,
  ): Promise<FeedbackAttentionDigestRunResult> {
    const windowMinutes = Math.max(1, Math.floor(input.windowMinutes ?? DEFAULT_DIGEST_WINDOW_MINUTES));
    const windowEnd = alignedWindowEnd(input.now ?? new Date().toISOString(), windowMinutes);
    const windowStart = new Date(Date.parse(windowEnd) - windowMinutes * 60_000).toISOString();
    const items = await listFeedbackAttention(deps.db, { limit: 500, now: windowEnd });
    const digest = buildFeedbackAttentionDigest(
      items.map((item) => ({
        attentionId: item.attentionId,
        caseId: item.caseId,
        teamKey: "support",
        ownerId: item.ownerId,
        priority: item.priority,
        reason: item.reason,
        dueAt: item.dueAt,
        adminHref: `/support/customer-feedback/attention?caseId=${encodeURIComponent(item.caseId)}`,
      })),
      { start: windowStart, end: windowEnd },
      { maxItems: input.maxItemsPerGroup ?? DEFAULT_MAX_ITEMS_PER_GROUP },
    );
    let groupsRequested = 0;
    let groupsAlreadyRequested = 0;
    let noRecipientGroups = 0;
    let itemCount = 0;

    for (const group of digest.groups) {
      const recipients = group.ownerId
        ? [group.ownerId]
        : uniqueNonEmpty(input.teamRecipientUserIds ?? []).length > 0
          ? uniqueNonEmpty(input.teamRecipientUserIds ?? [])
          : [null];
      for (const recipientUserId of recipients) {
        const digestId = stableDigestId(windowStart, windowEnd, group.groupKey, recipientUserId);
        const event: FeedbackAttentionDigestRequestedEvent = {
          type: "customer-feedback.attention.digest-requested",
          data: {
            eventSchemaVersion: 1,
            digestId,
            windowStart,
            windowEnd,
            groupKey: group.groupKey,
            teamKey: group.teamKey,
            recipientUserId,
            items: group.items.map((item) => ({
              attentionId: item.attentionId,
              caseId: item.caseId,
              priority: item.priority,
              reason: item.reason,
              adminHref: item.adminHref,
            })),
            capped: group.capped,
            requestedAt: windowEnd,
          },
        };
        try {
          await deps.eventStore.appendToStream({
            streamId: `customer-feedback.attention-digest-${digestId}`,
            expectedVersion: "no_stream",
            context,
            events: [{ eventType: event.type, payload: event.data as never, occurredAt: windowEnd as never }],
          });
          groupsRequested += 1;
          itemCount += event.data.items.length;
          if (!recipientUserId) noRecipientGroups += 1;
        } catch (error) {
          if (!isConcurrencyConflict(error)) throw error;
          groupsAlreadyRequested += 1;
        }
      }
    }

    return {
      windowStart,
      windowEnd,
      groupsRequested,
      groupsAlreadyRequested,
      noRecipientGroups,
      itemCount,
    };
  };
}

function alignedWindowEnd(now: string, windowMinutes: number): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("Feedback attention digest time must be a valid timestamp.");
  const windowMs = windowMinutes * 60_000;
  return new Date(Math.floor(timestamp / windowMs) * windowMs).toISOString();
}

function stableDigestId(windowStart: string, windowEnd: string, groupKey: string, recipientUserId: string | null) {
  return createHash("sha256")
    .update(`${windowStart}\u0000${windowEnd}\u0000${groupKey}\u0000${recipientUserId ?? "no-recipient"}`)
    .digest("hex");
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
