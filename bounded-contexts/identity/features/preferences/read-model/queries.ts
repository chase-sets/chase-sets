import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import {
  defaultUserPresentationPreferences,
  type PresentationColorMode,
  type PresentationDensity,
  type ReducedMotionPreference,
  type UserPreferences,
} from "../domain/domain";

export type UserPreferencesRow = Readonly<{
  user_id: string;
  color_mode: PresentationColorMode;
  density: PresentationDensity;
  reduced_motion: ReducedMotionPreference;
  locale: string;
  time_zone: string;
  updated_at: string;
}>;

export async function getUserPreferences(db: PgQueryable, userId: string): Promise<UserPreferences> {
  const result = await db.query<UserPreferencesRow>(`SELECT * FROM identity_user_preferences WHERE user_id = $1`, [
    userId,
  ]);
  const row = result.rows[0];
  if (!row) {
    return {
      userId: userId as UserId,
      ...defaultUserPresentationPreferences,
    };
  }

  return {
    userId: row.user_id as UserId,
    colorMode: row.color_mode,
    density: row.density,
    reducedMotion: row.reduced_motion,
    locale: row.locale,
    timeZone: row.time_zone,
  };
}
