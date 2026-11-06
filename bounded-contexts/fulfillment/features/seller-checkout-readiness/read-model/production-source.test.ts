import { describe, expect, it } from "vitest";
import type { SellerCheckoutReadinessKey } from "../domain/contract";
import { decodeSellerShippingRow } from "../api/runtime";
import { actor, accountOwner, anonymousOwner, context, createShippingTestHarness, initialize, setup } from "../api/test-support";

describe("production-bound seller checkout source", () => {
  it.each([accountOwner, anonymousOwner])("reads current committed facts for $kind and both preferences without PII or read-time stamps", async (owner) => {
    const h = createShippingTestHarness();
    for (const labelPreference of ["prepaid-label", "seller-label-later"] as const) {
      const choices = { ...setup, labelPreference };
      const saved = await h.services.saveSetup(owner, choices, context);
      if (labelPreference === "prepaid-label") await h.services.changeSupport(actor, { ...initialize, owner }, context);
      const key = { owner, shipFromLocationId: saved.setup!.shipFromLocationId, labelPreference };
      const ready = await h.services.readReadiness(key);
      expect(ready).toMatchObject({ schemaVersion: "fulfillment.seller-checkout-readiness.v1", label: { status: "ready", reason: "ready" }, provider: { status: "ready", reason: "ready" }, sourceRevision: labelPreference === "prepaid-label" ? 2 : 3 });
      expect(await h.makeServices().readReadiness(key)).toEqual(ready);
      expect(Object.keys(ready).sort()).toEqual(["schemaVersion", "label", "provider", "sourceRevision", "sourceTimestamp"].sort());
      const serialized = JSON.stringify(ready);
      for (const privateValue of [setup.origin.line1, actor.userId, actor.membershipId]) expect(serialized).not.toContain(privateValue);
    }
  });

  it("setup-only, support-only, foreign and omitted sources never become ready", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    const key = { owner: accountOwner, shipFromLocationId: saved.setup!.shipFromLocationId, labelPreference: setup.labelPreference };
    expect((await h.services.readReadiness(key)).label).toMatchObject({ status: "blocked", fact: "missing" });
    await h.services.changeSupport(actor, { ...initialize, owner: anonymousOwner }, context);
    for (const owner of [anonymousOwner, { kind: "account", accountId: "acc_foreign" } as const]) expect((await h.services.readReadiness({ ...key, owner })).sourceRevision).toBeNull();
  });

  it("revoke/origin/preference edits immediately invalidate previously ready evaluations", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const key = { owner: accountOwner, shipFromLocationId: saved.setup!.shipFromLocationId, labelPreference: setup.labelPreference };
    const before = await h.services.readReadiness(key);
    expect(before.label.status).toBe("ready");
    await h.services.changeSupport(actor, { ...initialize, action: "revoke", labelPreference: setup.labelPreference, operationId: "revoke" }, context);
    const revoked = await h.services.readReadiness(key);
    expect(revoked.label).toMatchObject({ status: "blocked", fact: "unavailable" });
    expect(revoked.sourceRevision).toBe(3);
    await h.services.saveSetup(accountOwner, { ...setup, labelPreference: "seller-label-later" }, context);
    expect((await h.services.readReadiness(key)).label.status).toBe("blocked");
    await h.services.saveSetup(accountOwner, { ...setup, origin: { ...setup.origin, line1: "2 Main St" } }, context);
    expect((await h.services.readReadiness(key)).sourceRevision).toBeNull();
  });

  it("closes malformed/foreign nested keys and suppresses every unusable stamp", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const key = { owner: accountOwner, shipFromLocationId: saved.setup!.shipFromLocationId, labelPreference: setup.labelPreference };
    for (const bad of [null, {}, { ...key, status: "ready" }, { ...key, owner: { ...accountOwner, anonymousSellListId: "anon_forged" } }, { ...key, labelPreference: "unknown" }, { ...key, shipFromLocationId: "address_1" }]) {
      const result = await h.services.readReadiness(bad as SellerCheckoutReadinessKey);
      expect(result).toMatchObject({ label: { status: "blocked" }, provider: { status: "blocked" }, sourceRevision: null, sourceTimestamp: null });
    }
  });

  it("decodes genuine bigint/timestamptz driver shapes and rejects overflow, head lag, unknown/partial state and bad calendar instants", async () => {
    const h = createShippingTestHarness();
    await h.services.saveSetup(accountOwner, setup, context);
    const event = h.events[0]!;
    const row = { current_version: "1", stream_version: "1", recorded_at: new Date(event.recordedAt), event_type: event.eventType, payload: event.payload };
    expect(decodeSellerShippingRow(row, accountOwner).recordedAt).toBe(event.recordedAt);
    const state = event.payload.state as Record<string, unknown>;
    for (const bad of [{ ...row, current_version: "9007199254740992" }, { ...row, current_version: "2" }, { ...row, recorded_at: "2026-02-30T12:00:00.000Z" }, { ...row, payload: {} }, { ...row, payload: { ...event.payload, state: { ...state, revision: -1 } } }, { ...row, payload: { ...event.payload, state: { ...state, unexpected: true } } }, { ...row, payload: { ...event.payload, state: { ...state, support: { "prepaid-label": "enabled" } } } }]) expect(() => decodeSellerShippingRow(bad, accountOwner)).toThrow("source-unavailable");
    expect(() => decodeSellerShippingRow(row, anonymousOwner)).toThrow("source-unavailable");
  });
});
