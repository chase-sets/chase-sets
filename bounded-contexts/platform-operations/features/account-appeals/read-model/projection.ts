import {
  accountEnforcementReasonCodes,
  accountEnforcementReversalReasonCodes,
  parseMarketplaceListingAutoUnlistedPayload,
  parseMarketplaceListingOperatorUnlistedPayload,
  type MarketplaceListingAutoUnlistedPayload,
  type MarketplaceListingOperatorUnlistedPayload,
} from "@chase-sets/event-core";
import {
  createProjectionHandlerSet,
  resolveProjectionDb,
  type ProjectorHandler,
  type ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  parseStrictTypedUlid,
  parseTypedId,
  type AccountId,
  type EnforcementActionId,
  type ListingEnforcementActionId,
} from "@chase-sets/primitives/typed-ids";
import type { AccountAppealEvent } from "../domain/domain";

export const ACCOUNT_APPEAL_PROJECTION_NAME = "account-appeal-projection";
export const ACCOUNT_APPEAL_PROJECTION_EVENT_TYPES = [
  "platform-operations.account-appeal.filed",
  "platform-operations.account-appeal.review-started",
  "platform-operations.account-appeal.outcome-recorded",
  "platform-operations.account-appeal.withdrawn",
] as const;

/** The seller model is deliberately an exact allowlist: internal operator fields never land here. */
export const ACCOUNT_APPEAL_SELLER_HISTORY_COLUMNS = [
  "appeal_id",
  "tenant_id",
  "account_id",
  "appealable_action_id",
  "appealable_action_source",
  "appealable_action_source_stream_id",
  "appealable_action_source_stream_version",
  "statement",
  "filed_by_user_id",
  "status",
  "outcome",
  "rationale",
  "stream_version",
] as const;

export const ACCOUNT_APPEAL_OPERATOR_HISTORY_COLUMNS = [
  ...ACCOUNT_APPEAL_SELLER_HISTORY_COLUMNS,
  "note",
  "operator_user_id",
] as const;

const ACCOUNT_APPEAL_STREAM_PREFIX = "platform-operations.account-appeal-";

type AppealProjectionRow = Readonly<{ stream_version: number }>;

function appealIdFromStream(event: Readonly<{ streamId: string }>): string {
  if (!event.streamId.startsWith(ACCOUNT_APPEAL_STREAM_PREFIX)) {
    throw new Error(`Account appeal projection received an invalid stream ${event.streamId}.`);
  }
  const appealId = event.streamId.slice(ACCOUNT_APPEAL_STREAM_PREFIX.length);
  if (!appealId) throw new Error("Account appeal projection received an empty appeal id.");
  return appealId;
}

function appealData(event: Readonly<{ data: Record<string, unknown> }>): Record<string, unknown> {
  return event.data;
}

async function projectionVersion(db: PgQueryable, table: string, appealId: string): Promise<number | null> {
  const result = await db.query<AppealProjectionRow>(`SELECT stream_version FROM ${table} WHERE appeal_id = $1`, [
    appealId,
  ]);
  const version = result.rows[0]?.stream_version;
  return version === undefined ? null : Number(version);
}

async function assertProjectionVersion(
  db: PgQueryable,
  appealId: string,
  eventVersion: number,
): Promise<"apply" | "noop"> {
  const [sellerVersion, operatorVersion] = await Promise.all([
    projectionVersion(db, "platform_operations_account_appeal_seller_history", appealId),
    projectionVersion(db, "platform_operations_account_appeal_operator_history", appealId),
  ]);
  if (
    sellerVersion !== null &&
    operatorVersion !== null &&
    sellerVersion >= eventVersion &&
    operatorVersion >= eventVersion
  )
    return "noop";
  if (sellerVersion === null || operatorVersion === null || sellerVersion !== operatorVersion) {
    throw new Error(`Account appeal projection version gap for ${appealId} at ${eventVersion}.`);
  }
  if (sellerVersion !== eventVersion - 1) {
    throw new Error(
      `Account appeal projection version gap for ${appealId}: stored ${sellerVersion}, event ${eventVersion}.`,
    );
  }
  return "apply";
}

