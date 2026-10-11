import { describe, expect, it } from "vitest";
import {
  SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY,
  decideAccountCapabilityAssignment,
  evolveAccountCapabilityAssignment,
  initialAccountCapabilityAssignmentState,
  toAccountCapabilityAssignmentStreamId,
  type AccountCapabilityAssignmentEvent,
  type AccountCapabilityAssignmentState,
  type AccountCapabilityAssignmentCommand,
} from "./domain";

const target = {
  tenantId: "tnt_synthetic",
  accountId: "acc_synthetic",
  capabilityKey: SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY,
} as const;

function grant(expectedVersion: number, overrides: Partial<AccountCapabilityAssignmentCommand> = {}) {
  return {
    type: "GrantAccountCapability",
    ...target,
    assignmentId: "acap_synthetic",
    expectedVersion,
    ...overrides,
  } as AccountCapabilityAssignmentCommand;
}

function revoke(expectedVersion: number, overrides: Partial<AccountCapabilityAssignmentCommand> = {}) {
  return { type: "RevokeAccountCapability", ...target, expectedVersion, ...overrides } as AccountCapabilityAssignmentCommand;
}

function apply(state: AccountCapabilityAssignmentState, command: AccountCapabilityAssignmentCommand) {
  const events = decideAccountCapabilityAssignment(state, command) as readonly AccountCapabilityAssignmentEvent[];
  return { events, state: events.reduce(evolveAccountCapabilityAssignment, state) };
}

function replay(events: readonly AccountCapabilityAssignmentEvent[]) {
  return events.reduce(evolveAccountCapabilityAssignment, initialAccountCapabilityAssignmentState);
}

function event(
  type: AccountCapabilityAssignmentEvent["type"],
  version: number,
  overrides: Record<string, unknown> = {},
): AccountCapabilityAssignmentEvent {
  return { type, data: { ...target, assignmentId: "acap_synthetic", version, ...overrides } } as never;
}

