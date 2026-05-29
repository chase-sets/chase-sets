export const promoBarSchemaSql = `
CREATE TABLE IF NOT EXISTS public_presence_promo_bar_messages (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NULL,
  href text NULL,
  link_label text NULL,
  tone text NOT NULL DEFAULT 'info',
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 100,
  starts_at timestamptz NULL,
  ends_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT public_presence_promo_bar_messages_tone_check
    CHECK (tone IN ('info', 'success', 'warning')),
  CONSTRAINT public_presence_promo_bar_messages_window_check
    CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS public_presence_promo_bar_messages_active_idx
  ON public_presence_promo_bar_messages (is_active, display_order, updated_at DESC);
`;