async function insertFiled(
  db: PgQueryable,
  event: Extract<AccountAppealEvent, { type: "platform-operations.account-appeal.filed" }>,
) {
  const data = event.data;
  const action = data.action;
  const values = [
    data.appealId,
    data.tenantId,
    data.accountId,
    action.appealableActionId,
    action.source,
    action.sourceStreamId,
    action.sourceStreamVersion,
    data.statement,
    data.filedByUserId,
    "filed",
    null,
    null,
    null,
    1,
  ];
  await db.query(
    `INSERT INTO platform_operations_account_appeal_seller_history
       (appeal_id, tenant_id, account_id, appealable_action_id, appealable_action_source,
        appealable_action_source_stream_id, appealable_action_source_stream_version, statement,
        filed_by_user_id, status, outcome, rationale, stream_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    values,
  );
  await db.query(
    `INSERT INTO platform_operations_account_appeal_operator_history
       (appeal_id, tenant_id, account_id, appealable_action_id, appealable_action_source,
        appealable_action_source_stream_id, appealable_action_source_stream_version, statement,
        filed_by_user_id, status, outcome, rationale, stream_version, note, operator_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [...values, null, null],
  );
}

async function updateTransition(
  db: PgQueryable,
  appealId: string,
  eventVersion: number,
  status: string,
  outcome: string | null = null,
  rationale: string | null = null,
  note: string | null = null,
  operatorUserId: string | null = null,
): Promise<void> {
  const version = await assertProjectionVersion(db, appealId, eventVersion);
  if (version === "noop") return;
  const seller = await db.query(
    `UPDATE platform_operations_account_appeal_seller_history
        SET status=$2, outcome=$3, rationale=$4, stream_version=$5
      WHERE appeal_id=$1 AND stream_version=$6`,
    [appealId, status, outcome, rationale, eventVersion, eventVersion - 1],
  );
  if (seller.rowCount !== 1)
    throw new Error(`Account appeal projection update lost its seller version barrier for ${appealId}.`);
  const operator = await db.query(
    `UPDATE platform_operations_account_appeal_operator_history
        SET status=$2, outcome=$3, rationale=$4, stream_version=$5, note=$6, operator_user_id=$7
      WHERE appeal_id=$1 AND stream_version=$8`,
    [appealId, status, outcome, rationale, eventVersion, note, operatorUserId, eventVersion - 1],
  );
  if (operator.rowCount !== 1)
    throw new Error(`Account appeal projection update lost its operator version barrier for ${appealId}.`);
}

/** Same-context projection for the private appeal lifecycle; every write uses the runner transaction. */
export function buildAccountAppealProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const project: ProjectorHandler = async (event, context) => {
    const projectionDb = resolveProjectionDb(context, db);
    const appealId = appealIdFromStream(event);
    if (event.type === "platform-operations.account-appeal.filed") {
      if (event.streamVersion !== 1) throw new Error(`Account appeal filing must start at version 1 for ${appealId}.`);
      const existing = await projectionVersion(
        projectionDb,
        "platform_operations_account_appeal_seller_history",
        appealId,
      );
      if (existing !== null) {
        if (existing >= event.streamVersion) return;
        throw new Error(`Account appeal projection version gap for ${appealId}.`);
      }
      await insertFiled(
        projectionDb,
        event as unknown as Extract<AccountAppealEvent, { type: "platform-operations.account-appeal.filed" }>,
      );
      return;
    }
    if (event.type === "platform-operations.account-appeal.review-started") {
      await updateTransition(projectionDb, appealId, event.streamVersion, "in-review");
    } else if (event.type === "platform-operations.account-appeal.outcome-recorded") {
      const data = appealData(event);
      await updateTransition(
        projectionDb,
        appealId,
        event.streamVersion,
        String(data.outcome),
        String(data.outcome),
        String(data.rationale),
        String(data.note),
        String(data.operatorUserId),
      );
    } else if (event.type === "platform-operations.account-appeal.withdrawn") {
      await updateTransition(projectionDb, appealId, event.streamVersion, "withdrawn");
    }
  };
  return Object.fromEntries(ACCOUNT_APPEAL_PROJECTION_EVENT_TYPES.map((eventType) => [eventType, project]));
}

