import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseMarketplaceListingAutoUnlistedPayload, parseMarketplaceListingOperatorUnlistedPayload } from "@chase-sets/event-core";

function identityAction(event: any, source: "enf", accountId: string, data: any): { id: string; occurredAt: string } | null {
  if (!data || !data.enforcement) return null;
  const e = data.enforcement;
  if (e.version !== 1 || typeof e.enforcementActionId !== "string") return null;
  return { id: e.enforcementActionId, occurredAt: event.timing?.occurredAt ?? event.timing?.recordedAt ?? new Date().toISOString() };
}

async function insert(db: PgQueryable, event: any, source: "enf" | "lea", action: { id: string; accountId: string; occurredAt: string }): Promise<void> {
  await db.query(`INSERT INTO platform_operations_account_appealable_actions (appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, occurred_at, source_event_type) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (appealable_action_id) DO NOTHING`, [action.id, action.accountId, source, event.streamId, event.streamVersion, action.occurredAt, event.type ?? event.eventType]);
}

export function buildAccountAppealInterestProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const identity = async (event: any) => {
    const accountId = String(event.streamId ?? "").replace(/^identity.account-/, "").replace(/^identity.account-/, "");
    const action = identityAction(event, "enf", accountId, event.data);
    if (action && accountId) await insert(db, event, "enf", { ...action, accountId });
  };
  return {
    "identity.account.suspended": identity,
    "identity.account.reactivated": identity,
    "identity.account.closed": identity,
    "marketplace.listing.operator-unlisted": async (event: any) => {
      try {
        const parsed = parseMarketplaceListingOperatorUnlistedPayload(event.data);
        await insert(db, event, "lea", { id: parsed.listingEnforcement.listingEnforcementActionId, accountId: parsed.listingEnforcement.accountId, occurredAt: parsed.listingEnforcement.occurredAt });
      } catch { /* legacy or malformed records never become authority */ }
    },
    "marketplace.listing.auto-unlisted": async (event: any) => {
      try {
        const parsed = parseMarketplaceListingAutoUnlistedPayload(event.data);
        if ("listingEnforcement" in parsed) await insert(db, event, "lea", { id: parsed.listingEnforcement.listingEnforcementActionId, accountId: parsed.listingEnforcement.accountId, occurredAt: parsed.listingEnforcement.occurredAt });
      } catch { /* legacy or malformed records never become authority */ }
    },
  };
}

export async function resolveAccountAppealableAction(db: PgQueryable, actionId: string): Promise<{ appealableActionId: string; ownerAccountId: string; source: "enf" | "lea"; sourceStreamId: string; sourceStreamVersion: number } | null> {
  const result = await db.query<any>(`SELECT appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version FROM platform_operations_account_appealable_actions WHERE appealable_action_id = $1`, [actionId]);
  const row = result.rows[0];
  return row ? { appealableActionId: row.appealable_action_id, ownerAccountId: row.owner_account_id, source: row.source, sourceStreamId: row.source_stream_id, sourceStreamVersion: row.source_stream_version } : null;
}
