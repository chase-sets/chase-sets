import { describe, expect, it, vi } from "vitest";

vi.mock("@react-router/dev/vite", () => ({ reactRouter: () => [] }));
vi.mock("@tailwindcss/vite", () => ({ default: () => [] }));

/**
 * Composition-boundary regression coverage for #5145. The marketplace host
 * composes the same platform API as the admin host, so the marketplace host's
 * API route registry (its forwarded `/api/*` allowlist) is the deny-by-default
 * boundary that keeps the staff-only customer-feedback operator surface off
 * customer sessions.
 *
 * The operator surface lives under the `/api/experience` and `/api/platform`
 * mounts. The marketplace host must NOT forward either mount, so an operator
 * feedback route cannot mount for a customer session on the marketplace origin
 * even when the path is guessed directly. Server-side capability authz on the
 * platform API remains authoritative; this guard stops a later host change from
 * silently re-exposing the operator mounts through the marketplace edge.
 */
describe("marketplace host API route registry (#5145)", () => {
  it("does not forward the staff-only feedback operator mounts to customer sessions", async () => {
    const { default: viteConfig } = await import("../vite.config");
    const proxyPaths = Object.keys(viteConfig.server?.proxy ?? {});

    expect(proxyPaths).not.toContain("/api/experience");
    expect(proxyPaths).not.toContain("/api/platform");
    // No forwarded prefix may open a path into the experience/platform mounts.
    for (const path of proxyPaths) {
      expect(path.startsWith("/api/experience"), path).toBe(false);
      expect(path.startsWith("/api/platform"), path).toBe(false);
    }
  });

  it("still forwards the customer-facing marketplace API surface", async () => {
    const { default: viteConfig } = await import("../vite.config");
    const proxyPaths = Object.keys(viteConfig.server?.proxy ?? {});

    // Sanity: the boundary above is a deny of the operator mounts, not a broken
    // proxy config -- the ordinary customer API surface is still forwarded.
    expect(proxyPaths).toEqual(expect.arrayContaining(["/api/marketplace", "/api/auth"]));
  });
});