describe("Account Capability assignment decider", () => {
  it("moves one assignment absent -> granted -> revoked -> granted at a new version with a stable assignment id", () => {
    const granted = apply(initialAccountCapabilityAssignmentState, grant(0));
    const revoked = apply(granted.state, revoke(1));
    const regranted = apply(revoked.state, grant(2, { assignmentId: "acap_ignored_after_first_grant" } as never));

    expect([...granted.events, ...revoked.events, ...regranted.events]).toEqual([
      { type: "identity.account-capability.granted", data: { ...target, assignmentId: "acap_synthetic", version: 1 } },
      { type: "identity.account-capability.revoked", data: { ...target, assignmentId: "acap_synthetic", version: 2 } },
      { type: "identity.account-capability.granted", data: { ...target, assignmentId: "acap_synthetic", version: 3 } },
    ]);
    expect(regranted.state).toEqual({ ...target, status: "granted", assignmentId: "acap_synthetic", version: 3 });
    expect(replay([...granted.events, ...revoked.events, ...regranted.events])).toEqual(regranted.state);
  });

  it("appends nothing for exact retries of the transition that produced the current state", () => {
    const granted = apply(initialAccountCapabilityAssignmentState, grant(0)).state;
    const revoked = apply(granted, revoke(1)).state;
    const regranted = apply(revoked, grant(2)).state;

    expect(decideAccountCapabilityAssignment(granted, grant(0, { assignmentId: "acap_retry" } as never))).toEqual([]);
    expect(decideAccountCapabilityAssignment(revoked, revoke(1))).toEqual([]);
    expect(decideAccountCapabilityAssignment(regranted, grant(2))).toEqual([]);
  });

  it.each([
    // Bypass mutant: accepting any grant while already granted would make this an idempotent no-op.
    ["grant against a stale version while granted", () => apply(initialAccountCapabilityAssignmentState, grant(0)).state, grant(5)],
    // Bypass mutant: ignoring expectedVersion would append a second grant for the absent stream.
    ["grant expecting a version the stream never had", () => initialAccountCapabilityAssignmentState, grant(1)],
    [
      "regrant that skips the revoke it observed",
      () => apply(apply(initialAccountCapabilityAssignmentState, grant(0)).state, revoke(1)).state,
      grant(0),
    ],
    // Bypass mutant: treating revoke-of-absent as a retry would hide a contradictory request.
    ["revoke of a never-granted assignment", () => initialAccountCapabilityAssignmentState, revoke(0)],
    ["revoke against a stale version", () => apply(initialAccountCapabilityAssignmentState, grant(0)).state, revoke(0)],
    [
      "revoke retry against a later version",
      () =>
        apply(apply(apply(initialAccountCapabilityAssignmentState, grant(0)).state, revoke(1)).state, grant(2)).state,
      revoke(1),
    ],
  ])("rejects a changed or contradictory request: %s", (_name, state, command) => {
    expect(() => decideAccountCapabilityAssignment(state(), command)).toThrow(/Account Capability/);
  });

  it.each([
    ["another tenant", { tenantId: "tnt_other" }],
    ["another Account", { accountId: "acc_other" }],
  ])("rejects a command addressed to %s on an existing assignment stream", (_name, overrides) => {
    const granted = apply(initialAccountCapabilityAssignmentState, grant(0)).state;

    expect(() => decideAccountCapabilityAssignment(granted, revoke(1, overrides as never))).toThrow(
      /another tenant, Account, or capability/,
    );
  });

  it.each([
    "authenticity.seller-included",
    "inventory.locations",
    "mcp.rate-tier",
    "support.evidence.any-case ",
    "support.evidence",
  ])("rejects key %s before any event is decided", (capabilityKey) => {
    expect(() =>
      decideAccountCapabilityAssignment(initialAccountCapabilityAssignmentState, grant(0, { capabilityKey } as never)),
    ).toThrow(/support\.evidence\.any-case/);
    expect(() =>
      decideAccountCapabilityAssignment(initialAccountCapabilityAssignmentState, revoke(0, { capabilityKey } as never)),
    ).toThrow(/support\.evidence\.any-case/);
  });

  it.each([
    ["blank tenant", { tenantId: "" }],
    ["hyphenated Account that could alias another stream", { accountId: "acc-a-b" }],
    ["negative expected version", { expectedVersion: -1 }],
    ["fractional expected version", { expectedVersion: 0.5 }],
    ["blank assignment id", { assignmentId: " " }],
  ])("rejects a malformed grant: %s", (_name, overrides) => {
    expect(() =>
      decideAccountCapabilityAssignment(initialAccountCapabilityAssignmentState, grant(0, overrides as never)),
    ).toThrow();
  });

  it("derives one stream per tenant, Account and key", () => {
    expect(toAccountCapabilityAssignmentStreamId(target)).toBe(
      "identity.account-capability-tnt_synthetic-acc_synthetic-support.evidence.any-case",
    );
    expect(toAccountCapabilityAssignmentStreamId({ ...target, accountId: "acc_other" })).not.toBe(
      toAccountCapabilityAssignmentStreamId(target),
    );
    expect(() => toAccountCapabilityAssignmentStreamId({ ...target, capabilityKey: "mcp.rate-tier" } as never)).toThrow(
      /support\.evidence\.any-case/,
    );
  });
});

describe("Account Capability assignment history", () => {
  it.each([
    ["a grant that skips a version", [event("identity.account-capability.granted", 2)]],
    [
      "a repeated version",
      [event("identity.account-capability.granted", 1), event("identity.account-capability.revoked", 1)],
    ],
    [
      "two grants without a revoke",
      [event("identity.account-capability.granted", 1), event("identity.account-capability.granted", 2)],
    ],
    ["a revoke before any grant", [event("identity.account-capability.revoked", 1)]],
    [
      "a revoke after a revoke",
      [
        event("identity.account-capability.granted", 1),
        event("identity.account-capability.revoked", 2),
        event("identity.account-capability.revoked", 3),
      ],
    ],
    [
      "a changed Account",
      [
        event("identity.account-capability.granted", 1),
        event("identity.account-capability.revoked", 2, { accountId: "acc_other" }),
      ],
    ],
    [
      "a changed assignment id",
      [
        event("identity.account-capability.granted", 1),
        event("identity.account-capability.revoked", 2, { assignmentId: "acap_other" }),
      ],
    ],
    ["another key", [event("identity.account-capability.granted", 1, { capabilityKey: "mcp.rate-tier" })]],
    ["a non-string Account", [event("identity.account-capability.granted", 1, { accountId: 7 })]],
  ])("fails deterministically on poisoned history: %s", (_name, events) => {
    expect(() => replay(events)).toThrow(/Account Capability/);
  });

  it("refuses to decide against a stream whose stored target differs from the command", () => {
    const foreign = replay([event("identity.account-capability.granted", 1, { tenantId: "tnt_other" })]);

    expect(() => decideAccountCapabilityAssignment(foreign, grant(0))).toThrow(/another tenant, Account, or capability/);
  });
});
