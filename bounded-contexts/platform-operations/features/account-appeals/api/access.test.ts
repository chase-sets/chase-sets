import { describe, expect, it } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  APPEALABLE_ACTION_INDETERMINATE,
  createAppealableEnforcementActionResolver,
  ACCOUNT_APPEAL_FORBIDDEN,
  ACCOUNT_APPEAL_UNAUTHENTICATED,
  withAccountAppealSellerAccess,
} from "./access";
import type { AccountAppealRuntime } from "./runtime";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import manifest from "../../../context.json" with { type: "json" };

const actor = {
  sessionId: createId("ses"),
  tenantId: createId("tnt"),
  userId: createId("usr"),
  accountId: createId("acc"),
  membershipId: createId("mbr"),
  roleKey: "seller",
  permissions: ["account-appeals.file"],
} as const;

const account = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV" as AccountId;
const user = "usr_01ARZ3NDEKTSV4RRFFQ69F5AV" as UserId;
// @ts-expect-error capability brands are minted only by access guards.
const forgedSeller: import("./access").AccountAppealSellerCapability = {
  tenantId: "tnt",
  accountId: account,
  userId: user,
  permission: "account-appeals.file",
};
// @ts-expect-error capability brands are minted only by access guards.
const forgedOperator: import("./access").AccountAppealOperatorCapability = {
  tenantId: "tnt",
  userId: user,
  roleKey: "ops",
  permission: "account-appeals.review",
};
// @ts-expect-error runtime has typed capability entry points, not a raw command escape hatch.
type RawRuntimeCommand = AccountAppealRuntime["command"];
void (null as RawRuntimeCommand | null);
void forgedSeller;
void forgedOperator;

describe("account appeal access", () => {
  it("mints an account-owner capability only for an exact permission", async () => {
    await withAccountAppealSellerAccess(actor, "account-appeals.file", async (owner) => {
      const action = createId("enf");
      const resolve = createAppealableEnforcementActionResolver({
        resolve: async () => ({
          appealableActionId: action,
          ownerAccountId: owner.accountId,
          source: "identity.account.suspended",
          sourceStreamId: "identity.account-x",
          sourceStreamVersion: 2,
        }),
      });
      await expect(resolve(owner, action)).resolves.toMatchObject({ status: "resolved" });
    });
    expect(withAccountAppealSellerAccess({ ...actor, permissions: [] }, "account-appeals.file", () => undefined)).toBe(
      ACCOUNT_APPEAL_FORBIDDEN,
    );
  });

  it("returns one byte-identical indeterminate value for absent, foreign and conflicted rows", async () => {
    await withAccountAppealSellerAccess(actor, "account-appeals.file", async (owner) => {
      const action = createId("enf");
      const absent = await createAppealableEnforcementActionResolver({ resolve: async () => null })(owner, action);
      const foreign = await createAppealableEnforcementActionResolver({
        resolve: async () => ({
          appealableActionId: action,
          ownerAccountId: createId("acc"),
          source: "identity.account.suspended",
          sourceStreamId: "s",
          sourceStreamVersion: 1,
        }),
      })(owner, action);
      const conflicted = await createAppealableEnforcementActionResolver({
        resolve: async () => ({
          appealableActionId: action,
          ownerAccountId: owner.accountId,
          source: "identity.account.suspended",
          sourceStreamId: "s",
          sourceStreamVersion: 1,
          conflicted: true,
        }),
      })(owner, action);
      expect(absent).toBe(APPEALABLE_ACTION_INDETERMINATE);
      expect(foreign).toBe(APPEALABLE_ACTION_INDETERMINATE);
      expect(conflicted).toBe(APPEALABLE_ACTION_INDETERMINATE);
    });
  });

  it("returns stable authentication and authorization rejections without invoking the callback", () => {
    const run = () => "called";
    expect(withAccountAppealSellerAccess({ ...actor, tenantId: null }, "account-appeals.file", run)).toBe(
      ACCOUNT_APPEAL_UNAUTHENTICATED,
    );
    expect(withAccountAppealSellerAccess({ ...actor, permissions: [] }, "account-appeals.file", run)).toBe(
      ACCOUNT_APPEAL_FORBIDDEN,
    );
  });

  it("resolved manifest", () => {
    const declarations = manifest.eventSubscriptions.filter(
      (entry) => entry.projectionName === "account-appeal-projection",
    );
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.eventTypes).toEqual([
      "platform-operations.account-appeal.filed",
      "platform-operations.account-appeal.review-started",
      "platform-operations.account-appeal.outcome-recorded",
      "platform-operations.account-appeal.withdrawn",
    ]);
  });
});
