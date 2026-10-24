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
});
