import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PolicyProjectionOptions = Readonly<{
  /**
   * Invoked synchronously, in the same transaction-scoped handler call, right
   * after a policy document's created/revised event is applied to the read
   * model. This is the push-based cache-invalidation hook: it rides the same
   * event flow that already drives the projection (no separate polling loop
   * and no TTL). Callers wire this to a `PolicyCache`'s `invalidate`.
   */
  onPolicyRevised?: (policyKey: string) => void;
}>;

type PolicyDocumentCreatedPayload = Readonly<{
  documentId: string;
  policyKey: string;
  contextName: string;
  schemaSummary: string;
  status: string;
  value: unknown;
  effectiveFrom: string;
  effectiveUntil: string | null;
  actorUserId: string;
}>;

type PolicyDocumentRevisedPayload = Readonly<{
  documentId: string;
  policyKey: string;
  status: string;
  value: unknown;
  effectiveFrom: string;
  effectiveUntil: string | null;
  actorUserId: string;
}>;

/**
 * Builds the shared platform-policy projection handlers. Every context that
 * adopts the machinery registers this same handler map against its own event
 * stream -- the handlers are generic over policy shape because the read
 * model stores `value` as opaque jsonb.
 */
export function buildPolicyDocumentProjectionHandlers(
  db: PgQueryable,
  options: PolicyProjectionOptions = {},
): ProjectorHandlerMap {
  return {
    "platform-policy.document.created": async (event) => {
      const data = event.data as PolicyDocumentCreatedPayload;

      await db.query(
        `INSERT INTO platform_policy_documents (
           document_id,
           policy_key,
           context_name,
           schema_summary,
           status,
           value,
           effective_from,
           effective_until,
           created_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9
         )
         ON CONFLICT (document_id) DO UPDATE
         SET policy_key = EXCLUDED.policy_key,
             context_name = EXCLUDED.context_name,
             schema_summary = EXCLUDED.schema_summary,
             status = EXCLUDED.status,
             value = EXCLUDED.value,
             effective_from = EXCLUDED.effective_from,
             effective_until = EXCLUDED.effective_until,
             updated_at = EXCLUDED.updated_at`,
        [
          data.documentId,
          data.policyKey,
          data.contextName,
          data.schemaSummary,
          data.status,
          JSON.stringify(data.value),
          data.effectiveFrom,
          data.effectiveUntil,
          event.timing.recordedAt,
        ],
      );
      await insertPolicyDocumentHistory(db, {
        documentId: data.documentId,
        policyKey: data.policyKey,
        eventId: event.id,
        eventType: "created",
        actorUserId: data.actorUserId ?? event.audit.performedByUserId,
        status: data.status,
        value: data.value,
        effectiveFrom: data.effectiveFrom,
        effectiveUntil: data.effectiveUntil,
        recordedAt: event.timing.recordedAt,
      });
      options.onPolicyRevised?.(data.policyKey);
    },
    "platform-policy.document.revised": async (event) => {
      const data = event.data as PolicyDocumentRevisedPayload;

      await db.query(
        `UPDATE platform_policy_documents
         SET status = $2,
             value = $3::jsonb,
             effective_from = $4,
             effective_until = $5,
             updated_at = $6
         WHERE document_id = $1`,
        [
          data.documentId,
          data.status,
          JSON.stringify(data.value),
          data.effectiveFrom,
          data.effectiveUntil,
          event.timing.recordedAt,
        ],
      );
      await insertPolicyDocumentHistory(db, {
        documentId: data.documentId,
        policyKey: data.policyKey,
        eventId: event.id,
        eventType: "revised",
        actorUserId: data.actorUserId ?? event.audit.performedByUserId,
        status: data.status,
        value: data.value,
        effectiveFrom: data.effectiveFrom,
        effectiveUntil: data.effectiveUntil,
        recordedAt: event.timing.recordedAt,
      });
      options.onPolicyRevised?.(data.policyKey);
    },
  };
}

async function insertPolicyDocumentHistory(
  db: PgQueryable,
  params: Readonly<{
    documentId: string;
    policyKey: string;
    eventId: string;
    eventType: "created" | "revised";
    actorUserId: string;
    status: string;
    value: unknown;
    effectiveFrom: string;
    effectiveUntil: string | null;
    recordedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO platform_policy_document_history (
       document_id,
       policy_key,
       event_id,
       event_type,
       actor_user_id,
       status,
       value,
       effective_from,
       effective_until,
       recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10
     )
     ON CONFLICT (event_id) DO UPDATE
     SET document_id = EXCLUDED.document_id,
         policy_key = EXCLUDED.policy_key,
         event_type = EXCLUDED.event_type,
         actor_user_id = EXCLUDED.actor_user_id,
         status = EXCLUDED.status,
         value = EXCLUDED.value,
         effective_from = EXCLUDED.effective_from,
         effective_until = EXCLUDED.effective_until,
         recorded_at = EXCLUDED.recorded_at`,
    [
      params.documentId,
      params.policyKey,
      params.eventId,
      params.eventType,
      params.actorUserId,
      params.status,
      JSON.stringify(params.value),
      params.effectiveFrom,
      params.effectiveUntil,
      params.recordedAt,
    ],
  );
}
