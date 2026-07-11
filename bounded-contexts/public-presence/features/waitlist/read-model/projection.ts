import type {
  ChaseSetsEventPayloads,
  WaitlistSignupRecordedPayload,
  WaitlistSignupUpdatedPayload,
} from "@chase-sets/event-core";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type WaitlistEventData = WaitlistSignupRecordedPayload | WaitlistSignupUpdatedPayload;

async function upsertWaitlistSignup(db: PgQueryable, data: WaitlistEventData, timestamp: string) {
  await db.query(
    `INSERT INTO public_presence_waitlist_signups (
       signup_id,
       email,
       role,
       interests,
       email_consent_accepted_at,
       marketing_consent_accepted_at,
       referred_by_signup_id,
       page_path,
       referrer,
       utm_source,
       utm_medium,
       utm_campaign,
       utm_content,
       utm_term,
       submitted_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15
     )
     ON CONFLICT (signup_id) DO UPDATE
     SET email = EXCLUDED.email,
         role = EXCLUDED.role,
         interests = EXCLUDED.interests,
         email_consent_accepted_at = EXCLUDED.email_consent_accepted_at,
         marketing_consent_accepted_at = EXCLUDED.marketing_consent_accepted_at,
         -- referred_by_signup_id intentionally omitted: referral attribution
         -- is set once at initial signup and must never be overwritten by a
         -- later profile update (updated events never carry the field).
         page_path = EXCLUDED.page_path,
         referrer = EXCLUDED.referrer,
         utm_source = EXCLUDED.utm_source,
         utm_medium = EXCLUDED.utm_medium,
         utm_campaign = EXCLUDED.utm_campaign,
         utm_content = EXCLUDED.utm_content,
         utm_term = EXCLUDED.utm_term,
         updated_at = EXCLUDED.updated_at`,
    [
      data.signupId,
      data.email,
      data.role,
      JSON.stringify(data.interests),
      data.emailConsentAcceptedAt,
      data.marketingConsentAcceptedAt ?? null,
      data.referredBySignupId ?? null,
      data.source.pagePath,
      data.source.referrer,
      data.source.utmSource,
      data.source.utmMedium,
      data.source.utmCampaign,
      data.source.utmContent,
      data.source.utmTerm,
      timestamp,
    ],
  );
}

export function buildWaitlistProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<ChaseSetsEventPayloads, "public-presence.waitlist-signup.recorded" | "public-presence.waitlist-signup.updated">
  >({
    "public-presence.waitlist-signup.recorded": async (event) => {
      const data = event.data;
      await upsertWaitlistSignup(db, data, data.recordedAt ?? new Date().toISOString());
    },
    "public-presence.waitlist-signup.updated": async (event) => {
      const data = event.data;
      await upsertWaitlistSignup(db, data, data.updatedAt ?? new Date().toISOString());
    },
  });
}
