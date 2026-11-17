import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCustomerFeedbackDependencyViolations as check } from "./customer-feedback-dependencies.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const manifest = (contextName, dependencies = ["@chase-sets/customer-feedback"]) => ({
  contextName,
  allowedContextDependencies: dependencies,
});

describe("Customer Feedback dependency inversion", () => {
  it("allows only Notifications and Platform Operations to depend on Customer Feedback", () => {
    expect(check([manifest("notifications"), manifest("platform-operations"), manifest("inventory", [])])).toEqual([]);
    for (const source of ["marketplace", "inventory", "new-context"]) {
      expect(check([manifest(source)])).toEqual([expect.stringContaining(source)]);
    }
  });

  it("checks every bounded-context manifest, excluding deployable composition roots", () => {
    const manifests = readdirSync(path.join(root, "bounded-contexts"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        JSON.parse(readFileSync(path.join(root, "bounded-contexts", entry.name, "context.json"), "utf8")),
      );
    expect(check(manifests)).toEqual([]);
    expect(
      manifests
        .filter((entry) => entry.allowedContextDependencies.includes("@chase-sets/customer-feedback"))
        .map((entry) => entry.contextName)
        .sort(),
    ).toEqual(["notifications", "platform-operations"]);
    for (const source of ["marketplace", "inventory"]) {
      const pkg = JSON.parse(readFileSync(path.join(root, "bounded-contexts", source, "package.json"), "utf8"));
      for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        expect(pkg[group]?.["@chase-sets/customer-feedback"]).toBeUndefined();
      }
    }
  });
});
