import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { stableWaitlistSignupId } from "../../domain/common";
import {
  mapFoundersWindowOpenedToAdmissionEmail,
  mapWaitlistSignupRecordedToNurtureEmails,
} from "./transactional-email-intents";

export const PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION =
  "public-presence-waitlist-transactional-email-projection";

const IDENTITY_ACCOUNT_STREAM_PREFIX = "identity.account-";

type WaitlistSignupRecordedEmailEvent = Readonly<
  TransportEvent & {
    type: "public-presence.waitlist-signup.recorded";
    data: Readonly<{
      signupId: string;
      email: string;
      recordedAt?: string;
    }>;
  }
>;

type FoundersWindowOpenedEmailEvent = Readonly<
  TransportEvent & {
    type: "identity.account.founders-window-opened";
    data: Readonly<{
      betaAccessStartedAt: string;
      foundersWindowEndsAt: string;
      recipientEmail?: string;
    }>;
  }
>;

type WaitlistAdmissionProfileRow = Readonly<{
  role: string;
  games: unknown;
  has_store_link: boolean;
  inventory_size: string | null;
}>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectWaitlistEventToTransactionalEmail(
  db: PgQueryable,
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type === "public-presence.waitlist-signup.recorded") {
    const data = event.data as WaitlistSignupRecordedEmailEvent["data"];
    const source = sourceFromEvent(event, projectionName);
    const sequence = mapWaitlistSignupRecordedToNurtureEmails({
      email: data.email,
      signupId: data.signupId,
      recordedAt: data.recordedAt ?? event.timing.occurredAt,
      correlationId: correlationIdFromEvent(event),
    });

    for (const delivery of sequence) {
      await outbox.enqueueNotification({ message: delivery.message, source, availableAt: delivery.availableAt });
    }
    return;
  }

  if (event.type !== "identity.account.founders-window-opened") {
    return;
  }

  const data = event.data as FoundersWindowOpenedEmailEvent["data"];
  if (!data.recipientEmail) {
    // Additive payload: historical founders-window events predate the nurture
    // contract and cannot be safely guessed at during replay.
    return;
  }

  const signupId = stableWaitlistSignupId(data.recipientEmail);
  const result = await db.query<WaitlistAdmissionProfileRow>(
    `SELECT role, games, has_store_link, inventory_size
     FROM public_presence_waitlist_signups
     WHERE signup_id = $1`,
    [signupId],
  );
  const profile = result.rows[0];
  if (!profile) {
    // Founders access can also be granted outside the public waitlist. Public
    // Presence only owns nurture for a Waitlist Signup it can identify.
    return;
  }

  const accountId = extractIdFromStreamId(event.streamId, IDENTITY_ACCOUNT_STREAM_PREFIX) as AccountId;
  await outbox.enqueueNotification({
    message: mapFoundersWindowOpenedToAdmissionEmail({
      email: data.recipientEmail,
      signupId,
      accountId,
      betaAccessStartedAt: data.betaAccessStartedAt,
      foundersWindowEndsAt: data.foundersWindowEndsAt,
      missingCohortFields: missingCohortFields(profile),
      correlationId: correlationIdFromEvent(event),
    }),
    source: sourceFromEvent(event, projectionName),
    availableAt: data.betaAccessStartedAt,
  });
}

export function buildWaitlistTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  const project = (event: TransportEvent) =>
    projectWaitlistEventToTransactionalEmail(db, outbox, event, projectionName);
  return {
    "public-presence.waitlist-signup.recorded": project,
    "identity.account.founders-window-opened": project,
  };
}

function sourceFromEvent(event: TransportEvent, projectionName: string) {
  return {
    sourceEventId: event.id,
    sourceGlobalPosition: event.globalPosition,
    projectionName,
    occurredAt: event.timing.occurredAt,
  };
}

function missingCohortFields(profile: WaitlistAdmissionProfileRow) {
  if (profile.role === "buy") return [];
  const games = Array.isArray(profile.games) ? profile.games : [];
  return [
    ...(games.length === 0 ? ["the games you sell"] : []),
    ...(!profile.inventory_size ? ["your inventory-size range"] : []),
    ...(!profile.has_store_link ? ["an optional TCGplayer or eBay store link"] : []),
  ];
}
