import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CommercialTermsAttentionItem = Readonly<{
  id: string;
  kind: "upcoming-schedule" | "expiring-override";
  label: string;
  detail: string;
  attentionAt: string;
  href: string;
}>;

type CommercialTermsAttentionRow = Readonly<{
  document_id: string;
  document_kind: "schedule" | "agreement";
  label: string;
  account_id: string | null;
  attention_kind: "upcoming" | "expiring";
  attention_at: string;
}>;

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function toAttentionItem(row: CommercialTermsAttentionRow): CommercialTermsAttentionItem {
  const upcoming = row.attention_kind === "upcoming";
  return {
    id: `${row.document_kind}:${row.document_id}:${row.attention_kind}`,
    kind: upcoming ? "upcoming-schedule" : "expiring-override",
    label: row.label,
    detail: upcoming ? `Effective ${dateOnly(row.attention_at)}` : `Override expires ${dateOnly(row.attention_at)}`,
    attentionAt: row.attention_at,
    href:
      row.document_kind === "schedule"
        ? `/commerce/terms?schedule=${encodeURIComponent(row.document_id)}`
        : `/commerce/terms?agreement=${encodeURIComponent(row.document_id)}`,
  };
}

export async function listCommercialTermsEffectiveDateAttention(db: PgQueryable, now = new Date()) {
  const result = await db.query<CommercialTermsAttentionRow>(
    `SELECT document_id,
            document_kind,
            label,
            account_id,
            'upcoming' AS attention_kind,
            effective_from::text AS attention_at
     FROM platform_operations_commercial_terms_attention_pages
     WHERE document_kind = 'schedule'
       AND status = 'active'
       AND effective_from > $1
     UNION ALL
     SELECT document_id,
            document_kind,
            label,
            account_id,
            'expiring' AS attention_kind,
            effective_until::text AS attention_at
     FROM platform_operations_commercial_terms_attention_pages
     WHERE document_kind = 'agreement'
       AND status = 'active'
       AND effective_from <= $1
       AND effective_until > $1
     ORDER BY attention_at ASC, label ASC, document_id ASC`,
    [now.toISOString()],
  );
  return result.rows.map(toAttentionItem);
}
