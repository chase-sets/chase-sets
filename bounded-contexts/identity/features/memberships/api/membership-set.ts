import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { parseRoleKey, type RoleKey } from "../../../support/runtime-support/common";

export const MEMBERSHIP_SET_EVENT = "identity.user-membership-set.membership-recorded";
export const MEMBERSHIP_SET_PREFIX = "identity.user-membership-set-usr_";
export const MEMBERSHIP_SOURCE_PREFIX = "identity.membership-";
const HISTORY_BOUND = 100_000;
type MembershipSourceEvent = Pick<
  StoredEvent,
  "streamId" | "tenantId" | "streamVersion" | "eventId" | "eventType" | "payload"
>;

export type MembershipSetFact = Readonly<{
  membershipId: string;
  userId: string;
  accountId: string;
  roleKey: RoleKey;
  status: "active" | "revoked";
  sourceRevision: number;
  sourceEventId: string;
  sourceEventType: string;
}>;
export type MembershipSetState = Readonly<{
  version: number;
  memberships: readonly MembershipSetFact[];
  facts: readonly MembershipSetFact[];
}>;
export type MembershipHistoryReader = Pick<EventStore, "readStream"> &
  Readonly<{
    readVersion: (streamId: string) => Promise<number>;
  }>;

async function completeHistory(reader: MembershipHistoryReader, streamId: string) {
  const history = await readCompleteStream(reader, { streamId, maxEvents: HISTORY_BOUND });
  if ((await reader.readVersion(streamId)) !== history.length)
    membershipSetUnknown("truncated or concurrently changed history");
  return history;
}

export function membershipSetUnknown(reason: string): never {
  throw new Error(`MEMBERSHIP_SET_UNKNOWN: ${reason}`);
}

function closed(value: object, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) membershipSetUnknown("expected fact object");
  const actual = Object.keys(value).sort();
  if (actual.join("|") !== [...keys].sort().join("|")) membershipSetUnknown("unexpected fact shape");
}

function typed(value: unknown, prefix: "usr" | "acc" | "mbr" | "evt"): string {
  try {
    if (typeof value !== "string") membershipSetUnknown(`invalid ${prefix} identity`);
    return parseTypedId(value, prefix);
  } catch {
    return membershipSetUnknown(`invalid ${prefix} identity`);
  }
}

function role(value: unknown): RoleKey {
  return parseRoleKey(value) ?? membershipSetUnknown("invalid role");
}

export function membershipFacts(
  history: readonly MembershipSourceEvent[],
  streamId: string,
  tenantId: string,
): MembershipSetFact[] {
  const facts: MembershipSetFact[] = [];
  const eventIds = new Set<string>();
  for (const event of history) {
    if (event.streamId !== streamId || event.tenantId !== tenantId || event.streamVersion !== facts.length + 1)
      membershipSetUnknown("source identity, tenant or revision mismatch");
    const sourceEventId = typed(event.eventId, "evt");
    if (eventIds.has(sourceEventId)) membershipSetUnknown("duplicate source event");
    eventIds.add(sourceEventId);
    const previous = facts.at(-1);
    const payload = event.payload;
    let next: Omit<MembershipSetFact, "sourceRevision" | "sourceEventId" | "sourceEventType">;
    if (!previous) {
      if (event.eventType !== "identity.membership.granted") membershipSetUnknown("source must begin with grant");
      closed(payload, ["membershipId", "userId", "accountId", "roleKey"]);
      const membershipId = typed(payload.membershipId, "mbr");
      if (streamId !== `${MEMBERSHIP_SOURCE_PREFIX}${membershipId}`) membershipSetUnknown("source Membership mismatch");
      next = {
        membershipId,
        userId: typed(payload.userId, "usr"),
        accountId: typed(payload.accountId, "acc"),
        roleKey: role(payload.roleKey),
        status: "active",
      };
    } else {
      next = previous;
      switch (event.eventType) {
        case "identity.membership.role-changed": {
          closed(payload, ["roleKey"]);
          const roleKey = role(payload.roleKey);
          if (previous.status !== "active" || previous.roleKey === roleKey)
            membershipSetUnknown("invalid role transition");
          next = { ...previous, roleKey };
          break;
        }
        case "identity.membership.revoked":
          closed(payload, []);
          if (previous.status !== "active") membershipSetUnknown("invalid revocation");
          next = { ...previous, status: "revoked" };
          break;
        case "identity.membership.reinstated":
          closed(payload, []);
          if (previous.status !== "revoked") membershipSetUnknown("invalid reinstatement");
          next = { ...previous, status: "active" };
          break;
        default:
          membershipSetUnknown("unexpected source event");
      }
    }
    facts.push({ ...next, sourceRevision: event.streamVersion, sourceEventId, sourceEventType: event.eventType });
  }
  return facts;
}

