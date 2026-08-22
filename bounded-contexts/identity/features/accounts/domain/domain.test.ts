import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accountEnforcementReasonCodes,
  accountEnforcementReversalReasonCodes,
  type AccountEnforcementReasonCode,
  type AccountEnforcementReversalReasonCode,
} from "@chase-sets/event-core";
import { decideAccount, evolveAccount, GUEST_ACCOUNT_PLACEHOLDER_DISPLAY_NAME, initialAccountState } from "./domain";

const ENFORCEMENT_A = "enf_01ARYZ6S41TSV4RRFFQ69G5FAV" as const;
const ENFORCEMENT_B = "enf_01ARYZ6S41TSV4RRFFQ69G5FAW" as const;
const ENFORCEMENT_C = "enf_01ARYZ6S41TSV4RRFFQ69G5FAX" as const;
const SUPPORT_REQUEST = "sup_01ARYZ6S41TSV4RRFFQ69G5FAV" as const;

function enforcement<Reason extends AccountEnforcementReasonCode | AccountEnforcementReversalReasonCode>(
  enforcementActionId: typeof ENFORCEMENT_A | typeof ENFORCEMENT_B | typeof ENFORCEMENT_C,
  reason: Reason,
) {
  return {
    version: 1 as const,
    enforcementActionId,
    reason,
    reference: null,
  };
}

function rawCreatedAccountState() {
  return evolveAccount(initialAccountState, {
    type: "identity.account.created",
    data: {
      accountId: "acc_01ARYZ6S41TSV4RRFFQ69G5FAV",
      name: "North Store LLC",
      accountType: "business",
      displayName: "North Store",
    },
  });
}

