import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { connectorTransport } from "../src/adapters/connector-transport";
import {
  assertHarnessOrigins,
  connectorHostRegistry,
  platformOrigin,
  portalOrigin,
} from "../__tests__/harness/origins";
import { connectorViteConfig } from "../vite.config";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("connector-transport-origin-allowlist", () => {
  it("uses exactly the manifest origins and refuses before fetch, including redirects", async () => {
    const network = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", network);
    const input = {
      platformOrigin,
      hostRegistry: connectorHostRegistry,
      permissionRegistry: ["identity", "storage", "alarms"],
    };
    const request = connectorTransport(input);
    await request(new Request(`${portalOrigin}/portal/mutate`, { redirect: "error" }));
    expect(network).toHaveBeenCalledOnce();
    network.mockClear();
    for (const url of ["https://tcgplayer.com", "http://127.0.0.1:46176", "http://127.0.0.1.invalid:46175"])
      await expect(request(new Request(url, { redirect: "error" }))).rejects.toThrow(
        "connector-transport-origin-refused",
      );
    await expect(request(new Request(portalOrigin))).rejects.toThrow("connector-transport-origin-refused");
    await expect(
      connectorTransport({ ...input, hostRegistry: [] })(new Request(portalOrigin, { redirect: "error" })),
    ).rejects.toThrow("connector-transport-origin-refused");
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects planted real/non-loopback origins before harness build or network", () => {
    for (const origin of [
      "https://tcgplayer.com",
      "https://synthetic.invalid",
      "http://localhost:46175",
      "http://127.0.0.1:46176",
    ])
      expect(() => assertHarnessOrigins(platformOrigin, [{ origin }])).toThrow("connector-harness-origin-refused");
    vi.stubEnv("VITE_PLATFORM_API_URL", "https://tcgplayer.com");
    expect(() => connectorViteConfig("harness")).toThrow("connector-harness-origin-refused");
  });
  it("an allowlist-bypass mutant fails the isolated observer zero-network witness", async () => {
    let calls = 0;
    const observer = createServer((_request, response) => {
      calls++;
      response.end("{}");
    });
    await new Promise<void>((resolve) => observer.listen(0, "127.0.0.1", resolve));
    try {
      const address = observer.address();
      if (!address || typeof address === "string") throw new Error("observer-address-missing");
      const input = new Request(`http://127.0.0.1:${address.port}`, { redirect: "error" });
      const candidate = connectorTransport({
        platformOrigin,
        hostRegistry: connectorHostRegistry,
        permissionRegistry: ["identity", "storage", "alarms"],
      });
      await expect(candidate(input)).rejects.toThrow("connector-transport-origin-refused");
      expect(calls).toBe(0);
      const bypass = (request: Request) => fetch(request);
      await bypass(input);
      expect(() => expect(calls).toBe(0)).toThrow();
    } finally {
      observer.closeAllConnections();
      await new Promise<void>((resolve) => observer.close(() => resolve()));
    }
  });
});
