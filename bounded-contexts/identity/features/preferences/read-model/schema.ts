export const identityUserPreferencesSchemaSql = `CREATE TABLE IF NOT EXISTS identity_user_preferences (
  user_id text PRIMARY KEY,
  color_mode text NOT NULL,
  density text NOT NULL,
  reduced_motion text NOT NULL,
  locale text NOT NULL,
  time_zone text NOT NULL,
  updated_at timestamptz NOT NULL
);`;
