import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { publicHelpArticlePolicyCitations } from "@chase-sets/public-docs";

export function buildCommercialTermsPublicDocReviewProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "platform-policy.document.revised": async (event) => {
      const data = event.data as { documentId: string; policyKey: string };
      const linkedArticles = publicHelpArticlePolicyCitations.filter((article) =>
        article.citedPolicies.some((policyKey) => policyKey === data.policyKey),
      );

      for (const article of linkedArticles) {
        await db.query(
          `INSERT INTO platform_operations_public_doc_review_queue_pages (
             locale,
             article_slug,
             article_title,
             article_href,
             policy_key,
             policy_document_id,
             policy_revision_event_id,
             status,
             flagged_at,
             reviewed_at,
             reviewed_by_user_id,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'needs-review', $8, NULL, NULL, $8)
           ON CONFLICT (locale, article_slug, policy_key) DO UPDATE SET
             article_title = EXCLUDED.article_title,
             article_href = EXCLUDED.article_href,
             policy_document_id = EXCLUDED.policy_document_id,
             policy_revision_event_id = EXCLUDED.policy_revision_event_id,
             status = 'needs-review',
             flagged_at = EXCLUDED.flagged_at,
             reviewed_at = NULL,
             reviewed_by_user_id = NULL,
             updated_at = EXCLUDED.updated_at`,
          [
            article.locale,
            article.slug,
            article.title,
            article.href,
            data.policyKey,
            data.documentId,
            event.id,
            event.timing.recordedAt,
          ],
        );
      }
    },
  };
}

export function buildPlatformOperationsPublicDocReviewProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "platform-operations.public-doc-article-review.confirmed": async (event) => {
      const data = event.data as {
        locale: string;
        articleSlug: string;
        policyKey: string;
        policyRevisionEventId: string;
        operatorUserId: string;
        confirmedAt: string;
      };
      await db.query(
        `UPDATE platform_operations_public_doc_review_queue_pages
         SET status = 'confirmed',
             reviewed_at = $5,
             reviewed_by_user_id = $6,
             updated_at = $5
         WHERE locale = $1
           AND article_slug = $2
           AND policy_key = $3
           AND policy_revision_event_id = $4`,
        [
          data.locale,
          data.articleSlug,
          data.policyKey,
          data.policyRevisionEventId,
          data.confirmedAt,
          data.operatorUserId,
        ],
      );
    },
  };
}
