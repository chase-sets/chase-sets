import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppendToStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import {
  stageAccountBlockCommand,
  type AccountBlockAuthorityStore,
  type AccountBlockCommand,
} from "../api/transition-staging";
import {
  accountBlockProtectionLimits,
  assertAccountBlockBudgetLinks,
  countAccountBlockTransitionsInRollingWindow,
  decideAccountBlockCommand,
  foldAccountBlockBudgetHistory,
  foldAccountBlockPairHistory,
  resolveAccountBlockEffectiveAt,
} from "../domain/authority";
import {
  AccountBlockAuthorityError,
  accountBlockBudgetRecordedEventType,
  accountBlockBudgetStreamId,
  accountBlockPairStreamId,
  accountBlockTransitionRecordedEventType,
  decodeAccountBlockBudgetRecorded,
  decodeAccountBlockTransitionRecorded,
  encodeAccountBlockTransition,
  type AccountBlockOperation,
} from "../domain/events";
import {
  DAY,
  HOUR,
  alternatingSteps,
  blockedAccountId,
  blockingAccountId,
  buildSyntheticHistory,
  initiatingUserId,
  instant,
  otherBlockedAccountId,
  renumber,
  syntheticContext,
  syntheticPair,
  syntheticTenantId,
  syntheticTransitionId,
  type SyntheticHistory,
} from "./account-block-test-support";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const commandTransitionId = syntheticTransitionId("command");

function stateOf(history: SyntheticHistory) {
  const budgetState = foldAccountBlockBudgetHistory(syntheticPair, history.budgetEvents);
  const pairState = foldAccountBlockPairHistory(syntheticPair, history.pairEvents);
  assertAccountBlockBudgetLinks(pairState, budgetState);
  return { pairState, budgetState };
}

function decide(
  history: SyntheticHistory,
  operation: AccountBlockOperation,
  serverInstant: IsoUtcTimestamp,
  transitionId = commandTransitionId,
) {
  return decideAccountBlockCommand({
    pair: syntheticPair,
    operation,
    transitionId,
    serverInstant,
    ...stateOf(history),
  });
}

function refusalCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountBlockAuthorityError) return error.code;
    throw error;
  }
  return undefined;
}

/** Ten pair transitions whose oldest sits `oldestAge` before the newest at `end`. */
function fullPairWindow(end: number, oldestAge: number): SyntheticHistory {
  const newerNine = Array.from({ length: 9 }, (_, index) => instant(end - (8 - index) * 60_000));
  return buildSyntheticHistory(alternatingSteps("pair-window", [instant(end - oldestAge), ...newerNine]));
}

