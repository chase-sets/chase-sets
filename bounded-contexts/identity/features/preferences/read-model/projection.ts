import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type UserPreferencesUpdatedPayload = Readonly<{
  userId: string;
  colorMode: string;
  density: string;
  reducedMotion: string;
  locale: string;
  timeZone: string;
}>;

export function buildUserPreferencesProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.user-preferences.updated": async (event) => {
      const data = event.data as UserPreferencesUpdatedPayload;
      await db.query(
        `INSERT INTO identity_user_preferences (
           user_id,
           color_mode,
           density,
           reduced_motion,
           locale,
           time_zone,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE
         SET color_mode = $2,
             density = $3,
             reduced_motion = $4,
             locale = $5,
             time_zone = $6,
             updated_at = $7`,
        [
          data.userId,
          data.colorMode,
          data.density,
          data.reducedMotion,
          data.locale,
          data.timeZone,
          event.timing.recordedAt,
        ],
      );
    },
  };
}
