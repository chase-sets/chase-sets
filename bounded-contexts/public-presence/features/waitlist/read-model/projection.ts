import type {
  ChaseSetsEventPayloads,
  WaitlistCohortQualityProvidedPayload,
  WaitlistSignupAdmittedPayload,
  WaitlistSignupRecordedPayload,
  WaitlistSignupUpdatedPayload,
} from "@chase-sets/event-core";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type WaitlistEventData = WaitlistSignupRecordedPayload | WaitlistSignupUpdatedPayload;

async function upsertWaitlistSignup(db: PgQueryable, data: WaitlistEventData, timestamp: string) {
  const cohortQuality = data.cohortQuality ?? { games: [], hasStoreLink: false, storeUrl: null, inventorySize: null };
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
       games,
       has_store_link,
       store_url,
       inventory_size,
       submitted_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $19
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
         games = EXCLUDED.games,
         has_store_link = EXCLUDED.has_store_link,
         store_url = EXCLUDED.store_url,
         inventory_size = EXCLUDED.inventory_size,
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
      JSON.stringify(cohortQuality.games),
      cohortQuality.hasStoreLink,
      cohortQuality.storeUrl,
      cohortQuality.inventorySize,
      timestamp,
    ],
  );
}

/**
 * Applies a progressive cohort-quality save (welcome-page "wave placement"
 * step). The event carries the full merged cohort-quality record, so this is
 * a straight column replace; the row always exists because the recorded
 * event precedes it in the same stream.
 */
async function applyCohortQuality(db: PgQueryable, data: WaitlistCohortQualityProvidedPayload) {
  await db.query(
    `UPDATE public_presence_waitlist_signups
     SET games = $2::jsonb,
         has_store_link = $3,
         store_url = $4,
         inventory_size = $5,
         updated_at = $6
     WHERE signup_id = $1`,
    [
      data.signupId,
      JSON.stringify(data.cohortQuality.games),
      data.cohortQuality.hasStoreLink,
      data.cohortQuality.storeUrl,
      data.cohortQuality.inventorySize,
      data.providedAt,
    ],
  );
}

async function applyAdmission(db: PgQueryable, data: WaitlistSignupAdmittedPayload) {
  await db.query(
    `UPDATE public_presence_waitlist_signups
     SET admitted_wave = $2,
         beta_invitation_id = $3,
         admitted_at = $4,
         updated_at = $4
     WHERE signup_id = $1`,
    [data.signupId, data.waveNumber, data.invitationId, data.admittedAt],
  );
}

export function buildWaitlistProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<
      ChaseSetsEventPayloads,
      | "public-presence.waitlist-signup.recorded"
      | "public-presence.waitlist-signup.updated"
      | "public-presence.waitlist-signup.cohort-quality-provided"
      | "public-presence.waitlist-signup.admitted"
    >
  >({
    "public-presence.waitlist-signup.recorded": async (event) => {
      const data = event.data;
      await upsertWaitlistSignup(db, data, data.recordedAt ?? new Date().toISOString());
    },
    "public-presence.waitlist-signup.updated": async (event) => {
      const data = event.data;
      await upsertWaitlistSignup(db, data, data.updatedAt ?? new Date().toISOString());
    },
    "public-presence.waitlist-signup.cohort-quality-provided": async (event) => {
      await applyCohortQuality(db, event.data);
    },
    "public-presence.waitlist-signup.admitted": async (event) => {
      await applyAdmission(db, event.data);
    },
  });
}
