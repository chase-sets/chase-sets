import type {
  AccountAppealOperatorCapability,
  AccountAppealSellerCapability,
  AppealableEnforcementActionCapability,
} from "@chase-sets/platform-operations/features/account-appeals/api/access";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
const account = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV" as AccountId;
const user = "usr_01ARZ3NDEKTSV4RRFFQ69FAV" as UserId;
// @ts-expect-error capabilities are minted only by access guards.
const seller: AccountAppealSellerCapability = {
  tenantId: "tnt",
  accountId: account,
  userId: user,
  permission: "account-appeals.file",
};
// @ts-expect-error capabilities are minted only by access guards.
const operator: AccountAppealOperatorCapability = {
  tenantId: "tnt",
  userId: user,
  roleKey: "ops",
  permission: "account-appeals.review",
};
// @ts-expect-error action capabilities are minted only by registry resolution.
const action: AppealableEnforcementActionCapability = {
  appealableActionId: "enf_01ARZ6S41TSV4RRFFQ69F5AV",
  ownerAccountId: account,
  source: "enf",
  sourceStreamId: "identity.account-x",
  sourceStreamVersion: 1,
};
void seller;
void operator;
void action;
