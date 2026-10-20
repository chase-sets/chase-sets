import { extractIdFromStreamId, parseMarketplaceListingAutoUnlistedPayload, parseMarketplaceListingOperatorUnlistedPayload } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AppealableEnforcementAction } from "../domain/domain";

export type AccountAppealSource = "identity.account.suspended" | "identity.account.reactivated" | "identity.account.closed" | "marketplace.listing.operator-unlisted" | "marketplace.listing.auto-unlisted" | "enf" | "lea";
type ActionIdentity = Readonly<{ id: string; accountId: string; occurredAt: string }>;
type ActionRow = Readonly<{ appealable_action_id: string; owner_account_id: string; source: AccountAppealSource; source_stream_id: string; source_stream_version: number; conflict_state: string }>;
function record(value: unknown): Readonly<Record<string, unknown>> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null; }

function identityAction(event: TransportEvent, accountId: string): ActionIdentity | null {
  const data = record(event.data);
  if (data && Object.keys(data).length === 0) return null;
  const enforcement = record(data?.enforcement);
  if (enforcement?.version !== 1 || typeof enforcement.enforcementActionId !== "string") throw new Error(`Malformed modern ${event.type} payload.`);
  return { id: enforcement.enforcementActionId, accountId, occurredAt: event.timing.occurredAt };
}

async function insert(db: PgQueryable, event: TransportEvent, source: AccountAppealSource, action: ActionIdentity): Promise<void> {
  const result = await db.query<{ conflict_state: string }>(
    `INSERT INTO platform_operations_account_appealable_actions
      (appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, occurred_at, source_event_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (appealable_action_id) DO UPDATE SET conflict_state = 'conflicted', conflict_reason = 'immutable attribution changed'
       WHERE platform_operations_account_appealable_actions.owner_account_id <> EXCLUDED.owner_account_id
          OR platform_operations_account_appealable_actions.source_stream_id <> EXCLUDED.source_stream_id
          OR platform_operations_account_appealable_actions.source_stream_version <> EXCLUDED.source_stream_version
     RETURNING conflict_state`,
    [action.id, action.accountId, source, event.streamId, event.streamVersion, action.occurredAt, event.type],
  );
  if (result.rows.some((row) => row.conflict_state === "conflicted")) throw new Error(`Appealable action ${action.id} has conflicting source attribution.`);
}

function marketplaceAction(parsed: Readonly<Record<string, unknown>>): ActionIdentity | null {
  const value = record(parsed.listingEnforcement);
  if (!value || typeof value.listingEnforcementActionId !== "string" || typeof value.accountId !== "string" || typeof value.occurredAt !== "string") return null;
  return { id: value.listingEnforcementActionId, accountId: value.accountId, occurredAt: value.occurredAt };
}

export function buildAccountAppealInterestProjectionHandlers(db: PgQueryable, selectedEventTypes?: readonly string[]): ProjectorHandlerMap {
  const identity = async (event: TransportEvent) => {
    const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
    const action = identityAction(event, accountId);
    if (action) await insert(db, event, "enf", action);
  };
  const handlers: ProjectorHandlerMap = {
    "identity.account.suspended": identity,
    "identity.account.reactivated": identity,
    "identity.account.closed": identity,
    "marketplace.listing.operator-unlisted": async (event) => {
      let parsed;
      try { parsed = parseMarketplaceListingOperatorUnlistedPayload(event.data); } catch (error) { throw new Error(`Malformed modern ${event.type} payload.`, { cause: error }); }
      const action = marketplaceAction(record(parsed)!);
      if (action) await insert(db, event, "lea", action);
    },
    "marketplace.listing.auto-unlisted": async (event) => {
      let parsed;
      try { parsed = parseMarketplaceListingAutoUnlistedPayload(event.data); } catch (error) { throw new Error(`Malformed modern ${event.type} payload.`, { cause: error }); }
      const action = marketplaceAction(record(parsed)!);
      if (action) await insert(db, event, "lea", action);
    },
  };
  if (!selectedEventTypes) return handlers;
  return Object.fromEntries(selectedEventTypes.flatMap((eventType) => (handlers[eventType] ? [[eventType, handlers[eventType]]] : [])));
}

