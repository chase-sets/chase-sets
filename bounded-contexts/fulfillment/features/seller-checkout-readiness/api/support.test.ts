import { describe, expect, it, vi } from "vitest";
import type { OperatorAuthority } from "@chase-sets/auth-context";
import {
  actor,
  accountOwner,
  context,
  createShippingTestHarness,
  grantedAuthority,
  initialize,
  jsonRequest,
  setup,
} from "./test-support";

describe("audited platform shipping support", () => {
  it("initializes both launch preferences explicitly, atomically auditing authority and before/after", async () => {
    const h = createShippingTestHarness();
    const response = await jsonRequest(h.app, "/operations/seller-shipping-support", initialize, "POST");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      revision: 1,
      support: {
        launchPolicyId: "fulfillment.seller-shipping-support.launch.v1",
        "prepaid-label": "enabled",
        "seller-label-later": "enabled",
      },
    });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.payload.audit).toMatchObject({
      userId: actor.userId,
      membershipId: actor.membershipId,
      owner: accountOwner,
      before: null,
      after: result.support,
      reason: initialize.reason,
      operationId: initialize.operationId,
      revision: 1,
    });
    expect(h.events[0]!.recordedAt).toBe(result.recordedAt);
    expect(await h.services.readSetup(accountOwner)).toMatchObject({ setup: null, supportStatus: "missing" });
  });

  it("retries once, refuses conflicting payload/target, and never initializes over revoked support", async () => {
    const h = createShippingTestHarness();
    const initial = await h.services.changeSupport(actor, initialize, context);
    expect(await h.services.changeSupport(actor, initialize, context)).toEqual(initial);
    await expect(
      h.services.changeSupport(actor, { ...initialize, reason: "Different reason" }, context),
    ).rejects.toThrow("conflicting-operation");
    await expect(
      h.services.changeSupport(actor, { ...initialize, owner: { kind: "account", accountId: "acc_other" } }, context),
    ).rejects.toThrow("conflicting-operation");
    await h.services.saveSetup(accountOwner, setup, context);
    const revoke = { ...initialize, action: "revoke", labelPreference: "prepaid-label", operationId: "revoke" };
    const revoked = await h.services.changeSupport(actor, revoke, context);
    expect(await h.services.changeSupport(actor, initialize, context)).toEqual(initial);
    expect(await h.makeServices().readSetup(accountOwner)).toMatchObject({
      supportStatus: "revoked",
      revision: revoked.revision,
    });
    await expect(
      h.services.changeSupport(actor, { ...initialize, operationId: "second_boot" }, context),
    ).rejects.toThrow("conflicting-operation");
    expect(await h.services.changeSupport(actor, revoke, context)).toEqual(revoked);
    await h.services.changeSupport(actor, { ...revoke, action: "enable", operationId: "reenable" }, context);
    expect(await h.services.readSetup(accountOwner)).toMatchObject({ supportStatus: "enabled", revision: 4 });
    expect(h.events).toHaveLength(4);
  });

  it.each(["missing", "throwing", "seller", "inactive", "stale-membership"])(
    "refuses %s authority with all setup/command inputs fixed and writes nothing",
    async (kind) => {
      const authority: OperatorAuthority =
        kind === "throwing"
          ? async () => {
              throw new Error("offline");
            }
          : kind === "stale-membership"
            ? async () => ({
                kind: "granted",
                membershipId: "mem_stale",
                roleKey: "platform-admin",
                rolePermissions: [],
              })
            : async () => ({ kind: "denied", reason: kind === "inactive" ? "inactive" : "not-platform-admin" });
      const h = createShippingTestHarness(kind === "missing" ? undefined : authority);
      // Default factory authority is explicitly replaced for the missing-port control.
      const services =
        kind === "missing"
          ? (await import("./runtime")).createSellerShippingSetupServices({ pool: h.pool })
          : h.services;
      await expect(services.changeSupport(actor, initialize, context)).rejects.toThrow(
        kind === "missing" || kind === "throwing" ? "authority-unavailable" : "forbidden",
      );
      expect(h.events).toHaveLength(0);
    },
  );

  it("posted roles and seller permissions never substitute for authority; guest writes nothing", async () => {
    const authority = vi.fn<OperatorAuthority>(async () => ({ kind: "denied", reason: "not-platform-admin" }));
    const h = createShippingTestHarness(authority);
    h.setActor({ ...actor, roleKey: "seller", permissions: ["fulfillment.manage"] });
    expect(
      (
        await jsonRequest(
          h.app,
          "/operations/seller-shipping-support",
          { ...initialize, roleKey: "platform-admin" },
          "POST",
        )
      ).status,
    ).toBe(403);
    h.setActor(null);
    expect((await jsonRequest(h.app, "/operations/seller-shipping-support", initialize, "POST")).status).toBe(403);
    expect(authority).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(0);
  });

  it("rechecks authority even on an identical retry and requires initialization before enable", async () => {
    let allowed = true;
    const authority: OperatorAuthority = async (requester) =>
      allowed ? grantedAuthority(requester) : { kind: "denied", reason: "inactive" };
    const h = createShippingTestHarness(authority);
    await expect(
      h.services.changeSupport(actor, { ...initialize, action: "enable", labelPreference: "prepaid-label" }, context),
    ).rejects.toThrow("support-not-initialized");
    await h.services.changeSupport(actor, initialize, context);
    allowed = false;
    await expect(h.services.changeSupport(actor, initialize, context)).rejects.toThrow("forbidden");
    expect(h.events).toHaveLength(1);
  });

  it("refuses an otherwise authorized operation whose event audit context names another actor", async () => {
    const h = createShippingTestHarness();
    await expect(
      h.services.changeSupport(actor, initialize, {
        ...context,
        audit: { ...context.audit, performedByUserId: "usr_other" },
      }),
    ).rejects.toThrow("forbidden");
    expect(h.events).toHaveLength(0);
    expect((await h.services.changeSupport(actor, initialize, context)).revision).toBe(1);
  });

  it("isolates denied authority with valid setup, membership, actor context and command held fixed", async () => {
    let allowed = false;
    const authority: OperatorAuthority = async (requester) =>
      allowed ? grantedAuthority(requester) : { kind: "denied", reason: "inactive" };
    const h = createShippingTestHarness(authority);
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    await expect(h.services.changeSupport(actor, initialize, context)).rejects.toThrow("forbidden");
    expect(h.events).toHaveLength(1);
    expect(await h.services.readSetup(accountOwner)).toEqual(saved);
    allowed = true;
    await h.services.changeSupport(actor, initialize, context);
    expect(await h.services.readSetup(accountOwner)).toMatchObject({
      setup: saved.setup,
      supportStatus: "enabled",
      revision: 2,
    });
  });
});
