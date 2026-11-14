import { describe, expect, it } from "vitest";
import {
  actor,
  accountOwner,
  anonymousOwner,
  context,
  createShippingTestHarness,
  initialize,
  setup,
} from "./test-support";

describe("owner-wide anonymous merge fence", () => {
  it("records an empty-owner tombstone, agrees on retry/restart and refuses a conflicting target", async () => {
    const h = createShippingTestHarness();
    const input = { owner: anonymousOwner, targetAccountId: accountOwner.accountId };
    const first = await h.services.invalidateAnonymousOwner(input, context);
    expect(await h.makeServices().invalidateAnonymousOwner(input, context)).toEqual(first);
    await expect(
      h.services.invalidateAnonymousOwner({ ...input, targetAccountId: "acc_other" }, context),
    ).rejects.toThrow("conflicting-operation");
    await expect(h.makeServices().saveSetup(anonymousOwner, setup, context)).rejects.toThrow("invalidated");
    await expect(h.services.changeSupport(actor, { ...initialize, owner: anonymousOwner }, context)).rejects.toThrow(
      "invalidated",
    );
    expect(h.events).toHaveLength(1);
  });

  it("fences every old/future location and leaves independently ready account facts unchanged", async () => {
    const h = createShippingTestHarness();
    const keys = [];
    for (const owner of [accountOwner, anonymousOwner]) {
      await h.services.saveSetup(owner, setup, context);
      await h.services.changeSupport(actor, { ...initialize, owner, operationId: owner.kind }, context);
      const result = await h.services.resolveOrigin(owner, setup);
      if (result.status !== "accepted") throw new Error("Expected accepted fixture");
      keys.push(result.key);
    }
    const accountBefore = await h.services.readReadiness(keys[0]!);
    expect(accountBefore.label.status).toBe("ready");
    expect((await h.services.readReadiness(keys[1]!)).label.status).toBe("ready");
    await h.services.invalidateAnonymousOwner(
      { owner: anonymousOwner, targetAccountId: accountOwner.accountId },
      context,
    );
    expect((await h.makeServices().readReadiness(keys[1]!)).label).toMatchObject({ status: "blocked", fact: "stale" });
    expect((await h.services.readReadiness({ ...keys[1]!, shipFromLocationId: "sfl_future" })).label.status).toBe(
      "blocked",
    );
    expect(await h.services.readReadiness(keys[0]!)).toEqual(accountBefore);
    expect(await h.services.resolveOrigin(anonymousOwner, setup)).toEqual({ status: "blocked", fact: "stale" });
  });
});
