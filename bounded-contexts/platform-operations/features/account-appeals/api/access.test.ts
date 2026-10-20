import { describe, expect, it } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  APPEALABLE_ACTION_INDETERMINATE,
  resolveAppealableEnforcementAction,
  withAccountAppealSellerAccess,
} from "./access";

const actor = {
  sessionId: createId("ses"), tenantId: createId("tnt"), userId: createId("usr"), accountId: createId("acc"), membershipId: createId("mbr"), roleKey: "seller", permissions: ["account-appeals.file"],
} as const;

describe("account appeal access", () => {
  it("mints an account-owner capability only for an exact permission", async () => {
    await withAccountAppealSellerAccess(actor, "account-appeals.file", async (owner) => {
      const action = createId("enf");
      await expect(resolveAppealableEnforcementAction(owner, action, { resolve: async () => ({ appealableActionId: action, ownerAccountId: owner.accountId, source: "enf", sourceStreamId: "identity.account-x", sourceStreamVersion: 2 }) })).resolves.toMatchObject({ status: "resolved" });
    });
    expect(withAccountAppealSellerAccess({ ...actor, permissions: [] }, "account-appeals.file", () => undefined)).toBeNull();
  });

  it("returns one byte-identical indeterminate value for absent, foreign and conflicted rows", async () => {
    await withAccountAppealSellerAccess(actor, "account-appeals.file", async (owner) => {
      const action = createId("enf");
      const absent = await resolveAppealableEnforcementAction(owner, action, { resolve: async () => null });
      const foreign = await resolveAppealableEnforcementAction(owner, action, { resolve: async () => ({ appealableActionId: action, ownerAccountId: createId("acc"), source: "enf", sourceStreamId: "s", sourceStreamVersion: 1 }) });
      expect(absent).toBe(APPEALABLE_ACTION_INDETERMINATE);
      expect(foreign).toBe(APPEALABLE_ACTION_INDETERMINATE);
    });
  });
});
