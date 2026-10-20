import {
  parseMarketplaceListingAutoUnlistedPayload,
  parseMarketplaceListingOperatorUnlistedPayload,
} from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type AppealSource = "enf" | "lea";
type ActionIdentity = Readonly<{ id: string; accountId: string; occurredAt: string }>;
type ActionRow = Readonly<{
  appealable_action_id: string;
  owner_account_id: string;
  source: AppealSource;
  source_stream_id: string;
  source_stream_version: number;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function identityAction(event: TransportEvent, accountId: string): ActionIdentity | null {
  const data = record(event.data);
  const enforcement = record(data?.enforcement);
  if (enforcement?.version !== 1 || typeof enforcement.enforcementActionId !== "string") return null;
  return { id: enforcement.enforcementActionId, accountId, occurredAt: event.timing.occurredAt };
}

async function insert(
  db: PgQueryable,
  event: TransportEvent,
  source: AppealSource,
  action: ActionIdentity,
): Promise<void> {
  await db.query(
    `INSERT INTO platform_operations_account_appealable_actions
      (appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, occurred_at, source_event_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (appealable_action_id) DO NOTHING`,
    [action.id, action.accountId, source, event.streamId, event.streamVersion, action.occurredAt, event.type],
  );
}

export function buildAccountAppealInterestProjectionHandlers(
  db: PgQueryable,
  selectedEventTypes?: readonly string[],
): ProjectorHandlerMap {
  const identity = async (event: TransportEvent) => {
    const accountId = event.streamId.replace(/^identity\.account-/, "");
    const action = identityAction(event, accountId);
    if (action && accountId) await insert(db, event, "enf", action);
  };

  const handlers: ProjectorHandlerMap = {
    "identity.account.suspended": identity,
    "identity.account.reactivated": identity,
    "identity.account.closed": identity,
    "marketplace.listing.operator-unlisted": async (event) => {
      try {
        const parsed = parseMarketplaceListingOperatorUnlistedPayload(event.data);
        await insert(db, event, "lea", {
          id: parsed.listingEnforcement.listingEnforcementActionId,
          accountId: parsed.listingEnforcement.accountId,
          occurredAt: parsed.listingEnforcement.occurredAt,
        });
      } catch {
        // Legacy or malformed records never become authority.
      }
    },
    "marketplace.listing.auto-unlisted": async (event) => {
      try {
        const parsed = parseMarketplaceListingAutoUnlistedPayload(event.data);
        if ("listingEnforcement" in parsed) {
          await insert(db, event, "lea", {
            id: parsed.listingEnforcement.listingEnforcementActionId,
            accountId: parsed.listingEnforcement.accountId,
            occurredAt: parsed.listingEnforcement.occurredAt,
          });
        }
      } catch {
        // Legacy or malformed records never become authority.
      }
    },
  };
  if (!selectedEventTypes) return handlers;
  return Object.fromEntries(
    selectedEventTypes.flatMap((eventType) => (handlers[eventType] ? [[eventType, handlers[eventType]]] : [])),
  );
}

export async function resolveAccountAppealableAction(
  db: PgQueryable,
  actionId: string,
): Promise<{
  appealableActionId: string;
  ownerAccountId: string;
  source: AppealSource;
  sourceStreamId: string;
  sourceStreamVersion: number;
} | null> {
  const result = await db.query<ActionRow>(
    `SELECT appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version
     FROM platform_operations_account_appealable_actions
     WHERE appealable_action_id = $1`,
    [actionId],
  );
  const row = result.rows[0];
  return row
    ? {
        appealableActionId: row.appealable_action_id,
        ownerAccountId: row.owner_account_id,
        source: row.source,
        sourceStreamId: row.source_stream_id,
        sourceStreamVersion: row.source_stream_version,
      }
    : null;
}