describe("account domain", () => {
  function guestAccountEvents() {
    return decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_guest_converge" as never,
      name: "",
      accountType: "personal",
      displayName: GUEST_ACCOUNT_PLACEHOLDER_DISPLAY_NAME,
    });
  }

  it("replays a converged guest Account and leaves historical accounts at the placeholder", () => {
    const created = guestAccountEvents();
    const guestState = created.reduce(evolveAccount, initialAccountState);

    expect(guestState.displayName).toBe("Guest");
    expect(guestState.name).toBe("");

    const converged = decideAccount(guestState, {
      type: "ConvergeGuestAccountDisplayName",
      displayName: "  Buyer Example  ",
    });

    // The event carries the Account's own committed legal name. Omitting or
    // defaulting it would make `evolveAccount` rewrite the legal name from the
    // display name, which guest Accounts deliberately leave empty.
    expect(converged).toEqual([
      {
        type: "identity.account.profile-updated",
        data: { name: "", displayName: "Buyer Example" },
      },
    ]);

    // Full-stream replay, not the guard read plus a delta.
    const replayed = [...created, ...converged].reduce(evolveAccount, initialAccountState);
    expect(replayed.displayName).toBe("Buyer Example");
    expect(replayed.name).toBe("");

    // An Account minted before this slice carries no convergence event, and
    // replaying it leaves the placeholder exactly where it was -- there is no
    // backfill anywhere in this behaviour.
    const historical = created.reduce(evolveAccount, initialAccountState);
    expect(historical.displayName).toBe("Guest");
    expect(historical.name).toBe("");
  });

  it("converges a guest display name at most once and refuses every state outside that window", () => {
    const created = guestAccountEvents();
    const guestState = created.reduce(evolveAccount, initialAccountState);
    const convergedState = decideAccount(guestState, {
      type: "ConvergeGuestAccountDisplayName",
      displayName: "Buyer Example",
    }).reduce(evolveAccount, guestState);

    // Repeated: the committed post-state is the idempotency authority, so the
    // same name against the same Account appends nothing.
    expect(
      decideAccount(convergedState, { type: "ConvergeGuestAccountDisplayName", displayName: "Buyer Example" }),
    ).toEqual([]);
    expect(
      decideAccount(convergedState, { type: "ConvergeGuestAccountDisplayName", displayName: " Buyer Example " }),
    ).toEqual([]);

    // Already converged, asked for a different name.
    expect(() =>
      decideAccount(convergedState, { type: "ConvergeGuestAccountDisplayName", displayName: "Someone Else" }),
    ).toThrow(/placeholder display name/);

    // Never a placeholder in the first place.
    const namedState = evolveAccount(initialAccountState, {
      type: "identity.account.created",
      data: {
        accountId: "acc_named" as never,
        name: "North Store LLC",
        accountType: "business",
        displayName: "North Store",
      },
    });
    expect(() =>
      decideAccount(namedState, { type: "ConvergeGuestAccountDisplayName", displayName: "Buyer Example" }),
    ).toThrow(/placeholder display name/);

    // Terminal.
    const closedState = decideAccount(guestState, {
      type: "CloseAccount",
      enforcement: enforcement(ENFORCEMENT_A, "operator-other"),
    }).reduce(evolveAccount, guestState);
    expect(() =>
      decideAccount(closedState, { type: "ConvergeGuestAccountDisplayName", displayName: "Buyer Example" }),
    ).toThrow(/Closed accounts cannot converge/);

    // Empty aggregate history.
    expect(() =>
      decideAccount(initialAccountState, { type: "ConvergeGuestAccountDisplayName", displayName: "Buyer Example" }),
    ).toThrow(/Account must be created first/);

    // A blank bound contact name is not a name to converge to.
    expect(() => decideAccount(guestState, { type: "ConvergeGuestAccountDisplayName", displayName: "   " })).toThrow(
      /bound contact name/,
    );
  });

  it("creates and suspends an account", () => {
    const created = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_test" as never,
      name: "North Store LLC",
      accountType: "business",
      displayName: "North Store",
    });
    const createdState = created.reduce(evolveAccount, initialAccountState);
    const suspended = decideAccount(createdState, {
      type: "SuspendAccount",
      enforcement: enforcement(ENFORCEMENT_A, "operator-other"),
    });
    const suspendedState = suspended.reduce(evolveAccount, createdState);

    expect(createdState.displayName).toBe("North Store");
    expect(suspendedState.status).toBe("suspended");
  });

  it("accepts enterprise accounts", () => {
    const created = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_enterprise" as never,
      name: "Enterprise Seller LLC",
      accountType: "enterprise",
      displayName: "Enterprise Seller",
    });
    const createdState = created.reduce(evolveAccount, initialAccountState);

    expect(createdState.accountType).toBe("enterprise");
  });

  it("publishes the normalized grant-time recipient when the founders window opens", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    }).reduce(evolveAccount, initialAccountState);

    const opened = decideAccount(createdState, {
      type: "OpenFoundersWindow",
      betaAccessStartedAt: "2026-07-31T12:00:00.000Z",
      foundersWindowEndsAt: "2026-09-29T12:00:00.000Z",
      recipientEmail: " Founder@Example.COM ",
    });

    expect(opened).toEqual([
      {
        type: "identity.account.founders-window-opened",
        data: {
          betaAccessStartedAt: "2026-07-31T12:00:00.000Z",
          foundersWindowEndsAt: "2026-09-29T12:00:00.000Z",
          recipientEmail: "founder@example.com",
        },
      },
    ]);
  });

  it("assigns founding account badges idempotently", () => {
    const created = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    });
    const createdState = created.reduce(evolveAccount, initialAccountState);

    const assigned = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "founding-account",
      founderNumber: 47,
    });
    const assignedState = assigned.reduce(evolveAccount, createdState);
    const assignedAgain = decideAccount(assignedState, {
      type: "AssignAccountBadge",
      badgeKey: "founding-account",
      founderNumber: 47,
    });

    expect(assigned).toEqual([
      {
        type: "identity.account.badge-assigned",
        data: { badgeKey: "founding-account", founderNumber: 47 },
      },
    ]);
    expect(assignedState.badges).toEqual(["founding-account"]);
    expect(assignedState.founderNumber).toBe(47);
    expect(assignedAgain).toEqual([]);
  });

  it("removes operator-managed account badges idempotently", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    }).reduce(evolveAccount, initialAccountState);
    const assignedState = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "manual-payout-review",
    }).reduce(evolveAccount, createdState);

    const removed = decideAccount(assignedState, {
      type: "RemoveAccountBadge",
      badgeKey: "manual-payout-review",
    });
    const removedState = removed.reduce(evolveAccount, assignedState);
    const removedAgain = decideAccount(removedState, {
      type: "RemoveAccountBadge",
      badgeKey: "manual-payout-review",
    });

    expect(removedState.badges).toEqual([]);
    expect(removedAgain).toEqual([]);
  });

  it("keeps numbered founding account badges permanent", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    }).reduce(evolveAccount, initialAccountState);
    const assignedState = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "founding-account",
      founderNumber: 47,
    }).reduce(evolveAccount, createdState);

    expect(() => decideAccount(assignedState, { type: "RemoveAccountBadge", badgeKey: "founding-account" })).toThrow(
      "Founding Account badges are permanent.",
    );
  });

  it("assigns seller trust and manual payout review badges", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_trust" as never,
      name: "Trust Review LLC",
      accountType: "business",
      displayName: "Trust Review",
    }).reduce(evolveAccount, initialAccountState);

    const trustedState = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "trusted-seller",
    }).reduce(evolveAccount, createdState);
    const reviewState = decideAccount(trustedState, {
      type: "AssignAccountBadge",
      badgeKey: "manual-payout-review",
    }).reduce(evolveAccount, trustedState);

    expect(reviewState.badges).toEqual(["manual-payout-review", "trusted-seller"]);
  });

  it.each([
    ["missing enforcement", { type: "SuspendAccount" }],
    ["partial enforcement", { type: "SuspendAccount", enforcement: { version: 1 } }],
    [
      "unknown enforcement member",
      {
        type: "SuspendAccount",
        enforcement: { ...enforcement(ENFORCEMENT_A, "operator-other"), severity: "high" },
      },
    ],
    ["wrong reason union", { type: "SuspendAccount", enforcement: enforcement(ENFORCEMENT_A, "appeal-upheld") }],
    [
      "unknown reference kind",
      {
        type: "SuspendAccount",
        enforcement: {
          ...enforcement(ENFORCEMENT_A, "operator-other"),
          reference: { kind: "case", supportRequestId: SUPPORT_REQUEST },
        },
      },
    ],
    [
      "malformed support request id",
      {
        type: "SuspendAccount",
        enforcement: {
          ...enforcement(ENFORCEMENT_A, "operator-other"),
          reference: { kind: "support-request", supportRequestId: "sup_" },
        },
      },
    ],
  ])("rejects a %s command payload", (_case, command) => {
    expect(() => decideAccount(rawCreatedAccountState(), command as never)).toThrow();
  });

  it("emits exact supplied enforcement facts deterministically for every reason code", () => {
    const active = rawCreatedAccountState();

    for (const reason of accountEnforcementReasonCodes) {
      const command = {
        type: "SuspendAccount" as const,
        enforcement: {
          ...enforcement(ENFORCEMENT_A, reason),
          reference: { kind: "support-request" as const, supportRequestId: SUPPORT_REQUEST },
        },
      };
      const first = decideAccount(active, command);
      const second = decideAccount(active, command);
      expect(second).toEqual(first);
      expect(first).toEqual([
        {
          type: "identity.account.suspended",
          data: { enforcement: command.enforcement },
        },
      ]);
      expect(
        decideAccount(active, {
          ...command,
          enforcement: { ...command.enforcement, enforcementActionId: ENFORCEMENT_B },
        }),
      ).toEqual([
        {
          type: "identity.account.suspended",
          data: { enforcement: { ...command.enforcement, enforcementActionId: ENFORCEMENT_B } },
        },
      ]);

      const closeCommand = { type: "CloseAccount" as const, enforcement: command.enforcement };
      expect(decideAccount(active, closeCommand)).toEqual([
        { type: "identity.account.closed", data: { enforcement: closeCommand.enforcement } },
      ]);
    }

    const suspended = evolveAccount(active, {
      type: "identity.account.suspended",
      data: { enforcement: enforcement(ENFORCEMENT_A, "operator-other") },
    });
    for (const reason of accountEnforcementReversalReasonCodes) {
      const command = { type: "ReactivateAccount" as const, enforcement: enforcement(ENFORCEMENT_B, reason) };
      expect(decideAccount(suspended, command)).toEqual([
        { type: "identity.account.reactivated", data: { enforcement: command.enforcement } },
      ]);
    }
    expect(readFileSync(new URL("./domain.ts", import.meta.url), "utf8")).not.toMatch(/\bcreateId\s*\(/);
  });

  it("folds legacy lifecycle events without inventing or erasing enforcement facts", () => {
    const active = rawCreatedAccountState();
    const legacySuspended = evolveAccount(active, { type: "identity.account.suspended", data: {} });
    const modernReactivated = evolveAccount(legacySuspended, {
      type: "identity.account.reactivated",
      data: { enforcement: enforcement(ENFORCEMENT_A, "issue-resolved") },
    });
    const legacyClosed = evolveAccount(modernReactivated, { type: "identity.account.closed", data: {} });

    expect(legacySuspended).toMatchObject({
      status: "suspended",
      lastEnforcementAction: null,
      openEnforcementActionId: null,
      usedEnforcementActionIds: [],
    });
    expect(legacyClosed.status).toBe("closed");
    expect(legacyClosed.lastEnforcementAction).toEqual(modernReactivated.lastEnforcementAction);
    expect(legacyClosed.usedEnforcementActionIds).toEqual([ENFORCEMENT_A]);
  });

  it.each([
    { enforcement: { version: 1 } },
    { enforcement: enforcement(ENFORCEMENT_A, "appeal-upheld") },
    { enforcement: { ...enforcement(ENFORCEMENT_A, "operator-other"), extra: true } },
    { unknown: true },
  ])("rejects corrupt modern stored suspension data: $enforcement", (data) => {
    expect(() =>
      evolveAccount(rawCreatedAccountState(), { type: "identity.account.suspended", data } as never),
    ).toThrow();
  });

  it("executes the complete enforcement lifecycle and never reuses an action id", () => {
    const active = rawCreatedAccountState();
    const suspendedAEvent = {
      type: "identity.account.suspended" as const,
      data: { enforcement: enforcement(ENFORCEMENT_A, "policy-violation") },
    };
    const suspendedA = evolveAccount(active, suspendedAEvent);
    const exactAdjacentReplay = evolveAccount(suspendedA, suspendedAEvent);
    const reactivatedB = evolveAccount(suspendedA, {
      type: "identity.account.reactivated",
      data: { enforcement: enforcement(ENFORCEMENT_B, "appeal-upheld") },
    });
    const suspendedC = evolveAccount(reactivatedB, {
      type: "identity.account.suspended",
      data: { enforcement: enforcement(ENFORCEMENT_C, "operator-other") },
    });
    const closedFromSuspended = evolveAccount(suspendedA, {
      type: "identity.account.closed",
      data: { enforcement: enforcement(ENFORCEMENT_C, "seller-requested") },
    });

    expect(suspendedA).toMatchObject({ status: "suspended", openEnforcementActionId: ENFORCEMENT_A });
    expect(exactAdjacentReplay).toBe(suspendedA);
    expect(reactivatedB).toMatchObject({ status: "active", openEnforcementActionId: null });
    expect(suspendedC).toMatchObject({ status: "suspended", openEnforcementActionId: ENFORCEMENT_C });
    expect(closedFromSuspended).toMatchObject({ status: "closed", openEnforcementActionId: ENFORCEMENT_C });
    expect(closedFromSuspended.usedEnforcementActionIds).toEqual([ENFORCEMENT_A, ENFORCEMENT_C]);
    expect(suspendedC.usedEnforcementActionIds).toEqual([ENFORCEMENT_A, ENFORCEMENT_B, ENFORCEMENT_C]);

    expect(() =>
      evolveAccount(suspendedA, {
        type: "identity.account.suspended",
        data: { enforcement: enforcement(ENFORCEMENT_B, "operator-other") },
      }),
    ).toThrow("Stored account suspension is invalid for the current status.");
    expect(() =>
      evolveAccount(reactivatedB, {
        type: "identity.account.suspended",
        data: { enforcement: enforcement(ENFORCEMENT_A, "policy-violation") },
      }),
    ).toThrow("Account enforcement action id has already been used.");
    expect(() =>
      decideAccount(reactivatedB, {
        type: "SuspendAccount",
        enforcement: enforcement(ENFORCEMENT_A, "policy-violation"),
      }),
    ).toThrow("Account enforcement action id has already been used.");
    expect(() =>
      evolveAccount(suspendedA, {
        type: "identity.account.suspended",
        data: { enforcement: enforcement(ENFORCEMENT_A, "payment-risk") },
      }),
    ).toThrow("Account enforcement action id has already been used.");
  });

  it("keeps all lifecycle preconditions unchanged for every reason code", () => {
    const active = rawCreatedAccountState();
    const suspended = evolveAccount(active, {
      type: "identity.account.suspended",
      data: { enforcement: enforcement(ENFORCEMENT_A, "operator-other") },
    });
    const closed = evolveAccount(active, {
      type: "identity.account.closed",
      data: { enforcement: enforcement(ENFORCEMENT_B, "operator-other") },
    });

    for (const reason of accountEnforcementReasonCodes) {
      expect(() =>
        decideAccount(suspended, { type: "SuspendAccount", enforcement: enforcement(ENFORCEMENT_C, reason) }),
      ).toThrow("Only active accounts can be suspended.");
      expect(() =>
        decideAccount(closed, { type: "CloseAccount", enforcement: enforcement(ENFORCEMENT_C, reason) }),
      ).toThrow("Account has already been closed.");
      expect(
        decideAccount(suspended, {
          type: "CloseAccount",
          enforcement: enforcement(ENFORCEMENT_C, reason),
        }),
      ).toEqual([
        {
          type: "identity.account.closed",
          data: { enforcement: enforcement(ENFORCEMENT_C, reason) },
        },
      ]);
    }
    for (const reason of accountEnforcementReversalReasonCodes) {
      expect(() =>
        decideAccount(active, { type: "ReactivateAccount", enforcement: enforcement(ENFORCEMENT_C, reason) }),
      ).toThrow("Only suspended accounts can be reactivated.");
    }
  });
});
