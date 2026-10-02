import { expect, it } from "vitest";
import { createApiHost } from "@chase-sets/platform-runtime/api";
import { buildPlatformApiApp } from "../../../../../../deployables/platform-api/src/app";
import { module as catalogModule, contextManifest } from "../../../../index";
import { createTcgplayerAutomationRuntime } from "../../api/runtime";
import { createOperatorTransport } from "../../domain/extension/transport";
import { isGrant } from "../../domain/extension/protocol";
import { describeDb, keyring, observedAt, useOperatorSessionDatabase } from "../db-fixture";

describeDb("operator-extension-route-contract: real mounted grants and retained custody", () => {
  const db = useOperatorSessionDatabase("operator_extension_route");
  it("stored 1 -> Disconnect cleared 2 -> NEW grant stale 2 -> fresh cookie stored 3; unpair preserves custody", async () => {
    const runtime = createApiHost(
      [
        {
          contextName: "catalog",
          packageName: "@chase-sets/catalog",
          manifest: contextManifest,
          module: catalogModule,
        },
      ],
      "platform-api",
      {
        pools: { catalog: db() },
        hostPorts: { catalogOperatorSessionConfiguration: { config: null, keyring } },
      },
    );
    const app = buildPlatformApiApp(runtime, {
      resolveActor: async () => ({
        sessionId: "synthetic-session",
        tenantId: "synthetic-platform",
        accountId: "synthetic-account",
        userId: "84530000-0000-4000-8000-000000000001",
        membershipId: "84530000-0000-4000-8000-000000000002",
        roleKey: "platform-admin",
        permissions: ["catalog.view", "catalog.manage"],
        authenticatedAt: new Date().toISOString(),
      }),
    });
    const origin = "https://admin.staging.chasesets.com";
    async function admin(path: string, method: string) {
      const response = await app.request(origin + "/api/catalog/operator-session" + path, {
        method,
        headers: { Origin: origin },
      });
      expect(response.status).toBe(200);
      return response.json();
    }
    async function mint() {
      const body: unknown = await admin("/grant", "POST");
      if (typeof body !== "object" || body === null || !("grant" in body) || !isGrant(body.grant))
        throw new Error("Invalid synthetic grant response");
      return body.grant;
    }
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
    const first = await mint();
    const payload = {
      expectedRevision: 0,
      value: "synthetic-operator-session-before-clear",
      observedAt,
      browserExpiresAt: null,
    };
    expect(await client.push("staging", first, payload)).toEqual({ outcome: "stored", revision: 1 });
    expect(await admin("", "DELETE")).toEqual({ outcome: "cleared", revision: 2 });
    expect(await admin("", "GET")).toMatchObject({ revision: 2, storedAt: null, browserExpiresAt: null });
    expect(await admin("", "DELETE")).toEqual({ outcome: "unchanged", revision: 2 });
    expect(await client.push("staging", first, payload)).toEqual({ outcome: "grant-invalid" });
    const next = await mint();
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
