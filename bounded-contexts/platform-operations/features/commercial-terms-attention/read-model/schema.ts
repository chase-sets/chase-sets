export const commercialTermsEffectiveDateAttentionSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_operations_commercial_terms_attention_pages (
  document_id text PRIMARY KEY,
  document_kind text NOT NULL,
  label text NOT NULL,
  account_id text NULL,
  status text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_operations_commercial_terms_attention_window_idx
  ON platform_operations_commercial_terms_attention_pages (
    status,
    effective_from ASC,
    effective_until ASC
  );
`;
