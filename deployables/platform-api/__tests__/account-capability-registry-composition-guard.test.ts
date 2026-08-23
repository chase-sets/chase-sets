import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAccountCapabilityRegistry } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const repositoryRoot = path.join(import.meta.dirname, "..", "..", "..");

describe("platform-api Account Capability registry composition guard", () => {
  it("assembles the exact complete seed catalog with registration-derived owners", () => {
    expect(buildAccountCapabilityRegistry(apiContextRegistry)).toEqual([
      {
        owningContext: "authenticity",
        key: "authenticity.seller-included",
        description: "Declares whether an Account may use seller-included authenticity evidence.",
        kind: "boolean",
        defaultValue: false,
      },
      {
        owningContext: "inventory",
        key: "inventory.locations",
        description: "Declares the Account's inventory location limit.",
        kind: "limit",
        defaultValue: 0,
      },
      {
        owningContext: "platform-operations",
        key: "mcp.rate-tier",
        description: "Declares the Account's MCP rate tier.",
        kind: "tier",
        allowedValues: ["standard"],
        defaultValue: "standard",
      },
    ]);
  });

  it("keeps shipped Account Capability catalog terms separate from planned lifecycle terms", () => {
    const glossary = readFileSync(path.join(repositoryRoot, "bounded-contexts", "identity", "GLOSSARY.md"), "utf8");
    const readme = readFileSync(path.join(repositoryRoot, "bounded-contexts", "identity", "README.md"), "utf8");
    const shippedHeading = "## Account Capabilities";
    const plannedHeading = "## Planned Account Capabilities And Channel Connections";
    const shippedStart = glossary.indexOf(shippedHeading);
    const plannedStart = glossary.indexOf(plannedHeading);

    expect(shippedStart).toBeGreaterThanOrEqual(0);
    expect(plannedStart).toBeGreaterThan(shippedStart);
    expect(glossary.slice(shippedStart + shippedHeading.length, plannedStart).trimEnd()).not.toMatch(/^## /m);

    const shipped = glossary.slice(shippedStart, plannedStart);
    const planned = glossary.slice(plannedStart);
    for (const term of ["Account Capability", "Account Capability Declaration", "Account Capability Registry"]) {
      expect(shipped).toMatch(new RegExp(`^### ${term}$`, "m"));
      expect(readme).toContain(`**${term}**`);
    }
    for (const key of ["authenticity.seller-included", "inventory.locations", "mcp.rate-tier"]) {
      expect(shipped).toContain(`\`${key}\``);
      expect(planned).not.toContain(`\`${key}\``);
    }
    expect(shipped).toMatch(/inert declarations without grants, resolution, enforcement, pricing, or UI behavior/);
    expect(readme).toMatch(/inert metadata.*no grants, resolution, enforcement, pricing, or UI behavior/s);

    for (const plannedTerm of [
      "Capability Grant",
      "Capability Restriction",
      "Capability Requirement",
      "Capability Level",
      "Account Standing",
      "Capability Status",
      "Capability Review",
    ]) {
      expect(planned).toMatch(new RegExp(`^### ${plannedTerm}$`, "m"));
      expect(shipped).not.toMatch(new RegExp(`^### ${plannedTerm}$`, "m"));
    }
  });
});