/** Sixty budget entries for another pair whose oldest sits `oldestAge` before the newest at `end`. */
function fullAccountWindow(end: number, oldestAge: number): SyntheticHistory {
  const newer = Array.from({ length: 59 }, (_, index) => instant(end - (58 - index) * 30_000));
  return buildSyntheticHistory(
    alternatingSteps("account-window", [instant(end - oldestAge), ...newer], otherBlockedAccountId),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("account-block-effective-time-and-event-partition: effective time", () => {
  it("takes the latest of the server instant and each stream's last stored instant", () => {
    const pairHistory = buildSyntheticHistory(alternatingSteps("pair", [instant(T0)]));
    const { pairState, budgetState } = stateOf(pairHistory);
    expect(resolveAccountBlockEffectiveAt(instant(T0 + 5), pairState, budgetState)).toBe(instant(T0 + 5));
    expect(resolveAccountBlockEffectiveAt(instant(T0 - HOUR), pairState, budgetState)).toBe(instant(T0));

    const budgetAhead = buildSyntheticHistory([
      ...alternatingSteps("pair", [instant(T0)]),
      ...alternatingSteps("other", [instant(T0 + 7_000)], otherBlockedAccountId),
    ]);
    const ahead = stateOf(budgetAhead);
    expect(resolveAccountBlockEffectiveAt(instant(T0 + 1), ahead.pairState, ahead.budgetState)).toBe(
      instant(T0 + 7_000),
    );
  });

  it("never reads the process clock: decisions match under polarized system times", () => {
    const history = buildSyntheticHistory(alternatingSteps("pair", [instant(T0), instant(T0 + 60_000)]));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("1971-01-01T00:00:00.000Z"));
    const past = decide(history, "block", instant(T0 + 120_000));
    vi.setSystemTime(new Date("2999-12-31T23:59:59.999Z"));
    const future = decide(history, "block", instant(T0 + 120_000));
    expect(future).toEqual(past);
    expect(past).toMatchObject({ outcome: "transition", effectiveAt: instant(T0 + 120_000) });
  });

  it("keeps an equal instant and orders it by stream version", () => {
    const history = buildSyntheticHistory(alternatingSteps("pair", [instant(T0)]));
    const decision = decide(history, "unblock", instant(T0 - 1));
    expect(decision).toMatchObject({ outcome: "transition", effectiveAt: instant(T0) });

    const replayed = stateOf(buildSyntheticHistory(alternatingSteps("pair", [instant(T0), instant(T0)])));
    expect(
      replayed.pairState.transitions.map(({ effectiveAt, streamVersion }) => [effectiveAt, streamVersion]),
    ).toEqual([
      [instant(T0), 1],
      [instant(T0), 3],
    ]);
    expect(replayed.pairState.relation).toBe("inactive");
  });

  it("replays retained history identically when envelope times are polarized", () => {
    const steps = alternatingSteps("pair", [instant(T0), instant(T0 + 1_000), instant(T0 + 2_000)]);
    const pastClock = buildSyntheticHistory(steps, { recordedAt: instant(Date.parse("1990-01-01T00:00:00.000Z")) });
    const futureClock = buildSyntheticHistory(steps, { recordedAt: instant(Date.parse("2090-01-01T00:00:00.000Z")) });
    expect(pastClock.pairEvents[0]?.recordedAt).not.toBe(futureClock.pairEvents[0]?.recordedAt);
    expect(stateOf(futureClock)).toEqual(stateOf(pastClock));
    expect(decide(futureClock, "unblock", instant(T0))).toEqual(decide(pastClock, "unblock", instant(T0)));
  });
});

describe("account-block-effective-time-and-event-partition: rolling hour", () => {
  it("counts the half-open window (effectiveAt - PT1H, effectiveAt]", () => {
    const end = instant(T0);
    expect(countAccountBlockTransitionsInRollingWindow([instant(T0 - HOUR + 1)], end)).toBe(1);
    expect(countAccountBlockTransitionsInRollingWindow([instant(T0 - HOUR)], end)).toBe(0);
    expect(countAccountBlockTransitionsInRollingWindow([instant(T0 - HOUR - 1)], end)).toBe(0);
    expect(countAccountBlockTransitionsInRollingWindow([end], end)).toBe(1);
    expect(accountBlockProtectionLimits).toEqual({
      version: 1,
      rollingWindowMilliseconds: 3_600_000,
      pairTransitionsPerRollingWindow: 10,
      accountTransitionsPerRollingWindow: 60,
    });
  });

  it("limits the pair at ten transitions: just before one hour counts, exactly one hour and just after do not", () => {
    // The server clock trails the stored history, so the effective instant is the newest stored one.
    const server = instant(T0 - 5 * 60_000);
    expect(decide(fullPairWindow(T0, HOUR - 1), "block", server)).toEqual({
      outcome: "limited",
      limit: "pair",
      effectiveAt: instant(T0),
    });
    expect(decide(fullPairWindow(T0, HOUR), "block", server)).toMatchObject({
      outcome: "transition",
      effectiveAt: instant(T0),
    });
    expect(decide(fullPairWindow(T0, HOUR + 1), "block", server)).toMatchObject({ outcome: "transition" });
  });

  it("limits the blocking Account at sixty transitions across pairs with the same boundary", () => {
    const server = instant(T0 - 1);
    expect(decide(fullAccountWindow(T0, HOUR - 1), "block", server)).toEqual({
      outcome: "limited",
      limit: "account",
      effectiveAt: instant(T0),
    });
    expect(decide(fullAccountWindow(T0, HOUR), "block", server)).toMatchObject({ outcome: "transition" });
    expect(decide(fullAccountWindow(T0, HOUR + 1), "block", server)).toMatchObject({ outcome: "transition" });
  });
});

describe("account-block-effective-time-and-event-partition: steady states", () => {
  it("appends nothing and consumes no budget for already-in-state commands from both steady states", () => {
    const inactive = buildSyntheticHistory([]);
    expect(decide(inactive, "unblock", instant(T0))).toEqual({ outcome: "already-in-state", relation: "inactive" });

    // A full Account window would refuse a transition, but a no-op never consults it.
    const activeWithFullBudget = buildSyntheticHistory([
      ...alternatingSteps("account-window", alternatingInstants(T0 - 58 * 60_000, 59), otherBlockedAccountId),
      ...alternatingSteps("pair", [instant(T0 + 1)]),
    ]);
    expect(stateOf(activeWithFullBudget).budgetState.entries).toHaveLength(60);
    expect(decide(activeWithFullBudget, "block", instant(T0))).toEqual({
      outcome: "already-in-state",
      relation: "active",
    });
  });

  it("accepts ordinary next-day commands from both steady states", () => {
    const yesterday = T0 - DAY;
    const endsInactive = buildSyntheticHistory(alternatingSteps("pair", alternatingInstants(yesterday, 10)));
    expect(stateOf(endsInactive).pairState.relation).toBe("inactive");
    expect(decide(endsInactive, "block", instant(T0))).toMatchObject({
      outcome: "transition",
      operation: "block",
      effectiveAt: instant(T0),
    });

    const endsActive = buildSyntheticHistory(alternatingSteps("pair", alternatingInstants(yesterday, 11)));
    expect(stateOf(endsActive).pairState.relation).toBe("active");
    expect(decide(endsActive, "unblock", instant(T0))).toMatchObject({ outcome: "transition", operation: "unblock" });
  });

  it("resolves a duplicate delivery to its recorded transition and refuses a reused transition identity", () => {
    const recorded = syntheticTransitionId("recorded");
    const history = buildSyntheticHistory([
      { transitionId: recorded, operation: "block", effectiveAt: instant(T0) },
      ...alternatingSteps("other", [instant(T0 + 1)], otherBlockedAccountId),
    ]);
    expect(decide(history, "block", instant(T0 + HOUR), recorded)).toEqual({
      outcome: "already-recorded",
      transitionId: recorded,
      operation: "block",
      effectiveAt: instant(T0),
    });
    expect(refusalCode(() => decide(history, "unblock", instant(T0 + HOUR), recorded))).toBe("transition-conflict");
    expect(refusalCode(() => decide(history, "unblock", instant(T0 + HOUR), syntheticTransitionId("other:0")))).toBe(
      "transition-conflict",
    );
  });
});

describe("account-block-effective-time-and-event-partition: event partition", () => {
  it("encodes the budget entry, then the adjacent private transition and public fact, with deterministic identities", () => {
    const effectiveAt = instant(T0);
    const encoded = encodeAccountBlockTransition(syntheticPair, commandTransitionId, "block", effectiveAt);
    const lengthPrefixed = (parts: readonly string[]) => {
      const hash = createHash("sha256");
      for (const part of parts) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(Buffer.byteLength(part, "utf8"));
        hash.update(length).update(part, "utf8");
      }
      return hash.digest("hex");
    };

    expect(encoded.budgetEvent).toEqual({
      eventId: `evt_account_block_${lengthPrefixed([syntheticTenantId, blockingAccountId, commandTransitionId, "budget"])}`,
      eventType: accountBlockBudgetRecordedEventType,
      payload: { version: 1, transitionId: commandTransitionId, blockingAccountId, effectiveAt },
      occurredAt: effectiveAt,
    });
    expect(encoded.pairEvents.map((event) => event.eventType)).toEqual([
      accountBlockTransitionRecordedEventType,
      "identity.account-blocked",
    ]);
    expect(encoded.pairEvents[0].payload).toEqual({
      version: 1,
      transitionId: commandTransitionId,
      operation: "block",
      blockingAccountId,
      blockedAccountId,
      effectiveAt,
    });
    expect(encoded.pairEvents[1].payload).toEqual({ blockingAccountId, blockedAccountId });
    expect(encodeAccountBlockTransition(syntheticPair, commandTransitionId, "block", effectiveAt)).toEqual(encoded);
    expect(
      encodeAccountBlockTransition(syntheticPair, commandTransitionId, "unblock", effectiveAt).pairEvents[1].eventType,
    ).toBe("identity.account-unblocked");
  });
});

