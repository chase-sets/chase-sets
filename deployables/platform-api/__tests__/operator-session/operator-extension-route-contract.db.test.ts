import { expect, it } from "vitest";
import { contextManifest as catalogManifest } from "@chase-sets/catalog";
import { createOperatorTransport, createTcgplayerAutomationRuntime } from "@chase-sets/catalog/server";
import { admin, adminPath, keyring, mint, mounted, session } from "./fixture";
import { database, describeDb } from "./db-fixture";

describeDb("operator-extension-route-contract: real mounted grants and retained custody", () => {
  const db = database("operator_extension_route");
  it("stored 1 -> Disconnect cleared 2 -> NEW grant stale 2 -> fresh cookie stored 3; unpair preserves custody", async () => {
    const app = mounted(catalogManifest, db());
    const calls: { method: string; credentials: RequestCredentials; redirect: RequestRedirect; path: string }[] = [];
    const client = createOperatorTransport(async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        method: request.method,
        credentials: request.credentials,
        redirect: request.redirect,
        path: new URL(request.url).pathname,
      });
      return app.fetch(request);
    });
    const first = await mint(app);
    const payload = {
      expectedRevision: 0,
      value: "synthetic-operator-session-before-clear",
      observedAt: session().observedAt,
      browserExpiresAt: null,
    };
    expect(await client.push("staging", first, payload)).toEqual({ outcome: "stored", revision: 1 });
    expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({ outcome: "cleared", revision: 2 });
    expect(await (await admin(app, "GET", adminPath)).json()).toMatchObject({
      revision: 2,
      storedAt: null,
      browserExpiresAt: null,
    });
    expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({ outcome: "unchanged", revision: 2 });
    expect(await client.push("staging", first, payload)).toEqual({ outcome: "grant-invalid" });
    const next = await mint(app);
    expect(await client.push("staging", next, payload)).toEqual({ outcome: "stale-revision", revision: 2 });
    const fresh = { ...payload, expectedRevision: 2, value: "synthetic-operator-session-fresh-after-stale" };
    expect(await client.push("staging", next, fresh)).toEqual({ outcome: "stored", revision: 3 });
    expect(await client.push("staging", next, { ...fresh, expectedRevision: 3 })).toEqual({
      outcome: "unchanged",
      revision: 3,
    });
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(await client.push("staging", next, { ...fresh, expectedRevision: 3 })).toEqual({
        outcome: "unchanged",
        revision: 3,
      });
    }
    expect(await client.push("staging", next, { ...fresh, expectedRevision: 3 })).toEqual({
      outcome: "rate-limited",
      retryAfterMs: 60_000,
    });
    expect(await client.revoke("staging", next)).toEqual({ outcome: "revoked" });
    expect(await client.push("staging", next, { ...fresh, expectedRevision: 3 })).toEqual({ outcome: "grant-invalid" });
    const authority = createTcgplayerAutomationRuntime({ pool: db(), config: null, keyring });
    expect(await authority?.store.resolve()).toEqual({ value: fresh.value, revision: 3 });
    expect(calls.every((call) => call.credentials === "omit" && call.redirect === "error")).toBe(true);
    expect(
      calls.every(
        (call) => call.path === `/api/public/catalog/operator-session/${call.method === "PUT" ? "tcgplayer" : "grant"}`,
      ),
    ).toBe(true);
  });
});
