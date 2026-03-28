import { describe, expect, it } from "vitest";
import type { IdentityServices } from "@chase-sets/identity";
import { buildIdentityApp } from "../src/app";

describe("identity api host app", () => {
  it("mounts health and the identity API under /api/identity", async () => {
    const app = buildIdentityApp({
      auth: {
        issueChallenge: () => "challenge",
      },
      db: {
        query: async () => ({ rows: [], rowCount: 0 }),
      },
    } as IdentityServices);

    const healthResponse = await app.fetch(new Request("http://identity.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://identity.test/api/accounts"));
    expect(legacyResponse.status).toBe(404);

    const protectedResponse = await app.fetch(new Request("http://identity.test/api/identity/accounts"));
    expect(protectedResponse.status).toBe(401);

    const publicResponse = await app.fetch(
      new Request("http://identity.test/api/identity/auth/passkeys/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "passkey-sign-in" }),
      }),
    );
    expect(publicResponse.status).not.toBe(401);
  });
});