export function foldMembershipSet(
  history: readonly StoredEvent[],
  userId: string,
  tenantId: string,
): MembershipSetState {
  typed(userId, "usr");
  const entries = new Map<string, MembershipSetFact>();
  const facts: MembershipSetFact[] = [];
  const sourceIds = new Set<string>();
  for (const event of history) {
    if (
      event.eventType !== MEMBERSHIP_SET_EVENT ||
      event.streamId !== `identity.user-membership-set-${userId}` ||
      event.tenantId !== tenantId ||
      event.streamVersion !== facts.length + 1
    )
      membershipSetUnknown("Set identity, tenant, revision or event mismatch");
    const p = event.payload;
    closed(p, [
      "membershipId",
      "userId",
      "accountId",
      "roleKey",
      "status",
      "sourceRevision",
      "sourceEventId",
      "sourceEventType",
    ]);
    const fact: MembershipSetFact = {
      membershipId: typed(p.membershipId, "mbr"),
      userId: typed(p.userId, "usr"),
      accountId: typed(p.accountId, "acc"),
      roleKey: role(p.roleKey),
      status: p.status === "active" || p.status === "revoked" ? p.status : membershipSetUnknown("invalid status"),
      sourceRevision:
        Number.isSafeInteger(p.sourceRevision) && Number(p.sourceRevision) > 0
          ? Number(p.sourceRevision)
          : membershipSetUnknown("invalid source revision"),
      sourceEventId: typed(p.sourceEventId, "evt"),
      sourceEventType: String(p.sourceEventType),
    };
    if (fact.userId !== userId || sourceIds.has(fact.sourceEventId))
      membershipSetUnknown("wrong User or duplicate source fact");
    const previous = entries.get(fact.membershipId);
    if (
      fact.sourceRevision !== (previous?.sourceRevision ?? 0) + 1 ||
      (previous && previous.accountId !== fact.accountId)
    )
      membershipSetUnknown("missing, duplicate or rebound source revision");
    const valid = !previous
      ? fact.sourceEventType === "identity.membership.granted" && fact.status === "active"
      : fact.sourceEventType === "identity.membership.role-changed"
        ? previous.status === "active" && fact.status === "active" && previous.roleKey !== fact.roleKey
        : fact.sourceEventType === "identity.membership.revoked"
          ? previous.status === "active" && fact.status === "revoked" && previous.roleKey === fact.roleKey
          : fact.sourceEventType === "identity.membership.reinstated" &&
            previous.status === "revoked" &&
            fact.status === "active" &&
            previous.roleKey === fact.roleKey;
    if (!valid) membershipSetUnknown("Set transition mismatch");
    sourceIds.add(fact.sourceEventId);
    facts.push(fact);
    entries.set(fact.membershipId, fact);
  }
  return {
    version: history.length,
    memberships: [...entries.values()].sort((a, b) => a.membershipId.localeCompare(b.membershipId)),
    facts,
  };
}

export async function readUserMembershipSet(
  reader: MembershipHistoryReader,
  userId: string,
  tenantId: string,
): Promise<MembershipSetState> {
  const streamId = `identity.user-membership-set-${typed(userId, "usr")}`;
  return foldMembershipSet(await completeHistory(reader, streamId), userId, tenantId);
}

/** Expands a command batch before its one atomic expected-version append. */
export async function planMembershipSetAppends(
  reader: MembershipHistoryReader,
  inputs: readonly AppendToStreamInput[],
  options: Readonly<{ reconcile?: boolean }> = {},
): Promise<readonly AppendToStreamInput[]> {
  if (inputs.some((input) => input.streamId.startsWith("identity.user-membership-set-")))
    membershipSetUnknown("caller-supplied Set facts");
  const result = [...inputs];
  const groups = new Map<
    string,
    { state: MembershipSetState; context: AppendToStreamInput["context"]; missing: MembershipSetFact[] }
  >();
  const seenStreams = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    if (!input.streamId.startsWith(MEMBERSHIP_SOURCE_PREFIX) || (!input.events.length && !options.reconcile)) continue;
    if (seenStreams.has(input.streamId)) membershipSetUnknown("duplicate Membership batch participant");
    seenStreams.add(input.streamId);
    const history = await completeHistory(reader, input.streamId);
    if (input.expectedVersion === "any") membershipSetUnknown("unguarded Membership append");
    if ((input.expectedVersion === "no_stream" ? 0 : input.expectedVersion) !== history.length)
      throw createEventStoreError("concurrency_conflict", "Membership source expected version mismatch.");
    const events = input.events.map((event) => ({ ...event, eventId: event.eventId ?? createId("evt") }));
    result[index] = { ...input, events };
    const proposed = events.map((event, offset) => ({
      ...event,
      eventType: event.eventType,
      payload: event.payload,
      eventId: event.eventId,
      streamId: input.streamId,
      streamVersion: history.length + offset + 1,
      tenantId: input.context.tenantId,
    }));
    const facts = membershipFacts([...history, ...proposed], input.streamId, input.context.tenantId);
    if (!facts.length) membershipSetUnknown("missing source grant");
    const userId = facts[0].userId;
    let group = groups.get(userId);
    if (!group) {
      group = {
        state: await readUserMembershipSet(reader, userId, input.context.tenantId),
        context: input.context,
        missing: [],
      };
      groups.set(userId, group);
    }
    if (group.context.tenantId !== input.context.tenantId) membershipSetUnknown("cross-tenant Set batch");
    const recorded = group.state.facts.filter((fact) => fact.membershipId === facts[0].membershipId);
    if (recorded.length > history.length) membershipSetUnknown("Set is ahead of source");
    for (const [ordinal, fact] of recorded.entries()) {
      if (JSON.stringify(fact) !== JSON.stringify(facts[ordinal])) membershipSetUnknown("source-to-Set mismatch");
    }
    group.missing.push(...facts.slice(recorded.length));
  }
  for (const [userId, group] of groups) {
    if (!group.missing.length) continue;
    result.push({
      streamId: `identity.user-membership-set-${userId}`,
      expectedVersion: group.state.version,
      context: group.context,
      events: group.missing.map((fact) => ({ eventType: MEMBERSHIP_SET_EVENT, payload: { ...fact } })),
    });
  }
  return result;
}