export function buildAccountAppealProjectionHandlerSet(db: PgQueryable) {
  return createProjectionHandlerSet({
    projectionName: ACCOUNT_APPEAL_PROJECTION_NAME,
    handlers: buildAccountAppealProjectionHandlers(db),
  });
}

/**
 * The Appealable Enforcement Action registry. Identity account enforcement and Marketplace listing
 * enforcement facts each name one action; this projection records who owns it and which source
 * fact created it, and the typed reader below is the only way to read a row back.
 *
 * Presence is the only authority. A missing row may simply not be projected yet, and a row whose
 * attribution was ever contradicted is frozen as conflicted; both read as the same indeterminate
 * singleton, never as "not appealable".
 */

const IDENTITY_SOURCES = [
  "identity.account.suspended",
  "identity.account.reactivated",
  "identity.account.closed",
] as const;
const MARKETPLACE_SOURCES = ["marketplace.listing.operator-unlisted", "marketplace.listing.auto-unlisted"] as const;

type IdentityAppealableSource = (typeof IDENTITY_SOURCES)[number];
type MarketplaceAppealableSource = (typeof MARKETPLACE_SOURCES)[number];

type Attribution = Readonly<{
  ownerAccountId: AccountId;
  sourceStreamId: string;
  sourceStreamVersion: number;
}>;

export type AppealableEnforcementAction =
  | (Attribution & Readonly<{ source: IdentityAppealableSource; appealableActionId: EnforcementActionId }>)
  | (Attribution & Readonly<{ source: MarketplaceAppealableSource; appealableActionId: ListingEnforcementActionId }>);

/** Absent, foreign, conflicted, and incomplete rows all read as this one frozen value. */
export const APPEALABLE_ACTION_INDETERMINATE = Object.freeze({ status: "indeterminate" } as const);
export type AppealableActionIndeterminate = typeof APPEALABLE_ACTION_INDETERMINATE;

const IDENTITY_ACCOUNT_STREAM_PREFIX = "identity.account-";
const MARKETPLACE_LISTING_STREAM_PREFIX = "marketplace.listing-";

const IDENTITY_REASON_CODES: Readonly<Record<IdentityAppealableSource, readonly string[]>> = {
  "identity.account.suspended": accountEnforcementReasonCodes,
  "identity.account.reactivated": accountEnforcementReversalReasonCodes,
  "identity.account.closed": accountEnforcementReasonCodes,
};

type RegistryRow = Readonly<{
  appealable_action_id: string;
  owner_account_id: string;
  source: string;
  source_stream_id: string;
  source_stream_version: number;
  conflict_state: string;
}>;

type ActionClaim = Readonly<{ appealableActionId: unknown; ownerAccountId: unknown }>;

function isIdentitySource(value: unknown): value is IdentityAppealableSource {
  return IDENTITY_SOURCES.some((source) => source === value);
}

function isMarketplaceSource(value: unknown): value is MarketplaceAppealableSource {
  return MARKETPLACE_SOURCES.some((source) => source === value);
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function hasExactKeys(input: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key));
}

function strictTypedUlid<Prefix extends string>(value: unknown, prefix: Prefix) {
  if (typeof value !== "string") return null;
  try {
    return parseStrictTypedUlid(value, prefix);
  } catch {
    return null;
  }
}

/** Owners are prefix-checked, not ULID-checked: seeded accounts such as `acc_seed_*` are valid owners. */
function ownerAccountId(value: unknown): AccountId | null {
  if (typeof value !== "string" || value.trim() !== value || value.length <= "acc_".length) return null;
  try {
    return parseTypedId(value, "acc");
  } catch {
    return null;
  }
}

/**
 * Builds the complete, frozen tuple, or null when any part is missing or malformed. Both the
 * projection (from a source event) and the reader (from a stored row) go through this one parser.
 */
