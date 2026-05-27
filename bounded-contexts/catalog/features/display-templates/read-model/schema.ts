export const catalogDisplayTemplateSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_display_templates (
  display_template_id text PRIMARY KEY,
  key text NOT NULL,
  name_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  name text NOT NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  target_kind text NOT NULL DEFAULT 'global',
  target_id text NULL,
  priority integer NOT NULL DEFAULT 0,
  title_template text NOT NULL,
  subtitle_template text NULL,
  required_field_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_display_templates_key_idx
  ON catalog_display_templates (key);
CREATE INDEX IF NOT EXISTS catalog_display_templates_target_idx
  ON catalog_display_templates (target_kind, target_id);
CREATE INDEX IF NOT EXISTS catalog_display_templates_status_idx
  ON catalog_display_templates (status);`;
