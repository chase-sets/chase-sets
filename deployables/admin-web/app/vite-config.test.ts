import { describe, expect, it, vi } from "vitest";

vi.mock("@react-router/dev/vite", () => ({ reactRouter: () => [] }));
vi.mock("@tailwindcss/vite", () => ({ default: () => [] }));

describe("admin web dev proxy", () => {
  it("proxies bounded-context admin API mounts used by contributed routes", async () => {
    const { default: viteConfig } = await import("../vite.config");
    const proxyPaths = Object.keys(viteConfig.server?.proxy ?? {});

    expect(proxyPaths).toEqual(
      expect.arrayContaining(["/api/experience", "/api/marketplace", "/api/commercial-terms", "/api/settlement"]),
    );
  });
});
