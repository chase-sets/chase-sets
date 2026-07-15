import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { stableWaitlistSignupId } from "../../domain/common";
import {
  mapFoundersWindowOpenedToAdmissionEmail,
  mapWaitlistAdmissionToTransactionalEmail,
  mapWaitlistSignupRecordedToNurtureEmails,
} from "./transactional-email-intents";

export const PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION =
  "public-presence-waitlist-transactional-email-projection";

const IDENTITY_ACCOUNT_STREAM_PREFIX = "identity.account-";

type WaitlistSignupRecordedEmailData = Readonly<{
  signupId: string;
  email: string;
  recordedAt?: string;
}>;

type FoundersWindowOpenedEmailData = Readonly<{
  betaAccessStartedAt: string;
  foundersWindowEndsAt: string;
  recipientEmail?: string;
}>;

type WaitlistSignupAdmittedEmailData = Readonly<{
  signupId: string;
  email: string;
  waveNumber: number;
  invitationId: string;
}>;

type WaitlistAdmissionProfileRow = Readonly<{
  role: string;
  games: unknown;
  has_store_link: boolean;
  inventory_size: string | null;
}>;

export function buildWaitlistTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  return {
    ...defineTransactionalEmail<WaitlistSignupRecordedEmailData, string, "public-presence.waitlist-signup.recorded">({
      outbox,
      projectionName,
      on: "public-presence.waitlist-signup.recorded",
      recipient: (data) => data.email || null,
      template: (data, { recipient, event, correlationId }) =>
        mapWaitlistSignupRecordedToNurtureEmails({
          email: recipient,
          signupId: data.signupId,
          recordedAt: data.recordedAt ?? event.timing.occurredAt,
          correlationId,
        }),
    }),
    ...defineTransactionalEmail<WaitlistSignupAdmittedEmailData, string, "public-presence.waitlist-signup.admitted">({
      outbox,
      projectionName,
      on: "public-presence.waitlist-signup.admitted",
      recipient: (data) => data.email || null,
      template: (data, { recipient, event, correlationId }) => ({
        message: mapWaitlistAdmissionToTransactionalEmail({
          email: recipient,
          signupId: data.signupId,
          waveNumber: Number(data.waveNumber),
          correlationId,
        }),
        availableAt: event.timing.occurredAt,
      }),
    }),
    ...defineTransactionalEmail<
      FoundersWindowOpenedEmailData,
      { email: string; signupId: string; accountId: AccountId; profile: WaitlistAdmissionProfileRow },
      "identity.account.founders-window-opened"
    >({
      outbox,
      projectionName,
      on: "identity.account.founders-window-opened",
      recipient: async (data, { event }) => {
        if (!data.recipientEmail) {
          return null;
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
          return null;
        }

        return {
          email: data.recipientEmail,
          signupId,
          accountId: extractIdFromStreamId(event.streamId, IDENTITY_ACCOUNT_STREAM_PREFIX) as AccountId,
          profile,
        };
      },
      template: (data, { recipient, correlationId }) => ({
        message: mapFoundersWindowOpenedToAdmissionEmail({
          email: recipient.email,
          signupId: recipient.signupId,
          accountId: recipient.accountId,
          betaAccessStartedAt: data.betaAccessStartedAt,
          foundersWindowEndsAt: data.foundersWindowEndsAt,
          missingCohortFields: missingCohortFields(recipient.profile),
          correlationId,
        }),
        availableAt: data.betaAccessStartedAt,
      }),
    }),
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
