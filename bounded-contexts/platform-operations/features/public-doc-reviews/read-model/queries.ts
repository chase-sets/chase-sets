import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PublicDocReviewQueueItem = Readonly<{
  locale: string;
  articleSlug: string;
  articleTitle: string;
  articleHref: string;
  policyKey: string;
  policyDocumentId: string;
  policyRevisionEventId: string;
  flaggedAt: string;
  ageDays: number;
}>;

type PublicDocReviewRow = Readonly<{
  locale: string;
  article_slug: string;
  article_title: string;
  article_href: string;
  policy_key: string;
  policy_document_id: string;
  policy_revision_event_id: string;
  flagged_at: string;
}>;

function toQueueItem(row: PublicDocReviewRow, now: Date): PublicDocReviewQueueItem {
  return {
    locale: row.locale,
    articleSlug: row.article_slug,
    articleTitle: row.article_title,
    articleHref: row.article_href,
    policyKey: row.policy_key,
    policyDocumentId: row.policy_document_id,
    policyRevisionEventId: row.policy_revision_event_id,
    flaggedAt: row.flagged_at,
    ageDays: Math.max(0, Math.floor((now.getTime() - new Date(row.flagged_at).getTime()) / 86_400_000)),
  };
}

export async function listPendingPublicDocReviews(db: PgQueryable, now = new Date()) {
  const result = await db.query<PublicDocReviewRow>(
    `SELECT locale,
            article_slug,
            article_title,
            article_href,
            policy_key,
            policy_document_id,
            policy_revision_event_id,
            flagged_at::text AS flagged_at
     FROM platform_operations_public_doc_review_queue_pages
     WHERE status = 'needs-review'
     ORDER BY flagged_at ASC, article_slug ASC, policy_key ASC`,
  );
  return result.rows.map((row) => toQueueItem(row, now));
}

export async function getPendingPublicDocReview(
  db: PgQueryable,
  identity: Readonly<{ locale: string; articleSlug: string; policyKey: string }>,
) {
  const result = await db.query<PublicDocReviewRow>(
    `SELECT locale,
            article_slug,
            article_title,
            article_href,
            policy_key,
            policy_document_id,
            policy_revision_event_id,
            flagged_at::text AS flagged_at
     FROM platform_operations_public_doc_review_queue_pages
     WHERE locale = $1
       AND article_slug = $2
       AND policy_key = $3
       AND status = 'needs-review'`,
    [identity.locale, identity.articleSlug, identity.policyKey],
  );
  return result.rows[0] ? toQueueItem(result.rows[0], new Date()) : null;
}