export async function resolveAccountAppealableAction(db: PgQueryable, actionId: string): Promise<(AppealableEnforcementAction & { conflicted?: boolean }) | null> {
  const result = await db.query<ActionRow>(`SELECT appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, conflict_state FROM platform_operations_account_appealable_actions WHERE appealable_action_id = $1`, [actionId]);
  const row = result.rows[0];
  return row ? { appealableActionId: row.appealable_action_id as AppealableEnforcementAction["appealableActionId"], ownerAccountId: row.owner_account_id as AppealableEnforcementAction["ownerAccountId"], source: row.source === "lea" ? "lea" : "enf", sourceStreamId: row.source_stream_id, sourceStreamVersion: row.source_stream_version, ...(row.conflict_state === "conflicted" ? { conflicted: true } : {}) } : null;
}

export function buildAccountAppealProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const filed = async (event: TransportEvent) => {
    const data = record(event.data)!;
    await db.query(`INSERT INTO platform_operations_account_appeals (appeal_id, tenant_id, account_id, appealable_action_id, statement, status, outcome, rationale, filed_by_user_id, operator_user_id, note, stream_version, updated_at) VALUES ($1,$2,$3,$4,$5,'filed',NULL,NULL,$6,NULL,NULL,$7,now()) ON CONFLICT (appeal_id) DO NOTHING`, [data.appealId, data.tenantId, data.accountId, (data.action as Record<string, unknown>).appealableActionId, data.statement, data.filedByUserId, event.streamVersion]);
    await db.query(`INSERT INTO platform_operations_account_appeal_seller_history (appeal_id, account_id, appealable_action_id, statement, status, outcome, rationale, filed_by_user_id, stream_version, updated_at) VALUES ($1,$2,$3,$4,'filed',NULL,NULL,$5,$6,now()) ON CONFLICT (appeal_id) DO NOTHING`, [data.appealId, data.accountId, (data.action as Record<string, unknown>).appealableActionId, data.statement, data.filedByUserId, event.streamVersion]);
    await db.query(`INSERT INTO platform_operations_account_appeal_operator_history (appeal_id, status, outcome, rationale, operator_user_id, note, stream_version, updated_at) VALUES ($1,'filed',NULL,NULL,NULL,NULL,$2,now()) ON CONFLICT (appeal_id) DO NOTHING`, [data.appealId, event.streamVersion]);
  };
  const update = async (event: TransportEvent) => {
    const data = record(event.data)!;
    const status = event.type.endsWith("review-started") ? "in-review" : event.type.endsWith("withdrawn") ? "withdrawn" : String(data.outcome);
    const values = event.type.endsWith("outcome-recorded") ? [status, data.outcome, data.rationale, data.operatorUserId, data.note] : [status, null, null, null, null];
    const actionId = event.streamId.slice("platform-operations.account-appeal-".length);
    await db.query(`UPDATE platform_operations_account_appeals SET status=$1, outcome=$2, rationale=$3, operator_user_id=$4, note=$5, stream_version=$6, updated_at=now() WHERE appealable_action_id=$7 AND stream_version=$8`, [...values, event.streamVersion, actionId, event.streamVersion - 1]);
    await db.query(`UPDATE platform_operations_account_appeal_seller_history SET status=$1, outcome=$2, rationale=$3, stream_version=$4, updated_at=now() WHERE appealable_action_id=$5 AND stream_version=$6`, [status, data.outcome ?? null, data.rationale ?? null, event.streamVersion, actionId, event.streamVersion - 1]);
    await db.query(`UPDATE platform_operations_account_appeal_operator_history SET status=$1, outcome=$2, rationale=$3, operator_user_id=$4, note=$5, stream_version=$6, updated_at=now() WHERE appeal_id=(SELECT appeal_id FROM platform_operations_account_appeals WHERE appealable_action_id=$7) AND stream_version=$8`, [...values, event.streamVersion, actionId, event.streamVersion - 1]);
  };
  return {
    "platform-operations.account-appeal.filed": filed,
    "platform-operations.account-appeal.review-started": update,
    "platform-operations.account-appeal.outcome-recorded": update,
    "platform-operations.account-appeal.withdrawn": update,
  };
}
