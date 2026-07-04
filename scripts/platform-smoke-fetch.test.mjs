import { describe, expect, it } from "vitest";
import { fetchWithTimeout } from "./platform-smoke-fetch.mjs";

describe("platform smoke fetch timeout", () => {
  it("returns the fetch response before the timeout expires", async () => {
    const response = { ok: true };

    await expect(fetchWithTimeout(async () => response, "https://example.test", {}, { timeoutMs: 50 })).resolves.toBe(
      response,
    );
  });

  it("fails with probe context when a fetch hangs", async () => {
    await expect(
      fetchWithTimeout(
        () =>
          new Promise(() => {
            // never resolves
          }),
        "https://example.test/health",
        {},
        { label: "production health", timeoutMs: 5 },
      ),
    ).rejects.toThrow("production health timed out after 5ms while fetching https://example.test/health.");
  });

  it("passes an abort signal to fetch", async () => {
    let signal;

    await fetchWithTimeout(
      async (_input, init) => {
        signal = init.signal;
        return { ok: true };
      },
      "https://example.test",
      {},
      { timeoutMs: 50 },
    );

    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
