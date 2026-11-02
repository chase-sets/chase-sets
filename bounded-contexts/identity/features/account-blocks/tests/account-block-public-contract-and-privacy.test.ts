import { describe, expect, it, vi } from "vitest";
import type { BcApiModule, BcEventSubscription } from "@chase-sets/bounded-context-module";
import { createSubscriptionRunner, resolveModuleSubscriptions } from "@chase-sets/bounded-context-runtime";
import {
  identityAccountBlockFactEventTypes,
  identityAccountBlockPrivateEventTypePrefix,
  isIdentityAccountBlockPrivateEventType,
  parseIdentityAccountBlockFactPayload,
  type ChaseSetsEventPayloads,
  type IdentityAccountBlockFactPayload,
} from "@chase-sets/event-core/public-event-payloads";
import type { GlobalPosition, StoredEvent } from "@chase-sets/event-core/storage";
import {
  isContextPrivateEventType,
  redactedTransportAudit,
  redactedTransportTiming,
  toTransportEvent,
} from "@chase-sets/event-core/transport";
import {
  assertAccountBlockBudgetLinks,
  foldAccountBlockBudgetHistory,
  foldAccountBlockPairHistory,
} from "../domain/authority";
import {
  AccountBlockAuthorityError,
  accountBlockBudgetRecordedEventType,
  accountBlockTransitionRecordedEventType,
} from "../domain/events";
import {
  alternatingSteps,
  blockedAccountId,
  blockingAccountId,
  buildSyntheticHistory,
  initiatingUserId,
  instant,
  otherBlockedAccountId,
  syntheticPair,
  type SyntheticHistory,
} from "./account-block-test-support";

type IsExactly<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
// Synthetic receipt-shaped type: the admission owner keeps receipts private, so any such type is in the private namespace.
const receiptShapedPrivateType = `${identityAccountBlockPrivateEventTypePrefix}receipt-recorded`;
const plantedTraceId = "trc_planted_trace_identity";
const plantedSessionId = "ses_planted_session_identity";
const plantedRecordedAt = "2031-03-04T05:06:07.890Z";

function refusalCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountBlockAuthorityError) return error.code;
    throw error;
  }
  return undefined;
}

/** Stores the event with every envelope field populated by values a leak would carry verbatim. */
function withPlantedEnvelope(event: StoredEvent): StoredEvent {
  return {
    ...event,
    globalPosition: "41" as GlobalPosition,
    metadata: { sessionId: plantedSessionId, traceId: plantedTraceId, recordedAt: plantedRecordedAt },
    occurredAt: plantedRecordedAt as never,
    recordedAt: plantedRecordedAt as never,
    performedByUserId: initiatingUserId,
    forAccountId: blockingAccountId,
    traceId: plantedTraceId as never,
    spanId: "spn_planted" as never,
    parentSpanId: "spn_planted_parent" as never,
    traceState: "planted=state",
  };
}

