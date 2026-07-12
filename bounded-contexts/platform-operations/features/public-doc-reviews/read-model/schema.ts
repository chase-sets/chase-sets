export const publicDocReviewSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_operations_public_doc_review_queue_pages (
  locale text NOT NULL,
  article_slug text NOT NULL,
  article_title text NOT NULL,
  article_href text NOT NULL,
  policy_key text NOT NULL,
  policy_document_id text NOT NULL,
  policy_revision_event_id text NOT NULL,
  status text NOT NULL,
  flagged_at timestamptz NOT NULL,
  reviewed_at timestamptz NULL,
  reviewed_by_user_id text NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (locale, article_slug, policy_key)
);

CREATE INDEX IF NOT EXISTS platform_operations_public_doc_review_queue_status_age_idx
  ON platform_operations_public_doc_review_queue_pages (status, flagged_at ASC);
`;
