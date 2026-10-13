import { describe, expect, it, vi } from "vitest";

vi.mock("@react-router/dev/vite", () => ({ reactRouter: () => [] }));
vi.mock("@tailwindcss/vite", () => ({ default: () => [] }));

describe("marketplace production server", () => {
  it("bundles bounded-context Zod schemas", async () => {
    const { default: viteConfig } = await import("../vite.config");
    expect(viteConfig.ssr?.noExternal).toContain("zod");
  });
});
