import { describe, expect, it } from "vitest";
import { retiredFreshnessDroppingForwardingImport } from "./run.mjs";

describe("retired freshness forwarding helper guard", () => {
  it("rejects the retired bounded-context runtime helper package path", () => {
    expect(
      retiredFreshnessDroppingForwardingImport(
        "bounded-contexts/checkout/support/request-support/api-client.ts",
        "@chase-sets/bounded-context-runtime/http",
      ),
    ).toBe(true);
  });

  it("rejects relative imports of the retired helper file", () => {
    expect(
      retiredFreshnessDroppingForwardingImport(
        "infrastructure/platform-runtime/http.test.ts",
        "../bounded-context-runtime/http",
      ),
    ).toBe(true);
  });

  it("allows the canonical platform runtime helper path", () => {
    expect(
      retiredFreshnessDroppingForwardingImport(
        "bounded-contexts/checkout/support/request-support/api-client.ts",
        "@chase-sets/platform-runtime/http",
      ),
    ).toBe(false);
  });
});
