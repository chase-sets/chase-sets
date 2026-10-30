import { describe, expect, it, vi } from "vitest";
import { loader } from "./operations-attention";

const queue = {
  items: [],
  rollup: {
    total: 0,
    bySeverity: { critical: 0, warning: 0, info: 0 },
    bySource: {
      "projection-poison-event": 0,
      "projection-blocked-stream": 0,
      "wake-stalled-job": 0,
      "support-request-deadline": 0,
      "platform-feedback-unreviewed": 0,
    },
  },
  sources: [],
  degraded: false,
};

describe("OperationsAttentionRoute loader", () => {
  it("fetches the owning API once without a permission list", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(queue));
    try {
      const result = await loader({
        request: new Request("https://admin.example/platform/operations-attention"),
      } as never);

      expect(result).toEqual({ queue });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [input, init] = fetch.mock.calls[0] ?? [];
      expect(String(input)).toBe("https://admin.example/api/platform/operations-attention");
      expect((init?.headers as Headers).get("authorization")).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([401, 403])("propagates a %s API response", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status }));
    try {
      await expect(
        loader({ request: new Request("https://admin.example/platform/operations-attention") } as never),
      ).rejects.toMatchObject({ status });
    } finally {
      fetch.mockRestore();
    }
  });
});
