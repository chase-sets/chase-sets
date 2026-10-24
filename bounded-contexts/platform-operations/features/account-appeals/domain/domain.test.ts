import { describe, expect, it } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  ACCOUNT_APPEAL_DUPLICATE_FILING_CONTRACT,
  decideAccountAppeal,
  evolveAccountAppeal,
  initialAccountAppealState,
  type AccountAppealCommand,
  type AccountAppealState,
} from "./domain";

const account = createId("acc");
const filer = createId("usr");
const operator = createId("usr");
const file: AccountAppealCommand = {
  type: "FileAccountAppeal",
  appealId: createId("apl"),
  accountId: account,
  action: {
    appealableActionId: createId("enf"),
    ownerAccountId: account,
    source: "identity.account.suspended",
    sourceStreamId: `identity.account-${account}`,
    sourceStreamVersion: 2,
  },
  statement: "The action was mistaken",
  filedByUserId: filer,
  tenantId: createId("tnt"),
};

function run(...commands: AccountAppealCommand[]): AccountAppealState {
  return commands.reduce((state, command) => {
    const events = decideAccountAppeal(state, command);
    return events.reduce(evolveAccountAppeal, state);
  }, initialAccountAppealState);
}

describe("account appeal aggregate", () => {
  it("enumerates the executable duplicate table", () => {
    expect(ACCOUNT_APPEAL_DUPLICATE_FILING_CONTRACT).toEqual([
      { caseId: "open-same", given: "open", whenStatement: "same", then: "no-op-first-id" },
      { caseId: "open-different", given: "open", whenStatement: "different", then: "conflict" },
      { caseId: "closed-same", given: "closed", whenStatement: "same", then: "reject" },
      { caseId: "closed-different", given: "closed", whenStatement: "different", then: "reject" },
    ]);
    expect(Object.isFrozen(ACCOUNT_APPEAL_DUPLICATE_FILING_CONTRACT)).toBe(true);
  });

  it("files, reviews, records a terminal payload, and preserves it", () => {
    const filed = run(file);
    expect(filed.status).toBe("filed");
    const reviewing = run(file, { type: "StartAccountAppealReview" });
    const terminal = run(
      file,
      { type: "StartAccountAppealReview" },
      {
        type: "RecordAccountAppealOutcome",
        outcome: "reversed",
        rationale: "  Evidence changed ",
        note: " Internal ",
        operatorUserId: operator,
      },
    );
    expect(reviewing.status).toBe("in-review");
    expect(terminal).toMatchObject({
      status: "reversed",
      outcome: "reversed",
      rationale: "Evidence changed",
      note: "Internal",
      operatorUserId: operator,
    });
    expect(
      decideAccountAppeal(terminal, {
        type: "RecordAccountAppealOutcome",
        outcome: "reversed",
        rationale: "Evidence changed",
        note: "Internal",
        operatorUserId: operator,
      }),
    ).toEqual([]);
    expect(() =>
      decideAccountAppeal(terminal, {
        type: "RecordAccountAppealOutcome",
        outcome: "upheld",
        rationale: "Changed",
        note: "No",
        operatorUserId: operator,
      }),
    ).toThrow();
  });

  it("makes identical open filings no-op, differing filings conflict, and terminals reject", () => {
    const filed = run(file);
    expect(decideAccountAppeal(filed, { ...file, statement: "  The action was mistaken " })).toEqual([]);
    expect(() => decideAccountAppeal(filed, { ...file, statement: "A different reason" })).toThrow();
    const withdrawn = run(file, { type: "WithdrawAccountAppeal" });
    expect(withdrawn.status).toBe("withdrawn");
    expect(() => decideAccountAppeal(withdrawn, file)).toThrow();
  });

  it("rejects impossible histories and invalid transitions", () => {
    expect(() =>
      evolveAccountAppeal(initialAccountAppealState, {
        type: "platform-operations.account-appeal.review-started",
        data: {},
      }),
    ).toThrow();
    expect(() => decideAccountAppeal(initialAccountAppealState, { type: "StartAccountAppealReview" })).toThrow();
    expect(() => decideAccountAppeal(initialAccountAppealState, { ...file, accountId: createId("acc") })).toThrow();
  });

  it.each([
    ["empty", initialAccountAppealState, "FileAccountAppeal", "event"],
    ["empty", initialAccountAppealState, "StartAccountAppealReview", "error"],
    ["empty", initialAccountAppealState, "RecordAccountAppealOutcome", "error"],
    ["empty", initialAccountAppealState, "WithdrawAccountAppeal", "error"],
    ["filed", run(file), "FileAccountAppeal", "noop"],
    ["filed", run(file), "StartAccountAppealReview", "event"],
    ["filed", run(file), "RecordAccountAppealOutcome", "error"],
    ["filed", run(file), "WithdrawAccountAppeal", "event"],
    ["in-review", run(file, { type: "StartAccountAppealReview" }), "FileAccountAppeal", "noop"],
    ["in-review", run(file, { type: "StartAccountAppealReview" }), "StartAccountAppealReview", "noop"],
    ["in-review", run(file, { type: "StartAccountAppealReview" }), "RecordAccountAppealOutcome", "event"],
    ["in-review", run(file, { type: "StartAccountAppealReview" }), "WithdrawAccountAppeal", "event"],
    ...(["upheld", "reversed", "modified"] as const).flatMap((status) => {
      const state = run(
        file,
        { type: "StartAccountAppealReview" },
        {
          type: "RecordAccountAppealOutcome",
          outcome: status,
          rationale: "Rationale",
          note: "Note",
          operatorUserId: operator,
        },
      );
      return [
        [status, state, "FileAccountAppeal", "error"],
        [status, state, "StartAccountAppealReview", "error"],
        [status, state, "RecordAccountAppealOutcome", "noop"],
        [status, state, "WithdrawAccountAppeal", "error"],
      ];
    }),
    ["withdrawn", run(file, { type: "WithdrawAccountAppeal" }), "FileAccountAppeal", "error"],
    ["withdrawn", run(file, { type: "WithdrawAccountAppeal" }), "StartAccountAppealReview", "error"],
    ["withdrawn", run(file, { type: "WithdrawAccountAppeal" }), "RecordAccountAppealOutcome", "error"],
    ["withdrawn", run(file, { type: "WithdrawAccountAppeal" }), "WithdrawAccountAppeal", "error"],
  ] as const)("seven-state transition matrix: %s + %s => %s", (_status, state, type, expected) => {
    const terminalOutcome =
      state.status === "upheld" || state.status === "reversed" || state.status === "modified"
        ? state.status
        : "reversed";
    const command =
      type === "FileAccountAppeal"
        ? file
        : type === "StartAccountAppealReview"
          ? ({ type } as const)
          : type === "WithdrawAccountAppeal"
            ? ({ type } as const)
            : {
                type: "RecordAccountAppealOutcome" as const,
                outcome: terminalOutcome,
                rationale: "Rationale",
                note: "Note",
                operatorUserId: operator,
              };
    if (expected === "error") {
      expect(() => decideAccountAppeal(state, command)).toThrow();
    } else if (expected === "noop") {
      expect(decideAccountAppeal(state, command)).toEqual([]);
    } else {
      expect(decideAccountAppeal(state, command)).toHaveLength(1);
    }
  });

  it.each([
    { type: "platform-operations.account-appeal.review-started", data: {} },
    {
      type: "platform-operations.account-appeal.outcome-recorded",
      data: { outcome: "reversed", rationale: "Rationale", note: "Note", operatorUserId: operator },
    },
    { type: "platform-operations.account-appeal.withdrawn", data: {} },
  ] as const)("rejects poisoned history event %j", (event) => {
    expect(() => evolveAccountAppeal(initialAccountAppealState, event)).toThrow();
  });

  it("rejects unknown event types deterministically", () => {
    expect(() =>
      evolveAccountAppeal(initialAccountAppealState, {
        type: "platform-operations.account-appeal.unknown",
        data: {},
      } as never),
    ).toThrow("Unknown account appeal event");
  });
});
