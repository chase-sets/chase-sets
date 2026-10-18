import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { buildUcpBusinessProfile, createUcpEnvelope, UCP_VERSION } from "./ucp-contracts";

describe("UCP 2026-08-25 contract", () => {
  it("publishes one version, canonical keys, and an empty payment-handler map", () => {
    const profile = buildUcpBusinessProfile("https://shop.example", {
      signingKeys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "current" }],
    });
    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(profile).toHaveProperty("keys");
    expect(profile.ucp.payment_handlers).toEqual({});
    expect(profile).not.toHaveProperty("signing_keys");
    expect(profile.ucp).not.toHaveProperty("supported_versions");
  });

  it("uses the root resource and closed error messages", () => {
    const success = createUcpEnvelope("success", { checkout: { id: "chk_1", status: "completed" } });
    expect(success).toEqual({ ucp: { version: UCP_VERSION, status: "success" }, id: "chk_1", status: "completed" });

    const failure = createUcpEnvelope("error", {}, [{ severity: "error", code: "bad", message: "Bad request" }]);
    expect(failure).toEqual({
      ucp: { version: UCP_VERSION, status: "error" },
      messages: [{ type: "error", severity: "error", code: "bad", content: "Bad request" }],
    });
    const ajv = new Ajv({ strict: false });
    expect(
      ajv.compile({
        type: "object",
        required: ["ucp", "messages"],
        additionalProperties: false,
        properties: { ucp: { type: "object" }, messages: { type: "array" } },
      })(failure),
    ).toBe(true);
  });
});
