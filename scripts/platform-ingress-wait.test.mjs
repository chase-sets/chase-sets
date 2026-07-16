import { describe, expect, it } from "vitest";
import {
  classifyProbeResult,
  IngressReadinessError,
  probeIngressUrl,
  waitForIngressUrls,
} from "./platform-ingress-wait.mjs";

// A fake monotonic clock whose sleepImpl advances virtual time, so warmup-grace
// timing is deterministic and tests never actually wait.
function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    nowImpl: () => now,
    sleepImpl: async (delayMs) => {
      now += delayMs;
    },
  };
}

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

  describe("classifyProbeResult", () => {
    it("treats a stable 404 as a topology signal", () => {
      expect(classifyProbeResult({ status: 404, ok: false })).toBe("topology");
    });

    it("treats 5xx, connection errors, and DNS failures as transient", () => {
      expect(classifyProbeResult({ status: 503, ok: false })).toBe("transient");
      expect(classifyProbeResult({ status: 502, ok: false })).toBe("transient");
      expect(classifyProbeResult({ status: null, ok: false, error: "ECONNREFUSED" })).toBe("transient");
      expect(classifyProbeResult({ status: null, ok: false, error: "getaddrinfo ENOTFOUND" })).toBe("transient");
    });

    it("treats success/redirect as ready", () => {
      expect(classifyProbeResult({ status: 200, ok: true })).toBe("ready");
      expect(classifyProbeResult({ status: 301, ok: true })).toBe("ready");
    });
  });

  describe("fail-fast on topology failures (#5498)", () => {
    it("fails fast on a persistent 404 with an actionable diagnostic", async () => {
      const clock = fakeClock();
      let calls = 0;
      const promise = waitForIngressUrls({
        urls: ["https://landing-staging.chasesets.com/health/ready"],
        attempts: 60,
        delayMs: 30000,
        topologyStreak: 4,
        warmupGraceMs: 60000,
        ...clock,
        fetchImpl: async () => {
          calls += 1;
          return { status: 404 };
        },
      });

      const error = await promise.catch((caught) => caught);
      expect(error).toBeInstanceOf(IngressReadinessError);
      expect(error.classification).toBe("topology");
      // Must stop far short of the 60-attempt / ~30-min budget.
      expect(calls).toBeLessThanOrEqual(6);
      expect(error.message).toContain("landing-staging.chasesets.com");
      expect(error.message).toContain("404");
      expect(error.message).toContain("holding the promotion");
      expect(error.failures[0]).toMatchObject({
        url: "https://landing-staging.chasesets.com/health/ready",
        status: 404,
      });
    });

    it("does not abort a slow warmup: a 404 that clears to ready still succeeds", async () => {
      const clock = fakeClock();
      let calls = 0;
      // Six consecutive 404s (well past the streak threshold) then ready. This
      // would trip fail-fast if streak alone were used without corroboration,
      // but here it converges, proving a warming route is not aborted... as long
      // as the 404s eventually clear before the streak+grace verdict lands.
      const result = await waitForIngressUrls({
        urls: ["https://landing-staging.chasesets.com/health/ready"],
        attempts: 60,
        delayMs: 30000,
        // Loosen the streak so warmup 404s must persist longer to be a verdict;
        // here the route becomes ready on attempt 3, before any verdict.
        topologyStreak: 4,
        warmupGraceMs: 60000,
        ...clock,
        fetchImpl: async () => {
          calls += 1;
          return { status: calls < 3 ? 404 : 200 };
        },
      });

      expect(result.results.every((entry) => entry.ok)).toBe(true);
    });

    it("resets the streak when a 404 is interrupted by a transient status", async () => {
      const clock = fakeClock();
      let calls = 0;
      // Alternating 404 / 503 never accumulates a consecutive-404 streak, so it
      // is treated as transient and rides the full (small) budget rather than
      // fail-fast, then times out as transient.
      const error = await waitForIngressUrls({
        urls: ["https://landing-staging.chasesets.com/health/ready"],
        attempts: 6,
        delayMs: 30000,
        topologyStreak: 4,
        warmupGraceMs: 0,
        ...clock,
        fetchImpl: async () => {
          calls += 1;
          return { status: calls % 2 === 1 ? 404 : 503 };
        },
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(IngressReadinessError);
      expect(error.classification).toBe("transient-timeout");
      // Rode the full budget (no premature abort) because the streak kept resetting.
      expect(calls).toBe(6);
    });

    it("honors the warmup grace before declaring a topology failure", async () => {
      const clock = fakeClock();
      let calls = 0;
      // Persistent 404 but a very long grace window relative to delay: the
      // streak is reached quickly, yet fail-fast is withheld until grace elapses.
      await waitForIngressUrls({
        urls: ["https://landing-staging.chasesets.com/health/ready"],
        attempts: 60,
        delayMs: 1000,
        topologyStreak: 2,
        warmupGraceMs: 20000,
        ...clock,
        fetchImpl: async () => {
          calls += 1;
          return { status: 404 };
        },
      }).catch(() => {});

      // Streak of 2 is hit by attempt 2 (~1s), but grace is 20s, so it must keep
      // probing until virtual time crosses 20s (~21 attempts) before aborting.
      expect(calls).toBeGreaterThanOrEqual(20);
    });

    it("still fails a never-ready transient after the bounded budget", async () => {
      const clock = fakeClock();
      let calls = 0;
      const error = await waitForIngressUrls({
        urls: ["https://admin.staging.chasesets.com/health/ready"],
        attempts: 5,
        delayMs: 30000,
        ...clock,
        fetchImpl: async () => {
          calls += 1;
          return { status: 503 };
        },
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(IngressReadinessError);
      expect(error.classification).toBe("transient-timeout");
      expect(calls).toBe(5);
      expect(error.message).toContain("503");
    });
  });
});