describe("account-block-public-contract-and-privacy: public fact", () => {
  it("publishes exactly the two Accounts under one Block and one Unblock type", () => {
    const fact = { blockingAccountId, blockedAccountId };
    expect(parseIdentityAccountBlockFactPayload(fact)).toEqual(fact);
    expect(identityAccountBlockFactEventTypes).toEqual({
      block: "identity.account-blocked",
      unblock: "identity.account-unblocked",
    });
    const registered = {
      blocked: true satisfies IsExactly<
        ChaseSetsEventPayloads["identity.account-blocked"],
        IdentityAccountBlockFactPayload
      >,
      unblocked: true satisfies IsExactly<
        ChaseSetsEventPayloads["identity.account-unblocked"],
        IdentityAccountBlockFactPayload
      >,
      noPrivateType: true satisfies IsExactly<
        Extract<keyof ChaseSetsEventPayloads, `${typeof identityAccountBlockPrivateEventTypePrefix}${string}`>,
        never
      >,
    };
    expect(Object.values(registered).every(Boolean)).toBe(true);
  });

  it.each([
    ["version", 1],
    ["transitionId", "abt_planted"],
    ["effectiveAt", plantedRecordedAt],
    ["recordedAt", plantedRecordedAt],
    ["occurredAt", plantedRecordedAt],
    ["traceId", plantedTraceId],
    ["sessionId", plantedSessionId],
    ["performedByUserId", initiatingUserId],
    ["reason", "harassment"],
    ["direction", "outbound"],
    ["activeBlockCount", 3],
    ["nested", { blockingAccountId }],
  ])("rejects a planted %s field without echoing its value", (field, value) => {
    let message = "";
    try {
      parseIdentityAccountBlockFactPayload({ blockingAccountId, blockedAccountId, [field]: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Account Block fact requires exactly: blockingAccountId, blockedAccountId.");
  });

  it.each([
    ["a nested Account", { blockingAccountId: { id: blockingAccountId }, blockedAccountId }],
    ["a lowercase Account", { blockingAccountId, blockedAccountId: blockedAccountId.toLowerCase() }],
    ["a self-Block", { blockingAccountId, blockedAccountId: blockingAccountId }],
    ["a missing Account", { blockingAccountId }],
    ["an array", [blockingAccountId, blockedAccountId]],
  ])("rejects %s", (_label, value) => {
    expect(() => parseIdentityAccountBlockFactPayload(value)).toThrow(/^Account Block fact /);
  });

  it("keeps the private transition and budget types out of the public registry and inside the private namespace", () => {
    for (const eventType of [accountBlockTransitionRecordedEventType, accountBlockBudgetRecordedEventType]) {
      expect(isIdentityAccountBlockPrivateEventType(eventType)).toBe(true);
      expect(isContextPrivateEventType(eventType)).toBe(true);
    }
    for (const eventType of Object.values(identityAccountBlockFactEventTypes)) {
      expect(isIdentityAccountBlockPrivateEventType(eventType)).toBe(false);
      expect(isContextPrivateEventType(eventType)).toBe(false);
    }
    expect(isContextPrivateEventType("identity.account.suspended")).toBe(false);
  });
});

describe("account-block-public-contract-and-privacy: privacy-redacted transport", () => {
  const history = buildSyntheticHistory(alternatingSteps("pair", [instant(T0), instant(T0 + 1_000)]));
  const [blockedTransition, blockedFact, unblockedTransition, unblockedFact] =
    history.pairEvents.map(withPlantedEnvelope);

  it("keeps only id, type, position, tenant and the closed payload for Block and Unblock facts", () => {
    for (const fact of [blockedFact!, unblockedFact!]) {
      const transport = toTransportEvent(fact);
      expect(transport).toEqual({
        id: fact.eventId,
        type: fact.eventType,
        streamId: fact.streamId,
        streamVersion: fact.streamVersion,
        globalPosition: fact.globalPosition,
        tenantId: fact.tenantId,
        data: { blockingAccountId, blockedAccountId },
        metadata: {},
        audit: redactedTransportAudit,
        trace: {},
        timing: redactedTransportTiming,
      });
      const serialized = JSON.stringify(transport);
      for (const planted of [
        initiatingUserId,
        plantedTraceId,
        plantedSessionId,
        plantedRecordedAt,
        "spn_planted",
        "planted=state",
        "sessionId",
        'recordedAt":"2031',
      ]) {
        expect(serialized).not.toContain(planted);
      }
      expect(serialized).not.toContain(String(blockedTransition!.payload.transitionId));
      expect(serialized).not.toContain(String(blockedTransition!.payload.effectiveAt));
    }
  });

  it("gives the private types the same neutral envelope", () => {
    for (const event of [blockedTransition!, unblockedTransition!]) {
      const transport = toTransportEvent(event);
      expect(transport.audit).toEqual(redactedTransportAudit);
      expect(transport.trace).toEqual({});
      expect(transport.timing).toEqual(redactedTransportTiming);
      expect(transport.metadata).toEqual({});
    }
  });

  it("leaves every other context's envelope unchanged", () => {
    const other = withPlantedEnvelope({ ...blockedFact!, eventType: "identity.account.suspended", payload: {} });
    expect(toTransportEvent(other)).toMatchObject({
      metadata: other.metadata,
      audit: { performedByUserId: initiatingUserId, forAccountId: blockingAccountId },
      trace: { traceId: plantedTraceId, spanId: "spn_planted" },
      timing: { occurredAt: plantedRecordedAt, recordedAt: plantedRecordedAt },
    });
  });

  it.each(["recordedAt", "traceId", "performedByUserId"])(
    "fails closed instead of transporting a fact with a planted %s",
    (field) => {
      const planted = { ...blockedFact!, payload: { ...blockedFact!.payload, [field]: plantedRecordedAt } };
      expect(() => toTransportEvent(planted)).toThrow("Account Block fact requires exactly");
      expect(refusalCode(() => foldAccountBlockPairHistory(syntheticPair, [blockedTransition!, planted]))).toBe(
        "codec",
      );
    },
  );
});

describe("account-block-public-contract-and-privacy: one-field pairing mutations", () => {
  const valid = buildSyntheticHistory(alternatingSteps("pair", [instant(T0)]));
  const [privateEvent, publicEvent] = valid.pairEvents;
  const replay = (history: SyntheticHistory) => () => {
    const budget = foldAccountBlockBudgetHistory(syntheticPair, history.budgetEvents);
    assertAccountBlockBudgetLinks(foldAccountBlockPairHistory(syntheticPair, history.pairEvents), budget);
  };
  const mutatePrivate = (changes: Partial<StoredEvent>, payload: Record<string, unknown> = {}) =>
    replay({
      ...valid,
      pairEvents: [
        { ...privateEvent!, ...changes, payload: { ...privateEvent!.payload, ...payload } as never },
        publicEvent!,
      ],
    });
  const mutatePublic = (changes: Partial<StoredEvent>, payload: Record<string, unknown> = {}) =>
    replay({
      ...valid,
      pairEvents: [
        privateEvent!,
        { ...publicEvent!, ...changes, payload: { ...publicEvent!.payload, ...payload } as never },
      ],
    });

  it("replays the unmutated pairing", () => {
    expect(refusalCode(replay(valid))).toBeUndefined();
  });

  it.each([
    ["private operation", mutatePrivate({}, { operation: "unblock" }), "state"],
    ["private blocking Account", mutatePrivate({}, { blockingAccountId: otherBlockedAccountId }), "pairing"],
    ["private blocked Account", mutatePrivate({}, { blockedAccountId: otherBlockedAccountId }), "pairing"],
    ["private transition id", mutatePrivate({}, { transitionId: `abt_${"0".repeat(64)}` }), "identity"],
    ["private effective instant", mutatePrivate({}, { effectiveAt: instant(T0 + 1) }), "budget-link"],
    ["private event id", mutatePrivate({ eventId: "evt_planted" as never }), "identity"],
    ["private event type", mutatePrivate({ eventType: "identity.account-blocked" }), "unpaired"],
    ["public event type", mutatePublic({ eventType: "identity.account-unblocked" }), "pairing"],
    ["public blocking Account", mutatePublic({}, { blockingAccountId: otherBlockedAccountId }), "pairing"],
    ["public blocked Account", mutatePublic({}, { blockedAccountId: otherBlockedAccountId }), "pairing"],
    ["public event id", mutatePublic({ eventId: "evt_planted" as never }), "identity"],
    ["public tenant", mutatePublic({ tenantId: "tnt_other" as never }), "tenant"],
  ] as const)("rejects a changed %s", (_label, run, code) => {
    expect(refusalCode(run)).toBe(code);
  });
});

describe("account-block-public-contract-and-privacy: subscription registration", () => {
  const pool = () => ({ query: vi.fn(async () => ({ rows: [] })), connect: vi.fn() }) as never;
  const identitySource = {
    contextName: "identity",
    mountRole: "source-only",
    module: { contextName: "identity" } as unknown as BcApiModule,
    services: {},
    pool: pool(),
    projectionHandlerSets: [],
  } as const;
  const subscription = (
    overrides: Partial<BcEventSubscription> & Pick<BcEventSubscription, "handlers">,
  ): BcEventSubscription => ({
    subscriptionName: "account-block-downstream",
    handlerKind: "projection",
    sourceContextName: "identity",
    projectionName: "account-block-downstream-projection",
    subscriptionVersion: 1,
    ...overrides,
  });
  const mounted = (contextName: string, built: BcEventSubscription, mountIdentity = true) => [
    ...(mountIdentity ? [identitySource] : []),
    {
      contextName,
      module: {
        contextName,
        ...(built.handlerKind === "reaction"
          ? { eventReactions: [{ sourceContextName: built.sourceContextName, reactionName: built.projectionName }] }
          : {
              eventSubscriptions: [
                { sourceContextName: built.sourceContextName, projectionName: built.projectionName },
              ],
            }),
        buildSubscriptions: () => [built],
      } as unknown as BcApiModule,
      services: {},
      pool: pool(),
      projectionHandlerSets: [],
    },
  ];
  const handler = async () => undefined;

  it.each([
    [
      "the private transition",
      {
        eventTypes: [accountBlockTransitionRecordedEventType],
        handlers: { [accountBlockTransitionRecordedEventType]: handler },
      },
    ],
    ["the private Account budget", { handlers: { [accountBlockBudgetRecordedEventType]: handler } }],
    [
      "a receipt-shaped private type",
      { eventTypes: [receiptShapedPrivateType], handlers: { [receiptShapedPrivateType]: handler } },
    ],
    [
      "a private type beside a public fact",
      {
        eventTypes: ["identity.account-blocked", accountBlockTransitionRecordedEventType],
        handlers: { "identity.account-blocked": handler, [accountBlockTransitionRecordedEventType]: handler },
      },
    ],
    [
      "a reaction to the private transition",
      { handlerKind: "reaction", handlers: { [accountBlockTransitionRecordedEventType]: handler } },
    ],
  ] as const)("refuses a downstream registration that selects %s", (_label, overrides) => {
    const built = subscription(overrides as never);
    expect(() => resolveModuleSubscriptions(mounted("marketplace", built) as never)).toThrow(
      /selects context-private event types that never cross a context boundary/,
    );
    expect(() => createSubscriptionRunner("marketplace", pool(), pool(), built)).toThrow(
      /selects context-private event types/,
    );
  });

  it("refuses the registration even when the source context is not mounted", () => {
    const built = subscription({
      sourceContextMount: "when-mounted",
      handlers: { [accountBlockTransitionRecordedEventType]: handler },
    });
    expect(() => resolveModuleSubscriptions(mounted("marketplace", built, false) as never)).toThrow(
      /selects context-private event types/,
    );
  });

  it("refuses a non-Identity context that names Identity's private type against its own source", () => {
    const built = subscription({
      sourceContextName: "marketplace",
      handlers: { [accountBlockBudgetRecordedEventType]: handler },
    });
    expect(() => createSubscriptionRunner("marketplace", pool(), pool(), built)).toThrow(/selects context-private/);
  });

  it("admits downstream registration of the public facts and Identity's own private reads", () => {
    const publicFacts = subscription({
      eventTypes: Object.values(identityAccountBlockFactEventTypes),
      handlers: { "identity.account-blocked": handler, "identity.account-unblocked": handler },
    });
    expect(resolveModuleSubscriptions(mounted("marketplace", publicFacts) as never)).toHaveLength(1);

    const identityOwn = subscription({ handlers: { [accountBlockTransitionRecordedEventType]: handler } });
    expect(() => createSubscriptionRunner("identity", pool(), pool(), identityOwn)).not.toThrow();
  });
});

describe("account-block-public-contract-and-privacy: synthetic fixture identities", () => {
  it("uses only synthetic Accounts in every fixture", () => {
    const history = buildSyntheticHistory(alternatingSteps("other", [instant(T0)], otherBlockedAccountId));
    expect(history.pairEvents).toHaveLength(0);
    expect(history.budgetEvents).toHaveLength(1);
  });
});
