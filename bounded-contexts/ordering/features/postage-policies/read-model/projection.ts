import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { OrderingPostagePolicyPayload, PostagePolicyStatus } from "../domain/domain";

async function insertHistory(
  db: PgQueryable,
  params: Readonly<{
    policyId: string;
    eventType: string;
    actorUserId: string;
    reason: string | null;
    status: PostagePolicyStatus;
    payload: OrderingPostagePolicyPayload;
    effectiveFrom: string;
    effectiveUntil: string | null;
    recordedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO ordering_postage_policy_history (
       policy_id,
       event_type,
       actor_user_id,
       reason,
       status,
       policy_version,
       payload,
       effective_from,
       effective_until,
       recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10
     )`,
    [
      params.policyId,
      params.eventType,
      params.actorUserId,
      params.reason,
      params.status,
      params.payload.policyVersion,
      JSON.stringify(params.payload),
      params.effectiveFrom,
      params.effectiveUntil,
      params.recordedAt,
    ],
  );
}

export function buildPostagePolicyProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.postage-policy.created": async (event) => {
      const data = event.data as {
        policyId: string;
        label: string;
        status: PostagePolicyStatus;
        payload: OrderingPostagePolicyPayload;
        effectiveFrom: string;
        effectiveUntil: string | null;
        createdByUserId: string;
      };

      await db.query(
        `INSERT INTO ordering_postage_policy_pages (
           policy_id,
           label,
           status,
           policy_version,
           payload,
           effective_from,
           effective_until,
           created_by_user_id,
           created_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9
         )
         ON CONFLICT (policy_id) DO UPDATE
         SET label = EXCLUDED.label,
             status = EXCLUDED.status,
             policy_version = EXCLUDED.policy_version,
             payload = EXCLUDED.payload,
             effective_from = EXCLUDED.effective_from,
             effective_until = EXCLUDED.effective_until,
             created_by_user_id = EXCLUDED.created_by_user_id,
             updated_at = EXCLUDED.updated_at`,
        [
          data.policyId,
          data.label,
          data.status,
          data.payload.policyVersion,
          JSON.stringify(data.payload),
          data.effectiveFrom,
          data.effectiveUntil,
          data.createdByUserId,
          event.timing.recordedAt,
        ],
      );
      await insertHistory(db, {
        policyId: data.policyId,
        eventType: "created",
        actorUserId: data.createdByUserId,
        reason: null,
        status: "draft",
        payload: data.payload,
        effectiveFrom: data.effectiveFrom,
        effectiveUntil: data.effectiveUntil,
        recordedAt: event.timing.recordedAt,
      });
    },
    "ordering.postage-policy.revised": async (event) => {
      const data = event.data as {
        policyId: string;
        label: string;
        payload: OrderingPostagePolicyPayload;
        effectiveFrom: string;
        effectiveUntil: string | null;
        revisedByUserId: string;
      };

      await db.query(
        `UPDATE ordering_postage_policy_pages
         SET label = $2,
             policy_version = $3,
             payload = $4::jsonb,
             effective_from = $5,
             effective_until = $6,
             updated_at = $7
         WHERE policy_id = $1`,
        [
          data.policyId,
          data.label,
          data.payload.policyVersion,
          JSON.stringify(data.payload),
          data.effectiveFrom,
          data.effectiveUntil,
          event.timing.recordedAt,
        ],
      );
      await insertHistory(db, {
        policyId: data.policyId,
        eventType: "revised",
        actorUserId: data.revisedByUserId,
        reason: null,
        status: "draft",
        payload: data.payload,
        effectiveFrom: data.effectiveFrom,
        effectiveUntil: data.effectiveUntil,
        recordedAt: event.timing.recordedAt,
      });
    },
    "ordering.postage-policy.activated": async (event) => {
      const data = event.data as {
        policyId: string;
        activatedByUserId: string;
        activationReason: string;
      };

      const existing = await db.query<{
        payload: OrderingPostagePolicyPayload;
        effective_from: string;
        effective_until: string | null;
      }>(
        `SELECT payload, effective_from, effective_until
         FROM ordering_postage_policy_pages
         WHERE policy_id = $1`,
        [data.policyId],
      );

      await db.query(
        `UPDATE ordering_postage_policy_pages
         SET status = 'active',
             activation_reason = $2,
             activated_at = $3,
             retired_at = NULL,
             updated_at = $3
         WHERE policy_id = $1`,
        [data.policyId, data.activationReason, event.timing.recordedAt],
      );
      const row = existing.rows[0];
      if (row) {
        await insertHistory(db, {
          policyId: data.policyId,
          eventType: "activated",
          actorUserId: data.activatedByUserId,
          reason: data.activationReason,
          status: "active",
          payload: row.payload,
          effectiveFrom: row.effective_from,
          effectiveUntil: row.effective_until,
          recordedAt: event.timing.recordedAt,
        });
      }
    },
    "ordering.postage-policy.retired": async (event) => {
      const data = event.data as {
        policyId: string;
        retiredByUserId: string;
        retirementReason: string;
      };

      const existing = await db.query<{
        payload: OrderingPostagePolicyPayload;
        effective_from: string;
        effective_until: string | null;
      }>(
        `SELECT payload, effective_from, effective_until
         FROM ordering_postage_policy_pages
         WHERE policy_id = $1`,
        [data.policyId],
      );

      await db.query(
        `UPDATE ordering_postage_policy_pages
         SET status = 'retired',
             retired_at = $2,
             updated_at = $2
         WHERE policy_id = $1`,
        [data.policyId, event.timing.recordedAt],
      );
      const row = existing.rows[0];
      if (row) {
        await insertHistory(db, {
          policyId: data.policyId,
          eventType: "retired",
          actorUserId: data.retiredByUserId,
          reason: data.retirementReason,
          status: "retired",
          payload: row.payload,
          effectiveFrom: row.effective_from,
          effectiveUntil: row.effective_until,
          recordedAt: event.timing.recordedAt,
        });
      }
    },
  };
}
