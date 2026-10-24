import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createEbayAccountDeletionRoutes } from "../api/route";
import oracle from "./sdk-oracle.json";

const fixture = oracle.cases[0]!;
const path = "/ebay/account-deletion";
describe("ebay-account-deletion-challenge", () => {
  it.each(oracle.cases)("matches pinned eBay SDK for $challengeCode at $endpoint", async (config) => {
    const response = await createEbayAccountDeletionRoutes({ config }).request(
      `${path}?challenge_code=${encodeURIComponent(config.challengeCode)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ challengeResponse: config.challengeResponse });
  });
  it("distinguishes order, token and exact endpoint mutants", () => {
    expect(new Set(oracle.cases.map((entry) => entry.challengeResponse)).size).toBe(4);
    for (const input of [
      fixture.verificationToken + fixture.challengeCode + fixture.endpoint,
      fixture.challengeCode + fixture.endpoint + fixture.verificationToken,
      fixture.challengeCode + fixture.verificationToken + new URL(fixture.endpoint).href,
    ])
      expect(createHash("sha256").update(input).digest("hex")).not.toBe(fixture.challengeResponse);
  });
  it.each(["", "?challenge_code=", "?challenge_code=a&challenge_code=b", "?challenge_code=a&challenge_code="])(
    "rejects missing, empty and repeated challenges: %s",
    async (query) => {
      const response = await createEbayAccountDeletionRoutes({ config: fixture }).request(path + query);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(fixture.verificationToken);
    },
  );
  it.each(["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"])("rejects %s before GET", async (method) => {
    for (const config of [fixture, null]) {
      const response = await createEbayAccountDeletionRoutes({ config }).request(`${path}?challenge_code=a`, {
        method,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST");
    }
  });
  it("records only bounded telemetry for success and each refusal", async () => {
    const record = vi.fn();
    for (const [config, query, method, status] of [
      [fixture, "?challenge_code=private-challenge", "GET", 200],
      [fixture, "", "GET", 400],
      [fixture, "", "PUT", 405],
      [null, "?challenge_code=private-challenge", "GET", 503],
    ] as const) {
      const response = await createEbayAccountDeletionRoutes({ config, telemetry: { record } }).request(path + query, {
        method,
      });
      expect(response.status).toBe(status);
      expect(record).toHaveBeenLastCalledWith({
        endpoint: "channels-ebay-account-deletion",
        statusCode: status,
        outcome: status === 200 ? "processed" : "ignored",
        failureClass: status === 400 || status === 405 ? "schema-mismatch" : null,
        retryable: false,
      });
      if (status !== 200) {
        expect(record.mock.lastCall?.[0].outcome).not.toBe("failed");
        expect(record.mock.lastCall?.[0].failureClass).not.toBe("handler-failure");
      }
      if (status === 503)
        expect(await response.json()).toEqual({ error: { code: "ebay_account_deletion_not_configured" } });
    }
    expect(record).toHaveBeenCalledTimes(4);
  });
});
