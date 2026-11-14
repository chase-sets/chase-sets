import { describe, expect, it } from "vitest";
import {
  accountOwner,
  actor,
  anonymousOwner,
  context,
  createShippingTestHarness,
  initialize,
  jsonRequest,
  setup,
} from "./test-support";

describe("seller shipping setup API authority", () => {
  it.each(["account", "guest"] as const)(
    "saves and reloads %s choices without granting missing support",
    async (mode) => {
      const h = createShippingTestHarness();
      if (mode === "guest") h.setActor(null);
      const headers: Record<string, string> =
        mode === "guest" ? { "x-checkout-anonymous-sell-list-id": anonymousOwner.anonymousSellListId } : {};
      const response = await jsonRequest(h.app, `/${mode}/seller-shipping-setup`, setup, "PUT", headers);
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved).toMatchObject({
        supportStatus: "missing",
        revision: 1,
        setup: {
          origin: setup.origin,
          labelPreference: setup.labelPreference,
          shipFromLocationId: expect.stringMatching(/^sfl_/),
        },
      });
      const reload = await h.app.request(`/api/marketplace/${mode}/seller-shipping-setup`, { headers });
      expect(await reload.json()).toEqual(saved);
      expect(h.events).toHaveLength(1);
      const owner = mode === "guest" ? anonymousOwner : ({ kind: "account", accountId: actor.accountId } as const);
      const readiness = await h.services.readReadiness({
        owner,
        shipFromLocationId: saved.setup.shipFromLocationId,
        labelPreference: setup.labelPreference,
      });
      expect(readiness.label).toMatchObject({ status: "blocked", fact: "missing" });
    },
  );

  it("rejects posted owner/support/status/stamps and unknown nested origin fields before writes", async () => {
    const h = createShippingTestHarness();
    for (const field of ["owner", "status", "support", "revision", "recordedAt", "shipFromLocationId"]) {
      const response = await jsonRequest(h.app, "/account/seller-shipping-setup", { ...setup, [field]: "forged" });
      expect(response.status, field).toBe(400);
    }
    for (const origin of [
      { ...setup.origin, line1: " " },
      { ...setup.origin, verification: { status: "verified" } },
      { ...setup.origin, country: null },
      { ...setup.origin, line2: 1 },
    ]) {
      expect((await jsonRequest(h.app, "/account/seller-shipping-setup", { ...setup, origin })).status).toBe(400);
    }
    expect(h.events).toHaveLength(0);
  });

  it("refuses missing/foreign identity, shared anonymous account and query-owner fallback", async () => {
    const h = createShippingTestHarness();
    h.setActor(null);
    expect((await jsonRequest(h.app, "/account/seller-shipping-setup", setup)).status).toBe(403);
    expect((await jsonRequest(h.app, "/guest/seller-shipping-setup", setup)).status).toBe(400);
    expect((await jsonRequest(h.app, "/guest/seller-shipping-setup?owner=anon_forged", setup)).status).toBe(400);
    for (const id of ["acc_anonymous_sell_list", "anon_", "anon_with spaces", "anon_a,anon_b"])
      expect(
        (
          await jsonRequest(h.app, "/guest/seller-shipping-setup", setup, "PUT", {
            "x-checkout-anonymous-sell-list-id": id,
          })
        ).status,
      ).toBe(400);
    h.setActor({ ...actor, accountId: "acc_anonymous_sell_list" });
    expect((await jsonRequest(h.app, "/account/seller-shipping-setup", setup)).status).toBe(400);
    expect(h.events).toHaveLength(0);
  });

  it("matches complete normalized origin/preference, never address IDs or postal-only choices", async () => {
    const h = createShippingTestHarness();
    await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const accepted = await h.services.resolveOrigin(accountOwner, {
      ...setup,
      origin: { ...setup.origin, name: " Seller ", country: "us" },
    });
    expect(accepted.status).toBe("accepted");
    for (const input of [
      { ...setup, origin: { ...setup.origin, line1: "2 Main St" } },
      { ...setup, labelPreference: "seller-label-later" },
      { origin: { postalCode: "78701" }, labelPreference: setup.labelPreference },
      { addressId: "sfl_forged", labelPreference: setup.labelPreference },
    ]) {
      expect(await h.services.resolveOrigin(accountOwner, input)).toEqual({ status: "blocked", fact: "conflicting" });
    }
    expect(await h.services.resolveOrigin(anonymousOwner, setup)).toEqual({ status: "blocked", fact: "missing" });
  });

  it("isolates complete-origin authority from same-postal inputs and current enabled support", async () => {
    const h = createShippingTestHarness();
    await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const current = await h.services.resolveOrigin(accountOwner, setup);
    if (current.status !== "accepted") throw new Error("Expected current accepted origin");
    expect((await h.services.readReadiness(current.key)).label.status).toBe("ready");
    const differentStreet = { ...setup, origin: { ...setup.origin, line1: "2 Main St" } };
    expect(await h.services.resolveOrigin(accountOwner, differentStreet)).toEqual({
      status: "blocked",
      fact: "conflicting",
    });
    expect(await h.services.resolveOrigin(accountOwner, setup)).toEqual(current);
  });

  it("does not expose one account's setup through another authenticated account or anonymous owner", async () => {
    const h = createShippingTestHarness();
    await jsonRequest(h.app, "/account/seller-shipping-setup", setup);
    h.setActor({ ...actor, accountId: "acc_other" });
    const other = await h.app.request("/api/marketplace/account/seller-shipping-setup");
    expect(await other.json()).toMatchObject({ setup: null, revision: null, supportStatus: "missing" });
    h.setActor(null);
    const guest = await h.app.request("/api/marketplace/guest/seller-shipping-setup", {
      headers: { "x-checkout-anonymous-sell-list-id": anonymousOwner.anonymousSellListId },
    });
    expect(await guest.json()).toMatchObject({ setup: null, revision: null, supportStatus: "missing" });
    expect(h.events).toHaveLength(1);
  });

  it("preserves recording time on reads/restart and unchanged saves; changed choices advance identity", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    expect(await h.makeServices().readSetup(accountOwner)).toEqual(saved);
    expect(await h.services.saveSetup(accountOwner, setup, context)).toEqual(saved);
    const changed = await h.services.saveSetup(
      accountOwner,
      { ...setup, origin: { ...setup.origin, line1: "2 Main St" } },
      context,
    );
    expect(changed.revision).toBe(2);
    expect(changed.setup!.shipFromLocationId).not.toBe(saved.setup!.shipFromLocationId);
    expect(h.events).toHaveLength(2);
  });
});
