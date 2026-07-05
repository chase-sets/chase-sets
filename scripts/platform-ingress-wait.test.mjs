import { describe, expect, it } from "vitest";
import { probeIngressUrl, waitForIngressUrls } from "./platform-ingress-wait.mjs";

describe("platform ingress wait", () => {
  it("accepts successful HTTPS responses", async () => {
    const result = await probeIngressUrl("https://marketplace.staging.chasesets.com/health/ready", {
      fetchImpl: async (url, init) => ({
        status: url.includes("marketplace") && init.method === "GET" && init.redirect === "manual" ? 200 : 500,
      }),
    });

    expect(result).toEqual({
      url: "https://marketplace.staging.chasesets.com/health/ready",
      status: 200,
      ok: true,
    });
  });

  it("retries until every ingress URL is ready", async () => {
    let calls = 0;
    const sleeps = [];
    const result = await waitForIngressUrls({
      urls: ["https://admin.staging.chasesets.com/health/ready", "https://staging.chasesets.com/"],
      attempts: 3,
      delayMs: 10,
      sleepImpl: async (delayMs) => sleeps.push(delayMs),
      fetchImpl: async () => {
        calls += 1;
        return { status: calls <= 2 ? 503 : 200 };
      },
    });

    expect(result.attempts).toBe(2);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(sleeps).toEqual([10]);
  });

  it("requires HTTPS readiness URLs", async () => {
    await expect(
      waitForIngressUrls({
        urls: ["http://admin.staging.chasesets.com/health/ready"],
        fetchImpl: async () => ({ status: 200 }),
      }),
    ).rejects.toThrow("https");
  });

  it("reports the final failed statuses", async () => {
    await expect(
      waitForIngressUrls({
        urls: ["https://admin.staging.chasesets.com/health/ready"],
        attempts: 2,
        delayMs: 1,
        sleepImpl: async () => {},
        fetchImpl: async () => ({ status: 503 }),
      }),
    ).rejects.toThrow("503");
  });
});
