import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { contextManifest, module as fulfillmentModule } from "../../../index";
import type { SellerCheckoutReadinessKey } from "../domain/contract";
import { SellerShippingError } from "../domain/shipping-setup";
import { decodeSellerShippingRow } from "../api/runtime";
import {
  actor,
  accountOwner,
  anonymousOwner,
  context,
  createShippingTestHarness,
  initialize,
  setup,
} from "../api/test-support";

describe("production-bound seller checkout source", () => {
  it.each([accountOwner, anonymousOwner])(
    "reads current committed facts for $kind and both preferences without PII or read-time stamps",
    async (owner) => {
      const h = createShippingTestHarness();
      for (const labelPreference of ["prepaid-label", "seller-label-later"] as const) {
        const choices = { ...setup, labelPreference };
        const saved = await h.services.saveSetup(owner, choices, context);
        if (labelPreference === "prepaid-label")
          await h.services.changeSupport(actor, { ...initialize, owner }, context);
        const key = { owner, shipFromLocationId: saved.setup!.shipFromLocationId, labelPreference };
        const ready = await h.services.readReadiness(key);
        expect(ready).toMatchObject({
          schemaVersion: "fulfillment.seller-checkout-readiness.v1",
          label: { status: "ready", reason: "ready" },
          provider: { status: "ready", reason: "ready" },
          sourceRevision: labelPreference === "prepaid-label" ? 2 : 3,
        });
        expect(await h.makeServices().readReadiness(key)).toEqual(ready);
        expect(Object.keys(ready).sort()).toEqual(
          ["schemaVersion", "label", "provider", "sourceRevision", "sourceTimestamp"].sort(),
        );
        const serialized = JSON.stringify(ready);
        for (const privateValue of [setup.origin.line1, actor.userId, actor.membershipId])
          expect(serialized).not.toContain(privateValue);
      }
    },
  );

  it("setup-only, support-only, foreign and omitted sources never become ready", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    const key = {
      owner: accountOwner,
      shipFromLocationId: saved.setup!.shipFromLocationId,
      labelPreference: setup.labelPreference,
    };
    expect((await h.services.readReadiness(key)).label).toMatchObject({ status: "blocked", fact: "missing" });
    await h.services.changeSupport(actor, { ...initialize, owner: anonymousOwner }, context);
    for (const owner of [anonymousOwner, { kind: "account", accountId: "acc_foreign" } as const])
      expect((await h.services.readReadiness({ ...key, owner })).sourceRevision).toBeNull();
  });

  it("isolates missing support from a valid current setup and does not acquire defaults on day-after reads", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    const key = {
      owner: accountOwner,
      shipFromLocationId: saved.setup!.shipFromLocationId,
      labelPreference: setup.labelPreference,
    };
    expect((await h.services.readReadiness(key)).label).toMatchObject({ status: "blocked", fact: "missing" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      expect(await h.makeServices().readSetup(accountOwner)).toEqual(saved);
      expect((await h.services.readReadiness(key)).label).toMatchObject({ status: "blocked", fact: "missing" });
    } finally {
      vi.useRealTimers();
    }
    expect(h.events).toHaveLength(1);
    await h.services.changeSupport(actor, initialize, context);
    expect((await h.services.readReadiness(key)).label.status).toBe("ready");
  });

  it("requires the real declared production host port and mounts the admin operation fail-closed", async () => {
    expect(contextManifest.hostPorts.some((port) => port.portName === "operatorAuthority")).toBe(true);
    for (const operatorAuthority of [
      undefined,
      async () => ({ kind: "denied" as const, reason: "inactive" as const }),
    ]) {
      const h = createShippingTestHarness();
      const runtime = fulfillmentModule.createServices(h.pool, { operatorAuthority });
      const app = new Hono<AuthenticatedApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", actor);
        c.set("context", context);
        await next();
      });
      const router = fulfillmentModule.buildApis(runtime)[0]!.router;
      if (!(router instanceof Hono)) throw new Error("The Fulfillment API must register a Hono router.");
      app.route("/api/marketplace", router);
      const response = await app.request("/api/marketplace/operations/seller-shipping-support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initialize),
      });
      expect(response.status).toBe(operatorAuthority ? 403 : 503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(h.query).not.toHaveBeenCalled();
      expect(h.events).toHaveLength(0);
    }
  });

  it("limits no-store to seller-shipping responses on the shared marketplace API base", async () => {
    const h = createShippingTestHarness();
    const runtime = fulfillmentModule.createServices(h.pool);
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", context);
      await next();
    });
    const router = fulfillmentModule.buildApis(runtime)[0]!.router;
    if (!(router instanceof Hono)) throw new Error("The Fulfillment API must register a Hono router.");
    app.route("/api/marketplace", router);
    const ordering = new Hono();
    ordering.get("/account/purchases", (c) => c.json({ purchases: [] }));
    app.route("/api/marketplace", ordering);

    const purchases = await app.request("/api/marketplace/account/purchases");
    expect(purchases.status).toBe(200);
    expect(purchases.headers.get("Cache-Control")).toBeNull();
    const setupResponse = await app.request("/api/marketplace/account/seller-shipping-setup");
    expect(setupResponse.status).toBe(200);
    expect(setupResponse.headers.get("Cache-Control")).toBe("no-store");
    const refused = await app.request("/api/marketplace/guest/seller-shipping-setup");
    expect(refused.status).toBe(400);
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    const missing = await app.request("/api/marketplace/unknown");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBeNull();
  });

  it.each([
    [new SellerShippingError("invalid-input"), 400],
    [new SellerShippingError("forbidden"), 403],
    [new SellerShippingError("conflicting-operation"), 409],
    [new SellerShippingError("source-unavailable"), 503],
    [new Error("source offline"), 503],
  ])("keeps no-store when a seller-shipping read fails with %s", async (error, status) => {
    const h = createShippingTestHarness();
    vi.spyOn(h.services, "readSetup").mockRejectedValueOnce(error);
    const response = await h.app.request("/api/marketplace/account/seller-shipping-setup");
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("suppresses stamps for failed, duplicate, lagging and malformed authoritative head reads", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const key = {
      owner: accountOwner,
      shipFromLocationId: saved.setup!.shipFromLocationId,
      labelPreference: setup.labelPreference,
    };
    const ready = await h.services.readReadiness(key);
    expect(ready.label.status).toBe("ready");
    const head = h.events[1]!;
    const row = {
      current_version: "2",
      stream_version: "2",
      recorded_at: new Date(head.recordedAt),
      event_type: head.eventType,
      payload: head.payload,
    };
    h.query.mockRejectedValueOnce(new Error("source offline"));
    expect(await h.services.readReadiness(key)).toMatchObject({
      label: { status: "blocked", fact: "unavailable" },
      sourceRevision: null,
      sourceTimestamp: null,
    });
    for (const rows of [
      [row, row],
      [{ ...row, current_version: "3" }],
      [{ ...row, payload: { ...head.payload, audit: null } }],
    ]) {
      h.query.mockResolvedValueOnce({ rows });
      expect(await h.services.readReadiness(key)).toMatchObject({
        label: { status: "blocked", fact: "unavailable" },
        sourceRevision: null,
        sourceTimestamp: null,
      });
    }
    expect(await h.services.readReadiness(key)).toEqual(ready);
  });

  it("rejects missing, contradictory and unknown nested operation/audit fields at a ready source", async () => {
    const h = createShippingTestHarness();
    await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const event = h.events[1]!;
    const row = {
      current_version: "2",
      stream_version: "2",
      recorded_at: new Date(event.recordedAt),
      event_type: event.eventType,
      payload: event.payload,
    };
    expect(decodeSellerShippingRow(row, accountOwner).state.support?.[setup.labelPreference]).toBe("enabled");
    const operation = event.payload.operation as Record<string, unknown>;
    const audit = event.payload.audit as Record<string, unknown>;
    for (const payload of [
      { ...event.payload, operation: null },
      { ...event.payload, audit: null },
      { ...event.payload, audit: { ...audit, revision: 1 } },
      { ...event.payload, audit: { ...audit, owner: anonymousOwner } },
      { ...event.payload, audit: { ...audit, after: { ...(audit.after as object), "prepaid-label": "revoked" } } },
      { ...event.payload, audit: { ...audit, unexpected: true } },
      { ...event.payload, operation: { ...operation, action: "revoke" } },
      { ...event.payload, operation: { ...operation, owner: anonymousOwner } },
      { ...event.payload, operation: { ...operation, unexpected: true } },
    ])
      expect(() => decodeSellerShippingRow({ ...row, payload }, accountOwner)).toThrow("source-unavailable");
  });

  it("revoke/origin/preference edits immediately invalidate previously ready evaluations", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const key = {
      owner: accountOwner,
      shipFromLocationId: saved.setup!.shipFromLocationId,
      labelPreference: setup.labelPreference,
    };
    const before = await h.services.readReadiness(key);
    expect(before.label.status).toBe("ready");
    await h.services.changeSupport(
      actor,
      { ...initialize, action: "revoke", labelPreference: setup.labelPreference, operationId: "revoke" },
      context,
    );
    const revoked = await h.services.readReadiness(key);
    expect(revoked.label).toMatchObject({ status: "blocked", fact: "unavailable" });
    expect(revoked.sourceRevision).toBe(3);
    await h.services.saveSetup(accountOwner, { ...setup, labelPreference: "seller-label-later" }, context);
    expect((await h.services.readReadiness(key)).label.status).toBe("blocked");
    await h.services.saveSetup(accountOwner, { ...setup, origin: { ...setup.origin, line1: "2 Main St" } }, context);
    expect((await h.services.readReadiness(key)).sourceRevision).toBeNull();
  });

  it.each([accountOwner, anonymousOwner])(
    "keeps $kind enabled/revoked/re-enabled facts steady for both preferences the next day",
    async (owner) => {
      const h = createShippingTestHarness();
      await h.services.changeSupport(actor, { ...initialize, owner }, context);
      for (const labelPreference of ["prepaid-label", "seller-label-later"] as const) {
        const saved = await h.services.saveSetup(owner, { ...setup, labelPreference }, context);
        const key = { owner, shipFromLocationId: saved.setup!.shipFromLocationId, labelPreference };
        const enabled = await h.services.readReadiness(key);
        expect(enabled.label.status).toBe("ready");
        await h.services.changeSupport(
          actor,
          { ...initialize, owner, action: "revoke", labelPreference, operationId: `revoke_${labelPreference}` },
          context,
        );
        const revoked = await h.services.readReadiness(key);
        expect(revoked.label).toMatchObject({ status: "blocked", fact: "unavailable" });
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(Date.now() + 86_400_000);
          expect(await h.makeServices().readReadiness(key)).toEqual(revoked);
          await h.services.saveSetup(owner, { ...setup, labelPreference }, context);
          expect(await h.services.readReadiness(key)).toEqual(revoked);
        } finally {
          vi.useRealTimers();
        }
        await h.services.changeSupport(
          actor,
          { ...initialize, owner, action: "enable", labelPreference, operationId: `enable_${labelPreference}` },
          context,
        );
        const reenabled = await h.services.readReadiness(key);
        expect(reenabled.label.status).toBe("ready");
        expect(await h.makeServices().readReadiness(key)).toEqual(reenabled);
        expect(reenabled.sourceRevision).toBe(revoked.sourceRevision! + 1);
      }
    },
  );

  it("closes malformed/foreign nested keys and suppresses every unusable stamp", async () => {
    const h = createShippingTestHarness();
    const saved = await h.services.saveSetup(accountOwner, setup, context);
    await h.services.changeSupport(actor, initialize, context);
    const key = {
      owner: accountOwner,
      shipFromLocationId: saved.setup!.shipFromLocationId,
      labelPreference: setup.labelPreference,
    };
    for (const bad of [
      null,
      {},
      { ...key, status: "ready" },
      { ...key, owner: { ...accountOwner, anonymousSellListId: "anon_forged" } },
      { ...key, labelPreference: "unknown" },
      { ...key, shipFromLocationId: "address_1" },
    ]) {
      const result = await h.services.readReadiness(bad as SellerCheckoutReadinessKey);
      expect(result).toMatchObject({
        label: { status: "blocked" },
        provider: { status: "blocked" },
        sourceRevision: null,
        sourceTimestamp: null,
      });
    }
  });

  it("decodes genuine bigint/timestamptz driver shapes and rejects overflow, head lag, unknown/partial state and bad calendar instants", async () => {
    const h = createShippingTestHarness();
    await h.services.saveSetup(accountOwner, setup, context);
    const event = h.events[0]!;
    const row = {
      current_version: "1",
      stream_version: "1",
      recorded_at: new Date(event.recordedAt),
      event_type: event.eventType,
      payload: event.payload,
    };
    expect(decodeSellerShippingRow(row, accountOwner).recordedAt).toBe(event.recordedAt);
    const state = event.payload.state as Record<string, unknown>;
    for (const bad of [
      { ...row, current_version: "9007199254740992" },
      { ...row, current_version: "2" },
      { ...row, recorded_at: "2026-02-30T12:00:00.000Z" },
      { ...row, payload: {} },
      { ...row, payload: { ...event.payload, state: { ...state, revision: -1 } } },
      { ...row, payload: { ...event.payload, state: { ...state, unexpected: true } } },
      { ...row, payload: { ...event.payload, state: { ...state, support: { "prepaid-label": "enabled" } } } },
    ])
      expect(() => decodeSellerShippingRow(bad, accountOwner)).toThrow("source-unavailable");
    expect(() => decodeSellerShippingRow(row, anonymousOwner)).toThrow("source-unavailable");
  });
});
