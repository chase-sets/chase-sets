import { describe, expect, it } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  ACCOUNT_APPEAL_DUPLICATE_FILING_CONTRACT,
  decideAccountAppeal,
  evolveAccountAppeal,
  initialAccountAppealState,
  type AccountAppealState,
} from "./domain";

const account = createId("acc");
const action = createId("enf");
const appeal = createId("apl");
const operator = createId("usr");
const file = { type: "FileAccountAppeal" as const, appealId: appeal, accountId: account, action: { appealableActionId: action, ownerAccountId: account, source: "enf" as const, sourceStreamId: "identity.account-test", sourceStreamVersion: 1 }, statement: "The action was mistaken", filedByUserId: operator, tenantId: createId("tnt") };

function stateAfter(...commands: Parameters<typeof decideAccountAppeal>[1][]): AccountAppealState {
  return commands.reduce((state, command) => evolveAccountAppeal(state, decideAccountAppeal(state, command)[0]!), initialAccountAppealState);
}

describe("account appeal aggregate", () => {
  it("models filing, review and terminal outcome with private facts", () => {
    const filed = decideAccountAppeal(initialAccountAppealState, file);
    expect(filed).toHaveLength(1);
    const reviewing = stateAfter(file, { type: "StartAccountAppealReview" });
    const outcome = decideAccountAppeal(reviewing, { type: "RecordAccountAppealOutcome", outcome: "reversed", rationale: "Evidence changed", note: "Internal note", operatorUserId: operator });
    expect(outcome[0]?.type).toBe("platform-operations.account-appeal.outcome-recorded");
    expect(evolveAccountAppeal(reviewing, outcome[0]!)).toMatchObject({ status: "reversed", rationale: "Evidence changed", note: "Internal note" });
  });

  it("makes retries idempotent and terminal outcomes immutable", () => {
    const reviewing = stateAfter(file, { type: "StartAccountAppealReview" });
    const terminal = evolveAccountAppeal(reviewing, decideAccountAppeal(reviewing, { type: "RecordAccountAppealOutcome", outcome: "upheld", rationale: "Confirmed", note: "Keep", operatorUserId: operator })[0]!);
    expect(() => decideAccountAppeal(terminal, { type: "RecordAccountAppealOutcome", outcome: "reversed", rationale: "Changed", note: "No", operatorUserId: operator })).toThrow();
    expect(ACCOUNT_APPEAL_DUPLICATE_FILING_CONTRACT.then).toContain("differing statement");
  });

  it("covers withdrawal and rejects invalid state transitions", () => {
    const filed = stateAfter(file);
    expect(decideAccountAppeal(filed, { type: "WithdrawAccountAppeal" })).toHaveLength(1);
    expect(() => decideAccountAppeal(initialAccountAppealState, { type: "StartAccountAppealReview" })).toThrow();
  });
});
