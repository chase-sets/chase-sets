import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  collectIdentityCreationRegistryViolations,
  collectOpenSchemaObjectPaths,
  identityCreationDispositions,
  listIdentityCreationEntries,
  loadIdentityCreationPathRegistry,
  loadIdentityCreationPathRegistrySchema,
  validateAgainstSchema,
} from "./identity-creation-path-registry.mjs";

const registry = loadIdentityCreationPathRegistry();
const schema = loadIdentityCreationPathRegistrySchema();

function readSite(site) {
  const absolute = path.join(repoRoot, site.file);
  if (!existsSync(absolute)) {
    return null;
  }
  return readFileSync(absolute, "utf8").split(/\r?\n/);
}

describe("identity creation path registry", () => {
  it("validates against a recursively closed schema", () => {
    expect(collectOpenSchemaObjectPaths(schema)).toEqual([]);
    expect(validateAgainstSchema(registry, schema)).toEqual([]);
  });

  it("rejects an unknown member at every nesting level", () => {
    const withUnknownTopLevel = { ...registry, surprise: true };
    expect(validateAgainstSchema(withUnknownTopLevel, schema)).toContain('<root>: unknown member "surprise"');

    const withUnknownEntry = {
      ...registry,
      paths: [{ ...registry.paths[0], surprise: true }, ...registry.paths.slice(1)],
    };
    expect(validateAgainstSchema(withUnknownEntry, schema)).toContain('<root>/paths[0]: unknown member "surprise"');

    const withUnknownSite = {
      ...registry,
      paths: [
        { ...registry.paths[0], sites: [{ ...registry.paths[0].sites[0], surprise: true }] },
        ...registry.paths.slice(1),
      ],
    };
    expect(validateAgainstSchema(withUnknownSite, schema)).toContain(
      '<root>/paths[0]/sites[0]: unknown member "surprise"',
    );

    const withUnknownMember = {
      ...registry,
      compositions: [
        { ...registry.compositions[0], members: [{ ...registry.compositions[0].members[0], surprise: true }] },
      ],
    };
    expect(validateAgainstSchema(withUnknownMember, schema)).toContain(
      '<root>/compositions[0]/members[0]: unknown member "surprise"',
    );
  });

  it("gives every entry a disposition and a non-empty reason", () => {
    for (const entry of listIdentityCreationEntries(registry)) {
      expect(identityCreationDispositions.has(entry.disposition), `${entry.id} disposition`).toBe(true);
      expect(entry.reason.trim().length, `${entry.id} reason`).toBeGreaterThan(0);
    }
    expect(collectIdentityCreationRegistryViolations(registry, schema)).toEqual([]);
  });

  it("makes every temporary exemption name an owning issue", () => {
    const temporary = listIdentityCreationEntries(registry).filter((entry) => entry.disposition === "exempt-temporary");
    expect(temporary.length).toBeGreaterThan(0);
    for (const entry of temporary) {
      expect(typeof entry.owningIssue, `${entry.id} owner`).toBe("number");
    }
  });

  it("fails an entry whose reason is blank or whose temporary exemption has no owner", () => {
    const blankReason = {
      ...registry,
      paths: [{ ...registry.paths[0], reason: "   " }, ...registry.paths.slice(1)],
    };
    expect(collectIdentityCreationRegistryViolations(blankReason, schema)).toContain(
      `${registry.paths[0].id}: every entry needs a reason`,
    );

    const ownerless = { ...registry.compositions[0] };
    delete ownerless.owningIssue;
    const withoutOwner = { ...registry, compositions: [ownerless] };
    expect(collectIdentityCreationRegistryViolations(withoutOwner, schema)).toContain(
      `${ownerless.id}: every temporary exemption must name an owning issue`,
    );
  });

  it("binds all six public first-use paths and every direct register client", () => {
    const bound = registry.paths.filter((entry) => entry.disposition === "bound");
    expect(bound.filter((entry) => entry.kind === "public-first-use").map((entry) => entry.id)).toEqual([
      "password-direct-registration",
      "invitation-registration",
      "first-use-magic-link",
      "passkey-registration",
      "phone-code-registration",
      "social-login-first-use",
    ]);
    expect(bound.filter((entry) => entry.kind === "direct-register-client").map((entry) => entry.id)).toEqual([
      "marketplace-register-route-action",
      "marketplace-e2e-auth-helper",
      "guest-buy-now-freshness-probe",
      "stripe-money-smoke-test",
    ]);
  });

  it("registers guest checkout as one pinned composition exemption", () => {
    const guestCheckout = registry.compositions.find((entry) => entry.id === "guest-checkout-account-claim");
    expect(guestCheckout, "guest checkout must be classified, not omitted").toBeTruthy();
    expect(guestCheckout.disposition).toBe("exempt-temporary");
    expect(guestCheckout.members.map((member) => member.constructor).sort()).toEqual([
      "claimGuestAccount",
      "createGuestAccount",
      "createUser",
    ]);
    for (const member of guestCheckout.members) {
      const lines = readSite(member);
      expect(lines, `${member.file} must exist`).toBeTruthy();
      expect(lines[member.line - 1], `${member.file}:${member.line}`).toContain(member.constructor);
    }
  });

  it("pins every registered site to a file that still exists", () => {
    for (const entry of registry.paths) {
      for (const site of entry.sites) {
        expect(readSite(site), `${entry.id} -> ${site.file}`).toBeTruthy();
      }
    }
  });

  it("classifies every Auth caller of the personal-identity constructor", () => {
    const authRoutesDirectory = path.join(repoRoot, "bounded-contexts/auth/support/api-support");
    const registered = new Set(
      registry.paths.flatMap((entry) => entry.sites.map((site) => `${site.file}:${site.line}`)),
    );

    const discovered = [];
    for (const entry of registry.paths.filter((path) => path.kind === "public-first-use")) {
      for (const site of entry.sites) {
        discovered.push(`${site.file}:${site.line}`);
      }
    }

    // Independent rediscovery: every createPersonalIdentity call in the Auth
    // API surface must already be a registered site. A new caller shows up here
    // as an unregistered position rather than as a silently bound one.
    const callSites = [];
    for (const file of [
      "invitation-routes",
      "magic-link-routes",
      "passkey-routes",
      "phone-code-routes",
      "register-routes",
      "social-login-routes",
      "guest-checkout-routes",
    ]) {
      const relative = `bounded-contexts/auth/support/api-support/${file}.ts`;
      const lines = readFileSync(path.join(authRoutesDirectory, `${file}.ts`), "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes("await identityMutations.createPersonalIdentity(")) {
          callSites.push(`${relative}:${index + 1}`);
        }
      });
    }

    expect(callSites.length).toBe(6);
    expect(callSites.filter((site) => !registered.has(site))).toEqual([]);
    expect(discovered.sort()).toEqual(callSites.sort());
  });
});
