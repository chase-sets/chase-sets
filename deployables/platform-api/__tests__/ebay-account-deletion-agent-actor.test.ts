import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseReceiptLookupCredential } from "@chase-sets/auth/server";
import {
  receiptActorCredential,
  receiptActorHarness,
  receiptActorOrigin,
  receiptActorPath,
  receiptActorToken,
} from "./ebay-receipt-actor-harness";

describe("staging receipt lookup service actor AC1", () => {
  const h = receiptActorHarness();
  afterAll(h.close);
  beforeEach(() => {
    h.lookup.mockClear();
    h.count.mockClear();
    h.storage.mockClear();
    h.readCredential.mockReset().mockReturnValue(receiptActorCredential);
    h.human.mockReset().mockResolvedValue(null);
  });
  it("accepts only the parsed helper token, never the JSON, with a service permission and no human/storage resolution", async () => {
    const credential = parseReceiptLookupCredential(receiptActorCredential)!;
    const app = h.compose();
    const response = await h.request(app, { headers: { authorization: `Bearer ${credential.token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matches: [] });
    expect(h.lookup).toHaveBeenCalledExactlyOnceWith("synthetic-subject");
    expect(h.count).not.toHaveBeenCalled();
    expect(h.human).not.toHaveBeenCalled();
    expect(h.storage).not.toHaveBeenCalled();
    const jsonBearer = await h.request(app, { headers: { authorization: `Bearer ${receiptActorCredential}` } });
    expect(jsonBearer.status).toBe(401);
  });
  it("rejects a valid bearer when a chase_sets_session cookie is also present", async () => {
    const response = await h.request(h.compose(), { headers: { cookie: "chase_sets_session=synthetic" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "receipt_actor_authentication_required" });
    expect(h.human).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "",
    "{}",
    "malformed",
    JSON.stringify({ version: 1, token: receiptActorToken, expiresAt: "2000-01-01T00:00:00Z" }),
    JSON.stringify({ version: 1, token: receiptActorToken, expiresAt: "2099-01-01T00:00:00Z", extra: true }),
    JSON.stringify({ version: 2, token: receiptActorToken, expiresAt: "2099-01-01T00:00:00Z" }),
    JSON.stringify({ version: 1, token: { nested: receiptActorToken }, expiresAt: "2099-01-01T00:00:00Z" }),
    JSON.stringify({ version: 1, token: receiptActorToken, expiresAt: "2099-02-30T00:00:00Z" }),
    JSON.stringify({ version: 1, token: receiptActorToken, expiresAt: "2099-01-01" }),
  ])("disables only the actor for invalid/withheld server configuration %#", async (credential) => {
    h.readCredential.mockReturnValue(credential);
    const response = await h.request(h.compose());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "receipt_actor_authentication_required" });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.human).not.toHaveBeenCalled();
    expect(h.storage).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "Basic synthetic",
    "Bearer ucp_synthetic-unlisted-token-0123456789",
    "Bearer synthetic-invalid-token-0123456789",
    `Bearer ${"a".repeat(257)}`,
  ])("never uses cookie, user, UCP or support fallback for bearer attempt %#", async (authorization) => {
    h.human.mockResolvedValue({
      sessionId: "session",
      tenantId: "tenant",
      userId: "user",
      accountId: "account",
      membershipId: "member",
      roleKey: "staff",
      permissions: ["support.manage"],
    });
    const response = await h.request(h.compose(), {
      headers: {
        authorization,
        cookie: "chase_sets_session=synthetic",
        "x-user-id": "user",
        "x-account-id": "account",
        "x-permissions": "support.manage",
      },
    });
    expect(response.status).toBe(401);
    expect(h.human).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.storage).not.toHaveBeenCalled();
  });
  it("refuses a genuinely missing bearer and ignores all X-* identity suggestions", async () => {
    const app = h.compose();
    const response = await app.request(`${receiptActorOrigin}${receiptActorPath}`, {
      method: "POST",
      headers: { "x-account-id": "synthetic", "x-permissions": "channels.receipt.lookup" },
      body: JSON.stringify({ userId: "synthetic-subject" }),
    });
    expect(response.status).toBe(401);
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.human).not.toHaveBeenCalled();
  });
  it("expiry is the sole varied governing input", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const app = h.compose({
      receiptLookupActor: { deploymentEnvironment: "staging", readCredential: h.readCredential, now: () => now },
    });
    for (const [expiresAt, status] of [
      ["2030-01-01T00:00:00.001Z", 200],
      ["2030-01-01T00:00:00Z", 401],
      ["2029-12-31T23:59:59Z", 401],
    ] as const) {
      h.readCredential.mockReturnValue(JSON.stringify({ version: 1, token: receiptActorToken, expiresAt }));
      expect((await h.request(app)).status).toBe(status);
    }
  });
});
