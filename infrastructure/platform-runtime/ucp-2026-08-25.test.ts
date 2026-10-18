import Ajv2020 from "ajv/dist/2020";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildUcpBusinessProfile, createUcpEnvelope, UCP_VERSION } from "./ucp-contracts";

describe("UCP 2026-08-25 contract", () => {
  it("validates the business profile against the complete offline schema closure", () => {
    const rootPath = fileURLToPath(new URL("./__fixtures__/ucp-2026-08-25/schemas/", import.meta.url));
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".json")) files.push(path);
      }
    };
    visit(rootPath);
    expect(files.length).toBeGreaterThanOrEqual(66);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const path of files) ajv.addSchema(JSON.parse(readFileSync(path, "utf8")), relative(rootPath, path));
    const schema =
      ajv.getSchema("profile.json#/$defs/business_schema") ??
      ajv.compile({ $ref: "profile.json#/$defs/business_schema" });
    const profile = buildUcpBusinessProfile("https://shop.example", {
      signingKeys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "current" }],
    });
    expect(schema(profile), JSON.stringify(schema.errors)).toBe(true);
    const withoutPaymentHandlers = structuredClone(profile) as { ucp: { payment_handlers?: unknown } };
    delete withoutPaymentHandlers.ucp.payment_handlers;
    expect(schema(withoutPaymentHandlers)).toBe(false);
  });

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
    expect(success).toEqual({
      ucp: { version: UCP_VERSION, status: "success", payment_handlers: {} },
      id: "chk_1",
      status: "completed",
    });

    const failure = createUcpEnvelope("error", {}, [{ severity: "error", code: "bad", message: "Bad request" }]);
    expect(failure).toEqual({
      ucp: { version: UCP_VERSION, status: "error" },
      messages: [{ type: "error", severity: "error", code: "bad", content: "Bad request" }],
    });
    expect(failure.messages?.[0]).toMatchObject({ type: "error", content: "Bad request" });
  });
});
