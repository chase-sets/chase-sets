import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  compareGlobalPosition,
  EVENT_STORE_READ_PAGE_SIZE_MAX,
  parseGlobalPosition,
  ZERO_GLOBAL_POSITION,
  type AppendToStreamInput,
  type EventStoreContext,
  type GlobalPosition,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { readGapSafeEventStoreHead, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { IdentityMutationPersistence, IdentityMutationTransaction } from "../../account-management/api/fences";
import { normalizeLabel } from "../../../support/runtime-support/common";
import { decideUser, evolveUser, initialUserState, type UserEvent, type UserState } from "../domain/domain";

/**
 * Social Login Ownership Claim: one stream per provider subject decides which
 * User owns it. The owner never changes; a contradiction marks the subject
 * `repair-required`. The raw subject never enters a stream id, scope, payload,
 * signal or response -- only its `linkKey`.
 */
const SOCIAL_LOGIN_LINKED = "identity.user.social-login-linked";
const CLAIMED = "identity.social-login-ownership.claimed";
const REPAIR_REQUIRED = "identity.social-login-ownership.repair-required";
const CAUGHT_UP = "identity.social-login-ownership.caught-up";
const CLAIM_STREAM_PREFIX = "identity.social-login-ownership-";
const USER_STREAM_PREFIX = "identity.user-";
export const SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM = "identity.social-login-ownership-catch-up";
const SIGNAL_USER_ID_LIMIT = 10;

export type SocialLoginProviderName = "google" | "facebook";
export type SocialLoginSubjectResolution =
  | Readonly<{ status: "unclaimed" }>
  | Readonly<{ status: "owned"; userId: string }>
  | Readonly<{ status: "repair-required" }>;
export type SocialLoginLinkOutcome =
  | Readonly<{ outcome: "linked"; userId: string; version: number; state: UserState }>
  | Readonly<{ outcome: "already-linked" }>
  | Readonly<{ outcome: "repair-required" }>;
export type SocialLoginOwnershipDeps = Readonly<{
  mutationPersistence: IdentityMutationPersistence;
  pool: PgTransactionalPool;
}>;
export type SocialLoginOwnershipCatchUp = Readonly<{
  horizon: GlobalPosition;
  claimed: number;
  repairRequired: number;
}>;

/** Event history this module cannot read as a closed ownership fact; fails closed with a bounded code. */
export class SocialLoginOwnershipHistoryError extends Error {
  readonly code = "social_login_ownership_history_invalid";
  constructor() {
    super("Social login ownership history is invalid.");
    this.name = "SocialLoginOwnershipHistoryError";
  }
}

export function socialLoginLinkKey(providerName: string, providerSubject: string): string {
  return createHash("sha256")
    .update(`${providerName}:${normalizeLabel(providerSubject)}`, "utf8")
    .digest("hex");
}

function claimStreamId(linkKey: string) {
  return `${CLAIM_STREAM_PREFIX}${linkKey}`;
}

function claimScope(linkKey: string) {
  return `identity:social-login-ownership:${linkKey}`;
}

/** Bounded, subject-free projection signal for a link that names a second User; never halts the projector. */
export function reportSocialLoginLinkConflict(
  input: Readonly<{ providerName: string; providerSubject: string; userIds: readonly string[] }>,
) {
  console.warn("social_login_link_conflict", {
    providerName: input.providerName,
    linkKey: socialLoginLinkKey(input.providerName, input.providerSubject),
    userIds: [...new Set(input.userIds)].sort().slice(0, SIGNAL_USER_ID_LIMIT),
  });
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedBody(body: unknown, keys: readonly string[]) {
  return isPlainRecord(body) && Object.keys(body).every((key) => keys.includes(key)) ? body : null;
}

function boundedString(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const normalized = normalizeLabel(value);
  return normalized.length >= 1 && normalized.length <= max ? normalized : null;
}

function providerName(value: unknown): SocialLoginProviderName | null {
  return value === "google" || value === "facebook" ? value : null;
}

/** Closed Resolve input: `{ providerName, providerSubject }`, else `null` (400, no append). */
export function parseSocialLoginResolveBody(body: unknown) {
  const closed = closedBody(body, ["providerName", "providerSubject"]);
  const name = providerName(closed?.providerName);
  const subject = boundedString(closed?.providerSubject, 512);
  return name && subject ? { providerName: name, providerSubject: subject } : null;
}

/** Closed link input: `{ providerName, providerSubject, email }`, else `null` (400, no append). */
export function parseSocialLoginLinkBody(body: unknown) {
  const closed = closedBody(body, ["providerName", "providerSubject", "email"]);
  const subject = parseSocialLoginResolveBody(
    closed && { providerName: closed.providerName, providerSubject: closed.providerSubject },
  );
  const email = boundedString(closed?.email, 320);
  return subject && email ? { ...subject, email } : null;
}

type ClaimState =
  | Readonly<{ status: "unclaimed"; version: 0 }>
  | Readonly<{ status: "owned"; userId: string; version: number }>
  | Readonly<{ status: "repair-required"; userIds: readonly string[]; version: number }>;

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.length > 1 && value.every((entry) => typeof entry === "string" && entry)
    ? value
    : null;
}

/** Fold one claim stream; anything but `claimed`, `repair-required` or `claimed` then `repair-required` fails closed. */
function readClaim(history: readonly StoredEvent[], linkKey: string, name: string): ClaimState {
  let state: ClaimState = { status: "unclaimed", version: 0 };
  for (const [index, event] of history.entries()) {
    const payload = event.payload;
    if (event.streamVersion !== index + 1 || payload.linkKey !== linkKey || payload.providerName !== name) {
      throw new SocialLoginOwnershipHistoryError();
    }
    const userIds = stringList(payload.userIds);
    if (event.eventType === CLAIMED && state.status === "unclaimed" && typeof payload.userId === "string") {
      state = { status: "owned", userId: payload.userId, version: event.streamVersion };
    } else if (event.eventType === REPAIR_REQUIRED && state.status !== "repair-required" && userIds) {
      state = { status: "repair-required", userIds, version: event.streamVersion };
    } else {
      throw new SocialLoginOwnershipHistoryError();
    }
  }
  return state;
}

function readLinkFact(event: StoredEvent) {
  const subject = event.payload.providerSubject;
  const name = event.payload.providerName;
  const userId = event.streamId.startsWith(USER_STREAM_PREFIX) ? event.streamId.slice(USER_STREAM_PREFIX.length) : "";
  if (!userId || typeof name !== "string" || !name || typeof subject !== "string" || !normalizeLabel(subject)) {
    throw new SocialLoginOwnershipHistoryError();
  }
  return { userId, providerName: name, linkKey: socialLoginLinkKey(name, subject) };
}

async function readCatchUpHorizon(db: IdentityMutationTransaction["db"]) {
  const result = await db.query<{ horizon: unknown; stream_version: number | string }>(
    `SELECT payload->'horizon' AS horizon, stream_version
       FROM event_store_events
      WHERE stream_id = $1
      ORDER BY stream_version DESC
      LIMIT 1`,
    [SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM],
  );
  const row = result.rows[0];
  if (!row) return { horizon: ZERO_GLOBAL_POSITION, version: 0 };
  if (typeof row.horizon !== "string") throw new SocialLoginOwnershipHistoryError();
  return { horizon: parseGlobalPosition(row.horizon), version: Number(row.stream_version) };
}

function ownershipEvent(eventType: string, payload: JsonObject) {
  return { eventType, payload, eventId: createId("evt") };
}

/**
 * Idempotent horizon catch-up over event-store link history (never a
 * projection). Pages every `social-login-linked` event after the recorded
 * horizon up to one gap-safe head, then claims each unclaimed single-User
 * subject and marks any multi-User or claim-contradicting subject
 * `repair-required`. Appends nothing when no link event lies past the horizon,
 * and nothing when `recordUnchanged` is false and every such link already
 * agrees with its claim (a link transaction's refusal or retry appends nothing).
 *
 * Must run first in a transaction holding the catch-up scope, before that
 * transaction appends anything: the gap-safe head waits for every in-flight
 * appender, which would include this transaction once it appends.
 */
export async function catchUpSocialLoginOwnership(
  deps: SocialLoginOwnershipDeps,
  tx: IdentityMutationTransaction,
  context: EventStoreContext,
  options: Readonly<{ pageSize?: number; recordUnchanged?: boolean }> = {},
): Promise<SocialLoginOwnershipCatchUp | null> {
  const pageSize = options.pageSize ?? EVENT_STORE_READ_PAGE_SIZE_MAX;
  const recorded = await readCatchUpHorizon(tx.db);
  const head = await readGapSafeEventStoreHead(deps.pool);
  if (compareGlobalPosition(head, recorded.horizon) <= 0) return null;

  const subjects = new Map<string, { providerName: string; userIds: string[] }>();
  let after = recorded.horizon;
  for (;;) {
    const page = await deps.mutationPersistence.eventStore.readAll({
      eventTypes: [SOCIAL_LOGIN_LINKED],
      afterGlobalPosition: after,
      atOrBeforeGlobalPosition: head,
      limit: pageSize,
    });
    for (const event of page) {
      const fact = readLinkFact(event);
      const subject = subjects.get(fact.linkKey) ?? { providerName: fact.providerName, userIds: [] };
      if (!subject.userIds.includes(fact.userId)) subject.userIds.push(fact.userId);
      subjects.set(fact.linkKey, subject);
      after = event.globalPosition;
    }
    if (page.length < pageSize) break;
  }
  if (subjects.size === 0) return null;

  const inputs: AppendToStreamInput[] = [];
  let claimed = 0;
  let repairRequired = 0;
  for (const [linkKey, subject] of [...subjects].sort(([left], [right]) => left.localeCompare(right))) {
    const streamId = claimStreamId(linkKey);
    const claim = readClaim(await tx.read(streamId), linkKey, subject.providerName);
    if (claim.status === "repair-required") continue;
    const owners = claim.status === "owned" ? [claim.userId] : [];
    const userIds = [...owners, ...subject.userIds.filter((userId) => !owners.includes(userId))];
    if (claim.status === "owned" && userIds.length === 1) continue;
    const repair = userIds.length > 1;
    if (repair) repairRequired += 1;
    else claimed += 1;
    inputs.push({
      streamId,
      expectedVersion: claim.version || "no_stream",
      context,
      events: [
        repair
          ? ownershipEvent(REPAIR_REQUIRED, { providerName: subject.providerName, linkKey, userIds })
          : ownershipEvent(CLAIMED, { userId: userIds[0]!, providerName: subject.providerName, linkKey }),
      ],
    });
  }
  if (inputs.length === 0 && options.recordUnchanged === false) return null;
  const record = { horizon: head, claimed, repairRequired } as const;
  await tx.append!([
    ...inputs,
    {
      streamId: SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM,
      expectedVersion: recorded.version || "no_stream",
      context,
      events: [ownershipEvent(CAUGHT_UP, record)],
    },
  ]);
  return record;
}

/**
 * Lock-free probe: does any link event lie past the recorded horizon? An
 * uncommitted link is invisible here and to every reader alike; the catch-up
 * itself is the gap-safe step.
 */
async function hasLinkHistoryPastHorizon(pool: PgTransactionalPool) {
  const result = await pool.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM event_store_events
        WHERE event_type = $2
          AND global_position > COALESCE((
            SELECT (payload->>'horizon')::bigint FROM event_store_events
             WHERE stream_id = $1 ORDER BY stream_version DESC LIMIT 1), 0)
     ) AS pending`,
    [SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM, SOCIAL_LOGIN_LINKED],
  );
  return result.rows[0]?.pending === true;
}

const CATCH_UP_SCOPE = SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM;

/** Resolve one subject from its claim; takes the catch-up lock only when link history lies past the horizon. */
export async function resolveSocialLoginSubject(
  deps: SocialLoginOwnershipDeps,
  input: Readonly<{ providerName: SocialLoginProviderName; providerSubject: string }>,
  context: EventStoreContext,
): Promise<SocialLoginSubjectResolution> {
  if (await hasLinkHistoryPastHorizon(deps.pool)) {
    await deps.mutationPersistence.transaction([CATCH_UP_SCOPE], (tx) =>
      catchUpSocialLoginOwnership(deps, tx, context),
    );
  }
  const linkKey = socialLoginLinkKey(input.providerName, input.providerSubject);
  const history = await readCompleteStream(deps.mutationPersistence.eventStore, {
    streamId: claimStreamId(linkKey),
    maxEvents: 2,
  });
  const claim = readClaim(history, linkKey, input.providerName);
  return claim.status === "owned" ? { status: "owned", userId: claim.userId } : { status: claim.status };
}

function foldUser(history: readonly StoredEvent[]): UserState {
  return history.reduce(
    (state, event) => evolveUser(state, { type: event.eventType, data: event.payload } as UserEvent),
    initialUserState,
  );
}

/**
 * Link one subject to one User atomically with its claim: catch-up, claim
 * decision, `EnableAuthMethod` and `LinkSocialLogin` share one transaction
 * under the catch-up and claim scopes. Another owner or a `repair-required`
 * subject appends nothing; a repeated link by the owner appends nothing.
 */
export async function linkSocialLogin(
  deps: SocialLoginOwnershipDeps,
  input: Readonly<{ userId: string; providerName: SocialLoginProviderName; providerSubject: string; email: string }>,
  context: EventStoreContext,
): Promise<SocialLoginLinkOutcome> {
  const providerSubject = normalizeLabel(input.providerSubject);
  const linkKey = socialLoginLinkKey(input.providerName, providerSubject);
  return deps.mutationPersistence.transaction<SocialLoginLinkOutcome>(
    [CATCH_UP_SCOPE, claimScope(linkKey)],
    async (tx) => {
      await catchUpSocialLoginOwnership(deps, tx, context, { recordUnchanged: false });
      const claim = readClaim(await tx.read(claimStreamId(linkKey)), linkKey, input.providerName);
      if (claim.status === "repair-required") return { outcome: "repair-required" };
      if (claim.status === "owned" && claim.userId !== input.userId) return { outcome: "already-linked" };

      const userStreamId = `${USER_STREAM_PREFIX}${input.userId}`;
      const userHistory = await tx.read(userStreamId);
      const prior = foldUser(userHistory);
      const linked = prior.socialLoginLinks.some(
        (link) => link.providerName === input.providerName && link.providerSubject === providerSubject,
      );
      const enable = linked ? [] : decideUser(prior, { type: "EnableAuthMethod", authMethod: "social-login" });
      const afterEnable = enable.reduce(evolveUser, prior);
      const link = decideUser(afterEnable, {
        type: "LinkSocialLogin",
        providerName: input.providerName,
        providerSubject,
        email: input.email,
        linkedAt: new Date().toISOString(),
      });
      const events = [...enable, ...link];
      const claimInputs: AppendToStreamInput[] =
        claim.status === "unclaimed"
          ? [
              {
                streamId: claimStreamId(linkKey),
                expectedVersion: "no_stream",
                context,
                events: [ownershipEvent(CLAIMED, { userId: input.userId, providerName: input.providerName, linkKey })],
              },
            ]
          : [];
      const userInputs: AppendToStreamInput[] =
        events.length > 0
          ? [
              {
                streamId: userStreamId,
                expectedVersion: userHistory.length || "no_stream",
                context,
                events: events.map((event) => ownershipEvent(event.type, event.data as JsonObject)),
              },
            ]
          : [];
      if (claimInputs.length + userInputs.length > 0) await tx.append!([...claimInputs, ...userInputs]);
      return {
        outcome: "linked",
        userId: input.userId,
        version: userHistory.length + events.length,
        state: link.reduce(evolveUser, afterEnable),
      };
    },
  );
}
