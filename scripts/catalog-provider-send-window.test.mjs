import { describe, expect, it, vi } from "vitest";
import { runProviderSendWindowCommand } from "./catalog-provider-send-window.ts";
import { loadCatalogProviderSendWindowEnabled } from "../infrastructure/platform-runtime/config-schema.ts";

describe("staging-only Catalog provider-send governance", () => {
  it("absent and affirmative-disabled enablement remain disabled independently of ambient CI", () => {
    expect(loadCatalogProviderSendWindowEnabled({})).toBe(false);
    expect(
      loadCatalogProviderSendWindowEnabled({
        DEPLOYMENT_ENVIRONMENT: "production",
        CATALOG_PROVIDER_SEND_WINDOW_ENABLED: "false",
      }),
    ).toBe(false);
  });
  it.each(["production", "test", "preview", "local", undefined])(
    "refuses enablement outside staging: %s",
    (environment) => {
      expect(() =>
        loadCatalogProviderSendWindowEnabled({
          DEPLOYMENT_ENVIRONMENT: environment,
          CATALOG_PROVIDER_SEND_WINDOW_ENABLED: "true",
        }),
      ).toThrow("requires staging");
    },
  );
  it.each(["1", "yes", "TRUE", "unknown", ""])("refuses ambiguous enablement: %s", (value) => {
    expect(() =>
      loadCatalogProviderSendWindowEnabled({
        DEPLOYMENT_ENVIRONMENT: "staging",
        CATALOG_PROVIDER_SEND_WINDOW_ENABLED: value,
      }),
    ).toThrow("must be true or false");
  });
  it("accepts explicit staging enablement only", () => {
    expect(
      loadCatalogProviderSendWindowEnabled({
        DEPLOYMENT_ENVIRONMENT: "staging",
        CATALOG_PROVIDER_SEND_WINDOW_ENABLED: "true",
      }),
    ).toBe(true);
  });
  it("production arming refuses before database access", async () => {
    const query = vi.fn();
    const pool = { query, connect: vi.fn() };
    await expect(
      runProviderSendWindowCommand(pool, { environment: "production", action: "arm", apply: true, installation: {} }),
    ).rejects.toThrow("staging-required");
    expect(query).not.toHaveBeenCalled();
  });
  it("a staging argument cannot override the database identity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: "synthetic_not_staging" }] });
    const connect = vi.fn();
    const pool = { query, connect };
    await expect(
      runProviderSendWindowCommand(pool, { environment: "staging", action: "arm", apply: true, installation: {} }),
    ).rejects.toThrow("database-identity-refused");
    expect(connect).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT current_database() AS name");
  });
});
