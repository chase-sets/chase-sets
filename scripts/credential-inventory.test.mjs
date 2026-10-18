import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_INVENTORY_PATH,
  checkCredentialInventory,
  checkInventoryAgainstWorkflowSources,
  validateCredentialInventory,
} from "./credential-inventory.mjs";

const repositoryInventory = JSON.parse(readFileSync(resolve(CREDENTIAL_INVENTORY_PATH), "utf8"));

function entry(name, overrides = {}) {
  return {
    name,
    scope: ["staging", "production"],
    kind: "credential",
    rotation: "assisted",
    providerExpiryDays: null,
    maxAgeDays: 365,
    liveness: null,
    pairedWith: [],
    proofWorkflows: [],
    ...overrides,
  };
}

function fixture(secrets) {
  return { schemaVersion: 1, environments: ["production", "staging"], secrets };
}

function validFixture() {
  const { inventory, errors } = validateCredentialInventory(
    fixture([
      entry("ALPHA_TOKEN", { proofWorkflows: ["deploy.yml"] }),
      entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-list-buckets" }, pairedWith: ["SPACES_SECRET_KEY"] }),
      entry("SPACES_SECRET_KEY", { pairedWith: ["SPACES_ACCESS_ID"] }),
      entry("UNSET_SIGNING_KEY", { optional: true }),
    ]),
  );
  expect(errors).toEqual([]);
  return inventory;
}

function workflow(body) {
  return { file: ".github/workflows/deploy.yml", source: body };
}

const referencingAll = workflow(
  [
    "env:",
    "  A: ${{ secrets.ALPHA_TOKEN }}",
    "  B: ${{ secrets.SPACES_ACCESS_ID }}",
    "  C: ${{ secrets.SPACES_SECRET_KEY }}",
    "  D: ${{ secrets.UNSET_SIGNING_KEY }}",
  ].join("\n"),
);

