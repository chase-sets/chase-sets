import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type CommercialTermsPolicyPayload = Readonly<{
  documentId: string;
  policyKey: string;
  status: string;
  value: unknown;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function documentKind(policyKey: string): "schedule" | "agreement" | null {
  if (policyKey.startsWith("commercial-terms.schedule.")) return "schedule";
  if (policyKey.startsWith("commercial-terms.agreement.")) return "agreement";
  return null;
}

async function projectCommercialTermsPolicy(db: PgQueryable, data: CommercialTermsPolicyPayload, recordedAt: string) {
  const kind = documentKind(data.policyKey);
  if (!kind) return;

  const value = recordValue(data.value);
  const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : data.documentId;
  const accountId = kind === "agreement" && typeof value.accountId === "string" ? value.accountId : null;

  await db.query(
    `INSERT INTO platform_operations_commercial_terms_attention_pages (
       document_id,
       document_kind,
       label,
       account_id,
       status,
       effective_from,
       effective_until,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (document_id) DO UPDATE SET
       document_kind = EXCLUDED.document_kind,
       label = EXCLUDED.label,
       account_id = EXCLUDED.account_id,
       status = EXCLUDED.status,
       effective_from = EXCLUDED.effective_from,
       effective_until = EXCLUDED.effective_until,
       updated_at = EXCLUDED.updated_at`,
    [data.documentId, kind, label, accountId, data.status, data.effectiveFrom, data.effectiveUntil, recordedAt],
  );
}

export function buildCommercialTermsEffectiveDateAttentionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "platform-policy.document.created": (event) =>
      projectCommercialTermsPolicy(db, event.data as CommercialTermsPolicyPayload, event.timing.recordedAt),
    "platform-policy.document.revised": (event) =>
      projectCommercialTermsPolicy(db, event.data as CommercialTermsPolicyPayload, event.timing.recordedAt),
  };
}
