import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  createId,
  type AccountId,
  type EnforcementActionId,
  type ListingEnforcementActionId,
  type TypedUlid,
  type UserId,
} from "@chase-sets/primitives/typed-ids";

export type AccountAppealId = TypedUlid<"apl">;
export type AppealStatus = "filed" | "in-review" | "upheld" | "reversed" | "modified" | "withdrawn";
export type AppealableActionSource = "enf" | "lea";

export type AppealableEnforcementAction = Readonly<{
  appealableActionId: EnforcementActionId | ListingEnforcementActionId;
  ownerAccountId: AccountId;
  source: AppealableActionSource;
  sourceStreamId: string;
  sourceStreamVersion: number;
}>;

export type AccountAppealState = Readonly<{
  id: AccountAppealId | null;
  tenantId: string | null;
  accountId: AccountId | null;
  action: AppealableEnforcementAction | null;
  statement: string | null;
  status: AppealStatus | null;
  outcome: "upheld" | "reversed" | "modified" | null;
  rationale: string | null;
  note: string | null;
  filedByUserId: UserId | null;
}>;

export const initialAccountAppealState: AccountAppealState = {
  id: null,
  tenantId: null,
  accountId: null,
  action: null,
  statement: null,
  status: null,
  outcome: null,
  rationale: null,
  note: null,
  filedByUserId: null,
};

export const ACCOUNT_APPEAL_DUPLICATE_FILING_CONTRACT = Object.freeze({
  caseId: "account-appeal-duplicate-filing",
  given: "an account appeal stream has a filed statement",
  whenStatement: "the same statement is filed again",
  then: "the first appeal id is returned; a differing statement conflicts and terminal or withdrawn appeals reject",
} as const);

export type AccountAppealCommand =
  | Readonly<{
      type: "FileAccountAppeal";
      appealId?: AccountAppealId;
      accountId: AccountId;
      action: AppealableEnforcementAction;
      statement: string;
      filedByUserId: UserId;
      tenantId: string;
    }>
  | Readonly<{ type: "StartAccountAppealReview" }>
  | Readonly<{
      type: "RecordAccountAppealOutcome";
      outcome: "upheld" | "reversed" | "modified";
      rationale: string;
      note: string;
      operatorUserId: UserId;
    }>
  | Readonly<{ type: "WithdrawAccountAppeal" }>;

export type AccountAppealEvent =
  | DomainEvent<
      "platform-operations.account-appeal.filed",
      Readonly<{
        appealId: AccountAppealId;
        tenantId: string;
        accountId: AccountId;
        action: AppealableEnforcementAction;
        statement: string;
        filedByUserId: UserId;
      }>
    >
  | DomainEvent<"platform-operations.account-appeal.review-started", Readonly<Record<string, never>>>
  | DomainEvent<
      "platform-operations.account-appeal.outcome-recorded",
      Readonly<{ outcome: "upheld" | "reversed" | "modified"; rationale: string; note: string; operatorUserId: UserId }>
    >
  | DomainEvent<"platform-operations.account-appeal.withdrawn", Readonly<Record<string, never>>>;

function clean(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

export const decideAccountAppeal: AggregateDecider<AccountAppealState, AccountAppealCommand, AccountAppealEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "FileAccountAppeal": {
      const statement = clean(command.statement, "Appeal statement");
      if (state.status === "filed" || state.status === "in-review") {
        if (state.statement === statement) return [];
        throw new Error(ACCOUNT_APPEAL_DUPLICATE_FILING_CONTRACT.then);
      }
      if (
        state.status === "upheld" ||
        state.status === "reversed" ||
        state.status === "modified" ||
        state.status === "withdrawn"
      ) {
        throw new Error("A terminal or withdrawn appeal cannot be filed.");
      }
      if (state.id !== null) throw new Error("Appeal stream is already initialized.");
      return [
        {
          type: "platform-operations.account-appeal.filed",
          data: {
            appealId: command.appealId ?? createId("apl"),
            tenantId: command.tenantId,
            accountId: command.accountId,
            action: command.action,
            statement,
            filedByUserId: command.filedByUserId,
          },
        },
      ];
    }
    case "StartAccountAppealReview":
      if (state.status === "filed") return [{ type: "platform-operations.account-appeal.review-started", data: {} }];
      if (state.status === "in-review") return [];
      throw new Error("Only a filed appeal can start review.");
    case "RecordAccountAppealOutcome":
      if (state.status === "in-review")
        return [
          {
            type: "platform-operations.account-appeal.outcome-recorded",
            data: {
              outcome: command.outcome,
              rationale: clean(command.rationale, "Outcome rationale"),
              note: clean(command.note, "Outcome note"),
              operatorUserId: command.operatorUserId,
            },
          },
        ];
      if (state.status === command.outcome && state.rationale === command.rationale && state.note === command.note)
        return [];
      throw new Error("Only an in-review appeal can record an outcome.");
    case "WithdrawAccountAppeal":
      if (state.status === "filed" || state.status === "in-review")
        return [{ type: "platform-operations.account-appeal.withdrawn", data: {} }];
      throw new Error("Only a non-terminal appeal can be withdrawn.");
  }
};

export const evolveAccountAppeal: AggregateEvolver<AccountAppealState, AccountAppealEvent> = (state, event) => {
  switch (event.type) {
    case "platform-operations.account-appeal.filed":
      return {
        ...state,
        id: event.data.appealId,
        tenantId: event.data.tenantId,
        accountId: event.data.accountId,
        action: event.data.action,
        statement: event.data.statement,
        status: "filed",
        filedByUserId: event.data.filedByUserId,
      };
    case "platform-operations.account-appeal.review-started":
      return { ...state, status: "in-review" };
    case "platform-operations.account-appeal.outcome-recorded":
      return {
        ...state,
        status: event.data.outcome,
        outcome: event.data.outcome,
        rationale: event.data.rationale,
        note: event.data.note,
      };
    case "platform-operations.account-appeal.withdrawn":
      return { ...state, status: "withdrawn" };
  }
};

export function appealStreamId(actionId: string): string {
  return `platform-operations.account-appeal-${actionId}`;
}