function toAppealableAction(
  candidate: ActionClaim & Readonly<{ source: unknown; sourceStreamId: unknown; sourceStreamVersion: unknown }>,
): AppealableEnforcementAction | null {
  const owner = ownerAccountId(candidate.ownerAccountId);
  const { source, sourceStreamId, sourceStreamVersion } = candidate;
  if (
    owner === null ||
    typeof sourceStreamId !== "string" ||
    typeof sourceStreamVersion !== "number" ||
    !Number.isSafeInteger(sourceStreamVersion) ||
    sourceStreamVersion < 1
  ) {
    return null;
  }
  const attribution = { ownerAccountId: owner, sourceStreamId, sourceStreamVersion };
  if (isIdentitySource(source)) {
    const appealableActionId = strictTypedUlid(candidate.appealableActionId, "enf");
    return appealableActionId !== null && sourceStreamId === `${IDENTITY_ACCOUNT_STREAM_PREFIX}${owner}`
      ? Object.freeze({ ...attribution, source, appealableActionId })
      : null;
  }
  if (isMarketplaceSource(source)) {
    const appealableActionId = strictTypedUlid(candidate.appealableActionId, "lea");
    return appealableActionId !== null &&
      sourceStreamId.startsWith(MARKETPLACE_LISTING_STREAM_PREFIX) &&
      sourceStreamId.length > MARKETPLACE_LISTING_STREAM_PREFIX.length
      ? Object.freeze({ ...attribution, source, appealableActionId })
      : null;
  }
  return null;
}

function isAccountEnforcementReference(value: unknown): boolean {
  if (value === null) return true;
  const reference = plainRecord(value);
  return (
    reference !== null &&
    hasExactKeys(reference, ["kind", "supportRequestId"]) &&
    reference.kind === "support-request" &&
    strictTypedUlid(reference.supportRequestId, "sup") !== null
  );
}

/**
 * Exactly-empty data is a pre-enforcement legacy fact that names no action. Anything else must be
 * the closed version-1 `enforcement` record; the owner always comes from the account stream id.
 */
function identityClaim(event: Readonly<TransportEvent>, source: IdentityAppealableSource): ActionClaim | null {
  const data = plainRecord(event.data);
  if (data !== null && Object.keys(data).length === 0) return null;
  const enforcement = data !== null && hasExactKeys(data, ["enforcement"]) ? plainRecord(data.enforcement) : null;
  if (
    enforcement === null ||
    !hasExactKeys(enforcement, ["version", "enforcementActionId", "reason", "reference"]) ||
    enforcement.version !== 1 ||
    typeof enforcement.reason !== "string" ||
    !IDENTITY_REASON_CODES[source].includes(enforcement.reason) ||
    !isAccountEnforcementReference(enforcement.reference)
  ) {
    throw new Error(`Malformed modern ${source} payload on event ${event.id}.`);
  }
  return {
    appealableActionId: enforcement.enforcementActionId,
    ownerAccountId: event.streamId.startsWith(IDENTITY_ACCOUNT_STREAM_PREFIX)
      ? event.streamId.slice(IDENTITY_ACCOUNT_STREAM_PREFIX.length)
      : null,
  };
}

/** An auto-unlisted fact without `listingEnforcement` is historical and names no action. */
function marketplaceClaim(event: Readonly<TransportEvent>, source: MarketplaceAppealableSource): ActionClaim | null {
  let payload: MarketplaceListingOperatorUnlistedPayload | MarketplaceListingAutoUnlistedPayload;
  try {
    payload =
      source === "marketplace.listing.operator-unlisted"
        ? parseMarketplaceListingOperatorUnlistedPayload(event.data)
        : parseMarketplaceListingAutoUnlistedPayload(event.data);
  } catch (error) {
    throw new Error(`Malformed modern ${source} payload on event ${event.id}.`, { cause: error });
  }
  if (!("listingEnforcement" in payload)) return null;
  return {
    appealableActionId: payload.listingEnforcement.listingEnforcementActionId,
    ownerAccountId: payload.listingEnforcement.accountId,
  };
}

function appealableActionFromEvent(event: Readonly<TransportEvent>): AppealableEnforcementAction | null {
  const source = event.type;
  const claim = isIdentitySource(source)
    ? identityClaim(event, source)
    : isMarketplaceSource(source)
      ? marketplaceClaim(event, source)
      : null;
  if (claim === null) return null;
  const action = toAppealableAction({
    ...claim,
    source,
    sourceStreamId: event.streamId,
    sourceStreamVersion: event.streamVersion,
  });
  if (action === null) {
    throw new Error(`Event ${event.id} (${source}) does not carry a complete owner-attributed appealable action.`);
  }
  return action;
}

