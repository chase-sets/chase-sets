import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorTargets, connectorViteConfig } from "../vite.config";

afterEach(() => vi.unstubAllEnvs());

const clientId = "cc_client_12345678-1234-1234-1234-123456789abc";

describe("extension-build-target-contract", () => {
  it("binds deployed modes to generated marketplace origins and the public client", () => {
    vi.stubEnv("VITE_CONNECTOR_CLIENT_ID", clientId);
    expect(connectorViteConfig("connector-staging").define?.["import.meta.env.VITE_PLATFORM_API_URL"]).toBe(
      JSON.stringify(connectorTargets.staging),
    );
    expect(connectorViteConfig("connector-production").define?.["import.meta.env.VITE_PLATFORM_API_URL"]).toBe(
      JSON.stringify(connectorTargets.production),
    );
    expect(connectorViteConfig("connector-production").define?.["import.meta.env.VITE_CONNECTOR_CLIENT_ID"]).toBe(
      JSON.stringify(clientId),
    );
  });

  it.each([
    ["production", "connector-build-mode-refused"],
    ["unknown", "connector-build-mode-refused"],
  ])("refuses mode mutant %s before emit", (mode, error) => {
    expect(() => connectorViteConfig(mode as never)).toThrow(error);
  });

  it.each([
    ["", "connector-client-id-refused"],
    ["not-a-client", "connector-client-id-refused"],
  ])("refuses deployed client-id mutant %s", (value, error) => {
    vi.stubEnv("VITE_CONNECTOR_CLIENT_ID", value);
    expect(() => connectorViteConfig("connector-production")).toThrow(error);
  });

  it("refuses an inherited deployed origin and non-loopback local origin", () => {
    vi.stubEnv("VITE_CONNECTOR_CLIENT_ID", clientId);
    vi.stubEnv("PLATFORM_API_URL", "https://wrong.example");
    expect(() => connectorViteConfig("connector-production")).toThrow("connector-deployed-origin-refused");
    vi.stubEnv("VITE_PLATFORM_API_URL", "https://wrong.example/path");
    expect(() => connectorViteConfig("connector-local")).toThrow("connector-local-origin-refused");
  });
});