describe("account-block-effective-time-and-event-partition: poison matrix", () => {
  const steps = alternatingSteps("pair", [instant(T0), instant(T0 + 60_000), instant(T0 + 120_000)]);
  const valid = buildSyntheticHistory(steps);
  const pairFold = (events: readonly StoredEvent[]) => () => foldAccountBlockPairHistory(syntheticPair, events);
  const budgetFold = (events: readonly StoredEvent[]) => () => foldAccountBlockBudgetHistory(syntheticPair, events);
  const linked = (history: SyntheticHistory) => () => stateOf(history);
  const withPayload = (event: StoredEvent, changes: Record<string, unknown>): StoredEvent => ({
    ...event,
    payload: { ...event.payload, ...changes } as never,
  });
  const replace = (events: readonly StoredEvent[], index: number, event: StoredEvent) =>
    events.map((candidate, position) => (position === index ? event : candidate));
  const pair = valid.pairEvents;
  const budget = valid.budgetEvents;

  it("accepts the valid retained history it mutates", () => {
    expect(refusalCode(linked(valid))).toBeUndefined();
    expect(stateOf(valid).pairState).toMatchObject({ streamVersion: 6, relation: "active" });
  });

  it.each([
    [
      "duplicate transition with different data",
      pairFold(buildSyntheticHistory([steps[0]!, { ...steps[1]!, transitionId: steps[0]!.transitionId }]).pairEvents),
      "duplicate",
    ],
    ["private-only tail", pairFold(pair.slice(0, 5)), "unpaired"],
    ["public-only transition", pairFold(renumber([...pair.slice(0, 2), ...pair.slice(3)])), "unpaired"],
    [
      "public fact before its private transition",
      pairFold(renumber([pair[1]!, pair[0]!, ...pair.slice(2)])),
      "unpaired",
    ],
    [
      "missing Account budget entry",
      linked({ pairEvents: pair, budgetEvents: renumber([budget[0]!, budget[2]!]) }),
      "budget-link",
    ],
    [
      "non-monotonic effective instants",
      pairFold(
        buildSyntheticHistory(alternatingSteps("pair", [instant(T0), instant(T0 - 1), instant(T0 + 1)])).pairEvents,
      ),
      "time",
    ],
    [
      "date-only effective instant",
      pairFold(replace(pair, 2, withPayload(pair[2]!, { effectiveAt: "2026-11-01" }))),
      "codec",
    ],
    [
      "altered public event identity",
      pairFold(replace(pair, 3, { ...pair[3]!, eventId: `${pair[3]!.eventId}0` as never })),
      "identity",
    ],
    [
      "altered private event identity",
      pairFold(replace(pair, 0, { ...pair[0]!, eventId: "evt_planted" as never })),
      "identity",
    ],
    [
      "unknown event type",
      pairFold(replace(pair, 4, { ...pair[4]!, eventType: "identity.account-block-planted" })),
      "unknown-event",
    ],
    ["foreign tenant", pairFold(replace(pair, 1, { ...pair[1]!, tenantId: "tnt_other" as never })), "tenant"],
    ["stream version gap", pairFold([...pair.slice(0, 2), { ...pair[2]!, streamVersion: 4 }]), "order"],
    [
      "foreign stream",
      pairFold(replace(pair, 0, { ...pair[0]!, streamId: "identity.account-block-pair-planted" })),
      "identity",
    ],
    [
      "contradictory Block while active",
      pairFold(buildSyntheticHistory([steps[0]!, { ...steps[1]!, operation: "block" }]).pairEvents),
      "state",
    ],
    [
      "public fact that disagrees with the private operation",
      pairFold(replace(pair, 1, { ...pair[1]!, eventType: "identity.account-unblocked" })),
      "pairing",
    ],
    ["two private transitions in a row", pairFold(replace(pair, 1, { ...pair[2]!, streamVersion: 2 })), "unpaired"],
    [
      "budget entry with altered identity",
      budgetFold(replace(budget, 1, { ...budget[1]!, eventId: "evt_planted" as never })),
      "identity",
    ],
    [
      "budget entry for another blocking Account",
      budgetFold(replace(budget, 0, withPayload(budget[0]!, { blockingAccountId: otherBlockedAccountId }))),
      "pairing",
    ],
    [
      "budget entry of an unknown type",
      budgetFold(replace(budget, 2, { ...budget[2]!, eventType: "identity.planted" })),
      "unknown-event",
    ],
    ["duplicate budget entry", budgetFold(renumber([budget[0]!, budget[0]!])), "duplicate"],
    [
      "budget entry whose instant differs from its transition",
      linked({
        pairEvents: pair,
        budgetEvents: replace(budget, 2, withPayload(budget[2]!, { effectiveAt: instant(T0 + 120_001) })),
      }),
      "budget-link",
    ],
    [
      "budget entries in a different order than the pair",
      linked({
        pairEvents: buildSyntheticHistory(alternatingSteps("pair", [instant(T0), instant(T0)])).pairEvents,
        budgetEvents: renumber(
          [...buildSyntheticHistory(alternatingSteps("pair", [instant(T0), instant(T0)])).budgetEvents].reverse(),
        ),
      }),
      "budget-link",
    ],
  ] as const)("fails closed on %s", (_label, run, code) => {
    expect(refusalCode(run)).toBe(code);
  });
});