function changedAttribution(stored: RegistryRow, action: AppealableEnforcementAction): readonly string[] {
  return [
    stored.owner_account_id !== action.ownerAccountId ? "owner" : null,
    stored.source !== action.source ? "source" : null,
    stored.source_stream_id !== action.sourceStreamId ? "source stream id" : null,
    stored.source_stream_version !== action.sourceStreamVersion ? "source stream version" : null,
  ].filter((field): field is string => field !== null);
}

/**
 * The first tuple for an id wins and is never rewritten. A redelivery with a different tuple marks
 * the row conflicted through the autocommit `pool`, outside the projection transaction, so the
 * marker survives the rollback that the corruption error below causes.
 */
async function recordAppealableAction(
  pool: PgQueryable,
  projectionDb: PgQueryable,
  action: AppealableEnforcementAction,
): Promise<void> {
  const inserted = await projectionDb.query<{ appealable_action_id: string }>(
    `INSERT INTO platform_operations_account_appealable_actions
       (appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (appealable_action_id) DO NOTHING
     RETURNING appealable_action_id`,
    [
      action.appealableActionId,
      action.ownerAccountId,
      action.source,
      action.sourceStreamId,
      action.sourceStreamVersion,
    ],
  );
  if (inserted.rows.length === 1) return;

  const stored = await projectionDb.query<RegistryRow>(
    `SELECT appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, conflict_state
     FROM platform_operations_account_appealable_actions
     WHERE appealable_action_id = $1`,
    [action.appealableActionId],
  );
  const row = stored.rows[0];
  if (row === undefined) {
    throw new Error(`Appealable action ${action.appealableActionId} was neither inserted nor found.`);
  }
  const changed = changedAttribution(row, action);
  if (changed.length === 0) return;

  await pool.query(
    `UPDATE platform_operations_account_appealable_actions
     SET conflict_state = 'conflicted'
     WHERE appealable_action_id = $1`,
    [action.appealableActionId],
  );
  throw new Error(
    `Appealable action ${action.appealableActionId} was redelivered with a changed ${changed.join(", ")}; ` +
      "its registry row is marked conflicted.",
  );
}

/** Handlers for one source context's subscription to the registry interest projection. */
export function buildAccountAppealInterestProjectionHandlers(
  db: PgQueryable,
  sourceContextName: "identity" | "marketplace",
): ProjectorHandlerMap {
  const project: ProjectorHandler = async (event, context) => {
    const action = appealableActionFromEvent(event);
    if (action !== null) await recordAppealableAction(db, resolveProjectionDb(context, db), action);
  };
  const sources = sourceContextName === "identity" ? IDENTITY_SOURCES : MARKETPLACE_SOURCES;
  return Object.fromEntries(sources.map((source) => [source, project]));
}

/**
 * Returns the typed action only for a present, complete, non-conflicted row owned by
 * `ownerAccountId`. Every other case returns `APPEALABLE_ACTION_INDETERMINATE`, so a caller cannot
 * tell an unprojected action from a foreign or conflicted one.
 */
export async function readAppealableEnforcementAction(
  db: PgQueryable,
  request: Readonly<{
    appealableActionId: EnforcementActionId | ListingEnforcementActionId;
    ownerAccountId: AccountId;
  }>,
): Promise<AppealableEnforcementAction | AppealableActionIndeterminate> {
  const result = await db.query<RegistryRow>(
    `SELECT appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, conflict_state
     FROM platform_operations_account_appealable_actions
     WHERE appealable_action_id = $1`,
    [request.appealableActionId],
  );
  const row = result.rows[0];
  if (row === undefined || row.conflict_state !== "clear" || row.owner_account_id !== request.ownerAccountId) {
    return APPEALABLE_ACTION_INDETERMINATE;
  }
  return (
    toAppealableAction({
      appealableActionId: row.appealable_action_id,
      ownerAccountId: row.owner_account_id,
      source: row.source,
      sourceStreamId: row.source_stream_id,
      sourceStreamVersion: row.source_stream_version,
    }) ?? APPEALABLE_ACTION_INDETERMINATE
  );
}
