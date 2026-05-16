import { describe, expect, it } from "vitest";
import { loader as manifestLoader } from "./manifest";
import { loader as serviceWorkerLoader } from "./service-worker";

describe("admin PWA endpoints", () => {
  it("serves the admin web manifest", async () => {
    const manifest = manifestLoader({
      request: new Request("https://admin.example/manifest.webmanifest"),
      params: {},
      context: undefined,
    } as never);

    expect(manifest.headers.get("Content-Type")).toContain("application/manifest+json");
    await expect(manifest.json()).resolves.toMatchObject({
      name: "Chase Sets Admin",
      short_name: "CS Admin",
      start_url: "/",
      scope: "/",
      display: "standalone",
      icons: expect.arrayContaining([
        expect.objectContaining({
          src: "/icons/chase-sets-admin-192.png",
          sizes: "192x192",
          purpose: "any",
        }),
        expect.objectContaining({
          src: "/icons/chase-sets-admin-maskable-512.png",
          sizes: "512x512",
          purpose: "maskable",
        }),
      ]),
    });
  });

  it("serves the admin service worker", async () => {
    const serviceWorker = serviceWorkerLoader({
      request: new Request("https://admin.example/service-worker.js"),
      params: {},
      context: undefined,
    } as never);

    expect(serviceWorker.headers.get("Content-Type")).toContain(
      "application/javascript",
    );
    expect(serviceWorker.headers.get("Service-Worker-Allowed")).toBe("/");
    await expect(serviceWorker.text()).resolves.toContain("addEventListener(\"fetch\"");
  });
});
