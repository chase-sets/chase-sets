import { describe, expect, it, vi } from "vitest";
import {
  createChromeDevtoolsLoader,
  createFaviconLoader,
  createWebLiveLoader,
  createWebReadyLoader,
} from "./web-assets";

describe("web asset loaders", () => {
  it("serves the shared favicon response", async () => {
    const loader = createFaviconLoader("<svg />");
    const response = loader({ request: new Request("https://example.test/favicon.svg") });

    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400");
    await expect(response.text()).resolves.toBe("<svg />");
  });

  it("serves no-content Chrome DevTools metadata", () => {
    const loader = createChromeDevtoolsLoader();
    const response = loader({
      request: new Request("https://example.test/.well-known/appspecific/com.chrome.devtools.json"),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves a simple web readiness payload", async () => {
    const loader = createWebReadyLoader("public-web");
    const response = loader({ request: new Request("https://public.example/health/ready") });
    const body = (await response.json()) as { ok: boolean; service: string; origin: string };

    expect(body).toMatchObject({
      ok: true,
      service: "public-web",
      origin: "https://public.example",
    });
  });

  it("serves a DB-free liveness payload with no upstream call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const loader = createWebLiveLoader();
    const response = loader({ request: new Request("https://public.example/health/live") });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
