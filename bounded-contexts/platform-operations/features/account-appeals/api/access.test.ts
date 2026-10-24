import { describe, expect, it } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  ACCOUNT_APPEAL_FORBIDDEN,
  ACCOUNT_APPEAL_UNAUTHENTICATED,
  APPEALABLE_ACTION_INDETERMINATE,
  assertAccountAppealFileCapability,
  assertAccountAppealOperatorCapability,
  assertAppealableEnforcementActionCapability,
  createAppealableEnforcementActionResolver,
  fileAccountAppeal,
  withAccountAppealOperatorAccess,
  withAccountAppealSellerAccess,
} from "./access";

const actor = {
  tenantId: createId("tnt"),
  accountId: createId("acc"),
  userId: createId("usr"),
  permissions: ["account-appeals.file", "account-appeals.view"],
  roleKey: "seller",
} as const;

const action = {
  appealableActionId: createId("enf"),
  ownerAccountId: actor.accountId,
  source: "identity.account.suspended" as const,
  sourceStreamId: `identity.account-${actor.accountId}`,
  sourceStreamVersion: 2,
};

// @ts-expect-error capability brands are minted only by the access guard.
const forgedSeller: import("./access").AccountAppealSellerCapability = {
  tenantId: actor.tenantId,
  accountId: actor.accountId,
  userId: actor.userId,
  permission: "account-appeals.file",
};
void forgedSeller;

if (false) {
  withAccountAppealSellerAccess(actor, "account-appeals.view", (capability) => {
    // @ts-expect-error a view capability cannot construct a filing command.
    fileAccountAppeal(capability, null as never, { statement: "not allowed" });
  });
}

describe("account appeal access", () => {
  it("mints only exact, frozen capabilities and invokes the callback", () => {
    let called = false;
    const result = withAccountAppealSellerAccess(actor, "account-appeals.file", (capability) => {
      called = true;
      expect(capability.permission).toBe("account-appeals.file");
      expect(Object.isFrozen(capability)).toBe(true);
      return capability;
    });
    expect(called).toBe(true);
    expect(result).toMatchObject({ accountId: actor.accountId, permission: "account-appeals.file" });
    expect(withAccountAppealSellerAccess({ ...actor, permissions: [] }, "account-appeals.file", () => "called")).toBe(
      ACCOUNT_APPEAL_FORBIDDEN,
    );
    expect(withAccountAppealSellerAccess({ ...actor, tenantId: null }, "account-appeals.file", () => "called")).toBe(
      ACCOUNT_APPEAL_UNAUTHENTICATED,
    );
  });

  it("rejects operator identity and permission failures without invoking work", () => {
    const run = () => "called";
    expect(withAccountAppealOperatorAccess({ ...actor, roleKey: null }, "account-appeals.review", run)).toBe(
      ACCOUNT_APPEAL_UNAUTHENTICATED,
    );
    expect(withAccountAppealOperatorAccess({ ...actor, permissions: [] }, "account-appeals.review", run)).toBe(
      ACCOUNT_APPEAL_FORBIDDEN,
    );
  });

  it("keeps absent, foreign and conflicted lookup results indistinguishable", async () => {
    await withAccountAppealSellerAccess(actor, "account-appeals.view", async (capability) => {
      const absent = await createAppealableEnforcementActionResolver({
        resolve: async () => APPEALABLE_ACTION_INDETERMINATE,
      })(capability, action.appealableActionId);
      const foreign = await createAppealableEnforcementActionResolver({
        resolve: async () => APPEALABLE_ACTION_INDETERMINATE,
      })(capability, action.appealableActionId);
      expect(absent).toBe(APPEALABLE_ACTION_INDETERMINATE);
      expect(foreign).toBe(APPEALABLE_ACTION_INDETERMINATE);
    });
  });

  it("mints an action capability only from the closure-bound owner lookup", async () => {
    await withAccountAppealSellerAccess(actor, "account-appeals.view", async (capability) => {
      const resolve = createAppealableEnforcementActionResolver({
        resolve: async (actionId, ownerAccountId) =>
          ownerAccountId === capability.accountId
            ? { ...action, appealableActionId: actionId }
            : APPEALABLE_ACTION_INDETERMINATE,
      });
      const resolved = await resolve(capability, action.appealableActionId);
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") expect(Object.isFrozen(resolved.action)).toBe(true);
    });
  });

  it("rejects forged seller, operator, and action objects at every access boundary", async () => {
    const forgedSeller = {
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      userId: actor.userId,
      permission: "account-appeals.file",
    } as never;
    const forgedOperator = {
      tenantId: actor.tenantId,
      userId: actor.userId,
      roleKey: "trust-operator",
      permission: "account-appeals.review",
    } as never;
    const forgedAction = { ...action } as never;

    expect(() => assertAccountAppealFileCapability(forgedSeller)).toThrow("seller capability is invalid");
    expect(() => assertAccountAppealOperatorCapability(forgedOperator)).toThrow("operator capability is invalid");
    expect(() => assertAppealableEnforcementActionCapability(forgedAction)).toThrow(
      "enforcement action capability is invalid",
    );
    await expect(
      createAppealableEnforcementActionResolver({ resolve: async () => action })(
        forgedSeller,
        action.appealableActionId,
      ),
    ).rejects.toThrow("seller capability is invalid");

    await withAccountAppealSellerAccess(actor, "account-appeals.file", async (capability) => {
      expect(() => fileAccountAppeal(capability, forgedAction, { statement: "forged action" })).toThrow(
        "enforcement action capability is invalid",
      );
    });
  });
});
