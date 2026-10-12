import { describe, expect, it } from "vitest";
import { parseCapabilityAdministrationAuthority } from "./authority";

const scope = {
  environment: "preview",
  deploymentInstance: '["support-deployment-instance/v1","preview-9385","release-a"]',
  implementationSha: "a".repeat(40),
};
const config = {
  version: 1,
  ...scope,
  authorityId: "support-admin",
  revision: 1,
  adminUserIds: ["usr_synthetic_admin"],
};
const { implementationSha: _, ...declaration } = config;

describe("Capability Administration Authority closed configuration", () => {
  it("binds the effective list and scope, independent of JSON property order", () => {
    const authority = parseCapabilityAdministrationAuthority(JSON.stringify(declaration), scope);
    expect(authority.kind).toBe("configured");
    expect(
      parseCapabilityAdministrationAuthority(JSON.stringify({ ...declaration, adminUserIds: ["usr_other"] }), scope),
    ).not.toEqual(authority);
    expect(
      parseCapabilityAdministrationAuthority(
        JSON.stringify(Object.fromEntries(Object.entries(declaration).reverse())),
        scope,
      ),
    ).toEqual(authority);
  });
  it.each([
    undefined,
    "",
    "PLANTED_SECRET",
    "{}",
    JSON.stringify({ ...declaration, extra: "PLANTED_SECRET" }),
    JSON.stringify({ ...declaration, environment: "production" }),
    JSON.stringify({
      ...declaration,
      deploymentInstance: '["support-deployment-instance/v1","preview-9385","release-b"]',
    }),
    JSON.stringify({
      ...declaration,
      deploymentInstance: '["support-deployment-instance/v1",{"nested":"PLANTED_SECRET"},"release-a"]',
    }),
    JSON.stringify({ ...declaration, deploymentInstance: '["support-deployment-instance/v1","Upper","release-a"]' }),
    JSON.stringify({ ...declaration, revision: 0 }),
    JSON.stringify({ ...declaration, revision: 2147483648 }),
    JSON.stringify({ ...declaration, adminUserIds: ["usr_x", "usr_x"] }),
    JSON.stringify({ ...declaration, adminUserIds: ["*"] }),
    JSON.stringify({ ...declaration, adminUserIds: Array.from({ length: 17 }, (_, i) => `usr_${i}`) }),
    " ".repeat(4097),
  ])("rejects closed-schema/scope bypass mutant: %s", (raw) => {
    const result = parseCapabilityAdministrationAuthority(raw, scope);
    expect(result.kind).toBe("deny-all");
    expect(JSON.stringify(result)).not.toContain("PLANTED_SECRET");
  });
  it("requires a trusted tuple and implementation identity even when the declaration is valid", () => {
    expect(
      parseCapabilityAdministrationAuthority(JSON.stringify(declaration), { ...scope, deploymentInstance: undefined })
        .kind,
    ).toBe("deny-all");
    expect(
      parseCapabilityAdministrationAuthority(JSON.stringify(declaration), { ...scope, implementationSha: undefined })
        .kind,
    ).toBe("deny-all");
  });
  it("admits nobody on a valid retirement list", () => {
    expect(
      parseCapabilityAdministrationAuthority(JSON.stringify({ ...declaration, revision: 2, adminUserIds: [] }), scope),
    ).toMatchObject({ kind: "configured", adminUserIds: [] });
  });
});