describe("account-block-effective-time-and-event-partition: closed private codecs", () => {
  const transition = {
    version: 1,
    transitionId: commandTransitionId,
    operation: "block",
    blockingAccountId,
    blockedAccountId,
    effectiveAt: instant(T0),
  };
  const budget = { version: 1, transitionId: commandTransitionId, blockingAccountId, effectiveAt: instant(T0) };

  it("reads exactly the v1 shapes", () => {
    expect(decodeAccountBlockTransitionRecorded(transition)).toEqual(transition);
    expect(decodeAccountBlockBudgetRecorded(budget)).toEqual(budget);
    expect(decodeAccountBlockTransitionRecorded(JSON.parse(JSON.stringify(transition)))).toEqual(transition);
  });

  it.each([
    ["an extra key", { ...transition, recordedAt: instant(T0) }],
    ["a nested unknown value", { ...transition, effectiveAt: { at: instant(T0) } }],
    ["a missing key", { ...transition, effectiveAt: undefined }],
    ["an own __proto__ key", JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(transition).slice(1)}`)],
    ["a symbol key", { ...transition, [Symbol("planted")]: 1 }],
    ["a class instance", Object.assign(Object.create({ planted: true }), transition)],
    ["a string version", { ...transition, version: "1" }],
    ["a newer version", { ...transition, version: 2 }],
    ["a fractional version", { ...transition, version: 1.5 }],
    ["an unknown operation", { ...transition, operation: "mute" }],
    ["a lowercase Account", { ...transition, blockedAccountId: blockedAccountId.toLowerCase() }],
    ["a non-ASCII Account", { ...transition, blockedAccountId: `${blockedAccountId.slice(0, -1)}É` }],
    ["an overlength Account", { ...transition, blockedAccountId: `${blockedAccountId}0` }],
    ["a numeric Account", { ...transition, blockedAccountId: 7 }],
    ["a self-Block", { ...transition, blockedAccountId: blockingAccountId }],
    ["an uppercase transition id", { ...transition, transitionId: commandTransitionId.toUpperCase() }],
    ["a short transition id", { ...transition, transitionId: commandTransitionId.slice(0, -1) }],
    ["an overlength transition id", { ...transition, transitionId: `${commandTransitionId}0` }],
    ["a non-ASCII transition id", { ...transition, transitionId: `${commandTransitionId.slice(0, -1)}é` }],
    ["a date-only instant", { ...transition, effectiveAt: "2026-11-01" }],
    ["an offset instant", { ...transition, effectiveAt: "2026-11-01T12:00:00.000+00:00" }],
    ["a second-precision instant", { ...transition, effectiveAt: "2026-11-01T12:00:00Z" }],
    ["a microsecond instant", { ...transition, effectiveAt: "2026-11-01T12:00:00.000000Z" }],
    ["an impossible calendar date", { ...transition, effectiveAt: "2026-02-30T12:00:00.000Z" }],
    ["a numeric instant", { ...transition, effectiveAt: T0 }],
  ])("rejects a private transition with %s", (_label, value) => {
    expect(refusalCode(() => decodeAccountBlockTransitionRecorded(value))).toBe("codec");
  });

  it.each([
    ["the blocked Account", { ...budget, blockedAccountId }],
    ["an operation", { ...budget, operation: "block" }],
    ["a missing transition id", { version: 1, blockingAccountId, effectiveAt: instant(T0) }],
    ["a date-only instant", { ...budget, effectiveAt: "2026-11-01" }],
    ["an array", [budget]],
    ["null", null],
  ])("rejects an Account budget entry with %s", (_label, value) => {
    expect(refusalCode(() => decodeAccountBlockBudgetRecorded(value))).toBe("codec");
  });

  it("accepts a leap-day instant", () => {
    expect(decodeAccountBlockBudgetRecorded({ ...budget, effectiveAt: "2028-02-29T00:00:00.000Z" }).effectiveAt).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });
});

describe("account-block-effective-time-and-event-partition: staging inside the caller's transaction", () => {
  const budgetStreamId = accountBlockBudgetStreamId(syntheticTenantId, blockingAccountId);
  const pairStreamId = accountBlockPairStreamId(syntheticPair);
  const serverInstant = instant(T0);

  function harness(
    history: SyntheticHistory,
    serverRows: readonly Record<string, unknown>[] = [{ server_instant: serverInstant }],
  ) {
    const calls: string[] = [];
    const streamName = (streamId: string) =>
      streamId === budgetStreamId ? "budget" : streamId === pairStreamId ? "pair" : "other";
    const store: AccountBlockAuthorityStore = {
      appendToStreamsInTransaction: vi.fn(async (_client: unknown, inputs: readonly AppendToStreamInput[]) => {
        calls.push(`append ${inputs.map((input) => `${streamName(input.streamId)}:${input.events.length}`).join(" ")}`);
        return inputs.map((input) => ({ streamId: input.streamId, storedEvents: [] }));
      }) as never,
      readStreamInTransaction: vi.fn(
        async (_client: unknown, input: { streamId: string; fromVersion?: number; limit?: number }) => {
          calls.push(`read ${streamName(input.streamId)} from ${input.fromVersion} limit ${input.limit}`);
          return input.streamId === budgetStreamId ? history.budgetEvents : history.pairEvents;
        },
      ) as never,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql.includes("clock_timestamp()") ? "server clock" : "other query");
        return { rows: serverRows };
      }),
    } as never;
    return { calls, store, client };
  }
  const command = (overrides: Partial<AccountBlockCommand> = {}): AccountBlockCommand => ({
    operation: "block",
    blockingAccountId,
    blockedAccountId,
    transitionId: commandTransitionId,
    context: syntheticContext(),
    ...overrides,
  });
  const stagedRefusal = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof AccountBlockAuthorityError) return error.code;
      throw error;
    }
    return undefined;
  };

  it("locks the budget then the pair, reads bounded histories, reads the server clock and appends nothing", async () => {
    const { calls, store, client } = harness(buildSyntheticHistory([]));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("1971-01-01T00:00:00.000Z"));
    const staged = await stageAccountBlockCommand(store, client, command());
    expect(calls).toEqual([
      "append budget:0 pair:0",
      "read budget from 1 limit 32",
      "read pair from 1 limit 32",
      "server clock",
    ]);
    expect(staged).toMatchObject({ outcome: "transition", effectiveAt: serverInstant });
    if (staged.outcome !== "transition") throw new Error("expected a transition");
    expect(staged.appends.map((append) => [append.streamId, append.expectedVersion, append.events.length])).toEqual([
      [budgetStreamId, "no_stream", 1],
      [pairStreamId, "no_stream", 2],
    ]);
    for (const append of staged.appends) {
      expect(append.context).toEqual(syntheticContext());
      expect(append.events.every((event) => JSON.stringify(event.payload).includes(initiatingUserId))).toBe(false);
    }
  });

  it("guards each stream at its read version", async () => {
    const history = buildSyntheticHistory([
      ...alternatingSteps("pair", [instant(T0 - 2_000)]),
      ...alternatingSteps("other", [instant(T0 - 1_000)], otherBlockedAccountId),
    ]);
    const { store, client } = harness(history);
    const staged = await stageAccountBlockCommand(store, client, command({ operation: "unblock" }));
    if (staged.outcome !== "transition") throw new Error("expected a transition");
    expect(staged.appends.map((append) => append.expectedVersion)).toEqual([2, 2]);
  });

  it("refuses a history beyond the unsnapshotted tail instead of replaying it", async () => {
    const thirtyTwo = alternatingSteps("tail", alternatingInstants(T0 - DAY, 32), otherBlockedAccountId);
    const { calls, store, client } = harness(buildSyntheticHistory(thirtyTwo));
    expect(await stagedRefusal(() => stageAccountBlockCommand(store, client, command()))).toBe("tail-bound");
    expect(calls.filter((call) => call.startsWith("append"))).toEqual(["append budget:0 pair:0"]);

    const thirtyOne = harness(buildSyntheticHistory(thirtyTwo.slice(0, 31)));
    expect(await stageAccountBlockCommand(thirtyOne.store, thirtyOne.client, command())).toMatchObject({
      outcome: "transition",
    });
  });

  it.each([
    ["a date-only instant", [{ server_instant: "2026-11-01" }]],
    ["an offset instant", [{ server_instant: "2026-11-01T12:00:00.000+00:00" }]],
    ["no row", []],
  ])("refuses an unreadable server clock: %s", async (_label, rows) => {
    const { store, client } = harness(buildSyntheticHistory([]), rows);
    expect(await stagedRefusal(() => stageAccountBlockCommand(store, client, command()))).toBe("invalid-clock");
  });

  it.each([
    ["a self-Block", { blockedAccountId: blockingAccountId }],
    [
      "an audit Account other than the blocking Account",
      { context: syntheticContext({ accountId: blockedAccountId }) },
    ],
    ["a malformed transition id", { transitionId: "abt_planted" as never }],
    ["a lowercase Account", { blockedAccountId: blockedAccountId.toLowerCase() as never }],
    ["an unknown operation", { operation: "mute" as never }],
  ])("refuses %s before touching the store", async (_label, overrides) => {
    const { calls, store, client } = harness(buildSyntheticHistory([]));
    expect(await stagedRefusal(() => stageAccountBlockCommand(store, client, command(overrides)))).toBe(
      "invalid-command",
    );
    expect(calls).toEqual([]);
  });
});

function alternatingInstants(start: number, count: number): readonly IsoUtcTimestamp[] {
  return Array.from({ length: count }, (_, index) => instant(start + index * 60_000));
}