describe("credential inventory check (AC1)", () => {
  it("passes on the repository inventory, workflows and actions", () => {
    expect(checkCredentialInventory(resolve("."))).toEqual([]);
    const { inventory } = validateCredentialInventory(repositoryInventory);
    expect(inventory.entries.filter((candidate) => candidate.optional)).toHaveLength(11);
  });

  it("names a referenced secret that has no entry", () => {
    const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
      referencingAll,
      { file: ".github/actions/example/action.yml", source: "token: ${{ secrets.NEW_THING }}" },
    ]);
    expect(errors).toEqual([
      "NEW_THING: referenced by .github/actions/example/action.yml but has no credential inventory entry",
    ]);
  });

  it.each(["secrets['X']", 'secrets["X"]', "secrets [ 'X' ]", "secrets[format('{0}', inputs.name)]"])(
    "rejects index syntax %s",
    (expression) => {
      const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
        referencingAll,
        workflow(`run: echo "\${{ ${expression} }}"`),
      ]);
      expect(errors).toEqual([".github/workflows/deploy.yml:1: secrets[...] index syntax is not allowed"]);
    },
  );

  it("does not read step ids or GITHUB_TOKEN as inventory names", () => {
    const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
      referencingAll,
      workflow(
        "a: ${{ steps.runtime_secrets.outcome }}\nb: ${{ steps.secrets.outputs.value }}\nc: ${{ secrets.GITHUB_TOKEN }}",
      ),
    ]);
    expect(errors).toEqual([]);
  });

  it("requires proof workflows and optional names to be real references", () => {
    const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
      workflow("env:\n  B: ${{ secrets.SPACES_ACCESS_ID }}\n  C: ${{ secrets.SPACES_SECRET_KEY }}"),
    ]);
    expect(errors).toEqual([
      "ALPHA_TOKEN: proof workflow deploy.yml does not reference this secret",
      "UNSET_SIGNING_KEY: optional entries are for referenced names, but no workflow references it",
    ]);
  });

  it("rejects overlapping valueGroups and groups that do not cover scope", () => {
    const overlap = validateCredentialInventory(
      fixture([entry("ALPHA_TOKEN", { valueGroups: [["staging", "production"], ["production"]] })]),
    );
    expect(overlap.errors).toEqual(["ALPHA_TOKEN: valueGroups must partition scope without overlap"]);
    const partial = validateCredentialInventory(fixture([entry("ALPHA_TOKEN", { valueGroups: [["staging"]] })]));
    expect(partial.errors).toEqual(["ALPHA_TOKEN: valueGroups must partition scope without overlap"]);
  });

  it("defaults to one value group per scope member", () => {
    const { inventory } = validateCredentialInventory(fixture([entry("ALPHA_TOKEN")]));
    expect(inventory.byName.get("ALPHA_TOKEN").valueGroups).toEqual([["staging"], ["production"]]);
    expect(inventory.scopes).toEqual(["repository", "production", "staging"]);
  });

  it.each([
    ["an unknown key", { secret: "value" }, "ALPHA_TOKEN: unknown key secret"],
    ["an unknown kind", { kind: "password" }, "ALPHA_TOKEN: kind must be credential or identifier"],
    [
      "an unknown rotation",
      { rotation: "manual" },
      "ALPHA_TOKEN: rotation must be automatic, assisted or external-owner",
    ],
    [
      "external-owner without an owner",
      { rotation: "external-owner" },
      "ALPHA_TOKEN: owner issue is required for external-owner rotation and only there",
    ],
    [
      "an owner on an assisted entry",
      { owner: 8447 },
      "ALPHA_TOKEN: owner issue is required for external-owner rotation and only there",
    ],
    ["an assisted age other than 365", { maxAgeDays: 90 }, "ALPHA_TOKEN: assisted credentials use maxAgeDays 365"],
    ["a credential without an age limit", { maxAgeDays: null }, "ALPHA_TOKEN: credentials need maxAgeDays"],
    [
      "an identifier with an age limit",
      { kind: "identifier" },
      "ALPHA_TOKEN: identifier entries carry no age limit or provider expiry",
    ],
    [
      "a fractional provider expiry",
      { providerExpiryDays: 1.5 },
      "ALPHA_TOKEN: providerExpiryDays must be a positive integer or null",
    ],
    [
      "an unknown liveness kind",
      { liveness: { kind: "stripe-account" } },
      "ALPHA_TOKEN: liveness must be null or { kind, bucket? } with a known kind",
    ],
    [
      "a bucket on a non-bucket check",
      { liveness: { kind: "digitalocean-account", bucket: "evidence-bucket" } },
      "ALPHA_TOKEN: liveness bucket is required for spaces-bucket and only there",
    ],
    [
      "an uninventoried environment",
      { scope: ["staging", "qa"] },
      'ALPHA_TOKEN: scope must be "repository" or a list of inventoried environments',
    ],
    ["a self pairing", { pairedWith: ["ALPHA_TOKEN"] }, "ALPHA_TOKEN: pairedWith must list other secret names"],
    [
      "a non-workflow proof",
      { proofWorkflows: ["deploy.sh"] },
      "ALPHA_TOKEN: proofWorkflows must list workflow file names",
    ],
    ["optional false", { optional: false }, "ALPHA_TOKEN: optional may only be true"],
  ])("rejects a malformed entry with %s", (_label, overrides, message) => {
    expect(validateCredentialInventory(fixture([entry("ALPHA_TOKEN", overrides)])).errors).toEqual([message]);
  });

  it("rejects duplicate, unsorted and unreciprocated entries", () => {
    expect(validateCredentialInventory(fixture([entry("B_TOKEN"), entry("A_TOKEN")])).errors).toEqual([
      "A_TOKEN: entries must be sorted by name",
    ]);
    expect(validateCredentialInventory(fixture([entry("A_TOKEN"), entry("A_TOKEN")])).errors).toEqual([
      "A_TOKEN: duplicate entry",
      "A_TOKEN: entries must be sorted by name",
    ]);
    expect(
      validateCredentialInventory(fixture([entry("A_TOKEN", { pairedWith: ["B_TOKEN"] }), entry("B_TOKEN")])).errors,
    ).toEqual(["A_TOKEN: pairedWith B_TOKEN is not reciprocated"]);
  });

  it("requires a bucket for a scoped Spaces check", () => {
    const errors = validateCredentialInventory(
      fixture([
        entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-bucket" }, pairedWith: ["SPACES_SECRET_KEY"] }),
        entry("SPACES_SECRET_KEY", { pairedWith: ["SPACES_ACCESS_ID"] }),
      ]),
    ).errors;
    expect(errors).toEqual(["SPACES_ACCESS_ID: liveness bucket is required for spaces-bucket and only there"]);
  });

  it("requires a Spaces liveness entry to pair with exactly one same-scope secret key", () => {
    const errors = validateCredentialInventory(
      fixture([
        entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-list-buckets" }, pairedWith: ["SPACES_SECRET_KEY"] }),
        entry("SPACES_SECRET_KEY", { scope: ["staging"], pairedWith: ["SPACES_ACCESS_ID"] }),
      ]),
    ).errors;
    expect(errors).toEqual([
      "SPACES_ACCESS_ID: Spaces liveness partner SPACES_SECRET_KEY must share its scope and carry no liveness",
    ]);
  });

  it("accepts repository scope alone or beside environments", () => {
    const { errors } = validateCredentialInventory(
      fixture([entry("A_TOKEN", { scope: "repository" }), entry("B_URL", { scope: ["repository", "staging"] })]),
    );
    expect(errors).toEqual([]);
  });
});
